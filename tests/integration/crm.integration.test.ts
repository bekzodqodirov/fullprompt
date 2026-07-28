import 'dotenv/config';
import { desc, eq, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  clients,
  leads,
  tgMessages,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import {
  addActivity,
  convertLead,
  createLead,
  CrmError,
  deleteStage,
  dormantClients,
  followUps,
  funnelReport,
  listActivities,
  listLeads,
  listSources,
  listStages,
  moveLead,
  reorderStages,
  saveSource,
  saveStage,
  stageUsage,
  updateLead,
} from '@/modules/wms/crm/service';
import {
  groupClients,
  listPeople,
  personCodes,
  personForClient,
  suggestGroups,
} from '@/modules/wms/crm/people';
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
      saveStage(
        { id: won.id, name: won.name, kind: 'won', color: 'green', sortOrder: won.sortOrder, active: false },
        ctx(),
      ),
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

describe('the funnel is the owner’s to reshape', () => {
  it('reordering rewrites the positions in the order given', async () => {
    const before = await listStages();
    const flipped = [before[1]!.id, before[0]!.id, ...before.slice(2).map((s) => s.id)];
    await reorderStages(flipped, ctx());
    const after = await listStages();
    expect(after.map((stage) => stage.id)).toEqual(flipped);
    // Put it back so the rest of the suite reads the seeded order.
    await reorderStages(before.map((stage) => stage.id), ctx());
  });

  it('a removed stage hands its leads to another one', async () => {
    const extra = await saveStage(
      { name: `Vaqtinchalik ${SUFFIX}`, kind: 'open', color: 'teal', sortOrder: 45, active: true },
      ctx(),
    );
    const lead = await createLead({ name: `Ko‘chadi ${SUFFIX}`, stageId: extra.id }, ctx());
    expect((await stageUsage())[extra.id]).toBe(1);

    await deleteStage(extra.id, stageNewId, ctx());
    const moved = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    expect(moved!.stageId).toBe(stageNewId);
    expect((await listStages()).some((stage) => stage.id === extra.id)).toBe(false);
  });

  it('the last won stage cannot be deleted out of the funnel', async () => {
    const won = (await listStages()).find((stage) => stage.kind === 'won')!;
    await expect(deleteStage(won.id, stageNewId, ctx())).rejects.toThrow('needs_won');
    // The rollback must have kept the stage AND left no lead stranded.
    expect((await listStages()).some((stage) => stage.id === won.id)).toBe(true);
  });
});

describe('one person, several codes', () => {
  it('groups codes without merging the cards behind them', async () => {
    const phone = `+9989${SUFFIX}`;
    const [first] = await db
      .insert(clients)
      .values({ clientCode: `P1${SUFFIX}`.slice(0, 10), name: 'Aka', phones: [phone] })
      .returning();
    const [second] = await db
      .insert(clients)
      .values({ clientCode: `P2${SUFFIX}`.slice(0, 10), name: 'Aka (2)', phones: [phone] })
      .returning();

    const personId = await groupClients([first!.id, second!.id], { name: 'Aka' }, ctx());
    const codes = await personCodes(personId);
    expect(codes.map((row) => row.code).sort()).toEqual(
      [first!.clientCode, second!.clientCode].sort(),
    );
    // Each code keeps its own card — grouping must not rewrite history.
    const reread = await db.query.clients.findFirst({ where: eq(clients.id, first!.id) });
    expect(reread!.clientCode).toBe(first!.clientCode);
    expect(reread!.personId).toBe(personId);

    const view = await personForClient(second!.id);
    expect(view!.person.name).toBe('Aka');
    expect(view!.codes).toHaveLength(2);
    expect((await listPeople()).some((row) => row.id === personId && row.codes === 2)).toBe(true);
  });

  it('suggests codes that share a phone, and stops suggesting once grouped', async () => {
    const phone = `+99871${SUFFIX}`;
    const [a] = await db
      .insert(clients)
      .values({ clientCode: `S1${SUFFIX}`.slice(0, 10), name: 'Uka', phones: [phone] })
      .returning();
    const [b] = await db
      .insert(clients)
      .values({ clientCode: `S2${SUFFIX}`.slice(0, 10), name: 'Uka (2)', phones: [`998 71 ${SUFFIX}`] })
      .returning();

    const hasBoth = (groups: Awaited<ReturnType<typeof suggestGroups>>) =>
      groups.some((group) => {
        const ids = group.members.map((member) => member.id);
        return ids.includes(a!.id) && ids.includes(b!.id);
      });

    // Formatting differences must not hide the match (last-9-digit rule).
    expect(hasBoth(await suggestGroups(500))).toBe(true);
    await groupClients([a!.id, b!.id], {}, ctx());
    expect(hasBoth(await suggestGroups(500))).toBe(false);
  });
});

/**
 * The digest that shipped broken.
 *
 * `sendFollowUpDigest` composes a per-recipient list and hands it to
 * `deliver`, which stores it as `payload.text`. The Telegram sender then
 * re-renders every row through `renderTelegramText`, which had no case for
 * `CrmFollowUps` — so the composed text was discarded and the reader got the
 * literal string "CrmFollowUps" and a link to `/receipts/undefined`.
 *
 * This walks the real path: compose → row → render.
 */
describe('the follow-up digest reaches the phone intact', () => {
  it('renders the composed list, not the event name', async () => {
    const { sendFollowUpDigest } = await import('@/modules/wms/crm/digest');
    const { renderTelegramText } = await import('@/modules/platform/notifications/service');
    const { notifications } = await import('@/modules/platform/db/schema');

    // A lead due today for a manager who sees everything.
    const name = `Digest sinov ${SUFFIX}`;
    await createLead(
      { name, stageId: stageNewId, ownerId: actorId, nextActionAt: iso(0) },
      ctx(),
    );

    await sendFollowUpDigest();

    const rows = await db
      .select()
      .from(notifications)
      .where(sql`${notifications.type} = 'CrmFollowUps' AND ${notifications.channel} = 'telegram'`)
      .orderBy(sql`${notifications.createdAt} DESC`)
      .limit(5);
    expect(rows.length, 'the digest produced no telegram row').toBeGreaterThan(0);

    const text = renderTelegramText(
      rows[0]!.type,
      rows[0]!.payload as Record<string, unknown>,
      'uz',
    );
    // What the driver actually receives.
    expect(text).not.toBe('CrmFollowUps');
    expect(text).not.toContain('undefined');
    expect(text).toContain('📞');
  });
});

/**
 * The manager's Telegram, in the CRM.
 *
 * The script that talks to Telegram cannot be tested without an account, so
 * everything it DECIDES lives in `telegram-import.ts` and is unit-tested. What
 * is proved here is the other half: that a row written by that script is
 * readable as one client's thread, and that running the import twice cannot
 * double it.
 */
describe('telegram conversations on the client card', () => {
  it('re-running the import writes nothing the second time', async () => {
    const [client] = await db
      .insert(clients)
      .values({ clientCode: `TG${String(Date.now()).slice(-6)}`, name: 'Telegram client' })
      .returning();

    const row = {
      clientId: client!.id,
      managerUserId: actorId,
      peerId: 555_000_111n,
      tgMessageId: 42n,
      direction: 'in' as const,
      body: 'Yuk qachon keladi?',
      sentAt: new Date('2026-07-20T10:00:00Z'),
    };

    const first = await db.insert(tgMessages).values(row).onConflictDoNothing().returning();
    expect(first).toHaveLength(1);

    // The same message, seen again on a second run. The unique index is what
    // makes the import safe to repeat — not a "have I done this" flag that
    // somebody has to remember to set.
    const second = await db.insert(tgMessages).values(row).onConflictDoNothing().returning();
    expect(second).toHaveLength(0);

    // ...but the SAME conversation read from a different manager's account is
    // a different thread, and both are worth keeping.
    const other = await db
      .insert(users)
      .values({
        phone: `+99890${String(Date.now()).slice(-7)}`,
        fullName: 'Other manager',
        passwordHash: 'x',
      })
      .returning();
    const third = await db
      .insert(tgMessages)
      .values({ ...row, managerUserId: other[0]!.id })
      .onConflictDoNothing()
      .returning();
    expect(third).toHaveLength(1);
  });

  it('reads back as one client’s thread, newest first', async () => {
    const [client] = await db
      .insert(clients)
      .values({ clientCode: `TH${String(Date.now()).slice(-6)}`, name: 'Thread client' })
      .returning();
    await db.insert(tgMessages).values([
      {
        clientId: client!.id,
        managerUserId: actorId,
        peerId: 1n,
        tgMessageId: 1n,
        direction: 'in',
        body: 'birinchi',
        sentAt: new Date('2026-07-01T09:00:00Z'),
      },
      {
        clientId: client!.id,
        managerUserId: actorId,
        peerId: 1n,
        tgMessageId: 2n,
        direction: 'out',
        body: 'javob',
        sentAt: new Date('2026-07-02T09:00:00Z'),
      },
    ]);

    const thread = await db
      .select()
      .from(tgMessages)
      .where(eq(tgMessages.clientId, client!.id))
      .orderBy(desc(tgMessages.sentAt));
    // Newest first: this is a record being consulted, not a chat being had,
    // and the question is almost always "what did we last say to them".
    expect(thread.map((r) => r.body)).toEqual(['javob', 'birinchi']);
    expect(thread[0]!.direction).toBe('out');
  });
});
