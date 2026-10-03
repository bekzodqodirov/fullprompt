/**
 * The PURE half of «yuk ma'lumoti tekshirildi» (docs/YUK-TEKSHIRUV.md): the
 * states, the filter values and the chip a row wears — no database, so the
 * plan editor (a client component) can import it without carrying drizzle
 * into the browser. The SQL half is `lot-check-sql.ts`, which re-exports
 * these so a server reader has one import.
 */

export const LOT_CHECK_STATES = ['checked', 'unclaimed', 'stale', 'none'] as const;
export type LotCheckState = (typeof LOT_CHECK_STATES)[number];

/** The two filter values; absent = everything. */
export type CheckFilter = 'ha' | 'yoq';

/** `?tek=` read out of a URL — anything else is dropped, never bound (#514). */
export function readCheckFilter(raw: string | null | undefined): CheckFilter | null {
  return raw === 'ha' || raw === 'yoq' ? raw : null;
}

/** The pure twin of `checkFilterSql`, for a screen that filters what it already holds. */
export function inCheckFilter(
  tek: CheckFilter,
  state: LotCheckState | undefined,
  askable: boolean,
): boolean {
  if (state === undefined) return false;
  return tek === 'ha' ? state === 'checked' : (state === 'none' || state === 'stale') && askable;
}

/**
 * The chip a row wears: ✅ wherever it stands, ⚠/❓ only where it is askable,
 * nothing for unclaimed cargo (it has its own list) — null = draw nothing.
 */
export function chipFace(
  state: LotCheckState | undefined,
  askable: boolean,
): 'checked' | 'stale' | 'none' | null {
  if (state === 'checked') return 'checked';
  if (!askable) return null;
  if (state === 'stale' || state === 'none') return state;
  return null;
}
