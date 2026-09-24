import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apportion, sameMoney } from '@/modules/wms/accounting/cost-merge';

/**
 * The kassa package's doors (0101) — the halves an integration test cannot
 * press because they call `authorize` (#531). Comments are stripped first,
 * or a fence matches the sentence explaining itself (#725).
 */
const read = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const slice = (text: string, from: string, to?: string) => {
  const start = text.indexOf(from);
  expect(start, `${from} not found`).toBeGreaterThanOrEqual(0);
  const end = to ? text.indexOf(to, start + from.length) : text.length;
  return text.slice(start, end < 0 ? text.length : end);
};

describe('the cost doors ask the kassa rules after their own grant', () => {
  const actions = read('src/app/(protected)/costs/actions.ts');

  it('the payer rules: a kassa is the kassa holders\' and a staff account is not picked on a form', () => {
    const rule = slice(actions, 'async function payerRefusal', 'export async function addCostEntryAction');
    expect(rule).toContain("if (input.accountId && !mayPickTill(permissions)) return 'till_forbidden';");
    expect(rule).toMatch(/!maySeeStaffMoney\(permissions\) && \(await isStaffPartner\(input\.partnerId\)\)/);
  });

  it('the single form and the grid both ask it before the service writes', () => {
    for (const door of ['export async function addCostEntryAction', 'export async function saveReceiptCostGridAction']) {
      const body = slice(actions, door, 'export async function');
      const asked = body.indexOf('await payerRefusal(parsed.data, actor.permissions)');
      expect(asked, door).toBeGreaterThan(body.indexOf('authorize('));
      expect(asked, door).toBeLessThan(body.search(/await (addCostEntry|addReceiptCostsBulk)\(/));
    }
  });

  it('voiding a kassa-paid cost is a cash movement: the kassa holders only', () => {
    const body = slice(actions, 'export async function voidCostEntryAction', 'async function voidReceiptCostDoor');
    const gate = body.indexOf("if (entry.accountId && !mayPickTill(actor.permissions))");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(body.indexOf('await voidCostEntry('));
  });

  it('placing, the staff answer and the merge are behind the same predicate', () => {
    const place = slice(actions, 'export async function setCostAccountAction');
    expect(place).toContain("authorize('finance.expenses')");
    expect(place).toContain('if (!mayPickTill(actor.permissions))');
    const queue = read('src/app/(protected)/accounting/xarajat-kassa/actions.ts');
    expect(queue).toMatch(/async function door\(\)[\s\S]*authorize\('finance\.expenses'\)[\s\S]*mayPickTill\(actor\.permissions\)/);
    expect(queue.match(/actor = await door\(\);/g)?.length).toBe(2);
  });

  it('the annul refuses a kassa-paid cost instead of crediting the till, and its sweep leaves one', () => {
    const annul = read('src/modules/wms/receipts/annul.ts');
    expect(annul).toContain("throw new AnnulError('cost_paid_from_till')");
    expect(annul).toMatch(/for \(const entry of candidates\) \{\s*if \(entry\.accountId\) continue;/);
  });
});

describe('the owner\'s M4a rule for «the same money»', () => {
  const expense = { amount: 100, currency: 'USD', amountUsd: 100, expenseDate: '2026-09-10' };
  const cost = (amount: number, currency = 'USD', amountUsd: number | null = amount, costDate = '2026-09-09') => ({
    id: `c${amount}`,
    amount,
    currency,
    amountUsd,
    costDate,
  });

  it('same currency: to the cent, and the costs may be several', () => {
    expect(sameMoney([cost(100)], expense)).toBeNull();
    expect(sameMoney([cost(60), cost(40)], expense)).toBeNull();
    expect(sameMoney([cost(100.01)], expense)).toBe('amount_differs');
  });

  it('different currencies: within 2 % or $5, whichever is looser', () => {
    const cny = (usd: number) => cost(usd * 7, 'CNY', usd);
    expect(sameMoney([cny(104.9)], expense)).toBeNull(); // $4.90 < $5
    expect(sameMoney([cny(105.1)], expense)).toBe('amount_differs');
    const big = { amount: 1000, currency: 'USD', amountUsd: 1000, expenseDate: '2026-09-10' };
    expect(sameMoney([cny(1019)], big)).toBeNull(); // 1.9 %
    expect(sameMoney([cny(1021)], big)).toBe('amount_differs');
    expect(sameMoney([cost(10, 'CNY', null)], expense)).toBe('no_rate');
  });

  it('within 14 days of every cost', () => {
    expect(sameMoney([cost(100, 'USD', 100, '2026-08-27')], expense)).toBeNull();
    expect(sameMoney([cost(100, 'USD', 100, '2026-08-26')], expense)).toBe('too_far_apart');
  });

  it('the kassa side adds up to the expense to the cent, however it is split', () => {
    const uzs = { amount: 1_234_567.89, currency: 'UZS', amountUsd: 100, expenseDate: '2026-09-10' };
    const shares = apportion([cost(33.33), cost(33.33), cost(33.34)], uzs);
    expect(Math.round(shares.reduce((a, b) => a + b, 0) * 100) / 100).toBe(1_234_567.89);
    expect(shares.every((share) => share > 0)).toBe(true);
    expect(apportion([cost(60), cost(40)], expense)).toEqual([60, 40]);
  });
});
