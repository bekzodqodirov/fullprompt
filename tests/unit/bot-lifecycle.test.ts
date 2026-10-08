import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';
import {
  __resetLifecycle,
  installBotShutdown,
  isBacklog,
  lastDoneUpdateId,
  markBoot,
  stopTelegramBot,
  stoppingGuard,
  updateSummary,
} from '@/modules/platform/telegram/lifecycle';

/**
 * The bot's stop (Q5 a): it confirms to Telegram exactly what FINISHED.
 *
 * grammy's own `bot.stop()` confirms `lastTriedUpdateId + 1` — the update
 * being handled at that instant, marked done before it is — and its loop goes
 * on handling the rest of the batch after the stop. So the guard HOLDS what
 * arrives after the signal and the stop confirms `lastDone + 1` itself; only
 * when the poller is idle in its long poll is `bot.stop()` exactly right.
 */

const middleware = stoppingGuard();
/** The guard as a promise — a MiddlewareFn returns MaybePromise<unknown>. */
const guard = (ctx: Context, next: () => Promise<void>): Promise<unknown> => Promise.resolve(middleware(ctx, next));
const ctxOf = (id: number) => ({ update: { update_id: id } }) as unknown as Context;
const never = new Promise<never>(() => {});

function fakeBot(running = true) {
  const log: string[] = [];
  const confirms: Record<string, unknown>[] = [];
  return {
    log,
    confirms,
    bot: {
      isRunning: () => running,
      stop: vi.fn(async () => {
        log.push('stop');
      }),
      api: {
        getUpdates: vi.fn(async (other: Record<string, unknown>) => {
          log.push('confirm');
          confirms.push(other);
          return [];
        }),
      },
    },
  };
}

/** A flush that records when it ran. */
const flushOf = (log: string[], ms = 0) => async () => {
  log.push('flush-start');
  if (ms) await new Promise((r) => setTimeout(r, ms));
  log.push('flush-end');
};

beforeEach(() => __resetLifecycle());
afterEach(() => {
  vi.useRealTimers();
  __resetLifecycle();
});

describe('the backlog line', () => {
  it('nothing is backlog before the boot; before it is, at or after it is not', () => {
    expect(isBacklog(1)).toBe(false);
    markBoot(new Date(1_000_000_000));
    expect(isBacklog(999_999)).toBe(true);
    expect(isBacklog(1_000_000)).toBe(false);
    expect(isBacklog(1_000_001)).toBe(false);
  });
});

describe('(a) the guard', () => {
  it('records the finished update, and once stopping it HOLDS — the next middleware never runs', async () => {
    await guard(ctxOf(41), async () => {});
    expect(lastDoneUpdateId()).toBe(41);
    const { bot } = fakeBot(false);
    await stopTelegramBot({ bot: bot as never, flush: async () => {}, drain: async () => {} });
    let ran = false;
    const held = guard(ctxOf(42), async () => {
      ran = true;
    });
    const raced = await Promise.race([held.then(() => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 50))]);
    expect(raced).toBe('pending');
    expect(ran).toBe(false);
    expect(lastDoneUpdateId()).toBe(41);
  });
});

describe('(b) the stop', () => {
  it('idle in the long poll: grammy’s own stop, and no confirm of ours', async () => {
    await guard(ctxOf(10), async () => {});
    const { bot, log } = fakeBot();
    const out = await stopTelegramBot({ bot: bot as never, flush: flushOf(log), drain: async () => {} });
    expect(out.via).toBe('stop');
    expect(bot.stop).toHaveBeenCalledTimes(1);
    expect(bot.api.getUpdates).not.toHaveBeenCalled();
    expect(log).toEqual(['flush-start', 'flush-end', 'stop']);
  });

  it('an update finished and the next one HELD: confirms through the finished one, never grammy’s stop', async () => {
    await guard(ctxOf(20), async () => {});
    const { bot, confirms } = fakeBot();
    const stopping = stopTelegramBot({ bot: bot as never, flush: async () => {}, drain: async () => {} });
    void guard(ctxOf(21), async () => {});
    const out = await stopping;
    expect(out.via).toBe('confirm');
    expect(confirms).toEqual([{ offset: 21, limit: 1, timeout: 0 }]);
    expect(bot.stop).not.toHaveBeenCalled();
  });

  it('an update still running at the deadline is NOT confirmed — the one before it is', async () => {
    await guard(ctxOf(30), async () => {});
    void guard(ctxOf(31), () => never);
    const { bot, confirms } = fakeBot();
    const started = Date.now();
    const out = await stopTelegramBot({ bot: bot as never, flush: async () => {}, drain: async () => {}, deadlineMs: 300 });
    expect(out.via).toBe('confirm');
    expect(out.inFlightFinished).toBe(false);
    expect(confirms).toEqual([{ offset: 31, limit: 1, timeout: 0 }]);
    expect(Date.now() - started).toBeLessThanOrEqual(300 + 50);
  });

  it('an in-flight update that REJECTS: the stop still flushes and confirms, and never throws', async () => {
    const failing = guard(ctxOf(40), async () => {
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('handler failed');
    }).catch(() => 'caught');
    const { bot, log } = fakeBot();
    const out = await stopTelegramBot({ bot: bot as never, flush: flushOf(log), drain: async () => {} });
    expect(await failing).toBe('caught');
    expect(['stop', 'confirm']).toContain(out.via);
    expect(log).toContain('flush-end');
    expect(log.indexOf('flush-end')).toBeLessThan(Math.max(log.indexOf('stop'), log.indexOf('confirm')));
    expect(lastDoneUpdateId()).toBe(40);
    // …and the throw itself ENDED the wait: a rejection that only the 3 s
    // budget could end would stall every deploy whose last update failed.
    expect(out.ms).toBeLessThan(1_000);
  });

  it('the membership chain is drained inside the budget, and the flush comes BEFORE the confirm', async () => {
    await guard(ctxOf(50), async () => {});
    const { bot, log } = fakeBot();
    const drain = async () => {
      await new Promise((r) => setTimeout(r, 30));
      log.push('drained');
    };
    await stopTelegramBot({ bot: bot as never, flush: flushOf(log, 10), drain });
    expect(log).toEqual(['drained', 'flush-start', 'flush-end', 'stop']);
  });
});

describe('(c) the signal', () => {
  const targetOf = () => Object.assign(new EventEmitter(), { kill: vi.fn(), pid: 4242 });

  it('a prior listener (Next’s cleanup) runs only AFTER the stop resolved', async () => {
    const target = targetOf();
    const order: string[] = [];
    target.on('SIGTERM', () => order.push('next-cleanup'));
    let finish: () => void = () => {};
    installBotShutdown(target as never, () => new Promise<void>((r) => (finish = () => (order.push('stopped'), r()))));
    target.emit('SIGTERM', 'SIGTERM');
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    finish();
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['stopped', 'next-cleanup']);
  });

  it('a stop that never settles still hands the signal on at the deadline', async () => {
    vi.useFakeTimers();
    const target = targetOf();
    const cleanup = vi.fn();
    target.on('SIGTERM', cleanup);
    installBotShutdown(target as never, () => never, 5_000);
    target.emit('SIGTERM', 'SIGTERM');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('nobody listened before: the default action, exactly as before', async () => {
    const target = targetOf();
    installBotShutdown(target as never, async () => {});
    target.emit('SIGINT', 'SIGINT');
    await new Promise((r) => setTimeout(r, 20));
    expect(target.kill).toHaveBeenCalledWith(4242, 'SIGINT');
  });

  it('installed twice, still one listener per signal', () => {
    const target = targetOf();
    installBotShutdown(target as never, async () => {});
    installBotShutdown(target as never, async () => {});
    expect(target.listenerCount('SIGTERM')).toBe(1);
    expect(target.listenerCount('SIGINT')).toBe(1);
  });
});

describe('the error line names the update', () => {
  it('id, kind and chat', () => {
    expect(updateSummary({ update_id: 7, message: { chat: { id: 99 } } } as never)).toEqual({ id: 7, kind: 'message', chatId: 99 });
    expect(updateSummary({ update_id: 8, callback_query: { message: { chat: { id: 5 } }, from: { id: 6 } } } as never)).toEqual({
      id: 8,
      kind: 'callback_query',
      chatId: 5,
    });
  });
});
