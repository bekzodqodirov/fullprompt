import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which passes reach the seller past his «✅ Mening vazifalarim» mute
 * (docs/IKKI-ESHIK.md §0.3, §3.6) — the ONE behaviour kernel K changes.
 *
 * The door is the REQUEST's, handed back by the standing's own read of the row
 * (`prefillStanding`'s `seen`), never the job's: the stand-in standing below
 * fills it the way the real read does, and the job payload carries none — as
 * a job queued before 0140 carries none. «🤖 AI rastamojka» ('ai') passes the
 * mute, reply and stand-downs alike; «🧮» ('plain') and every legacy request
 * (NULL — the card form, the thread door, the agent) keep it, exactly as today.
 */
const prefill = vi.hoisted(() => ({ standing: vi.fn(), run: vi.fn() }));
const say = vi.hoisted(() => vi.fn());
vi.mock('@/modules/wms/calc/prefill', () => ({ prefillStanding: prefill.standing, aiPrefill: prefill.run }));
vi.mock('@/modules/wms/calc/say-once', () => ({ sayOnce: say }));
vi.mock('@/modules/wms/calc/prefill-queue', () => ({ settlePass: vi.fn() }));
vi.mock('@/modules/wms/calc/service', () => ({ notifyOverdueCalcs: vi.fn() }));
vi.mock('@/modules/wms/calc/review', () => ({ notifyDictionaryReview: vi.fn() }));
vi.mock('@/modules/wms/calc/link-ask', () => ({ sendLinkAsks: vi.fn() }));
// The lenta copy is behind a setting; off here, so no unit test reaches a database.
vi.mock('@/modules/platform/settings/service', () => ({ getSetting: async () => false }));

import { JOB_CALC_PREFILL, PASS_FAILED, STOOD_DOWN, directPass, registerCalcPrefillWorker } from '@/modules/wms/calc/jobs';
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
});

describe('the rule', () => {
  it('an «✅ Qo‘shish» re-run, or any pass on an «🤖 AI rastamojka» request — nothing else', () => {
    expect(directPass('landing', 'ai')).toBe(true);
    expect(directPass('landing', 'plain')).toBe(false);
    expect(directPass('landing', null)).toBe(false);
    // His ⭐ of Question 7, unchanged on every door.
    expect(directPass('amend:01234567-89ab-7def-8123-456789abcd01', null)).toBe(true);
    expect(directPass('amend:01234567-89ab-7def-8123-456789abcd01', 'plain')).toBe(true);
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

  it('a plain request’s, and a legacy one’s, keep it — exactly the landing’s call of today', async () => {
    for (const door of ['plain', null] as const) {
      say.mockClear();
      standing('ok', door);
      await (await handler())([job()]);
      expect(say).toHaveBeenCalledTimes(1);
      expect(say).toHaveBeenCalledWith('r1', 'landing', expect.objectContaining({ text: 'customs reply' }), {
        whileOpen: true,
      });
    }
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
  it('an AI request’s mid-pass stand-down passes the mute; a plain or legacy one’s keeps it', async () => {
    for (const stood of ['closed', 'touched'] as const) {
      prefill.run.mockResolvedValue({ ...reply, stood });
      for (const door of ['ai', 'plain', null] as const) {
        say.mockClear();
        standing('ok', door);
        await (await handler())([job()]);
        expect(say).toHaveBeenCalledTimes(1);
        expect(say.mock.calls[0]![2]).toEqual(expect.objectContaining({ text: STOOD_DOWN[stood] }));
        expect(say.mock.calls[0]!.slice(3)).toEqual(door === 'ai' ? [{ direct: true }] : []);
      }
    }
  });

  it('the closed sentence after a withheld reply passes it on an AI request, and only there', async () => {
    for (const door of ['ai', 'plain', null] as const) {
      say.mockReset().mockResolvedValueOnce(false).mockResolvedValue(true);
      standing('ok', door);
      await (await handler())([job()]);
      expect(say).toHaveBeenCalledTimes(2);
      // The reply itself: `whileOpen`, and `direct` on the AI door alone.
      expect(say.mock.calls[0]![3]).toEqual(door === 'ai' ? { whileOpen: true, direct: true } : { whileOpen: true });
      expect(say.mock.calls[1]![2]).toEqual(expect.objectContaining({ text: STOOD_DOWN.closed }));
      expect(say.mock.calls[1]!.slice(3)).toEqual(door === 'ai' ? [{ direct: true }] : []);
    }
  });

  it('a plain request’s stand-down keeps the mute', async () => {
    standing('touched', 'plain');
    await (await handler())([job()]);
    expect(say).toHaveBeenCalledTimes(1);
    expect(say.mock.calls[0]![3]).toBeUndefined();
  });

  it('a standing read that throws is answered as a landing was before 0140 — the pass name alone', async () => {
    prefill.standing.mockRejectedValue(new Error('connection reset'));
    await (await handler())([job()]);
    expect(say).toHaveBeenCalledWith('r1', 'landing', expect.objectContaining({ text: PASS_FAILED }));
    expect(say.mock.calls[0]![3]).toBeUndefined();

    say.mockClear();
    await (await handler())([job('amend:01234567-89ab-7def-8123-456789abcd01')]);
    expect(say.mock.calls[0]![3]).toEqual({ direct: true });
  });
});
