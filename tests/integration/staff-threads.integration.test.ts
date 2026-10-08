import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The staff threads against a real database (0127, the owner's E answers):
 * the calculation's Q&A and its tag, who hears a note at SEND time (E9 a, E6
 * c, G4 a's standing), the box's «who will not hear it», the idempotent
 * Telegram landing, E11 a, the dock's list and the lenta's hint.
 *
 * Fixtures are this file's own, every name run-suffixed, every person with a
 * SEEDED role (a door about roles is measured on the roles he edits, #170).
 * Cleanup: rows this file wrote are deleted, users DEACTIVATED (audit FK).
 */

const override = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }));
vi.mock('@/modules/platform/auth/session', async (original) => ({
  ...(await original<typeof import('@/modules/platform/auth/session')>()),
  requestMeta: async () => ({ ip: null, userAgent: 'staff-threads.integration' }),
}));
vi.mock('next/cache', async (original) => ({
  ...(await original<typeof import('next/cache')>()),
  revalidatePath: () => {},
}));
vi.mock('@/modules/platform/rbac/authorize', async (original) => {
  const real = await original<typeof import('@/modules/platform/rbac/authorize')>();
  return {
    ...real,
    getActor: async () => (override.actor ?? (await real.getActor())) as Awaited<ReturnType<typeof real.getActor>>,
  };
});

import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcRequests,
  clients,
  crmActivities,
  dealStages,
  deals,
  leadStages,
  leads,
  notifications,
  roles,
  telegramLinks,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { userPermissions } from '@/modules/platform/rbac/authorize';
import { rekeyLeadCalcRequests } from '@/modules/wms/calc/service';
import { announceNote, noteRecipients } from '@/modules/wms/crm/internal-chat';
import {
  addThreadMessage,
  calcThreadMessages,
  calcThreadsOnCard,
  calcThreadSummary,
  markThreadRead,
  myThreads,
  openCalcThreadOn,
  threadHrefsFor,
  threadReadMarks,
} from '@/modules/wms/crm/thread';
import { mayWriteThread, threadStanding } from '@/modules/wms/crm/thread-door';
import { landThreadReply } from '@/modules/wms/crm/thread-reply';
import { contactedRecently } from '@/modules/wms/crm/first-contact';
import { postCalcThreadAction } from '@/app/(protected)/hisoblash/[id]/thread-actions';

const SFX = randomUUID().replace(/-/g, '').slice(0, 6);
let seq = 0;
const phone = () => `+99897${String(Date.now()).slice(-5)}${(seq += 1).toString().padStart(2, '0')}`;
const ctx = (id: string) => ({ actorId: id, ip: null, userAgent: 'staff-threads.integration' });
let chatSeq = 7_700_000_000 + Math.floor(Math.random() * 1_000_000);

const madeUsers: string[] = [];
const madeLeads: string[] = [];
const madeDeals: string[] = [];
const madeClients: string[] = [];
const madeRequests: string[] = [];

let openLeadStage = '';
let openDealStage = '';
const P: Record<'S' | 'B' | 'V' | 'C' | 'C2' | 'W' | 'V2' | 'V3', string> = {
  S: '', B: '', V: '', C: '', C2: '', W: '', V2: '', V3: '',
};

async function person(role: string, name: string, linked = true): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: phone(), fullName: `${name} ${SFX}`, passwordHash: 'x', active: true })
    .returning({ id: users.id });
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  if (linked) {
    await db.insert(telegramLinks).values({
      userId: u!.id,
      telegramChatId: BigInt((chatSeq += 1)),
      status: 'linked',
      linkedAt: new Date(),
    });
  }
  madeUsers.push(u!.id);
  return u!.id;
}

async function lead(ownerId: string | null, clientId: string | null = null): Promise<string> {
  const [row] = await db
    .insert(leads)
    .values({ name: `Ichki lid ${SFX} ${(seq += 1)}`, stageId: openLeadStage, ownerId, clientId })
    .returning({ id: leads.id });
  madeLeads.push(row!.id);
  return row!.id;
}

async function deal(ownerId: string | null, clientId: string): Promise<string> {
  const [row] = await db
    .insert(deals)
    .values({
      code: `B-T${SFX}${(seq += 1)}`.slice(0, 14),
      clientId,
      stageId: openDealStage,
      ownerId,
      createdBy: ownerId ?? P.C,
    })
    .returning({ id: deals.id });
  madeDeals.push(row!.id);
  return row!.id;
}

async function client(salesManagerId: string | null): Promise<string> {
  const [row] = await db
    .insert(clients)
    .values({ clientCode: `TH${SFX}${(seq += 1)}`.slice(0, 10).toUpperCase(), name: `Ichki mijoz ${SFX}`, phones: [], salesManagerId })
    .returning({ id: clients.id });
  madeClients.push(row!.id);
  return row!.id;
}

async function request(entityType: 'lead' | 'deal', entityId: string, requestedBy: string, assigneeId: string | null) {
  const [row] = await db
    .insert(calcRequests)
    .values({
      entityType,
      entityId,
      requestedBy,
      assigneeId,
      itemCount: 1,
      section: 'rastamojka',
      dueAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: calcRequests.id });
  madeRequests.push(row!.id);
  return row!.id;
}

const actorOf = async (id: string) => ({ id, permissions: await userPermissions(id) });

/** The pings one note produced, by its own row id (`payload.thread.activityId`). */
async function pingsOf(activityId: string) {
  return db
    .select({ userId: notifications.userId, type: notifications.type, payload: notifications.payload })
    .from(notifications)
    .where(sql`${notifications.payload} -> 'thread' ->> 'activityId' = ${activityId}`);
}

/** The Telegram landing announces OFF the poller (`void`) — wait for its rows. */
async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  let last = await read();
  for (let i = 0; i < 50 && !ok(last); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    last = await read();
  }
  return last;
}

async function chatOf(userId: string): Promise<bigint> {
  const [row] = await db.select({ chat: telegramLinks.telegramChatId }).from(telegramLinks).where(eq(telegramLinks.userId, userId));
  return row!.chat!;
}

beforeAll(async () => {
  const [ls] = await db.select().from(leadStages).where(eq(leadStages.kind, 'open')).limit(1);
  const [ds] = await db.select().from(dealStages).where(eq(dealStages.kind, 'open')).limit(1);
  openLeadStage = ls!.id;
  openDealStage = ds!.id;
  P.S = await person('sales_manager', 'Ichki Sotuvchi');
  P.B = await person('sales_manager', 'Ichki Sotuvchi B');
  P.V = await person('ved_manager', 'Ichki VED');
  P.C = await person('logist', 'Ichki Logist');
  P.C2 = await person('logist', 'Ichki Logist 2');
  P.W = await person('warehouse_operator', 'Ichki Skladchi');
  P.V2 = await person('ved_manager', 'Ichki VED ulanmagan', false);
  P.V3 = await person('ved_manager', 'Ichki VED jim');
  await db.update(users).set({ mutedNotificationTypes: ['CalcThread'] }).where(eq(users.id, P.V3));
});

afterAll(async () => {
  const notes = await db
    .select({ id: crmActivities.id })
    .from(crmActivities)
    .where(inArray(crmActivities.entityId, [...madeLeads, ...madeDeals, ...madeClients]));
  if (madeUsers.length) {
    await db.delete(notifications).where(inArray(notifications.userId, madeUsers));
    await db.execute(sql`DELETE FROM thread_reads WHERE user_id IN (${sql.join(madeUsers.map((id) => sql`${id}::uuid`), sql`, `)})`);
  }
  if (madeRequests.length) await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
  if (notes.length) await db.delete(crmActivities).where(inArray(crmActivities.id, notes.map((n) => n.id)));
  if (madeDeals.length) await db.delete(deals).where(inArray(deals.id, madeDeals));
  if (madeLeads.length) await db.delete(leads).where(inArray(leads.id, madeLeads));
  if (madeClients.length) await db.delete(clients).where(inArray(clients.id, madeClients));
  if (madeUsers.length) {
    await db.delete(telegramLinks).where(inArray(telegramLinks.userId, madeUsers));
    await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
  }
  await pgClient.end();
});

describe('1. the calculation’s Q&A — written on the card of the moment, read by the tag', () => {
  it('the VED asks, the seller answers, the lead is won, and the whole thread stays under the calculation', async () => {
    const L = await lead(P.S);
    const R = await request('lead', L, P.S, P.V);

    const q = await addThreadMessage({ ref: { kind: 'calc', id: R }, body: 'Necha kub?' }, ctx(P.V));
    const [row] = await db.execute<{ entity_type: string; entity_id: string; calc_request_id: string }>(sql`
      SELECT entity_type, entity_id::text AS entity_id, calc_request_id::text AS calc_request_id
        FROM crm_activities WHERE id = ${q.activityId}::uuid`);
    expect(row).toEqual({ entity_type: 'lead', entity_id: L, calc_request_id: R });
    await announceNote({
      entityType: q.entityType,
      entityId: q.entityId,
      note: 'Necha kub?',
      authorId: P.V,
      activityId: q.activityId,
      calcRequestId: q.calcRequestId,
    });
    const toSeller = (await pingsOf(q.activityId)).filter((p) => p.userId === P.S);
    expect(toSeller.map((p) => p.type)).toEqual(['CalcThread']);
    expect((toSeller[0]!.payload as { thread: unknown }).thread).toEqual({ kind: 'calc', id: R, activityId: q.activityId });

    // The seller answers from Telegram.
    const answer = await landThreadReply(await actorOf(P.S), {
      ref: { kind: 'calc', id: R },
      ping: 'CalcThread',
      text: '12 kub',
      tg: { chatId: await chatOf(P.S), messageId: 501 },
      writtenAt: new Date().toISOString(),
    });
    expect(answer.outcome).toBe('landed_calc');
    const messages = await calcThreadMessages(R);
    expect(messages.map((m) => m.body)).toEqual(['Necha kub?', '12 kub']);
    expect(messages[1]!.viaTelegram).toBe(true);
    const toVed = await eventually(
      async () => (await pingsOf(messages[1]!.id)).filter((p) => p.userId === P.V),
      (rows) => rows.length > 0,
    );
    expect(toVed.map((p) => p.type)).toEqual(['CalcThread']);

    // Won: the request follows the lead to its deal; the notes stay on the lead.
    const D = await deal(P.S, await client(P.S));
    await rekeyLeadCalcRequests(L, D);
    const third = await addThreadMessage({ ref: { kind: 'calc', id: R }, body: 'Rahmat' }, ctx(P.V));
    expect(third.entityType).toBe('deal');
    expect(third.entityId).toBe(D);
    expect((await calcThreadMessages(R)).map((m) => m.body)).toEqual(['Necha kub?', '12 kub', 'Rahmat']);
  });
});

describe('who hears a note — decided at send time', () => {
  it('2. E9 on a lead: the seller it was handed away from stops hearing it', async () => {
    const L = await lead(P.S);
    await addThreadMessage({ ref: { kind: 'lead', id: L }, body: 'birinchi' }, ctx(P.S));
    expect(await noteRecipients('lead', L, null)).toContain(P.S);
    await db.update(leads).set({ ownerId: P.B }).where(eq(leads.id, L));
    const who = await noteRecipients('lead', L, null);
    expect(who).toContain(P.B);
    expect(who).not.toContain(P.S);
  });

  it('3. E9 on a client: a past author with plain crm.leads stays only while involved; a logist always', async () => {
    const K = await client(null);
    const LK = await lead(P.S, K);
    await addThreadMessage({ ref: { kind: 'client', id: K }, body: 'mijoz haqida' }, ctx(P.S));
    await addThreadMessage({ ref: { kind: 'client', id: K }, body: 'logist izohi' }, ctx(P.C2));
    expect(new Set(await noteRecipients('client', K, null))).toEqual(new Set([P.S, P.C2]));
    // The lead moves to B: S is no longer involved with K, B is.
    await db.update(leads).set({ ownerId: P.B }).where(eq(leads.id, LK));
    const who = await noteRecipients('client', K, null);
    expect(who).toContain(P.B);
    expect(who).toContain(P.C2);
    expect(who).not.toContain(P.S);
  });

  it('4. E6 c: the logist’s question on the client card reaches the client’s seller', async () => {
    const K = await client(P.S);
    const note = await addThreadMessage({ ref: { kind: 'client', id: K }, body: `Yuk ma'lumoti ${SFX}` }, ctx(P.C));
    await announceNote({
      entityType: 'client',
      entityId: K,
      note: 'yuk',
      authorId: P.C,
      activityId: note.activityId,
      calcRequestId: null,
    });
    const rows = await pingsOf(note.activityId);
    expect(rows.filter((r) => r.userId === P.S).map((r) => r.type)).toEqual(['InternalNote']);
  });

  it('5. two threads on one card: a VED’s calc question does not make him a lead participant', async () => {
    const L = await lead(P.S);
    const R = await request('lead', L, P.S, P.V);
    await addThreadMessage({ ref: { kind: 'calc', id: R }, body: 'savol' }, ctx(P.V));
    expect(await noteRecipients('lead', L, null)).not.toContain(P.V);
    expect(await noteRecipients('lead', L, R)).toContain(P.V);
  });

  it('6. standing (G4 a): a warehouse operator who sent «🧮 Hisoblatish» hears the question with no link and may answer', async () => {
    const LW = await lead(P.W);
    const RW = await request('lead', LW, P.W, P.V);
    const q = await addThreadMessage({ ref: { kind: 'calc', id: RW }, body: `kub? ${SFX}` }, ctx(P.V));
    const said = await announceNote({
      entityType: q.entityType,
      entityId: q.entityId,
      note: `kub? ${SFX}`,
      authorId: P.V,
      activityId: q.activityId,
      calcRequestId: q.calcRequestId,
    });
    expect(said.standingOnly).toContain(P.W);
    const mine = (await pingsOf(q.activityId)).filter((p) => p.userId === P.W);
    expect(mine).toHaveLength(1);
    expect(String((mine[0]!.payload as { text: string }).text)).not.toContain('🔗');
    const out = await landThreadReply(await actorOf(P.W), {
      ref: { kind: 'calc', id: RW },
      ping: 'CalcThread',
      text: '3 kub',
      tg: { chatId: await chatOf(P.W), messageId: 601 },
      writtenAt: new Date().toISOString(),
    });
    expect(out.outcome).toBe('landed_calc');
    // …and a CRM seller-requester whose lead was handed on has NO standing (E9 a).
    const LS = await lead(P.S);
    const RS = await request('lead', LS, P.S, P.V);
    await db.update(leads).set({ ownerId: P.B }).where(eq(leads.id, LS));
    expect(await threadStanding(P.S, { kind: 'calc', id: RS })).toBe(false);
    expect(await noteRecipients('lead', LS, RS)).not.toContain(P.S);
  });

  it('6b. the seller who ASKED is never judged by involvement: his request on an ownerless deal of a seller-less client still reaches him', async () => {
    // `dealFor` sends a repeat client's request to its newest OPEN deal —
    // which may be nobody's. S owns nothing of K and is not its seller; he
    // asked, and the VED's question is FOR him (§3.4: filter 2 judges past
    // authors, not the requester).
    const K = await client(null);
    const D = await deal(null, K);
    const R = await request('deal', D, P.S, P.V);
    expect(await noteRecipients('deal', D, R)).toContain(P.S);
    const q = await addThreadMessage({ ref: { kind: 'calc', id: R }, body: `deal savol ${SFX}` }, ctx(P.V));
    const said = await announceNote({
      entityType: q.entityType,
      entityId: q.entityId,
      note: 'deal savol',
      authorId: P.V,
      activityId: q.activityId,
      calcRequestId: q.calcRequestId,
    });
    expect(said.heard).toContain(P.S);
    // …and his dock lists it, by the same exemption (the list agrees with the ping).
    expect((await myThreads(await actorOf(P.S))).find((r) => r.kind === 'calc' && r.id === R)?.unread).toBe(true);
    // A plain seller who merely WROTE there and is not involved is still dropped.
    await addThreadMessage({ ref: { kind: 'calc', id: R }, body: 'begona izoh' }, ctx(P.B));
    expect(await noteRecipients('deal', D, R)).not.toContain(P.B);
  });

  it('18. the write gap: a seller may not write on a colleague’s lead he cannot open', async () => {
    const L = await lead(P.S);
    expect(await mayWriteThread(await actorOf(P.B), { kind: 'lead', id: L })).toBe(false);
    expect(await mayWriteThread(await actorOf(P.S), { kind: 'lead', id: L })).toBe(true);
  });
});

describe('7. what the box is told', () => {
  const ask = async (who: string, requestId: string, body: string) => {
    override.actor = { ...(await actorOf(who)), fullName: 'x', roles: [], warehouseIds: [], warehouseScoped: false };
    const form = new FormData();
    form.set('requestId', requestId);
    form.set('body', body);
    try {
      return await postCalcThreadAction({}, form);
    } finally {
      override.actor = null;
    }
  };

  it('an unassigned request: nobody receives the seller’s question — and the box says so', async () => {
    const R = await request('lead', await lead(P.S), P.S, null);
    const out = await ask(P.S, R, 'kim oladi?');
    expect(out).toMatchObject({ ok: true, noAudience: true, unreachable: [] });
  });

  it('an assigned VED with no linked chat, and a VED who muted these, are named with the reason', async () => {
    const R2 = await request('lead', await lead(P.S), P.S, P.V2);
    expect((await ask(P.S, R2, 'savol')).unreachable).toEqual([{ name: `Ichki VED ulanmagan ${SFX}`, reason: 'no_chat' }]);
    const R3 = await request('lead', await lead(P.S), P.S, P.V3);
    expect((await ask(P.S, R3, 'savol')).unreachable).toEqual([{ name: `Ichki VED jim ${SFX}`, reason: 'muted' }]);
    // A reachable VED: nothing to warn about.
    const R1 = await request('lead', await lead(P.S), P.S, P.V);
    expect(await ask(P.S, R1, 'savol')).toMatchObject({ ok: true, noAudience: false, unreachable: [] });
  });

  it('a refusal is a code with words, never a throw', async () => {
    const R = await request('lead', await lead(P.S), P.S, P.V);
    expect(await ask(P.B, R, 'begona')).toEqual({ error: 'forbidden' });
    expect(await ask(P.S, R, '   ')).toEqual({ error: 'empty' });
    expect(await ask(P.S, R, 'x'.repeat(4001))).toEqual({ error: 'too_long' });
  });
});

describe('9. a Telegram reply lands once', () => {
  it('the same incoming message twice: one note, the second says so, one set of pings', async () => {
    const L = await lead(P.S);
    const R = await request('lead', L, P.S, P.V);
    const tg = { chatId: await chatOf(P.S), messageId: 777 };
    const first = await landThreadReply(await actorOf(P.S), { ref: { kind: 'calc', id: R }, ping: 'CalcThread', text: 'bir', tg, writtenAt: new Date().toISOString() });
    const second = await landThreadReply(await actorOf(P.S), { ref: { kind: 'calc', id: R }, ping: 'CalcThread', text: 'bir', tg, writtenAt: new Date().toISOString() });
    expect(first.outcome).toBe('landed_calc');
    expect(second.outcome).toBe('duplicate');
    const notes = await calcThreadMessages(R);
    expect(notes).toHaveLength(1);
    const pings = await eventually(() => pingsOf(notes[0]!.id), (rows) => rows.length > 0);
    expect(pings.filter((p) => p.userId === P.V)).toHaveLength(1);
  });
});

describe('16. E11 a — a thread message is not contact with the customer', () => {
  it('the owner’s calc answer and a Telegram-landed note do not count; a plain lenta note does', async () => {
    const L = await lead(P.S);
    const R = await request('lead', L, P.S, P.V);
    await addThreadMessage({ ref: { kind: 'calc', id: R }, body: 'javob' }, ctx(P.S));
    await addThreadMessage({ ref: { kind: 'lead', id: L }, body: 'tg', tg: { chatId: await chatOf(P.S), messageId: 901 } }, ctx(P.S));
    expect(await contactedRecently(L, P.S)).toBe(false);
    await db.insert(crmActivities).values({ entityType: 'lead', entityId: L, kind: 'note', note: 'gaplashdim', createdBy: P.S });
    expect(await contactedRecently(L, P.S)).toBe(true);
  });
});

describe('17. the dock — the threads I am in', () => {
  it('lists what I wrote in and what I was pinged about; new until read; a lead handed away vanishes', async () => {
    const Lmine = await lead(P.S);
    await addThreadMessage({ ref: { kind: 'lead', id: Lmine }, body: 'meniki' }, ctx(P.S));
    const Lpinged = await lead(P.S);
    const R = await request('lead', Lpinged, P.S, P.V);
    const q = await addThreadMessage({ ref: { kind: 'calc', id: R }, body: 'dock savol' }, ctx(P.V));
    await announceNote({
      entityType: q.entityType,
      entityId: q.entityId,
      note: 'dock savol',
      authorId: P.V,
      activityId: q.activityId,
      calcRequestId: q.calcRequestId,
    });
    const seller = await actorOf(P.S);
    let rows = await myThreads(seller);
    const mine = rows.find((r) => r.kind === 'lead' && r.id === Lmine);
    const pinged = rows.find((r) => r.kind === 'calc' && r.id === R);
    expect(mine?.unread).toBe(false);
    expect(mine?.href).toBe(`/crm/leads/${Lmine}#ichki`);
    expect(pinged?.unread).toBe(true);
    expect(pinged?.href).toBe(`/crm/leads/${Lpinged}#calc-thread-${R}`);
    await markThreadRead(P.S, { kind: 'calc', id: R }, new Date().toISOString());
    rows = await myThreads(seller);
    expect(rows.find((r) => r.kind === 'calc' && r.id === R)?.unread).toBe(false);
    // Handed away: gone from his list (E9 a), still on the new owner's door.
    await db.update(leads).set({ ownerId: P.B }).where(eq(leads.id, Lmine));
    rows = await myThreads(seller);
    expect(rows.find((r) => r.kind === 'lead' && r.id === Lmine)).toBeUndefined();

    // A mention-only addressee is not shown the card's thread (E2 a): the VED
    // named in a CLIENT note holds the ping AND an address for the card — it
    // is the door, not the address, that keeps the thread off his list.
    const K = await client(P.S);
    const named = await addThreadMessage({ ref: { kind: 'client', id: K }, body: 'VED nomi bilan' }, ctx(P.S));
    await db.insert(notifications).values({
      userId: P.V,
      channel: 'telegram',
      type: 'MentionedInNote',
      status: 'sent',
      sentAt: new Date(),
      payload: { text: 'x', thread: { kind: 'client', id: K, activityId: named.activityId } },
    });
    const ved = await actorOf(P.V);
    expect((await threadHrefsFor(ved, [{ kind: 'client', id: K }])).get(`client:${K}`)).toBe(`/admin/clients/${K}#ichki`);
    expect((await myThreads(ved)).find((r) => r.kind === 'client' && r.id === K)).toBeUndefined();
  });
});

describe('17b. the read mark is AS OF what was drawn', () => {
  it('a note that lands between the render and the mark stays new; a future instant is capped at now', async () => {
    const L = await lead(P.S);
    const R = await request('lead', L, P.S, P.V);
    const ref = { kind: 'calc' as const, id: R };
    await addThreadMessage({ ref, body: 'birinchi savol' }, ctx(P.V));
    // The seller's page reads its marks BEFORE drawing the list…
    const [drawn] = await threadReadMarks([ref]);
    expect(drawn?.asOf).toEqual(expect.any(String));
    // …the VED writes again before the browser's POST arrives…
    await addThreadMessage({ ref, body: 'ikkinchi savol' }, ctx(P.V));
    await markThreadRead(P.S, ref, drawn!.asOf!);
    // …and the second question was never on his screen: it is still new.
    expect((await calcThreadSummary(R, P.S)).unread).toBe(true);
    // The render that SHOWS it reads it.
    const [again] = await threadReadMarks([ref]);
    await markThreadRead(P.S, ref, again!.asOf!);
    expect((await calcThreadSummary(R, P.S)).unread).toBe(false);
    // A forged instant in the future reads nothing in advance.
    await markThreadRead(P.S, ref, '2999-01-01T00:00:00.000Z');
    await addThreadMessage({ ref, body: 'uchinchi savol' }, ctx(P.V));
    expect((await calcThreadSummary(R, P.S)).unread).toBe(true);
  });
});

describe('17e. a late Telegram note is new by when it LANDED, not when it was written (Q5-3)', () => {
  it('my note, then a colleague’s Telegram reply written half an hour before it: the ● rises on the chip, the fold and the dock', async () => {
    const L = await lead(P.S);
    const R = await request('lead', L, P.S, P.V);
    const calc = { kind: 'calc' as const, id: R };
    const card = { kind: 'lead' as const, id: L };
    // I write in both threads — my own note is read up to itself…
    await addThreadMessage({ ref: calc, body: 'sotuvchi savoli' }, ctx(P.S));
    await addThreadMessage({ ref: card, body: 'sotuvchi izohi' }, ctx(P.S));
    expect((await calcThreadSummary(R, P.S)).unread).toBe(false);
    // …then the answers that were typed in Telegram during the deploy land,
    // filed at the moment they were WRITTEN.
    const before = new Date(Date.now() - 30 * 60_000).toISOString();
    await addThreadMessage(
      { ref: calc, body: 'VED javobi kechikib', tg: { chatId: BigInt((chatSeq += 1)), messageId: 1 }, writtenAt: before },
      ctx(P.V),
    );
    await addThreadMessage(
      { ref: card, body: 'logist izohi kechikib', tg: { chatId: BigInt((chatSeq += 1)), messageId: 1 }, writtenAt: before },
      ctx(P.C),
    );
    // The calc page's chip.
    expect((await calcThreadSummary(R, P.S)).unread).toBe(true);
    // The card's calc fold.
    const folds = await calcThreadsOnCard({ entityType: 'lead', entityId: L }, P.S);
    expect(folds.find((f) => f.requestId === R)?.unread).toBe(true);
    // The dock, both laterals — and its excerpt is the note that landed last.
    const rows = await myThreads(await actorOf(P.S));
    const calcRow = rows.find((r) => r.kind === 'calc' && r.id === R);
    expect(calcRow).toMatchObject({ unread: true, excerpt: 'VED javobi kechikib' });
    const cardRow = rows.find((r) => r.kind === 'lead' && r.id === L);
    expect(cardRow).toMatchObject({ unread: true, excerpt: 'logist izohi kechikib' });
  });
});

describe('17c. E9 on a client thread — from the dock', () => {
  it('a plain seller whose lead of the client went to a colleague stops seeing the client thread in his dock', async () => {
    const K = await client(null);
    const LK = await lead(P.S, K);
    await addThreadMessage({ ref: { kind: 'client', id: K }, body: `mijoz yozuvi ${SFX}` }, ctx(P.S));
    const listed = async (who: string) =>
      (await myThreads(await actorOf(who))).some((r) => r.kind === 'client' && r.id === K);
    expect(await listed(P.S)).toBe(true);
    // The lead goes to B, who writes: S is no longer involved — he hears
    // nothing (filter 2), and his dock must not keep a ● for it either.
    await db.update(leads).set({ ownerId: P.B }).where(eq(leads.id, LK));
    await addThreadMessage({ ref: { kind: 'client', id: K }, body: 'B yozdi' }, ctx(P.B));
    expect(await noteRecipients('client', K, null)).not.toContain(P.S);
    expect(await listed(P.S)).toBe(false);
    expect(await listed(P.B)).toBe(true);
    // A logist past author is not a plain seller: never judged.
    await addThreadMessage({ ref: { kind: 'client', id: K }, body: 'logist' }, ctx(P.C2));
    expect(await listed(P.C2)).toBe(true);
  });
});

describe('17d. a mention outranks involvement — the dock and the ping agree', () => {
  it('a plain seller no longer involved with the client, then @-named there, is pinged AND finds the thread in his dock', async () => {
    const K = await client(null);
    const LK = await lead(P.S, K);
    await addThreadMessage({ ref: { kind: 'client', id: K }, body: `oldingi yozuv ${SFX}` }, ctx(P.S));
    const listed = async (who: string) =>
      (await myThreads(await actorOf(who))).some((r) => r.kind === 'client' && r.id === K);
    // Handed to B: S is out of the thread (17c) …
    await db.update(leads).set({ ownerId: P.B }).where(eq(leads.id, LK));
    expect(await listed(P.S)).toBe(false);
    // … until B names him. The mention reaches him with no involvement filter (E2 a) …
    const body = `@Ichki Sotuvchi ${SFX} bu mijozni bilasizmi?`;
    const named = await addThreadMessage({ ref: { kind: 'client', id: K }, body }, ctx(P.B));
    await announceNote({
      entityType: 'client',
      entityId: K,
      note: body,
      authorId: P.B,
      activityId: named.activityId,
      calcRequestId: null,
    });
    const pings = await pingsOf(named.activityId);
    expect(pings.filter((p) => p.userId === P.S).map((p) => p.type)).toEqual(['MentionedInNote']);
    expect(await noteRecipients('client', K, null)).not.toContain(P.S);
    // … so the thread he was called into is in his «👥 Ichki» — new until read.
    const row = (await myThreads(await actorOf(P.S))).find((r) => r.kind === 'client' && r.id === K);
    expect(row?.unread).toBe(true);
    expect(row?.href).toBe(`/admin/clients/${K}#ichki`);
  });
});

describe('19. the lenta’s hint', () => {
  it('points the seller to the calc thread while an open calculation has a question — and only then', async () => {
    const L = await lead(P.S);
    const R = await request('lead', L, P.S, P.V);
    expect(await openCalcThreadOn({ entityType: 'lead', entityId: L })).toBe(false);
    await addThreadMessage({ ref: { kind: 'calc', id: R }, body: 'savol' }, ctx(P.V));
    expect(await openCalcThreadOn({ entityType: 'lead', entityId: L })).toBe(true);
    // The hint is load-bearing: an untagged lenta note reaches nobody in the
    // calculation's audience who is not a card-thread recipient.
    expect(await noteRecipients('lead', L, null)).not.toContain(P.V);
    await db.update(calcRequests).set({ completedAt: new Date() }).where(eq(calcRequests.id, R));
    expect(await openCalcThreadOn({ entityType: 'lead', entityId: L })).toBe(false);
  });
});
