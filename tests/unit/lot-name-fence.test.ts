import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Russian name a lot is SHOWN under follows its tarkib (the owner's items
 * 3-4, 2026-11-10; docs/TARKIB-TUZATISH.md §3): one good → its name, several
 * → «first +N». It is DERIVED at read time and has ONE home,
 * `wms/receipts/lot-name.ts`; the stored `receipt_lots.product_name_ru` stays
 * the warehouse's own word and goes on being read as IDENTITY — by the
 * sticker, the customs papers, the TNVED memory, the price history, the ✏️
 * form.
 *
 * So there are two kinds of reader, and a new one must say which it is. A
 * list written tomorrow with `receiptLots.productNameRu` in its select would
 * print the warehouse's name beside forty lists that print the tarkib's — and
 * nothing would fail: the screen simply shows yesterday's name. This fence is
 * derived from the tree, so that reader is red the day it is written.
 *
 *  (1) THE COLUMN — every `receiptLots.productNameRu` (drizzle) and every
 *      `product_name_ru` (raw SQL) is counted per file against a list with
 *      EXACT counts and the reason the stored name is read there. Zero
 *      anywhere else; a stale entry is red too.
 *  (2) THE PROPERTY — every file that names `productNameRu` at all is
 *      CLASSIFIED: `shown` (prints a field its reader filled through
 *      lot-name.ts), `own` (identity — the stored name on purpose), `writer`,
 *      `both` (a row that carries the stored name AND the shown one beside
 *      it). A file that starts naming it is red until somebody decides.
 *  (3) ONE «+N» — the label's ` +N` is concatenated in SQL in lot-name.ts
 *      alone, and the three lists that already print «first +N» over SEVERAL
 *      lots count goods KINDS, so they never print «Клавиатура +2 +1».
 *
 * Comments are stripped first (#725). BLIND SPOT, decided: (2) cannot tell a
 * `shown` file that later starts reading a WHOLE lot row's own name from one
 * that still reads the swapped field — the per-package tests
 * (`lot-name-warehouse` / `lot-name-office.integration.test.ts`) read a
 * tarkib back through each reader and are what goes red there.
 */

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

const FILES = walk('src').map((path) => ({ path, src: strip(readFileSync(path, 'utf8')) }));
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

/** (1) The stored column, read directly: file → [drizzle reads, raw-SQL mentions, why]. */
const STORED: Record<string, [number, number, string]> = {
  'src/modules/platform/db/schema/wms.ts': [0, 2, 'the columns themselves: receipt_lots and the TNVED memory'],
  'src/modules/wms/receipts/lot-name.ts': [0, 2, 'the home: the label falls back to the stored name'],
  // The probe-off branch — a server one migration behind prints the stored name (#472).
  'src/modules/wms/planning/stock.ts': [2, 0, 'the plan editor’s two lists, lotChecksReady() false'],
  'src/app/(protected)/stock/page.tsx': [1, 0, 'the stock table, lotChecksReady() false'],
  'src/app/api/reports/stock/route.ts': [1, 0, 'the Ostatka XLSX, lotChecksReady() false'],
  // Search arms: the word on the sticker must go on finding the carton — the tarkib's arm is ORed beside it.
  'src/modules/wms/inventory/stock-filter.ts': [1, 0, 'the stock search’s stored arm'],
  'src/modules/wms/search/service.ts': [1, 0, '⌘K’s stored arm'],
  'src/modules/platform/broadcast/service.ts': [0, 1, 'the broadcast’s goods filter, stored arm'],
  'src/modules/wms/scanning/count-load.ts': [
    0,
    10,
    'three selects alias the SHOWN name as product_name_ru (and type + read it); ONE stored arm in the picker’s search',
  ],
  // Identity.
  'src/modules/wms/batches/lots.ts': [1, 0, 'BatchLot.productNameRu — the price history’s needle; shownNameRu sits beside it'],
  'src/modules/wms/finance/price-history.ts': [0, 2, 'the trigram needle of «Oldingi narx»'],
  'src/modules/wms/finance/similar-ai.ts': [0, 2, 'the similarity and the names the model picks from'],
  'src/modules/wms/labels/qrless.ts': [1, 0, 'the sticker — what the warehouse wrote on the carton'],
  'src/modules/wms/issue/service.ts': [2, 0, 'the STORED «berildi» payload — a label is never stored as a name'],
  'src/modules/wms/receipts/lot-check.ts': [0, 1, 'the tick’s lock statement; the snapshot itself reads lotRuShownSql'],
  'src/modules/wms/tnved/service.ts': [0, 1, 'tnved_assignments.product_name_ru — the memory’s own column'],
};

/** (2) Every file that names the property, and what it does with it. */
type Kind = 'shown' | 'own' | 'writer' | 'both' | 'schema';
const NAMES: Record<string, Kind> = {
  'src/modules/platform/db/schema/wms.ts': 'schema',
  'src/modules/platform/audit/fields.ts': 'schema',
  // The writers: the receive wizard, the ✏️ form and their services.
  'src/app/(protected)/receive/receive-wizard.tsx': 'writer',
  'src/app/(protected)/receipts/[id]/edit-actions.ts': 'writer',
  'src/app/(protected)/receipts/[id]/lot-edit-form.tsx': 'writer',
  'src/modules/wms/receipts/edit.ts': 'writer',
  'src/modules/wms/receipts/service.ts': 'writer',
  // Identity: the stored name on purpose.
  'src/app/(protected)/batches/[id]/tnved/actions.ts': 'own',
  'src/app/(protected)/inventory/qrless-print-list.tsx': 'own',
  'src/app/api/pricing/similar/[lotId]/route.ts': 'own',
  'src/modules/platform/notifications/service.ts': 'own',
  'src/modules/wms/documents/agent-xlsx.ts': 'own',
  'src/modules/wms/documents/packing-photos-xlsx.ts': 'own',
  'src/modules/wms/documents/ved-xlsx.ts': 'own',
  'src/modules/wms/finance/price-history.ts': 'own',
  'src/modules/wms/inventory/stock-filter.ts': 'own',
  'src/modules/wms/issue/service.ts': 'own',
  'src/modules/wms/labels/qrless.ts': 'own',
  'src/modules/wms/labels/sheet.ts': 'own',
  'src/modules/wms/receipts/lot-composition.ts': 'own',
  'src/modules/wms/tnved/batch-lots.ts': 'own',
  'src/modules/wms/tnved/service.ts': 'own',
  // A row that carries both, or a file that prints one and keys on the other.
  'src/app/(protected)/batches/[id]/pricing/page.tsx': 'both',
  'src/app/(protected)/receipts/[id]/page.tsx': 'both',
  'src/modules/wms/batches/lots.ts': 'both',
  'src/modules/wms/planning/stock.ts': 'both',
  'src/modules/wms/search/service.ts': 'both',
  // Display: a field its reader filled through lot-name.ts.
  'src/app/(protected)/batches/[id]/page.tsx': 'shown',
  'src/app/(protected)/batches/[id]/xarajatlar/page.tsx': 'shown',
  'src/app/(protected)/boxes/[id]/page.tsx': 'shown',
  'src/app/(protected)/crates/[id]/page.tsx': 'shown',
  'src/app/(protected)/crates/new/crate-builder.tsx': 'shown',
  'src/app/(protected)/issue/issue-screen.tsx': 'shown',
  'src/app/(protected)/plans/new/plan-editor.tsx': 'shown',
  'src/app/(protected)/reports/client-history/page.tsx': 'shown',
  'src/app/(protected)/reports/landed-cost/page.tsx': 'shown',
  'src/app/(protected)/reports/stock-aging/page.tsx': 'shown',
  'src/app/(protected)/stock/page.tsx': 'shown',
  'src/app/api/crates/boxes/route.ts': 'shown',
  'src/app/api/issue/list/route.ts': 'shown',
  'src/app/api/reports/stock/route.ts': 'shown',
  'src/components/cabinet-app.tsx': 'shown',
  'src/components/client-cargo-history.tsx': 'shown',
  'src/modules/wms/client-cabinet/bot-text.ts': 'shown',
  'src/modules/wms/client-cabinet/map.ts': 'shown',
  'src/modules/wms/client-cabinet/service.ts': 'shown',
  'src/modules/wms/costing/freight-split.ts': 'shown',
  'src/modules/wms/costing/freight-types.ts': 'shown',
  'src/modules/wms/costing/service.ts': 'shown',
  'src/modules/wms/documents/handover-act.ts': 'shown',
  'src/modules/wms/documents/manifest-xlsx.ts': 'shown',
  'src/modules/wms/reports/queries.ts': 'shown',
  'src/modules/wms/reports/stock-xlsx.ts': 'shown',
  'src/modules/wms/reports/xlsx.ts': 'shown',
};

/** Files whose `productNameRu` field must be filled through the home — the readers behind the `shown` screens. */
const FILLED_THROUGH_HOME = [
  'src/app/(protected)/crates/[id]/page.tsx',
  'src/app/(protected)/stock/page.tsx',
  'src/app/api/crates/boxes/route.ts',
  'src/app/api/issue/list/route.ts',
  'src/app/api/reports/stock/route.ts',
  'src/modules/wms/batches/lots.ts',
  'src/modules/wms/client-cabinet/map.ts',
  'src/modules/wms/client-cabinet/service.ts',
  'src/modules/wms/costing/service.ts',
  'src/modules/wms/documents/handover-act.ts',
  'src/modules/wms/documents/manifest-xlsx.ts',
  'src/modules/wms/planning/stock.ts',
  'src/modules/wms/reports/queries.ts',
  'src/modules/wms/search/service.ts',
];

describe('the lot’s shown name has one home', () => {
  it('(1) the stored column is read only where the list says, exactly as often', () => {
    const found: Record<string, [number, number]> = {};
    for (const { path, src } of FILES) {
      const drizzle = count(src, /\breceiptLots\.productNameRu\b/g);
      const raw = count(src, /\bproduct_name_ru\b/g);
      if (drizzle + raw > 0) found[path] = [drizzle, raw];
    }
    const expected = Object.fromEntries(Object.entries(STORED).map(([path, [d, r]]) => [path, [d, r]]));
    // A file that is not on the list reads the warehouse's own word where a
    // screen wants the tarkib's: use `lotRuShownSql` / `lotGoodsShownSql`
    // (wms/receipts/lot-name.ts), or add the file here WITH its reason.
    expect(found).toEqual(expected);
  });

  it('(2) every file that names the property has said what it does with it', () => {
    const naming = FILES.filter(({ src }) => /\bproductNameRu\b/.test(src))
      .map(({ path }) => path)
      .sort();
    expect(naming).toEqual(Object.keys(NAMES).sort());
  });

  it('(2) the readers behind the «shown» screens fill the field through the home', () => {
    for (const path of FILLED_THROUGH_HOME) {
      const file = FILES.find((f) => f.path === path);
      expect(file, path).toBeDefined();
      expect(file!.src, path).toMatch(/\blot(RuShown|GoodsShown)(Sql|For)\(/);
      expect(file!.src, path).toMatch(/from '(@\/modules\/wms\/receipts|\.\.\/receipts|\.\.\/\.\.\/receipts|\.)\/lot-name'/);
    }
  });

  it('(3) the label’s « +N» is concatenated in SQL in the home alone', () => {
    const builders = FILES.filter(({ src }) => /\|\|\s*' \+'/.test(src)).map(({ path }) => path);
    expect(builders).toEqual(['src/modules/wms/receipts/lot-name.ts']);
  });

  it('(3) the lists that print «first +N» over several lots count goods KINDS — one number', () => {
    const src = (path: string) => FILES.find((f) => f.path === path)!.src;
    // A deal's cargo label and the uncollected list unnest the kinds…
    expect(src('src/modules/wms/deals/service.ts')).toMatch(/unnest\(\$\{lotGoodsKindsSql\(/);
    expect(src('src/modules/wms/issue/waiting.ts')).toContain('lotGoodsKindsSql(');
    // …and the «Narx» tab's deal label reads the kinds the batch reader carries.
    expect(src('src/modules/wms/batches/lots.ts')).toMatch(/goodsKinds: sql<string\[\]>`\$\{lotGoodsKindsSql\(/);
    expect(src('src/app/(protected)/batches/[id]/pricing/page.tsx')).toContain('goodsKinds');
    // None of them is handed the lot's label to count over.
    for (const path of ['src/modules/wms/deals/service.ts', 'src/modules/wms/issue/waiting.ts']) {
      expect(src(path), path).not.toMatch(/lotRuShownSql\(/);
    }
  });
});
