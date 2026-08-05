import ExcelJS from 'exceljs';
import { reportLabels } from '../reports/labels';
import { listExpenses } from './service';
import { paymentsRegister } from '../finance/service';
import { toUzs, uzsRate } from './period';
import {
  arAging,
  cashFlow,
  profitAndLoss,
  profitByBatch,
  profitByClient,
  profitByRoute,
} from './reports';

/**
 * Accounting exports (owner: "otchetlarni excelda skachat qiladgan bolsin").
 *
 * Same queries as the screens, so a downloaded file and the page it came from
 * can never disagree. Headers follow the reader's language, like the other
 * §13 reports — these are internal management files, not customs papers.
 *
 * Sheet names stay slash-free ASCII on purpose: Excel rejects \ / ? * [ ] : in
 * a tab name, and a bilingual label with a slash once made every manifest
 * download fail with a 500.
 */

function sheetSetup(workbook: ExcelJS.Workbook, name: string, title: string) {
  const sheet = workbook.addWorksheet(name);
  sheet.addRow([title]);
  sheet.getRow(1).font = { bold: true, size: 13, name: 'Arial' };
  sheet.addRow([]);
  return sheet;
}

const period = (from: string, to: string) => `${from} … ${to}`;

export async function buildPnlXlsx(from: string, to: string, locale?: string): Promise<Buffer> {
  const L = reportLabels(locale);
  const [pnl, rate] = await Promise.all([profitAndLoss(from, to), uzsRate()]);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(workbook, 'P&L', `${L.tPnl} · ${period(from, to)}`);

  const head = sheet.addRow([L.category, ...pnl.months, `${L.total} $`, 'UZS']);
  head.font = { bold: true };
  sheet.columns = [
    { width: 34 },
    ...pnl.months.map(() => ({ width: 14 })),
    { width: 16 },
    { width: 18 },
  ];

  const line = (label: string, byPeriod: Record<string, number>, total: number, bold = false) => {
    const row = sheet.addRow([
      label,
      ...pnl.months.map((month) => byPeriod[month] ?? 0),
      total,
      toUzs(total, rate) ?? '',
    ]);
    if (bold) row.font = { bold: true };
    return row;
  };

  line(L.revenue, pnl.revenue.byPeriod, pnl.revenue.total, true);
  for (const row of pnl.directCosts) line(`— ${row.label}`, row.byPeriod, row.total);
  line(L.directCosts, pnl.directTotal.byPeriod, pnl.directTotal.total, true);
  line(L.grossProfit, pnl.grossProfit.byPeriod, pnl.grossProfit.total, true);
  sheet.addRow([
    L.margin,
    ...pnl.months.map((month) => pnl.grossMarginPct[month] ?? 0),
    pnl.grossMarginPct.total ?? 0,
    '',
  ]);
  for (const row of pnl.opex) line(`— ${row.label}`, row.byPeriod, row.total);
  line(L.opex, pnl.opexTotal.byPeriod, pnl.opexTotal.total, true);
  line(L.netProfit, pnl.netProfit.byPeriod, pnl.netProfit.total, true);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildCashFlowXlsx(from: string, to: string, locale?: string): Promise<Buffer> {
  const L = reportLabels(locale);
  const flow = await cashFlow(from, to);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(workbook, 'Cash flow', `${L.tCashFlow} · ${period(from, to)}`);

  const head = sheet.addRow([L.category, `${L.amount} $`]);
  head.font = { bold: true };
  sheet.columns = [{ width: 34 }, { width: 16 }];

  // The SAME list the cash-flow screen translates — a label the screen knows
  // and the file prints raw is the screen and its download disagreeing.
  const name = (label: string) =>
    label === 'clientPayments'
      ? L.clientPayments
      : label === 'cargoCosts'
        ? L.cargoCosts
        : label === 'partnerIn'
          ? L.partnerIn
          : label === 'partnerOut'
            ? L.partnerOut
            : label;
  for (const row of flow.rows) {
    sheet.addRow([name(row.label), row.kind === 'in' ? row.amountUsd : -row.amountUsd]);
  }
  const total = sheet.addRow([L.netFlow, flow.net]);
  total.font = { bold: true };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildReceivablesXlsx(asOf: string, locale?: string): Promise<Buffer> {
  const L = reportLabels(locale);
  const rows = await arAging(asOf);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(workbook, 'Receivables', `${L.tReceivables} · ${asOf}`);

  const head = sheet.addRow([L.client, L.name, `${L.debt} $`, L.days0, L.days30, L.days60, L.days90]);
  head.font = { bold: true };
  sheet.columns = [
    { width: 12 }, { width: 32 }, { width: 14 },
    { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 },
  ];
  for (const row of rows) {
    sheet.addRow([row.clientCode, row.clientName, row.balance, ...row.buckets]);
  }
  const total = sheet.addRow([
    L.total,
    '',
    Math.round(rows.reduce((acc, row) => acc + row.balance, 0) * 100) / 100,
    ...[0, 1, 2, 3].map(
      (index) =>
        Math.round(rows.reduce((acc, row) => acc + (row.buckets[index] ?? 0), 0) * 100) / 100,
    ),
  ]);
  total.font = { bold: true };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildProfitXlsx(
  view: 'batch' | 'client' | 'route',
  from: string,
  to: string,
  locale?: string,
): Promise<Buffer> {
  const L = reportLabels(locale);
  const workbook = new ExcelJS.Workbook();
  const title = view === 'batch' ? L.tProfitBatch : view === 'client' ? L.tProfitClient : L.tProfitRoute;
  const sheet = sheetSetup(workbook, 'Profit', `${title} · ${period(from, to)}`);

  if (view === 'batch') {
    const rows = await profitByBatch(from, to);
    const head = sheet.addRow([
      L.batch, L.route, L.departed, L.boxes, L.kg, L.m3,
      `${L.revenue} $`, `${L.cost} $`, `${L.profit} $`, L.margin, L.usdPerKg,
    ]);
    head.font = { bold: true };
    sheet.columns = [
      { width: 14 }, { width: 14 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 10 },
      { width: 14 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 10 },
    ];
    for (const row of rows) {
      sheet.addRow([
        row.code,
        row.route,
        row.departedAt ? row.departedAt.toISOString().slice(0, 10) : '',
        row.boxCount, row.kg, row.m3,
        row.revenueUsd, row.costUsd, row.profitUsd, row.marginPct, row.profitPerKg,
      ]);
    }
  } else if (view === 'client') {
    const rows = await profitByClient(from, to);
    const head = sheet.addRow([
      L.client, L.name, `${L.revenue} $`, `${L.cost} $`, `${L.profit} $`, L.margin,
    ]);
    head.font = { bold: true };
    sheet.columns = [
      { width: 12 }, { width: 32 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 10 },
    ];
    for (const row of rows) {
      sheet.addRow([
        row.clientCode, row.clientName, row.revenueUsd, row.costUsd, row.profitUsd, row.marginPct,
      ]);
    }
  } else {
    const rows = await profitByRoute(from, to);
    const head = sheet.addRow([
      L.route, L.batches, L.boxes, L.kg,
      `${L.revenue} $`, `${L.cost} $`, `${L.profit} $`, L.margin, L.usdPerKg,
    ]);
    head.font = { bold: true };
    sheet.columns = [
      { width: 16 }, { width: 10 }, { width: 10 }, { width: 12 },
      { width: 14 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 10 },
    ];
    for (const row of rows) {
      sheet.addRow([
        row.route, row.batches, row.boxCount, row.kg,
        row.revenueUsd, row.costUsd, row.profitUsd, row.marginPct, row.profitPerKg,
      ]);
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildExpensesXlsx(
  from: string,
  to: string,
  categoryId: string | undefined,
  locale?: string,
): Promise<Buffer> {
  const L = reportLabels(locale);
  const rows = await listExpenses({ from, to, categoryId, limit: 5000 });
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(workbook, 'Expenses', `${L.tExpenses} · ${period(from, to)}`);

  const head = sheet.addRow([
    L.date, L.category, L.amount, L.currency, 'USD', L.account, L.warehouse, L.employee, L.note,
  ]);
  head.font = { bold: true };
  sheet.columns = [
    { width: 12 }, { width: 26 }, { width: 14 }, { width: 10 }, { width: 14 },
    { width: 20 }, { width: 10 }, { width: 22 }, { width: 40 },
  ];
  for (const { expense, categoryName, warehouseCode, employeeName, accountName } of rows) {
    sheet.addRow([
      expense.expenseDate,
      categoryName,
      Number(expense.amount),
      expense.currency,
      Number(expense.amountUsd),
      accountName ?? '',
      warehouseCode ?? '',
      employeeName ?? '',
      expense.note ?? '',
    ]);
  }
  const total = sheet.addRow([
    L.total, '', '', '',
    Math.round(rows.reduce((acc, row) => acc + Number(row.expense.amountUsd), 0) * 100) / 100,
  ]);
  total.font = { bold: true };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * The payments register (round 29): every incoming payment of the period,
 * row for row — the file the accountant used to keep by hand.
 */
export async function buildPaymentsXlsx(from: string, to: string, locale?: string): Promise<Buffer> {
  const L = reportLabels(locale);
  const { rows, totalUsd, count, truncated } = await paymentsRegister(from, to);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(workbook, 'Payments', `${L.clientPayments} · ${period(from, to)}`);

  const head = sheet.addRow([
    L.date, L.client, '', L.amount, L.currency, 'USD', L.account, L.employee, L.note,
  ]);
  head.font = { bold: true };
  sheet.columns = [
    { width: 12 }, { width: 12 }, { width: 26 }, { width: 14 }, { width: 10 },
    { width: 14 }, { width: 20 }, { width: 22 }, { width: 40 },
  ];
  for (const row of rows) {
    sheet.addRow([
      row.txDate,
      row.clientCode,
      row.clientName,
      Number(row.amount),
      row.currency,
      Number(row.amountUsd),
      // The reestr screen's own rule: a settlement paid through a partner's
      // account is NOT the same fact as an unplaced payment, and the file the
      // accountant reconciles the tills against must not blur them.
      row.accountName ?? (row.partnerName ? `→ ${row.partnerName}` : ''),
      row.enteredBy ?? '',
      row.note ?? '',
    ]);
  }
  const total = sheet.addRow([L.total, '', '', '', '', totalUsd]);
  total.font = { bold: true };
  // No silent caps: the rows above are the newest 2000, the total the whole
  // period — the file must say so or a clipped list reads as complete.
  if (truncated) {
    const warn = sheet.addRow([`⚠ ${rows.length} / ${count}`]);
    warn.font = { bold: true };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
