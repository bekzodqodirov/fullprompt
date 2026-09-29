import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * His 3a — the upsale's «paid cargo» is the KPI's rule — pinned where no
 * behaviour can see it: ONE reader of the carton × FIFO walk, the pay door
 * deciding on its own transaction's connection (#714), the liability out of
 * the parts nobody's net needs, the walk's two budgets, and every reader of
 * `upsaleRows` classified by whether it may skip the walk. The money itself
 * is proven through the real doors in upsale.integration.
 *
 * Comments are stripped first (#725) and the anchors are names the code must
 * contain (#720): a fence that matches the sentence explaining itself, or a
 * list of today's callers, proves nothing.
 */
const strip = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (path: string) => strip(readFileSync(path, 'utf8'));

/** The text from `start` to the next top-level `export` (or the end). */
function section(source: string, start: string): string {
  const at = source.indexOf(start);
  expect(at, start).toBeGreaterThanOrEqual(0);
  const next = source.indexOf('\nexport ', at + start.length);
  return source.slice(at, next < 0 ? undefined : next);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}
const SRC = walk('src').map((path) => ({ path: path.split('\\').join('/'), code: read(path) }));

const SERVICE = 'src/modules/wms/calc/upsale-service.ts';
const KPI_PAID = 'src/modules/wms/staff/kpi-paid.ts';
const UNPRICED = 'src/modules/wms/finance/unpriced.ts';
const REPORTS = 'src/modules/wms/accounting/reports.ts';
const SUMMARY = 'src/modules/wms/reports/owner-summary.ts';
const WORKSPACE = 'src/modules/wms/calc/workspace.ts';

describe('ONE carton × FIFO reader (a, b, c)', () => {
  it('only paid-cartons and the client card call settleCharges — the declaration is not a call', () => {
    const callers = SRC.filter((f) => /(?<!function\s)\bsettleCharges\(/.test(f.code)).map((f) => f.path);
    expect(callers.sort()).toEqual([
      'src/modules/wms/finance/client-cargo.ts',
      'src/modules/wms/finance/paid-cartons.ts',
    ]);
  });

  it('the KPI is a fold of paidCargo, with the words-only tag off', () => {
    const body = section(read(KPI_PAID), 'export async function paidM3ByMonth');
    expect(body).toContain('paidCargo(');
    expect(body).toContain('elsewhere: false');
    expect(body).not.toContain('settleCharges(');
    expect(body).not.toContain('uncoveredCtes(');
  });

  it('the upsale no longer asks the client’s whole balance', () => {
    expect(read(SERVICE)).not.toContain('balancesForClients');
  });
});

describe('the pay door decides on its own transaction (d)', () => {
  const body = section(read(SERVICE), 'export async function payUpsale');

  it('in order: open, budget, walk on tx, expense, claim', () => {
    const order = ['db.transaction(', 'SET LOCAL statement_timeout', 'dealCargoPaid(tx', 'addExpenseTx(', 'UPDATE calc_offers o'];
    const at = order.map((needle) => body.indexOf(needle));
    for (const [i, needle] of order.entries()) expect(at[i], needle).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('asks no pool connection from inside it, and borrows no KPI lock', () => {
    for (const pooled of ['withoutJit(', 'walkDealsBudgeted(', 'walkDealsWithin(', 'upsaleRows(', "'kpi:"]) {
      expect(body, pooled).not.toContain(pooled);
    }
  });
});

describe('the readers walk under their own budgets (e)', () => {
  const source = read(SERVICE);

  it('the list walks with the list budget', () => {
    const body = section(source, 'export async function upsaleRows');
    expect(body).toContain('walkDealsBudgeted(');
    expect(body).toContain("'list'");
    expect(body).not.toContain('dealCargoPaid(db');
  });

  it('the liability walks, and folds through liabilityOf', () => {
    const body = section(source, 'export async function upsaleLiability');
    expect(body).toContain('walkDealsBudgeted(');
    expect(body).toContain('liabilityOf(');
    expect(body).not.toContain('dealCargoPaid(db');
  });

  it('only a budget miss is soft', () => {
    const body = section(source, 'export async function walkDealsWithin');
    const handler = body.slice(body.indexOf('catch (err)'));
    expect(handler).toContain('isBudgetMiss(err)');
  });
});

describe('the deals scope is client-consistent (f)', () => {
  it('a prixod moved to another client never decides the deal it still names', () => {
    const scope = section(read(UNPRICED), 'export function unpricedScopeSql');
    const at = scope.indexOf("case 'deals'");
    expect(at).toBeGreaterThan(-1);
    const next = scope.indexOf("case '", at + 5);
    expect(scope.slice(at, next)).toContain('sd.client_id = r.client_id');
  });
});

describe('the liability is read only where a net is printed, through the memo (g)', () => {
  it('the parts never wait for it; the net and the Monday summary read it through the memo', () => {
    const reports = read(REPORTS);
    const parts = section(reports, 'export const companyBalanceParts');
    expect(parts).not.toContain('upsaleLiability');
    const net = section(reports, 'export async function companyBalance()');
    expect(net).toContain('upsaleLiabilityForNet()');
    expect(net).not.toContain("upsaleLiability('net')");
    const summary = read(SUMMARY);
    expect(summary).toContain('upsaleLiabilityForNet()');
    expect(summary).not.toContain("upsaleLiability('net')");
    expect(summary).not.toContain('balance.sellerCommissions');
  });

  it('the memo wraps the walk, and nothing in src walks the company past it', () => {
    const body = section(read(SERVICE), 'export function upsaleLiabilityForNet');
    expect(body).toContain('rememberedLiability(');
    expect(body).toContain("upsaleLiability('net')");
    const direct = SRC.filter((f) => f.path !== SERVICE && /(?<!function\s)\bupsaleLiability\(/.test(f.code));
    expect(direct.map((f) => f.path)).toEqual([]);
  });

  it('every door in this process that changes the answer forgets it', () => {
    const service = read(SERVICE);
    const pay = section(service, 'export async function payUpsale');
    // After the commit — a forget inside the transaction would let a reader
    // remember the pre-pay figure again before the claim is visible — and
    // never on the refusal path, where nothing changed.
    const forgot = pay.indexOf('forgetUpsaleLiability()');
    expect(forgot).toBeGreaterThan(pay.indexOf('UPDATE calc_offers o'));
    expect(forgot).toBeGreaterThan(pay.indexOf('return { expenseId'));
    expect(forgot).toBeLessThan(pay.indexOf('catch (err)'));
    expect(section(service, 'export async function reopenUpsaleForExpense')).toContain('forgetUpsaleLiability()');
    const workspace = read(WORKSPACE);
    for (const door of ['export async function recordOffer', 'export async function releaseOffer']) {
      expect(section(workspace, door), door).toContain('forgetUpsaleLiability()');
    }
  });
});

describe('every reader of upsaleRows is classified (h)', () => {
  const READERS: Record<string, 'fifo' | 'skip'> = {
    'src/app/(protected)/upsale/page.tsx': 'fifo',
    'src/app/(protected)/hodimlar/page.tsx': 'fifo',
    'src/modules/wms/staff/my-month.ts': 'skip',
    'src/modules/wms/staff/seller-profit.ts': 'skip',
  };

  /** The balanced `( … )` after each call's name. */
  const callArgs = (code: string): string[] => {
    const out: string[] = [];
    for (const match of code.matchAll(/(?<!function\s)\bupsaleRows\(/g)) {
      let depth = 0;
      const open = match.index! + match[0].length - 1;
      for (let i = open; i < code.length; i += 1) {
        if (code[i] === '(') depth += 1;
        else if (code[i] === ')' && --depth === 0) {
          out.push(code.slice(open, i + 1));
          break;
        }
      }
    }
    return out;
  };

  it('a new caller turns this red until it says which walk it needs', () => {
    const callers = SRC.filter((f) => f.path !== SERVICE && callArgs(f.code).length > 0).map((f) => f.path);
    expect(callers.sort()).toEqual(Object.keys(READERS).sort());
    for (const [path, walk] of Object.entries(READERS)) {
      const calls = callArgs(SRC.find((f) => f.path === path)!.code);
      for (const args of calls) expect(args, path).toContain(`walk: '${walk}'`);
    }
  });

  it('a reader that skips the walk never reads the state it skipped', () => {
    for (const [path, walk] of Object.entries(READERS)) {
      if (walk !== 'skip') continue;
      const code = SRC.find((f) => f.path === path)!.code;
      expect(code, path).not.toMatch(/\bstate\s*===?\s*'(paid|payable|awaiting_payment|no_invoice|no_cargo|no_deal|not_computed)'/);
    }
  });
});

describe('an unknown is SAID on every surface that prints the figure (i, j)', () => {
  it('the Balans page — beside the headline net, on its line, and in words — and the dashboard bridge', () => {
    const balance = read('src/app/(protected)/accounting/balance/page.tsx');
    expect(balance).toMatch(/sellerCommissionsUnknownCount > 0 &&[\s\S]{0,300}data-testid="balance-commissions-unknown"/);
    // Review nit A3: the ⚠ stands INSIDE the headline net's own element, so
    // the figure the owner reads first says it is short of something.
    const net = balance.indexOf('data-testid="balance-net"');
    const mark = balance.indexOf('data-testid="balance-net-commissions-unknown"');
    expect(net).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(net);
    expect(mark).toBeLessThan(balance.indexOf('</p>', net));
    expect(balance.slice(net, mark)).toContain('commissionsUnknown &&');
    expect(read('src/app/(protected)/dashboard/sections/money.tsx')).toContain('dash-commissions-unknown');
  });

  it('/upsale asks the ledger door for money sight, never restates it by hand (#513)', () => {
    const page = read('src/app/(protected)/upsale/page.tsx');
    expect(page).toContain('mayOpenClientLedger(');
    expect(page).not.toMatch(/clientManagerId\s*===|===\s*[\w.]*clientManagerId\b/);
  });

  it('/upsale: the chip, the hint, the page warning, the rule — and the pay list ticks payable only', () => {
    const page = read('src/app/(protected)/upsale/page.tsx');
    for (const testid of ['data-testid="upsale-state"', 'upsale-fifo-hint', 'upsale-not-computed', 'upsale-rule']) {
      expect(page, testid).toContain(testid);
    }
    expect(page).toContain("r.state === 'payable' && r.payableUsd > 0.009");
  });

  it('the deploy-morning script', () => {
    expect(read('scripts/balance-report.ts')).toContain('sellerCommissionsUnknownCount');
  });
});
