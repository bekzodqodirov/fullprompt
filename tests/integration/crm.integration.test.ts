import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { attachments, clients, leads, users, warehouses } from '@/modules/platform/db/schema';
import {
  addActivity,
  convertLead,
  createLead,
  CrmError,
  dormantClients,
  followUps,
  funnelReport,
  listActivities,
  listLeads,
  listSources,
  listStages,
  moveLead,
  saveSource,
  saveStage,
  updateLead,
} from '@/modules/wms/crm/service';
import { confirmReceipt } from '@/modules/wms/receipts/service';

/**
 * Phase 2.3 CRM. The engine has one job the owner cares about: nobody who
 * asked about prices should fall off the list, and nobody who used to send
 * cargo should go quiet unnoticed.
 */

const SUFFIX = String(Date.now()).slice(-7);
let actorId: string;
let managerId: string;
let sourceId: string;
let stageNewId: string;
let stageLostId: string;
const ctx = () => ({ actorId });

const iso = (daysFromNow: number) =>
  new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  const staff = await db.select().from(users).limit(2);
  actorId = staff[0]!.id;
  managerId = (staff[1] ?? staff[0])!.id;

  const source = await saveSource({ name: `Instagram ${SUFFIX}`, sortOrder: 10, active: true }, ctx());
  sourceId = source.id;
  const stages = await listStages();
  stageNewId = stages.find((stage) => stage.kind === 'open')!.id;
  stageLostId = stages.find((stage) => stage.kind === 'lost')!.id;
});

afterAll(async () => {
  await pgClient.end();
});

describe('funnel dictionaries', () => {
  it('are data the owner edits, and a rename keeps the row', async () => {
    const created = await saveSource({ name: `Reklama ${SUFFIX}`, sortOrder: 90, active: true }, ctx());
    const renamed = await saveSource(
      { id: created.id, name: `Reklama (FB) ${SUFFIX}`, sortOrder: 90, active: true },
      ctx(),
    );
    expect(renamed.id).toBe(created.id);
    expect((await listSources()).some((row) => row.id === created.id)).toBe(true);

    // Deactivating hides it from the pickers without touching old leads.
    await saveSource({ id: created.id, name: `Reklama (FB) ${SUFFIX}`, sortOrder: 90, active: false }, ctx());
    expect((await listSources()).some((row) => row.id === created.id)).toBe(false);
    expect((await listSources(true)).some((row) => row.id === created.id)).toBe(true);
  });

  it('refuses to leave the funnel without a won stage', async () => {
    const stages = await listStages();
    const won = stages.find((stage) => stage.kind === 'won')!;
    await expect(
      saveStage({ id: won.id, name: won.name, kind: 'won', sortOrder: won.sortOrder, active: false }, ctx()),
    ).rejects.toThrow('needs_won');
    // The guard must not have left the stage deactivated on its way out.
    expect((await listStages()).some((stage) => stage.id === won.id)).toBe(true);
  });
});

describe('leads', () => {
  it('an unassigned lead belongs to whoever entered it', async () => {
    const lead = await createLead({ name: `Alisher ${SUFFIX}`, phone: '+998901112233' }, ctx());
    expect(lead.ownerId).toBe(actorId);
    expect(lead.stageId).toBe(stageNewId);
  });

  it('a lost lead must say why, and moving back out clears the reason', async () => {
    const lead = await createLead({ name: `Bekzod ${SUFFIX}`, sourceId }, ctx());
    await expect(moveLead(lead.id, stageLostId, '', ctx())).rejects.toThrow('reason_required');

    await moveLead(lead.id, stageLostId, 'boshqa kargo arzonroq', ctx());
    const lost = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    expect(lost!.lostReason).toBe('boshqa kargo arzonroq');

    await moveLead(lead.id, stageNewId, '', ctx());
    const back = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    expect(back!.lostReason).toBeNull();
  });

  it('converting mints a client card and keeps the link for the funnel report', async () => {
    const lead = await createLead(
      { name: `Dilshod ${SUFFIX}`, phone: '+998907778899', sourceId, ownerId: managerId },
      ctx(),
    );
    const client = await convertLead(lead.id, {}, ctx());
    expect(client.clientCode).toMatch(/^[A-Z0-9]{2,10}$/);
    expect(client.phones).toEqual(['+998907778899']);
    expect(client.salesManagerId).toBe(managerId);

    const after = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    expect(after!.clientId).toBe(client.id);
    // Conversion lands on the won stage, so the funnel counts it.
    const stages = await listStages();
    expect(after!.stageId).toBe(stages.find((stage) => stage.kind === 'won')!.id);

    // Converting twice would mint a second code for the same person.
    await expect(convertLead(lead.id, {}, ctx())).rejects.toThrow('already_converted');
  });

  it('a typed client code is honoured, and a taken one is refused', async () => {
    const taken = `CRM${SUFFIX}`.slice(0, 10);
    const first = await createLead({ name: `Kod egasi ${SUFFIX}` }, ctx());
    await convertLead(first.id, { clientCode: taken }, ctx());

    const second = await createLead({ name: `Ikkinchi ${SUFFIX}` }, ctx());
    await expect(convertLead(second.id, { clientCode: taken }, ctx())).rejects.toThrow('code_exists');
    // The refused conversion must not have half-converted the lead.
    const row = await db.query.leads.findFirst({ where: eq(leads.id, second.id) });
    expect(row!.clientId).toBeNull();
  });
});

describe('contact history and follow-ups', () => {
  it('logging a call can set the next one, on a lead or on a client', async () => {
    const lead = await createLead({ name: `Qo‘ng‘iroq ${SUFFIX}`, ownerId: actorId }, ctx());
    await addActivity(
      {
        entityType: 'lead',
        entityId: lead.id,
        kind: 'call',
        note: 'narx aytdim, o‘ylab ko‘radi',
        nextActionAt: iso(-1),
        nextActionNote: 'qayta qo‘ng‘iroq',
      },
      ctx(),
    );

    const log = await listActivities('lead', lead.id);
    expect(log).toHaveLength(1);
    expect(log[0]!.activity.kind).toBe('call');

    const due = await followUps(iso(0), actorId);
    const row = due.find((entry) => entry.kind === 'lead' && entry.id === lead.id);
    expect(row, 'an overdue lead must appear in today’s list').toBeDefined();
    expect(row!.note).toBe('qayta qo‘ng‘iroq');
  });

  it('a converted lead drops out of the follow-up list', async () => {
    const lead = await createLead(
      { name: `Aylandi ${SUFFIX}`, ownerId: actorId, nextActionAt: iso(-2), nextActionNote: 'qo‘ng‘iroq' },
      ctx(),
    );
    expect((await followUps(iso(0), actorId)).some((entry) => entry.id === lead.id)).toBe(true);
    await convertLead(lead.id, {}, ctx());
    // It is a client now — chasing it as a lead would be a duplicate task.
    expect((await followUps(iso(0), actorId)).some((entry) => entry.id === lead.id)).toBe(false);
  });

  it('leads and clients share ONE list, and a future date is not due yet', async () => {
    const [client] = await db
      .insert(clients)
      .values({
        clientCode: `CF${SUFFIX}`.slice(0, 10),
        name: 'Follow-up client',
        salesManagerId: actorId,
        nextActionAt: iso(-3),
        nextActionNote: 'qarzi haqida gaplash',
      })
      .returning();
    const later = await createLead(
      { name: `Keyinroq ${SUFFIX}`, ownerId: actorId, nextActionAt: iso(30) },
      ctx(),
    );

    const due = await followUps(iso(0), actorId);
    expect(due.some((entry) => entry.kind === 'client' && entry.id === client!.id)).toBe(true);
    expect(due.some((entry) => entry.id === later.id)).toBe(false);
    // Oldest first — the one waiting longest is the one to call.
    expect(due.map((entry) => entry.dueOn)).toEqual([...due.map((entry) => entry.dueOn)].sort());
  });

  it('another manager’s follow-ups stay out of my list', async () => {
    const theirs = await createLead(
      { name: `Boshqaniki ${SUFFIX}`, ownerId: managerId, nextActionAt: iso(-1) },
      ctx(),
    );
    const mine = await followUps(iso(0), actorId);
    expect(mine.some((entry) => entry.id === theirs.id)).toBe(managerId === actorId);
    // The owner sees everyone's.
    expect((await followUps(iso(0))).some((entry) => entry.id === theirs.id)).toBe(true);
  });
});

describe('dormant clients', () => {
  it('flags a client who stopped sending cargo, not one who never sent any', async () => {
    const warehouse = (await db.select().from(warehouses).limit(1))[0]!;
    const [sender] = await db
      .insert(clients)
      .values({ clientCode: `DQ${SUFFIX}`.slice(0, 10), name: 'Quiet sender', salesManagerId: actorId })
      .returning();
    const [never] = await db
      .insert(clients)
      .values({ clientCode: `DN${SUFFIX}`.slice(0, 10), name: 'Never sent', salesManagerId: actorId })
      .returning();

    const lotId = uuidv4();
    await db.insert(attachments).values({
      entityType: 'receipt_lot',
      entityId: lotId,
      kind: 'photo',
      storageKey: `crm/${lotId}`,
      fileName: 'x.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1,
      uploadedBy: actorId,
    });
    const receiptId = uuidv4();
    await confirmReceipt(
      {
        receiptId,
        warehouseId: warehouse.id,
        clientId: sender!.id,
        unclaimedMarking: '',
        lots: [
          {
            id: lotId,
            productNameZh: '静默货',
            boxCount: 1,
            dimsMode: 'uniform',
            boxLengthCm: 40,
            boxWidthCm: 30,
            boxHeightCm: 20,
            boxWeightKg: 5,
          },
        ],
        extraCosts: [],
      },
      ctx(),
    );
    // Push the receipt into the past so the client reads as gone quiet.
    await db.execute(
      sql`UPDATE receipts SET received_at = now() - interval '100 days' WHERE id = ${receiptId}`,
    );

    const dormant = await dormantClients(60, actorId);
    const row = dormant.find((entry) => entry.id === sender!.id);
    expect(row, 'a client 100 days quiet must be flagged at a 60-day threshold').toBeDefined();
    expect(row!.daysQuiet).toBeGreaterThanOrEqual(99);
    expect(row!.receiptCount).toBe(1);

    // Someone who never sent anything is a lead with a card, not a lost
    // regular — listing them would bury the real signal.
    expect(dormant.some((entry) => entry.id === never!.id)).toBe(false);
    // And at a threshold longer than the silence, nobody is flagged.
    expect((await dormantClients(365, actorId)).some((entry) => entry.id === sender!.id)).toBe(false);
  });
});

describe('funnel report', () => {
  it('counts every stage and scores a source only on decided leads', async () => {
    const report = await funnelReport();
    const stages = await listStages();
    // Every stage appears, including the empty ones — a funnel with a hole
    // in it is exactly what a manager needs to see.
    for (const stage of stages) {
      expect(report.stages.some((row) => row.stageId === stage.id), stage.name).toBe(true);
    }

    const source = report.sources.find((row) => row.name === `Instagram ${SUFFIX}`)!;
    expect(source).toBeDefined();
    expect(source.winRate).toBe(
      source.decided ? Math.round((source.won / source.decided) * 1000) / 10 : 0,
    );
    // An open lead is not a failure yet.
    expect(source.decided).toBeLessThanOrEqual(source.total);
  });

  it('lists leads with their stage, source and owner resolved', async () => {
    const rows = await listLeads({ ownerId: actorId });
    const row = rows.find((entry) => entry.lead.name === `Alisher ${SUFFIX}`)!;
    expect(row).toBeDefined();
    expect(row.stageName).toBeTruthy();
    expect(row.ownerName).toBeTruthy();
  });

  it('an edit keeps the stage when the form does not send one', async () => {
    const lead = await createLead({ name: `Tahrir ${SUFFIX}` }, ctx());
    await moveLead(lead.id, stageLostId, 'test', ctx());
    await updateLead(lead.id, { name: `Tahrir ${SUFFIX} (yangi)` }, ctx());
    const row = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    expect(row!.stageId).toBe(stageLostId);
    expect(row!.name).toBe(`Tahrir ${SUFFIX} (yangi)`);
  });

  it('errors carry a code the UI can translate', async () => {
    await expect(moveLead(uuidv4(), stageNewId, '', ctx())).rejects.toBeInstanceOf(CrmError);
  });
});
