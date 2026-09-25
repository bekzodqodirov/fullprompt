import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The money reports' audit fixes (2026-09-25) that live on a PAGE or in a
 * FILE — a page calls `getActor` and cannot be rendered by an integration
 * test, so the service halves are proven in cash-reports / cost-kassa /
 * upsale / internal-leg integration tests and the wiring is pinned here
 * (#531). Comments are stripped first, or a fence matches the sentence
 * explaining itself (#725).
 */
const read = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const CASHFLOW_PAGE = 'src/app/(protected)/accounting/cashflow/page.tsx';
const BALANCE_PAGE = 'src/app/(protected)/accounting/balance/page.tsx';
const FINANCE_PAGE = 'src/app/(protected)/finance/page.tsx';
const XLSX = 'src/modules/wms/accounting/xlsx.ts';

describe('audit 2026-09-25 — what the reports say', () => {
  it('U23: the cash flow links the QUEUE\'s figure to the queue, and names the rest unlinked', () => {
    const page = read(CASHFLOW_PAGE);
    expect(page).toMatch(/flow\.cargoQueuedUsd > 0 && \(\s*<Link\s+href="\/accounting\/xarajat-kassa"/);
    expect(page).toContain("t('cargoKassaUnknown', { usd: usd(flow.cargoKassaUnknownUsd) })");
    expect(page).not.toContain('cargoUnplacedUsd');
  });

  it('U24: the cash flow page AND its file name the costs read as $0', () => {
    expect(read(CASHFLOW_PAGE)).toMatch(/flow\.unconverted\.count > 0 && \(/);
    const file = read(XLSX);
    const cashFile = file.slice(file.indexOf('export async function buildCashFlowXlsx'), file.indexOf('export async function buildReceivablesXlsx'));
    expect(cashFile).toContain('flow.unconverted.count > 0');
    expect(cashFile).toContain('L.unconvertedCosts');
  });

  it('U13: the page and its file print the period\'s kassa table from ONE read', () => {
    expect(read(CASHFLOW_PAGE)).toContain('cashReconciliation(from, to)');
    const file = read(XLSX);
    const cashFile = file.slice(file.indexOf('export async function buildCashFlowXlsx'), file.indexOf('export async function buildReceivablesXlsx'));
    expect(cashFile).toContain('await cashReconciliation(from, to)');
    expect(cashFile).toContain('recon.kassas');
    expect(cashFile).toContain('recon.lines');
  });

  it('U13: the hub lists a retired till holding money, by the Balans\'s own predicate', () => {
    const hub = read('src/app/(protected)/accounting/page.tsx');
    expect(hub).toContain('.filter(countedAccount)');
    expect(hub).not.toMatch(/balances\s*\.filter\(\(row\) => row\.active\)/);
  });

  it('U14: the Balans and the kassa screen flag a till the net leaves out for want of a rate', () => {
    const balance = read(BALANCE_PAGE);
    expect(balance).toContain('const unrated = balance.unratedTills.length > 0;');
    expect(balance).toContain("t('balUnrated', { sums: unratedSums })");
    expect(read('src/app/(protected)/accounting/accounts/page.tsx')).toContain("t('noRateOutOfNet')");
    // The admin home asks the same list, not its own reading of the rows.
    expect(read('src/app/(protected)/admin-dashboard.tsx')).toContain('balance?.unratedTills.length');
  });

  it('U15: /finance prints the advances the Balans line links to, from the Balans\'s own arithmetic', () => {
    const page = read(FINANCE_PAGE);
    expect(page).toContain('clientTotals(rows)');
    expect(page).toContain('data-testid="finance-total-advances"');
  });

  it('U13 (answer A): the cash flow page and its file name the overheads that left no drawer', () => {
    expect(read(CASHFLOW_PAGE)).toMatch(/flow\.cashOpexNoKassaCount > 0 && \(/);
    expect(read(XLSX)).toContain('flow.cashOpexNoKassaCount > 0');
  });

  it('U14 (answer a): a till below zero is marked on the Balans, the kassa screens and the hub', () => {
    expect(read(BALANCE_PAGE)).toContain('balance.negativeTills.length > 0');
    for (const page of [BALANCE_PAGE, 'src/app/(protected)/accounting/accounts/page.tsx', 'src/app/(protected)/accounting/page.tsx']) {
      expect(read(page), page).toContain("t('tillNegative')");
    }
    expect(read('src/app/(protected)/dashboard/sections/attention.tsx')).toContain('balance.negativeTills.length');
  });

  it('U26 (answer A): the homes print the net with its parts, and the register row the register\'s own figure', () => {
    const home = read('src/app/(protected)/page.tsx');
    expect(home).toContain("td('monthPaidNet')");
    expect(home).toContain("td('monthPaidParts', {");
    expect(home).toContain('flow.snapshot.paidParts.toTill + flow.snapshot.paidParts.viaPartner');
    expect(home).not.toContain("td('monthPaid')");
    expect(read('src/app/(protected)/admin-dashboard.tsx')).toContain("td('monthPaidParts', {");
    // One home for the month's client money (#513).
    expect(read('src/modules/wms/reports/overview.ts')).toContain('await clientMoneyInPeriod(monthStart, today)');
  });

  it('U22: the P&L and profit files carry the screen\'s warnings', () => {
    const file = read(XLSX);
    const pnl = file.slice(file.indexOf('export async function buildPnlXlsx'), file.indexOf('export async function buildCashFlowXlsx'));
    expect(pnl).toContain('pnlGaps(from, to)');
    expect(pnl).toContain('gapRows(sheet, L, gaps)');
    const profit = file.slice(file.indexOf('export async function buildProfitXlsx'), file.indexOf('export async function buildExpensesXlsx'));
    expect(profit).toContain('pnlGaps(from, to)');
    expect(profit).toContain('unbatchedMoney(from, to)');
    expect(profit).toContain('tripTotals(rows)');
    expect(profit).toContain('gapRows(sheet, L, gaps)');
  });
});

describe('owner 6a — the P&L page carries the losses beside its table', () => {
  it('the page and its file both read lossesInPeriod; the page renders the note after the table', () => {
    const page = read('src/app/(protected)/accounting/pnl/page.tsx');
    expect(page).toContain('lossesInPeriod(from, to),');
    const table = page.indexOf('</table>');
    const note = page.indexOf('<PnlLossesNote losses={losses} />');
    expect(note).toBeGreaterThan(table);
    // Information, never a row: the table's body must not name it.
    expect(page.slice(page.indexOf('<tbody>'), table)).not.toContain('losses');
    const file = read('src/modules/wms/accounting/xlsx.ts');
    expect(file).toContain('lossesInPeriod(from, to),');
  });
});
