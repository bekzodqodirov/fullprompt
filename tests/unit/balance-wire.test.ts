import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CARD_PRICE_RULE } from '@/modules/wms/accounting/reports';

/**
 * The Balans line «narxi hali yozilmagan yukka sarflangan» (U03, the owner's
 * Q16 A) — the wiring no behaviour can see. The money is proven through the
 * real doors in balance-unpriced-cargo.integration; this file pins where the
 * line may and may not be read, because every one of these is a shape that
 * stays green while being wrong: a section that waits for a read it never
 * prints, a pool read inside the line's transaction (#714), the nested-loop
 * spelling (4.2 s at 15k cartons), a door restated inline.
 *
 * Comments are stripped first (#725): a fence that matches the sentence
 * explaining itself proves nothing.
 */
const read = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The text from `start` to the next top-level `export` (or the end). */
function section(source: string, start: string): string {
  const at = source.indexOf(start);
  expect(at, start).toBeGreaterThanOrEqual(0);
  const next = source.indexOf('\nexport ', at + start.length);
  return source.slice(at, next < 0 ? undefined : next);
}

const REPORTS = 'src/modules/wms/accounting/reports.ts';
const UNPRICED = 'src/modules/wms/finance/unpriced.ts';

describe('U03 — the Balans line’s wiring', () => {
  it('ships the owner’s (i): dated exclusion, one constant', () => {
    expect(CARD_PRICE_RULE).toBe('exclude');
  });

  it('companyBalance adds the line to the net, under his rule, with the ban cut', () => {
    const body = section(read(REPORTS), 'export async function companyBalance()');
    expect(body).toMatch(/const net =[\s\S]*?\+\s*cargo\.lineUsd;/);
    expect(body).toContain('cardRule: CARD_PRICE_RULE');
    expect(body).toContain("history: 'since_gate'");
    // The parts and the line side by side, awaited together.
    expect(body).toMatch(/await Promise\.all\(\[\s*companyBalanceParts\(\),\s*unpricedCargoMoney\(/);
  });

  it('the line is ONE statement through withoutJit, with no pool read inside it (#714)', () => {
    const body = section(read(REPORTS), 'export async function unpricedCargoMoney(');
    expect(body).toContain('withoutJit((exec) =>');
    const inside = body.slice(body.indexOf('withoutJit((exec) =>'));
    for (const pooled of ['unplacedCostSince(', 'unpricedGate(', 'getSetting(', 'rateFor(', 'kassaRatesToday(']) {
      expect(inside, pooled).not.toContain(pooled);
    }
  });

  it('the read spells the uncovered cartons as the anti-join u_unc, never FROM u_cov', () => {
    const line = section(read(REPORTS), 'export async function unpricedCargoMoney(');
    const money = section(read(UNPRICED), 'export function uncoveredMoneyCtes()');
    expect(line).toContain('FROM u_unc');
    expect(line).not.toContain('FROM u_cov');
    expect(money).toContain('WHERE ua.box_id IS NULL OR NOT ua.covered');
    expect(money).not.toContain('FROM u_cov');
  });

  it('«names no cargo» carries all three branches — the truck one included', () => {
    const money = section(read(UNPRICED), 'export function uncoveredMoneyCtes()');
    const free = money.slice(money.indexOf('u_free AS MATERIALIZED ('), money.indexOf('u_nocargo AS ('));
    expect(free).toContain('NOT EXISTS (SELECT 1 FROM u_rc r WHERE r.charge_id = uc.id)');
    const nocargo = money.slice(money.indexOf('u_nocargo AS ('));
    expect(nocargo).toContain('FROM u_free uf');
    expect(nocargo).toContain('WHEN uf.batch_id IS NOT NULL THEN');
    expect(nocargo).toContain('nb.current_batch_id = uf.batch_id');
    expect(nocargo).toContain('WHEN uf.deal_id IS NOT NULL THEN');
  });

  it('the plan fences stay — each measured, each a silent regression when removed', () => {
    // u_nocargo: the anti-join materialized first and each probe fenced, or
    // the truck probe hashes every batch movement (244 ms at two years).
    const money = section(read(UNPRICED), 'export function uncoveredMoneyCtes()');
    expect(money).toContain('u_free AS MATERIALIZED (');
    expect(money.match(/OFFSET 0\)/g)?.length).toBe(3);
    // The unclaimed note driven from its prixods, or it walks every
    // allocation of the company (390 ms at 60k cartons).
    expect(section(read(REPORTS), 'export async function unpricedCargoMoney(')).toContain('w_unc_alloc AS MATERIALIZED (');
  });

  it('the admin home and the attention list read the parts and never the full balance', () => {
    const home = read('src/app/(protected)/admin-dashboard.tsx');
    expect(home).toContain('companyBalanceParts()');
    expect(home).not.toMatch(/\bcompanyBalance\(\)/);
    const attention = read('src/app/(protected)/dashboard/sections/attention.tsx');
    expect(attention).toContain('loadBalanceParts()');
    expect(attention).not.toMatch(/\bloadBalance\(\)/);
  });

  it('the hero draws on the parts; only a component under <Suspense awaits the full balance', () => {
    const hero = read('src/app/(protected)/dashboard/sections/hero.tsx');
    const tiles = hero.slice(hero.indexOf('export async function HeroTiles('), hero.indexOf('async function TileNet('));
    expect(tiles.length).toBeGreaterThan(100);
    expect(tiles).toContain('loadBalanceParts()');
    expect(tiles).not.toMatch(/\bloadBalance\(\)/);
    expect(tiles).toMatch(/<Suspense key="net"[\s\S]{0,120}?>\s*<TileNet \/>\s*<\/Suspense>/);
    const tileNet = hero.slice(hero.indexOf('async function TileNet('));
    expect(tileNet).toContain('await loadBalance()');
  });

  it('every door to the unpriced list asks the one predicate', () => {
    expect(read('src/app/(protected)/finance/narxsiz/page.tsx')).toContain('mayReadUnpricedList(actor.permissions)');
    expect(read('src/app/(protected)/dashboard/page.tsx')).toContain('canUnpricedList={mayReadUnpricedList(perms)}');
    const balance = read('src/app/(protected)/accounting/balance/page.tsx');
    expect(balance).toContain('const canList = mayReadUnpricedList(actor.permissions);');
    expect(balance).toMatch(/\{canList && \(\s*<div>\s*<Link\s+href="\/finance\/narxsiz"/);
  });

  it('the row links to the notes card on both screens, never to the list', () => {
    expect(read('src/app/(protected)/accounting/balance/page.tsx')).toContain(
      "balanceLines(balance, { cash: '/accounting/accounts', cargo: '#balance-unpriced' })",
    );
    expect(read('src/app/(protected)/dashboard/sections/money.tsx')).toContain(
      "cargo: '/accounting/balance#balance-unpriced'",
    );
  });

  it('the nightly repair writes the debt a failed chargeForCost never wrote', () => {
    const body = section(read('src/modules/wms/costing/service.ts'), 'export async function recomputeAll(');
    expect(body).toMatch(
      /partner_id IS NOT NULL AND \$\{costEntries\}\.amount_usd IS NOT NULL\s*AND NOT EXISTS \(SELECT 1 FROM partner_transactions pt/,
    );
  });
});
