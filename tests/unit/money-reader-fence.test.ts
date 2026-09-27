import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The tripwire for the NEXT screen (owner's Q19, 2026-09-25: the VED sees no
 * kassa, no profit/loss, no tannarx «umuman»). DERIVED: every page, component
 * and API route under `src/app` that imports a reader of the landed cost, the
 * profit, the P&L, the kassa or a drawer list must also ask one of the
 * predicates that keep the VED out — or sit on the allow-list below with its
 * reason and its own check.
 *
 * Stated weakness: a file passes on ANY matching mention, so one that asks
 * `moneyHidden(` for a different element still passes. money-sight-wire.test
 * is the precise pin; this one catches the file nobody has pinned yet.
 *
 * The client-DEBT readers (`clientBalances`, `clientBalanceUsd`,
 * `balancesForClients`, `clientLedger`) are deliberately NOT on the list:
 * his follow-up «19 a» keeps client debts open to the VED.
 */
const MONEY_READERS = [
  'boxLandedCost',
  'batchLandedCostByClient',
  'batchLandedCostByLot',
  'batchLandedCostTotals',
  'batchClientCostBreakdown',
  'landedCostByClient',
  'landedCostByLot',
  'dealProfit',
  'profitByBatch',
  'profitByClient',
  'profitByRoute',
  'profitAndLoss',
  'cashFlow',
  'cashFlowByMonth',
  'cashFlowCore',
  'companyBalance',
  // U03: the cash half (the admin home, the attention list, the hero tile)
  // and the Balans line itself — both money, both kept from the VED.
  'companyBalanceParts',
  'unpricedCargoMoney',
  'accountBalances',
  'balanceLines',
  'moneySnapshot',
  'arAging',
  'paymentsRegister',
  'listAccounts',
  'unbatchedMoney',
  'buildLandedCostXlsx',
  // Review of the VED unit (C14/C21): the cached wrappers pages actually
  // import, the readers the parallel units added after this list, the three
  // report files, and the cost grid's own readers — the widest tannarx
  // surface the VED can open.
  'loadBalance',
  'loadAging',
  'loadTrips',
  'loadGaps',
  'cashReconciliation',
  'pnlMonthParts',
  'cashMonthParts',
  'lossesInPeriod',
  'buildPnlXlsx',
  'buildCashFlowXlsx',
  'buildProfitXlsx',
  'receiptCostMatrix',
  'batchScopeCostByType',
  'batchCostSheet',
  'costEntriesFor',
  // Round B (judge O6): the dashboard's new money loaders and the readers
  // behind them — every one was outside the list, so a card built on them
  // escaped the fence the day it was written.
  'loadBalanceParts',
  'loadPnl12',
  'loadPnlRange',
  'loadCashRange',
  'loadCashWeeks',
  'loadCashByMonth',
  'loadTargetFor',
  'cashFlowByWeek',
  'pnlParts',
];

/** A predicate that keeps the VED out of a money read. */
const GATES = [
  /moneyHidden\(/,
  /pricingSight\(/,
  /seesCompanyMoney\(/,
  /\.has\('finance\.(reports|expenses)'\)/,
  /authorize\('finance\.(reports|expenses)'/,
  /mayPickTill\(/,
  /isAnalyst\(/,
  /upsaleScopeFor\(/,
  /sellerReportScopeFor\(/,
  /calcControlScopeFor\(/,
  // Not a door but a sight: the cost readers take it as a REQUIRED argument
  // and show the VED only what he typed (Q19 D1). Pinned precisely below for
  // the grid, because a file passes this list on any mention.
  /costSightFor\(/,
];

/**
 * Files that read money and are gated by the file that RENDERS them, each
 * with its reason and the check that holds the reason true.
 */
const ALLOWED: Record<string, { why: string; renderedBy: string; gate: RegExp }> = {
  'src/app/(protected)/dashboard/sections/hero.tsx': {
    why: 'its money tiles take `money` from the page, which asks seesCompanyMoney',
    renderedBy: 'src/app/(protected)/dashboard/page.tsx',
    gate: /const money = seesCompanyMoney\(actor\) && analyst;/,
  },
  'src/app/(protected)/dashboard/sections/money.tsx': {
    why: 'mounted only under the page’s `money` flag, and every card in it takes the CompanyMoneySight token',
    renderedBy: 'src/app/(protected)/dashboard/page.tsx',
    gate: /\{money && sight && \(\s*<Suspense[\s\S]{0,120}?<MoneySection/,
  },
};

const stripComments = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The names a file imports — static `import {…} from` (multi-line) and `const {…} = await import(…)`. */
function importedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const part of match[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
      if (name) names.add(name);
    }
  }
  for (const match of source.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+import\(/g)) {
    for (const part of match[1]!.split(',')) {
      const name = part.trim().split(':')[0]!.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

describe('every money reader under src/app keeps the VED out', () => {
  const files = globSync('src/app/**/*.{ts,tsx}');

  it('finds the app', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('a file that imports one asks a gate, or is allow-listed with its reason', () => {
    const offenders: string[] = [];
    for (const path of files) {
      const source = stripComments(readFileSync(path, 'utf8'));
      const readers = MONEY_READERS.filter((name) => importedNames(source).has(name));
      if (readers.length === 0) continue;
      if (ALLOWED[path]) continue;
      if (!GATES.some((gate) => gate.test(source))) offenders.push(`${path}: ${readers.join(', ')}`);
    }
    expect(offenders, 'money read with no gate that keeps the VED out').toEqual([]);
  });

  it('the cost grid hands BOTH its readers the actor’s own sight — never ALL_COSTS (review of the VED unit, C21)', () => {
    const page = stripComments(readFileSync('src/app/(protected)/batches/[id]/xarajatlar/page.tsx', 'utf8'));
    expect(page).toMatch(/const sight = costSightFor\(actor\);/);
    expect(page).toMatch(/receiptCostMatrix\([\s\S]{0,160}?,\s*sight,?\s*\)/);
    expect(page).toMatch(/batchScopeCostByType\(id, sight\)/);
    expect(page).not.toMatch(/ALL_COSTS/);
  });

  it('each allow-listed file is still rendered only behind its gate', () => {
    for (const [path, entry] of Object.entries(ALLOWED)) {
      const importer = stripComments(readFileSync(entry.renderedBy, 'utf8'));
      expect(importer, `${path} — ${entry.why}`).toMatch(entry.gate);
    }
  });

  it('every dashboard money card demands the CompanyMoneySight token, minted by the one predicate (round B, O6)', () => {
    // The import fence passes a whole FILE; a card exported from an allowed
    // file and mounted outside the gate passed with it. So each exported
    // component in the two money files that awaits a money loader must TYPE
    // the token into its props — a branded value nobody can write by hand.
    for (const path of [
      'src/app/(protected)/dashboard/sections/hero.tsx',
      'src/app/(protected)/dashboard/sections/money.tsx',
    ]) {
      const source = stripComments(readFileSync(path, 'utf8'));
      const parts = source.split(/(?=export async function )/).slice(1);
      expect(parts.length, path).toBeGreaterThan(1);
      for (const part of parts) {
        const name = /export async function (\w+)/.exec(part)![1]!;
        const readsMoney = MONEY_READERS.some((reader) => new RegExp(`\\b${reader}\\(`).test(part));
        if (!readsMoney) continue;
        expect(part, `${path} ${name}`).toMatch(/sight: CompanyMoneySight( \| null)?;/);
      }
    }
    const scope = stripComments(readFileSync('src/modules/wms/finance/scope.ts', 'utf8'));
    expect(scope).toContain('return seesCompanyMoney(actor) ? SIGHT : null;');
    const page = stripComments(readFileSync('src/app/(protected)/dashboard/page.tsx', 'utf8'));
    expect(page).toContain('const sight = money ? companyMoneySight(actor) : null;');
    // HeroTiles takes a nullable token and reads money only when it holds one.
    expect(readFileSync('src/app/(protected)/dashboard/sections/hero.tsx', 'utf8')).toContain('const money = sight !== null;');
  });
});
