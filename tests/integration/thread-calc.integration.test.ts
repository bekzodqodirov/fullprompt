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
import { threadCalcSend, threadMaterial } from '@/modules/wms/calc/from-thread';
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
const madeRequests: string[] = [];
const madeNotes: string[] = [];

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
});

afterAll(async () => {
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
  await db.delete(tgMessages).where(inArray(tgMessages.id, [msgA1, msgA2, msgB1, msgFile, msgLead]));
  await db.delete(crmActivities).where(eq(crmActivities.entityId, dealId));
  await db.delete(crmActivities).where(eq(crmActivities.entityId, leadId));
  await db.delete(leads).where(eq(leads.id, leadId));
  await db.delete(deals).where(eq(deals.id, dealId));
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

  it('a client entity falls back to the bot’s landing rule — the open deal', async () => {
    const { res } = await send(seller(managerA), { kind: 'client', id: clientId }, [msgA1]);
    expect(res).toMatchObject({ kind: 'deal', id: dealId });
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
