import ExcelJS from 'exceljs';
import { marginPct } from './margin';
import { eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { expenseCategories } from '../../platform/db/schema';
import { reportLabels } from '../reports/labels';
import { expenseTotals, listExpenses } from './service';
import { dayIn, OFFICE_TZ } from '@/modules/platform/time/tashkent';

/** How many expense rows a file carries before it says it is a slice. */
export const EXPENSES_XLSX_CAP = 5000;
import { paymentsRegister } from '../finance/service';
import { toUzs, uzsRate } from './period';
import { perUsd } from '../costing/fx-display';
import {
  arAging,
  cashReconciliation,
  clientProfitGaps,
  pnlGaps,
  profitAndLoss,
  profitByBatch,
  profitByClient,
  profitByRoute,
  unbatchedMoney,
  type FxPnlKey,
  type PnlGaps,
  type ReconLineKey,
} from './reports';
import { tripTotals } from '../reports/dashboard-math';
import { lossesInPeriod } from '../reports/business';

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

/** A figure somebody reads in a note, not a cell somebody sums. */
const usdText = (value: number) =>
  value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * What a period's report could not count, as ONE text cell per warning (audit
 * U22) — the rows `PnlGapsNote` prints above the P&L and the profit tables.
 * One cell and never a number beside it: the file is summed by hand, and a
 * figure in a note row is a figure somebody adds to the total.
 */
function gapRows(sheet: ExcelJS.Worksheet, L: ReturnType<typeof reportLabels>, gaps: PnlGaps) {
  if (gaps.manualCharges.count > 0) {
    sheet.addRow([
      `⚠ ${L.gapManualCharges}: ${gaps.manualCharges.count} · $${usdText(gaps.manualCharges.usd)}`,
    ]).font = { bold: true };
  }
  if (gaps.unconverted.count > 0) {
    sheet.addRow([
      `⚠ ${L.unconvertedCosts}: ${gaps.unconverted.byCurrency.map((row) => `${row.amount} ${row.currency}`).join(', ')}`,
    ]).font = { bold: true };
  }
  if (gaps.onNoBox.count > 0) {
    sheet.addRow([
      `⚠ ${L.gapNoBox}: ${gaps.onNoBox.count} · $${usdText(gaps.onNoBox.usd)}`,
    ]).font = { bold: true };
  }
  // The kurs farqi the report could not count (0103) — named, never added.
  if (gaps.unclassifiedAdjusts.count > 0) {
    sheet.addRow([
      `⚠ ${L.gapAdjustUnclassified}: ${gaps.unclassifiedAdjusts.count} · $${usdText(gaps.unclassifiedAdjusts.usd)}`,
    ]).font = { bold: true };
  }
  if (gaps.kassaUsdMissing.count > 0) {
    sheet.addRow([`⚠ ${L.gapKassaUsdMissing}: ${gaps.kassaUsdMissing.count}`]).font = { bold: true };
  }
  if (gaps.transferUsdMissing.count > 0) {
    sheet.addRow([`⚠ ${L.gapTransferUsdMissing}: ${gaps.transferUsdMissing.count}`]).font = { bold: true };
  }
}

/** The P&L's kurs farqi sub-rows by key (0103) — a literal map, so a new source is a type error. */
function fxLabel(L: ReturnType<typeof reportLabels>): Record<FxPnlKey, string> {
  return { 'fx:kassa': L.fxKassa, 'fx:settlement': L.fxSettlement, 'fx:adjust': L.fxAdjust, 'fx:closing': L.fxClosing };
}

export async function buildPnlXlsx(from: string, to: string, locale?: string): Promise<Buffer> {
  const L = reportLabels(locale);
  const [pnl, rate, gaps, losses] = await Promise.all([
    profitAndLoss(from, to),
    uzsRate(),
    pnlGaps(from, to),
    lossesInPeriod(from, to),
  ]);
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

  // Compensation for lost cargo (0105): gross − compensation = revenue, by
  // this file's own «— rows sum into the bold line that follows» (U22). With
  // no compensation the file is exactly as before.
  if (pnl.compensation.total !== 0) {
    line(`— ${L.grossCharges}`, pnl.grossCharges.byPeriod, pnl.grossCharges.total);
    line(
      `— ${L.compensation}`,
      Object.fromEntries(Object.entries(pnl.compensation.byPeriod).map(([month, usd]) => [month, -usd])),
      -pnl.compensation.total,
    );
  }
  line(L.revenue, pnl.revenue.byPeriod, pnl.revenue.total, true);
  for (const row of pnl.directCosts) line(`— ${row.label}`, row.byPeriod, row.total);
  line(L.directCosts, pnl.directTotal.byPeriod, pnl.directTotal.total, true);
  line(L.grossProfit, pnl.grossProfit.byPeriod, pnl.grossProfit.total, true);
  sheet.addRow([
    L.margin,
    // «—» over a month whose net revenue is not positive (0105, `marginPct`).
    ...pnl.months.map((month) => pnl.grossMarginPct[month] ?? '—'),
    pnl.grossMarginPct.total ?? '—',
    '',
  ]);
  for (const row of pnl.opex) line(`— ${row.label}`, row.byPeriod, row.total);
  line(L.opex, pnl.opexTotal.byPeriod, pnl.opexTotal.total, true);
  // «Kurs farqi» (0103): the screen's block, between the overheads and the
  // net it is part of.
  line(L.fxTotal, pnl.fxTotal.byPeriod, pnl.fxTotal.total, true);
  const fxLabels = fxLabel(L);
  for (const row of pnl.fx) line(`— ${fxLabels[row.key as FxPnlKey]}`, row.byPeriod, row.total);
  line(L.netProfit, pnl.netProfit.byPeriod, pnl.netProfit.total, true);

  // The screen's own notes, AFTER the net row (U22): the file used to carry
  // an unrated cost at $0 and leave a hand-typed partner debt out with no
  // word, while the page said both. And the UZS column names its rate.
  sheet.addRow([]);
  gapRows(sheet, L, gaps);
  // The page's «Yo'qotishlar» (owner 6a), one text cell each for the same
  // reason as the gaps: the dollars are already inside the costs above.
  if (losses.lost.boxes > 0) {
    sheet.addRow([`❌ ${L.lossesLost}: ${losses.lost.boxes} · ${losses.lost.m3} m³ · $${usdText(losses.lost.usd)}`]);
  }
  if (losses.missing.boxes > 0) {
    sheet.addRow([
      `⚠ ${L.lossesMissing}: ${losses.missing.boxes} · ${losses.missing.m3} m³ · $${usdText(losses.missing.usd)}`,
    ]);
  }
  if (losses.lost.boxes > 0 || losses.missing.boxes > 0) sheet.addRow([L.lossesInCosts]);
  // `rate` is dollars per ONE so'm (0.00008); printed raw the file said
  // «1 $ = 0.00008 UZS», inverted by five orders of magnitude.
  if (rate) sheet.addRow([`${L.uzsAtRate}: 1 $ = ${perUsd(rate)} UZS`]);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildCashFlowXlsx(from: string, to: string, locale?: string): Promise<Buffer> {
  const L = reportLabels(locale);
  // The page's own read (U13): the flow and the period's kassa table from
  // one call, so the file and the screen reconcile the same figures.
  const recon = await cashReconciliation(from, to);
  const flow = recon.flow;
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(workbook, 'Cash flow', `${L.tCashFlow} · ${period(from, to)}`);

  const head = sheet.addRow([L.category, `${L.amount} $`]);
  head.font = { bold: true };
  sheet.columns = [{ width: 44 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 18 }];

  // The SAME list the cash-flow screen translates — a label the screen knows
  // and the file prints raw is the screen and its download disagreeing.
  const KNOWN: Record<string, string> = {
    clientPayments: L.clientPayments,
    cargoCosts: L.cargoCosts,
    partnerIn: L.partnerIn,
    partnerOut: L.partnerOut,
    clientRefunds: L.clientRefunds,
    // 0103: the kurs farqi that moved a kassa, and kassa money paid for a
    // cost with no rate of its own.
    fxGain: L.fxGain,
    fxLoss: L.fxLoss,
    cargoUnrated: L.cargoUnrated,
  };
  // An overhead row's label is its category's own name.
  const name = (label: string) => KNOWN[label] ?? label;
  for (const row of flow.rows) {
    sheet.addRow([name(row.label), row.kind === 'in' ? row.amountUsd : -row.amountUsd]);
    if (row.label !== 'cargoCosts') continue;
    // The screen's three notes under the cargo row (U23, U24), as TEXT: each
    // is «of which», and a number in the amount column would be summed twice.
    if (flow.cargoQueuedUsd > 0) sheet.addRow([`   ⚠ ${L.cargoQueued}: $${usdText(flow.cargoQueuedUsd)}`]);
    if (flow.cargoKassaUnknownUsd > 0) {
      sheet.addRow([`   ${L.cargoKassaUnknown}: $${usdText(flow.cargoKassaUnknownUsd)}`]);
    }
    if (flow.unconverted.count > 0) {
      sheet.addRow([
        `   ⚠ ${L.unconvertedCosts}: ${flow.unconverted.byCurrency.map((entry) => `${entry.amount} ${entry.currency}`).join(', ')}`,
      ]).font = { bold: true };
    }
  }
  const total = sheet.addRow([L.netFlow, flow.net]);
  total.font = { bold: true };
  if (flow.cashOpexNoKassaCount > 0) {
    sheet.addRow([`⚠ ${L.cashOpexNoKassa}: ${flow.cashOpexNoKassaCount} · $${usdText(flow.cashOpexNoKassaUsd)}`]).font = {
      bold: true,
    };
  }

  // The kassas from the period's first day to its last — the block the page
  // prints under the flow (U13; #532d: the screen and its download agree).
  const LINE: Record<ReconLineKey, string> = {
    countedInPeriod: L.reconCountedInPeriod,
    noKassaPayments: L.reconNoKassaPayments,
    queuedCosts: L.reconQueuedCosts,
    historyCosts: L.reconHistoryCosts,
    noKassaExpenses: L.reconNoKassaExpenses,
    beforeOpening: L.reconBeforeOpening,
    tillOnly: L.reconTillOnly,
    oneSidedTransfers: L.reconOneSidedTransfers,
    unratedTills: L.reconUnratedTills,
    tillUnconverted: L.reconTillUnconverted,
    fx: L.reconFx,
  };
  sheet.addRow([]);
  sheet.addRow([L.reconTitle]).font = { bold: true };
  sheet.addRow([L.account, L.currency, L.reconOpen, L.inflow, L.outflow, L.reconClose]).font = { bold: true };
  for (const kassa of recon.kassas) {
    sheet.addRow([
      kassa.active ? kassa.name : `${kassa.name} (${L.retiredTill})`,
      kassa.currency,
      kassa.opening,
      kassa.inflow,
      -kassa.outflow,
      kassa.closing,
    ]);
  }
  sheet.addRow([]);
  sheet.addRow([L.reconOpeningUsd, recon.openingUsd]).font = { bold: true };
  sheet.addRow([L.netFlow, recon.netFlowUsd]);
  for (const line of recon.lines) sheet.addRow([LINE[line.key], line.usd]);
  if (Math.abs(recon.unexplained) > 0.004) {
    sheet.addRow([L.reconUnexplained, recon.unexplained]).font = { bold: true };
  }
  sheet.addRow([L.reconClosingUsd, recon.closingUsd]).font = { bold: true };
  if (recon.unratedTills.length > 0) {
    sheet.addRow([
      `⚠ ${L.reconUnratedTills}: ${recon.unratedTills.map((row) => `${row.closing} ${row.currency}`).join(', ')}`,
    ]);
  }
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

/**
 * The profit table as a file (audit U22): the page's rows AND its words.
 *
 * A Chinese internal leg's cost is already inside the cross-border truck's as
 * «shu reysgacha» (R2a), so it no longer sits in the «Xarajat $» column — a
 * hand SUM there counted it twice — but in a column of its own; the total row
 * is `tripTotals`, the page's own JAMI, so a correction to that rule moves
 * both. Kilograms and boxes are not totalled: the same box rides every leg.
 */
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
  // Exactly what the page fetches beside its rows.
  const [gaps, unbatched] = await Promise.all([
    pnlGaps(from, to),
    view === 'client' ? Promise.resolve(null) : unbatchedMoney(from, to),
  ]);
  // The one margin rule (0105): «—» over revenue that is not positive.
  const margin = (totals: { revenue: number; profit: number }) => marginPct(totals.profit, totals.revenue) ?? '—';
  const bold = (row: ExcelJS.Row) => {
    row.font = { bold: true };
  };
  const notes: string[] = [];

  if (view === 'batch') {
    const rows = await profitByBatch(from, to);
    const head = sheet.addRow([
      L.batch, L.route, L.departed, L.boxes, L.kg, L.m3,
      `${L.revenue} $`, L.noCargoCol, `${L.cost} $`, L.prevLegs, L.unallocated, L.internalCost,
      `${L.profit} $`, L.margin, L.usdPerKg,
    ]);
    head.font = { bold: true };
    sheet.columns = [
      { width: 14 }, { width: 14 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 10 },
      { width: 14 }, { width: 16 }, { width: 14 }, { width: 16 }, { width: 16 }, { width: 16 },
      { width: 14 }, { width: 10 }, { width: 10 },
    ];
    // An internal leg is a cost row (R2a): «—» where a profit would stand,
    // never a $0 that a SUM over the column would read as a real figure.
    for (const row of rows) {
      sheet.addRow([
        row.code,
        row.route,
        row.departedAt ? dayIn(row.departedAt, OFFICE_TZ) : '',
        row.boxCount, row.kg, row.m3,
        row.revenueUsd,
        // A PART of the revenue (0104) — blank, never 0, when there is none.
        row.noCargoChargeUsd > 0.009 ? row.noCargoChargeUsd : '',
        row.internal ? '—' : row.costUsd,
        row.internal ? '' : row.prevUsd,
        row.unallocatedUsd > 0.009 ? row.unallocatedUsd : '',
        row.internal ? row.costUsd : '',
        row.profitUsd ?? '—', row.marginPct ?? '—', row.profitPerKg ?? '—',
      ]);
    }
    if (rows.length > 0) {
      const totals = tripTotals(rows);
      bold(
        sheet.addRow([
          L.total, '', '', '', '', '', totals.revenue, totals.noCargo > 0.009 ? totals.noCargo : '',
          totals.cost, '', '', '', totals.profit, margin(totals), '',
        ]),
      );
    }
    if (rows.some((row) => row.internal)) notes.push(L.internalRowsNote);
    const noCargo = rows.filter((row) => !row.internal && row.noCargoChargeUsd > 0.009);
    if (noCargo.length > 0) {
      const sum = noCargo.reduce((acc, row) => acc + row.noCargoChargeUsd, 0);
      notes.push(`⚠ ${L.noCargoNote}: $${usdText(sum)} · ${noCargo.length}`);
    }
    const unallocated = rows.filter((row) => row.unallocatedUsd > 0.009);
    if (unallocated.length > 0) {
      const sum = unallocated.reduce((acc, row) => acc + row.unallocatedUsd, 0);
      notes.push(`⚠ ${L.unallocatedNote}: $${usdText(sum)} · ${unallocated.length}`);
    }
  } else if (view === 'client') {
    const [rows, clientGaps] = await Promise.all([profitByClient(from, to), clientProfitGaps(from, to)]);
    const head = sheet.addRow([
      L.client, L.name, `${L.revenue} $`, `${L.cost} $`, `${L.profit} $`, L.margin,
    ]);
    head.font = { bold: true };
    sheet.columns = [
      { width: 12 }, { width: 32 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 10 },
    ];
    for (const row of rows) {
      sheet.addRow([
        row.clientCode, row.clientName, row.revenueUsd, row.costUsd, row.profitUsd, row.marginPct ?? '—',
      ]);
    }
    // The screen's own two lines (U19), so the file reconciles to the P&L as
    // the tab does: unclaimed cargo is a row inside the JAMI (its cost
    // counts), money that reached no box is a NOTE under the table — text,
    // never a number a hand SUM of the cost column would reach into.
    const unclaimedUsd = clientGaps.unclaimed.usd > 0.009 ? clientGaps.unclaimed.usd : 0;
    if (unclaimedUsd > 0) {
      sheet.addRow([
        L.unclaimedCargo,
        `${L.receipts}: ${clientGaps.unclaimed.receipts}`,
        0,
        unclaimedUsd,
        -unclaimedUsd,
        '—',
      ]);
    }
    if (rows.length > 0 || unclaimedUsd > 0) {
      const totals = tripTotals(
        unclaimedUsd > 0 ? [...rows, { revenueUsd: 0, costUsd: unclaimedUsd, profitUsd: -unclaimedUsd }] : rows,
      );
      bold(sheet.addRow([L.total, '', totals.revenue, totals.cost, totals.profit, margin(totals)]));
    }
    if (clientGaps.unallocated.usd > 0.009) {
      const scopeWord: Record<string, string> = {
        batch: L.gapScopeBatch,
        pickup: L.gapScopePickup,
        receipt: L.gapScopeReceipt,
        crate: L.gapScopeCrate,
      };
      const scopes = clientGaps.unallocated.byScope
        .map((row) => `${scopeWord[row.scope] ?? row.scope} ×${row.count}`)
        .join(', ');
      notes.push(`⚠ ${L.clientUnallocatedNote}: $${usdText(clientGaps.unallocated.usd)} · ${scopes}`);
    }
  } else {
    const rows = await profitByRoute(from, to);
    const head = sheet.addRow([
      L.route, L.batches, L.boxes, L.kg,
      `${L.revenue} $`, L.noCargoCol, `${L.cost} $`, L.internalCost, `${L.profit} $`, L.margin, L.usdPerKg,
    ]);
    head.font = { bold: true };
    sheet.columns = [
      { width: 16 }, { width: 10 }, { width: 10 }, { width: 12 },
      { width: 14 }, { width: 16 }, { width: 14 }, { width: 16 }, { width: 14 }, { width: 10 }, { width: 10 },
    ];
    for (const row of rows) {
      sheet.addRow([
        row.route, row.batches, row.boxCount, row.kg,
        row.revenueUsd,
        row.noCargoChargeUsd > 0.009 ? row.noCargoChargeUsd : '',
        row.internal ? '—' : row.costUsd,
        row.internal ? row.costUsd : '',
        row.profitUsd ?? '—', row.marginPct ?? '—', row.profitPerKg ?? '—',
      ]);
    }
    if (rows.length > 0) {
      const totals = tripTotals(rows);
      bold(
        sheet.addRow([
          L.total, '', '', '', totals.revenue, totals.noCargo > 0.009 ? totals.noCargo : '',
          totals.cost, '', totals.profit, margin(totals), '',
        ]),
      );
    }
    if (rows.some((row) => row.internal)) notes.push(L.internalRowsNote);
  }

  if (unbatched && unbatched.revenueUsd > 0) notes.push(`${L.unbatchedNote}: $${usdText(unbatched.revenueUsd)}`);
  if (unbatched && unbatched.compensationUsd > 0.009) {
    notes.push(`${L.unbatchedCompensationNote}: $${usdText(unbatched.compensationUsd)}`);
  }
  // …and its cost half (U37): money on cargo that rode no priced truck, in the
  // screen's three parts — no truck row carries it, so the file names it.
  const noTruck = unbatched?.noTruckCost;
  if (noTruck && noTruck.lostUsd + noTruck.issuedUsd + noTruck.waitingUsd > 0.009) {
    notes.push(
      `${L.unbatchedCostNote}: ${L.noTruckLost} $${usdText(noTruck.lostUsd)} · ` +
        `${L.noTruckIssued} $${usdText(noTruck.issuedUsd)} · ${L.noTruckWaiting} $${usdText(noTruck.waitingUsd)}`,
    );
  }
  // The page's notes as TEXT rows under the table — never a number beside
  // them, or a hand SUM of a column reaches into a note.
  if (notes.length > 0 || gaps.manualCharges.count > 0 || gaps.unconverted.count > 0) sheet.addRow([]);
  for (const note of notes) sheet.addRow([note]);
  gapRows(sheet, L, gaps);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildExpensesXlsx(
  from: string,
  to: string,
  categoryId: string | undefined,
  locale?: string,
): Promise<Buffer> {
  const L = reportLabels(locale);
  const [rows, totals, category] = await Promise.all([
    listExpenses({ from, to, categoryId, limit: EXPENSES_XLSX_CAP }),
    expenseTotals({ from, to, categoryId }),
    categoryId
      ? db.query.expenseCategories.findFirst({ where: eq(expenseCategories.id, categoryId) })
      : Promise.resolve(undefined),
  ]);
  const workbook = new ExcelJS.Workbook();
  // A filtered file says what it is (audit A15): the same title for «all
  // categories» and «salaries only» is how one is read as the other.
  const title = [L.tExpenses, category?.name, period(from, to)].filter(Boolean).join(' · ');
  const sheet = sheetSetup(workbook, 'Expenses', title);

  const head = sheet.addRow([
    L.date, L.category, L.amount, L.currency, 'USD', L.account, L.warehouse, L.employee, L.note,
  ]);
  head.font = { bold: true };
  sheet.columns = [
    { width: 12 }, { width: 26 }, { width: 14 }, { width: 10 }, { width: 14 },
    { width: 20 }, { width: 10 }, { width: 22 }, { width: 40 },
  ];
  for (const { expense, categoryName, warehouseCode, employeeName, accountName, partnerName } of rows) {
    sheet.addRow([
      expense.expenseDate,
      categoryName,
      Number(expense.amount),
      expense.currency,
      Number(expense.amountUsd),
      // The screen's own rule (audit A17): «a firm paid it» and «nobody named
      // a till» are two facts, and the file reconciled against the tills must
      // not print both as one blank cell. The payments file learned it in #532.
      accountName ?? (partnerName ? `→ ${partnerName}` : ''),
      warehouseCode ?? '',
      employeeName ?? '',
      expense.note ?? '',
    ]);
  }
  // The whole period's total, not the rows' — and a clipped list says so
  // (audit A14; the payments file's shape).
  const total = sheet.addRow([L.total, '', '', '', totals.totalUsd]);
  total.font = { bold: true };
  if (totals.count > rows.length) {
    const warn = sheet.addRow([`⚠ ${rows.length} / ${totals.count}`]);
    warn.font = { bold: true };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * The payments register (round 29): every incoming payment of the period,
 * row for row — the file the accountant used to keep by hand.
 */
export async function buildPaymentsXlsx(
  from: string,
  to: string,
  locale?: string,
  /** The seller whose book this file is, or undefined for the whole company. */
  ownerId?: string,
): Promise<Buffer> {
  const L = reportLabels(locale);
  const { rows, totalUsd, count, truncated } = await paymentsRegister(from, to, ownerId);
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
