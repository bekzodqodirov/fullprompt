import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COUNT_LOAD_ERRORS } from '@/modules/wms/scanning/count-load';

/*
 * «Sanab yuklash»'s wiring (0112). Source-shape on purpose: every half WORKS
 * on its own — the door, the lock order, the refusal on the phone, the
 * readers of a truck's cargo — and a behavioural test only proves the doors
 * it happens to call (#531). Comments are stripped first, or a fence matches
 * the sentence that explains it (#725).
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

const SERVICE = 'src/modules/wms/scanning/service.ts';
const COUNT_LOAD = 'src/modules/wms/scanning/count-load.ts';
const ACTIONS = 'src/app/(protected)/batches/count-load-actions.ts';
const PANEL = 'src/app/(protected)/batches/[id]/count-load-panel.tsx';
// Since 2026-09-28 the truck card is six tabs (docs/CARD-TABS.md): the count
// panel and the loaded list live on the «Yuklash» tab, the ⚠ chip in the
// header every tab draws, and the TNVED list in its own module.
const CARD = 'src/app/(protected)/batches/[id]/yuklash/page.tsx';
const HEADER = 'src/app/(protected)/batches/[id]/batch-card.tsx';
const LOAD_SCREEN = 'src/app/(protected)/batches/[id]/load/loading-screen.tsx';

describe('the count door', () => {
  it('is asked at the truck’s ORIGIN, as an answer — never a thrown AuthError — and minted before the press', () => {
    const src = read(ACTIONS);
    expect(src).toContain("authorize('plans.manage', { warehouseId: batch.originWarehouseId })");
    expect(src).toMatch(/catch \(err\) \{\s*if \(err instanceof AuthError\) return \{ ok: false as const, error: 'forbidden' as const \}/);
    expect(src).toContain('countDoorFor(actor, batch.originWarehouseId)');
    expect(src).toMatch(/countLoadLot\(parsed\.data, \{[^}]*\}, opened\.door\)/);
    expect(src).toMatch(/countLoadCrate\(parsed\.data, \{[^}]*\}, opened\.door\)/);
    // A deadlock or the lock wait is «press again», never a white page.
    expect(src).toContain('isBusyError(err)');
  });

  it('the service demands the branded door — not optional — and checks it against the truck and the person', () => {
    for (const fn of ['countLoadLot', 'countLoadCrate']) {
      const text = body(COUNT_LOAD, fn);
      expect(text, fn).toMatch(/door: CountDoor,?\s*\)/);
      expect(text, fn).not.toMatch(/door\?: CountDoor/);
      expect(text, fn).toContain('doorOpens(door, batch.originWarehouseId, actorId)');
    }
  });

  it('a press locks in the kernel’s order: timeout, the truck, the lot’s cartons in id order, THEN a fresh read', () => {
    const text = body(COUNT_LOAD, 'countLoadLot');
    const at = (needle: string) => {
      const i = text.indexOf(needle);
      expect(i, needle).toBeGreaterThan(0);
      return i;
    };
    const timeout = at('await setCountLockTimeout(tx)');
    const truck = at('await lockTruckLoading(tx, batchId)');
    const firstQuery = at('tx.query.');
    const rowLock = at('FOR UPDATE');
    const fresh = at('await countRows(tx');
    const firstLoad = at('await loadScanInTx(');
    const grow = at('await growLotInTx(tx');
    expect(timeout).toBeLessThan(truck);
    expect(truck).toBeLessThan(firstQuery);
    expect(rowLock).toBeLessThan(fresh);
    expect(fresh).toBeLessThan(firstLoad);
    // The lot's row lock (inside growLotInTx) only AFTER the cartons' (decision 23).
    expect(rowLock).toBeLessThan(grow);
    expect(text.slice(rowLock - 40, rowLock)).toContain('ORDER BY b.id');
  });

  it('every carton goes through the phone’s own body, as the door, one event id per carton per press', () => {
    const text = body(COUNT_LOAD, 'countLoadLot');
    expect(text).toContain('{ door: COUNT_LOAD_REASON, boxId: box.id, quietSpot: true }');
    expect(text).toContain('manualReason: COUNT_LOAD_REASON');
    expect(text).toContain('uuidv5(`load:${box.id}`, input.pressId)');
    // A replay inside a press is a conflict, never a success.
    expect(text).toMatch(/ack\.result !== 'ok' \|\| ack\.detail === 'replay'\) throw new CountError\('count_conflict'\)/);
    // …and the number typed is re-read before the audit.
    expect(text.indexOf('aboardCount(tx, batchId, lotId)')).toBeLessThan(text.indexOf('writeAudit(tx'));
  });

  it('the batch card draws the panel only for a door holder; the phone screen never reaches the press', () => {
    const card = read(CARD);
    expect(card).toContain('const countDoor = countDoorFor(actor, batch.originWarehouseId)');
    expect(card).toMatch(/const loadPanel = countDoor && loadingNow \? await countLoadPanel\(batch\) : null/);
    expect(card).toMatch(/\{loadPanel && \(\s*<CountLoadPanel/);
    expect(read(LOAD_SCREEN)).not.toContain('count-load-actions');
  });

  it('the panel puts every refusal the service can give into words', () => {
    const panel = read(PANEL);
    for (const code of [...COUNT_LOAD_ERRORS, 'bad_target', 'busy_retry']) {
      expect(panel, code).toContain(`case '${code}':`);
    }
  });
});

describe('the phone and the office’s lot', () => {
  it('the loading screen merges the quick truck’s shelf too, or a dialled-down carton stays «aboard»', () => {
    // On a quick truck the office's dial-down puts the cartons back on the
    // shelf with no pointer: they leave `boxes` for `available`, and a merge
    // over `boxes` alone never takes them off the phone (review phone-2).
    const screen = read(LOAD_SCREEN);
    const calls = [...screen.matchAll(/mergeLoaded\(([^;]*?)data\.countOnly\)/g)].map((m) => m[1]!);
    expect(calls).toHaveLength(2);
    for (const args of calls) expect(args).toContain('...(data.available ?? [])');
  });

  it('the phone’s removal refuses a counted lot, by the kernel’s load-side marker', () => {
    const text = body(SERVICE, 'removeLoadedCode');
    expect(text).toContain("countedOnTruckSql(batchId, sql`${aboard[0]!.lotId}::uuid`, 'load')");
    expect(text).toContain("throw new ScanError('lot_counted')");
    // After the truck lock and after it knows what is aboard.
    expect(text.indexOf('lockTruckLoading(tx')).toBeLessThan(text.indexOf("'lot_counted'"));
    expect(text.indexOf("'not_loaded_here'")).toBeLessThan(text.indexOf("'lot_counted'"));
  });

  it('the loading screen refuses a count-only lot before anything is queued, and knows the removal refusal', () => {
    const src = read(LOAD_SCREEN);
    const onCode = src.slice(src.indexOf('function onCode('));
    const refuse = onCode.indexOf('countOnlyLotOf(');
    expect(refuse).toBeGreaterThan(0);
    expect(refuse).toBeLessThan(onCode.indexOf('void accept('));
    expect(refuse).toBeGreaterThan(onCode.indexOf('isSendableCode(code)'));
    expect(src).toContain("res.error === 'lot_counted'");
    expect(src).toContain('mergeLoaded(prev, [...data.boxes, ...(data.available ?? [])], data.countOnly)');
    expect(src).toContain('data-testid="load-toast"');
  });
});

describe('«yuklash tugadi» (decision 28)', () => {
  it('refuses over uncounted QR-siz lots unless told to drop them — inside its own transaction', () => {
    const text = body(SERVICE, 'finishLoading');
    const guard = text.indexOf('qrlessUncountedByTruck(tx, [batchId])');
    expect(guard).toBeGreaterThan(text.indexOf('lockTruckLoading(tx'));
    expect(guard).toBeLessThan(text.indexOf('const memberBoxes'));
    expect(text).toMatch(/if \(!opts\.dropQrless\) \{/);
  });

  it('only a count-door holder at the origin may drop them', () => {
    const src = body('src/app/(protected)/plans/actions.ts', 'finishLoadingAction');
    expect(src).toContain('const canDrop = mayCountMove(actor, batch.originWarehouseId)');
    expect(src).toContain("if (opts.dropQrless && !canDrop) return { ok: false, error: 'forbidden' }");
    expect(src).toMatch(/catch \(err\) \{\s*if \(err instanceof AuthError\) return \{ ok: false, error: 'forbidden' \}/);
  });

  it('counts the cartons beyond the plan that are STILL aboard, once each', () => {
    const text = body(SERVICE, 'finishLoading');
    expect(text).toContain('count(DISTINCT ${scanEvents.boxId})');
    expect(text).toContain('aboardFilter(batchId)');
  });
});

describe('a truck’s papers read its cargo, never its scan history (decision 25)', () => {
  it('the packing list and the TNVED page', () => {
    const packing = read('src/modules/wms/documents/packing-photos-xlsx.ts');
    expect(packing).not.toContain('scanEvents');
    expect(packing).toContain('aboardFilter(batchId)');
    // The editor's rows AND the header's «TNVED kodsiz» count read one list.
    const tnved = read('src/modules/wms/tnved/batch-lots.ts');
    expect(tnved).not.toContain('scanEvents');
    expect(tnved).toContain('aboardFilter(batchId)');
    const page = read('src/app/(protected)/batches/[id]/tnved/page.tsx');
    expect(page).not.toContain('scanEvents');
    expect(page).toContain('batchTnvedProducts(id,');
  });

  it('the batch card’s loaded list and ⚠ chip', () => {
    // A marker that is missing makes `indexOf` -1 and `slice(start, -1)` runs
    // to the end of the file, where any later query passes the checks — so
    // both ends are asserted before anything is read between them.
    const card = read(CARD);
    const from = card.indexOf('const loadedBoxes');
    const to = card.indexOf('return (', from);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const loaded = card.slice(from, to);
    expect(loaded).toContain('.where(aboardFilter(id))');
    expect(loaded).not.toContain('scanEvents');
    const header = read(HEADER);
    const spotFrom = header.indexOf('const onSpotCount');
    const spotTo = header.indexOf('const loadingNow', spotFrom);
    expect(spotFrom).toBeGreaterThan(0);
    expect(spotTo).toBeGreaterThan(spotFrom);
    const spot = header.slice(spotFrom, spotTo);
    expect(spot).toContain('count(DISTINCT ${scanEvents.boxId})');
    expect(spot).toContain("eq(scanEvents.type, 'load')");
    expect(spot).toContain('aboardFilter(id)');
  });

  it('the register’s ➕', () => {
    const text = body('src/modules/wms/reports/queries.ts', 'batchRegister');
    const added = text.slice(text.indexOf('added: sql'), text.indexOf('costUsd: sql'));
    expect(added).toContain('count(DISTINCT se.box_id)');
    expect(added).toContain("ab.status <> 'void'");
    // «Reserved» only on the live pointer — a carton that rode this truck and
    // is planned on the next one still rode this one (review cargo-1).
    expect(added).toContain("(ab.current_batch_id = ${batches.id} AND ab.status <> 'planned') OR EXISTS");
  });
});
