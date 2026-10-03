// FIRST: the icon set builds elements at import time (see the fixture).
import '../fixtures/react-global';
import { globSync, readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CrateRows, FOLD_ABOVE } from '@/components/crate-rows';
import { LotCheckChip } from '@/components/lot-check-chip';
import { chipFace, inCheckFilter, readCheckFilter } from '@/modules/wms/receipts/lot-check-face';
import type { CrateStockRow } from '@/modules/wms/inventory/service';

/**
 * «Yuk ma'lumoti tekshirildi» as a shape (docs/YUK-TEKSHIRUV.md) — the rules
 * no behavioural test reaches cheaply: one writer, one sentence, a filter
 * that survives every link of /stock, a plan filter that never touches the
 * plan, a chip that is never an <a> inside an <a> — and the crate list that
 * folds (§9). Comments are stripped first (#725): several of these files
 * explain the very words they must not use.
 */

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const read = (path: string) => stripComments(readFileSync(path, 'utf8'));
const files = globSync('src/**/*.{ts,tsx}');

const WRITER = 'src/modules/wms/receipts/lot-check.ts';
const SENTENCE = 'src/modules/wms/receipts/lot-check-sql.ts';
const STOCK_PAGE = 'src/app/(protected)/stock/page.tsx';
const STOCK_ROUTE = 'src/app/api/reports/stock/route.ts';
const PLAN_STOCK = 'src/modules/wms/planning/stock.ts';
const HOME_COUNT = 'src/modules/wms/inventory/lot-check-count.ts';
const EDITOR = 'src/app/(protected)/plans/new/plan-editor.tsx';

describe('one writer, one sentence', () => {
  it('only lot-check.ts writes lot_checks (derived over src — #896\'s shape)', () => {
    const writes = files.filter((path) => {
      const src = read(path);
      return (
        /\.(insert|update|delete)\(\s*lotChecks\b/.test(src) ||
        /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?lot_checks\b/i.test(src)
      );
    });
    expect(writes).toEqual([WRITER]);
  });

  it('the snapshot\'s columns are compared in the sentence alone — no reader restates a term', () => {
    const naming = files.filter((path) => /seen_name_zh|seen_client_id|seen_name_ru/.test(read(path)));
    // The sentence compares; the writer writes and re-reads its own row; the
    // schema declares the columns.
    expect(naming.sort()).toEqual([WRITER, SENTENCE, 'src/modules/platform/db/schema/wms.ts'].sort());
  });

  it('every list reader asks the sentence over the two LEFT JOINs, never a correlated subquery', () => {
    for (const path of [STOCK_PAGE, STOCK_ROUTE, PLAN_STOCK, HOME_COUNT]) {
      const src = read(path);
      expect(src, path).toMatch(/lotCheckState(OrNull)?Sql\(/);
      expect(src, path).toContain('withLotCheckJoins(');
      // The measured 3.3 s shape (docs/YUK-TEKSHIRUV.md §4).
      expect(src, path).not.toMatch(/FROM\s+lot_checks/i);
    }
  });

  it('every reader of the 0123 tables asks lotChecksReady first (#472) — and no list joins them by hand', () => {
    const joining = files.filter((path) => /withLotCheckJoins\(|lotCheckState(OrNull)?Sql\(/.test(read(path)));
    for (const path of joining) {
      if (path === SENTENCE) continue;
      expect(read(path), path).toContain('lotChecksReady(');
    }
    const byHand = files.filter((path) => path !== SENTENCE && /\.leftJoin\(lotChecks\b/.test(read(path)));
    expect(byHand).toEqual([]);
  });

  it('the plan editor imports the PURE half only — drizzle never reaches the browser', () => {
    const src = read(EDITOR);
    expect(src).toContain("from '@/modules/wms/receipts/lot-check-face'");
    expect(src).not.toContain('lot-check-sql');
    expect(read('src/modules/wms/receipts/lot-check-face.ts')).not.toContain('drizzle');
  });
});

describe('/stock carries `tek` through every door (#514, #171)', () => {
  const page = read(STOCK_PAGE);
  it('the sort links, the export link and the 🔍 form keep it', () => {
    expect(page).toMatch(/const sortParams = \{[^}]*tek: params\.tek[^}]*\}/);
    expect(page).toContain("exportQuery.set('tek', params.tek)");
    expect(page).toContain('<input type="hidden" name="tek" value={params.tek} />');
  });

  it('a value that is not one of the two is dropped, never bound', () => {
    expect(page).toContain('const tek = readCheckFilter(params.tek);');
    expect(page).toContain('if (!tek) params.tek = undefined;');
    expect(read(STOCK_ROUTE)).toContain("readCheckFilter(url.searchParams.get('tek'))");
  });

  it('the rows take the filter after grouping (HAVING) and the Σ as a FILTER over the same groups', () => {
    expect(page).toMatch(/\.having\(checkTek \? checkFilterSql\(checkTek, sql`min\(\$\{checkState\}\)`, sql`bool_and\(\$\{askable\}\)`\) : undefined\)/);
    expect(page).toMatch(/const groupFilter = checkTek \? checkFilterSql\(checkTek, sql`g\.state`, sql`g\.askable`\)/);
    // The screen without the migration has no filter row and binds no `tek`.
    expect(page).toContain('const checkTek = checksOn ? tek : null;');
    expect(page).toContain('{checksOn && (');
  });

  it('«Hammasi» is never a bare /stock (a bare visit redirects to a saved default view)', () => {
    expect(page).toContain("return qs ? `/stock?${qs}` : '/stock?tek=';");
  });

  it('the chip is a SIBLING of the code cell\'s link, never inside it', () => {
    const from = page.indexOf("column.key === 'code' ? (");
    const to = page.indexOf("column.key === 'product' ? (", from);
    const cell = page.slice(from, to);
    expect(cell.indexOf('<LotCheckChip')).toBeGreaterThan(cell.indexOf('</Link>'));
  });
});

describe('the plan editor filters what it DRAWS, never what it plans', () => {
  const editor = read(EDITOR);
  it('the table and the crate list render the filtered rows; the Σ and the submit read the full ones', () => {
    expect(editor).toContain('{shownLots.map((lot) => {');
    expect(editor).toContain('{shownCrates.map((crate) => {');
    expect(editor).not.toMatch(/setLots\([^)]*filter/);
    const totals = editor.slice(editor.indexOf('const totals = useMemo('), editor.indexOf('function setCount('));
    expect(totals).toContain('for (const lot of lots)');
    expect(totals).toContain('for (const crate of stockCrates)');
    expect(totals).not.toContain('shown');
  });
});

describe('the door: the page draws what the service allows (#531)', () => {
  it('the service asks mayCheckLot and mayReadReceipt; the page asks mayCheckLot', () => {
    const writer = read(WRITER);
    const door = writer.slice(writer.indexOf('async function lotCheckDoor('), writer.indexOf('interface LockedLot'));
    expect(door).toContain('mayCheckLot(actor.permissions)');
    expect(door).toContain('mayReadReceipt(actor');
    const page = read('src/app/(protected)/receipts/[id]/page.tsx');
    expect(page).toMatch(/const mayCheck = mayCheckLot\(actor\.permissions\) && receipt\.status === 'confirmed';/);
    expect(page).toContain('canWrite={mayCheck}');
  });

  it('the snapshot is written from the LOCKED row, never from the post', () => {
    const writer = read(WRITER);
    const insert = writer.slice(writer.indexOf('INSERT INTO lot_checks'), writer.indexOf('ON CONFLICT (lot_id)'));
    expect(insert).toContain('${lot.name_zh}, ${lot.name_ru}, ${lot.box_count}, ${current.client_id}::uuid');
    expect(insert).not.toContain('parsed.seen');
  });
});

describe('the pure half', () => {
  it('a URL value is one of two or nothing', () => {
    expect(readCheckFilter('ha')).toBe('ha');
    expect(readCheckFilter('yoq')).toBe('yoq');
    expect(readCheckFilter('HA')).toBeNull();
    expect(readCheckFilter("ha' OR 1=1")).toBeNull();
    expect(readCheckFilter(undefined)).toBeNull();
  });

  it('the chip: ✅ anywhere, ⚠/❓ only where asked, nothing for unclaimed or a missing state', () => {
    expect(chipFace('checked', false)).toBe('checked');
    expect(chipFace('none', true)).toBe('none');
    expect(chipFace('stale', true)).toBe('stale');
    expect(chipFace('none', false)).toBeNull();
    expect(chipFace('stale', false)).toBeNull();
    expect(chipFace('unclaimed', true)).toBeNull();
    expect(chipFace(undefined, true)).toBeNull();
  });

  it('a snapshot cached before the check (no state) is in neither filter', () => {
    expect(inCheckFilter('ha', undefined, true)).toBe(false);
    expect(inCheckFilter('yoq', undefined, true)).toBe(false);
  });

  it('the chip renders a span without a door, a link with one, a new tab when asked', () => {
    const labels = { checked: 'tekshirilgan', stale: "o'zgardi", none: 'tekshirilmagan' };
    expect(renderToStaticMarkup(h(LotCheckChip, { face: null, labels }))).toBe('');
    const span = renderToStaticMarkup(h(LotCheckChip, { face: 'checked', labels }));
    expect(span).toMatch(/^<span[^>]*data-state="checked"/);
    const link = renderToStaticMarkup(h(LotCheckChip, { face: 'none', labels, href: '/receipts/x#lot-y' }));
    expect(link).toMatch(/^<a[^>]*href="\/receipts\/x#lot-y"/);
    expect(link).not.toContain('target=');
    const tab = renderToStaticMarkup(h(LotCheckChip, { face: 'stale', labels, href: '/r', newTab: true }));
    expect(tab).toContain('target="_blank"');
    expect(tab).toContain('chip-warn');
  });
});

describe('the crate list folds (owner, 2026-10-03: «colapsable bolsin»)', () => {
  const crate = (i: number, over = false): CrateStockRow => ({
    id: `c${i}`,
    code: `CR-${i}`,
    clientCode: 'GS777',
    whCode: 'YW',
    boxCount: 3,
    kg: 30,
    m3: 0.3,
    statedM3: 0.4,
    statedKg: 40,
    over,
  });
  const labels = { title: 'Yashiklar', inside: 'Ichida', over: "sig'magan", place: 'mesta' };

  it(`open with up to ${FOLD_ABOVE} crates, folded above that`, () => {
    const few = renderToStaticMarkup(h(CrateRows, { rows: Array.from({ length: FOLD_ABOVE }, (_, i) => crate(i)), labels }));
    expect(few).toMatch(/^<details[^>]* open=""/);
    const many = renderToStaticMarkup(h(CrateRows, { rows: Array.from({ length: FOLD_ABOVE + 1 }, (_, i) => crate(i)), labels }));
    expect(many).toMatch(/^<details/);
    expect(many.slice(0, many.indexOf('>'))).not.toContain('open');
  });

  it('folded, the summary still carries the count and the over-capacity warning', () => {
    const rows = Array.from({ length: 12 }, (_, i) => crate(i, i < 2));
    const html = renderToStaticMarkup(h(CrateRows, { rows, labels }));
    const summary = html.slice(html.indexOf('<summary'), html.indexOf('</summary>'));
    expect(summary).toContain('Yashiklar (12)');
    expect(summary).toContain('data-testid="crate-rows-over"');
    expect(summary).toContain('· 2');
  });
});
