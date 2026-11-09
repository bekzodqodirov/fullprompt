import { seenOf } from '@/modules/wms/finance/truck-deal';

/**
 * The price table's small decisions, pure and import-light — so the table
 * (`PricingTable`), the wrapper that words its refusals (`ClientPricing`) and
 * their tests are one arithmetic (#166). Nothing here reads money: each rule
 * is about which row a press counts, marks or names.
 */

/**
 * What one press totals — «Jami: N ta bitim · X». N counts DEALS: the
 * «bitimsiz» part names no deal, and is said beside them (review B3: two deals
 * and «bitimsiz» read «3 ta bitim»).
 */
export function pressTotalOf(filled: { key: string; amount: number }[]): { n: number; none: boolean; total: number } {
  return {
    n: filled.filter((part) => part.key !== 'none').length,
    none: filled.some((part) => part.key === 'none'),
    total: Math.round(filled.reduce((sum, part) => sum + part.amount, 0) * 100) / 100,
  };
}

/** A refusal marked on its row: the row, and what the door said about it. */
export type RowMark = { key: string; error: string } | null;

/**
 * Whether a row prints «summani o'qib bo'lmadi» — only for an unreadable
 * amount. Every other refusal a row is named by (a figure too large for one
 * row, a deal that left, a part posted twice) only OUTLINES the row, and its
 * sentence is the wrapper's (review B2: a well-formed $1.5 billion used to
 * read «unreadable» on its row while the line under the table said «too
 * large»).
 */
export function rowSaysUnreadable(mark: RowMark, key: string): boolean {
  return mark !== null && mark.key === key && mark.error === 'validation';
}

/**
 * Whether the wrapper words the held refusal — or its row already does
 * (`rowSaysUnreadable`), and the sentence would stand twice (review B2). An
 * unreadable amount is said on its row while that row is drawn; with the row
 * gone (a redraw, a flip to the single form), the wrapper says it.
 */
export function wrapperWords(last: { error: string; dealId?: string } | null, drawnKeys: string[] | null): boolean {
  if (!last) return false;
  if (last.error !== 'validation' || !last.dealId || !drawnKeys) return true;
  return !drawnKeys.includes(last.dealId);
}

/**
 * The code a held refusal names — taken when the refusal ARRIVES, while the
 * rows it was about are the drawn ones. The sentence outlives every redraw
 * (§3.1.8); a deal that has since left this client's rows would otherwise
 * print as a raw id, or as the word «none» after a flip to the single form
 * (review B4). No code, no prefix — never the id.
 */
export function refusalCodeOf(dealId: string | undefined, codes: Record<string, string>): string | null {
  return dealId ? (codes[dealId] ?? null) : null;
}

/**
 * The posted deals that carried a price of their own on their CARD as drawn —
 * the «bitim kartasida narx bor» each filled row asked, or did not. The write
 * body re-reads it under the client lock, so a card price written between the
 * drawing and the press is `prices_changed`, never a second bill nobody was
 * asked about (review A4). Only filled rows: a blank row bills nothing.
 */
export function cardSeenOf<R extends { key: string; card: boolean }>(rows: R[], posted: (row: R) => boolean): string {
  return seenOf(rows.filter((row) => row.card && row.key !== 'none' && posted(row)).map((row) => row.key));
}
