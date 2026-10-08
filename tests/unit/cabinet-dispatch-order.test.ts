import { describe, expect, it, vi } from 'vitest';
import { __dispatchSettled, CABINET_ANSWER_MS, dispatch } from '@/modules/platform/telegram/client-cabinet';

/**
 * The cabinet's dispatched answers, one chat at a time (Q5 a, judge W5): a
 * customer's backlog of «📦 Yuklarim», «💰 Balans», «🧾 Tarix» arrives after a
 * deploy as three updates in a row, and three parallel answers interleave —
 * the cargo list split by the balance. Still off the poller (#706), and two
 * chats still run side by side.
 */
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('dispatch', () => {
  it('one chat: the answers finish in the order they were asked, the slow first one included', async () => {
    const done: string[] = [];
    dispatch('cargo', 9_001, async () => {
      await tick(40);
      done.push('cargo');
    });
    dispatch('balance', 9_001, async () => {
      done.push('balance');
    });
    await __dispatchSettled();
    expect(done).toEqual(['cargo', 'balance']);
  });

  it('two chats: the second chat does not wait for the first', async () => {
    const done: string[] = [];
    dispatch('cargo', 9_002, async () => {
      await tick(60);
      done.push('A');
    });
    dispatch('cargo', 9_003, async () => {
      await tick(5);
      done.push('B');
    });
    await __dispatchSettled();
    expect(done).toEqual(['B', 'A']);
  });

  it('a throwing answer does not stop the next one, and the settled wait waits for all', async () => {
    const done: string[] = [];
    dispatch('history', 9_004, async () => {
      throw new Error('telegram refused');
    });
    dispatch('manager', 9_004, async () => {
      await tick(10);
      done.push('manager');
    });
    await __dispatchSettled();
    expect(done).toEqual(['manager']);
  });

  it('an answer that never settles holds its chat for the ceiling and no longer (Q5-1)', async () => {
    vi.useFakeTimers();
    try {
      const done: string[] = [];
      // A storage read that never answers, a socket nobody closes — whatever
      // the next unbounded link is, the customer's later taps still come.
      dispatch('photos', 9_005, () => new Promise(() => {}));
      dispatch('cargo', 9_005, async () => {
        done.push('cargo');
      });
      await vi.advanceTimersByTimeAsync(CABINET_ANSWER_MS - 1);
      expect(done).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toEqual(['cargo']);
    } finally {
      vi.useRealTimers();
    }
  });
});
