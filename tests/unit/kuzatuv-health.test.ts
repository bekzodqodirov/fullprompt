import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * /api/health must ANSWER while the thing it reports on is stuck (B9, the
 * package judge's finding 2): the watchdog kills a server that does not answer
 * in ten seconds, so a health route that waits on a starved pool would turn
 * the freeze it reports into a kill — and a database outage into a restart
 * loop. Behavioural on purpose: every dependency is replaced by a promise that
 * never settles, except the side connection, which answers — the one
 * arrangement in which «stuck» is the true word.
 */
const never = () => new Promise<never>(() => {});

vi.mock('@/modules/platform/db/client', () => ({
  db: { execute: () => never() },
}));
vi.mock('@/modules/platform/db/side', () => ({
  sideSql: () => () => Promise.resolve([{ '?column?': 1 }]),
}));
vi.mock('@/modules/platform/db/ledger', () => ({
  schemaLedger: () => never(),
}));
vi.mock('@/modules/platform/files/storage', () => ({
  getStorage: () => ({ ping: () => never() }),
}));
vi.mock('@/modules/platform/jobs/boss', () => ({
  isBossStarted: () => true,
}));

afterEach(async () => {
  const { __resetHealth } = await import('@/modules/platform/diagnostics/health');
  __resetHealth();
});

describe('the health answer under a stuck pool', () => {
  it('answers inside five seconds, says «stuck», and keeps the 503 rule', async () => {
    const { healthAnswer } = await import('@/modules/platform/diagnostics/health');
    const started = Date.now();
    const deep = await healthAnswer();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(deep.ok).toBe(false);
    expect(deep.body).toMatchObject({
      status: 'degraded',
      db: 'down',
      storage: 'down',
      jobs: 'down',
      pool: 'stuck',
      schema: null,
    });
  }, 10_000);

  it('shares one answer between the callers of one moment (single flight)', async () => {
    const { healthAnswer } = await import('@/modules/platform/diagnostics/health');
    const first = healthAnswer();
    const second = healthAnswer();
    expect(second).toBe(first);
    await first;
  }, 10_000);
});
