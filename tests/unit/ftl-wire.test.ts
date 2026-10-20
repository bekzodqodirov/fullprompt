import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bodyOf, read, srcFiles, strip } from '../fixtures/source-shape';
import { FOUNDERS, MUTE_GROUPS } from '@/modules/platform/notifications/mutes';
import { FTL_REFUSALS, isFtlRefusal, leadDealMoveRefusal, mayRevertFtl, ftlDoorFor } from '@/modules/wms/ftl/door';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { loadFilterSql } from '@/modules/wms/ftl/sql';

/**
 * LTL / FTL (0135) — the wiring a behavioural test cannot see on its own:
 * which writer may touch the three tables, that every door that moves a
 * prixod's deal also carries the deal's FTL, that the KPI's readers all ask
 * the same constant, that the payout and the doors take the very same lock,
 * and that every refusal has a sentence in every language. Comments are
 * stripped first (#725). Anchored on names they must find (#720).
 */

const LOCALES = ['uz', 'ru', 'en', 'zh-CN'] as const;
type Bundle = {
  ftl: { errors: Record<string, string>; skip: Record<string, string> };
  deals: { errors: Record<string, string> };
};
const bundle = (locale: string) => JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as Bundle;

describe('one writer for the three tables', () => {
  it('only wms/ftl/service.ts writes lead_ftl, deal_ftl and receipt_load_mode', () => {
    const writers = srcFiles()
      .filter((f) => !f.path.includes('/migrations/'))
      .filter((f) => /(INSERT INTO|UPDATE|DELETE FROM)\s+(lead_ftl|deal_ftl|receipt_load_mode)\b/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(writers).toEqual(['src/modules/wms/ftl/service.ts']);
  });

  it('no drizzle writer touches them either (they are declared for reads and the schema only)', () => {
    const drizzle = srcFiles().filter((f) =>
      /\.(insert|update|delete)\((leadFtl|dealFtl|receiptLoadMode)\)/.test(f.text),
    );
    expect(drizzle.map((f) => f.path)).toEqual([]);
  });
});

describe('a prixod that gets a deal carries the deal’s FTL (1a)', () => {
  it('confirmReceipt inherits after its own INSERT writes deal_id', () => {
    const body = bodyOf(read('src/modules/wms/receipts/service.ts'), 'export async function confirmReceipt(');
    expect(body.indexOf('inheritFromDealTx(tx, receipt!.id')).toBeGreaterThan(body.indexOf('.insert(receipts)'));
    // Asked BEFORE the transaction (#714), and only when there is a deal to read.
    expect(body).toMatch(/const ftlOn = input\.clientId && input\.dealId \? await ftlReady\(\) : false;/);
    expect(body.indexOf('await ftlReady()')).toBeLessThan(body.indexOf('db.transaction('));
  });

  it('every .update(receipts) that writes dealId also inherits — and never downgrades', () => {
    const movers = srcFiles()
      .filter((f) => f.text.includes('.update(receipts)'))
      .flatMap((f) => {
        const out: string[] = [];
        for (const m of f.text.matchAll(/\.update\(receipts\)/g)) {
          const whereAt = f.text.indexOf('.where(', m.index!);
          const set = f.text.slice(m.index!, whereAt);
          if (/\bdealId\b/.test(set)) out.push(f.path);
        }
        return out;
      });
    expect(movers, 'linkReceipt is found').toContain('src/modules/wms/deals/service.ts');
    for (const path of new Set(movers)) {
      expect(read(path), path).toContain('inheritFromDealTx(');
    }
    const link = bodyOf(read('src/modules/wms/deals/service.ts'), 'export async function linkReceipt(');
    // The deal row FOR SHARE and the stamp's KPI lock come before the receipt row (deal → kpi → receipt).
    expect(link.indexOf('FOR SHARE')).toBeLessThan(link.indexOf('.update(receipts)'));
    expect(link.indexOf('takeKpiSellerLocks(')).toBeLessThan(link.indexOf('.update(receipts)'));
    expect(link).not.toMatch(/DELETE FROM receipt_load_mode|setReceiptLoad\(/);
  });

  it('winLead carries the lead’s mark into its deal', () => {
    const crm = read('src/modules/wms/crm/service.ts');
    expect(bodyOf(crm, 'export async function winLead(')).toContain('{ carryFtlFromLead: id }');
    expect(bodyOf(read('src/modules/wms/deals/service.ts'), 'export async function createDeal(')).toContain(
      'carryLeadFtlTx(tx, options.carryFtlFromLead',
    );
  });
});

describe('the KPI counts LTL only — one constant, every reader', () => {
  it('the KPI service, its paid part and the rating’s points ask KPI_LOAD', () => {
    const kpi = read('src/modules/wms/staff/kpi-service.ts');
    expect(kpi.match(/KPI_LOAD\)/g)?.length).toBe(4);
    expect(read('src/modules/wms/staff/kpi-paid.ts')).toContain('load: KPI_LOAD');
    const rating = bodyOf(read('src/modules/wms/staff/rating.ts'), 'async function standingsFor(');
    expect(rating).toContain('KPI_LOAD');
  });

  it('the filter lives in the stamped scope only — never in u_box, which upsale and the handover gate read (5a)', () => {
    const unpriced = read('src/modules/wms/finance/unpriced.ts');
    expect(unpriced.match(/loadFilterSql\(/g)?.length).toBe(1);
    const stampedCase = unpriced.slice(unpriced.indexOf("case 'stamped':"), unpriced.indexOf("case 'deals':"));
    expect(stampedCase).toContain('loadFilterSql(sql`r.id`, scope.load)');
  });

  it('the clause: LTL is «not FTL», so a hand-pinned LTL row stays LTL', () => {
    const render = (filter: 'all' | 'ltl' | 'ftl') => new PgDialect().sqlToQuery(loadFilterSql(sql`r.id`, filter)).sql;
    expect(render('ftl')).toContain("rlm.mode = 'ftl'");
    expect(render('ltl')).toMatch(/^NOT EXISTS \(SELECT 1 FROM receipt_load_mode rlm WHERE rlm\.receipt_id = r\.id AND rlm\.mode = 'ftl'\)$/);
    expect(render('all')).toBe('true');
  });
});

describe('the paid-month freeze takes the payout’s own lock (6a)', () => {
  it('payKpi and the doors share one spelling of the key', () => {
    const lock = strip(readFileSync('src/modules/wms/staff/kpi-lock.ts', 'utf8'));
    expect(lock).toContain("hashtext('kpi:' || ${sellerId})");
    expect(read('src/modules/wms/staff/kpi-service.ts')).toContain('kpiSellerLockSql(sellerId)');
    expect(read('src/modules/wms/staff/kpi-service.ts')).not.toMatch(/hashtext\('kpi:' \|\|/);
    // Sorted, deduplicated — two opposite cascades must not deadlock.
    expect(lock).toContain('[...new Set(');
    expect(lock).toContain(')].sort();');
  });

  it('every inherit and revert statement is gated by the freeze', () => {
    const service = read('src/modules/wms/ftl/service.ts');
    expect(bodyOf(service, 'function inheritSql(')).toContain("NOT ${kpiPaidMonthSql('r')}");
    expect(bodyOf(service, 'export async function setDealFtlTx(')).toContain("NOT ${kpiPaidMonthSql('r')}");
  });
});

describe('the departure hint (7a)', () => {
  it('fires after departBatch commits, and the truck lock stays the first await', () => {
    const body = bodyOf(read('src/modules/wms/scanning/service.ts'), 'export async function departBatch(');
    expect(body.indexOf("import('../ftl/hint')")).toBeGreaterThan(body.indexOf('}).then('));
    expect(body.indexOf('lockTruckLoading(')).toBeLessThan(body.indexOf('.update(boxes)'));
  });

  it('both new pushes are alerts and newcomers, never founders', () => {
    for (const type of ['FtlMarked', 'FtlSuspected']) {
      expect(MUTE_GROUPS.alerts, type).toContain(type);
      expect(Object.values(FOUNDERS).flat(), type).not.toContain(type);
    }
  });
});

describe('the door, pure (2a)', () => {
  const a = ftlDoorFor({ id: 'a', permissions: new Set(['crm.leads']), warehouseScoped: false });
  const boss = ftlDoorFor({ id: 'x', permissions: new Set(['finance.reports']), warehouseScoped: false });

  it('a seller marks only his own, never takes back, never hands an FTL job on', () => {
    expect(leadDealMoveRefusal(a, { before: false, after: true, ownerBefore: 'a', ownerAfter: 'a' })).toBeNull();
    expect(leadDealMoveRefusal(a, { before: false, after: true, ownerBefore: 'b', ownerAfter: 'b' })).toBe('ftl_not_yours');
    // Taking a colleague's job and marking it in one save is still not his own.
    expect(leadDealMoveRefusal(a, { before: false, after: true, ownerBefore: 'b', ownerAfter: 'a' })).toBe('ftl_office_only');
    expect(leadDealMoveRefusal(a, { before: true, after: false, ownerBefore: 'a', ownerAfter: 'a' })).toBe('ftl_office_only');
    expect(leadDealMoveRefusal(a, { before: true, after: true, ownerBefore: 'a', ownerAfter: 'b' })).toBe('ftl_office_only');
    expect(leadDealMoveRefusal(a, { before: false, after: false, ownerBefore: 'a', ownerAfter: 'b' })).toBeNull();
  });

  it('the office may do all of it; the VED’s finance.manage is not the office', () => {
    expect(leadDealMoveRefusal(boss, { before: true, after: false, ownerBefore: 'a', ownerAfter: 'b' })).toBeNull();
    expect(mayRevertFtl({ permissions: new Set(['finance.manage', 'ved.docs']), warehouseScoped: false })).toBe(false);
  });

  it('every refusal has a sentence in every language, and the deal form’s three too (#163)', () => {
    for (const locale of LOCALES) {
      const m = bundle(locale);
      for (const code of [...FTL_REFUSALS, 'busy', 'validation', 'forbidden']) {
        expect(m.ftl.errors[code], `${locale} ftl.errors.${code}`).toBeTruthy();
      }
      for (const code of ['ftl_office_only', 'ftl_not_yours', 'server_behind']) {
        expect(m.deals.errors[code], `${locale} deals.errors.${code}`).toBeTruthy();
      }
      for (const why of ['kpi_paid', 'hand', 'other_seller', 'other_client']) {
        expect(m.ftl.skip[why], `${locale} ftl.skip.${why}`).toBeTruthy();
      }
    }
    expect(isFtlRefusal('ftl_office_only')).toBe(true);
    expect(isFtlRefusal('bad_number')).toBe(false);
  });
});
