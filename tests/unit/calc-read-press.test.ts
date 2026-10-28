import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  registerCalcIntakeReadWorker,
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

function fakeCtx() {
  const replies: { text: string; extra?: Record<string, unknown> }[] = [];
  return {
    replies,
    texts: () => replies.map((r) => r.text),
    async reply(text: string, extra?: Record<string, unknown>) {
      replies.push({ text, extra });
      return { message_id: 100 + replies.length };
    },
  };
}

beforeEach(() => {
  resetReadingDrive();
  model.analyze.mockReset();
  // An answer, so a reading that ran here would be SEEN running (the spy),
  // not merely crash on an undefined answer.
  model.analyze.mockResolvedValue({ ok: false, failure: 'network' });
});
afterEach(() => {
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
    // The model is the JOB's: nothing on the poller ever reaches it.
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

    await handleCalcCallback(ctx, chatId, 'done');
    expect(ctx.texts()).not.toContain(LIVE);
    expect(readingsEnqueued(chatId)).toHaveLength(1);
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
});
