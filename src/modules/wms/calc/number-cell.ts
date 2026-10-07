/**
 * A number typed into one of the calculation's cells — quantity, kg, m³, the
 * O'lchov measure and the baza — read the ONE way both screen shapes read it.
 *
 * Pure and zero-import, like `money-input.ts` beside it, and deliberately NOT
 * that reader. The grid had two readers of the same keystrokes and they
 * disagreed exactly where money is made: the table's own `parseCell` turned
 * «15,000» into $15 and the dictionary's form did the same, while
 * `parseTypedMoney` turns «1,125» into 1125. The baza column holds four
 * decimals, so «1,125 $/kg» and «15,000 $/dona» (a vehicle) are BOTH
 * legitimate prices — neither reading is safe, and guessing either way is a
 * thousand-fold error on a customer's customs bill. His B4 a: such a number is
 * not saved; the screen asks «1.125 dollarmi yoki 1125 dollarmi?».
 *
 * The rules, in the order they are applied:
 *
 *  1. Every space, NBSP, narrow NBSP and apostrophe comes out (the grouping
 *     marks a phone keyboard, an Excel paste and some invoices produce).
 *  2. ONE comma followed by exactly three digits, not after a lone 0 —
 *     «1,125», «15,000» — is AMBIGUOUS: both readings are handed back and
 *     nothing is chosen.
 *  3. Two or more comma groups, or a comma group followed by a dot decimal —
 *     «1,125,000», «1,125.50» — cannot be a decimal comma: thousands.
 *  4. Any other single comma is the decimal separator («0,125», «1,5»,
 *     «1,12», «1234,567»), the way this office writes «1,5».
 *  5. What is left must be a plain non-negative number with a dot decimal,
 *     and FINITE — a 400-digit string is `Infinity` to `Number()`, and
 *     Infinity answers true to `> 0`. A minus is bad: the server refuses a
 *     non-positive measure or baza anyway.
 */
export type NumberCell =
  | { state: 'empty' }
  | { state: 'ok'; value: number }
  | { state: 'bad' }
  | {
      state: 'ambiguous';
      /** «1,125» read with a decimal comma — 1.125. */
      decimal: number;
      /** …and read with a thousands comma — 1125. */
      thousands: number;
      /** The two readings as the person would retype them. */
      decimalText: string;
      thousandsText: string;
    };

const GROUPING = /[\s  ']/g;
const AMBIGUOUS = /^[1-9]\d{0,2},\d{3}$/;
const THOUSANDS = [/^\d{1,3}(,\d{3}){2,}(\.\d+)?$/, /^\d{1,3}(,\d{3})+\.\d+$/];
const PLAIN = /^\d+(\.\d+)?$/;

const finite = (text: string): NumberCell => {
  if (!PLAIN.test(text)) return { state: 'bad' };
  const value = Number(text);
  return Number.isFinite(value) ? { state: 'ok', value } : { state: 'bad' };
};

export function readNumberCell(raw: string): NumberCell {
  const cleaned = raw.replace(GROUPING, '');
  if (cleaned === '') return { state: 'empty' };

  if (AMBIGUOUS.test(cleaned)) {
    const decimalText = cleaned.replace(',', '.');
    const thousandsText = cleaned.replace(',', '');
    const decimal = Number(decimalText);
    const thousands = Number(thousandsText);
    return { state: 'ambiguous', decimal, thousands, decimalText, thousandsText };
  }
  if (THOUSANDS.some((re) => re.test(cleaned))) return finite(cleaned.replace(/,/g, ''));
  const commas = cleaned.split(',').length - 1;
  if (commas === 1) return finite(cleaned.replace(',', '.'));
  if (commas > 1) return { state: 'bad' };
  return finite(cleaned);
}

/** The cell's value when it can be priced — null for empty, bad AND
 * ambiguous: no figure is ever computed from a number nobody stated. */
export function numberOrNull(raw: string): number | null {
  const cell = readNumberCell(raw);
  return cell.state === 'ok' ? cell.value : null;
}
