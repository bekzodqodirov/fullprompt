import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * «Sanab qabul» (0112, package B) — the wiring. Source-shape on purpose:
 * every half here WORKS on its own, and the fence is about which door asks
 * which question and in what order (#531) — a behavioural test only proves
 * the doors it happens to call. Comments are stripped first, or a fence
 * matches the sentence explaining it (#725).
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
  const next = rest.search(/\n(export |async function |function |interface |const |type )/);
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
}

const ACCEPT = 'src/modules/wms/scanning/count-accept.ts';
const UNLOAD = 'src/modules/wms/scanning/unload.ts';
const ACTIONS = 'src/app/(protected)/batches/batch-actions-server.ts';
const PANEL = 'src/app/(protected)/batches/[id]/count-accept-panel.tsx';
// The count panel and the unloading controls live on the truck card's
// «Tushirish» tab since 2026-09-28 (docs/CARD-TABS.md); the header only counts.
const PAGE = 'src/app/(protected)/batches/[id]/yuklash/page.tsx';
const HEADER = 'src/app/(protected)/batches/[id]/batch-card.tsx';
const SCREEN = 'src/app/(protected)/batches/[id]/unload/unload-screen.tsx';
const MISSING = 'src/app/(protected)/batches/[id]/unload-actions.tsx';

describe('the count-accept door', () => {
  it('both actions ask the destination’s count door, answer forbidden in words, and hand the door to the service', () => {
    for (const fn of ['countAcceptLotAction', 'countAcceptCrateAction', 'resolveMissingLotAction']) {
      const text = body(ACTIONS, fn);
      expect(text, fn).toMatch(/catch \(err\) \{\s*if \(err instanceof AuthError\) return \{ ok: false, error: 'forbidden' \}/);
    }
    // The two count presses ask at the destination the PANEL was drawn for
    // (the reroute round, amended deliberately): minted from a fresh read,
    // an unscoped logist's stale press landed the count at the warehouse the
    // truck was rerouted to. The service refuses `batch_rerouted` when the
    // door's warehouse is no longer the truck's; absent, it is the live one.
    for (const fn of ['countAcceptLotAction', 'countAcceptCrateAction']) {
      const text = body(ACTIONS, fn);
      expect(text, fn).toContain('const at = parsed.data.seenDestWarehouseId ?? batch.destWarehouseId;');
      expect(text, fn).toContain("authorize('plans.manage', { warehouseId: at })");
      expect(text, fn).toContain('countDoorFor(actor, at)');
    }
    const missing = body(ACTIONS, 'resolveMissingLotAction');
    expect(missing).toContain("authorize('plans.manage', { warehouseId: batch.destWarehouseId })");
    expect(missing).toContain('countDoorFor(actor, batch.destWarehouseId)');
    // Cartons beyond the truck come off the ORIGIN's books: its own door.
    expect(body(ACTIONS, 'countAcceptLotAction')).toContain('countDoorFor(actor, batch.originWarehouseId)');
  });

  it('a door minted for this person at another warehouse is the reroute, asked before and after the lock', () => {
    for (const fn of ['countAcceptLot', 'countAcceptCrate']) {
      const text = body(ACCEPT, fn);
      expect(text, fn).toContain('throw await preCheckRefusal(doors.dest, actorId, pre);');
    }
    // «Rerouted» only about a warehouse the truck really was sent away from:
    // the answer reads the reroute's own history, never the door alone.
    const helper = body(ACCEPT, 'reroutedOrForbidden');
    expect(helper).toContain('formerDestinationsFor([batchId])');
    expect(helper).toContain("former.includes(door.warehouseId) ? 'batch_rerouted' : 'forbidden'");
    expect(body(ACCEPT, 'preCheckRefusal')).toContain('await reroutedOrForbidden(door, actorId, batch.id)');
    // …carrying WHERE the truck goes now (the reroute review): the panel
    // prints the phone's sentence, never «refresh the page».
    expect(body(ACCEPT, 'reroutedCountError')).toContain("new CountError('batch_rerouted', { to: dest?.code ?? '—' })");
    // …and on the LOCKED truck row, which the reroute takes too.
    const chunk = body(ACCEPT, 'countChunk');
    const lock = chunk.indexOf(".from(batches).where(eq(batches.id, T)).for('no key update')");
    const recheck = chunk.indexOf('if (!doorOpens(a.doors.dest, batch.destWarehouseId, actorId)) {');
    expect(lock).toBeGreaterThan(0);
    expect(recheck).toBeGreaterThan(lock);
    expect(chunk.indexOf('throw await reroutedCountError(tx, batch.destWarehouseId);')).toBeGreaterThan(recheck);
    const crate = body(ACCEPT, 'countAcceptCrate');
    expect(crate.indexOf('if (!doorOpens(doors.dest, batch.destWarehouseId, actorId)) {'))
      .toBeGreaterThan(crate.indexOf(".for('no key update')"));
  });

  it('the service refuses a door that does not open BEFORE any transaction, and the doors are required', () => {
    for (const fn of ['countAcceptLot', 'countAcceptCrate']) {
      const text = body(ACCEPT, fn);
      const door = text.indexOf('doorOpens(doors.dest, pre.destWarehouseId, actorId)');
      expect(door, fn).toBeGreaterThan(0);
      expect(door, fn).toBeLessThan(text.indexOf('db.transaction('));
      expect(text, fn).toMatch(/doors: \{ dest: CountDoor/);
      expect(text, fn).not.toMatch(/doors\?:/);
    }
    const lot = body(UNLOAD, 'resolveMissingLot');
    expect(lot.indexOf('doorOpens(dest, pre.destWarehouseId, actorId)')).toBeGreaterThan(0);
    expect(lot.indexOf('doorOpens(')).toBeLessThan(lot.indexOf('db.transaction('));
  });

  it('a chunk takes the truck row, then the lot row, then every carton row before the lot lock, then reads fresh', () => {
    const text = body(ACCEPT, 'countChunk');
    // NO KEY UPDATE: a phone's scan event on an ARRIVED truck key-shares this
    // row, and FOR UPDATE here closed a cycle with it (review lock-1).
    const truck = text.indexOf(".from(batches).where(eq(batches.id, T)).for('no key update')");
    expect(text).not.toContain(".from(batches).where(eq(batches.id, T)).for('update')");
    // The lot row before its cartons — the receipt card's switch and the lot
    // form take them in that order, and a growth locks the lot (review lock-3).
    const lotRow = text.indexOf(".from(receiptLots).where(eq(receiptLots.id, L)).for('update')");
    const lotLock = text.indexOf('lockLotOnTruck(tx, T, L)');
    const ledger = text.indexOf('readLedger(tx');
    expect(truck).toBeGreaterThan(0);
    expect(lotRow).toBeGreaterThan(truck);
    expect(lotLock).toBeGreaterThan(lotRow);
    const rowLocks = [...text.matchAll(/\.for\('update'\)/g)].map((m) => m.index!);
    expect(rowLocks.length).toBeGreaterThanOrEqual(3);
    for (const at of rowLocks) {
      expect(at, 'a row lock after the lot lock').toBeLessThan(lotLock);
      expect(at, 'a carton lock before the lot row').toBeGreaterThanOrEqual(lotRow);
    }
    expect(ledger).toBeGreaterThan(lotLock);
    expect(text.indexOf('growLotInTx(tx')).toBeGreaterThan(lotLock);
  });

  it('the count never names the departure — membership is batchMemberFilter’s', () => {
    expect(readFileSync(ACCEPT, 'utf8')).not.toContain('batch_departed');
    expect(read(ACCEPT)).toContain('batchMemberFilter(T)');
  });

  it('cartons land through the scan’s own body with the door’s reason, per press, quietly, in the office window', () => {
    const text = body(ACCEPT, 'countChunk');
    expect(text).toContain('landUnloadInput(');
    expect(text).toContain('uuidv5(`unload:${box.id}`, input.pressId)');
    expect(text).toMatch(/door: reason,\s*boxId: box\.id,\s*quietSpot: true,\s*noticeWindowMinutes: OFFICE_NOTICE_WINDOW_MINUTES/);
    // Growth (his Q3 b) is minted at the truck's ORIGIN, never where it lands.
    expect(text).toMatch(/growLotInTx\(tx, \{[\s\S]*?warehouseId: batch\.originWarehouseId/);
  });

  it('the re-split of the truck’s riders and the lot’s growth run after the chunks, in a finally', () => {
    const text = body(ACCEPT, 'countAcceptLot');
    const fin = text.indexOf('} finally {');
    expect(fin).toBeGreaterThan(text.indexOf('db.transaction('));
    expect(text.indexOf('queueRiderChange(')).toBeGreaterThan(fin);
    expect(text.indexOf('afterLotGrown(')).toBeGreaterThan(fin);
  });

  it('«Hammasini qabul qilish» leaves a lot counted HERE out up front and records what really landed', () => {
    const text = body(UNLOAD, 'unloadRemaining');
    expect(text).toContain("countedOnTruckSql(batchId, sql`${boxes}.lot_id`, 'unload')");
    expect(text).toContain('shortCodes: landed');
    expect(text).toContain('skippedCounted');
    // The page's number is the same subtraction the service performs.
    expect(read(PAGE)).toContain('acceptable={remainingToAccept - countedAwaiting}');
  });

  it('the panel is drawn only for the destination’s count door, on a truck being unloaded', () => {
    const page = read(PAGE);
    expect(page).toMatch(/const mayCountAccept = unloadingNow && mayCountMove\(actor, batch\.destWarehouseId\)/);
    expect(page).toMatch(/mayCountAccept \? countAcceptPanel\(id\) : null/);
    const panel = page.indexOf('<CountAcceptPanel');
    expect(panel).toBeGreaterThan(0);
    expect(page.lastIndexOf('{countPanel &&', panel)).toBeGreaterThan(0);
    expect(page).toContain('id="count-accept"');
  });

  it('the header counts the same office work, for the same door, that the tab draws', () => {
    const header = read(HEADER);
    expect(header).toContain('const destCount = mayCountMove(actor, batch.destWarehouseId);');
    const from = header.indexOf('if (unloadingNow && destCount) {');
    expect(from).toBeGreaterThan(0);
    const branch = header.slice(from, header.indexOf('}', header.indexOf('todos.push(', from)));
    expect(branch).toContain('const panel = await countAcceptPanel(id);')
    // «awaiting» alone is every carton still aboard; the office's work is a
    // lot the phone cannot scan (a mode) with cartons left (review D6).
    expect(header).toContain('lot.mode !== null && lot.awaiting > 0');
    expect(header).toContain("hash: 'count-accept'");
  });

  it('every refusal the service can give has a sentence on the panel (#906)', () => {
    const source = readFileSync(ACCEPT, 'utf8');
    const union = /export type CountAcceptRefusal =([\s\S]*?);/.exec(source)?.[1];
    expect(union).toBeDefined();
    const members = [...union!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(members.length).toBeGreaterThan(10);
    const panel = read(PANEL);
    for (const code of [...members, 'validation']) {
      expect(panel, code).toContain(`case '${code}':`);
      expect(panel, code).toContain(`t('errors.${code}'`);
    }
    // And the service throws nothing outside the union.
    for (const m of source.matchAll(/new CountError\('([a-z_]+)'/g)) expect(members).toContain(m[1]);
  });

  it('the phone refuses a count-only lot itself, names it, and the toast can be read', () => {
    const screen = read(SCREEN);
    expect(screen).toContain('countOnlyLotOf(code, snapshot.boxes, snapshot.countOnly)');
    expect(screen).toContain('data-testid="unload-toast"');
    expect(screen).toContain("case 'lot_counted':");
    expect(screen).toContain("case 'qr_less_count_only':");
    expect(screen).toContain('data-testid="open-count-accept"');
  });

  it('the per-lot missing buttons live behind the count door; «Hammasi shu yerda» keeps its loop and collects', () => {
    const missing = read(MISSING);
    expect(missing).toContain('resolveMissingLotAction(');
    expect(missing).toContain('{canCountResolve && (');
    expect(missing).toMatch(/for \(const box of missing\) \{\s*const res = await resolveMissingAction/);
    expect(missing).toContain('failed.push(');
  });
});

describe('an office press is never silent (review ui-5, phone-3)', () => {
  it('the lot press, the pallet press and the missing-lot press each say something when the action never answers', () => {
    const panel = read('src/app/(protected)/batches/[id]/count-accept-panel.tsx');
    // One catch per press, each landing on the offline sentence.
    expect(panel.match(/\} catch \{\s*(setError\(t\('offline'\)\)|setNote\(\{ ok: false, text: t\('offline'\) \}\));/g) ?? []).toHaveLength(2);
    const missing = read('src/app/(protected)/batches/[id]/unload-actions.tsx');
    expect(missing).toMatch(/onDone\(\);\s*\} catch \{\s*setError\(t\('offline'\)\);/);
    expect(missing).toContain("case 'busy_retry':");
  });

  it('the missing-lot action answers a lock wait with «try again», never a white page', () => {
    const actions = read('src/app/(protected)/batches/batch-actions-server.ts');
    const fn = actions.slice(actions.indexOf('export async function resolveMissingLotAction'));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    expect(body).toContain("if (isBusyError(err)) return { ok: false, error: 'busy_retry' };");
  });

  it('the loading screen says when the office’s cartons outgrew the snapshot', () => {
    const screen = read('src/app/(protected)/batches/[id]/load/loading-screen.tsx');
    expect(screen).toContain('{snapshot.countOnlyCapped && (');
    expect(screen).toContain("tcount('countOnlyCapped')");
  });
});
