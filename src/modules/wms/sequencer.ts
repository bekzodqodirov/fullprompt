import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../platform/db/client';
import { letterBlacklist, settings, warehouses } from '../platform/db/schema';
import { computeNextLetters, type LetterAssignment } from './letters';

/**
 * Assign `count` letters at a warehouse inside the caller's transaction.
 * The warehouse row is locked (SELECT … FOR UPDATE) so two operators
 * confirming simultaneously can never receive the same letter (spec 5.3,
 * acceptance test 4).
 *
 * `letter_scope=global` (spec §17) uses one shared counter: the counter then
 * lives on a designated row — the alphabetically-first active warehouse —
 * but the lock still serializes every confirm.
 */
export async function assignLetters(
  tx: Tx,
  warehouseId: string,
  count: number,
): Promise<LetterAssignment[]> {
  const scopeRow = await tx.query.settings.findFirst({
    where: eq(settings.key, 'letter_scope'),
  });
  const scope = (scopeRow?.value as string | undefined) ?? 'warehouse';

  let counterWarehouseId = warehouseId;
  if (scope === 'global') {
    const rows = (await tx.execute(
      sql`SELECT id FROM warehouses WHERE active ORDER BY code LIMIT 1`,
    )) as unknown as { id: string }[];
    counterWarehouseId = rows[0]?.id ?? warehouseId;
  }

  // Row lock — the serialization point.
  const lockedRows = (await tx.execute(sql`
    SELECT id, letter_position, letter_cycle_no
    FROM warehouses WHERE id = ${counterWarehouseId} FOR UPDATE
  `)) as unknown as { id: string; letter_position: number; letter_cycle_no: number }[];
  const locked = lockedRows[0];
  if (!locked) throw new Error(`warehouse not found: ${counterWarehouseId}`);

  const blacklistRows = await tx.select().from(letterBlacklist);
  const ambiguousRow = await tx.query.settings.findFirst({
    where: eq(settings.key, 'exclude_ambiguous_letters'),
  });

  const { letters, nextState } = computeNextLetters(
    { position: locked.letter_position, cycleNo: locked.letter_cycle_no },
    count,
    {
      blacklist: new Set(blacklistRows.map((r) => r.combo)),
      excludeAmbiguous: ambiguousRow?.value === true,
    },
  );

  await tx
    .update(warehouses)
    .set({ letterPosition: nextState.position, letterCycleNo: nextState.cycleNo })
    .where(eq(warehouses.id, counterWarehouseId));

  return letters;
}

/**
 * Non-binding preview of the next letters (wizard shows "≈ D, E, F").
 * No locks, no state change — the real assignment happens at confirm
 * (DECISIONS.md #8).
 */
export async function previewLetters(
  tx: Tx,
  warehouseId: string,
  count: number,
): Promise<string[]> {
  const wh = await tx.query.warehouses.findFirst({ where: eq(warehouses.id, warehouseId) });
  if (!wh) return [];
  const blacklistRows = await tx.select().from(letterBlacklist);
  const ambiguousRow = await tx.query.settings.findFirst({
    where: eq(settings.key, 'exclude_ambiguous_letters'),
  });
  const { letters } = computeNextLetters(
    { position: wh.letterPosition, cycleNo: wh.letterCycleNo },
    count,
    {
      blacklist: new Set(blacklistRows.map((r) => r.combo)),
      excludeAmbiguous: ambiguousRow?.value === true,
    },
  );
  return letters.map((l) => l.letter);
}
