import { afterEach, describe, expect, it, vi } from 'vitest';
import type PgBoss from 'pg-boss';

/**
 * The `[agent] inbound` line says WHY a run started when it did (2026-10-29:
 * a card 23 minutes after the customer, and a log that named the peer and
 * the outcome and nothing else). The worker is registered on a stand-in boss
 * that records what it was given, so the test drives the real handler with a
 * job shaped like the one pg-boss hands over under `includeMetadata`.
 */

vi.mock('@/modules/wms/agent/run', () => ({
  handleInbound: vi.fn(async () => ({ outcome: 'draft', blocked: false })),
}));

const { logger } = await import('@/modules/platform/logger');
const { inboundLogFields, registerAgentWorkers } = await import('@/modules/wms/agent/jobs');
const { JOB_AGENT_INBOUND } = await import('@/modules/wms/agent/queues');

type Handler = (jobs: unknown[]) => Promise<void>;

/** A boss that records each `work` call: its options and its handler. */
function recordingBoss() {
  const work = new Map<string, { options: Record<string, unknown> | null; handler: Handler }>();
  const boss = {
    createQueue: async () => undefined,
    schedule: async () => undefined,
    work: async (name: string, a: unknown, b?: unknown) => {
      const handler = (typeof a === 'function' ? a : b) as Handler;
      work.set(name, { options: typeof a === 'function' ? null : (a as Record<string, unknown>), handler });
      return name;
    },
  };
  return { boss: boss as unknown as PgBoss, work };
}

const data = { managerUserId: 'u-1', peerId: '9001', anchorTgMessageId: '77', origin: 'pull' as const };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the inbound worker logs the origin and how long the job waited', () => {
  it('asks pg-boss for the job’s clocks on the inbound queue', async () => {
    const { boss, work } = recordingBoss();
    await registerAgentWorkers(boss);
    expect(work.get(JOB_AGENT_INBOUND)?.options).toMatchObject({ includeMetadata: true });
  });

  it('a pull answered late and a job that sat behind a busy worker read apart in the line', async () => {
    const { boss, work } = recordingBoss();
    await registerAgentWorkers(boss);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    const created = new Date('2026-10-29T13:09:00.000Z');
    await work.get(JOB_AGENT_INBOUND)!.handler([
      {
        id: 'j1',
        name: JOB_AGENT_INBOUND,
        data,
        createdOn: created,
        startAfter: new Date(created.getTime() + 12_000),
        startedOn: new Date(created.getTime() + 20 * 60_000),
      },
    ]);
    const line = info.mock.calls.find((c) => c[1] === '[agent] inbound');
    expect(line?.[0]).toMatchObject({
      peer: '9001',
      origin: 'pull',
      attempt: 0,
      lagMs: 20 * 60_000 - 12_000,
      queuedMs: 20 * 60_000,
      outcome: 'draft',
    });
  });

  it('a job with no clocks (no metadata) still names its origin — never a NaN', () => {
    expect(inboundLogFields({ data: { ...data, origin: 'sweep', attempt: 1 } })).toEqual({ peer: '9001', origin: 'sweep', attempt: 1 });
    // pg-boss hands timestamps over as Dates; a string is read the same, a garbage one is left out.
    expect(
      inboundLogFields({ data, startAfter: '2026-10-29T13:00:00Z', createdOn: 'garbage', startedOn: '2026-10-29T13:00:05Z' }),
    ).toEqual({ peer: '9001', origin: 'pull', attempt: 0, lagMs: 5_000 });
  });
});
