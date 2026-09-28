import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FOUNDERS, MUTE_GROUPS } from '@/modules/platform/notifications/mutes';

/**
 * The wiring of «Olib ketilmagan yuk» (0116) that no behaviour can see.
 * Source-shape on purpose, comments STRIPPED first (#725 — a fence that reads
 * the sentence explaining it tests nothing).
 */

/** Comments out, strings kept — the quote-walking stripper (#725). */
function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

const read = (path: string) => stripComments(readFileSync(path, 'utf8'));

/** The body of `export async function name(` up to the next top-level `\n}`. */
function body(source: string, name: string): string {
  const at = source.indexOf(`export async function ${name}(`);
  expect(at, `${name} is declared`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}\n', at);
  return source.slice(at, end);
}

const DIGEST = 'src/modules/wms/reports/daily-digest.ts';
const WAITING = 'src/modules/wms/issue/waiting.ts';
const ALERTS = 'src/modules/wms/issue/waiting-alerts.ts';
const PAGE = 'src/app/(protected)/my-clients/olib-ketilmagan/page.tsx';
const FLOWS = 'src/modules/wms/home/role-flows.ts';
const QUERIES = 'src/modules/wms/reports/queries.ts';

describe('the svodka asks the screens, never a copy of them', () => {
  it('reads warehouseFill and unclaimedReport, sweeps first, and dates nothing by the China receipt', () => {
    const digest = read(DIGEST);
    expect(digest).toMatch(/warehouseFill\(/);
    expect(digest).toMatch(/unclaimedReport\(/);
    expect(digest).toMatch(/waitingDigestSection\(/);
    expect(digest).not.toMatch(/receivedAt|received_at/);
    expect(digest).not.toContain("'in_stock'");
    // Active people only.
    expect(digest).toMatch(/usersWithRoles\(\['logist', 'admin', 'super_admin'\]\)/);
  });

  it('the old platform digest is gone, and the job registration points at the new home', () => {
    expect(globSync('src/modules/platform/jobs/digest.ts')).toHaveLength(0);
    expect(read('src/modules/platform/jobs/boss.ts')).toContain("import('../../wms/reports/daily-digest')");
  });

  it('warehouseFill and stockAging read the landing helper, and warehouseFill no longer spells the rule out', () => {
    const queries = read(QUERIES);
    const fill = queries.slice(queries.indexOf('export async function warehouseFill('), queries.indexOf('export async function stockByWarehouse('));
    expect(fill).toContain("landedHereDaySql('b')");
    expect(fill).not.toMatch(/DISTINCT ON|to_status <> 'in_transit'|'in_stock'/);
    const aging = body(queries, 'stockAging');
    expect(aging).toContain("landedHereDaySql('b')");
    // A per-carton correlated read across every warehouse: JIT off (0104).
    expect(aging).toMatch(/withoutJit\(/);
    expect(aging).not.toMatch(/\bdb\./);
    // The Tashkent day of a landing has ONE home beside the landing itself.
    expect(fill + aging).not.toContain("AT TIME ZONE 'Asia/Tashkent'");
    expect(read('src/modules/wms/documents/arrivals.ts')).toMatch(
      /export function landedHereDaySql\(box: string\): SQL \{\s*return sql`\(\(\$\{landedHereAtSql\(box\)\}\) AT TIME ZONE 'Asia\/Tashkent'\)::date`;/,
    );
    expect(queries).not.toMatch(/export async function agingSummary/);
  });

  it('the agent sheet and the waiting list date a walk-in by ONE helper', () => {
    const arrivals = read('src/modules/wms/documents/arrivals.ts');
    const sheet = arrivals.slice(arrivals.indexOf('export async function arrivalsForLots('));
    expect(sheet).toContain('landingInstantSql(boxes.lotId)');
    expect(sheet).not.toContain('received_at');
  });
});

describe('the list', () => {
  it('uncollectedCargo touches only the executor it is given — no pool, no settings (#714 inside withoutJit)', () => {
    const fn = body(read(WAITING), 'uncollectedCargo');
    expect(fn).toMatch(/exec\.execute\(/);
    expect(fn).not.toMatch(/\bdb\./);
    expect(fn).not.toMatch(/getSetting|getActor|waitThresholds/);
  });

  it('every door asks the one scope and reads the one function', () => {
    const page = read(PAGE);
    expect(page).toMatch(/mayOpenMyClients\(actor\)/);
    expect(page).toMatch(/uncollectedScope\(actor\)/);
    expect(page).toMatch(/uncollectedPageQuery\(scope, filters,/);
    expect(page).toMatch(/uncollectedCargo\(/);
    // «Qarz» is money's; «narxsiz» is the cargo's and every drawn row gets it.
    expect(page).toMatch(/mayOpenClientLedger\(actor/);
    expect(page).toMatch(/waitingPriceGate\(exec, rows, gate\)/);
    const flows = read(FLOWS);
    expect(flows.match(/uncollectedCount\(/g)).toHaveLength(2);
    // The company-wide one runs with JIT off and inside the home's budget,
    // over the page's own book.
    expect(flows).toMatch(/withoutJit\(\s*\(exec\) =>\s*uncollectedCount\(exec,[\s\S]{0,160}timeoutMs: UNBILLED_BUDGET_MS/);
    expect(flows).toMatch(/ownerId: book\.ownerId, warehouseIds: book\.warehouseIds/);
    expect(flows).toMatch(/logistFlowCounts\(actor, today, \{ uncollected: uncollectedScope\(actor\) \}\)/);
    expect(flows).toMatch(/salesFlowCounts\(actor\.id, today, \{ seesAllClients: seesAllClients\(actor\) \}\)/);
    expect(read('src/app/(protected)/page.tsx')).toMatch(/href=\{flow\.uncollectedHref\}/);
    // The rule has one home now — nobody restates it by hand.
    for (const file of ['src/app/(protected)/my-clients/page.tsx', 'src/modules/wms/bot/lookup.ts', WAITING]) {
      const src = read(file);
      expect(src, file).toMatch(/seesAllClients\(/);
      expect(src, file).not.toMatch(/has\('crm\.leads\.view_all'\)\s*\|\|\s*[\w.]*permissions\.has\('clients\.manage'\)/);
      expect(src, file).not.toMatch(/has\('clients\.manage'\)\s*\|\|\s*[\w.]*permissions\.has\('crm\.leads\.view_all'\)/);
    }
  });

  it('the «qarz» tag and the counter share one debt rule — the amount AND the line', () => {
    const issue = read('src/modules/wms/issue/service.ts');
    expect(issue).toMatch(/blockingDebtUsd\(balance, deferred\)/);
    expect(issue).toMatch(/const needDebt = debtBlocks\(balance, deferred\) && !input\.debtOk;/);
    const waiting = read(WAITING);
    expect(waiting).toMatch(/debtBlocks\(money\.balanceUsd, money\.deferredUsd\)/);
    expect(waiting).not.toContain('0.009');
  });
});

describe('the sweep', () => {
  it('opens no transaction of its own and claims per seller inside its try', () => {
    const alerts = read(ALERTS);
    expect(alerts).not.toMatch(/db\.transaction\(/);
    const sweep = body(alerts, 'sweepCargoWaiting');
    const loop = sweep.slice(sweep.indexOf('for (const [sellerId, sellerRows] of bySeller)'));
    expect(loop.indexOf('try {')).toBeGreaterThan(-1);
    expect(loop.indexOf('try {')).toBeLessThan(loop.indexOf('claimWaitAlerts('));
    expect(loop.indexOf('claimWaitAlerts(')).toBeLessThan(loop.indexOf('notifyStaffTelegram('));
  });

  it('reads the price tags ONCE, JIT off, before any seller — never per seller on the pool', () => {
    const alerts = read(ALERTS);
    const sweep = body(alerts, 'sweepCargoWaiting');
    const loopAt = sweep.indexOf('for (const [sellerId, sellerRows] of bySeller)');
    const read1 = sweep.indexOf('withoutJit((exec) => waitingPriceGate(exec, rows, gate))');
    expect(read1).toBeGreaterThan(-1);
    expect(read1).toBeLessThan(loopAt);
    expect(alerts.match(/waitingPriceGate\(/g)).toHaveLength(1);
    expect(alerts).not.toMatch(/waitingPriceGate\(db,/);
  });

  it('a claim is offered at the level a row may be ANNOUNCED at, never its bare age', () => {
    const claim = body(read(ALERTS), 'claimWaitAlerts');
    expect(claim).toMatch(/announceLevel\(row, thresholds, asOf\)/);
    expect(claim).not.toMatch(/waitLevel\(/);
  });
});

describe('every staff message can be muted', () => {
  it('each type passed to notifyStaffTelegram anywhere in src/ sits in a mute group', () => {
    const covered = new Set<string>(Object.values(MUTE_GROUPS).flat());
    const found = new Set<string>();
    for (const file of globSync('src/**/*.{ts,tsx}')) {
      const src = read(file);
      let at = 0;
      while ((at = src.indexOf('notifyStaffTelegram({', at)) !== -1) {
        const call = src.slice(at, at + 1200);
        const literal = /\btype:\s*'([A-Za-z]+)'/.exec(call);
        if (literal) found.add(literal[1]!);
        at += 1;
      }
    }
    // Constants passed by name, read from their declarations.
    found.add(/export const CARGO_WAITING = '([A-Za-z]+)'/.exec(read(ALERTS))![1]!);
    expect(found.size).toBeGreaterThan(20);
    for (const type of found) expect(covered.has(type), type).toBe(true);
  });

  it('CargoWaiting is the seller\'s morning list, a newcomer and never a founder', () => {
    expect(MUTE_GROUPS.calls as readonly string[]).toContain('CargoWaiting');
    expect(MUTE_GROUPS.digest as readonly string[]).not.toContain('CargoWaiting');
    expect(Object.values(FOUNDERS).flat()).not.toContain('CargoWaiting');
  });
});
