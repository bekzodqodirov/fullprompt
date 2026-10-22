import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the AI pass tells the seller when it stands down (round-1 review,
 * a18). The worker is registered on a stand-in boss and handed jobs the way
 * pg-boss hands them — a first delivery, and a re-delivery after the process
 * died mid-pass, whose own writes moved the revision.
 */
const prefill = vi.hoisted(() => ({ standing: vi.fn(), run: vi.fn() }));
const notify = vi.hoisted(() => vi.fn());
vi.mock('@/modules/wms/calc/prefill', () => ({ prefillStanding: prefill.standing, aiPrefill: prefill.run }));
vi.mock('@/modules/platform/notifications/staff', () => ({ notifyStaffTelegram: notify }));
vi.mock('@/modules/wms/calc/service', () => ({ notifyOverdueCalcs: vi.fn() }));
vi.mock('@/modules/wms/calc/review', () => ({ notifyDictionaryReview: vi.fn() }));
vi.mock('@/modules/wms/calc/link-ask', () => ({ sendLinkAsks: vi.fn() }));

import { PASS_FAILED, STOOD_DOWN, attemptStanding, registerCalcPrefillWorker } from '@/modules/wms/calc/jobs';

type Handler = (jobs: { id: string; name: string; data: unknown; retryCount: number }[]) => Promise<void>;

async function worker(): Promise<{ options: unknown; handler: Handler }> {
  const boss = { createQueue: vi.fn(async () => {}), work: vi.fn(async () => 'w') };
  await registerCalcPrefillWorker(boss as never);
  const call = boss.work.mock.calls[0] as unknown[];
  return { options: call[1], handler: call[2] as Handler };
}

const job = (retryCount: number) => ({
  id: 'j1',
  name: 'calc.prefill',
  data: { requestId: 'r1', staffId: 's1', rev: 3 },
  retryCount,
});

beforeEach(() => {
  prefill.standing.mockReset();
  prefill.run.mockReset();
  notify.mockReset();
});

describe('a re-delivered pass never says a person moved the request (review a18)', () => {
  it('the rule: «touched» on a retry is the AI not finishing; a person’s ✅ or seal stands on any attempt', () => {
    expect(attemptStanding('touched', 0)).toBe('touched');
    expect(attemptStanding('touched', 1)).toBe('unfinished');
    expect(STOOD_DOWN.unfinished).toBe(PASS_FAILED);
    expect(attemptStanding('confirmed', 2)).toBe('confirmed');
    expect(attemptStanding('closed', 2)).toBe('closed');
    expect(attemptStanding('ok', 3)).toBe('ok');
  });

  it('the worker asks pg-boss for the attempt number, and a retry says PASS_FAILED', async () => {
    const { options, handler } = await worker();
    expect(options).toMatchObject({ includeMetadata: true });

    prefill.standing.mockResolvedValue('touched');
    await handler([job(1)]);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userIds: ['s1'], text: PASS_FAILED }));
    expect(prefill.run).not.toHaveBeenCalled();

    notify.mockReset();
    await handler([job(0)]);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: STOOD_DOWN.touched }));
  });
});
