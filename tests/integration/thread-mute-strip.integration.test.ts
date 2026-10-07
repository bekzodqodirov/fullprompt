import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { users } from '@/modules/platform/db/schema';
import { FOUNDERS } from '@/modules/platform/notifications/mutes';

/**
 * 0127's one data statement (E8 a): «InternalNote» and «MentionedInNote» left
 * `operations` for the new `chat` group, and a list saved since 2026-07-28
 * holds them BY NAME — it would stay muted under a box that reads unticked.
 *
 * The migration's OWN text is run, inside a transaction that is rolled back
 * (the 0099 backfill test's shape), over four fixture lists: a post-07-28
 * «operations» list, a pre-07-28 one (its founders only), «all», and empty.
 */
const MIGRATION = readFileSync(
  resolve(__dirname, '../../src/modules/platform/db/migrations/0127_staff_threads.sql'),
  'utf8',
);
const STRIP = MIGRATION.slice(MIGRATION.indexOf('UPDATE "users"')).trim().replace(/;\s*$/, '');

/** Every member «operations» had the day before 0127 — what a 07-28-or-later save wrote. */
const OPERATIONS_BEFORE = [
  'ClientBirthday',
  'ReceiptConfirmed',
  'UnknownCargoReceived',
  'ReadyForPickup',
  'BoxIssued',
  'PlanApproved',
  'PlanChangesRequested',
  'InventoryCompleted',
  'LoadFinished',
  'UnloadFinished',
  'BatchRerouted',
  'InternalNote',
  'MentionedInNote',
  'ChatMessageShared',
  'AutomationRule',
  'CalcDictReview',
  'CalcOffer',
];

const SFX = randomUUID().slice(0, 6);
const made: string[] = [];

afterAll(async () => {
  if (made.length) await db.delete(users).where(inArray(users.id, made));
  await pgClient.end();
});

describe('0127 strips the two moved names, and only them', () => {
  it('post-07-28 list loses both, a founders-only list, «all» and [] are untouched', async () => {
    expect(STRIP).toContain("- 'InternalNote' - 'MentionedInNote'");
    const lists = {
      post: OPERATIONS_BEFORE,
      pre: [...FOUNDERS.operations],
      all: ['all'],
      none: [] as string[],
    };
    const rows = await db
      .insert(users)
      .values(
        Object.entries(lists).map(([key, muted], i) => ({
          phone: `+99896${String(Date.now()).slice(-6)}${i}`,
          fullName: `Strip ${key} ${SFX}`,
          passwordHash: 'x',
          mutedNotificationTypes: muted,
        })),
      )
      .returning({ id: users.id, name: users.fullName });
    made.push(...rows.map((r) => r.id));
    const idOf = (key: string) => rows.find((r) => r.name === `Strip ${key} ${SFX}`)!.id;

    const after = new Map<string, unknown>();
    await db
      .transaction(async (tx) => {
        await tx.execute(sql.raw(STRIP));
        const read = await tx
          .select({ id: users.id, muted: users.mutedNotificationTypes })
          .from(users)
          .where(inArray(users.id, made));
        for (const row of read) after.set(row.id, row.muted);
        throw new Error('rollback');
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error) || err.message !== 'rollback') throw err;
      });

    expect(after.get(idOf('post'))).toEqual(OPERATIONS_BEFORE.filter((t) => t !== 'InternalNote' && t !== 'MentionedInNote'));
    expect(after.get(idOf('pre'))).toEqual(lists.pre);
    expect(after.get(idOf('all'))).toEqual(['all']);
    expect(after.get(idOf('none'))).toEqual([]);
  });
});
