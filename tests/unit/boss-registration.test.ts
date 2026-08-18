import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type PgBoss from 'pg-boss';
import { registerAllWorkers, WORKER_REGISTRATIONS } from '@/modules/platform/jobs/boss';

/**
 * A boot retry must never register a worker twice.
 *
 * `boss.work` is not idempotent — every call adds a fresh worker to the
 * queue — and `startBoss` retries its whole registration list when one entry
 * throws (a deploy morning where postgres wakes slowly is exactly when one
 * does). The old code re-ran the list from the top, so every queue registered
 * BEFORE the failure got a second worker, and with two workers running
 * `sendPendingTelegram` concurrently every staff message went out twice.
 * The audit read the comment claiming «registration is idempotent» and
 * measured that it was not.
 */
describe('worker registration survives a partial failure without doubling', () => {
  it('re-runs only what failed, and each success exactly once', async () => {
    const calls = new Map<string, number>();
    const count = (name: string) => calls.set(name, (calls.get(name) ?? 0) + 1);
    let secondFails = true;
    const registrations: [string, (boss: PgBoss) => Promise<void>][] = [
      [
        'one',
        async () => {
          count('one');
        },
      ],
      [
        'two',
        async () => {
          if (secondFails) throw new Error('postgres not ready yet');
          count('two');
        },
      ],
      [
        'three',
        async () => {
          count('three');
        },
      ],
    ];
    const registered = new Set<string>();
    const boss = {} as PgBoss;

    await expect(registerAllWorkers(boss, registrations, registered)).rejects.toThrow(
      'postgres not ready yet',
    );
    expect(calls.get('one')).toBe(1);
    expect(calls.get('three'), 'nothing after the failure ran').toBeUndefined();

    // The boot retry, five seconds later, with postgres now answering.
    secondFails = false;
    await registerAllWorkers(boss, registrations, registered);
    expect(calls.get('one'), 'the survivor was not registered again').toBe(1);
    expect(calls.get('two')).toBe(1);
    expect(calls.get('three')).toBe(1);
  });

  it('the real list is non-trivial and carries the queues that matter', () => {
    const names = WORKER_REGISTRATIONS.map(([name]) => name);
    expect(names.length).toBeGreaterThan(10);
    expect(names).toContain('notifications');
    expect(names).toContain('backup');
  });
});

describe('enqueue is a sender, never a worker', () => {
  // The tg-listen container's session-dead alarm called enqueue, enqueue
  // called startBoss, and the whole worker fleet — the nightly backup
  // included, into a container with no backups volume — booted inside the
  // Telegram bridge. From then on two processes worked notify.telegram and
  // every staff message arrived twice. Source-shape, because the freeze-dried
  // proof is WHICH function enqueue calls.
  const source = readFileSync('src/modules/platform/jobs/boss.ts', 'utf8');
  const enqueueBody = source.slice(source.indexOf('export async function enqueue'));

  it('enqueue starts the listener half only', () => {
    expect(enqueueBody).toContain('ensureListening()');
    expect(enqueueBody, 'never the worker fleet').not.toContain('startBoss(');
  });
});
