import { autoBasisFor, basesFor, basisOnScreen, pairUnitFor, type AutoBasisItem } from './basis';
import { readNumberCell } from './number-cell';
import type { BazaBasis, MeasureUnit } from './pricing';

/** The slices of the workspace's row, block and draft that decide a row's
 * unit — narrow on purpose, so the browser's table and the test hand the
 * same function the same shapes. The FIGURES are required since «avto»
 * reads them (2026-10-09): an optional figure fails open into the law-only
 * answer the save no longer stamps. */
export interface ScreenItem {
  groupId: string | null;
  tnvedCode: string | null;
  bazaBasis: BazaBasis | null;
  quantity: number | null;
  weightKg: number | null;
  measureUnit: MeasureUnit | null;
  measureQty: number | null;
}
export interface ScreenGroup {
  dutyUnit: string | null;
  tnvedCode: string | null;
}
export interface ScreenDraft {
  tnvedCode?: string;
  bazaBasis?: BazaBasis;
  quantity?: string;
  weightKg?: string;
  measure?: string;
}

/** A drafted cell as a figure — an empty, ambiguous or bad cell states
 * nothing (B4 a), exactly as the live engine reads it. */
function draftedFigure(raw: string | undefined, stored: number | null): number | null {
  if (raw === undefined) return stored;
  const cell = readNumberCell(raw);
  return cell.state === 'ok' ? cell.value : null;
}

/** The figures «avto» reads: the drafts over the stored row. A drafted
 * measure keeps the STORED unit — the unit of a statement is the row's, the
 * box only types its amount. */
export function screenFigures(item: ScreenItem, draft: ScreenDraft | undefined): AutoBasisItem {
  return {
    quantity: draftedFigure(draft?.quantity, item.quantity),
    weightKg: draftedFigure(draft?.weightKg, item.weightKg),
    measureUnit: item.measureUnit,
    measureQty: draftedFigure(draft?.measure, item.measureQty),
  };
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
      : basisOnScreen(draft?.bazaBasis, item.bazaBasis, lawGroup, screenFigures(item, draft));
  return {
    lawGroup,
    lawUnknown,
    basis,
    offered: basesFor(lawUnknown ? null : lawUnit),
    pair: lawUnknown ? 'any' : pairUnitFor(lawUnit, basis),
  };
}

/**
 * The same answer for a GHOST row (one typed and not yet saved): the law its
 * typed code would land under when this request already has that code's
 * block, the unit its select shows — null «avto» until touched (18a) — the
 * units on offer, and the measure pair the LIVE figure prices in.
 *
 * It decides nothing about whether the ghost's O'lchov box is DRAWN: a new
 * row's law is unknowable before the save (a code no block carries, or an
 * uncoded row the server's TNVED memory codes on that very save), so the box
 * is drawn on every ghost and posted, and the server drops and names what the
 * law does not take (`measuresDropped`).
 */
export function ghostScreenOf<G extends ScreenGroup>(
  row: {
    tnvedCode: string;
    bazaBasis: BazaBasis | null;
    quantity: string;
    weightKg: string;
    measure: string;
    measureUnit: MeasureUnit | null;
  },
  groupsByCode: Map<string, G>,
): ScreenRow<G> {
  const code = row.tnvedCode.trim();
  const lawGroup = code ? (groupsByCode.get(code) ?? null) : null;
  const lawUnknown = code !== '' && lawGroup === null;
  return {
    lawGroup,
    lawUnknown,
    basis: row.bazaBasis,
    offered: basesFor(lawUnknown ? null : (lawGroup?.dutyUnit ?? null)),
    pair: lawUnknown ? 'any' : pairUnitFor(lawGroup?.dutyUnit, row.bazaBasis ?? ghostAutoBasis(row, lawGroup)),
  };
}

/** The «avto» unit of a ghost row — the save's own rule over what is typed.
 * The unit select beside its O'lchov box says what the amount is IN. */
export function ghostAutoBasis(
  row: { quantity: string; weightKg: string; measure: string; measureUnit: MeasureUnit | null },
  lawGroup: { dutyUnit?: string | null } | null,
): BazaBasis {
  return autoBasisFor(lawGroup, {
    quantity: draftedFigure(row.quantity, null),
    weightKg: draftedFigure(row.weightKg, null),
    measureUnit: row.measureUnit,
    measureQty: draftedFigure(row.measure, null),
  });
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

/**
 * The unit a baza edit POSTS (0125's four states, workspace.ts
 * `TableItemEdit`). A unit the VED touched is posted with or without a price;
 * an untouched one posts what is stored — it stands, or null = «avto», which
 * the server stamps from the block the row ENDS in.
 *
 * Clearing the price keeps the stored unit only when it is KNOWN to be a
 * choice: on a row with no price, a stored unit was always picked by a
 * person. A priced row's unit may be the server's stamp, a fill's, or a
 * pre-0125 «шт» on a juft code — «differs from today's default» is not
 * «chosen», and posting it made every fill and the 📥 picker narrow to a unit
 * nobody picked (review units-r2-1). It goes back to «avto» with the price.
 */
export function postedBasis(
  draft: BazaBasis | undefined,
  priceCleared: boolean,
  stored: { bazaUsd: number | null; bazaBasis: BazaBasis | null },
): BazaBasis | null {
  if (draft !== undefined) return draft;
  if (priceCleared) return stored.bazaUsd === null ? stored.bazaBasis : null;
  return stored.bazaBasis;
}
