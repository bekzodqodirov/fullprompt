import { autoBasisFor, basesFor, basisOnScreen, healPairKept, pairUnitFor, type AutoBasisItem } from './basis';
import { readNumberCell } from './number-cell';
import { missingNeeds, rowNeeds, type NeedLaw, type NeedUnit, type RowNeed } from './needs';
import { pendingUnitOf, type PendingUnit } from './units';
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

/**
 * The code a GROUPED row is re-homed under by the next Saqlash — its own
 * stored code when that is not its block's (workspace.ts step 3, P2.10d) —
 * or null. ONE reading for the live figure (`screenRowOf` prices the row in
 * the block it will land in) and for the gate that waits on that save: a row
 * the bar prices in its new block is a row the STORED total does not price
 * yet, so ✅ and the seal must wait for the press that moves it, and the
 * screen must offer that press (review fix-review: the ✨ pass's 6403 rows in
 * a 6402 block re-priced the bar while Saqlash stayed grey and the seal
 * locked the old law). A row with no code stays where a person put it, as
 * the sweep leaves it; a draft of the code is the draft's business.
 */
export function rehomeCodeOf(
  item: { groupId: string | null; tnvedCode: string | null },
  groupById: Map<string, { tnvedCode: string | null }>,
): string | null {
  if (!item.groupId) return null;
  const stored = (item.tnvedCode ?? '').trim();
  const own = (groupById.get(item.groupId)?.tnvedCode ?? '').trim();
  return stored !== '' && stored !== own ? stored : null;
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
  // And a GROUPED row whose own code is not its block's: the save's sweep
  // re-homes it (workspace.ts step 3), so the screen reads it in the block it
  // will land in — otherwise the live figure priced it where it no longer
  // stands (review live-figure). A matching code keeps its own block, a
  // legacy same-code duplicate included, as the sweep does.
  const code =
    draft?.tnvedCode !== undefined
      ? draft.tnvedCode.trim()
      : item.groupId
        ? (rehomeCodeOf(item, groupById) ?? '')
        : (item.tnvedCode ?? '').trim();
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

/**
 * The pair a GHOST row's law or CHOSEN unit names — never the one its own
 * typed measure states. The O'lchov unit select and the posted `measureUnit`
 * ask THIS, not `pair`: since «avto» reads the stated measure, `pair` turns
 * to m² the moment m² is picked, so the select vanished under the VED's
 * finger and the add posted no unit — and the save, told nothing, dropped the
 * 120 m² it had just been typed. Found by m9zr in a browser; the integration
 * test posted the unit itself and could not see it (#531's shape).
 * An unknown law names nothing: the VED says the unit.
 */
export function ghostFixedPair<G extends ScreenGroup>(
  row: { tnvedCode: string; bazaBasis: BazaBasis | null },
  groupsByCode: Map<string, G>,
): MeasureUnit | null {
  const code = row.tnvedCode.trim();
  const lawGroup = code ? (groupsByCode.get(code) ?? null) : null;
  if (code !== '' && lawGroup === null) return null;
  return pairUnitFor(lawGroup?.dutyUnit, row.bazaBasis);
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

/** The cell a needed figure is typed into. */
export type NeedCell = 'quantity' | 'weightKg' | 'volumeM3' | 'measure';
export interface CellNeed extends RowNeed {
  cell: NeedCell;
}

const CELL_OF: Record<NeedUnit, NeedCell> = {
  dona: 'quantity',
  '1000_dona': 'quantity',
  kg: 'weightKg',
  m3: 'volumeM3',
  m2: 'measure',
  juft: 'measure',
  litr: 'measure',
  sm3: 'measure',
};

/**
 * Which of a row's cells still need a figure, and WHY — the engine asked
 * ahead of time (`rowNeeds`, the kernel's one reading), so the cell a
 * refusal will name is marked before the VED presses anything (P3.2). The
 * owner's kg-and-dona rows: a jacket valued per kg under «20 %, kamida
 * $3/dona» marks its count, a table valued per piece under «kamida
 * $0.4/kg» marks its weight.
 *
 * The law's floor and a specific excise ask always; the BAZA's unit asks
 * only once the row carries a price (an unpriced row has not said what it is
 * priced per, and marking a guess would be noise on every new row).
 */
export function neededCells(
  screen: Pick<ScreenRow<unknown>, 'basis' | 'pair'>,
  law: NeedLaw | null,
  item: ScreenItem & { volumeM3: number | null; bazaUsd: number | null },
  draft: (ScreenDraft & { volumeM3?: string; bazaValue?: string }) | undefined,
): CellNeed[] {
  const figures = screenFigures(item, draft);
  const pair = screen.pair !== null && screen.pair !== 'any' ? screen.pair : null;
  const measureQty =
    pair === null
      ? null
      : draft?.measure !== undefined
        ? draftedFigure(draft.measure, null)
        : item.measureUnit === pair
          ? item.measureQty
          : null;
  const price = draft?.bazaValue !== undefined ? draftedFigure(draft.bazaValue, null) : item.bazaUsd;
  const needs = rowNeeds(law, price !== null && price > 0 ? screen.basis : null, {
    quantity: figures.quantity,
    weightKg: figures.weightKg,
    volumeM3: draftedFigure(draft?.volumeM3, item.volumeM3),
    measureUnit: pair,
    measureQty,
  });
  return missingNeeds(needs).map((n) => ({ ...n, cell: CELL_OF[n.unit] }));
}

/**
 * A row still stored the old way, as the SCREEN must say it before any press
 * (judge UX7): the save's own predicate (`pendingUnitOf`) over the stored
 * row, with one draft read — a price typed (or a unit chosen) in this draft
 * means the save will NOT move the number, so the screen must not promise it.
 */
export function pendingUnitOnScreen(
  item: ScreenItem & { unit: string | null; volumeM3: number | null; bazaUsd: number | null },
  ctx: { confirmed: boolean; lawDutyUnit: string | null; grouped: boolean },
  draft: { bazaValue?: string; bazaBasis?: BazaBasis } | undefined,
): PendingUnit | null {
  // The price and the unit as the SAVE will hold them: a cleared price takes
  // a stamped unit with it (`postedBasis`), and the save then heals the row —
  // reading the drafted basis alone said «nothing will move» about a row the
  // save then moved (review gate-ux).
  const priceDrafted = draft?.bazaValue !== undefined;
  const draftedPrice = priceDrafted ? draftedFigure(draft!.bazaValue, null) : null;
  const priced = priceDrafted ? draftedPrice !== null : item.bazaUsd !== null;
  const chosen = postedBasis(draft?.bazaBasis, priceDrafted && draftedPrice === null, item);
  if (priced || chosen !== null) return null;
  const law = ctx.lawDutyUnit;
  return pendingUnitOf(
    {
      quantity: item.quantity,
      unit: item.unit,
      weightKg: item.weightKg,
      volumeM3: item.volumeM3,
      measureUnit: item.measureUnit,
      measureQty: item.measureQty,
      bazaUsd: null,
      bazaBasis: null,
    },
    {
      confirmed: ctx.confirmed,
      pairKept: (unit) =>
        healPairKept(law, ctx.grouped, unit, { weightKg: item.weightKg, measureQty: item.quantity }),
    },
  );
}

/**
 * Which block each row prices in RIGHT NOW — the drafted state, by the
 * save's own regroup (P3.8, judge MR-22): a row whose code is drafted joins
 * that code's block (the first by seq, `groupsByCodeOf`), a row whose code is
 * drafted EMPTY leaves its block, and a drafted code no block carries makes
 * the whole figure the browser's guess until the save mints that block.
 *
 * The live bar used to price a re-coded row in its OLD block and count the
 * ungrouped rows off the STORED list — a total that the very next Saqlash
 * would change or refuse. `ungrouped` is the drafted count the request's
 * assembly needs; `moved` names the blocks whose membership the save will
 * change, so their footers say «taxminiy».
 */
export function liveMembership<I extends ScreenItem & { id: string }, G extends ScreenGroup & { id: string }>(
  items: I[],
  drafts: Record<string, ScreenDraft | undefined>,
  groupById: Map<string, G>,
  groupsByCode: Map<string, G>,
): { members: Map<string, I[]>; ungrouped: I[]; unsavedCode: boolean; moved: Set<string> } {
  const members = new Map<string, I[]>();
  const ungrouped: I[] = [];
  const moved = new Set<string>();
  let unsavedCode = false;
  for (const item of items) {
    const screen = screenRowOf(item, drafts[item.id], groupById, groupsByCode);
    const home = screen.lawGroup?.id ?? null;
    if (screen.lawUnknown) unsavedCode = true;
    if (home !== item.groupId) {
      if (item.groupId) moved.add(item.groupId);
      if (home) moved.add(home);
    }
    if (home) {
      const list = members.get(home) ?? [];
      list.push(item);
      members.set(home, list);
    } else if (!screen.lawUnknown) {
      ungrouped.push(item);
    }
  }
  return { members, ungrouped, unsavedCode, moved };
}
