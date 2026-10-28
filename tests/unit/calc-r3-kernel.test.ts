import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';
import {
  __resetLifecycle,
  currentUpdateId,
  stopTelegramBot,
  stoppingGuard,
} from '@/modules/platform/telegram/lifecycle';
import { fitTelegram, MAX_REPLY_LINES, TELEGRAM_LIMIT } from '@/modules/wms/calc/fit-telegram';
import * as aiReply from '@/modules/wms/calc/ai-reply';
import { passQueueOf } from '@/modules/wms/calc/prefill-queue';
import { JOB_CALC_PREFILL, JOB_CALC_TARIFF_REPLY } from '@/modules/wms/calc/jobs';
import { cargoPatchOf } from '@/modules/wms/calc/workspace';
import { groupLawsOf } from '@/modules/wms/calc/needs';
import { answeredRoute, sameRouteAnswer } from '@/modules/platform/telegram/calc-intake';

/**
 * The round-3 kernel's pure seams (docs/SAKKIZ-R3.md K14, K15): each inert
 * until a package uses it, each pinned here so the package meets the shape
 * the spec froze. The database seams are calc-r3-kernel.integration.
 */

const middleware = stoppingGuard();
const guard = (ctx: Context, next: () => Promise<void>): Promise<unknown> => Promise.resolve(middleware(ctx, next));
const ctxOf = (id: number) => ({ update: { update_id: id } }) as unknown as Context;

function fakeBot() {
  const log: string[] = [];
  const confirms: Record<string, unknown>[] = [];
  return {
    log,
    confirms,
    bot: {
      isRunning: () => true,
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

beforeEach(() => __resetLifecycle());
afterEach(() => __resetLifecycle());

describe('the update a handler runs under (lifecycle, K15)', () => {
  it('is the update id through every await of the handler, and null outside one', async () => {
    expect(currentUpdateId()).toBeNull();
    const seen: (number | null)[] = [];
    await guard(ctxOf(77), async () => {
      seen.push(currentUpdateId());
      await new Promise((r) => setTimeout(r, 5));
      seen.push(currentUpdateId());
    });
    expect(seen).toEqual([77, 77]);
    expect(currentUpdateId()).toBeNull();
  });

  it('a change the flush left unwritten keeps its update, and every later one, unconfirmed', async () => {
    await guard(ctxOf(50), async () => {});
    await guard(ctxOf(51), async () => {});
    await guard(ctxOf(52), async () => {});
    const { bot, confirms } = fakeBot();
    const asked: string[] = [];
    const out = await stopTelegramBot({
      bot: bot as never,
      flush: async () => {
        asked.push('flush');
      },
      drain: async () => {},
      unwritten: () => {
        asked.push('unwritten');
        return 51;
      },
    });
    // Asked AFTER the flush, and the idle stop's own confirm (grammy's, which
    // would confirm 52) is not taken.
    expect(asked).toEqual(['flush', 'unwritten']);
    expect(out.via).toBe('confirm');
    expect(confirms).toEqual([{ offset: 51, limit: 1, timeout: 0 }]);
    expect(bot.stop).not.toHaveBeenCalled();
  });

  it('nothing unwritten: the stop is the one that shipped', async () => {
    await guard(ctxOf(60), async () => {});
    const { bot, log } = fakeBot();
    const out = await stopTelegramBot({ bot: bot as never, flush: async () => {}, drain: async () => {}, unwritten: () => null });
    expect(out.via).toBe('stop');
    expect(log).toEqual(['stop']);
  });

  it('the flush may use the budget but the confirm’s share — longer than the old fixed second', async () => {
    await guard(ctxOf(70), async () => {});
    const { bot } = fakeBot();
    let finished = false;
    await stopTelegramBot({
      bot: bot as never,
      flush: async () => {
        await new Promise((r) => setTimeout(r, 1_300));
        finished = true;
      },
      drain: async () => {},
      deadlineMs: 2_600,
    });
    expect(finished).toBe(true);
  });
});

describe('fitTelegram (K15)', () => {
  it('lives in its own module, and ai-reply re-exports the same functions', () => {
    expect(aiReply.fitTelegram).toBe(fitTelegram);
    expect(aiReply.TELEGRAM_LIMIT).toBe(TELEGRAM_LIMIT);
    expect(aiReply.MAX_REPLY_LINES).toBe(MAX_REPLY_LINES);
  });

  it('`maxLines: Infinity` keeps every line that fits; the default still collapses at MAX_REPLY_LINES', () => {
    const lines = Array.from({ length: MAX_REPLY_LINES + 5 }, (_, i) => `${i + 1}. qator`);
    const all = fitTelegram(['bosh'], lines, ['jami'], [], { maxLines: Infinity });
    expect(all).toContain(`${MAX_REPLY_LINES + 5}. qator`);
    expect(all).not.toContain('va yana');
    const capped = fitTelegram(['bosh'], lines, ['jami'], []);
    expect(capped).toContain('… va yana 5 ta qator');
  });
});

describe('passQueueOf (K15)', () => {
  it('routes a section to its queue — the routing the sender always did, one home', () => {
    expect(passQueueOf('yolkira')).toBe(JOB_CALC_TARIFF_REPLY);
    expect(passQueueOf('rastamojka')).toBe(JOB_CALC_PREFILL);
    expect(passQueueOf('podklyuch')).toBe(JOB_CALC_PREFILL);
    // A request with no section was a customs job, the only kind there was.
    expect(passQueueOf(null)).toBe(JOB_CALC_PREFILL);
  });
});

describe('cargoPatchOf (K15)', () => {
  it('returns only the keys it was given, in their column shape', () => {
    expect(cargoPatchOf({ weightKg: 3500 })).toEqual({ weightKg: '3500.000' });
    expect(cargoPatchOf({ toCity: '  Toshkent ' })).toEqual({ toCity: 'Toshkent' });
    expect(cargoPatchOf({ fromCity: null, toCity: null, weightKg: null, volumeM3: 2.5 })).toEqual({
      fromCity: null,
      toCity: null,
      weightKg: null,
      volumeM3: '2.500',
    });
  });

  it('refuses what setCargoFacts refused: a non-positive, an overflowing or a non-number figure', () => {
    expect(() => cargoPatchOf({ volumeM3: 0 })).toThrow();
    expect(() => cargoPatchOf({ weightKg: 1e9 })).toThrow();
    expect(() => cargoPatchOf({ weightKg: Number.NaN })).toThrow();
  });
});

describe('groupLawsOf (K14)', () => {
  it('gives each grouped row its group’s law, by seq', () => {
    const laws = groupLawsOf([
      { dutyMode: 'max', dutyUnit: 'juft', dutySpecific: 3, dutyFree: false, items: [{ seq: 1 }, { seq: 3 }] },
      { dutyMode: 'advalor', dutyUnit: null, dutySpecific: null, dutyFree: false, items: [{ seq: 2 }] },
    ]);
    expect([...laws.keys()].sort()).toEqual([1, 2, 3]);
    expect(laws.get(3)).toMatchObject({ dutyMode: 'max', dutyUnit: 'juft', dutySpecific: 3 });
    expect(laws.get(2)).toMatchObject({ dutyMode: 'advalor' });
  });
});

describe('the route answer (K15)', () => {
  const at = { material: 2, files: 0 };

  it('stands over a re-read unless material written AFTER it names another city', () => {
    const answer = { fromCity: 'Yiwu', toCity: 'Toshkent', at };
    expect(answeredRoute(answer, null)).toEqual({ fromCity: 'Yiwu', toCity: 'Toshkent' });
    // The same city again (any case) does not doubt it…
    expect(answeredRoute(answer, { fromCity: 'yiwu', toCity: null })).toEqual({ fromCity: 'Yiwu', toCity: 'Toshkent' });
    // …another one does, and the reading's city stands for that key alone.
    expect(answeredRoute(answer, { fromCity: null, toCity: 'Andijon' })).toEqual({ fromCity: 'Yiwu' });
    expect(answeredRoute(null, null)).toEqual({});
  });

  it('is the same answer only with the same cities at the same point', () => {
    const a = { fromCity: 'Yiwu', at };
    expect(sameRouteAnswer(a, { fromCity: 'Yiwu', at: { ...at } })).toBe(true);
    expect(sameRouteAnswer(a, { fromCity: 'Yiwu', at: { material: 3, files: 0 } })).toBe(false);
    expect(sameRouteAnswer(null, undefined)).toBe(true);
    expect(sameRouteAnswer(a, null)).toBe(false);
  });
});
