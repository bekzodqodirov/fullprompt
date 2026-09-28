import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { byShelf, PLANNABLE_STATUSES } from '@/modules/wms/boxes/shelf';

/*
 * «Tokchada» — the cargo a truck may take, and the shelf a give-back returns
 * it to, each said once (`boxes/shelf.ts`). The rule's SQL is proven through
 * the real services in `plan-collection-origin.integration.test.ts`; this
 * file pins the pure grouping and the WIRING, source-shape on purpose: every
 * give-back door works on its own and a behavioural test proves only the
 * doors it calls (#531). The plan path read `in_stock` alone while the quick
 * truck read both — two restatements of one list, and Andijan's cargo fell
 * between them. Comments are stripped first, or a fence matches the sentence
 * that explains it (#725).
 */

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (path: string) => stripComments(readFileSync(path, 'utf8'));

/** The body of a top-level function, up to the next top-level declaration. */
function body(path: string, fn: string): string {
  const src = read(path);
  const start = src.search(new RegExp(`(export\\s+)?async function ${fn}\\(`));
  expect(start, `${fn} in ${path}`).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(export |async function |function |const )/);
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
}

describe('byShelf', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

  it('groups by the status each goes back to, in the list’s order, and drops an empty group', () => {
    const back = new Map([
      ['a', 'ready_for_pickup' as const],
      ['b', 'in_stock' as const],
      ['c', 'ready_for_pickup' as const],
      ['d', 'in_stock' as const],
    ]);
    expect(byShelf(rows, back)).toEqual([
      ['in_stock', [{ id: 'b' }, { id: 'd' }]],
      ['ready_for_pickup', [{ id: 'a' }, { id: 'c' }]],
    ]);
    expect(byShelf(rows.slice(0, 1), back)).toEqual([['ready_for_pickup', [{ id: 'a' }]]]);
  });

  it('a carton the map does not name goes back in_stock, the fragment’s own default', () => {
    expect(byShelf(rows.slice(0, 2), new Map())).toEqual([['in_stock', [{ id: 'a' }, { id: 'b' }]]]);
  });

  it('the list is the two shelf statuses and nothing a truck is carrying', () => {
    expect([...PLANNABLE_STATUSES]).toEqual(['in_stock', 'ready_for_pickup']);
  });
});

const SCANNING = 'src/modules/wms/scanning';

describe('the wiring', () => {
  it('no door in scanning/ gives a carton back to a hard-coded shelf', () => {
    // Derived: a give-back added tomorrow is inside the fence the day it lands.
    const files = readdirSync(SCANNING).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      expect(read(`${SCANNING}/${file}`), file).not.toMatch(/[sS]tatus:\s*'in_stock'/);
    }
  });

  it('every give-back asks where the carton stood', () => {
    const doors: [string, string][] = [
      [`${SCANNING}/service.ts`, 'removeLoadedCode'],
      [`${SCANNING}/service.ts`, 'finishLoading'],
      [`${SCANNING}/unload.ts`, 'cancelBatch'],
      [`${SCANNING}/unload.ts`, 'resolveOneMissingInTx'],
      [`${SCANNING}/count-accept.ts`, 'undoOver'],
    ];
    for (const [path, fn] of doors) expect(body(path, fn), fn).toMatch(/shelfBefore\(tx, /);
    // The count press's own way back reads the same fragment, never a copy.
    expect(body(`${SCANNING}/count-load.ts`, 'countRows')).toContain("shelfBeforeSql('b', ");
  });

  it('the plan path and the quick truck read one list', () => {
    for (const path of ['src/modules/wms/planning/service.ts', 'src/modules/wms/planning/stock.ts']) {
      const src = read(path);
      expect(src, path).not.toContain("'in_stock'");
      expect(src, path).toContain('inArray(boxes.status, [...PLANNABLE_STATUSES])');
    }
    for (const fn of ['availableByLot', 'submitPlan', 'recordVerdict']) {
      expect(body('src/modules/wms/planning/service.ts', fn), fn).toContain('PLANNABLE_STATUSES');
    }
    expect(read(`${SCANNING}/service.ts`)).toMatch(/const looseAtOrigin = [^;]*PLANNABLE_STATUSES/);
    // The editor's route is the door and nothing else: the question lives in
    // `plannableStock`, which the integration test asks.
    const route = read('src/app/api/plans/stock/route.ts');
    expect(route).toContain('plannableStock(query.data.warehouseId)');
    expect(route).not.toContain('boxes.status');
  });
});
