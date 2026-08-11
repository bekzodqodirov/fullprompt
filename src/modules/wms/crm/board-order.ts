/**
 * Where a card sits in its column — the arithmetic, and nothing else.
 *
 * The owner, at a board: «cartni boshqa etapga otkazganda ularni tartibi
 * ozgarib qolyabti qaysi ketma ketlikda qoysa usha saqlanib qoladgan qilsa
 * boladimi?» Both funnels sorted a column by «last touched first», so moving
 * A and then B put B above A — and an ✏️ edit, an owner change or an
 * automation rule reshuffled a column nobody had touched at all.
 *
 * A card now carries a NUMBER (migration 0073) and a drop takes the midpoint
 * between its two new neighbours: one row written per drag, whatever the
 * column's length. The cost of midpoints is that the gaps halve, so the rule
 * says when a column has to be renumbered — and says it HERE, once, because
 * two things read it:
 *
 *   - the service, which writes the number;
 *   - the board in the browser, which has to show the card in its new place
 *     immediately. Germany→Uzbekistan is a third of a second (round 45) and a
 *     card that snaps back for that long reads as a refused drag.
 *
 * Pure on purpose: no database, no React, so the two can be shown to agree
 * without either (#513's rule, one predicate for the rows and the count).
 */

/** The gap the backfill and every append leave between two neighbours. */
export const BOARD_SPACING = 1000;

/**
 * Below this a midpoint stops being worth taking.
 *
 * A double splits a gap of 1000 about fifty times before it runs out of
 * significant digits, and the last few splits produce numbers that are equal
 * to their neighbour — at which point the order silently stops being an
 * order. Well above that floor, so the renumber happens while the arithmetic
 * still works rather than after it has failed.
 */
export const BOARD_MIN_GAP = 1e-4;

/**
 * The number a card must take to land between these two neighbours.
 *
 * `null` for a neighbour means «there is nothing on that side»: dropping at
 * the very top of a column, or at the very end of it.
 *
 * Answers `'renumber'` when the two are too close to fit anything between —
 * the caller then spaces that column out again and asks a second time. The
 * caller, not this function, because renumbering is a write and this file
 * runs in the browser too.
 */
export function slotBetween(prev: number | null, next: number | null): number | 'renumber' {
  if (prev === null && next === null) return BOARD_SPACING;
  if (prev === null) return next! - BOARD_SPACING;
  if (next === null) return prev + BOARD_SPACING;
  if (next - prev < BOARD_MIN_GAP) return 'renumber';
  return prev + (next - prev) / 2;
}

/**
 * Compare two cards by the order the owner put them in.
 *
 * NULL sorts FIRST, which is where a brand-new card has always appeared: the
 * column is ordered by «last touched» today, and a card created a moment ago
 * is the most recently touched thing in it. That makes an unplaced card the
 * safe default rather than a bug — any write path that forgets to number a
 * row leaves it at the top, which is what the board did before this existed.
 *
 * Equal (including both NULL) answers 0, and `Array.prototype.sort` is stable,
 * so the caller's existing order — the server's ORDER BY, tie-broken by date —
 * survives underneath.
 */
export function compareBoardOrder(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a - b;
}
