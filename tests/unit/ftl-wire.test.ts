import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bodyOf, read, srcFiles, strip } from '../fixtures/source-shape';
import { FOUNDERS, MUTE_GROUPS } from '@/modules/platform/notifications/mutes';
import { FTL_REFUSALS, isFtlRefusal, leadDealMoveRefusal, mayRevertFtl, ftlDoorFor } from '@/modules/wms/ftl/door';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { loadFilterSql } from '@/modules/wms/ftl/sql';
import { CASCADE_SKIPS } from '@/modules/wms/ftl/service';

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
  ftl: {
    errors: Record<string, string>;
    skip: Record<string, string>;
    reach: Record<string, string>;
    leadErrors: Record<string, string>;
  };
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
    // Asked BEFORE the transaction (#714), only when there is a deal to read
    // and a presser who vouches (absent door = no inheritance).
    expect(body).toMatch(/const ftlOn = input\.clientId && input\.dealId && ftlDoor \? await ftlReady\(\) : false;/);
    expect(body.indexOf('await ftlReady()')).toBeLessThan(body.indexOf('db.transaction('));
    // The deal row FOR SHARE before the prixod exists — the cascade holds it FOR NO KEY UPDATE.
    expect(body.indexOf("FROM deals WHERE id = ${input.dealId}::uuid FOR SHARE")).toBeGreaterThan(body.indexOf('db.transaction('));
    expect(body.indexOf('FOR SHARE')).toBeLessThan(body.indexOf('.insert(receipts)'));
    expect(body).toContain('inheritFromDealTx(tx, receipt!.id, ftlDoor, null, ctx)');
  });

  it('the doors that link pass the PRESSER’s door — the receive wizard and the re-file', () => {
    expect(read('src/app/(protected)/receive/actions.ts')).toContain('{ onBehalf, ftlDoor: ftlDoorFor(actor) }');
    expect(read('src/app/(protected)/bitimlar/actions.ts')).toContain('linkReceipt(receiptId, dealId, ctx, ftlDoorFor(actor))');
    const deals = read('src/modules/wms/deals/service.ts');
    const link = bodyOf(deals, 'export async function linkReceipt(');
    // REQUIRED, never optional: an optional door fails OPEN (null = nobody vouches).
    const signature = deals.slice(deals.indexOf('export async function linkReceipt('), deals.indexOf('): Promise<void> {', deals.indexOf('export async function linkReceipt(')));
    expect(signature).toMatch(/\bftlDoor: FtlDoor \| null,\s*$/);
    expect(link).toContain('inheritFromDealTx(tx, receiptId, ftlDoor, ftlLocked, ctx)');
    // A seller's own re-file that carried the mark is told to the office like his own mark.
    expect(link).toMatch(/if \(ftlInherited && ftlDoor && !ftlDoor\.office\) \{\s*await notifyFtlMarked\(/);
    // The gate itself: the office reaches what the mark reaches, anybody else only his own stamp.
    expect(bodyOf(read('src/modules/wms/ftl/service.ts'), 'function inheritSql(')).toContain(
      "opts.presser === null || opts.presser.office ? sql`true` : sql`r.sales_manager_id = ${opts.presser.actorId}::uuid`",
    );
  });

  it('a client correction locks both stamps first and takes back what the old job decided', () => {
    const body = bodyOf(read('src/modules/wms/receipts/edit.ts'), 'export async function assignReceiptClient(');
    const update = body.indexOf('.update(receipts)');
    expect(body.indexOf('takeKpiSellerLocks(tx, [receipt.salesManagerId, client.salesManagerId])')).toBeGreaterThan(-1);
    expect(body.indexOf('takeKpiSellerLocks(')).toBeLessThan(update);
    expect(body.indexOf('dropFtlOnClientChangeTx(tx, receiptId,')).toBeGreaterThan(update);
    expect(body.indexOf('await ftlReady()')).toBeLessThan(body.indexOf('db.transaction('));
    // …keeping only the office's own hand decision.
    expect(bodyOf(read('src/modules/wms/ftl/service.ts'), 'export async function dropFtlOnClientChangeTx(')).toContain(
      "rlm.mode = 'ftl' AND (NOT rlm.hand OR NOT rlm.by_office)",
    );
  });

  it('cargo stamped later takes its seller’s mark, under his lock', () => {
    const body = bodyOf(read('src/modules/wms/staff/stamp.ts'), 'export async function stampUnattributedCargo(');
    expect(body.indexOf('takeKpiSellerLocks(tx, [managerId])')).toBeLessThan(body.indexOf('UPDATE receipts SET sales_manager_id'));
    expect(body.indexOf('inheritStampedTx(tx,')).toBeGreaterThan(body.indexOf('UPDATE receipts SET sales_manager_id'));
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

  it('winLead carries the lead’s mark into EVERY deal it opens', () => {
    // A won lead opens a deal per sale (his Q5 a): the main one and each
    // other sale's — all of them the lead's FTL job (proved red in
    // win-split.integration.test.ts; this pins both call sites).
    const crm = read('src/modules/wms/crm/service.ts');
    expect(bodyOf(crm, 'export async function winLead(').match(/carryFtlFromLead: id\b/g)?.length).toBe(2);
    // The carry lives in the transaction body both creators share (UCH-BAND §7).
    expect(bodyOf(read('src/modules/wms/deals/service.ts'), 'export async function createDealInTx(')).toContain(
      'carryLeadFtlTx(tx, pre.carryFtlFromLead',
    );
    expect(bodyOf(read('src/modules/wms/deals/service.ts'), 'export async function createDeal(')).toContain(
      'createDealInTx(tx, input, ctx,',
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

describe('one migration behind, nothing that worked on 134 breaks', () => {
  it('the celebrations name the side tables only behind the readiness probe — a lost post is never retried', () => {
    const body = strip(read('src/modules/wms/staff/celebrate.ts'));
    for (const fn of ['export async function celebrateLeadWon(', 'async function wonFacts(', 'export async function celebrateFirstCargo(']) {
      const part = bodyOf(body, fn);
      for (const table of ['lead_ftl', 'receipt_load_mode']) {
        for (const m of part.matchAll(new RegExp(`FROM ${table}`, 'g'))) {
          const before = part.slice(Math.max(0, m.index! - 120), m.index!);
          expect(before, `${fn} ${table}`).toMatch(/ftlOn \? sql`(NOT )?EXISTS \(SELECT 1 $/);
        }
      }
    }
  });

  it('the upsale screen and the seller report read ALL cargo when the round is not there', () => {
    expect(read('src/app/(protected)/upsale/page.tsx')).toContain('ftlOn ? KPI_LOAD : \'all\'');
    const report = read('src/modules/wms/crm/seller-report.ts');
    expect(report).toContain("const kpiLoad = ftlOn ? KPI_LOAD : 'all';");
    expect(report).toContain("ftlOn ? KPI_LOAD : 'all'");
  });
});

describe('the form field (S1, A4)', () => {
  it('is uncontrolled, keyed on the stored mode, and a locked chip posts nothing', () => {
    const field = strip(read('src/components/load-mode-field.tsx'));
    expect(field).toContain('defaultValue={load.initial}');
    expect(field).not.toMatch(/value=\{mode\}/);
    expect(field).not.toMatch(/type="hidden" name="loadMode"/);
    for (const form of ['src/app/(protected)/bitimlar/deal-form.tsx', 'src/app/(protected)/crm/leads/lead-form.tsx']) {
      expect(read(form), form).toContain("<LoadModeField key={`load-${load?.initial ?? 'none'}`} load={load ?? null} />");
    }
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
      for (const why of CASCADE_SKIPS) {
        expect(m.ftl.skip[why], `${locale} ftl.skip.${why}`).toBeTruthy();
      }
      for (const why of ['other_client', 'kpi_paid', 'no_seller', 'other_seller', 'linked']) {
        expect(m.ftl.reach[why], `${locale} ftl.reach.${why}`).toBeTruthy();
      }
      for (const code of ['ftl_office_only', 'ftl_not_yours']) {
        expect(m.ftl.leadErrors[code], `${locale} ftl.leadErrors.${code}`).toBeTruthy();
      }
    }
    expect(isFtlRefusal('ftl_office_only')).toBe(true);
    expect(isFtlRefusal('bad_number')).toBe(false);
  });
});
