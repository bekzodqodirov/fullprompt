import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «✅ Bo‘ldi» since the reading is a pg-boss job (docs/SAKKIZ-R3.md §7.2.3):
 * the press mints the token and the job's id, sends the notice, writes the
 * collection and ENQUEUES — the model is never called on the poller. And the
 * wall clock the job runs under (§7.2.1), pinned as a SUM, because pg-boss 10
 * races a handler against its expiry and retries the job while the loser
 * keeps running: a step outside the sum was a second paid model call.
 *
 * The model, pg-boss and Telegram are stand-ins.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', () => ({ aiCalcBudgetLeft: async () => 100, recordAiPass: async () => {} }));
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);
/** P1's answer to the press's flush, played: false = a sealed store or a write that failed. */
const store = vi.hoisted(() => ({ flushAnswer: true }));
vi.mock('@/modules/platform/telegram/calc-store', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/platform/telegram/calc-store')>();
  return {
    ...real,
    flushIntakeWrites: async (chatId?: bigint) => (store.flushAnswer ? real.flushIntakeWrites(chatId) : false),
  };
});

import { INTAKE_TIMEOUT_MS } from '@/modules/wms/calc/intake-ai';
import { activeIntake, endIntake, startIntake, updateIntake } from '@/modules/platform/telegram/calc-intake';
import {
  ANALYSIS_STALE_MS,
  INTAKE_DELIVERY_RESERVE_MS,
  INTAKE_FILES_BUDGET_MS,
  INTAKE_HYDRATE_WAIT_MS,
  INTAKE_READ_EXPIRE_S,
  INTAKE_READ_RETRY,
  INTAKE_READ_WORKERS,
  INTAKE_STEP_SLACK_MS,
  JOB_CALC_INTAKE_READ,
  readingAlive,
  registerCalcIntakeReadWorker,
  type IntakeReadJob,
} from '@/modules/platform/telegram/calc-read';
import { handleCalcCallback } from '@/modules/platform/telegram/staff-handlers';
import { readingsEnqueued, refuseNextEnqueue, resetReadingDrive } from '../fixtures/calc-read-drive';

const LIVE = '⏳ Tahlil davom etmoqda — natijani kuting.';
const NOTICE = '⏳ AI o‘qiyapti… (3 daqiqagacha)';
const REFUSED = 'Tahlilni boshlab bo‘lmadi — «Bo‘ldi» ni qayta bosing.';

let seq = 0;
const chats: bigint[] = [];
function collection(patch: Partial<Parameters<typeof updateIntake>[1]> = {}): bigint {
  seq += 1;
  const chatId = BigInt(-9_920_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, 'rastamojka', { staffId: 'staff-test' });
  updateIntake(chatId, { stage: 'material', clientHintRaw: 'GS777', material: ['Kurtka 300 dona 150 kg'], ...patch });
  return chatId;
}

function fakeCtx(hold?: { notice: Promise<void> }) {
  const replies: { text: string; extra?: Record<string, unknown> }[] = [];
  return {
    replies,
    texts: () => replies.map((r) => r.text),
    async reply(text: string, extra?: Record<string, unknown>) {
      replies.push({ text, extra });
      const id = 100 + replies.length;
      if (hold && text === NOTICE) await hold.notice;
      return { message_id: id };
    },
  };
}

/**
 * Whatever the press set going without awaiting it gets its turn before an
 * assertion about it. The reading's modules are loaded first (`beforeAll`),
 * so a reading set going reaches the model within a few ticks: on a cold
 * module the first dynamic import alone outlasts the wait, and a red proof
 * would stay green on the import's time, not on the code.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

beforeAll(async () => {
  await import('@/modules/wms/calc/intake-manual');
  await import('@/modules/wms/calc/intake');
  await import('@/modules/wms/calc/ai-cost');
  // The job reads through P1's `loadIntake`, which in a process with no bot
  // answers «not hydrated» at once: this file stands in for the start's mark.
  const { markIntakesHydrated } = await import('@/modules/platform/telegram/calc-store');
  markIntakesHydrated();
});

beforeEach(() => {
  resetReadingDrive();
  store.flushAnswer = true;
  model.analyze.mockReset();
  // An answer, so a reading that ran here would be SEEN running (the spy),
  // not merely crash on an undefined answer.
  model.analyze.mockResolvedValue({ ok: false, failure: 'network' });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const id of chats.splice(0)) endIntake(id);
});

describe('the press enqueues the reading and calls no model (§7.2.3)', () => {
  it('one job: the chat, the note, the token; its id is the stored `analysingJob`; its own expiry', async () => {
    const chatId = collection();
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');

    const live = activeIntake(chatId)!;
    const jobs = readingsEnqueued(chatId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toEqual({
      chatId: String(chatId),
      noteId: live.noteId,
      token: live.analysing,
      noticeMessageId: 101,
    });
    expect(jobs[0]!.options).toMatchObject({
      id: live.analysingJob,
      expireInSeconds: 300,
      retryLimit: INTAKE_READ_RETRY,
    });
    expect(live.analysing).toEqual(expect.any(String));
    expect(live.analysingAt).toEqual(expect.any(Number));
    // The model is the JOB's: nothing on the poller ever reaches it — not even
    // a reading the press set going without awaiting it (review spec-2: the
    // `void` dispatch this replaces reached the model only after the press
    // returned, so the spy is asked once that work has had its turn).
    await settle();
    expect(model.analyze).not.toHaveBeenCalled();
    expect(ctx.texts()).toEqual([NOTICE]);
    // The notice is the collection's own message (its buttons are owned).
    expect(live.ownMessageIds).toContain(101);
  });

  it('a second press while it reads says so and enqueues nothing', async () => {
    const chatId = collection();
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    await handleCalcCallback(ctx, chatId, 'reread');
    expect(ctx.texts().at(-1)).toBe(LIVE);
    expect(readingsEnqueued(chatId)).toHaveLength(1);
  });

  it('a queue that refuses the send: the token is released and the seller told — the next press enqueues', async () => {
    const chatId = collection();
    const ctx = fakeCtx();
    refuseNextEnqueue();
    await handleCalcCallback(ctx, chatId, 'done');
    expect(ctx.texts().at(-1)).toBe(REFUSED);
    expect(JSON.stringify(ctx.replies.at(-1)?.extra?.reply_markup)).toContain('c:done');
    expect(activeIntake(chatId)).toMatchObject({ analysing: null, analysingAt: null, analysingJob: null });
    expect(readingsEnqueued(chatId)).toHaveLength(0);
    // Its «Bo‘ldi» is the collection's own: pressed, it is a «Bo‘ldi», never
    // «Bu tugma eskirgan.» under the sentence that asked for it (review adv-1).
    const refused = 100 + ctx.replies.length;
    expect(activeIntake(chatId)!.ownMessageIds).toContain(refused);

    await handleCalcCallback(
      Object.assign(ctx, { callbackQuery: { message: { message_id: refused } } }),
      chatId,
      'done',
    );
    expect(ctx.texts()).not.toContain(LIVE);
    expect(readingsEnqueued(chatId)).toHaveLength(1);
  });

  it('a collection the store did not take (sealed by a stop, or a failed write): refused in words, the token released, no job', async () => {
    const chatId = collection();
    const ctx = fakeCtx();
    store.flushAnswer = false;
    await handleCalcCallback(ctx, chatId, 'done');
    // A job enqueued here would reach a new process with no token in the row
    // and return in silence under a «⏳» nobody answers (review adv-10).
    expect(readingsEnqueued(chatId)).toHaveLength(0);
    expect(ctx.texts().at(-1)).toBe(REFUSED);
    expect(activeIntake(chatId)).toMatchObject({ analysing: null, analysingAt: null, analysingJob: null });
    expect(activeIntake(chatId)!.ownMessageIds).toContain(100 + ctx.replies.length);

    store.flushAnswer = true;
    await handleCalcCallback(ctx, chatId, 'done');
    expect(readingsEnqueued(chatId)).toHaveLength(1);
  });

  it('«Bo‘ldi» is refused for no file: the two file questions are gone (his 1a, docs/IKKI-ESHIK.md §1.1)', async () => {
    // Re-anchored: this pinned «Avval ikkinchi fayl haqida javob bering» and «Avval javob bering:
    // …boshqa zavodmi?» with their keyboards. He refused both questions; the press now reads.
    const invoice = collection({ pendingInvoice: { goods: [], label: '«B.xlsx»', texts: [] } });
    const a = fakeCtx();
    await handleCalcCallback(a, invoice, 'done');
    expect(a.texts()).toEqual([NOTICE]);
    expect(JSON.stringify(a.replies.map((r) => r.extra?.reply_markup ?? null))).not.toMatch(/c:inv_|c:other_/);
    expect(readingsEnqueued(invoice)).toHaveLength(1);

    const other = collection({ aiGoods: 'ask' });
    const b = fakeCtx();
    await handleCalcCallback(b, other, 'done');
    expect(b.texts()).toEqual([NOTICE]);
    expect(readingsEnqueued(other)).toHaveLength(1);
  });

  it('a notice that hangs past the sweep’s minute of grace: the press stays alive, and its job id is stored only once the notice is out', async () => {
    const chatId = collection({ analysingJob: 'an-older-reading' });
    let out: () => void = () => {};
    const ctx = fakeCtx({ notice: new Promise<void>((resolve) => (out = resolve)) });
    const pressing = handleCalcCallback(ctx, chatId, 'done');
    await vi.waitFor(() => expect(ctx.texts()).toContain(NOTICE));
    const hung = activeIntake(chatId)!;
    // Two minutes on, the job not yet enqueued: still alive (review adv-14).
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 120_000);
    expect(await readingAlive(hung)).toBe(true);
    // …because no job id stands yet — never the previous reading's, which
    // the sweep would find finished.
    expect(hung.analysingJob).toBeNull();
    out();
    await pressing;
    const live = activeIntake(chatId)!;
    expect(readingsEnqueued(chatId).map((j) => j.options.id)).toEqual([live.analysingJob]);
    expect(await readingAlive(live)).toBe(true);
  });

  it('a token minted 23 minutes ago is taken over by the next press', async () => {
    expect(ANALYSIS_STALE_MS).toBe(22 * 60_000);
    const chatId = collection({ analysing: 'old-token', analysingAt: Date.now() - 23 * 60_000, analysingJob: 'old-job' });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    expect(ctx.texts()).not.toContain(LIVE);
    const live = activeIntake(chatId)!;
    expect(live.analysing).not.toBe('old-token');
    expect(readingsEnqueued(chatId).map((j) => j.data.token)).toEqual([live.analysing]);
  });

  it('…while one minted a minute ago still holds', async () => {
    const chatId = collection({ analysing: 'young-token', analysingAt: Date.now() - 60_000, analysingJob: 'young-job' });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    expect(ctx.texts()).toEqual([LIVE]);
    expect(readingsEnqueued(chatId)).toHaveLength(0);
  });
});

describe('the one wall clock and its workers (§7.2.1, §7.2.2)', () => {
  it('hydrate + files + model + delivery + slack fit pg-boss’s expiry, less the handler’s own 10 s', () => {
    expect(
      INTAKE_HYDRATE_WAIT_MS + INTAKE_FILES_BUDGET_MS + INTAKE_TIMEOUT_MS + INTAKE_DELIVERY_RESERVE_MS + INTAKE_STEP_SLACK_MS,
    ).toBeLessThanOrEqual(INTAKE_READ_EXPIRE_S * 1000 - 10_000);
    expect(INTAKE_READ_EXPIRE_S).toBe(300);
  });

  it('four workers, each with `includeMetadata` (or the handler cannot know its last attempt)', async () => {
    const boss = { createQueue: vi.fn(async () => {}), work: vi.fn(async () => 'w') };
    await registerCalcIntakeReadWorker(boss as never);
    expect(boss.createQueue).toHaveBeenCalledWith(JOB_CALC_INTAKE_READ);
    expect(INTAKE_READ_WORKERS).toBe(4);
    expect(boss.work).toHaveBeenCalledTimes(INTAKE_READ_WORKERS);
    for (const call of boss.work.mock.calls as unknown[][]) {
      expect(call[0]).toBe(JOB_CALC_INTAKE_READ);
      expect(call[1]).toEqual({ includeMetadata: true });
    }
  });

  it('…and each hands the job’s own `retryCount` on: only the LAST attempt keeps a failed delivery quiet', async () => {
    // Review spec-1: the pin above holds `includeMetadata`, which is worthless
    // if the handler then drops the count — every attempt would think it is
    // the first, and the last would rethrow instead of answering.
    type Handler = (jobs: { data: IntakeReadJob; retryCount?: number }[]) => Promise<void>;
    const handlers: Handler[] = [];
    const boss = {
      createQueue: async () => {},
      work: async (_name: string, _opts: unknown, handler: Handler) => {
        handlers.push(handler);
        return 'w';
      },
    };
    await registerCalcIntakeReadWorker(boss as never);
    // No bot token: every send answers status 0 — a delivery worth retrying.
    const token = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      const pressedOnce = async () => {
        const chatId = collection();
        await handleCalcCallback(fakeCtx(), chatId, 'done');
        return readingsEnqueued(chatId).at(-1)!.data;
      };
      await expect(handlers[0]!([{ data: await pressedOnce(), retryCount: 0 }])).rejects.toThrow('not delivered');
      await expect(handlers[1]!([{ data: await pressedOnce(), retryCount: INTAKE_READ_RETRY }])).resolves.toBeUndefined();
    } finally {
      if (token !== undefined) process.env.TELEGRAM_BOT_TOKEN = token;
    }
  });
});
