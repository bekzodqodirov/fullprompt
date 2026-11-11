import { nameKey } from '@/modules/wms/receipts/composition-math';
import type { TnvedProductRow } from '@/modules/wms/tnved/batch-lots';

/**
 * The Bojxona tab's editor, the part that is not React: its row, the row's
 * key, and the three decisions the review of the built round found wrong or
 * missing (2026-11-10) — pure, so each is a test's and not a browser's.
 */

export interface TnvedRow {
  lotId: string;
  nameZh: string;
  nameRu: string | null;
  photoId: string | null;
  boxCount: number;
  /** From memory — pre-filled. */
  code: string;
  source: 'manual' | 'ai' | null;
  /** The lots behind the row; `readable` = the person may open that prixod. */
  lots: { lotId: string; receiptId: string; label: string; readable: boolean }[];
  /** A lot tarkibi LINE (docs/LOT-TARKIBI.md §5); absent on a product row. */
  line?: NonNullable<TnvedProductRow['line']> & { readable: boolean; firstOfLot: boolean };
}

/**
 * Every piece of per-row state is keyed by THIS — never by `lotId`: both
 * lines of a composed lot share their lot's id, so a `lotId` key wrote the
 * mouse's code into the keyboard's line too (the lot tarkibi judge's R1, a
 * misdeclaration no other test saw).
 */
export function rowKey(row: Pick<TnvedRow, 'lotId' | 'line'>): string {
  return row.line ? row.line.rowKey : row.lotId;
}

/**
 * The editor's rows after a REFRESH brought the server's (a save, «🔄», a
 * colleague's change): every row is the server's — its code, its line
 * revision, its hint — except where this screen holds a code that is NOT
 * saved yet (typed, or suggested by the 🤖): that row keeps the person's code
 * on the server's row. A row the refresh no longer has is gone (a tarkib
 * re-saved on the prixod card replaces every line and its key).
 *
 * `baseOf(key)` = what the server held for that row when the code was last
 * equal to it: the rows the editor was seeded with, overlaid by what a save
 * has just written.
 *
 * It replaces a React `key` built from the line revisions, which re-seeded by
 * REMOUNT: one lot's tarkib moving, or one line code saved, threw away every
 * unsaved code on the screen — model answers already paid for — and a
 * product-only save did not remount at all, so a row nobody had touched read
 * as «changed» when the memory moved under it and the next «Saqlash» wrote
 * the stale code back over a colleague's correction.
 */
export function reseedRows(
  current: readonly TnvedRow[],
  baseOf: (key: string) => string,
  fresh: readonly TnvedRow[],
): TnvedRow[] {
  const held = new Map(current.map((row) => [rowKey(row), row]));
  return fresh.map((row) => {
    const mine = held.get(rowKey(row));
    return mine && mine.code !== baseOf(rowKey(row)) ? { ...row, code: mine.code, source: mine.source } : row;
  });
}

/**
 * What a 🤖 refusal means for «🤖 AI taklif (N)»:
 *
 *  · `failed` — the model's own failure. The next row may fare better; two in
 *    a row end the walk;
 *  · `skip-lot` — a fact about ONE lot: its tarkib was re-saved under the
 *    screen, its prixod is no longer confirmed, the lot is gone. That lot's
 *    rows are left alone, the walk goes on, and the lot is named at the end.
 *    (Stopping here left every later lot out of the walk's reach until a
 *    reload that dropped the answers already given.);
 *  · `stop` — a door that is shut for every row: no key, no permission, a
 *    ticked truck. One sentence is enough, and a dead button is not pressed
 *    once per row.
 */
export type WalkStep = 'failed' | 'skip-lot' | 'stop';
export function walkStep(error: string | undefined): WalkStep {
  switch (error) {
    case 'ai_failed':
      return 'failed';
    case 'composition_changed':
    case 'receipt_not_confirmed':
    case 'not_found':
      return 'skip-lot';
    default:
      return 'stop';
  }
}

/**
 * A code that another tarkib line of the SAME name already holds on the
 * screen — typed, suggested or saved. It IS the answer for this line and
 * costs no call: two asks about one good can come back with two codes, and
 * the invoice merges same-named goods only when their codes are equal. The
 * walk's own `byName` covered only the answers of one uninterrupted walk; a
 * code from the row's own 🤖, from typing or from a walk that stopped was
 * asked about again.
 */
export function sameNameCode(rows: readonly TnvedRow[], target: TnvedRow): string | null {
  if (!target.line) return null;
  const name = nameKey(target.nameZh);
  const self = rowKey(target);
  const twin = rows.find(
    (row) => row.line && rowKey(row) !== self && nameKey(row.nameZh) === name && row.code.trim() !== '',
  );
  return twin ? twin.code : null;
}
