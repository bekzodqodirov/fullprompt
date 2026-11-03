import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The AI-VED's estimate to the AI sotuvchi's owner rides the prefill worker
 * (his Q5 ⭐ c), after the seller has been told. It is best-effort: a copy
 * the owner could not get must never make the worker tell the seller «the
 * pass failed» about a figure he already has — and a run that did not speak
 * (the request closed, or a re-delivery) announces nothing.
 */
const prefill = vi.hoisted(() => ({ standing: vi.fn(), run: vi.fn() }));
const say = vi.hoisted(() => vi.fn());
const announce = vi.hoisted(() => vi.fn());
vi.mock('@/modules/wms/calc/prefill', () => ({ prefillStanding: prefill.standing, aiPrefill: prefill.run }));
vi.mock('@/modules/wms/calc/say-once', () => ({ sayOnce: say }));
vi.mock('@/modules/wms/calc/service', () => ({ notifyOverdueCalcs: vi.fn() }));
vi.mock('@/modules/wms/calc/review', () => ({ notifyDictionaryReview: vi.fn() }));
vi.mock('@/modules/wms/calc/link-ask', () => ({ sendLinkAsks: vi.fn() }));
vi.mock('@/modules/wms/agent/calc-loop', () => ({ announceAgentCalcSafe: announce }));
vi.mock('@/modules/platform/settings/service', () => ({ getSetting: async () => false }));

import { JOB_CALC_PREFILL, registerCalcPrefillWorker } from '@/modules/wms/calc/jobs';

type Handler = (jobs: { id: string; name: string; data: unknown; retryCount: number }[]) => Promise<void>;

async function handler(): Promise<Handler> {
  const boss = { createQueue: vi.fn(async () => {}), work: vi.fn(async () => 'w') };
  await registerCalcPrefillWorker(boss as never);
  return (boss.work.mock.calls as unknown[][]).find((c) => c[0] === JOB_CALC_PREFILL)![2] as Handler;
}

const job = { id: 'j1', name: 'calc.prefill', data: { requestId: 'r1', staffId: 's1', rev: 3 }, retryCount: 0 };
const out = { text: 'customs reply', lentaText: 'customs reply', stood: null, customsUsd: 412.5, freightUsd: null };

beforeEach(() => {
  prefill.standing.mockReset().mockResolvedValue('ok');
  prefill.run.mockReset().mockResolvedValue(out);
  say.mockReset().mockResolvedValue(true);
  announce.mockReset().mockResolvedValue(undefined);
});

describe('the AI-VED estimate to the owner', () => {
  it('is announced with the customs figure once the seller was told', async () => {
    await (await handler())([job]);
    expect(announce).toHaveBeenCalledWith('r1', 'estimate', { amountText: 'rastamojka ≈ $412.50' });
  });

  it('a copy that could not be written never turns into «the pass failed» for the seller', async () => {
    announce.mockRejectedValue(new Error('owner copy failed'));
    await (await handler())([job]);
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith('r1', expect.objectContaining({ text: 'customs reply' }), { whileOpen: true });
  });

  it('a run that did not speak announces nothing', async () => {
    say.mockResolvedValueOnce(false).mockResolvedValue(true);
    await (await handler())([job]);
    expect(announce).not.toHaveBeenCalled();
  });
});
