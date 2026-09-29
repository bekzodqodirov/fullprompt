import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The wiring of 4a (his «a) yuk kelgan kundagi sotuvchiga»): which readers the
 * seller's money goes through, and what each of them may and may not name.
 * Source shape on purpose — each rule below is a property of the CODE PATH
 * (the own card cannot hold a cost query; the relation is the price door's,
 * never the gate's; the own result is filtered before it is folded), and a
 * behavioural test passes on a fixture where the wrong path happens to agree.
 * Comments are stripped first, or the files' own prose about the rules mints
 * the matches (#725).
 */
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const REVENUE = 'src/modules/wms/staff/stamp-revenue.ts';
const COST = 'src/modules/wms/staff/stamp-cost.ts';
const SPLIT = 'src/modules/wms/staff/stamp-split.ts';

/** A function's body: from `export … function name` to the next top-level export (client-ledger-sign's slice). */
function body(path: string, name: string): string {
  const text = code(path);
  const start = text.search(new RegExp(`export (async )?function ${name}\\b`));
  expect(start, `${name} not found in ${path}`).toBeGreaterThanOrEqual(0);
  const next = text.indexOf('\nexport ', start + 1);
  return text.slice(start, next < 0 ? text.length : next);
}

describe('the stamp readers', () => {
  it('take the executor and never reach the pool themselves (#714)', () => {
    for (const path of [REVENUE, COST]) {
      const src = code(path);
      expect(src, path).not.toMatch(/platform\/db\/client'/);
      expect(src, path).not.toMatch(/getSetting/);
    }
  });

  it('revenueByStamp takes a REQUIRED scope (#790)', () => {
    const src = code(REVENUE);
    expect(src).toMatch(
      /export async function revenueByStamp\(\s*exec: Exec,\s*period: \{[^}]*\},\s*scope: StaffScope,?\s*\)/,
    );
    expect(src).not.toMatch(/scope\?:/);
  });

  it('a truck price names the price door’s relation (the riders), never the gate’s `covers`', () => {
    const src = code(REVENUE);
    expect(src).toMatch(/riderRowsSql\(/);
    expect(src).not.toMatch(/uncoveredCtes|u_pair|covers/);
  });

  it('the cost reader keeps claimed cargo only and every carton status (#833)', () => {
    const src = code(COST);
    expect(src).toContain('ca.client_id IS NOT NULL');
    expect(src).not.toMatch(/b\.status/);
  });

  it('the report asks the stamp readers, and neither the book map nor profitByClient', () => {
    const all = body('src/modules/wms/crm/seller-report.ts', 'sellerPerformanceAll');
    expect(all).toMatch(/revenueByStamp\(/);
    expect(all).toMatch(/costByStamp\(/);
    const own = body('src/modules/wms/crm/seller-report.ts', 'sellerPerformanceOwn');
    expect(own).toMatch(/revenueByStamp\(/);
    for (const part of [all, own]) {
      expect(part).not.toMatch(/managerOf/);
      expect(part).not.toMatch(/profitByClient/);
    }
  });

  it('the rules are pure — stamp-split.ts imports nothing', () => {
    expect(readFileSync(SPLIT, 'utf8')).not.toMatch(/^import /m);
  });

  it('the own result is filtered BEFORE anything is folded (no colleague’s figure rides out)', () => {
    const src = code(REVENUE);
    expect(src.match(/foldParts\(/g) ?? []).toHaveLength(1);
    expect(src).toContain('foldParts(kept)');
    expect(src).toContain(
      "const kept = scope.kind === 'own' ? parts.filter((p) => p.sellerId === scope.userId) : parts;",
    );
  });
});

describe('the dashboard card', () => {
  const card = code('src/app/(protected)/dashboard/sections/staff-profit.tsx');

  it('opens the report on its own period, and prints no caveat line of its own', () => {
    expect(card).toMatch(/href=\{`\/reports\/sotuvchilar\?dan=\$\{period\.from\}&gacha=\$\{period\.to\}`\}/);
    expect(card).not.toMatch(/staffProfit\.(unlinked|split)/);
  });

  it('its note is one short line in words he already has — never «paid» (the KPI’s word)', () => {
    for (const locale of ['uz', 'ru', 'en', 'zh-CN']) {
      const bundle = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as {
        dashboard: { staffProfit: { note: string } };
      };
      const note = bundle.dashboard.staffProfit.note;
      expect(note.length, locale).toBeLessThanOrEqual(120);
      expect(note, locale).not.toMatch(/to[‘']la|оплач|\bpaid\b|支付/i);
    }
  });
});
