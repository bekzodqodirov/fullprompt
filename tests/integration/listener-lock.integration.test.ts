import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { pgClient } from '@/modules/platform/db/client';
import {
  listenerLockDiagnostics,
  takeListenerLock,
} from '@/modules/wms/crm/telegram-accounts';

/**
 * Every listener's lock, ONE connection.
 *
 * The first version reserved a pool connection PER account, and the pool is
 * ten, shared with every pump and store in the tg-listen process — so the
 * 10th connected manager would have left zero connections for the work of
 * all ten listeners, silently, while the screen read «live». Advisory locks
 * are per session and a session holds any number, so the count of sessions
 * must stay at one however many accounts connect.
 *
 * The exhaustion itself is deliberately NOT pressed here: reproducing it
 * needs the pool empty, and a test that empties the shared pool takes its
 * own worker's remaining files down with it (the tx-pool rule, again).
 */

afterAll(async () => {
  await pgClient.end();
});

describe('the listener lock', () => {
  it('any number of accounts ride one reserved connection', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    const releaseA = await takeListenerLock(a);
    const releaseB = await takeListenerLock(b);
    const releaseC = await takeListenerLock(c);
    expect(releaseA && releaseB && releaseC).toBeTruthy();
    expect(listenerLockDiagnostics()).toEqual({ held: 3, sessions: 1 });

    // Cross-process exclusivity is postgres's half: a second connection —
    // another machine, in real life — must be refused while we hold it.
    const stranger = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    const [row] = await stranger<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtext('gsr-tg-listen'), hashtext(${a})) AS locked`;
    expect(row?.locked).toBe(false);
    await stranger.end();

    await releaseB!();
    expect(listenerLockDiagnostics()).toEqual({ held: 2, sessions: 1 });
    await releaseA!();
    await releaseC!();
    // The last lock out returns the reservation to the pool — a test run must
    // not strand a connection, and neither must a supervisor shutting down.
    expect(listenerLockDiagnostics()).toEqual({ held: 0, sessions: 0 });
  });

  it('the same account asked for twice in this process is refused', async () => {
    // Advisory locks are REENTRANT within a session — postgres would say yes
    // and mean «you already have it», which as an exclusivity answer is a
    // lie. The in-process set is what keeps the old per-connection behaviour.
    const id = randomUUID();
    const release = await takeListenerLock(id);
    expect(release).not.toBeNull();
    expect(await takeListenerLock(id)).toBeNull();
    await release!();
    const again = await takeListenerLock(id);
    expect(again).not.toBeNull();
    await again!();
  });
});
