import ExcelJS from 'exceljs';
import { DOC } from '@/modules/wms/documents/labels';

/**
 * The customs invoice's table, read the way a person reads it: by its HEADER.
 *
 * Four test files used to read it by cell number, and a column added after
 * «№» (2026-11-10, «Маркировка») moved every one of them — one of them
 * silently: netto and brutto carry the same figure, so a reader left on the
 * old cell went on passing while reading the other column. A reader that
 * finds its columns by their names cannot be moved by a new one.
 */
export interface InvoiceSheetRow {
  /** The sheet's row number. */
  row: number;
  no: number;
  /** Column «Маркировка»: the stickers behind the row, as plain text. */
  marks: string;
  /** The stickers of that cell written red (rich-text runs). */
  redMarks: string[];
  product: string;
  code: string;
  unit: string;
  quantity: number;
  places: unknown;
  netto: number;
  brutto: number;
  /** The name cell's note (an estimate), as text. */
  note: string | null;
  /** The quantity cell's note (pieces a «кг» position swallowed). */
  quantityNote: string | null;
  /** The name cell wears the estimate's solid fill. */
  filled: boolean;
  /** The amount cell's formula, with the columns it names. */
  amount: string | null;
}

export interface InvoiceSheet {
  rows: InvoiceSheetRow[];
  /** 1-based column of each header. */
  cols: Record<'no' | 'marks' | 'product' | 'code' | 'unit' | 'quantity' | 'places' | 'netto' | 'brutto' | 'price' | 'amount', number>;
  /** Column letters, for asserting formulas. */
  letters: Record<keyof InvoiceSheet['cols'], string>;
  headRow: number;
  /** The totals row's formulas by column. */
  totals: Partial<Record<keyof InvoiceSheet['cols'], string>>;
  sheet: ExcelJS.Worksheet;
}

const HEADERS: Record<keyof InvoiceSheet['cols'], string> = {
  no: '№',
  marks: DOC.lotMarks,
  product: DOC.productName,
  code: DOC.hsCode,
  unit: DOC.unit,
  quantity: DOC.quantity,
  places: DOC.places,
  netto: DOC.netWeight,
  brutto: DOC.grossWeight,
  price: DOC.price,
  amount: DOC.totalAmount,
};

const noteText = (note: unknown): string | null => {
  if (!note) return null;
  if (typeof note === 'string') return note;
  const texts = (note as { texts?: { text: string }[] }).texts;
  return texts ? texts.map((t) => t.text).join('') : JSON.stringify(note);
};
const formulaOf = (value: unknown): string | null =>
  value && typeof value === 'object' && 'formula' in value ? String((value as { formula: unknown }).formula) : null;

export async function readInvoiceSheet(buffer: Buffer | Uint8Array | ArrayBuffer | null): Promise<InvoiceSheet> {
  if (!buffer) throw new Error('no invoice file');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = wb.worksheets[0]!;
  let headRow = 0;
  for (let r = 1; r <= 40 && headRow === 0; r += 1) {
    const values = (sheet.getRow(r).values as unknown[]).map((v) => String(v ?? ''));
    if (values.includes(HEADERS.product) && values.includes(HEADERS.code)) headRow = r;
  }
  if (headRow === 0) throw new Error('the invoice has no header row');
  const head = (sheet.getRow(headRow).values as unknown[]).map((v) => String(v ?? ''));
  const cols = {} as InvoiceSheet['cols'];
  const letters = {} as InvoiceSheet['letters'];
  for (const key of Object.keys(HEADERS) as (keyof InvoiceSheet['cols'])[]) {
    const at = head.indexOf(HEADERS[key]);
    if (at < 1) throw new Error(`the invoice has no «${HEADERS[key]}» column`);
    cols[key] = at;
    letters[key] = sheet.getColumn(at).letter;
  }
  const rows: InvoiceSheetRow[] = [];
  let r = headRow + 1;
  for (; r < headRow + 2000; r += 1) {
    const row = sheet.getRow(r);
    if (typeof row.getCell(cols.no).value !== 'number') break;
    const marks = row.getCell(cols.marks);
    const rich = (marks.value as { richText?: { text: string; font?: { color?: { argb?: string } } }[] } | null)?.richText;
    const name = row.getCell(cols.product);
    rows.push({
      row: r,
      no: Number(row.getCell(cols.no).value),
      marks: marks.text,
      redMarks: (rich ?? []).filter((run) => run.font?.color?.argb === 'FFC00000').map((run) => run.text),
      product: String(name.value),
      code: String(row.getCell(cols.code).value ?? ''),
      unit: String(row.getCell(cols.unit).value),
      quantity: Number(row.getCell(cols.quantity).value),
      places: row.getCell(cols.places).value,
      netto: Number(row.getCell(cols.netto).value),
      brutto: Number(row.getCell(cols.brutto).value),
      note: noteText(name.note),
      quantityNote: noteText(row.getCell(cols.quantity).note),
      filled: name.fill?.type === 'pattern' && name.fill.pattern === 'solid',
      amount: formulaOf(row.getCell(cols.amount).value),
    });
  }
  const totals: InvoiceSheet['totals'] = {};
  for (const key of Object.keys(HEADERS) as (keyof InvoiceSheet['cols'])[]) {
    const formula = formulaOf(sheet.getRow(r).getCell(cols[key]).value);
    if (formula) totals[key] = formula;
  }
  return { rows, cols, letters, headRow, totals, sheet };
}
