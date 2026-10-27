import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Yo'ldagi yuk (docs/YOLDAGI-YUK.md) — the WIRING, source-shape on purpose:
 * every landing door works on its own and a behavioural test proves only the
 * doors it calls (#531); `plan-road.integration.test.ts` proves the rule
 * through the ones it does. Comments are stripped first (#725).
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

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

const ROAD = 'src/modules/wms/planning/road.ts';
const SCANNING = 'src/modules/wms/scanning';

describe('the road part has one writer and one probe', () => {
  it('only road.ts names the two tables or mints the probe’s value', () => {
    for (const path of walk('src')) {
      if (path === ROAD || path.includes('/db/schema/') || path.includes('/db/migrations/')) continue;
      const src = read(path);
      // Readers ask road.ts; nobody else writes or joins the tables.
      expect(src, path).not.toMatch(/\bplan_line_road\b|\bplan_road_claims\b/);
      expect(src, path).not.toMatch(/as RoadOn\b/);
      expect(src, path).not.toContain('roadOffForTest');
    }
  });

  it('road.ts reads the shelf through the one list and never a hard-coded status', () => {
    const src = read(ROAD);
    expect(src).toContain('PLANNABLE_STATUSES');
    expect(src).not.toContain("'in_stock'");
    expect(src).not.toContain("'ready_for_pickup'");
  });
});

describe('every door that lands a carton offers it to a plan owing its lot (§7)', () => {
  it('the unload body, the found-here door and both stocktake doors', () => {
    expect(body(`${SCANNING}/unload.ts`, 'landUnloadInput')).toContain('claimLandedForRoadTx(tx, road,');
    expect(body(`${SCANNING}/unload.ts`, 'resolveOneMissingInTx')).toContain('claimLandedForRoadTx(tx, road,');
    const inventory = 'src/modules/wms/inventory/service.ts';
    expect(body(inventory, 'reconcileInventory')).toContain('claimLandedForRoadTx(tx, road,');
    expect(body(inventory, 'acceptFoundBox')).toContain('claimLandedForRoadTx(tx, road,');
  });

  it('never an office over-count’s cartons — `undoOver` must find them on the shelf', () => {
    expect(body(`${SCANNING}/unload.ts`, 'landUnloadInput')).toMatch(
      /if \(opts\.door !== COUNT_OVER_REASON\) \{\s*await claimLandedForRoadTx/,
    );
  });

  it('a carton this truck already landed is never landed again by it', () => {
    const src = body(`${SCANNING}/unload.ts`, 'landUnloadInput');
    expect(src).toContain('const allDone = members.every(doneHere)');
    expect(src).toContain('const toMove = members.filter((b) => !doneHere(b))');
    expect(src).toMatch(/!landedBefore\.has\(b\.id\)/);
  });

  it('the sync body lands before it loads', () => {
    const src = read(`${SCANNING}/sync.ts`);
    expect(src.indexOf('ingestUnloadScans(unloads')).toBeGreaterThan(-1);
    expect(src.indexOf('ingestUnloadScans(unloads')).toBeLessThan(src.indexOf('ingestLoadScans(loads'));
  });
});

describe('the doors that end a loading keep what did not come (§8)', () => {
  it('«yuklash tugadi» and the cancel move owed into missed before reading the cartons', () => {
    for (const [path, fn] of [
      [`${SCANNING}/service.ts`, 'finishLoading'],
      [`${SCANNING}/unload.ts`, 'cancelBatch'],
    ] as const) {
      const src = body(path, fn);
      const close = src.indexOf('closeRoadOwedTx(tx, road, batchId)');
      expect(close, fn).toBeGreaterThan(-1);
      expect(close, fn).toBeLessThan(src.indexOf('.from(boxes)'));
    }
  });

  it('the departure refuses while anything is owed', () => {
    expect(body(`${SCANNING}/service.ts`, 'departBatch')).toMatch(
      /owedOnTruck\(tx, road, batchId\)\) > 0\) throw new ScanError\('road_owed_open'\)/,
    );
  });

  it('a claimed carton given back «tayyor» is announced again, at both give-backs', () => {
    expect(body(`${SCANNING}/service.ts`, 'finishLoading')).toContain('reannounceGivenBack(tx, road, batchId, home, actorId)');
    expect(body(`${SCANNING}/unload.ts`, 'cancelBatch')).toContain('reannounceGivenBack(tx, road, batchId, home, actorId)');
  });
});

describe('the count door counts what can be on the truck (§9)', () => {
  it('the press and the panel subtract the road’s owed and missed, through one fragment', () => {
    const src = read(`${SCANNING}/count-load.ts`);
    expect(body(`${SCANNING}/count-load.ts`, 'planNumber')).toContain("roadNotHereSql('pl')");
    expect(body(`${SCANNING}/count-load.ts`, 'countLoadPanel')).toContain("roadNotHereSql('pl')");
    // The press claims what stands free before it reads its plan number.
    const press = body(`${SCANNING}/count-load.ts`, 'countLoadLot');
    expect(press.indexOf('claimFromShelfTx(tx, road,')).toBeGreaterThan(-1);
    expect(press.indexOf('claimFromShelfTx(tx, road,')).toBeLessThan(press.indexOf('await planNumber(tx, batchId, lotId, road)'));
    expect(src).not.toMatch(/sum\(pl\.planned_box_count\)/);
  });
});
