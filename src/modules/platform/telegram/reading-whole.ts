import type { IntakeState } from './calc-intake';

/**
 * Has the AI read everything the seller sent and the bot ACCEPTED?
 * (docs/FAYL-OQISH.md §1.1, his 2026-11-10 «fillarni oldin korib chiqib
 * togridan togri tasdiq deyabti».)
 *
 * On the AI door «✅ Tasdiqlash» says «the AI read it and will compute». It
 * was drawn over a lone Excel the model never saw and over a table of zero
 * goods. This is the one predicate the table's closing, its keyboard, every
 * word that names the confirm, the save branch and the landing ask
 * (#513).
 *
 * It reads STATE FIELDS only (judge door-whole-inputs). The reading job's
 * locals are gone by the time a press or the sweep asks: a missing file
 * became a note string, and a cut never reached the state.
 *
 * Two tiers:
 * - `blocking`: what was accepted and not read. Any of it makes the reading
 *   not whole.
 * - `named`: files refused AT ARRIVAL. The seller was told then that each
 *   would not be read, so they are named on the table and never block. There
 *   is no door to take a file back out of a collection, and blocking on one
 *   would leave «✖️» as the only way to an AI figure.
 */
export type UnreadReason =
  /** The table has no goods row. */
  | 'no_goods'
  /** The model stopped before the end (§3.3): a clock, size or dropped cut. */
  | 'cut'
  /** Material only the model can read is here, and the model did not answer. */
  | 'model_failed'
  /** The API refused one or more PDFs (§3.4). */
  | 'pdf_refused'
  /** A stored file did not load at the reading (§2.5). */
  | 'files_missing'
  /** The model was not shown all of an accepted sheet text (§1.1 f). */
  | 'input_cut'
  /** A mapped Excel past the reader's row ceiling kept only its first rows (§1.1 g). */
  | 'capped';

export interface ReadingWholeness {
  whole: boolean;
  blocking: UnreadReason[];
  named: { name: string; why: string; resent?: boolean }[];
}

/**
 * The press that lands a not-whole AI collection for the VED alone (§1.2) —
 * never «📨 VED ga yuborish», which is the add door's «✅ Qo‘shish»
 * (door-amend-scope). One home for the keyboard, the dialogue's words and the
 * table's (wms reads it from here: this file imports nothing at run time).
 */
export const TO_VED_LABEL = '👤 VED hisoblasin';

/** The fields the predicate reads — a type, so a caller cannot hand it a stale projection. */
export type WholenessInput = Pick<
  IntakeState,
  'images' | 'pdfs' | 'sheetTexts' | 'aiUsed' | 'goodsFiles'
> &
  Partial<Pick<IntakeState, 'aiCut' | 'aiInputCut' | 'filesMissing' | 'unreadPdfs' | 'refusedFiles'>>;

/** Is there material only the MODEL can read — photos, PDFs it was not refused, sheet text the reader could not map? */
export function modelOnlyMaterial(state: WholenessInput): boolean {
  const refused = new Set(state.unreadPdfs ?? []);
  return (
    state.images.length > 0 ||
    state.pdfs.some((p) => !refused.has(p.attachmentId)) ||
    state.sheetTexts.some((t) => t.text.trim() !== '')
  );
}

/**
 * `rowCount` is the TABLE's goods rows (`tableRowsOf(...).length`), never the
 * facts' goods before the table's own merge.
 */
export function aiReadingWhole(state: WholenessInput, rowCount: number): ReadingWholeness {
  const blocking: UnreadReason[] = [];
  if (rowCount === 0) blocking.push('no_goods');
  if (state.aiCut) blocking.push('cut');
  if (modelOnlyMaterial(state) && !state.aiUsed) blocking.push('model_failed');
  if ((state.unreadPdfs ?? []).length > 0) blocking.push('pdf_refused');
  if ((state.filesMissing ?? 0) > 0) blocking.push('files_missing');
  if (state.aiInputCut) blocking.push('input_cut');
  if ((state.goodsFiles ?? []).some((f) => f.capped === true)) blocking.push('capped');
  return { whole: blocking.length === 0, blocking, named: [...(state.refusedFiles ?? [])] };
}
