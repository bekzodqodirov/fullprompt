import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The add door's one writer against a real database (docs/SAKKIZ-R3.md §9.5,
 * his 1.9 a): while the VED has not started, the seller's addition goes INTO
 * the job and the machine computes again; once a person has, it goes to the
 * VED as words — decided at SAVE time, under the stamp's compare-and-set.
 *
 * The machine's pass is simulated by its stamp and its ticket: `ticketStanding`
 * (P5's, a stub in K) and `queueCalcPrefill` are stood in, so a test can say
 * «a pass is running» and see what was queued. No pg-boss in a test process.
 * The sender is the no-network transport (#530's idiom).
 */
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => null),
}));
vi.mock('@/modules/wms/calc/prefill-queue', async (original) => ({
  ...(await original<typeof import('@/modules/wms/calc/prefill-queue')>()),
  ticketStanding: vi.fn(async () => 'none' as const),
  queueCalcPrefill: vi.fn(async () => true),
}));
vi.mock('@/modules/wms/crm/internal-chat', async (original) => {
  const real = await original<typeof import('@/modules/wms/crm/internal-chat')>();
  return { ...real, announceNote: vi.fn(real.announceNote) };
});

import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcAmendments,
  calcGroups,
  calcRequestItems,
  calcRequests,
  clients,
  crmActivities,
  deals,
  dealStages,
  events,
  leads,
  leadStages,
  notifications,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { enqueue } from '@/modules/platform/jobs/boss';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import { amendWords, runAmendSave, type AmendSaveJob } from '@/modules/platform/telegram/calc-amend';
import {
  amendRequest,
  amendStanding,
  requeueWaitingAmendments,
  threadIdOf,
  type AmendOutcome,
} from '@/modules/wms/calc/amend';
import type { AmendSubmission } from '@/modules/wms/calc/amend-types';
import { queueCalcPrefill, ticketStanding } from '@/modules/wms/calc/prefill-queue';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { saveTable } from '@/modules/wms/calc/workspace';
import { announceNote } from '@/modules/wms/crm/internal-chat';

const SUFFIX = String(Date.now()).slice(-6);
const CHAT = BigInt(`-97${SUFFIX}`);
let sellerId = '';
let vedId = '';
let clientId = '';
let openDealStage = '';
let openLeadStage = '';
let lostLeadStage = '';
const madeDeals: string[] = [];
const madeLeads: string[] = [];
const madeRequests: string[] = [];
const sent: string[] = [];

beforeAll(async () => {
  const [seller] = await db
    .insert(users)
    .values({ phone: `+99891${String(Date.now()).slice(-7)}`, fullName: `Ali ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  sellerId = seller!.id;
  const [ved] = await db
    .insert(users)
    .values({ phone: `+99892${String(Date.now()).slice(-7)}`, fullName: `VED ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  vedId = ved!.id;
  const [client] = await db.insert(clients).values({ clientCode: `AM${SUFFIX}`, name: `Amend mijoz ${SUFFIX}` }).returning();
  clientId = client!.id;
  openDealStage = (await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') }))!.id;
  openLeadStage = (await db.query.leadStages.findFirst({ where: eq(leadStages.kind, 'open') }))!.id;
  lostLeadStage = (await db.query.leadStages.findFirst({ where: eq(leadStages.kind, 'lost') }))!.id;
  process.env.TELEGRAM_BOT_TOKEN = 'amend-test-token';
  __setTelegramTransport(async (url, init) => {
    if (url.endsWith('/sendMessage') && typeof init.body === 'string') {
      sent.push(String((JSON.parse(init.body) as { text?: string }).text ?? ''));
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, date: 0, chat: { id: 1 } } }), { status: 200 });
  });
});

afterEach(async () => {
  // One seller, many requests: each test's job is closed when it is done, so
  // the per-person cap on open jobs (20) never refuses the next landing.
  if (madeRequests.length > 0) {
    await db
      .update(calcRequests)
      .set({ completedAt: new Date(), completedVia: 'lines' })
      .where(and(inArray(calcRequests.id, madeRequests), sql`${calcRequests.completedAt} IS NULL`));
  }
  vi.mocked(ticketStanding).mockReset().mockResolvedValue('none');
  vi.mocked(queueCalcPrefill).mockClear();
  vi.mocked(enqueue).mockClear();
  vi.mocked(announceNote).mockClear();
  sent.length = 0;
});

afterAll(async () => {
  __setTelegramTransport(null);
  delete process.env.TELEGRAM_BOT_TOKEN;
  await db.delete(notifications).where(inArray(notifications.userId, [sellerId, vedId]));
  if (madeRequests.length > 0) {
    await db.delete(calcAmendments).where(inArray(calcAmendments.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db.select({ taskId: calcRequests.taskId }).from(calcRequests).where(inArray(calcRequests.id, madeRequests));
    // `calc_request_id` is SQL-only this release (the thread round's own rule).
    await db.execute(sql`DELETE FROM crm_activities WHERE calc_request_id IN (${sql.join(
      madeRequests.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`);
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const ids = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (ids.length > 0) {
      await db.delete(events).where(inArray(events.entityId, ids));
      await db.delete(tasks).where(inArray(tasks.id, ids));
    }
  }
  const cards = [...madeDeals, ...madeLeads];
  if (cards.length > 0) await db.delete(crmActivities).where(inArray(crmActivities.entityId, cards));
  if (madeLeads.length > 0) await db.delete(leads).where(inArray(leads.id, madeLeads));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(inArray(users.id, [sellerId, vedId]));
  await pgClient.end();
});

async function freshDeal(): Promise<string> {
  const [deal] = await db
    .insert(deals)
    .values({ code: `AM-${SUFFIX}-${madeDeals.length}`, clientId, stageId: openDealStage, title: 'Amend', createdBy: sellerId })
    .returning();
  madeDeals.push(deal!.id);
  return deal!.id;
}

async function freshLead(): Promise<string> {
  const [lead] = await db
    .insert(leads)
    .values({ name: `Amend lid ${SUFFIX}-${madeLeads.length}`, stageId: openLeadStage, ownerId: sellerId, createdBy: sellerId })
    .returning();
  madeLeads.push(lead!.id);
  return lead!.id;
}

type Item = Parameters<typeof openCalcRequest>[0]['items'][number];

async function land(
  items: Item[],
  opts: { lead?: boolean; weightKg?: number; volumeM3?: number; fromCity?: string; toCity?: string } = {},
): Promise<{ requestId: string; entityId: string; items: { id: string; seq: number }[] }> {
  const entityId = opts.lead ? await freshLead() : await freshDeal();
  const r = await openCalcRequest(
    {
      entityType: opts.lead ? 'lead' : 'deal',
      entityId,
      section: 'rastamojka',
      items,
      weightKg: opts.weightKg ?? null,
      volumeM3: opts.volumeM3 ?? null,
      fromCity: opts.fromCity ?? null,
      toCity: opts.toCity ?? null,
      source: 'card',
    },
    { actorId: sellerId },
  );
  madeRequests.push(r.id);
  const rows = await db
    .select({ id: calcRequestItems.id, seq: calcRequestItems.seq })
    .from(calcRequestItems)
    .where(eq(calcRequestItems.requestId, r.id))
    .orderBy(calcRequestItems.seq);
  return { requestId: r.id, entityId, items: rows };
}

const sub = (over: Partial<AmendSubmission> = {}): AmendSubmission => ({
  rowAnswers: [],
  newLines: [],
  totals: null,
  route: null,
  conflicts: [],
  doubtedTotals: [],
  material: [],
  fileCount: 0,
  ...over,
});

const amend = (requestId: string, submission: AmendSubmission, noteId = randomUUID(), staffId = sellerId) =>
  amendRequest({ requestId, staffId, staffName: `Ali ${SUFFIX}`, noteId, chatId: CHAT, submission });

const request = (id: string) =>
  db
    .select({
      rev: calcRequests.rev,
      handsoffRev: calcRequests.handsoffRev,
      weightKg: calcRequests.weightKg,
      volumeM3: calcRequests.volumeM3,
      fromCity: calcRequests.fromCity,
      toCity: calcRequests.toCity,
    })
    .from(calcRequests)
    .where(eq(calcRequests.id, id))
    .then((rows) => rows[0]!);

const itemsOf = (requestId: string) =>
  db.select().from(calcRequestItems).where(eq(calcRequestItems.requestId, requestId)).orderBy(calcRequestItems.seq);

const amendmentsOf = (requestId: string) => db.select().from(calcAmendments).where(eq(calcAmendments.requestId, requestId));

/** The job's thread — `calc_request_id` is SQL-only this release, read raw. */
const threadOf = (requestId: string) =>
  db.execute<{ id: string; note: string; entity_id: string }>(sql`
    SELECT id::text AS id, note, entity_id::text AS entity_id FROM crm_activities
     WHERE calc_request_id = ${requestId}::uuid ORDER BY created_at
  `);

/** A person's ordinary save on the VED's screen — the clock moves, the stamp does not. */
const vedSave = (requestId: string, item: { id: string; seq: number }) =>
  saveTable(requestId, { items: [{ id: item.id, seq: item.seq, note: `VED ${SUFFIX}` }], adds: [] }, { actorId: vedId });

/**
 * Hold the request row FOR UPDATE in a transaction of this test's own while
 * `during` runs — the pg_stat_activity observer idiom (#715): `during` must
 * reach the lock and WAIT there, seen through the pool, before the holder
 * commits what it wrote. Deterministic, never a burst.
 */
async function whileHeld<T>(requestId: string, inHold: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>, during: () => Promise<T>): Promise<{ out: T; waited: boolean }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let holding!: () => void;
  const held = new Promise<void>((r) => (holding = r));
  const holder = db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM calc_requests WHERE id = ${requestId}::uuid FOR UPDATE`);
    await inHold(tx);
    holding();
    await gate;
  });
  await held;
  const pending = during();
  let waited = false;
  for (let i = 0; i < 200 && !waited; i += 1) {
    const rows = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND wait_event <> 'advisory' AND datname = current_database()
    `);
    waited = Number(rows[0]?.n ?? 0) > 0;
    if (!waited) await new Promise((r) => setTimeout(r, 25));
  }
  release();
  await holder;
  return { out: await pending, waited };
}

const kind = (o: AmendOutcome) => o.kind;

describe('(a) open: the addition goes into the rows and the pass runs again', () => {
  it('a row answer, a new line and «jami 3500 kg» are written; the stamp moves with the save', async () => {
    const r = await land([
      { name: `Kurtka ${SUFFIX}`, quantity: 300, weightKg: 150 },
      { name: `Krossovka ${SUFFIX}`, weightKg: 12.5 },
      { name: `Sumka ${SUFFIX}`, quantity: 10 },
    ]);
    const out = await amend(
      r.requestId,
      sub({
        rowAnswers: [{ itemId: r.items[2]!.id, patch: { quantity: 50 } }],
        newLines: [{ name: `Shim ${SUFFIX}`, weightKg: 20 }],
        totals: { weightKg: 3500 },
        material: ['3: 50 dona', 'jami 3500 kg'],
      }),
    );
    expect(kind(out)).toBe('applied');
    if (out.kind !== 'applied') return;
    const rows = await itemsOf(r.requestId);
    expect(Number(rows[2]!.quantity)).toBe(50);
    expect(rows.map((x) => x.name)).toContain(`Shim ${SUFFIX}`);
    const after = await request(r.requestId);
    expect(Number(after.weightKg)).toBe(3500);
    expect(after.handsoffRev).toBe(after.rev);
    expect(after.rev).toBe(out.rev);
    const recorded = await amendmentsOf(r.requestId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ outcome: 'applied', rev: out.rev, staffId: sellerId });
    const thread = await threadOf(r.requestId);
    expect(thread.map((t) => t.id)).toContain(threadIdOf(out.amendmentId, 'applied'));
    expect(thread.find((t) => t.id === threadIdOf(out.amendmentId, 'applied'))!.note).toMatch(
      /^➕ Sotuvchi qo‘shimcha yubordi — so‘rovga yozildi, AI qayta hisoblaydi:\n· 3-qator «Sumka \d+»: 50 dona/,
    );
    expect(vi.mocked(queueCalcPrefill)).toHaveBeenCalledWith({
      requestId: r.requestId,
      staffId: sellerId,
      section: 'rastamojka',
      pass: `amend:${out.amendmentId}`,
      atRev: out.rev,
    });
    expect(await amendWords(out, false)).toMatch(/^✅ So‘rovga qo‘shildi \(AM-\d+-\d+\):\n· 3-qator/);
  });
});

describe('(b) a VED’s screen save after the stamp', () => {
  it('reads «started», writes nothing into the rows, and the VED gets the change lines', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    await vedSave(r.requestId, r.items[0]!);
    expect((await amendStanding(r.requestId)).standing).toBe('started');
    const before = await request(r.requestId);
    const out = await amend(r.requestId, sub({ rowAnswers: [{ itemId: r.items[0]!.id, patch: { quantity: 50 } }] }));
    expect(out).toMatchObject({ kind: 'to_ved', reason: 'started' });
    if (out.kind !== 'to_ved') return;
    expect(Number((await itemsOf(r.requestId))[0]!.quantity)).toBe(10);
    expect((await request(r.requestId)).rev).toBe(before.rev);
    const note = (await threadOf(r.requestId)).find((t) => t.id === threadIdOf(out.amendmentId, 'to_ved'))!;
    expect(note.note).toBe(
      `➕ Sotuvchi qo‘shimcha yubordi — so‘rovga avtomatik yozilmadi (siz ishlayapsiz), o‘zgartirishni kiriting:\n· 1-qator «Sumka ${SUFFIX}»: 50 dona`,
    );
    expect(vi.mocked(queueCalcPrefill)).not.toHaveBeenCalled();
    expect(await amendWords(out, false)).toBe(
      `📨 VED bu so‘rov ustida ishlayapti — qo‘shimchangiz VED ga yuborildi, o‘zgartirishni VED o‘zi kiritadi:\n· 1-qator «Sumka ${SUFFIX}»: 50 dona`,
    );
  });
});

describe('(c) a person saving between the standing and the lock', () => {
  it('the compare-and-set answers `conflict` → the VED’s branch, nothing written', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    const { out, waited } = await whileHeld(
      r.requestId,
      async (tx) => {
        await tx.execute(sql`UPDATE calc_requests SET rev = rev + 1 WHERE id = ${r.requestId}::uuid`);
      },
      () => amend(r.requestId, sub({ rowAnswers: [{ itemId: r.items[0]!.id, patch: { quantity: 50 } }] })),
    );
    expect(waited).toBe(true);
    expect(out).toMatchObject({ kind: 'to_ved', reason: 'started' });
    expect(Number((await itemsOf(r.requestId))[0]!.quantity)).toBe(10);
  });
});

describe('(d) a closed request — keyed on HOW it ended (re-check p4-15)', () => {
  const close = (id: string, set: Record<string, unknown>) =>
    db.update(calcRequests).set({ completedAt: new Date(), ...set }).where(eq(calcRequests.id, id));

  it('answered → «yopilgan (javob berilgan)»', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    await close(r.requestId, { completedVia: 'task', answerAmount: '120.00' });
    const out = await amend(r.requestId, sub({ rowAnswers: [{ itemId: r.items[0]!.id, patch: { quantity: 50 } }] }));
    expect(out).toMatchObject({ kind: 'to_ved', reason: 'closed', ending: 'answered' });
    if (out.kind !== 'to_ved') return;
    expect(await amendWords(out, false)).toBe(
      '📨 Bu so‘rov yopilgan (javob berilgan) — qo‘shimchangiz VED ga yozildi. Yangi hisob kerak bo‘lsa «🧮 Hisoblatish» dan yuboring.',
    );
  });

  it('returned → its reason kept, and the words never promise a reopen', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    await close(r.requestId, { completedVia: 'returned', returnReason: 'kg yo‘q' });
    const out = await amend(r.requestId, sub({ rowAnswers: [{ itemId: r.items[0]!.id, patch: { quantity: 50 } }] }));
    expect(out).toMatchObject({ kind: 'to_ved', reason: 'closed', ending: 'returned', returnReason: 'kg yo‘q' });
    if (out.kind !== 'to_ved') return;
    const words = await amendWords(out, false);
    expect(words).toContain('VED bu so‘rovni sizga qaytargan');
    expect(words).toContain('yangi so‘rov yuboring');
    expect(words).not.toMatch(/qayta ochil/);
  });

  it('closed with no price (`unpriced_task`) → the price-less words, never «javob berilgan»', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    await close(r.requestId, { completedVia: 'task' });
    const out = await amend(r.requestId, sub({ rowAnswers: [{ itemId: r.items[0]!.id, patch: { quantity: 50 } }] }));
    expect(out).toMatchObject({ kind: 'to_ved', ending: 'unpriced_task' });
    if (out.kind !== 'to_ved') return;
    const words = await amendWords(out, false);
    expect(words).toContain('narxsiz yopilgan');
    expect(words).not.toContain('javob berilgan');
  });
});

describe('(e) a machine pass still running', () => {
  it('a ticket whose job is alive is `busy`: the addition is STORED waiting, with its thread message', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    // A deep queue: the ticket is 40 minutes old and its job still alive.
    await db
      .update(calcRequests)
      .set({ aiPassRev: 0, aiPassAt: new Date(Date.now() - 40 * 60_000), aiPassJob: randomUUID() })
      .where(eq(calcRequests.id, r.requestId));
    vi.mocked(ticketStanding).mockResolvedValue('live');
    expect((await amendStanding(r.requestId)).standing).toBe('busy');
    const out = await amend(r.requestId, sub({ rowAnswers: [{ itemId: r.items[0]!.id, patch: { quantity: 50 } }] }));
    expect(out).toMatchObject({ kind: 'waiting', stillWaiting: false });
    if (out.kind !== 'waiting') return;
    expect(await amendmentsOf(r.requestId)).toMatchObject([{ outcome: 'waiting', rev: null }]);
    expect(Number((await itemsOf(r.requestId))[0]!.quantity)).toBe(10);
    const note = (await threadOf(r.requestId)).find((t) => t.id === threadIdOf(out.amendmentId, 'waiting'))!;
    expect(note.note.startsWith('➕ Sotuvchi qo‘shimcha yubordi — AI hisobi tugagach so‘rovga avtomatik yoziladi')).toBe(true);
  });

  it('a ticket whose job is gone is not busy', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    vi.mocked(ticketStanding).mockResolvedValue('none');
    expect((await amendStanding(r.requestId)).standing).toBe('open');
  });
});

describe('(f) one note, once', () => {
  it('the same note id twice → `duplicate`, one row, no second write', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    const noteId = randomUUID();
    const first = await amend(r.requestId, sub({ rowAnswers: [{ itemId: r.items[0]!.id, patch: { quantity: 50 } }] }), noteId);
    expect(first.kind).toBe('applied');
    const rev = (await request(r.requestId)).rev;
    const second = await amend(r.requestId, sub({ rowAnswers: [{ itemId: r.items[0]!.id, patch: { quantity: 60 } }] }), noteId);
    expect(second.kind).toBe('duplicate');
    expect(await amendmentsOf(r.requestId)).toHaveLength(1);
    expect((await request(r.requestId)).rev).toBe(rev);
    expect(Number((await itemsOf(r.requestId))[0]!.quantity)).toBe(50);
  });
});

describe('(g)-(i) the doors that never write', () => {
  it('(g) not the requester → `not_yours`', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    expect(
      (await amend(r.requestId, sub({ rowAnswers: [{ itemId: r.items[0]!.id, patch: { quantity: 50 } }] }), randomUUID(), vedId)).kind,
    ).toBe('not_yours');
  });

  it('(h) a code on a coded row is not written — named in `codesKept` and in the thread', async () => {
    const r = await land([{ name: `Krossovka ${SUFFIX}`, quantity: 40, tnvedCode: '6403990000' }]);
    const out = await amend(r.requestId, sub({ rowAnswers: [{ itemId: r.items[0]!.id, patch: { tnvedCode: '6402990000' } }] }));
    expect(out.kind).toBe('noted');
    if (out.kind !== 'noted') return;
    expect(out.change.codesKept).toEqual([
      { seq: 1, name: `Krossovka ${SUFFIX}`, typed: '6402990000', stored: '6403990000' },
    ]);
    expect((await itemsOf(r.requestId))[0]!.tnvedCode).toBe('6403990000');
    const note = (await threadOf(r.requestId)).find((t) => t.id === threadIdOf(out.amendmentId, 'noted'))!;
    expect(note.note).toContain(`· 1-qator «Krossovka ${SUFFIX}»: sotuvchi kodi 6402990000 (so‘rovda 6403990000 — VED hal qiladi)`);
  });

  it('(i) no stamp (a request from before 0139, or a correction) → `started`', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    await db.update(calcRequests).set({ handsoffRev: null }).where(eq(calcRequests.id, r.requestId));
    expect((await amendStanding(r.requestId)).standing).toBe('started');
    const out = await amend(r.requestId, sub({ rowAnswers: [{ itemId: r.items[0]!.id, patch: { quantity: 50 } }] }));
    expect(out).toMatchObject({ kind: 'to_ved', reason: 'started' });
  });
});

describe('(j)-(l) every number through the door, and the totals that follow', () => {
  it('(j) «Kafel 120 m2» as a new line → measure_unit m2, measure_qty 120 (law-money-4)', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    const out = await amend(r.requestId, sub({ newLines: [{ name: `Kafel ${SUFFIX}`, quantity: 120, unit: 'm2' }] }));
    expect(out.kind).toBe('applied');
    const kafel = (await itemsOf(r.requestId)).find((x) => x.name === `Kafel ${SUFFIX}`)!;
    expect(kafel.measureUnit).toBe('m2');
    expect(Number(kafel.measureQty)).toBe(120);
    expect(kafel.quantity).toBeNull();
  });

  it('(k) a stored Σ m³ of 12 and a new line of 3 m³ → the request reads 15', async () => {
    const r = await land([
      { name: `Kurtka ${SUFFIX}`, quantity: 300, volumeM3: 5 },
      { name: `Sumka ${SUFFIX}`, quantity: 10, volumeM3: 7 },
    ]);
    expect(Number((await request(r.requestId)).volumeM3)).toBe(12);
    const out = await amend(r.requestId, sub({ newLines: [{ name: `Shim ${SUFFIX}`, quantity: 20, volumeM3: 3 }] }));
    expect(out.kind).toBe('applied');
    // `upsaleRows`' `quoted_m3` for an answer offer is COALESCE(v.volume_m3,
    // r.volume_m3) — this very column (amend-wire pins the expression).
    expect(Number((await request(r.requestId)).volumeM3)).toBe(15);
  });

  it('(l) a TYPED m³ and a new line → not re-summed, said stale; brutto stale too', async () => {
    const r = await land(
      [
        { name: `Kurtka ${SUFFIX}`, quantity: 300, volumeM3: 5 },
        { name: `Sumka ${SUFFIX}`, quantity: 10, volumeM3: 7 },
      ],
      { volumeM3: 20, weightKg: 3000 },
    );
    const out = await amend(r.requestId, sub({ newLines: [{ name: `Shim ${SUFFIX}`, quantity: 20, volumeM3: 3 }] }));
    expect(out.kind).toBe('applied');
    if (out.kind !== 'applied') return;
    expect(Number((await request(r.requestId)).volumeM3)).toBe(20);
    expect(out.change.totalsStale).toEqual(['volumeM3', 'weightKg']);
    expect(out.lines).toContain('· ⚠️ umumiy hajm yangilanmagan — yangi tovar qo‘shildi');
    expect(out.lines).toContain('· ⚠️ umumiy brutto yangilanmagan — yangi tovar qo‘shildi');
  });
});

describe('(m) a file that changes no row', () => {
  it('is `noted`: no clock move, no pass, and the thread says the rows did not change (law-money-5)', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    const rev = (await request(r.requestId)).rev;
    const out = await amend(r.requestId, sub({ material: ['packing list'], fileCount: 1 }));
    expect(out.kind).toBe('noted');
    if (out.kind !== 'noted') return;
    expect((await request(r.requestId)).rev).toBe(rev);
    expect(vi.mocked(queueCalcPrefill)).not.toHaveBeenCalled();
    const note = (await threadOf(r.requestId)).find((t) => t.id === threadIdOf(out.amendmentId, 'noted'))!;
    expect(note.note).toBe(
      '➕ Sotuvchi fayl yoki matn yubordi — so‘rov qatorlari o‘zgarmadi, kartadagi lentada:\n· 📎 1 ta fayl kartadagi lentada',
    );
    // The card's lenta note, under the note id the files were pre-bound to.
    const card = await db.execute<{ note: string }>(sql`
      SELECT note FROM crm_activities WHERE entity_id = ${r.entityId}::uuid AND calc_request_id IS NULL
    `);
    expect(card).toHaveLength(1);
    expect(card[0]!.note.startsWith('➕ Qo‘shimcha — 🛃 Rastamojka · AM-')).toBe(true);
  });
});

describe('(n) a stored addition, written when the pass ends', () => {
  async function waitingOn(r: Awaited<ReturnType<typeof land>>) {
    vi.mocked(ticketStanding).mockResolvedValue('live');
    const out = await amend(r.requestId, sub({ rowAnswers: [{ itemId: r.items[0]!.id, patch: { quantity: 50 } }] }));
    expect(out.kind).toBe('waiting');
    vi.mocked(ticketStanding).mockResolvedValue('none');
    vi.mocked(enqueue).mockClear();
    expect(await requeueWaitingAmendments(r.requestId)).toBe(1);
    const [, data, options] = vi.mocked(enqueue).mock.calls[0]!;
    expect(options).toMatchObject({ expireInSeconds: 120, retryLimit: 3 });
    expect(options).not.toHaveProperty('singletonKey');
    return data as AmendSaveJob;
  }

  it('the ticket clears → requeued → `applied`, the seller told ONCE', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    const job = await waitingOn(r);
    await runAmendSave(job, 0);
    expect(await amendmentsOf(r.requestId)).toMatchObject([{ outcome: 'applied' }]);
    expect(Number((await itemsOf(r.requestId))[0]!.quantity)).toBe(50);
    expect(sent.filter((t) => t.startsWith('✅ Kutib turgan qo‘shimchangiz so‘rovga yozildi'))).toHaveLength(1);
    // The same job again (an expired run's twin) says nothing more.
    await runAmendSave(job, 0);
    expect(sent.filter((t) => t.startsWith('✅ Kutib turgan'))).toHaveLength(1);
  });

  it('a VED saved meanwhile → the VED’s branch, «Kutib turgan qo‘shimchangiz VED ga yuborildi»', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    const job = await waitingOn(r);
    await vedSave(r.requestId, r.items[0]!);
    await runAmendSave(job, 0);
    expect(await amendmentsOf(r.requestId)).toMatchObject([{ outcome: 'to_ved' }]);
    expect(Number((await itemsOf(r.requestId))[0]!.quantity)).toBe(10);
    expect(sent.some((t) => t.startsWith('📨 VED bu so‘rov ustida ishlayapti — Kutib turgan qo‘shimchangiz VED ga yuborildi'))).toBe(true);
  });

  it('a stored addition `saveTable` refuses when its turn comes is the VED’s, named — never `waiting` for ever (adv-8)', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    // 1000 lines more than a request may carry: stored while the pass ran,
    // refused by the save when the pass ended.
    vi.mocked(ticketStanding).mockResolvedValue('live');
    const many = Array.from({ length: 1000 }, (_, i) => ({ name: `Qator ${SUFFIX} ${i}`, quantity: 1 }));
    expect((await amend(r.requestId, sub({ newLines: many }))).kind).toBe('waiting');
    vi.mocked(ticketStanding).mockResolvedValue('none');
    vi.mocked(enqueue).mockClear();
    expect(await requeueWaitingAmendments(r.requestId)).toBe(1);
    const job = vi.mocked(enqueue).mock.calls[0]![1] as AmendSaveJob;
    await runAmendSave(job, 0);
    const [row] = await amendmentsOf(r.requestId);
    expect(row!.outcome).toBe('to_ved');
    expect((row!.change as { told?: { reason: string; code?: string } }).told).toMatchObject({ reason: 'refused', code: 'too_many_items' });
    expect(row!.outcomeSentAt).not.toBeNull();
    expect(sent.filter((t) => t.startsWith('📨 Kutib turgan qo‘shimchangizni so‘rovga avtomatik yozib bo‘lmadi — tovarlar juda ko‘p'))).toHaveLength(1);
    expect((await threadOf(r.requestId)).some((t) => t.note.startsWith('➕ Kutib turgan qo‘shimchani so‘rovga avtomatik yozib bo‘lmadi'))).toBe(true);
    // Nothing left waiting for the next settle to hand back.
    vi.mocked(enqueue).mockClear();
    expect(await requeueWaitingAmendments(r.requestId)).toBe(0);
  });

  it('a waiting addition older than a day is not handed back again — named in the log (adv-8)', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    vi.mocked(ticketStanding).mockResolvedValue('live');
    expect((await amend(r.requestId, sub({ rowAnswers: [{ itemId: r.items[0]!.id, patch: { quantity: 50 } }] }))).kind).toBe('waiting');
    vi.mocked(ticketStanding).mockResolvedValue('none');
    await db
      .update(calcAmendments)
      .set({ createdAt: sql`now() - interval '25 hours'` })
      .where(eq(calcAmendments.requestId, r.requestId));
    vi.mocked(enqueue).mockClear();
    expect(await requeueWaitingAmendments(r.requestId)).toBe(0);
    expect(vi.mocked(enqueue)).not.toHaveBeenCalled();
  });

  it('the write of a waited addition owes its OWN ping: a failed one is left for the redo (adv-9)', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    const job = await waitingOn(r);
    const [waitingRow] = await amendmentsOf(r.requestId);
    expect(waitingRow!.announcedAt).not.toBeNull();
    vi.mocked(announceNote).mockRejectedValueOnce(new Error('ping lost'));
    await runAmendSave(job, 0);
    const [row] = await amendmentsOf(r.requestId);
    expect(row!.outcome).toBe('applied');
    expect(row!.announcedAt).toBeNull();
  });

  it('a pass still running keeps it stored, unsaid', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    const job = await waitingOn(r);
    vi.mocked(ticketStanding).mockResolvedValue('live');
    await runAmendSave(job, 0);
    expect(await amendmentsOf(r.requestId)).toMatchObject([{ outcome: 'waiting' }]);
    expect(sent).toEqual([]);
  });
});

describe('(t) a request deleted between the read and the lock (spec-10)', () => {
  it('is the `not_found` outcome — the press’s own words — never a refusal or three retries', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    const [landed] = await db.select({ taskId: calcRequests.taskId }).from(calcRequests).where(eq(calcRequests.id, r.requestId));
    const taskId = landed!.taskId;
    const { out, waited } = await whileHeld(
      r.requestId,
      async (tx) => {
        await tx.execute(sql`DELETE FROM crm_activities WHERE calc_request_id = ${r.requestId}::uuid`);
        await tx.execute(sql`DELETE FROM calc_request_items WHERE request_id = ${r.requestId}::uuid`);
        await tx.execute(sql`DELETE FROM calc_groups WHERE request_id = ${r.requestId}::uuid`);
        await tx.execute(sql`DELETE FROM calc_requests WHERE id = ${r.requestId}::uuid`);
      },
      () => amend(r.requestId, sub({ rowAnswers: [{ itemId: r.items[0]!.id, patch: { quantity: 50 } }] })),
    );
    expect(waited).toBe(true);
    expect(out).toEqual({ kind: 'not_found' });
    if (taskId) {
      await db.delete(events).where(eq(events.entityId, taskId));
      await db.delete(tasks).where(eq(tasks.id, taskId));
    }
  });
});

describe('(o) the cargo patch (law-money-6)', () => {
  it('only `weightKg` → the stored cities and m³ untouched', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }], {
      volumeM3: 12,
      weightKg: 3000,
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
    });
    const out = await amend(r.requestId, sub({ totals: { weightKg: 3500 } }));
    expect(out.kind).toBe('applied');
    expect(await request(r.requestId)).toMatchObject({ weightKg: '3500.000', volumeM3: '12.000', fromCity: 'Yiwu', toCity: 'Toshkent' });
  });
});

describe('(p) the lock answers what the standing could not see (law-money-7)', () => {
  it('a request closed between the standing and the lock → the VED’s branch, `closed`, nothing written', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    const { out, waited } = await whileHeld(
      r.requestId,
      async (tx) => {
        await tx.execute(
          sql`UPDATE calc_requests SET completed_at = now(), completed_via = 'task', answer_amount = 99 WHERE id = ${r.requestId}::uuid`,
        );
      },
      () => amend(r.requestId, sub({ rowAnswers: [{ itemId: r.items[0]!.id, patch: { quantity: 50 } }] })),
    );
    expect(waited).toBe(true);
    expect(out).toMatchObject({ kind: 'to_ved', reason: 'closed', ending: 'answered' });
    expect(Number((await itemsOf(r.requestId))[0]!.quantity)).toBe(10);
  });

  it('a VED’s ✨ claim held → `started`; a machine claim (the ticket) → stored waiting — never «qayta bosing»', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    await db.update(calcRequests).set({ aiProposalStartedAt: new Date() }).where(eq(calcRequests.id, r.requestId));
    const person = await amend(r.requestId, sub({ rowAnswers: [{ itemId: r.items[0]!.id, patch: { quantity: 50 } }] }));
    expect(person).toMatchObject({ kind: 'to_ved', reason: 'started' });

    const m = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }]);
    await db.update(calcRequests).set({ aiProposalStartedAt: new Date() }).where(eq(calcRequests.id, m.requestId));
    // Not standing at the first read; the claim the lock meets is the pass's.
    vi.mocked(ticketStanding).mockResolvedValueOnce('none').mockResolvedValue('live');
    const machine = await amend(m.requestId, sub({ rowAnswers: [{ itemId: m.items[0]!.id, patch: { quantity: 50 } }] }));
    expect(machine).toMatchObject({ kind: 'waiting' });
  });
});

describe('(q) what the save DROPPED is said «yozilmadi» (regression-16)', () => {
  it('«2: 40 juft» on a row whose law asks no juft', async () => {
    const r = await land([
      { name: `Kurtka ${SUFFIX}`, quantity: 300 },
      { name: `Krossovka ${SUFFIX}`, weightKg: 12.5, tnvedCode: '6403990000' },
    ]);
    const [group] = await db
      .insert(calcGroups)
      // A law that counts in kg: «40 juft» is a statement about something else.
      .values({
        requestId: r.requestId,
        seq: 1,
        label: 'Oyoq kiyim',
        tnvedCode: '6403990000',
        dutyPct: '10.000',
        vatPct: '12.000',
        dutyMode: 'max',
        dutyUnit: 'kg',
        dutySpecific: '1.0000',
      })
      .returning();
    await db.update(calcRequestItems).set({ groupId: group!.id }).where(eq(calcRequestItems.id, r.items[1]!.id));
    const out = await amend(r.requestId, sub({ rowAnswers: [{ itemId: r.items[1]!.id, patch: { measureUnit: 'juft', measureQty: 40 } }] }));
    expect(out.kind).toBe('applied');
    if (out.kind !== 'applied') return;
    const line = `· 2-qator «Krossovka ${SUFFIX}»: 40 juft — yozilmadi (kod juft so‘ramaydi)`;
    expect(out.lines).toContain(line);
    const note = (await threadOf(r.requestId)).find((t) => t.id === threadIdOf(out.amendmentId, 'applied'))!;
    expect(note.note).toContain(line);
    expect((await itemsOf(r.requestId))[1]!.measureQty).toBeNull();
  });
});

describe('(r) a stored row the new material restates (product-fit-17)', () => {
  it('«qo‘shilsin» writes 300 + 200; «VED hal qilsin» and an unanswered 120 kg are named, never written', async () => {
    const r = await land([
      { name: `Kurtka ${SUFFIX}`, quantity: 300 },
      { name: `Sumka ${SUFFIX}`, quantity: 10 },
    ]);
    const out = await amend(
      r.requestId,
      sub({
        rowAnswers: [
          { itemId: r.items[0]!.id, patch: { quantity: 500 }, sum: { field: 'quantity', unit: 'dona', stored: 300, read: 200 } } as never,
        ],
        conflicts: [
          { itemId: r.items[1]!.id, seq: 2, name: `Sumka ${SUFFIX}`, field: 'quantity', unit: 'dona', stored: 10, read: 12 },
          { itemId: r.items[1]!.id, seq: 2, name: `Sumka ${SUFFIX}`, field: 'weightKg', unit: 'kg', stored: null, read: 120 },
        ],
      }),
    );
    expect(out.kind).toBe('applied');
    if (out.kind !== 'applied') return;
    const rows = await itemsOf(r.requestId);
    expect(Number(rows[0]!.quantity)).toBe(500);
    expect(Number(rows[1]!.quantity)).toBe(10);
    expect(rows[1]!.weightKg).toBeNull();
    const note = (await threadOf(r.requestId)).find((t) => t.id === threadIdOf(out.amendmentId, 'applied'))!.note;
    expect(note).toContain(`· 1-qator «Kurtka ${SUFFIX}»: 300 + 200 = 500 dona (ikkinchi fayl qo‘shildi)`);
    expect(note).toContain(`· 2-qator «Sumka ${SUFFIX}»: faylda 12 dona (so‘rovda 10) — sotuvchi tanlamadi, VED hal qiladi`);
    expect(note).toContain(`· 2-qator «Sumka ${SUFFIX}»: faylda 120 kg (so‘rovda yo‘q) — sotuvchi tanlamadi, VED hal qiladi`);
  });
});

describe('(s) the card is read off the LOCKED row (re-check p4-4)', () => {
  it('a lead WON between the read and the save → the card note and the thread land on the DEAL', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }], { lead: true });
    const dealId = await freshDeal();
    const { out, waited } = await whileHeld(
      r.requestId,
      async (tx) => {
        // Uch band's win split re-keys a won lead's requests onto its deal.
        await tx.execute(sql`UPDATE calc_requests SET entity_type = 'deal', entity_id = ${dealId}::uuid WHERE id = ${r.requestId}::uuid`);
      },
      () =>
        amend(
          r.requestId,
          sub({ newLines: [{ name: `Shim ${SUFFIX}`, weightKg: 20 }], material: [`Shim ${SUFFIX} 20 kg`] }),
        ),
    );
    expect(waited).toBe(true);
    expect(out.kind).toBe('applied');
    if (out.kind !== 'applied') return;
    const notes = await db.execute<{ id: string; entity_id: string; calc: string | null }>(sql`
      SELECT id::text AS id, entity_id::text AS entity_id, calc_request_id::text AS calc FROM crm_activities
       WHERE entity_id IN (${r.entityId}::uuid, ${dealId}::uuid)
    `);
    const card = notes.filter((n) => n.calc === null);
    expect(card.map((n) => n.entity_id)).toEqual([dealId]);
    expect(notes.find((n) => n.id === threadIdOf(out.amendmentId, 'applied'))!.entity_id).toBe(dealId);
  });

  it('a lead LOST between them → `lead_closed`: no row written, no pass queued, the note on the lost lead', async () => {
    const r = await land([{ name: `Sumka ${SUFFIX}`, quantity: 10 }], { lead: true });
    await db.update(leads).set({ stageId: lostLeadStage }).where(eq(leads.id, r.entityId));
    const out = await amend(
      r.requestId,
      sub({ rowAnswers: [{ itemId: r.items[0]!.id, patch: { quantity: 50 } }], material: ['1: 50 dona'] }),
    );
    expect(out).toMatchObject({ kind: 'to_ved', reason: 'lead_closed' });
    if (out.kind !== 'to_ved') return;
    expect(Number((await itemsOf(r.requestId))[0]!.quantity)).toBe(10);
    expect(vi.mocked(queueCalcPrefill)).not.toHaveBeenCalled();
    const card = await db.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM crm_activities WHERE entity_id = ${r.entityId}::uuid AND calc_request_id IS NULL
    `);
    expect(card).toHaveLength(1);
    const thread = (await threadOf(r.requestId)).find((t) => t.id === threadIdOf(out.amendmentId, 'to_ved'))!;
    expect(thread.note.startsWith('➕ Sotuvchi qo‘shimcha yubordi — so‘rov yopilgan, avtomatik yozilmadi:')).toBe(true);
    expect(await amendWords(out, false)).toBe(
      `📨 Lid yopilgan — qo‘shimchangiz so‘rovga yozilmadi, VED ga yozildi.\n· 1-qator «Sumka ${SUFFIX}»: 50 dona`,
    );
  });
});
