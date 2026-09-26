import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

  it('voiding a cost a colleague paid is staff money: the accountant and the admin only (U34)', () => {
    const body = slice(actions, 'export async function voidCostEntryAction', 'async function voidReceiptCostDoor');
    const gate = body.indexOf(
      "if (entry.partnerId && !maySeeStaffMoney(actor.permissions) && (await isStaffPartner(entry.partnerId))) {",
    );
    expect(gate).toBeGreaterThan(body.indexOf('authorize('));
    expect(gate).toBeLessThan(body.indexOf('await voidCostEntry('));
    expect(body).toContain("return { ok: false, error: 'staff_cost_needs_finance' };");
    // The panel says it in words (a literal in its map, #163).
    const panel = read('src/components/cost-panel.tsx');
    expect(panel).toContain("staff_cost_needs_finance: 'errStaffVoid',");
  });

  it('a FIRM-paid cost: its typist until the firm\u2019s account moves, then the kassa holders (U34, owner B)', () => {
    const body = slice(actions, 'export async function voidCostEntryAction', 'async function voidReceiptCostDoor');
    // The rule itself is `firmDebtVoidRefusal` (partners/service.ts), shared
    // with the counterparty card's ✕ and proven in money-doors.integration.
    const gate = body.indexOf('const refusal = await firmDebtVoidRefusal(actor, {');
    expect(gate).toBeGreaterThan(body.indexOf('authorize('));
    expect(gate).toBeLessThan(body.indexOf('await voidCostEntry('));
    const rule = body.slice(gate, body.indexOf('await voidCostEntry('));
    expect(rule).toContain('costEntryId: entry.id,');
    expect(rule).toContain('costEnteredBy: entry.enteredBy,');
    expect(rule).toContain('if (refusal) return { ok: false, error: refusal };');
    const panel = read('src/components/cost-panel.tsx');
    expect(panel).toContain("partner_cost_not_yours: 'errPartnerVoidNotYours',");
    expect(panel).toContain("partner_cost_settled: 'errPartnerVoidSettled',");
  });

  it('placing, the staff answer and the merge are behind the same predicate', () => {
    const place = slice(actions, 'export async function setCostAccountAction');
    expect(place).toContain("authorize('finance.expenses')");
    expect(place).toContain('if (!mayPickTill(actor.permissions))');
    const queue = read('src/app/(protected)/accounting/xarajat-kassa/actions.ts');
    expect(queue).toMatch(/async function door\(\)[\s\S]*authorize\('finance\.expenses'\)[\s\S]*mayPickTill\(actor\.permissions\)/);
    // Three doors since Q8: the staff answer, the merge, and the un-merge —
    // a deliberate update, the new door asks the same predicate.
    expect(queue.match(/actor = await door\(\);/g)?.length).toBe(3);
  });

  it('the annul refuses a kassa-paid cost instead of crediting the till, and its sweep leaves one', () => {
    const annul = read('src/modules/wms/receipts/annul.ts');
    expect(annul).toContain("throw new AnnulError('cost_paid_from_till')");
    // Q8: a merged cost is the only record of its money — the sweep leaves
    // it too (a deliberate update of this line, the kassa half unchanged).
    expect(annul).toMatch(/for \(const entry of candidates\) \{\s*if \(entry\.accountId \|\| entry\.mergedExpenseId\) continue;/);
  });
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'migrations' ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('a merged cost is the only record of its money until the merge is undone (Q8)', () => {
  const actions = read('src/app/(protected)/costs/actions.ts');

  it('ONE writer voids a cost, and its claim refuses a merged one — for every caller', () => {
    const hits: string[] = [];
    for (const path of files('src')) {
      const text = read(path);
      for (const m of text.matchAll(/\.update\(costEntries\)[\s\S]{0,120}?\bvoidedAt:/g)) {
        hits.push(path);
        const statement = text.slice(m.index!, text.indexOf('.returning(', m.index!));
        expect(statement, path).toContain('isNull(costEntries.mergedExpenseId)');
      }
    }
    expect(hits).toEqual(['src/modules/wms/costing/service.ts']);
  });

  it('the cost card answers a merged row in words that fit who pressed, BEFORE the kassa gate', () => {
    const body = slice(actions, 'export async function voidCostEntryAction', 'async function voidReceiptCostDoor');
    const merged = body.indexOf('if (entry.mergedExpenseId) {');
    expect(merged).toBeGreaterThan(body.indexOf('authorize('));
    expect(merged).toBeLessThan(body.indexOf('if (entry.accountId && !mayPickTill(actor.permissions))'));
    expect(body).toContain("error: mayPickTill(actor.permissions) ? 'merged_cost' : 'merged_cost_ask'");
    const panel = read('src/components/cost-panel.tsx');
    expect(panel).toContain("merged_cost: 'errMergedCost',");
    expect(panel).toContain("merged_cost_ask: 'errMergedCostAsk',");
    // The 🔗 and the ↩ — the ↩ only for the kassa holders the page names.
    expect(panel).toContain("{entry.mergedExpenseId && canUnmerge && <UnmergeButton expenseId={entry.mergedExpenseId} />}");
  });

  it('every cost card names the merge and says who may undo it', () => {
    for (const card of ['batches', 'receipts', 'crates', 'zavod']) {
      const page = read(`src/app/(protected)/${card}/[id]/page.tsx`);
      expect(page, card).toContain('mergedExpenseId: entry.mergedExpenseId');
      expect(page, card).toContain('canUnmerge={mayPickTill(actor.permissions)}');
    }
  });

  it("the queue's «Saqlash» is a claim under the queue's own predicate — it places, it never clears", () => {
    const place = slice(actions, 'export async function setCostAccountAction');
    expect(place).toContain('await placeCostAccount(');
    expect(place).not.toContain('await setCostAccount(');
    const schema = slice(actions, 'const placeSchema', '});');
    expect(schema).toContain('accountId: z.string().uuid(),');
    expect(schema).not.toContain('.nullable()');
    const service = read('src/modules/wms/costing/service.ts');
    const claim = slice(service, 'export async function placeCostAccount', '\n}\n');
    expect(claim).toContain('.where(and(eq(costEntries.id, costId), unplacedCostSql(since)))');
    expect(claim).toContain("throw new CostError('already_placed')");
  });

  it('the annul refuses a merged cost before anything is voided', () => {
    const annul = read('src/modules/wms/receipts/annul.ts');
    const merged = annul.indexOf("throw new AnnulError('cost_merged')");
    expect(merged).toBeGreaterThan(0);
    expect(merged).toBeLessThan(annul.indexOf("throw new AnnulError('cost_paid_from_till')"));
    for (const page of ['src/app/(protected)/receipts/[id]/page.tsx', 'src/app/(protected)/admin/anulirovka/page.tsx']) {
      expect(read(page), page).toMatch(/cost_merged: ta?\('mergedCost'\),/);
    }
  });

  it('voidExpense is a claim — a void racing a merge can never overwrite its stamp', () => {
    const service = read('src/modules/wms/accounting/service.ts');
    const body = slice(service, 'export async function voidExpense', 'export interface ExpenseFilters');
    const update = body.slice(body.indexOf('.update(expenses)'), body.indexOf('if (row.partnerId)'));
    expect(update).toContain('.where(and(eq(expenses.id, id), isNull(expenses.voidedAt)))');
    expect(update).toContain('.returning(');
    expect(update).toContain("if (!hit) throw new AccountingError('already_voided');");
  });

  it('the merge and the un-merge share ONE stamp', () => {
    const merge = read('src/modules/wms/accounting/cost-merge.ts');
    expect(merge).toContain('const reason = `${MERGE_VOID_PREFIX}xarajat(lar): ${costs.length} ta`;');
    const unmerge = slice(merge, 'export async function unmergeDuplicate', 'export async function recentMerges');
    expect(unmerge).toContain("if (!expense.voidReason?.startsWith(MERGE_VOID_PREFIX)) throw new MergeError('merge_changed');");
  });
});

describe('a cost merged into a kassa-less expense stays on the queue (U02)', () => {
  // The service half (it stays queued, the staff answer takes it) is proven
  // in cost-kassa.integration; the screen calls `getActor`, so its half —
  // no second merge offered, the row says what is left to answer — is here.
  it('the queue offers it no merge — only its kassa or the colleague', () => {
    expect(read('src/modules/wms/accounting/cost-queue.ts')).toContain('mergedExpenseId: costEntries.mergedExpenseId,');
    const page = read('src/app/(protected)/accounting/xarajat-kassa/page.tsx');
    expect(page).toContain('const merged = row.mergedExpenseId !== null;');
    expect(page).toMatch(/const twin = merged\s*\?\s*undefined\s*:\s*candidates\.find\(/);
    const rows = read('src/app/(protected)/accounting/xarajat-kassa/cost-queue.tsx');
    expect(rows).toMatch(/\{!row\.merged && \(\s*<input\s+type="checkbox"/);
    expect(rows).toContain("t('queueMergedNoKassa')");
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

  it('an expense an un-merge restored skips ONLY the day window — the money rule stays whole (Q8)', () => {
    const late = cost(100, 'USD', 100, '2026-10-20');
    expect(sameMoney([late], expense)).toBe('too_far_apart');
    expect(sameMoney([late], expense, { window: false })).toBeNull();
    expect(sameMoney([cost(100.01, 'USD', 100.01, '2026-10-20')], expense, { window: false })).toBe('amount_differs');
  });

  it('the kassa side adds up to the expense to the cent, however it is split', () => {
    const uzs = { amount: 1_234_567.89, currency: 'UZS', amountUsd: 100, expenseDate: '2026-09-10' };
    const shares = apportion([cost(33.33), cost(33.33), cost(33.34)], uzs);
    expect(Math.round(shares.reduce((a, b) => a + b, 0) * 100) / 100).toBe(1_234_567.89);
    expect(shares.every((share) => share > 0)).toBe(true);
    expect(apportion([cost(60), cost(40)], expense)).toEqual([60, 40]);
  });
});
