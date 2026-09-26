/**
 * A number a PERSON typed, read the way this office writes numbers.
 *
 * Pure and zero-import, like the engine beside it. It exists because
 * `Number('1 000')` is NaN and NaN answers false to every comparison a guard
 * is made of: the «Готово» answer closed a job with `answer_currency = 'USD'`
 * and no amount, and the seller's Telegram read «💵 NaN USD» (audit A3). The
 * fix is a parser that knows what the typing MEANT, plus a server-side
 * refusal behind it — a screen guard alone leaves the action accepting it
 * (#531).
 *
 * The rules, in the order they are applied:
 *
 *  1. Every kind of space is a grouping mark and comes out: the ordinary one,
 *     NBSP (what a phone keyboard and a paste from Excel produce) and the
 *     narrow NBSP. So does the apostrophe, which is how some invoices group.
 *  2. `1,000` — a comma with exactly three digits behind it, repeatedly — is
 *     a THOUSANDS separator. `Number('1.000')` would have read it as one
 *     dollar, which is the second half of the same defect. Never after a lone
 *     `0`: nobody groups the thousands of zero, so `0,125` is a decimal (a
 *     baza per kilo, a fraction of a cube) and not 125.
 *  3. Any other comma is the DECIMAL separator, because that is how a
 *     Russian- or Uzbek-speaking person writes «1,5».
 *  4. Anything left that is not a plain number is `null` — never a guess, and
 *     never NaN travelling on as if it were a figure.
 */
export function parseTypedMoney(raw: string): number | null {
  const cleaned = raw
    .replace(/[\s   ']/g, '')
    .trim();
  if (cleaned === '') return null;

  const grouped = /^-?[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/.test(cleaned);
  const normalised = grouped ? cleaned.replace(/,/g, '') : cleaned.replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(normalised)) return null;

  const value = Number(normalised);
  return Number.isFinite(value) ? value : null;
}
