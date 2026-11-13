import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * «AI so‘raydi», end to end (docs/AI-SORAYDI.md §3.4 A1-A3, review JR-13):
 * a request LANDED with three rows the seller still owes something about —
 *  1. coded, under a law that pins the count («kamida $1/dona»), with no count;
 *  2. coded, stating neither a count nor a weight;
 *  3. not coded at all —
 * is queued by the landing's own sender, run by the worker exactly as
 * `boss.ts` registers it, and answered through `sayOnce` into the
 * notification the drain would send. The door is the ROW's:
 *  - «🤖 AI rastamojka» asks all three, by their row numbers, in the block's
 *    one order (review JS-25: a row with no figure, the law's unit, an
 *    uncoded row), under the new head — and the add door prefers the rows it
 *    asked a figure of;
 *  - a request from before the doors (NULL) asks as it did: the law's block,
 *    its one row and today's tails (its lines are numbered by the row, A3);
 *  - «🧮 Hisoblatish» sends the seller nothing.
 *
 * The model is stood in at its two boundaries the way calc-prefill's pass
 * tests inject it — a grouping that codes nothing (`idle`) and a pick with no
 * answers — through the module the pass imports them from, because the worker
 * passes the pass no deps. The SDK beneath them throws: no real call can
 * escape the stand-ins. pg-boss is calc-pass-settle's job table in memory.
 */
type FakeJob = { queue: string; data: Record<string, unknown>; options: Record<string, unknown>; state: string };
const boss = vi.hoisted(() => ({ jobs: new Map<string, FakeJob>() }));
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async (queue: string, data: Record<string, unknown>, options: Record<string, unknown> = {}) => {
    const id = (options.id as string | undefined) ?? globalThis.crypto.randomUUID();
    boss.jobs.set(id, { queue, data, options, state: 'created' });
    return id;
  }),
  jobState: vi.fn(async (queue: string, id: string) => {
    const job = boss.jobs.get(id);
    return job && job.queue === queue ? job.state : null;
  }),
}));
const model = vi.hoisted(() => ({ grouped: 0, picked: 0 }));
vi.mock('@anthropic-ai/sdk', async (original) => {
  const real = await original<typeof import('@anthropic-ai/sdk')>();
  class Refuses extends real.default {
    constructor(opts?: ConstructorParameters<typeof real.default>[0]) {
      super({ ...opts, apiKey: 'test-key' });
      (this as unknown as { messages: unknown }).messages = {
        create: async () => {
          throw new Error('the real API must not be called from this file');
        },
      };
    }
  }
  return { ...real, default: Refuses };
});
vi.mock('@/modules/wms/calc/workspace', async (original) => ({
  ...(await original<typeof import('@/modules/wms/calc/workspace')>()),
  // calc-prefill's `idle`: a grouping that wrote nothing, the revision chain
  // handed back as it came in.
  proposeGroups: async (_requestId: string, _ctx: unknown, opts: { expectRev?: number } = {}) => {
    model.grouped += 1;
    return {
      groups: 0,
      batches: 0,
      failed: 0,
      ratesPulled: 0,
      codesStamped: 0,
      importFilled: 0,
      memoryFilled: 0,
      dictionaryFilled: 0,
      rev: opts.expectRev ?? null,
    };
  },
}));
vi.mock('@/modules/wms/calc/prefill-ai', async (original) => ({
  ...(await original<typeof import('@/modules/wms/calc/prefill-ai')>()),
  pickImportRows: async () => {
    model.picked += 1;
    return { answers: [], usage: null };
  },
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcGroups,
  calcRequestItems,
  calcRequests,
  clients,
  crmActivities,
  dealStages,
  deals,
  events,
  notifications,
  tasks,
  telegramLinks,
  users,
} from '@/modules/platform/db/schema';
import { openCalcRequest, storedRequestFacts } from '@/modules/wms/calc/service';
import { queueCalcPrefill } from '@/modules/wms/calc/prefill-queue';
import { JOB_CALC_PREFILL, registerCalcPrefillWorker, type CalcPrefillJob } from '@/modules/wms/calc/jobs';
import { SELLER_ASKS_HEAD } from '@/modules/wms/calc/ai-reply';
import { AI_NOTE_HEAD, AI_REPLY_HEAD } from '@/modules/wms/calc/reply-heads';
import { SILENT_DOOR_ERROR } from '@/modules/wms/calc/say-once';
import { askedSeqsOf, lawAsksInputOfStored, lawAsksOf, sellerAsksOf } from '@/modules/wms/calc/law-asks';
import type { IntakeDoor } from '@/modules/wms/calc/intake';

const SUFFIX = String(Date.now()).slice(-6);
const CHAT = 720_000_000 + Number(SUFFIX);
const keyBefore = process.env.ANTHROPIC_API_KEY;
let sellerId = '';
let clientId = '';
let dealId = '';
const madeRequests: string[] = [];

type Handler = (jobs: { id: string; name: string; data: CalcPrefillJob; retryCount: number }[]) => Promise<void>;
const handlers = new Map<string, Handler>();

/**
 * The three rows — the SAME names on every door, so the answers can be
 * compared line by line. Row 1 is a sweater under 6110 (the seeded book:
 * «20 %, kamida $1/dona»); row 2 a backpack under 4202 (20 %, no unit
 * pinned); row 3 a part nobody coded.
 */
const SWEATER = `Sviter E2E ${SUFFIX}`;
const BACKPACK = `Ryukzak E2E ${SUFFIX}`;
const PART = `Zapchast XJ-200 E2E ${SUFFIX}`;
const ROWS = [
  { name: SWEATER, tnvedCode: '6110200000', weightKg: 150 },
  { name: BACKPACK, tnvedCode: '4202921100' },
  { name: PART, weightKg: 5 },
];

beforeAll(async () => {
  // A key behind the model, so the pass runs its model steps — into the
  // stand-ins above, never the network.
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const [u] = await db
    .insert(users)
    .values({
      phone: `+99895${String(Number(SUFFIX) * 10 + 7).slice(-7).padStart(7, '0')}`,
      fullName: `AI soraydi ${SUFFIX}`,
      passwordHash: 'x',
      active: true,
    })
    .returning({ id: users.id });
  sellerId = u!.id;
  // A seller who hears: the AI door's answer is a message that goes out.
  await db.insert(telegramLinks).values({ userId: sellerId, telegramChatId: BigInt(CHAT), status: 'linked', linkedAt: new Date() });
  const [client] = await db.insert(clients).values({ clientCode: `AS${SUFFIX}`, name: `AI soraydi mijoz ${SUFFIX}` }).returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({ code: `AS-${SUFFIX}`, clientId, stageId: stage!.id, title: 'AI soraydi fixture', createdBy: sellerId })
    .returning();
  dealId = deal!.id;
  // The worker exactly as `boss.ts` registers it.
  await registerCalcPrefillWorker({
    createQueue: vi.fn(async () => {}),
    work: vi.fn(async (name: string, _opts: unknown, handler: Handler) => {
      handlers.set(name, handler);
      return 'w';
    }),
  } as never);
});

afterAll(async () => {
  if (madeRequests.length > 0) {
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db.select({ taskId: calcRequests.taskId }).from(calcRequests).where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  const handBacks = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.entityId, dealId));
  if (handBacks.length > 0) {
    await db.delete(events).where(inArray(events.entityId, handBacks.map((t) => t.id)));
    await db.delete(tasks).where(inArray(tasks.id, handBacks.map((t) => t.id)));
  }
  await db.delete(crmActivities).where(eq(crmActivities.entityId, dealId));
  await db.delete(notifications).where(eq(notifications.userId, sellerId));
  await db.delete(telegramLinks).where(eq(telegramLinks.userId, sellerId));
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  // An audited fixture user is DEACTIVATED, never deleted (audit_log FK).
  await db.update(users).set({ active: false }).where(eq(users.id, sellerId));
  if (keyBefore === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = keyBefore;
  await pgClient.end();
});

/**
 * Land the three rows on `door`, queue the pass through the landing's own
 * sender, and run its job through the registered worker — then read what the
 * worker left for the seller: the rows the drain would send.
 */
async function landAndRun(
  door: IntakeDoor | null,
  over: {
    section?: 'rastamojka' | 'yolkira';
    items?: { name: string; tnvedCode?: string; weightKg?: number; quantity?: number }[];
    volumeM3?: number | null;
  } = {},
) {
  const section = over.section ?? 'rastamojka';
  const r = await openCalcRequest(
    {
      intakeDoor: door,
      entityType: 'deal',
      entityId: dealId,
      section,
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: 500,
      volumeM3: over.volumeM3 === undefined ? 10 : over.volumeM3,
      items: over.items ?? ROWS,
      source: 'card',
    },
    { actorId: sellerId },
  );
  madeRequests.push(r.id);
  expect(await queueCalcPrefill({ requestId: r.id, staffId: sellerId, section })).toBe(true);
  // A yo‘lkira job rides its own queue (his 2.5 b); the worker serves both.
  const [jobId, job] = [...boss.jobs.entries()].find(([, j]) => j.data.requestId === r.id)!;
  await handlers.get(job.queue)!([{ id: jobId, name: job.queue, data: job.data as unknown as CalcPrefillJob, retryCount: 0 }]);
  const said = await db
    .select({ payload: notifications.payload, status: notifications.status, error: notifications.error })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, sellerId),
        eq(notifications.type, 'CalcPrefilled'),
        sql`${notifications}.payload->>'requestId' = ${r.id}`,
      ),
    );
  return { id: r.id, said };
}

const textOf = (row: { payload: unknown }) => (row.payload as { text: string }).text;

describe('«AI so‘raydi» through the landing, the queue and the worker (A1-A3)', () => {
  let aiText = '';
  let nullText = '';

  it('«🤖»: one message to the seller, its ❓ block asking all three rows by their numbers, in the block’s order, under the new head', async () => {
    const { id, said } = await landAndRun('ai');
    expect(said, 'one answer, and it goes out').toHaveLength(1);
    // Queued for the drain to send — the seller has not muted the answers.
    expect(said[0]!.status).toBe('pending');
    aiText = textOf(said[0]!);
    expect(aiText.startsWith(AI_REPLY_HEAD)).toBe(true);
    // The block, written by hand. Its order is JS-25's: the row with no
    // figure (2), the law's unit (1), the uncoded row (3). The example is a
    // FIGURE for each of the first two figure asks — «300 dona» is the
    // block's own example count.
    expect(aiText).toContain(
      [
        '❓ AI so‘raydi — javob yozsangiz qayta hisoblaydi:',
        `· 2-qator «${BACKPACK}»: soni (dona) yoki sof og‘irligi (kg)`,
        `· 1-qator «${SWEATER}»: soni (dona) — boj kamida $1/dona`,
        `· 3-qator «${PART}»: bu nima — nimadan qilingan, nima uchun ishlatiladi?`,
        '✍️ Shu xabarga reply qilib yozing: «2: 300 dona; 1: 300 dona» — yoki «➕ Shu so‘rovga qo‘shish» ni bosing.',
        // Row 3 is asked in WORDS, which no reply carries in this release
        // (review ask-break-1): said where they go, and who codes it.
        '📝 Nima tovar ekanini (nimadan, nima uchun) kartadagi lentaga yozing — kodni VED xodimi qo‘yadi.',
      ].join('\n'),
    );
    // Row 2 states no figure: its group's refusal is the figure the block
    // asks, the seller's — never «baza yo‘q — VED xodimi qo‘yadi» under the
    // question to him (review ask-break-8). The line opens «2.» alone, so the
    // refusal names no row.
    const lines = aiText.split('\n');
    expect(lines[lines.indexOf(`2. ${BACKPACK} · 4202921100`) + 1]).toBe(
      '   ⚠️ soni (dona) yoki sof og‘irligi (kg) kiritilmagan — mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring',
    );
    expect(SELLER_ASKS_HEAD).toBe('❓ AI so‘raydi — javob yozsangiz qayta hisoblaydi:');
    // The uncoded row stands in its place by its own number (A3), and
    // since the block asks what it is, its line names no VED.
    expect(aiText.split('\n')).toContain(`3. ${PART} — kod yo‘q`);
    // Never the law-only head, never «the VED will ask you» about the seller's own facts.
    for (const w of ['Hisob to‘liq bo‘lishi uchun', 'sizdan so‘raydi']) expect(aiText, w).not.toContain(w);
    // The pass ran its model steps — into the stand-ins (the premise of a
    // «kod yo‘q» after a coding call that answered).
    expect(model.grouped).toBeGreaterThan(0);
    // The add table opened from this answer prefers the rows it asked a
    // FIGURE of — 1 and 2, never 3, which was asked in words (review JR-13:
    // one list per door, read off the stored request as the add door reads it).
    const stored = (await storedRequestFacts(id))!;
    expect(stored.door).toBe('ai');
    expect(askedSeqsOf(sellerAsksOf(lawAsksInputOfStored(stored)))).toEqual([1, 2]);
  });

  it('NULL (a request from before the doors): the law’s block and its one row, today’s tails — line for line, by hand', async () => {
    const { id, said } = await landAndRun(null);
    expect(said).toHaveLength(1);
    expect(said[0]!.status).toBe('pending');
    nullText = textOf(said[0]!);
    // Re-anchored (review ask-spec-3) on literal lines, not on the AI door's
    // rendering — a change to a line both doors share would have kept that
    // comparison green. Each line is the fixture put through the rule:
    expect(nullText).toBe(
      [
        // The title: customs only, the client's code, the deal's code.
        `${AI_REPLY_HEAD} · taxminiy rastamojka · AS${SUFFIX} · AS-${SUFFIX}`,
        // Row 1 alone in its group, opened by its own number (A3, on every
        // door: PA-3's overwrite was the law block's own example). No import
        // is uploaded in this file, so no baza — the VED's — and its 📊 says
        // there was no file to take a median from.
        `1. ${SWEATER} · 6110200000`,
        '   ⚠️ baza yo‘q — VED xodimi qo‘yadi',
        '   📊 taxmin yo‘q: bojxona fayli yuklanmagan',
        // Row 2: nobody asks it on this door, so the engine's own refusal and
        // tail stand as today; its 📊 says why no median could price it.
        `2. ${BACKPACK} · 4202921100`,
        '   ⚠️ baza yo‘q — VED xodimi qo‘yadi',
        '   📊 taxmin yo‘q: qatorda soni ham, og‘irligi ham yo‘q',
        // Row 3, uncoded, in its place by its number (A3) — the VED's to code.
        `3. ${PART} — kod yo‘q — VED xodimi qo‘yadi`,
        // The law's block, as today: row 1's count, under the law's head.
        '❓ Hisob to‘liq bo‘lishi uchun o‘lchov kerak — qonun shuni so‘raydi:',
        `· 1-qator «${SWEATER}»: soni (dona) — boj kamida $1/dona`,
        '✍️ Shu xabarga reply qilib yozing: «1: 300 dona» — yoki «➕ Shu so‘rovga qo‘shish» ni bosing.',
        '━━━━━━━━━━━━',
        // Blocked by two refusals and an uncoded row, with nothing «Aniq» and
        // no Taxminiy: the one sentence, no figure.
        'Rastamojka jami: hozircha hisoblab bo‘lmadi.',
        '⚠️ Rasmiy emas — VED xodimi tasdiqlaydi.',
        // The request's certificate is TRUE by default.
        '📄 Sertifikat: bor (deb hisoblandi)',
        // Two lines carry a 📊 (their reason for none), so the legend is drawn.
        '📊 deklaratsiyalar medianasi (taxminiy)',
      ].join('\n'),
    );
    // …and the add door prefers the law's row alone, as before.
    const stored = (await storedRequestFacts(id))!;
    expect(stored.door).toBeNull();
    expect(lawAsksOf(lawAsksInputOfStored(stored)).map((a) => a.seq)).toEqual([1]);
  });

  it('«🧮»: nothing is sent — the claim alone, muted «oddiy eshik», and the VED’s note asks the seller nothing', async () => {
    const { said } = await landAndRun('plain');
    expect(said).toHaveLength(1);
    expect(said[0]!.status).toBe('muted');
    expect(said[0]!.error).toBe(SILENT_DOOR_ERROR);
    const note = textOf(said[0]!);
    expect(note.startsWith(AI_NOTE_HEAD)).toBe(true);
    for (const w of ['❓', 'reply qilib', 'bu nima', 'Rastamojka jami']) expect(note, w).not.toContain(w);
    // Its note keeps the law's rows (review JR-13): the VED's to get.
    expect(note.split('\n')).toContain(`⚠️ VED uchun: 1-qator «${SWEATER}»: soni (dona).`);
    // The plain door is FROZEN (review ask-break-5): its note names the
    // uncoded row by name, as before this round.
    expect(note).toContain(`⚠️ Kod topilmadi: ${PART} — VED xodimi qo‘yadi`);
  });

  /**
   * Review ask-break-3, the finding's own path: a yo‘lkira job on the AI
   * door whose seller can hear nobody (no linked chat). The card's lenta is
   * then the only copy anyone reads, and it told its reader «mijozdan
   * so‘rab, kartadagi lentaga yozing» with no line for the VED — the customs
   * answer had its «⚠️ VED uchun:» copy, the road's did not.
   */
  it('«🤖» yo‘lkira, a seller nobody reaches: the card carries the VED’s copy — the gap named, «VED xodimi so‘raydi»', async () => {
    await db.delete(telegramLinks).where(eq(telegramLinks.userId, sellerId));
    try {
      const before = new Date();
      await landAndRun('ai', { section: 'yolkira', items: [{ name: `Kurtka yo‘l ${SUFFIX}`, quantity: 10 }], volumeM3: null });
      const notes = await db
        .select({ note: crmActivities.note, at: crmActivities.createdAt })
        .from(crmActivities)
        .where(eq(crmActivities.entityId, dealId));
      const card = notes.filter((n) => n.at >= before).map((n) => n.note ?? '');
      expect(card, 'one card note for this answer').toHaveLength(1);
      // The road's gap, the seller's fact: no cube stored and none on a line.
      expect(card[0]!.split('\n')[1]).toBe('⚠️ VED uchun: umumiy hajm (m³) yo‘q.');
      expect(card[0]).toContain('Yo‘lkira: ⚠️ umumiy hajm (m³) yo‘q — VED xodimi so‘raydi');
      expect(card[0]).not.toContain('kartadagi lentaga yozing');
    } finally {
      await db.insert(telegramLinks).values({ userId: sellerId, telegramChatId: BigInt(CHAT), status: 'linked', linkedAt: new Date() });
    }
  });
});
