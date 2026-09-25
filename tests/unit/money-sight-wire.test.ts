import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Q19's DOORS (owner, 2026-09-25: «ved hodimi kassa foyda zararni umuman
 * ko'rmasin, tannarxni ham») — the halves that call `getActor`/`authorize` and
 * so cannot be pressed by an integration test (#531). The predicates
 * themselves are behavioural in money-sight.test.ts and cost-sight.test.ts;
 * this file pins that each screen, file and action ASKS them, one `it` per
 * group, each naming its file. Comments are stripped first, or a fence
 * matches the sentence explaining itself (#725).
 */
const read = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const slice = (text: string, from: string, to?: string) => {
  const start = text.indexOf(from);
  expect(start, `${from} not found`).toBeGreaterThanOrEqual(0);
  const end = to ? text.indexOf(to, start + from.length) : text.length;
  return text.slice(start, end < 0 ? text.length : end);
};

describe('1 — results: the price-only pricing page, its door, the box card', () => {
  it('«Partiya moliyasi» decides its sight BEFORE the reads, and never READS the tannarx for a price-only reader', () => {
    const page = read('src/app/(protected)/batches/[id]/pricing/page.tsx');
    const sight = page.indexOf('pricingSight(actor.permissions, internal)');
    expect(sight).toBeGreaterThan(0);
    expect(sight).toBeLessThan(page.indexOf('Promise.all('));
    expect(page).toContain("if (sight === 'none') redirect(");
    for (const read of [
      'full ? batchLandedCostByLot(id)',
      'full ? batchClientCostBreakdown(id)',
      'full ? unconvertedCostCount(id, receiptIds)',
      'full ? batchCostEntryCount(id)',
    ]) {
      expect(page, read).toContain(read);
    }
    // The cost cells are drawn only for the full sight.
    expect(page).toMatch(/\{full && \(\s*<div className="shrink-0 text-right">\s*<p className="num text-sm font-bold" data-testid="lot-cost">/);
    expect(page).toMatch(/\{full && \(\s*<div>\s*<p className="text-xs uppercase tracking-wide text-ink-500">\{t\('costLabel'\)\}<\/p>\s*<p className="num text-lg font-extrabold" data-testid="pricing-total-cost">/);
    expect(page).toMatch(/\{full && \(\s*<div>\s*<p className="text-xs text-ink-500">\{t\('costLabel'\)\}<\/p>\s*<p className="num font-bold" data-testid="client-cost">/);
  });

  it('the batch card door asks the same sight (no door that bounces)', () => {
    const card = read('src/app/(protected)/batches/[id]/page.tsx');
    expect(card).toContain("pricingSight(actor.permissions, internal) !== 'none'");
    expect(card).not.toMatch(/actor\.permissions\.has\('finance\.manage'\) && \(\s*<Link\s*href=\{`\/batches\/\$\{batch\.id\}\/pricing`\}/);
  });

  it('the box card never reads the landed cost for the VED', () => {
    const box = read('src/app/(protected)/boxes/[id]/page.tsx');
    const gate = slice(box, 'const canSeeCosts', 'const landed');
    expect(gate).toContain("!moneyHidden('results', actor.permissions)");
    expect(box).toContain('const landed = canSeeCosts ? await boxLandedCost(box.id) : null;');
  });
});

describe('2 — results: the reports', () => {
  it('the hub offers no «Tannarx» tile and the page refuses (reports/page.tsx, reports/landed-cost/page.tsx)', () => {
    expect(read('src/app/(protected)/reports/page.tsx')).toMatch(
      /allWh && !moneyHidden\('results', actor\.permissions\)\s*\?\s*\[\{ href: '\/reports\/landed-cost'/,
    );
    expect(read('src/app/(protected)/reports/landed-cost/page.tsx')).toMatch(
      /!actor\.permissions\.has\('reports\.all_warehouses'\) \|\| moneyHidden\('results', actor\.permissions\)/,
    );
  });

  it('the file route refuses the landed-cost file BEFORE building it, and strips the register’s cost columns (api/reports/[kind]/route.ts)', () => {
    const route = read('src/app/api/reports/[kind]/route.ts');
    const refusal = route.indexOf("kind.data === 'landed-cost' && moneyHidden('results', actor.permissions)");
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(route.indexOf('buildLandedCostXlsx('));
    expect(route).toContain("buildBatchRegisterXlsx(scope, locale, { costs: !moneyHidden('results', actor.permissions) })");
  });

  it('the register screen decides its cost column BEFORE sorting (reports/batches/page.tsx)', () => {
    const page = read('src/app/(protected)/reports/batches/page.tsx');
    const decided = page.indexOf("const showCosts = allWh && !moneyHidden('results', actor.permissions);");
    expect(decided).toBeGreaterThan(0);
    expect(decided).toBeLessThan(page.indexOf('sortRows('));
    expect(page).toContain('showCosts ? SORTABLE : SORTABLE_NO_COST');
  });
});

describe('3 — kassa: /finance, the register, the ledger and its doors', () => {
  it('/finance offers the register only to a reader the kassa is not hidden from (finance/page.tsx)', () => {
    expect(read('src/app/(protected)/finance/page.tsx')).toMatch(
      /moneyHidden\('kassa', actor\.permissions\) \? undefined : \(\s*<Link href="\/finance\/reestr"/,
    );
  });

  it('the register refuses the VED and places only for the kassa holders (finance/reestr/page.tsx)', () => {
    const page = read('src/app/(protected)/finance/reestr/page.tsx');
    expect(page).toMatch(/\|\|\s*moneyHidden\('kassa', actor\.permissions\)\s*\)\s*\{\s*redirect\('\/'\)/);
    expect(page).toContain('const canPlace = mayPickTill(actor.permissions);');
  });

  it('the payments file refuses the VED too (api/accounting/[kind]/route.ts)', () => {
    const route = read('src/app/api/accounting/[kind]/route.ts');
    const payments = slice(route, "if (kind.data === 'payments') {", '} else {');
    expect(payments).toContain("moneyHidden('kassa', actor.permissions)");
  });

  it('the add door asks WHO before any kassa refusal, and refuses a kassa posted by a non-holder (finance/actions.ts)', () => {
    const action = read('src/app/(protected)/finance/actions.ts');
    const body = slice(action, 'export async function addTransactionAction', 'const voidSchema');
    const who = body.indexOf("authorize('finance.manage')");
    expect(who).toBeGreaterThan(0);
    expect(who).toBeLessThan(body.indexOf("'account_required'"));
    expect(who).toBeLessThan(body.indexOf("if (!mayPickTill(actor.permissions) && parsed.data.accountId) return { error: 'forbidden' };"));
  });

  it('placing a payment is the kassa holders’ act, asked after the grant and before the write', () => {
    const body = slice(read('src/app/(protected)/finance/actions.ts'), 'export async function placePaymentAction');
    const gate = body.indexOf('if (!mayPickTill(actor.permissions)) return;');
    expect(gate).toBeGreaterThan(body.indexOf("authorize('finance.manage')"));
    expect(gate).toBeLessThan(body.indexOf('await placePayment('));
  });

  it('the void door answers its refusal instead of swallowing it, and the ✖ says it in words', () => {
    const body = slice(
      read('src/app/(protected)/finance/actions.ts'),
      'export async function voidTransactionAction',
      'export async function placePaymentAction',
    );
    expect(body).toContain('Promise<TxFormState>');
    expect(body).toContain('if (err instanceof FinanceError) return { error: err.code };');
    const button = read('src/app/(protected)/finance/[clientId]/void-button.tsx');
    // 0105: a second refusal (`compensation_paid_out`) joined the first, so
    // the words are a literal map now (#163) — both codes, both keys.
    expect(button).toContain("forbidden: 'voidNeedsAccountant',");
    expect(button).toContain("compensation_paid_out: 'compensationPaidOut',");
    expect(button).toContain('if (res.error) setError(voidErrorText(res.error, t, tc));');
    expect(button).toContain('role="alert"');
  });

  it('the form draws the drawers only for their holders, and says who names them to everybody else (tx-form.tsx)', () => {
    const form = read('src/app/(protected)/finance/[clientId]/tx-form.tsx');
    expect(form).toMatch(/\{canPickTill && type !== 'charge' && \(\s*<select\s*name="accountId"/);
    expect(form).toMatch(/\{!canPickTill && type === 'payment' && \(\s*<p className="text-xs text-ink-500" data-testid="tx-no-till">/);
    expect(form).toContain("state.error === 'forbidden'");
    const page = read('src/app/(protected)/finance/[clientId]/page.tsx');
    expect(page).toContain('canRefund ? listAccounts() : Promise.resolve([])');
    expect(page).toContain('canPickTill={canRefund}');
  });
});

describe('4 — the partner card, the cost void, the assistant', () => {
  it('the partner card keeps the row and drops the drawer’s name (kontragentlar/[id]/page.tsx)', () => {
    expect(read('src/app/(protected)/kontragentlar/[id]/page.tsx')).toContain(
      "{accountName && !moneyHidden('kassa', actor.permissions) && (",
    );
  });

  it('a cost the reader cannot see is refused after the door and before the void (costs/actions.ts)', () => {
    const body = slice(
      read('src/app/(protected)/costs/actions.ts'),
      'export async function voidCostEntryAction',
      'async function voidReceiptCostDoor',
    );
    const refusal = body.indexOf("if (costSightFor(actor).ownOnly && entry.enteredBy !== actor.id) {");
    expect(refusal).toBeGreaterThan(body.indexOf('authorize('));
    expect(refusal).toBeLessThan(body.indexOf('await voidCostEntry('));
    expect(body).toContain("return { ok: false, error: 'cost_not_yours' };");
    // The service re-judges the kassa in its claim, with the holder's door.
    expect(body).toContain('{ mayMoveTill: mayPickTill(actor.permissions) },');
    expect(read('src/components/cost-panel.tsx')).toContain("cost_not_yours: 'errCostNotYours',");
  });

  it('the assistant’s money tier and its prompt ask one predicate (platform/ai/tools.ts, assistant.ts)', () => {
    const tools = read('src/modules/platform/ai/tools.ts');
    expect(tools).toContain("return isAnalyst(actor) && !moneyHidden('results', actor.permissions);");
    expect(tools).toContain('if (!hasMoneyTier(actor)) return tools;');
    expect(read('src/modules/platform/ai/assistant.ts')).toContain('if (!hasMoneyTier(actor)) return base;');
  });

  it('the dashboard and the admin home ask the company-money predicate (dashboard/page.tsx, admin-dashboard.tsx)', () => {
    expect(read('src/app/(protected)/dashboard/page.tsx')).toContain('const money = seesCompanyMoney(actor) && analyst;');
    expect(read('src/app/(protected)/admin-dashboard.tsx')).toContain('const money = seesCompanyMoney(actor);');
    expect(read('src/app/(protected)/reports/yuk-xavfi/page.tsx')).toContain('const money = seesCompanyMoney(actor);');
  });
});

describe('5 — DERIVED: every cost card lists through the one reader and speaks the kassa through tillView', () => {
  const cards = globSync('src/app/**/*.tsx').filter((path) => readFileSync(path, 'utf8').includes('<CostPanel'));

  it('finds the four cost cards', () => {
    expect(cards.length).toBeGreaterThanOrEqual(4);
  });

  it('each asks tillView and a sighted reader, and none selects cost rows inline', () => {
    for (const path of cards) {
      const source = read(path);
      expect(source, path).toContain('tillView(actor.permissions');
      expect(/costEntriesFor\(|batchCostSheet\(/.test(source), path).toBe(true);
      expect(source, path).toMatch(/costSightFor\(actor\)/);
      expect(source, path).not.toContain('.from(costEntries)');
      expect(source, path).not.toContain('paidFromTill: entry.accountId');
    }
  });
});
