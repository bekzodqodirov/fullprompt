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
  'accountBalances',
  'balanceLines',
  'moneySnapshot',
  'arAging',
  'paymentsRegister',
  'listAccounts',
  'unbatchedMoney',
  'buildLandedCostXlsx',
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
    why: 'mounted only under the page’s `money` flag',
    renderedBy: 'src/app/(protected)/dashboard/page.tsx',
    gate: /\{money && \(\s*<Suspense[\s\S]{0,120}?<MoneySection/,
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

  it('each allow-listed file is still rendered only behind its gate', () => {
    for (const [path, entry] of Object.entries(ALLOWED)) {
      const importer = stripComments(readFileSync(entry.renderedBy, 'utf8'));
      expect(importer, `${path} — ${entry.why}`).toMatch(entry.gate);
    }
  });
});
