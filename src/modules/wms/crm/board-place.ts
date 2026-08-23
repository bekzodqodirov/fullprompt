import { sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Db, Tx } from '@/modules/platform/db/client';
import { BOARD_SPACING, slotBetween } from './board-order';

/**
 * Writing the number `board-order.ts` decides.
 *
 * Split from the arithmetic because that half runs in the browser too — the
 * board has to show a dropped card in its new place before Germany answers —
 * and a module reaching for `db` cannot be imported by a client component.
 *
 * Generic over the TABLE rather than written twice: `leads` and `deals` carry
 * the same two columns under the same names (0075), and the funnel and the
 * deal board are one story the owner reads the same way. What genuinely
 * differs is how a column breaks a tie between two cards nobody has placed —
 * the funnel by when it was last touched, the deal board by when it was
 * raised — so that arrives as a fragment.
 */
export interface BoardTable {
  table: PgTable;
  /** ORDER BY fragment for two unplaced cards, mirroring the board's own. */
  tieBreak: SQL;
}

type Exec = Db | Tx;

/** The top of a column: above everything already in it. */
export async function topOfColumn(db: Exec, spec: BoardTable, stageId: string): Promise<number> {
  const [row] = await db.execute<{ m: number | null }>(
    sql`SELECT min(board_order) AS m FROM ${spec.table} WHERE stage_id = ${stageId}::uuid`,
  );
  const min = row?.m ?? null;
  return min === null ? BOARD_SPACING : min - BOARD_SPACING;
}

/**
 * The bottom of a column: below everything already in it.
 *
 * The top is where a card a PERSON raised belongs — they are about to work on
 * it. A card the system opened by itself is not that: round 111 opens a deal
 * with every client code, so on a busy funnel those shells would take the top
 * of the first column and push real, priced work off the forty the board
 * draws. Ordered by `board_order ASC`, the bottom is exactly the right rank
 * for a card that carries nothing yet, and it costs the same one query.
 */
export async function bottomOfColumn(db: Exec, spec: BoardTable, stageId: string): Promise<number> {
  const [row] = await db.execute<{ m: number | null }>(
    sql`SELECT max(board_order) AS m FROM ${spec.table} WHERE stage_id = ${stageId}::uuid`,
  );
  const slot = slotBetween(row?.m ?? null, null);
  // `slotBetween` can only answer 'renumber' when it is given two neighbours;
  // with `null` on one side it always returns a number. Narrowed rather than
  // asserted, so a future change to that function fails here loudly.
  return slot === 'renumber' ? BOARD_SPACING : slot;
}

/**
 * Space one column out again, keeping the order it is already in.
 *
 * Two things need this and they are the same thing seen twice: gaps halved
 * until nothing fits between them, and a column holding cards nobody has
 * numbered. Both are «this column's numbers no longer express its order»,
 * and both are answered by one UPDATE over one stage.
 */
export async function renumberColumn(db: Exec, spec: BoardTable, stageId: string): Promise<void> {
  await db.execute(sql`
    UPDATE ${spec.table} AS t
       SET board_order = ranked.rn * ${BOARD_SPACING}
      FROM (
        SELECT id,
               row_number() OVER (
                 ORDER BY board_order ASC NULLS FIRST, ${spec.tieBreak}
               ) AS rn
          FROM ${spec.table}
         WHERE stage_id = ${stageId}::uuid
      ) ranked
     WHERE t.id = ranked.id
  `);
}

/**
 * The number that puts `movingId` directly ABOVE `beforeId` in `stageId`.
 *
 * `beforeId` null means the end of the column — dropped below everything, or
 * onto the empty space under the last card.
 *
 * The card being moved is excluded from the neighbour search, because it may
 * still be sitting in this very column: dragging a card down past two others
 * must measure the gap between THOSE two, not between the card and itself.
 *
 * A `beforeId` the browser named but the database cannot place — deleted
 * meanwhile, moved by a colleague, or simply not in this column — is not an
 * error. The card goes to the top, which is where an unplaced card goes
 * everywhere else in this file.
 */
export async function placeInColumn(
  db: Exec,
  spec: BoardTable,
  stageId: string,
  movingId: string,
  beforeId: string | null,
): Promise<number> {
  if (beforeId === null) {
    const [row] = await db.execute<{ m: number | null }>(sql`
      SELECT max(board_order) AS m FROM ${spec.table}
       WHERE stage_id = ${stageId}::uuid AND id <> ${movingId}::uuid
    `);
    const slot = slotBetween(row?.m ?? null, null);
    return slot === 'renumber' ? BOARD_SPACING : slot;
  }
  // Dropped on itself — the pointer never left the card's own place. Nothing
  // to compute: it stays exactly where it is.
  if (beforeId === movingId) {
    const [self] = await db.execute<{ o: number | null }>(sql`
      SELECT board_order AS o FROM ${spec.table} WHERE id = ${movingId}::uuid
    `);
    if (self?.o !== null && self?.o !== undefined) return self.o;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [target] = await db.execute<{ o: number | null }>(sql`
      SELECT board_order AS o FROM ${spec.table}
       WHERE id = ${beforeId}::uuid AND stage_id = ${stageId}::uuid
    `);
    if (!target) return topOfColumn(db, spec, stageId);
    // The card above it is unplaced, so there is no number to sit under.
    if (target.o === null) {
      await renumberColumn(db, spec, stageId);
      continue;
    }
    const [above] = await db.execute<{ m: number | null }>(sql`
      SELECT max(board_order) AS m FROM ${spec.table}
       WHERE stage_id = ${stageId}::uuid
         AND id <> ${movingId}::uuid
         AND board_order < ${target.o}
    `);
    const slot = slotBetween(above?.m ?? null, target.o);
    if (slot !== 'renumber') return slot;
    await renumberColumn(db, spec, stageId);
  }
  // Two renumbers and still nowhere to put it means the column changed under
  // us both times. The top is a real answer and a visible one.
  return topOfColumn(db, spec, stageId);
}

/**
 * What a card's number becomes on an ordinary move.
 *
 * `place` is the drag: the browser says which card the moved one landed above.
 * Everything ELSE that moves a card — the one-tap next-stage button, the ⋯
 * sheet, a bulk sweep, an automation rule, the cargo trigger — says nothing
 * about position, and the honest answer for those is the TOP of the
 * destination: the card just arrived, and arriving is what puts a card at the
 * top of a column on every board this app has ever drawn.
 */
export async function orderForMove(
  db: Exec,
  spec: BoardTable,
  stageId: string,
  movingId: string,
  place?: { beforeId: string | null },
): Promise<number> {
  return place
    ? placeInColumn(db, spec, stageId, movingId, place.beforeId)
    : topOfColumn(db, spec, stageId);
}
