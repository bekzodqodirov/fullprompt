import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The yo'lkira-tarifi split's wiring (docs/YOLKIRA-TAQSIMOT.md §11). Each rule
 * here is something no behavioural test can see — a second caller that
 * agrees today, an import that works until the module graph closes a loop, a
 * read of the live tariff that gives the same answer until he edits a row.
 * Source shape, comments stripped first (#725: a fence matching the sentence
 * that explains it tests nothing).
 */
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}
const SRC = walk('src');
const COSTING = SRC.filter((f) => f.startsWith('src/modules/wms/costing/'));

/** The body of a top-level function, by brace matching from its declaration. */
function body(src: string, signature: string): string {
  const at = src.indexOf(signature);
  expect(at, `no ${signature}`).toBeGreaterThan(-1);
  // The body opens with the first brace that ENDS a line — a return type's
  // `{ … }` literal never does.
  const open = src.indexOf(' {\n', at) + 1;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced ${signature}`);
}

describe('one pool', () => {
  it('allocateEntry is called only by costing/pool.ts', () => {
    const callers = SRC.filter((f) => /\ballocateEntry\(/.test(strip(read(f))) && !f.endsWith('costing/engine.ts'));
    expect(callers).toEqual(['src/modules/wms/costing/pool.ts']);
  });

  it('the recompute and the void guard both go through costPool + loadPoolInputs', () => {
    const service = strip(read('src/modules/wms/costing/service.ts'));
    const recompute = body(service, 'export async function recomputeEntry(');
    expect(recompute).toMatch(/loadPoolInputs\(entry, ids, tx\)/);
    expect(recompute).toMatch(/costPool\(/);
    const guard = strip(read('src/modules/wms/costing/void-guard.ts'));
    expect(guard).toMatch(/homed\(\s*costPool\(/);
    expect(guard).toMatch(/loadPoolInputs\(entry, boxIds, tx\)/);
  });

  it('the copy is read only behind basis «freight» (a weight recompute never touches the side table)', () => {
    const service = strip(read('src/modules/wms/costing/service.ts'));
    const load = body(service, 'export async function loadPoolInputs(');
    const guard = load.indexOf("if (entry.allocationBasis !== 'freight') return { measures, freight: null };");
    const copyRead = load.indexOf('freightCopyFor(entry.id, handle)');
    expect(guard).toBeGreaterThan(-1);
    expect(copyRead).toBeGreaterThan(guard);
  });

  it('the recompute, the pool and the void guard never read the LIVE tariff', () => {
    const forbidden = /calc_freight_tariffs|calcFreightTariffs|tariff-read|\btariffFor\b|\btariffHistory\b|\bfreightSplitZone\b/;
    const service = strip(read('src/modules/wms/costing/service.ts'));
    expect(body(service, 'export async function recomputeEntry(')).not.toMatch(forbidden);
    expect(body(service, 'export async function loadPoolInputs(')).not.toMatch(forbidden);
    expect(strip(read('src/modules/wms/costing/pool.ts'))).not.toMatch(forbidden);
    expect(strip(read('src/modules/wms/costing/void-guard.ts'))).not.toMatch(forbidden);
  });
});

describe('one home for the frozen copy', () => {
  it('cost_entry_tariffs is named only by freight-copy.ts, the schema and the migration', () => {
    const naming = SRC.filter((f) => /cost_entry_tariffs|costEntryTariffs/.test(strip(read(f))));
    // freight-ready.ts names it in its catalog probe (to_regclass) — a
    // question about the schema, never a read of a row.
    expect(naming.sort()).toEqual(
      [
        'src/modules/platform/db/schema/wms.ts',
        'src/modules/wms/costing/freight-copy.ts',
        'src/modules/wms/costing/freight-ready.ts',
      ].sort(),
    );
  });
});

describe('the module graph', () => {
  it('no file under costing imports calc/dictionaries or calc/service (the costing ↔ calc loop)', () => {
    for (const f of COSTING) {
      expect(strip(read(f)), f).not.toMatch(/from ['"](\.\.\/calc|@\/modules\/wms\/calc)\/(dictionaries|service)['"]/);
    }
  });

  it('the leaves never import ./service (a static cycle crashes a top-level extends at load)', () => {
    for (const leaf of ['freight-copy', 'freight-zone', 'freight-ready', 'customs-ids', 'errors', 'pool', 'freight-split', 'freight-types']) {
      const rel = `src/modules/wms/costing/${leaf}.ts`;
      if (!existsSync(path.join(ROOT, rel))) continue;
      expect(strip(read(rel)), rel).not.toMatch(/from ['"]\.\/service['"]/);
    }
  });

  it('freight-split.ts and pool.ts stay pure (no database, no node)', () => {
    for (const rel of ['src/modules/wms/costing/freight-split.ts', 'src/modules/wms/costing/pool.ts', 'src/modules/wms/costing/freight-types.ts']) {
      const imports = [...strip(read(rel)).matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const i of imports) expect(['../calc/pricing', './engine', './freight-split', './freight-types'], `${rel}: ${i}`).toContain(i);
    }
  });
});

describe('the lot door heals a freight split', () => {
  it("editLot's re-split gate names measureChange, not only the rounded totals", () => {
    const edit = strip(read('src/modules/wms/receipts/edit.ts'));
    expect(edit).toMatch(
      /if \(result\.labelsToPrint > 0 \|\| result\.labelsToDestroy\.length > 0 \|\| totalsChanged \|\| measureChange\) \{/,
    );
  });
});

describe('his 1a (2026-10-15): ONE column for every truck, nothing per warehouse', () => {
  it('the column has one source, a zero-import leaf, and it is his seeded Yiwu/Guangzhou → Toshkent column', async () => {
    const leaf = strip(read('src/modules/wms/costing/freight-zone.ts'));
    expect(leaf).not.toMatch(/^import /m);
    const { freightSplitZone } = await import('@/modules/wms/costing/freight-zone');
    const { OWNER_TARIFF_ZONES } = await import('@/modules/wms/calc/tariff-seed');
    expect(freightSplitZone()).toBe('cn');
    expect(OWNER_TARIFF_ZONES as readonly string[]).toContain(freightSplitZone());
  });

  it('the save and the preview take the zone from it, and only they build a copy', () => {
    for (const rel of ['src/modules/wms/costing/freight-copy.ts', 'src/modules/wms/costing/freight-offer.ts']) {
      const src = strip(read(rel));
      expect(src, rel).toContain('const zone = freightSplitZone();');
      expect(src, rel).toMatch(/copyDraft\(zone, /);
    }
    const builders = SRC.filter((f) => /\bcopyDraft\(/.test(strip(read(f))) && !f.endsWith('costing/freight-split.ts'));
    expect(builders.sort()).toEqual(['src/modules/wms/costing/freight-copy.ts', 'src/modules/wms/costing/freight-offer.ts']);
  });

  it('the retired mapping table is named by the schema alone (kept for its rows, read by nobody)', () => {
    const naming = SRC.filter((f) => /warehouse_tariff_columns|warehouseTariffColumns/.test(strip(read(f))));
    expect(naming).toEqual(['src/modules/platform/db/schema/wms.ts']);
  });

  it('no file reaches for the removed door', () => {
    const door = /\btariffColumnOf\b|\bmappableZones\b|\bsetTariffColumnInTx\b|\breadTariffZoneField\b|tariff-column['"]|tariff-zone-field['"]|wh-tariff-zone|\bno_column\b|\bmayFixColumn\b/;
    for (const f of SRC) expect(strip(read(f)), f).not.toMatch(door);
  });

  it('the warehouse form, its pages and its actions carry no tariff column; the update keeps its one transaction', () => {
    for (const rel of [
      'src/app/(protected)/admin/warehouses/actions.ts',
      'src/app/(protected)/admin/warehouses/warehouse-form.tsx',
      'src/app/(protected)/admin/warehouses/new/page.tsx',
      'src/app/(protected)/admin/warehouses/[id]/page.tsx',
    ]) {
      const src = strip(read(rel));
      expect(src, rel).not.toMatch(/tariffZone|freight-ready|costing\//);
    }
    const actions = strip(read('src/app/(protected)/admin/warehouses/actions.ts'));
    const update = body(actions, 'export async function updateWarehouseAction(');
    expect(update).toMatch(/db\.transaction\(async \(tx\) => \{[\s\S]*writeAudit\(\s*tx,/);
  });

  it('the readiness probe names only the copy table (the mapping table will be dropped)', () => {
    const probe = strip(read('src/modules/wms/costing/freight-ready.ts'));
    expect(probe).toContain("to_regclass('public.cost_entry_tariffs')");
    expect(probe).not.toMatch(/warehouse_tariff_columns/);
  });
});

describe('his 2b (2026-10-15): every reader of a split is keyed by LOT', () => {
  it('the saved fold’s cents are keyed by the lot, the same key the view’s rows carry', () => {
    const offer = strip(read('src/modules/wms/costing/freight-offer.ts'));
    expect(offer).toContain("'l:' || b.lot_id::text AS k");
    expect(offer).not.toMatch(/'c:' \|\| ca\.client_id/);
  });

  it('the Narx tab names a part’s bands through the ONE pure rule, over the lots its money sits on (judge J1/J21)', () => {
    const pricing = strip(read('src/app/(protected)/batches/[id]/pricing/page.tsx'));
    expect(pricing).toMatch(/clientBandLine\(freightViews\.get\(part\.freightEntryId\)\?\.view, `c:\$\{clientId\}`, part\.freightLotIds/);
    // The part's lot ids come from the rows that make its dollars, never a second membership rule.
    const service = strip(read('src/modules/wms/costing/service.ts'));
    const breakdown = body(service, 'export async function batchClientCostBreakdown(');
    expect(breakdown).toContain("CASE WHEN ce.allocation_basis = 'freight' THEN bx.lot_id::text END AS freight_lot_id");
    expect(breakdown).toMatch(/GROUP BY [^\n]*freight_entry_id, freight_lot_id/);
    // The lot row's % divides THIS truck's dollars of the lot by the bill (the review as built).
    expect(pricing).toMatch(/usd \/ explained\.amountUsd/);
    // The lot row's own % of each bill (judge J36) reads the same views and the same lot ids.
    expect(pricing).toMatch(/part\.freightLotIds\.includes\(lot\.lotId\)/);
    expect(pricing).toMatch(/const explained = freightViews\.get\(part\.freightEntryId\);\s*const row = splitLot\(explained\?\.view, lot\.lotId\)/);
    for (const f of SRC) expect(strip(read(f)), f).not.toMatch(/\bsplitGroup\b|\bfreightGroups\b|\blightLots\b|\bHeldGroup\b|\bGroupView\b/);
  });

  it('the re-basis token covers the after split’s lots, and its rows carry no single band', () => {
    const rebase = strip(read('src/modules/wms/costing/rebase.ts'));
    expect(rebase).toMatch(/split \? split\.lots\.map\(\(l\) => \[l\.key, l\.share\]/);
    expect(rebase).not.toMatch(/bands\.set\(/);
    // The after split is built by `splitView` alone — the one producer that honours the money sight (judge J5).
    expect(rebase).toMatch(/verdict\.kind === 'split' \? splitView\(verdict, money\) : null/);
  });

  it('a bill’s cents have ONE rule: only freight-split.ts calls splitCents; the fold, the preview and the re-basis rows ask lotCents (judge J2/J14/J22)', () => {
    const callers = SRC.filter((f) => /\bsplitCents\(/.test(strip(read(f))) && !f.endsWith('costing/freight-split.ts'));
    expect(callers).toEqual([]);
    for (const rel of ['src/modules/wms/costing/freight-offer.ts', 'src/modules/wms/costing/rebase.ts', 'src/components/freight-views.tsx']) {
      expect(strip(read(rel)), rel).toMatch(/\blotCents\(/);
    }
    for (const rel of ['src/modules/wms/costing/rebase.ts', 'src/components/freight-views.tsx']) {
      expect(strip(read(rel)), rel).toMatch(/\bclientCentsOf\(/);
    }
  });

  it('the ✎ after-fold draws the server’s per-lot cents, never this browser re-splitting a nominal 100 (judge J14)', () => {
    const panel = strip(read('src/components/cost-panel.tsx'));
    const fold = panel.slice(panel.indexOf('data-testid="cost-rebase-lots"'), panel.indexOf('testid="cost-rebase-lot"'));
    expect(fold).toContain('cents={preview.money ? preview.afterLotCents : undefined}');
    expect(fold).toContain('amount={null}');
  });

  it('/admin/tarif says when the one column would not split a bill, through the save’s own constructor (judge J31)', () => {
    const page = strip(read('src/app/(protected)/admin/tarif/page.tsx'));
    expect(page).toContain('const zone = freightSplitZone();');
    expect(page).toMatch(/columnWatch\(zone, history, tashkentDay\(\), FREIGHT_LIGHT_BELOW\)/);
    const split = strip(read('src/modules/wms/costing/freight-split.ts'));
    expect(body(split, 'export function columnWatch(')).toMatch(/copyDraft\(zone, history, from, lightBelow, ''\)/);
  });

  it('every producer of a split view asks the ONE money sight (#790/#791 — never a finance.manage gate)', () => {
    const offer = strip(read('src/modules/wms/costing/freight-offer.ts'));
    const rebase = strip(read('src/modules/wms/costing/rebase.ts'));
    // From the signature to the next export — `body()` stops at a parameter's `{` that ends a line.
    const upToNext = (src: string, fn: string) => {
      const at = src.indexOf(fn);
      expect(at, fn).toBeGreaterThan(-1);
      const next = src.indexOf('\nexport ', at + fn.length);
      return src.slice(at, next < 0 ? undefined : next);
    };
    for (const fn of ['export async function freightOffer(', 'export async function explainFreightBills(']) {
      expect(upToNext(offer, fn), fn).toContain('const money = freightMoneySight(actor.permissions);');
    }
    expect(body(rebase, 'export async function rebaseCost(')).toContain('const money = freightMoneySight(actor.permissions);');
    for (const src of [offer, rebase]) expect(src).not.toMatch(/permissions\.has\('finance\.manage'\)/);
  });

  it('the batched explain hands each truck its cartons in box order, as boxMeasures does (the review as built)', () => {
    const offer = strip(read('src/modules/wms/costing/freight-offer.ts'));
    expect(offer).toContain('[...ids].sort().flatMap(');
  });

  it('the offer gives no whole-split slot to a version no save can choose (judge J16)', () => {
    const offer = strip(read('src/modules/wms/costing/freight-offer.ts'));
    expect(offer).toMatch(/const dates = allDates\.filter\(\(d\) => d <= last\);/);
    expect(offer).toContain('firstFrom: allDates.at(-1) ?? null,');
  });
});

describe('the browser bundle stays free of the database', () => {
  it('the cost panel and the freight views import only pure costing values (#276)', () => {
    const SERVER = /costing\/(service|freight-offer|freight-copy|freight-ready|rebase|customs-ids|cost-entry)['"]/;
    for (const rel of ['src/components/cost-panel.tsx', 'src/components/freight-views.tsx']) {
      const lines = strip(read(rel))
        .split('\n')
        .filter((l) => /^import /.test(l) && SERVER.test(l));
      for (const line of lines) expect(line, `${rel}: a value import from a server module`).toMatch(/^import type /);
    }
  });

  it('the reason line is drawn only under a freight type (SP-5)', () => {
    const panel = strip(read('src/components/cost-panel.tsx'));
    expect(panel).toMatch(/const isFreightType = flags\.freightTypeIds\.includes\(typeId\);/);
    expect(panel).toMatch(/\{isFreightType && offered\.includes\('freight'\) && !usable\.ok && freight && \(/);
  });

  it('the panel posts the digest of the version its preview drew (M6)', () => {
    const panel = strip(read('src/components/cost-panel.tsx'));
    expect(panel).toMatch(/basis === 'freight' && usable\.ok && usable\.version \? \{ freightSeen: usable\.version\.digest \}/);
  });
});


describe('the re-basis door (§8)', () => {
  const REBASE = strip(read('src/modules/wms/costing/rebase.ts'));
  const ACTIONS = strip(read('src/app/(protected)/costs/actions.ts'));

  it('touches the copy only when freight is on EITHER side (DS1 — a weight → volume move works one migration behind)', () => {
    expect(REBASE).toContain("const fromCopy: FromCopy = entry.allocationBasis === 'freight' ? await freightCopyFor(entry.id) : 'none';");
    expect(REBASE).toContain("const fromCopy: FromCopy = fromBasis === 'freight' ? await freightCopyFor(entryId, tx) : 'none';");
    expect(REBASE).toContain(
      "if (fromBasis === 'freight' || toBasis === 'freight') await replaceFreightCopyInTx(tx, entryId, planned.to);",
    );
  });

  it('the save locks the entry first, judges the void under the lock, and deletes the shares before the basis moves', () => {
    const save = body(REBASE, 'async function saveRebaseInTx(');
    const lock = save.indexOf(".for('update')");
    const voided = save.indexOf("if (!locked || locked.voidedAt) return 'voided';");
    const del = save.indexOf('await tx.delete(costAllocations).where(eq(costAllocations.costEntryId, entryId));');
    const update = save.indexOf('.update(costEntries)');
    expect(lock).toBeGreaterThan(-1);
    expect(voided).toBeGreaterThan(lock);
    expect(del).toBeGreaterThan(voided);
    expect(update).toBeGreaterThan(del);
  });

  it('never writes the money (only the basis and, leaving direct_to_client, the client)', () => {
    const save = body(REBASE, 'async function saveRebaseInTx(');
    expect(save).toContain(".set({ allocationBasis: toBasis, ...(fromBasis === 'direct_to_client' ? { clientId: null } : {}) })");
    expect(save).not.toMatch(/amount|currency|fxRate|partnerId|accountId|mergedExpenseId/);
  });

  it('the action asks the door and answers every refusal through costRefusal and the lagging-server mapping', () => {
    const action = body(ACTIONS, 'export async function rebaseCostAction(');
    expect(action).toContain("authorize('costs.enter_batch', { warehouseId: batch.originWarehouseId })");
    expect(action).toContain("if (!mayEnterBatchCost(actor, batch)) return { ok: false, error: 'cancelled' };");
    expect(action).toContain('if (costSightFor(actor).ownOnly && entry.enteredBy !== actor.id) {');
    expect(action).toContain('if (err instanceof CostError) return costRefusal(err);');
    expect(action).toContain("if (freightServerBehind(err)) return { ok: false, error: 'server_behind' };");
  });
});

describe('the review’s screen fixes stay put', () => {
  const PANEL = strip(read('src/components/cost-panel.tsx'));
  const VIEWS = strip(read('src/components/freight-views.tsx'));
  const PRICING = strip(read('src/app/(protected)/batches/[id]/pricing/page.tsx'));

  it('a stale-preview refusal refreshes the offer, or every press re-posts the old digest (M6)', () => {
    expect(PANEL).toContain("if (res.error?.startsWith('freight_')) router.refresh();");
  });

  it('the entry page carries only a basis the person CHOSE (his 4a on the next truck)', () => {
    expect(PANEL).toContain("const nextBasis = touched && chosenValid && chosen !== 'direct_to_client' ? chosen : undefined;");
    expect(PANEL).toMatch(/onKept\?\.\(\{ typeId, currency, costDate, payer, basis: nextBasis \}\)/);
  });

  it('a row on no box is marked whatever its basis — every cost card computes it from the same fact', () => {
    expect(PANEL).toContain('{(entry.unsplit || entry.freight?.unsplit) && (');
    for (const page of [
      'src/app/(protected)/batches/[id]/xarajatlar/page.tsx',
      'src/app/(protected)/accounting/sarflar/kiritish/page.tsx',
      'src/app/(protected)/receipts/[id]/page.tsx',
      'src/app/(protected)/crates/[id]/page.tsx',
      'src/app/(protected)/zavod/[id]/page.tsx',
    ]) {
      expect(strip(read(page)), page).toContain('unsplit: entry.amountUsd !== null && !hasShare,');
    }
  });

  it('the preview’s lot links open a new tab (a same-tab click threw the typed amount away)', () => {
    const links = [...VIEWS.matchAll(/<a className="underline" href=\{`\/receipts\/\$\{lot\.receiptId\}`\}([^>]*)>/g)];
    expect(links.length).toBe(2);
    for (const link of links) expect(link[1]).toContain('target="_blank"');
  });

  it('a saved bill’s fold says «saved», the preview «will be saved»', () => {
    expect(VIEWS).toContain("t(saved ? 'freightHeldTitle' : 'freightPreviewHeld')");
    expect(PANEL).toMatch(/testid="cost-freight-row"\s+saved\s+\/>/);
  });

  it('the open-cargo sentence is never suppressed by a held later leg, and a feeding truck says both its sums', () => {
    expect(PRICING).not.toMatch(/laterHeld/);
    expect(PRICING).toContain('{row.unconverted > 0 &&');
    expect(PRICING).toMatch(/\{row\.usd !== null && t\('unsplitCarried'/);
  });

  it('the «bo’linmagan» view offers no XLSX of the tracked table, and names trucks that have not left', () => {
    const profit = strip(read('src/app/(protected)/accounting/profit/page.tsx'));
    expect(profit).toContain('exportHref={unsplitOnly ? undefined : `/api/accounting/profit?view=${view}`}');
    expect(profit).toContain("unsplitOnly ? unsplitOnFormingTrucks() : Promise.resolve([]),");
  });
});

describe('every money screen that reads «on no box» names a held bill apart (§6.7)', () => {
  // The four readers the fix review found still calling a held bill «a truck
  // with no cargo — void it»: each splits it by the ONE fragment and each
  // screen draws what its service returns. The integration file
  // (freight-held-reports) proves the figures; this pins the drawing.
  it('the services ask heldFreightSql — never a basis test of their own', () => {
    const reports = strip(read('src/modules/wms/accounting/reports.ts'));
    expect(body(reports, 'export async function pnlGaps(')).toContain('heldFreightSql(');
    expect(body(reports, 'export async function clientProfitGaps(')).toContain('heldFreightSql(');
    expect(body(strip(read('src/modules/wms/reports/queries.ts')), 'export async function heldFreightCosts(')).toContain(
      'heldFreightSql(',
    );
    for (const f of SRC.filter((f) => !f.startsWith('src/modules/wms/costing/'))) {
      expect(strip(read(f)), f).not.toMatch(/allocation_basis\s*=\s*'freight'\s+AND/);
    }
  });

  it('each screen draws its held figure', () => {
    const screens: [string, string, string][] = [
      ['src/app/(protected)/accounting/pnl-gaps.tsx', 'pnl-gap-freight-held', 'gaps.freightHeld'],
      ['src/app/(protected)/accounting/profit/page.tsx', 'profit-client-freight-held', 'unallocated.heldFreight'],
      ['src/app/(protected)/bitimlar/[id]/page.tsx', 'deal-profit-freight-held', 'profit.heldFreight'],
      ['src/app/(protected)/reports/landed-cost/page.tsx', 'landed-freight-held', 'heldFreightCosts()'],
    ];
    for (const [file, testid, reads] of screens) {
      const src = strip(read(file));
      expect(src, file).toContain(`data-testid="${testid}"`);
      expect(src, file).toContain(reads);
    }
  });
});
