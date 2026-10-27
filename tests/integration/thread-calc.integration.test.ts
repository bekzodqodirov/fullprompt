import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcRequestItems,
  calcRequests,
  clients,
  crmActivities,
  dealStages,
  deals,
  events,
  leads,
  leadStages,
  tasks,
  tgMessages,
  users,
} from '@/modules/platform/db/schema';
import { threadCalcAnalyze, threadCalcSend, threadMaterial } from '@/modules/wms/calc/from-thread';
import type { Actor } from '@/modules/platform/rbac/authorize';

/**
 * The third calc door — «Hisoblatishga yuborish» from a thread (owner,
 * 2026-08-25). What it must hold: the tg viewer's own fence on the posted
 * ids, the words landing verbatim on the note (law 11), the entity on
 * screen being the entity landed on, and the double press refusing.
 */
const SUFFIX = String(Date.now()).slice(-6);
let managerA = '';
let managerB = '';
let clientId = '';
let dealId = '';
let leadId = '';
let msgA1 = '';
let msgA2 = '';
let msgB1 = '';
let msgFile = '';
let msgLead = '';
let msgTwoWays = '';
const madeRequests: string[] = [];
const madeNotes: string[] = [];
const madeLeads: string[] = [];

const seller = (id: string): Actor =>
  ({
    id,
    fullName: `Sotuvchi ${SUFFIX}`,
    roles: ['sales_manager'],
    permissions: new Set(['crm.leads', 'clients.view_own', 'finance.view']),
  }) as unknown as Actor;
const supervisor = (id: string): Actor =>
  ({
    id,
    fullName: `Admin ${SUFFIX}`,
    roles: ['admin'],
    permissions: new Set(['crm.leads', 'clients.manage']),
  }) as unknown as Actor;

async function message(input: {
  manager: string;
  body: string | null;
  direction?: 'in' | 'out';
  hasMedia?: boolean;
  leadId?: string;
  sentAt: string;
}) {
  const [row] = await db
    .insert(tgMessages)
    .values({
      clientId: input.leadId ? null : clientId,
      leadId: input.leadId ?? null,
      managerUserId: input.manager,
      peerId: 424242n,
      tgMessageId: BigInt(Math.floor(Math.random() * 1_000_000_000)),
      direction: input.direction ?? 'in',
      body: input.body,
      hasMedia: input.hasMedia ?? false,
      sentAt: new Date(input.sentAt),
    })
    .returning({ id: tgMessages.id });
  return row!.id;
}

beforeAll(async () => {
  const mint = async (tag: string) => {
    const [u] = await db
      .insert(users)
      .values({
        phone: `+99896${SUFFIX}${tag.length}`,
        fullName: `TC ${tag} ${SUFFIX}`,
        passwordHash: 'x',
        active: true,
      })
      .returning();
    return u!.id;
  };
  managerA = await mint('A');
  managerB = await mint('Bx');

  const [client] = await db
    .insert(clients)
    .values({ clientCode: `TC${SUFFIX}`.slice(0, 10), name: `Thread ${SUFFIX}` })
    .returning();
  clientId = client!.id;

  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({
      id: randomUUID(),
      code: `TCD-${SUFFIX}`,
      title: 'Thread deal',
      clientId,
      stageId: stage!.id,
      createdBy: managerA,
    })
    .returning();
  dealId = deal!.id;

  const lstage = await db.query.leadStages.findFirst({ where: eq(leadStages.kind, 'open') });
  const [lead] = await db
    .insert(leads)
    .values({ name: `Thread lead ${SUFFIX}`, stageId: lstage!.id, createdBy: managerA })
    .returning();
  leadId = lead!.id;

  msgA1 = await message({ manager: managerA, body: '500 dona chexol, 2 kub bo‘ladi', sentAt: '2026-08-25T10:00:00Z' });
  msgA2 = await message({ manager: managerA, body: 'Yiwu dan Toshkent ga', direction: 'out', sentAt: '2026-08-25T10:01:00Z' });
  msgB1 = await message({ manager: managerB, body: 'kolleganing xabari', sentAt: '2026-08-25T10:02:00Z' });
  msgFile = await message({ manager: managerA, body: null, hasMedia: true, sentAt: '2026-08-25T10:03:00Z' });
  msgLead = await message({ manager: managerA, body: 'lead savoli', leadId, sentAt: '2026-08-25T10:04:00Z' });
  msgTwoWays = await message({
    manager: managerA,
    body: 'Kurtka 300 dona 1.2 kub\nShim 200 dona 1.6 kub\nJami 3500 kg, 2,500 kub',
    sentAt: '2026-08-25T10:05:00Z',
  });
});

afterAll(async () => {
  // Every job on this client's deals and these leads, not only the ones the
  // helper saw — a red proof's second request would otherwise stay queued.
  const cards = [
    ...(await db.select({ id: deals.id }).from(deals).where(eq(deals.clientId, clientId))).map((d) => d.id),
    leadId,
    ...madeLeads,
  ];
  for (const row of await db.select({ id: calcRequests.id }).from(calcRequests).where(inArray(calcRequests.entityId, cards))) {
    if (!madeRequests.includes(row.id)) madeRequests.push(row.id);
  }
  if (madeRequests.length > 0) {
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    const rows = await db
      .select({ taskId: calcRequests.taskId })
      .from(calcRequests)
      .where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  if (madeNotes.length > 0) await db.delete(crmActivities).where(inArray(crmActivities.id, madeNotes));
  await db.delete(tgMessages).where(inArray(tgMessages.id, [msgA1, msgA2, msgB1, msgFile, msgLead, msgTwoWays]));
  await db.delete(crmActivities).where(eq(crmActivities.entityId, dealId));
  await db.delete(crmActivities).where(eq(crmActivities.entityId, leadId));
  if (madeLeads.length > 0) {
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, madeLeads));
    await db.delete(leads).where(inArray(leads.id, madeLeads));
  }
  await db.delete(leads).where(eq(leads.id, leadId));
  // The per-request deals the client door opened, and the fixture's own.
  const opened = await db.select({ id: deals.id }).from(deals).where(eq(deals.clientId, clientId));
  if (opened.length > 0) await db.delete(crmActivities).where(inArray(crmActivities.entityId, opened.map((d) => d.id)));
  await db.delete(deals).where(eq(deals.clientId, clientId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(inArray(users.id, [managerA, managerB]));
  await pgClient.end();
});

async function send(actor: Actor, entity: Parameters<typeof threadCalcSend>[1]['entity'], ids: string[]) {
  const noteId = randomUUID();
  madeNotes.push(noteId);
  const res = await threadCalcSend(
    actor,
    { entity, section: 'podklyuch', messageIds: ids, noteId },
    { actorId: actor.id, ip: null, userAgent: null },
  );
  const request = await db.query.calcRequests.findFirst({
    where: eq(calcRequests.noteId, noteId),
  });
  if (request) madeRequests.push(request.id);
  return { res, noteId, request };
}

describe('the viewer fence on posted ids', () => {
  it('a seller cannot weld a colleague’s message into their request', async () => {
    // #514: the ids are a forged post. Refused whole — never trimmed to the
    // readable subset, which would land a request silently missing material.
    await expect(
      threadMaterial(seller(managerA), { kind: 'client', id: clientId }, [msgA1, msgB1]),
    ).rejects.toMatchObject({ code: 'not_yours' });
  });

  it('the supervision view reads both, and names who said what', async () => {
    const material = await threadMaterial(supervisor(managerA), { kind: 'client', id: clientId }, [
      msgB1,
      msgA1,
      msgA2,
    ]);
    // Sent order, not the posted order and not the panel's newest-first.
    expect(material.lines[0]).toBe('Mijoz: 500 dona chexol, 2 kub bo‘ladi');
    expect(material.lines[1]).toContain(`TC A ${SUFFIX}: Yiwu dan Toshkent ga`);
    expect(material.lines[2]).toBe('Mijoz: kolleganing xabari');
  });
});

describe('landing', () => {
  it('lands on the DEAL on screen, with the words verbatim on the note (law 11)', async () => {
    const { res, noteId, request } = await send(seller(managerA), { kind: 'deal', id: dealId }, [
      msgA1,
      msgA2,
    ]);
    expect(res).toMatchObject({ kind: 'deal', id: dealId, queued: true });
    expect(request?.entityType).toBe('deal');
    expect(request?.entityId).toBe(dealId);
    expect(request?.source).toBe('card');
    // The manual parser read the seller's own words.
    expect(Number(request?.volumeM3)).toBe(2);

    const note = await db.query.crmActivities.findFirst({ where: eq(crmActivities.id, noteId) });
    expect(note?.entityId).toBe(dealId);
    expect(note?.note).toContain('Mijoz: 500 dona chexol, 2 kub bo‘ladi');
    expect(note?.note).toContain('suhbatdan');
  });

  it('a files-only selection is SUBMITTABLE — invoices arrive as photos', async () => {
    const { request } = await send(seller(managerA), { kind: 'deal', id: dealId }, [msgFile]);
    expect(request).toBeTruthy();
    const note = await db.query.crmActivities.findFirst({ where: eq(crmActivities.id, request!.noteId!) });
    expect(note?.note).toContain('1 ta fayl suhbatda');
  });

  it('a lead thread lands on the lead itself, never a second lead', async () => {
    const { res } = await send(seller(managerA), { kind: 'lead', id: leadId }, [msgLead]);
    expect(res).toMatchObject({ kind: 'lead', id: leadId });
    const count = await db.query.leads.findMany({ where: eq(leads.name, `Thread lead ${SUFFIX}`) });
    expect(count).toHaveLength(1);
  });

  it('a client entity opens a NEW deal per request, and a retried press lands on it again', async () => {
    // His 2026-10-27 «har so'rovga yangi bitim»: a client names no job, so
    // each request is its own deal — never the client's open one.
    const { res, noteId } = await send(seller(managerA), { kind: 'client', id: clientId }, [msgA1]);
    expect(res.kind).toBe('deal');
    expect(res.id).not.toBe(dealId);
    const retried = await threadCalcSend(
      seller(managerA),
      { entity: { kind: 'client', id: clientId }, section: 'podklyuch', messageIds: [msgA1], noteId },
      { actorId: managerA, ip: null, userAgent: null },
    );
    expect(retried).toMatchObject({ kind: 'deal', id: res.id, queued: true });
    const jobs = await db.select().from(calcRequests).where(eq(calcRequests.noteId, noteId));
    expect(jobs).toHaveLength(1);
  });

  it('a lead’s CLIENT thread lands on the lead while it is open, and on a new deal of its client once won', async () => {
    const lstage = await db.query.leadStages.findFirst({ where: eq(leadStages.kind, 'open') });
    const wstage = await db.query.leadStages.findFirst({ where: eq(leadStages.kind, 'won') });
    const [bound] = await db
      .insert(leads)
      .values({ name: `Thread bound ${SUFFIX}`, stageId: lstage!.id, createdBy: managerA, ownerId: managerA, clientId })
      .returning();
    madeLeads.push(bound!.id);
    const open = await send(seller(managerA), { kind: 'lead_client', id: bound!.id }, [msgA1]);
    expect(open.res).toMatchObject({ kind: 'lead', id: bound!.id });
    await db.update(leads).set({ stageId: wstage!.id }).where(eq(leads.id, bound!.id));
    const won = await send(seller(managerA), { kind: 'lead_client', id: bound!.id }, [msgA1]);
    expect(won.res.kind).toBe('deal');
    expect(won.res.id).not.toBe(dealId);
    const deal = await db.query.deals.findFirst({ where: eq(deals.id, won.res.id) });
    expect(deal!.clientId).toBe(clientId);
  });

  it('a CLOSED lead’s own chat is refused before the model reads it', async () => {
    // The card draws no 🧮 there (`leadTakesJobs`); a posted analyse is
    // refused in words, before a paid model call on a job that cannot land.
    const before = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
    const lost = await db.query.leadStages.findFirst({ where: eq(leadStages.kind, 'lost') });
    await db.update(leads).set({ stageId: lost!.id }).where(eq(leads.id, leadId));
    try {
      await expect(
        threadCalcAnalyze(seller(managerA), { entity: { kind: 'lead', id: leadId }, section: 'rastamojka', messageIds: [msgLead] }),
      ).rejects.toMatchObject({ code: 'lead_closed' });
    } finally {
      await db.update(leads).set({ stageId: before!.stageId }).where(eq(leads.id, leadId));
    }
  });

  it('a cube typed two ways is named missing in the preview and NOT summed from the lines at the landing (P3-R2)', async () => {
    const actor = seller(managerA);
    const entity = { kind: 'deal' as const, id: dealId };
    const preview = await threadCalcAnalyze(actor, { entity, section: 'yolkira', messageIds: [msgTwoWays] });
    expect(preview.facts.volumeM3 ?? null).toBeNull();
    expect(preview.facts.volumeAmbiguous).toBe(true);
    expect(preview.missing).toContain('volumeM3');

    const land = async (facts: typeof preview.facts) => {
      const noteId = randomUUID();
      madeNotes.push(noteId);
      await threadCalcSend(
        actor,
        { entity, section: 'yolkira', messageIds: [msgTwoWays], noteId, facts },
        { actorId: actor.id, ip: null, userAgent: null },
      );
      const request = await db.query.calcRequests.findFirst({ where: eq(calcRequests.noteId, noteId) });
      madeRequests.push(request!.id);
      return request!.volumeM3 === null ? null : Number(request!.volumeM3);
    };
    // The preview the browser posts back, as it was drawn: the column stays empty.
    expect(await land(preview.facts)).toBeNull();
    // The control: the same lines with no two-way cube ARE summed.
    expect(await land({ ...preview.facts, volumeAmbiguous: undefined })).toBe(2.8);
  });

  it('a retried confirm refuses on the pre-minted note id', async () => {
    const noteId = randomUUID();
    madeNotes.push(noteId);
    const once = await threadCalcSend(
      seller(managerA),
      { entity: { kind: 'deal', id: dealId }, section: 'podklyuch', messageIds: [msgA1], noteId },
      { actorId: managerA, ip: null, userAgent: null },
    );
    const request = await db.query.calcRequests.findFirst({ where: eq(calcRequests.noteId, noteId) });
    if (request) madeRequests.push(request.id);
    expect(once.queued).toBe(true);
    await expect(
      threadCalcSend(
        seller(managerA),
        { entity: { kind: 'deal', id: dealId }, section: 'podklyuch', messageIds: [msgA1], noteId },
        { actorId: managerA, ip: null, userAgent: null },
      ),
    ).rejects.toMatchObject({ code: 'note_taken' });
  });
});
