import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIEF_RETRY_MAX_S, briefRetry } from '@/modules/platform/telegram/retry';
import { __setTelegramTransport, sendTextBriefRetry } from '@/modules/platform/telegram/send';

/**
 * The burst after a deploy (Q5 a): a 429 that asks for a moment is waited
 * out, at most twice; anything longer is the caller's. Never for the poll,
 * never for a toast.
 */
type Res = { ok: boolean; error_code?: number; description?: string; parameters?: { retry_after?: number }; result?: unknown };
const tooMany = (s: number): Res => ({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: s } });
const fine: Res = { ok: true, result: true };

function prevOf(answers: Res[]) {
  const calls: string[] = [];
  const prev = vi.fn(async (method: string) => {
    calls.push(method);
    return (answers.shift() ?? fine) as never;
  });
  return { prev, calls };
}

const call = (prev: ReturnType<typeof prevOf>['prev'], method: string) =>
  briefRetry(prev as never, method as never, {} as never, undefined);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  __setTelegramTransport(null);
});

describe('briefRetry', () => {
  it('waits out a 429 of one second once, and returns the answer', async () => {
    const { prev, calls } = prevOf([tooMany(1), fine]);
    const pending = call(prev, 'sendMessage');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual(fine);
    expect(calls).toEqual(['sendMessage', 'sendMessage']);
  });

  it('a long wait is the caller’s — returned at once', async () => {
    const { prev, calls } = prevOf([tooMany(30)]);
    expect((await call(prev, 'sendMessage')).ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(BRIEF_RETRY_MAX_S).toBe(5);
  });

  it('three 429s of a second: two retries, then the 429', async () => {
    const { prev, calls } = prevOf([tooMany(1), tooMany(1), tooMany(1), fine]);
    const pending = call(prev, 'sendMessage');
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).ok).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it('never the poll, never a toast', async () => {
    for (const method of ['getUpdates', 'answerCallbackQuery']) {
      const { prev, calls } = prevOf([tooMany(1)]);
      expect((await call(prev, method)).ok).toBe(false);
      expect(calls).toEqual([method]);
    }
  });
});

describe('sendTextBriefRetry', () => {
  it('sends once more after a brief 429, and gives a long one back', async () => {
    const saved = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = '1:T';
    try {
      const answers = [
        { status: 429, body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 1 } } },
        { status: 200, body: { ok: true, result: { message_id: 5 } } },
        { status: 429, body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 30 } } },
      ];
      let calls = 0;
      __setTelegramTransport(async () => {
        calls += 1;
        const next = answers.shift()!;
        return new Response(JSON.stringify(next.body), { status: next.status });
      });
      const first = sendTextBriefRetry({ chatId: 1, text: 'x' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await first).messageId).toBe(5);
      expect(calls).toBe(2);
      const second = await sendTextBriefRetry({ chatId: 1, text: 'y' });
      expect(second.status).toBe(429);
      expect(calls).toBe(3);
    } finally {
      if (saved === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = saved;
    }
  });
});
