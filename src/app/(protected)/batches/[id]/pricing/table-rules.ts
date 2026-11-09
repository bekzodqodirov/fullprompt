import { seenOf } from '@/modules/wms/finance/truck-deal';

/**
 * The «Narx» tab's small decisions, pure and import-light — so the table
 * (`PricingTable`), the single form (`PricingForm`), the wrapper that words
 * their refusals (`ClientPricing`) and their tests are one arithmetic (#166).
 * Nothing here reads money: each rule is about which row a press counts,
 * marks or names, and when a press stops to ask.
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
 * drawing and the press is `card_prices_changed`, never a second bill nobody
 * was asked about (review A4). Only filled rows: a blank row bills nothing.
 * Computed ONCE per render, and that one value is both the question's
 * identity (`askKeyOf`) and the hidden input the press posts (review RVF1-2).
 */
export function cardSeenOf<R extends { key: string; card: boolean }>(rows: R[], posted: (row: R) => boolean): string {
  return seenOf(rows.filter((row) => row.card && row.key !== 'none' && posted(row)).map((row) => row.key));
}

/**
 * The table's question identity — what an open alert is about: every row as
 * it reads now, the money, the day, and every drawn fact the press posts for
 * the door to compare (`dealsSeen`, `pricesSeen`, `cardSeen`). The alert
 * stands only while the key it was asked under is this one, so a redraw that
 * moves any of them takes it back and the next press asks again. `cardSeen`
 * used to be left out while its hidden input followed every redraw: a card
 * price written behind an open alert was posted by the redrawn input, the
 * door compared it with itself, and the job was billed on its card and on the
 * truck with the alert on screen never having asked «bitim kartasida narx
 * bor» (review RVF1-2). Pass the SAME `cardSeen` the hidden input posts.
 */
export function askKeyOf(question: {
  rows: [key: string, value: string][];
  currency: string;
  txDate: string;
  dealsSeen: string;
  pricesSeen: string;
  cardSeen: string;
}): string {
  return JSON.stringify({
    rows: question.rows,
    currency: question.currency,
    txDate: question.txDate,
    seen: `${question.dealsSeen}#${question.pricesSeen}#${question.cardSeen}`,
  });
}

/**
 * The refusals that mean «the page was drawn on facts that have moved» — the
 * client's deals aboard, his prices on this truck, the posted deals' card
 * prices (review A4-words). Either body takes its alert back and redraws on
 * any of them, the same way; the wrapper words each by its own code.
 */
export function pageWentStale(error: string | undefined): boolean {
  return error === 'deals_changed' || error === 'prices_changed' || error === 'card_prices_changed';
}

/**
 * What a filled table row asks of the prices already standing for the
 * client here — before its own zeroed / card / elsewhere / 5 % questions.
 *
 * - `whole` — a whole-cargo price stands (`wholeStandingOf`, live or given
 *   back to zero): every filled row asks, naming the list. Truck coverage
 *   ignores the deal (judge P1-UX-4).
 * - `ownUsd` — the row's own live prices here (`hereUsd`), to be named as
 *   «allaqachon $X — qo'shimcha hisob»; null when there are none, or while a
 *   LIVE whole-cargo price stands, which already says the press is a second
 *   bill over all his cargo (P1-UX-4's design). A whole price the lost-cargo
 *   door lowered to ZERO bills nothing: it never hides the row's own live
 *   price — the price that really makes this press an extra bill — from the
 *   question (review RVF2-M1; A1-zeroed-words had put the $0 price in the
 *   whole list, and the row's $400 was then said only in its muted line).
 */
export function standingAsksOf(
  hereUsd: number | null,
  whole: { zeroed: boolean }[],
): { whole: boolean; ownUsd: number | null } {
  return {
    whole: whole.length > 0,
    ownUsd: hereUsd !== null && !whole.some((price) => !price.zeroed) ? hereUsd : null,
  };
}

/**
 * Whether the single «Narx» form stops a press to ask: a second bill over an
 * earlier truck's price, a figure off the deal's, or ANY price of the
 * client's standing here — a live one (`pricedHere`), or one the lost-cargo
 * door lowered to zero (`zeroedHere`). For such a client one price covers
 * all his cargo here, so a press over either is an extra bill. The table
 * asked a zeroed part and this form did not, so the same fact asked or not
 * by which shape the client happened to get — and a re-filed prixod flips it
 * (review RVF1-1).
 */
export function singleFormAsks(press: {
  secondBill: boolean;
  deviates: boolean;
  pricedHere: unknown[];
  zeroedHere: unknown[];
}): boolean {
  return press.secondBill || press.deviates || press.pricedHere.length > 0 || press.zeroedHere.length > 0;
}
