import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The annul round's wiring: the owner-only gate asked from ONE home on both
 * sides of every door (#531), the money folded into the cargo's transaction,
 * the terminal box write shared with voidReceipt (#513), and the
 * «a void box is not cargo» rule closed over EVERY movement-based aggregate
 * — the design review found the rule hand-written in ten places and missing
 * from six of them. Source-shape, comments stripped first (#725).
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const read = (path: string) => strip(readFileSync(path, 'utf8'));

describe('the gate — super_admin, one home, both sides of every door', () => {
  it('mayAnnul is the single writer of the rule', () => {
    const annul = read('src/modules/wms/receipts/annul.ts');
    expect(annul).toContain("roles.includes('super_admin')");
    expect(annul).toMatch(/if \(!mayAnnul\(actor\)\) throw new AnnulError\('annul_forbidden'\)/);
  });

  it('both actions authorize WITHOUT a warehouse and re-check the role', () => {
    for (const [path, fn] of [
      ['src/app/(protected)/receipts/[id]/actions.ts', 'annulReceiptAction'],
      ['src/app/(protected)/admin/anulirovka/actions.ts', 'bulkAnnulAction'],
    ] as const) {
      const src = read(path);
      const body = src.slice(src.indexOf(`export async function ${fn}`));
      expect(body, path).toContain("authorize('receipts.void')");
      expect(body, path).toContain('mayAnnul(actor)');
    }
  });

  it('the registry page opens on the audit door and offers the annul half only to mayAnnul', () => {
    const page = read('src/app/(protected)/admin/anulirovka/page.tsx');
    expect(page).toContain("permissions.has('admin.audit.browse')");
    expect(page).toContain('mayAnnul(actor)');
    const doors = read('src/app/(protected)/admin/hub-doors.ts');
    expect(doors).toMatch(/anulirovka[\s\S]{0,120}admin\.audit\.browse/);
  });

  it('the super_admin ROLE cannot be self-assigned: both users actions guard the change', () => {
    const src = read('src/app/(protected)/admin/users/actions.ts');
    expect(
      [...src.matchAll(/actor\.roles\.includes\('super_admin'\)/g)].length,
    ).toBeGreaterThanOrEqual(2);
    expect(src).toContain("'super_admin_locked'");
  });
});

describe('the cascade — one transaction, one terminal writer', () => {
  it('the money voids INSIDE the annul transaction, via the shared in-tx core', () => {
    const annul = read('src/modules/wms/receipts/annul.ts');
    const tx = annul.slice(
      annul.indexOf('db.transaction'),
      annul.indexOf('export interface AftermathResult'),
    );
    expect(tx).toContain('voidCostEntryInTx(tx,');
    // The refusals live in the SAME transaction, before any write.
    expect(tx.indexOf("'box_on_active_plan'")).toBeLessThan(tx.indexOf('voidCostEntryInTx'));
  });

  it('voidReceipt and the annul write the terminal state through ONE helper', () => {
    for (const path of [
      'src/modules/wms/receipts/service.ts',
      'src/modules/wms/receipts/annul.ts',
    ]) {
      expect(read(path), path).toContain('voidBoxRows(tx,');
    }
    const helper = read('src/modules/wms/receipts/void-box.ts');
    // The cleared pointers ARE the fence: a void box still pointing at a
    // batch rides batchMemberFilter for ever.
    expect(helper).toContain('currentBatchId: null');
    expect(helper).toContain('crateId: null');
  });

  it('the aftermath is re-runnable: an annulled receipt re-runs it instead of refusing', () => {
    const annul = read('src/modules/wms/receipts/annul.ts');
    const repair = annul.slice(annul.indexOf('if (existing.voidedAt)'));
    expect(repair.slice(0, 400)).toContain('annulAftermath');
  });

  it('the empty-scope sweep judges the SCOPE, never the allocation count', () => {
    const annul = read('src/modules/wms/receipts/annul.ts');
    expect(annul).toContain('await scopeBoxIds(entry)');
    expect(annul).toMatch(/scope\.length > 0\) continue/);
  });
});

describe('«a void box is not cargo» — the closed set', () => {
  it('scopeBoxIds excludes void boxes in ALL THREE branches', () => {
    const src = read('src/modules/wms/costing/service.ts');
    const fn = src.slice(
      src.indexOf('export async function scopeBoxIds'),
      src.indexOf('export async function recomputeEntry'),
    );
    expect([...fn.matchAll(/ne\(boxes\.status, 'void'\)/g)].length).toBeGreaterThanOrEqual(4);
  });

  it('every movement-aggregate surface carries the exclusion, and no file is unaccounted for', () => {
    // The surfaces that answer «what is / was on this truck» as a FIGURE.
    const FIXED = [
      'src/modules/wms/reports/queries.ts',
      'src/modules/wms/accounting/reports.ts',
      'src/modules/wms/costing/service.ts',
      'src/app/(protected)/batches/[id]/pricing/page.tsx',
      'src/app/(protected)/batches/page.tsx',
      'src/app/(protected)/trucks/page.tsx',
      'src/modules/wms/finance/client-cargo.ts',
      'src/modules/wms/tracking/truck.ts',
      'src/modules/wms/arrivals/service.ts',
      'src/modules/wms/bot/lookup.ts',
    ];
    // History-keepers and writers, deliberately WITHOUT the exclusion: the
    // manifest and the customs documents record what rode (round 92 — a
    // document must not change its claims on re-download), the scanners
    // WRITE the movements, membership/attribution queries resolve ids and
    // not figures, and the cabinet/notices filter by live box status already.
    const HISTORICAL = [
      'src/modules/wms/scanning/service.ts',
      'src/modules/wms/scanning/unload.ts',
      'src/modules/wms/documents/arrivals.ts',
      'src/modules/wms/notices/arrival.ts',
      'src/modules/wms/deals/auto-stage.ts',
      'src/modules/wms/deals/service.ts',
      'src/modules/wms/calc/actuals.ts',
      'src/modules/wms/client-cabinet/service.ts',
      'src/modules/wms/client-cabinet/journey.ts',
      'src/modules/wms/crm/feed.ts',
      'src/modules/wms/planning/service.ts',
      'src/modules/wms/receipts/annul.ts',
      'src/modules/platform/ai/schema-card.ts',
    ];
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && readFileSync(p, 'utf8').includes('batch_departed')) {
          found.push(p.replace(/\\/g, '/'));
        }
      }
    };
    walk('src');
    for (const path of FIXED) {
      const src = readFileSync(path, 'utf8');
      expect(src, `${path} must exclude void boxes`).toMatch(/void/);
      expect(
        /(<> 'void'|ne\(boxes\.status, 'void'\)|status <> 'void'|status = 'void')/.test(src),
        `${path} carries no void exclusion near its batch_departed aggregate`,
      ).toBe(true);
    }
    // The CLOSED set: a new file aggregating over batch_departed must choose
    // a list — figures exclude void, history keeps it — or this goes red.
    const known = new Set([...FIXED, ...HISTORICAL]);
    const strangers = found.filter((p) => !known.has(p));
    expect(strangers, `unaccounted batch_departed consumers: ${strangers.join(', ')}`).toEqual([]);
  });

  it('the bot names only a CONFIRMED receipt as the last prixod', () => {
    const src = read('src/modules/wms/bot/lookup.ts');
    const fn = src.slice(src.indexOf('lastReceipt'));
    expect(fn.slice(0, 500)).toContain("eq(receipts.status, 'confirmed')");
  });
});
