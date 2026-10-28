import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the AI pass tells the seller when it stands down (round-1 review,
 * a18). The worker is registered on a stand-in boss and handed jobs the way
 * pg-boss hands them — a first delivery, and a re-delivery after the process
 * died mid-pass, whose own writes moved the revision.
 *
 * Re-anchored for round 2 (docs/SAKKIZ-R2.md §6.8): every machine message
 * goes through `sayOnce` (one per request), so the stand-in is `./say-once`
 * rather than `notifyStaffTelegram`; and the queue a job came from — its
 * payload's section — decides whether a moved revision matters at all.
 */
const prefill = vi.hoisted(() => ({ standing: vi.fn(), run: vi.fn() }));
const say = vi.hoisted(() => vi.fn());
vi.mock('@/modules/wms/calc/prefill', () => ({ prefillStanding: prefill.standing, aiPrefill: prefill.run }));
vi.mock('@/modules/wms/calc/say-once', () => ({ sayOnce: say }));
vi.mock('@/modules/wms/calc/service', () => ({ notifyOverdueCalcs: vi.fn() }));
vi.mock('@/modules/wms/calc/review', () => ({ notifyDictionaryReview: vi.fn() }));
vi.mock('@/modules/wms/calc/link-ask', () => ({ sendLinkAsks: vi.fn() }));
// The lenta copy is behind a setting; off here, so no unit test reaches a database.
vi.mock('@/modules/platform/settings/service', () => ({ getSetting: async () => false }));

import {
  JOB_CALC_PREFILL,
  JOB_CALC_TARIFF_REPLY,
  PASS_FAILED,
  STOOD_DOWN,
  TARIFF_PASS_FAILED,
  TARIFF_STOOD_DOWN,
  attemptStanding,
  registerCalcPrefillWorker,
} from '@/modules/wms/calc/jobs';

type Handler = (jobs: { id: string; name: string; data: unknown; retryCount: number }[]) => Promise<void>;

async function worker(queue = JOB_CALC_PREFILL): Promise<{ options: unknown; handler: Handler }> {
  const boss = { createQueue: vi.fn(async () => {}), work: vi.fn(async () => 'w') };
  await registerCalcPrefillWorker(boss as never);
  const call = (boss.work.mock.calls as unknown[][]).find((c) => c[0] === queue)!;
  return { options: call[1], handler: call[2] as Handler };
}

const job = (retryCount: number, section?: string) => ({
  id: 'j1',
  name: 'calc.prefill',
  data: { requestId: 'r1', staffId: 's1', rev: 3, ...(section ? { section } : {}) },
  retryCount,
});

beforeEach(() => {
  prefill.standing.mockReset();
  prefill.run.mockReset();
  say.mockReset();
  say.mockResolvedValue(true);
});

describe('a re-delivered pass never says a person moved the request (review a18)', () => {
  it('the rule: «touched» on a retry is the AI not finishing; a person’s ✅ or seal stands on any attempt', () => {
    expect(attemptStanding('touched', 0, true)).toBe('touched');
    expect(attemptStanding('touched', 1, true)).toBe('unfinished');
    expect(STOOD_DOWN.unfinished).toBe(PASS_FAILED);
    expect(attemptStanding('confirmed', 2, true)).toBe('confirmed');
    expect(attemptStanding('closed', 2, true)).toBe('closed');
    expect(attemptStanding('ok', 3, true)).toBe('ok');
  });

  it('the worker asks pg-boss for the attempt number, and a retry says PASS_FAILED', async () => {
    const { options, handler } = await worker();
    expect(options).toMatchObject({ includeMetadata: true });

    prefill.standing.mockResolvedValue('touched');
    await handler([job(1)]);
    expect(say).toHaveBeenCalledWith('r1', 'landing', expect.objectContaining({ userIds: ['s1'], text: PASS_FAILED }));
    expect(prefill.run).not.toHaveBeenCalled();

    say.mockReset();
    await handler([job(0)]);
    expect(say).toHaveBeenCalledWith('r1', 'landing', expect.objectContaining({ text: STOOD_DOWN.touched }));
  });
});

describe('a tariff reply writes nothing, so a moved revision is nothing it could overwrite (§6.8)', () => {
  it('the rule: on the tariff queue «touched» answers and «unfinished» cannot arise', () => {
    expect(attemptStanding('touched', 0, false)).toBe('ok');
    expect(attemptStanding('touched', 2, false)).toBe('ok');
    // A ✅ is a person's work the tariff reply cannot overwrite either (review
    // concurrency-9) — it used to withhold the figure with the customs sentence.
    expect(attemptStanding('confirmed', 0, false)).toBe('ok');
    expect(attemptStanding('confirmed', 3, false)).toBe('ok');
    expect(Object.keys(TARIFF_STOOD_DOWN).sort()).toEqual(['closed', 'not_found', 'unfinished']);
    expect(attemptStanding('closed', 0, false)).toBe('closed');
    expect(TARIFF_STOOD_DOWN.closed).not.toBe(STOOD_DOWN.closed);
    expect(TARIFF_STOOD_DOWN.unfinished).toBe(TARIFF_PASS_FAILED);
  });

  it('a yolkira job whose revision moved is answered, not stood down', async () => {
    const { options, handler } = await worker(JOB_CALC_TARIFF_REPLY);
    expect(options).toMatchObject({ includeMetadata: true });
    prefill.standing.mockResolvedValue('touched');
    prefill.run.mockResolvedValue({ text: 'tariff reply', lentaText: 'tariff reply', stood: null });
    await handler([job(0, 'yolkira')]);
    expect(prefill.run).toHaveBeenCalledWith('r1', { actorId: null }, { replyTo: 's1' }, { expectCustoms: false, expectRev: 3 });
    expect(say).toHaveBeenCalledWith('r1', 'landing', expect.objectContaining({ text: 'tariff reply' }), { whileOpen: true });
  });

  it('a yolkira job a person ✅ed is answered too — the tariff reply writes nothing', async () => {
    const { handler } = await worker(JOB_CALC_TARIFF_REPLY);
    prefill.standing.mockResolvedValue('confirmed');
    prefill.run.mockResolvedValue({ text: 'tariff reply', lentaText: 'tariff reply', stood: null });
    await handler([job(0, 'yolkira')]);
    expect(prefill.run).toHaveBeenCalled();
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith('r1', 'landing', expect.objectContaining({ text: 'tariff reply' }), { whileOpen: true });
  });

  it('a job queued as freight-only on a request that has since gained customs stands down — the section moved', async () => {
    const { handler } = await worker(JOB_CALC_TARIFF_REPLY);
    prefill.standing.mockResolvedValue('ok');
    // `aiPrefill` compares the section with the queue and refuses to run a
    // customs pass from here (§6.8); the worker says the customs sentence.
    prefill.run.mockResolvedValue({ text: '', lentaText: '', stood: 'touched' });
    await handler([job(0, 'yolkira')]);
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith('r1', 'landing', expect.objectContaining({ text: STOOD_DOWN.touched }));
  });

  it('a closed request is told in the tariff words, and a failure too', async () => {
    const { handler } = await worker(JOB_CALC_TARIFF_REPLY);
    prefill.standing.mockResolvedValue('closed');
    await handler([job(0, 'yolkira')]);
    expect(say).toHaveBeenCalledWith('r1', 'landing', expect.objectContaining({ text: TARIFF_STOOD_DOWN.closed }));

    say.mockReset();
    prefill.standing.mockResolvedValue('ok');
    prefill.run.mockRejectedValue(new Error('tariff read failed'));
    await handler([job(0, 'yolkira')]);
    expect(say).toHaveBeenCalledWith('r1', 'landing', expect.objectContaining({ text: TARIFF_PASS_FAILED }));
  });

  it('a payload with no section is a customs job — the only kind queued before round 2', async () => {
    const { handler } = await worker();
    prefill.standing.mockResolvedValue('ok');
    prefill.run.mockResolvedValue({ text: 'customs reply', lentaText: 'customs reply', stood: null });
    await handler([job(0)]);
    expect(prefill.run).toHaveBeenCalledWith('r1', { actorId: null }, { replyTo: 's1' }, { expectCustoms: true, expectRev: 3 });
  });
});

describe('a request the VED closed while the pass ran gets no machine reply (review CONC-1)', () => {
  it('the reply is spoken only while the request is open; a closed one is told the closed sentence instead', async () => {
    const { handler } = await worker();
    prefill.standing.mockResolvedValue('ok');
    prefill.run.mockResolvedValue({ text: 'customs reply', lentaText: 'customs reply', stood: null });
    // The speaking door refuses: the request closed after the pass's last step.
    say.mockImplementation(async (_id: string, _pass: string, _input: unknown, opts?: { whileOpen?: boolean }) => !opts?.whileOpen);
    await handler([job(0)]);
    const texts = say.mock.calls.map((call) => (call[2] as { text: string }).text);
    expect(texts).toEqual(['customs reply', STOOD_DOWN.closed]);
    expect(say.mock.calls[0]![3]).toEqual({ whileOpen: true });
    expect(say.mock.calls[1]![3]).toBeUndefined();
  });

  it('a pass that stood down mid-run says its own sentence and no reply', async () => {
    const { handler } = await worker();
    prefill.standing.mockResolvedValue('ok');
    prefill.run.mockResolvedValue({ text: '', lentaText: '', stood: 'closed', overtaken: null });
    await handler([job(0)]);
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith('r1', 'landing', expect.objectContaining({ text: STOOD_DOWN.closed }));
  });
});
