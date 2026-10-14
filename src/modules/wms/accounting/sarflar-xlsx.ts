import ExcelJS from 'exceljs';
import type { CompanyMoneySight } from '../finance/scope';
import type { CostSight } from '../costing/cost-sight';
import { tillView } from '../costing/cost-sight';
import { payerNameFor, REGISTER_XLSX_CAP, spendRegister, type SpendFilters, type SpendRow } from './sarflar';

/** The words the file prints, handed in by the route in the reader's language. */
export interface SpendXlsxLabels {
  title: string;
  date: string;
  book: string;
  type: string;
  amount: string;
  currency: string;
  where: string;
  warehouse: string;
  payer: string;
  author: string;
  bookCost: string;
  bookExpense: string;
  kassa: string;
  /** «{shown} of {total}» when the file is a slice. */
  sliced: (shown: number, total: number) => string;
  payerWord: (row: SpendRow) => string;
}

/**
 * The register as a file (§1.6, §8.4): the page's OWN reader over the page's
 * own validated filters — never `buildExpensesXlsx`'s row reader — capped at
 * 5000 rows with the uncapped total printed, because a file that silently
 * stops is read as the whole period. Every sight is REQUIRED: a file carrying
 * a row the screen hid is a leak with a filename (#490).
 */
export async function buildSpendXlsx(
  sight: CompanyMoneySight,
  period: { from: string; to: string },
  filters: SpendFilters,
  reader: { id: string; seesStaff: boolean; expenseRows: boolean; costs: CostSight; permissions: ReadonlySet<string> },
  labels: SpendXlsxLabels,
): Promise<Buffer> {
  const { rows, total } = await spendRegister(sight, period, filters, reader, { limit: REGISTER_XLSX_CAP, offset: 0 });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sarflar');
  sheet.addRow([`${labels.title} · ${period.from} … ${period.to}`]).font = { bold: true, size: 13 };
  if (total > rows.length) sheet.addRow([labels.sliced(rows.length, total)]).font = { italic: true };
  const head = sheet.addRow([
    labels.date,
    labels.book,
    labels.type,
    labels.amount,
    labels.currency,
    'USD',
    labels.where,
    labels.warehouse,
    labels.payer,
    labels.author,
  ]);
  head.font = { bold: true };
  sheet.columns = [
    { width: 12 },
    { width: 14 },
    { width: 24 },
    { width: 14 },
    { width: 9 },
    { width: 14 },
    { width: 18 },
    { width: 16 },
    { width: 24 },
    { width: 22 },
  ];
  for (const row of rows) {
    const till = row.book === 'cost' ? tillView(reader.permissions, row) : null;
    const kassaName = till?.paidFromTill ? (till.accountName ?? labels.kassa) : row.book === 'expense' ? row.accountName : null;
    sheet.addRow([
      row.day,
      row.book === 'cost' ? labels.bookCost : labels.bookExpense,
      row.typeName,
      Number(row.amount),
      row.currency,
      row.usd === null ? '' : Number(row.usd),
      row.batchCode ?? row.receiptNumber ?? row.crateCode ?? row.pickupCode ?? '',
      row.warehouseName ?? '',
      kassaName ?? payerNameFor(row, reader.seesStaff) ?? labels.payerWord(row),
      row.authorName ?? '',
    ]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
