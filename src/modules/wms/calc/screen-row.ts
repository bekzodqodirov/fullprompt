import { basesFor, basisOnScreen, pairUnitFor } from './basis';
import type { BazaBasis, MeasureUnit } from './pricing';

/** The slices of the workspace's row, block and draft that decide a row's
 * unit — narrow on purpose, so the browser's table and the test hand the
 * same function the same shapes. */
export interface ScreenItem {
  groupId: string | null;
  tnvedCode: string | null;
  bazaBasis: BazaBasis | null;
}
export interface ScreenGroup {
  dutyUnit: string | null;
  tnvedCode: string | null;
}
export interface ScreenDraft {
  tnvedCode?: string;
  bazaBasis?: BazaBasis;
}

/**
 * What ONE existing row looks like on the screen right now — the law it is
 * under, the unit its select shows, the units it offers and the measure its
 * O'lchov line asks for (0125).
 *
 * ONE function for the four sites that must agree (#886's live-equals-saved):
 * the rendered row, the live engine item, the save, and the draft
 * self-clean. Split, the select shows one unit while the save posts another
 * (#171) — which is exactly how the owner's snap-back reached production.
 *
 * The law is the drafted code's block when the code is drafted and this
 * request already carries that code; a drafted code no block carries has an
 * UNKNOWN law until the save mints it — the select then reads «avto» and the
 * O'lchov box is the generic one, because promising «m²» about a law nobody
 * has looked up yet is how a count gets stored in the wrong unit.
 */
export interface ScreenRow<G> {
  lawGroup: G | null;
  lawUnknown: boolean;
  /** null = «avto»: untouched, nothing stored, and the law not yet known. */
  basis: BazaBasis | null;
  offered: BazaBasis[];
  /** The pair unit the row asks for; 'any' = the generic box (unknown law). */
  pair: MeasureUnit | 'any' | null;
}

export function screenRowOf<G extends ScreenGroup>(
  item: ScreenItem,
  draft: ScreenDraft | undefined,
  groupById: Map<string, G>,
  groupsByCode: Map<string, G>,
): ScreenRow<G> {
  let lawGroup = item.groupId ? (groupById.get(item.groupId) ?? null) : null;
  let lawUnknown = false;
  // A drafted code, OR a stored code on a row no block holds yet — intake
  // prefills codes and the save's sweep places the row, so the commonest
  // request arrives exactly like this. Read as «no law», it showed a fixed
  // «шт» while the sweep stamped the code's own unit (review units-3).
  const code = draft?.tnvedCode !== undefined ? draft.tnvedCode.trim() : item.groupId ? '' : (item.tnvedCode ?? '').trim();
  if (draft?.tnvedCode !== undefined || code !== '') {
    lawGroup = code ? (groupsByCode.get(code) ?? null) : null;
    lawUnknown = code !== '' && lawGroup === null;
  }
  const lawUnit = lawGroup?.dutyUnit ?? null;
  const basis =
    lawUnknown && draft?.bazaBasis === undefined && item.bazaBasis === null
      ? null
      : basisOnScreen(draft?.bazaBasis, item.bazaBasis, lawGroup);
  return {
    lawGroup,
    lawUnknown,
    basis,
    offered: basesFor(lawUnknown ? null : lawUnit),
    pair: lawUnknown ? 'any' : pairUnitFor(lawUnit, basis),
  };
}

/** The first group per code, by seq — the regroup's own «first by seq wins». */
export function groupsByCodeOf<G extends ScreenGroup>(groups: G[]): Map<string, G> {
  const out = new Map<string, G>();
  for (const g of groups) {
    const code = (g.tnvedCode ?? '').trim();
    if (code && !out.has(code)) out.set(code, g);
  }
  return out;
}
