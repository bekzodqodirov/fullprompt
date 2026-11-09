import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who hears the pass, by the door the request came in through
 * (docs/IKKI-ESHIK.md §0.3, §2.4, §3.6).
 *
 * The door is the REQUEST's, handed back by the standing's own read of the row
 * (`prefillStanding`'s `seen`), never the job's: the stand-in standing below
 * fills it the way the real read does, and the job payload carries none — as
 * a job queued before 0140 carries none. «🤖 AI rastamojka» ('ai') passes the
 * mute, reply and stand-downs alike. «🧮 Hisoblatish» ('plain') — his 3a —
 * tells the seller NOTHING on a customs pass: every one of the five messages
 * goes through `sayOnce`'s `silent` mode (re-anchored from kernel K's «plain
 * keeps the mute», which pinned the behaviour his 2026-11-08 answer refused).
 * Every legacy request (NULL — the card form, the thread door, the agent)
 * keeps today's call exactly.
 */
const prefill = vi.hoisted(() => ({ standing: vi.fn(), run: vi.fn() }));
const say = vi.hoisted(() => vi.fn());
const door = vi.hoisted(() => ({ read: vi.fn() }));
const setting = vi.hoisted(() => ({ lenta: false }));
const lenta = vi.hoisted(() => vi.fn());
vi.mock('@/modules/wms/calc/prefill', () => ({ prefillStanding: prefill.standing, aiPrefill: prefill.run }));
vi.mock('@/modules/wms/calc/say-once', () => ({ sayOnce: say }));
// The catch path's one more read of the door (K-SPEC-3), when the standing threw.
vi.mock('@/modules/wms/calc/intake-door', () => ({ requestIntakeDoor: door.read }));
vi.mock('@/modules/wms/calc/prefill-queue', () => ({ settlePass: vi.fn() }));
vi.mock('@/modules/wms/calc/service', () => ({ notifyOverdueCalcs: vi.fn() }));
vi.mock('@/modules/wms/calc/review', () => ({ notifyDictionaryReview: vi.fn() }));
vi.mock('@/modules/wms/calc/link-ask', () => ({ sendLinkAsks: vi.fn() }));
// The lenta copy is behind a setting; off unless a case turns it on, and the
// note's write is caught at `addActivity` — no unit test reaches a database.
vi.mock('@/modules/platform/settings/service', () => ({ getSetting: async () => setting.lenta }));
vi.mock('@/modules/platform/db/client', () => ({
  db: { select: () => ({ from: () => ({ where: async () => [{ entityType: 'deal', entityId: 'd1' }] }) }) },
}));
vi.mock('@/modules/wms/crm/service', () => ({ addActivity: lenta }));

import {
  JOB_CALC_PREFILL,
  PASS_FAILED,
  PLAIN_PASS_FAILED_NOTE,
  STOOD_DOWN,
  directPass,
  registerCalcPrefillWorker,
  silentPass,
} from '@/modules/wms/calc/jobs';
import type { IntakeDoor } from '@/modules/wms/calc/intake';

type Handler = (jobs: { id: string; name: string; data: unknown; retryCount: number }[]) => Promise<void>;

async function handler(): Promise<Handler> {
  const boss = { createQueue: vi.fn(async () => {}), work: vi.fn(async () => 'w') };
  await registerCalcPrefillWorker(boss as never);
  return (boss.work.mock.calls as unknown[][]).find((c) => c[0] === JOB_CALC_PREFILL)![2] as Handler;
}

/** A landing pass's job — no `pass`, no door: the payload a job queued before 0140 carries. */
const job = (pass?: string) => ({
  id: 'j1',
  name: 'calc.prefill',
  data: { requestId: 'r1', staffId: 's1', rev: 3, ...(pass ? { pass } : {}) },
  retryCount: 0,
});

/** The standing the real read gives: `stand`, and the request's door into `seen`. */
function standing(stand: string, door: IntakeDoor | null) {
  prefill.standing.mockImplementation(async (_id: string, _rev: number | null, seen?: { door: IntakeDoor | null }) => {
    if (seen) seen.door = door;
    return stand;
  });
}

const reply = { text: 'customs reply', lentaText: 'customs reply', stood: null, customsUsd: null, freightUsd: null };

beforeEach(() => {
  prefill.standing.mockReset();
  prefill.run.mockReset().mockResolvedValue(reply);
  say.mockReset().mockResolvedValue(true);
  door.read.mockReset().mockResolvedValue(null);
  lenta.mockReset().mockResolvedValue(undefined);
  setting.lenta = false;
});

/** Each door's mode for a sayOnce call with no `whileOpen`: past the mute, silent, or today's. */
const MODE = { ai: [{ direct: true }], plain: [{ silent: true }], legacy: [] } as const;
const modeOf = (d: IntakeDoor | null) => MODE[d ?? 'legacy'];

/** The lenta notes the worker wrote, by their text. */
const notes = () => lenta.mock.calls.map((c) => (c[0] as { note: string }).note);

describe('the rule', () => {
  it('an «✅ Qo‘shish» re-run, or any pass on an «🤖 AI rastamojka» request — nothing else', () => {
    expect(directPass('landing', 'ai')).toBe(true);
    expect(directPass('landing', 'plain')).toBe(false);
    expect(directPass('landing', null)).toBe(false);
    // His ⭐ of Question 7, unchanged on every door.
    expect(directPass('amend:01234567-89ab-7def-8123-456789abcd01', null)).toBe(true);
    expect(directPass('amend:01234567-89ab-7def-8123-456789abcd01', 'plain')).toBe(true);
  });

  it('silent: a customs pass on a plain request — the landing and an addition’s re-run alike; never a tariff answer, never legacy', () => {
    expect(silentPass('plain', true)).toBe(true);
    // His 2.5 b: a plain yo‘lkira keeps the tariff answer to the chat.
    expect(silentPass('plain', false)).toBe(false);
    expect(silentPass('ai', true)).toBe(false);
    expect(silentPass(null, true)).toBe(false);
  });
});

describe('the worker reads the door from the row the standing read', () => {
  it('an AI request’s landing reply passes the mute', async () => {
    standing('ok', 'ai');
    await (await handler())([job()]);
    expect(say).toHaveBeenCalledWith('r1', 'landing', expect.objectContaining({ text: 'customs reply' }), {
      whileOpen: true,
      direct: true,
    });
  });

  it('a legacy request’s keeps it — exactly the landing’s call of today', async () => {
    standing('ok', null);
    await (await handler())([job()]);
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith('r1', 'landing', expect.objectContaining({ text: 'customs reply' }), {
      whileOpen: true,
    });
  });

  it('a plain request’s goes nowhere: the claim is silent (his 3a, §2.4) — the landing and an addition’s re-run', async () => {
    standing('ok', 'plain');
    await (await handler())([job()]);
    expect(say).toHaveBeenCalledTimes(1);
    expect(say.mock.calls[0]![3]).toEqual({ whileOpen: true, silent: true });

    // §2.6: an addition's re-run is `direct` on every other door; silence outranks it.
    say.mockClear();
    standing('ok', 'plain');
    await (await handler())([job('amend:01234567-89ab-7def-8123-456789abcd01')]);
    expect(say.mock.calls[0]![3]).toEqual({ whileOpen: true, silent: true });
  });

  it('a plain request’s yo‘lkira answer still reaches the chat (his 2.5 b) — the mute kept, as today', async () => {
    const tariff = await (async () => {
      const boss = { createQueue: vi.fn(async () => {}), work: vi.fn(async () => 'w') };
      await registerCalcPrefillWorker(boss as never);
      return (boss.work.mock.calls as unknown[][]).find((c) => c[0] !== JOB_CALC_PREFILL)![2] as Handler;
    })();
    standing('ok', 'plain');
    await tariff([{ ...job(), data: { ...job().data, section: 'yolkira' } }]);
    expect(say.mock.calls[0]![3]).toEqual({ whileOpen: true });
  });

  it('a plain request’s lenta note is written ONCE — `spoke` gates it under silence too; a redelivery writes none', async () => {
    setting.lenta = true;
    standing('ok', 'plain');
    prefill.run.mockResolvedValue({ ...reply, text: 'the note', lentaText: 'the note' });
    await (await handler())([job()]);
    expect(notes()).toEqual(['the note']);
    // The redelivery: the claim is already there, so sayOnce answers false.
    lenta.mockClear();
    say.mockReset().mockResolvedValue(false);
    await (await handler())([job()]);
    expect(notes()).toEqual([]);
  });

  it('a stand-in that never fills the door is a legacy request — today’s behaviour (§0.2)', async () => {
    prefill.standing.mockResolvedValue('ok');
    await (await handler())([job()]);
    expect(say).toHaveBeenCalledWith('r1', 'landing', expect.anything(), { whileOpen: true });
  });

  it('an AI request’s stand-down and «hisoblay olmadi» pass the mute too — the answer to his press (§3.6)', async () => {
    standing('touched', 'ai');
    await (await handler())([job()]);
    expect(say).toHaveBeenCalledWith('r1', 'landing', expect.objectContaining({ text: STOOD_DOWN.touched }), { direct: true });

    say.mockClear();
    standing('ok', 'ai');
    prefill.run.mockRejectedValue(new Error('model refused'));
    await (await handler())([job()]);
    expect(say).toHaveBeenCalledWith('r1', 'landing', expect.objectContaining({ text: PASS_FAILED }), { direct: true });
  });

  // The two sayOnce calls past the reply (K review K-SPEC-2): a pass the
  // VED overtook or closed mid-run (`out.stood`), and the closed sentence
  // after a reply the claim withheld because the request had closed.
  it('an AI request’s mid-pass stand-down passes the mute; a plain one’s is silent; a legacy one’s keeps it', async () => {
    for (const stood of ['closed', 'touched'] as const) {
      prefill.run.mockResolvedValue({ ...reply, stood });
      for (const d of ['ai', 'plain', null] as const) {
        say.mockClear();
        standing('ok', d);
        await (await handler())([job()]);
        expect(say).toHaveBeenCalledTimes(1);
        expect(say.mock.calls[0]![2]).toEqual(expect.objectContaining({ text: STOOD_DOWN[stood] }));
        expect(say.mock.calls[0]!.slice(3)).toEqual(modeOf(d));
      }
    }
  });

  it('the closed sentence after a withheld reply: past the mute on AI, silent on plain, today’s on legacy', async () => {
    for (const d of ['ai', 'plain', null] as const) {
      say.mockReset().mockResolvedValueOnce(false).mockResolvedValue(true);
      standing('ok', d);
      await (await handler())([job()]);
      expect(say).toHaveBeenCalledTimes(2);
      // The reply itself: `whileOpen`, and the door's mode beside it.
      expect(say.mock.calls[0]![3]).toEqual({ whileOpen: true, ...(modeOf(d)[0] ?? {}) });
      expect(say.mock.calls[1]![2]).toEqual(expect.objectContaining({ text: STOOD_DOWN.closed }));
      expect(say.mock.calls[1]!.slice(3)).toEqual(modeOf(d));
    }
  });

  it('a plain request’s stand-down from the standing is silent; a legacy one’s keeps the mute', async () => {
    standing('touched', 'plain');
    await (await handler())([job()]);
    expect(say).toHaveBeenCalledTimes(1);
    expect(say.mock.calls[0]![3]).toEqual({ silent: true });

    say.mockClear();
    standing('touched', null);
    await (await handler())([job()]);
    expect(say.mock.calls[0]![3]).toBeUndefined();
  });

  it('a plain request’s «hisoblay olmadi» is silent, and the card says no AI note is coming — once', async () => {
    setting.lenta = true;
    standing('ok', 'plain');
    prefill.run.mockRejectedValue(new Error('model refused'));
    await (await handler())([job()]);
    expect(say).toHaveBeenCalledWith('r1', 'landing', expect.objectContaining({ text: PASS_FAILED }), { silent: true });
    expect(notes()).toEqual([PLAIN_PASS_FAILED_NOTE]);
    // A redelivery after a message already went out: no second line.
    lenta.mockClear();
    say.mockReset().mockResolvedValue(false);
    await (await handler())([job()]);
    expect(notes()).toEqual([]);
    // …and a re-delivered pass that found the dead one unfinished is a failed pass too.
    say.mockReset().mockResolvedValue(true);
    standing('touched', 'plain');
    await (await handler())([{ ...job(), retryCount: 1 }]);
    expect(say.mock.calls[0]![2]).toEqual(expect.objectContaining({ text: PASS_FAILED }));
    expect(notes()).toEqual([PLAIN_PASS_FAILED_NOTE]);
  });

  it('no failure line on an AI or a legacy request — those were told in the chat', async () => {
    setting.lenta = true;
    for (const d of ['ai', null] as const) {
      standing('ok', d);
      prefill.run.mockRejectedValue(new Error('model refused'));
      await (await handler())([job()]);
    }
    expect(notes()).toEqual([]);
  });
});

describe('a standing read that throws (K-SPEC-3): the door is asked once more before the failure is said', () => {
  it('the door read answers: «ai» passes the mute, «plain» is silent, NULL is today’s', async () => {
    for (const d of ['ai', 'plain', null] as const) {
      say.mockClear();
      prefill.standing.mockRejectedValue(new Error('connection reset'));
      door.read.mockResolvedValue(d);
      await (await handler())([job()]);
      expect(door.read).toHaveBeenCalledWith('r1');
      expect(say).toHaveBeenCalledWith('r1', 'landing', expect.objectContaining({ text: PASS_FAILED }), ...modeOf(d));
      expect(say.mock.calls[0]!.slice(3)).toEqual(modeOf(d));
    }
  });

  it('the door read throws too: the pass name alone decides, as a landing was before 0140', async () => {
    prefill.standing.mockRejectedValue(new Error('connection reset'));
    door.read.mockRejectedValue(new Error('connection reset'));
    await (await handler())([job()]);
    expect(say).toHaveBeenCalledWith('r1', 'landing', expect.objectContaining({ text: PASS_FAILED }));
    expect(say.mock.calls[0]![3]).toBeUndefined();

    say.mockClear();
    await (await handler())([job('amend:01234567-89ab-7def-8123-456789abcd01')]);
    expect(say.mock.calls[0]![3]).toEqual({ direct: true });
  });

  it('a pass that failed AFTER the standing read is not read again — the door it saw decides', async () => {
    standing('ok', 'plain');
    prefill.run.mockRejectedValue(new Error('model refused'));
    await (await handler())([job()]);
    expect(door.read).not.toHaveBeenCalled();
    expect(say.mock.calls[0]![3]).toEqual({ silent: true });
  });
});
