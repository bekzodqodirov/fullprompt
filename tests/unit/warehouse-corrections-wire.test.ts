import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MUTE_GROUPS } from '@/modules/platform/notifications/mutes';

/**
 * The corrections round's wiring (#531's shape): every door here calls
 * `authorize`, so no integration test can press the button — the gate, the
 * warehouse it is judged at, and the service each action reaches are pinned
 * as source, comments stripped first (#725).
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const read = (path: string) => strip(readFileSync(path, 'utf8'));

describe('the three doors and their gates', () => {
  it('removeLoadedAction: the loader’s own permission at the ORIGIN', () => {
    const src = read('src/app/(protected)/batches/batch-actions-server.ts');
    const fn = src.slice(src.indexOf('export async function removeLoadedAction'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain("authorize('scan.load', { warehouseId: batch.originWarehouseId })");
    expect(body).toContain('removeLoadedCode(');
  });

  it('acceptFoundAction: the loader’s own permission at THIS warehouse', () => {
    const src = read('src/app/(protected)/inventory/actions.ts');
    const fn = src.slice(src.indexOf('export async function acceptFoundAction'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain("authorize('scan.load', { warehouseId: parsed.data.warehouseId })");
    expect(body).toContain('acceptFoundBox(');
  });

  it('markBoxLostAction: manager level, judged where the BOX stands', () => {
    const src = read('src/app/(protected)/receipts/[id]/actions.ts');
    const fn = src.slice(src.indexOf('export async function markBoxLostAction'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain("authorize('receipts.void', { warehouseId: box.currentWarehouseId })");
    expect(body).toContain('markBoxLost(');
  });
});

describe('the screens reach the doors', () => {
  it('the loading screen carries the remove sheet and calls its action', () => {
    const src = read('src/app/(protected)/batches/[id]/load/loading-screen.tsx');
    expect(src).toContain('remove-loaded-open');
    expect(src).toContain('removeLoadedAction({ batchId, code })');
    // Two-tap: the row press arms, a second control fires.
    expect(src).toContain('remove-confirm');
  });

  it('the receipt card offers the write-off only behind receipts.void', () => {
    const src = read('src/app/(protected)/receipts/[id]/page.tsx');
    expect(src).toMatch(/canVoid && \(\s*<MarkLostForm/);
  });

  it('/inventory offers both jobs and the nav names it for the scanner', () => {
    const page = read('src/app/(protected)/inventory/page.tsx');
    expect(page).toContain("mode === 'bitta'");
    expect(page).toContain('<AcceptFound');
    const nav = read('src/modules/platform/rbac/nav.ts');
    expect(nav).toMatch(/href: '\/inventory',[\s\S]{0,200}permissions: \['scan\.load'\]/);
  });
});

describe('the rules the services must not lose', () => {
  it('every correction type is mutable — the three joined MUTE_GROUPS', () => {
    const covered = new Set<string>(Object.values(MUTE_GROUPS).flat());
    for (const type of ['BoxFoundHere', 'BoxLost', 'ReceiptMeasureCorrected']) {
      expect(covered.has(type), type).toBe(true);
    }
  });

  it('a found box tells the planners, and EVERY landing path asks the one rule', () => {
    const src = read('src/modules/wms/inventory/service.ts');
    const accept = src.slice(src.indexOf('export async function acceptFoundBox'));
    expect(accept).toContain("type: 'BoxFoundHere'");
    // The rule moved to its own home (#513) after the corrections round found
    // it written out four times and MISSING from the fourth. The fence is now
    // that nobody restates it: every landing path calls `landedStatusFor`.
    for (const path of [
      'src/modules/wms/inventory/service.ts',
      'src/modules/wms/scanning/unload.ts',
      'src/modules/wms/boxes/status.ts',
    ]) {
      const file = read(path);
      expect(file, path).toContain('landedStatusFor(');
      expect(file, path).not.toMatch(/\['customs', 'distribution'\]/);
    }
  });

  it('editLot: the COUNT lock is unconditional, the measure lock names receipts.void', () => {
    const src = read('src/modules/wms/receipts/edit.ts');
    expect(src).toContain("if (countChange && boxesLeft) throw new EditError('structural_locked')");
    expect(src).toMatch(
      /measureChange && boxesLeft && !actor\.permissions\.has\('receipts\.void'\)/,
    );
    // The correction re-allocates the money it feeds, immediately.
    expect(src).toContain('|| totalsChanged');
  });
});

/**
 * The second corrections round (owner's four reports, 2026-08-25): the bin
 * scan, the two unload shortcuts, one arrival message per truck, and the
 * warehouse fill block.
 */
describe('round two — the bin, the shortcuts, the one message', () => {
  it('the bin door is the manager gate, asked from its ONE home', () => {
    const actions = read('src/app/(protected)/inventory/actions.ts');
    for (const fn of ['binLookupAction', 'binConfirmAction']) {
      const body = actions.slice(actions.indexOf(`export async function ${fn}`));
      expect(body.slice(0, body.indexOf('\n}'))).toContain(
        "authorize('receipts.void', { warehouseId: parsed.data.warehouseId })",
      );
      expect(body.slice(0, body.indexOf('\n}'))).toContain('mayWriteOffBox(actor)');
    }
    // …and every other door to `lost` asks the same function, so widening it
    // widens all of them together (#513).
    const page = read('src/app/(protected)/inventory/page.tsx');
    expect(page).toContain('mayWriteOffBox(actor)');
  });

  it('the write-off cannot reach a carton standing somewhere else', () => {
    const src = read('src/modules/wms/receipts/service.ts');
    const fn = src.slice(src.indexOf('export async function markBoxLost'));
    // A REQUIRED argument, not an optional one: an optional fence fails open.
    expect(fn).toContain('atWarehouseId: string');
    expect(fn).toContain('box.currentWarehouseId !== input.atWarehouseId');
    // One call, one union — two calls send the logist-who-is-also-a-seller
    // the same sentence twice.
    expect(fn).toContain("usersWithPermission('plans.manage')");
    expect([...fn.matchAll(/notifyStaffTelegram\(/g)]).toHaveLength(1);
  });

  it('BOTH unload shortcuts are manager acts, and the service refuses too', () => {
    const actions = read('src/app/(protected)/batches/batch-actions-server.ts');
    const accept = actions.slice(actions.indexOf('export async function unloadRemainingAction'));
    expect(accept.slice(0, accept.indexOf('\n}'))).toContain(
      "authorize('receipts.void', { warehouseId: batch.destWarehouseId })",
    );
    const finish = actions.slice(actions.indexOf('export async function finishUnloadAction'));
    expect(finish.slice(0, finish.indexOf('\n}'))).toContain('mayCloseWithMissing');
    // #531: a hidden button is not a rule.
    const service = read('src/modules/wms/scanning/unload.ts');
    expect(service).toContain("throw new ScanError('finish_needs_manager')");
    // And every authorize in that file answers in words rather than throwing
    // into an onClick with no boundary.
    expect([...actions.matchAll(/AuthError\) return \{ ok: false, error: 'forbidden' \}/g)].length)
      .toBeGreaterThanOrEqual(4);
  });

  it('the staff arrival event left the scan and rides the notice claim', () => {
    const unload = read('src/modules/wms/scanning/unload.ts');
    const scanBlock = unload.slice(
      unload.indexOf("if (landedStatus === 'ready_for_pickup' && toMove.length > 0)"),
      unload.indexOf('.insert(scanEvents)'),
    );
    // The claim stays in the transaction; the EVENT must not.
    expect(scanBlock).toContain('claimArrivalNotice(');
    expect(scanBlock).not.toContain('ReadyForPickup');
    const staff = read('src/modules/wms/notices/arrival-staff.ts');
    // Claim and emit in ONE transaction, or a restart between them loses it.
    expect(staff).toContain('isNull(clientNotices.staffNotifiedAt)');
    expect(staff).toContain("type: 'ReadyForPickup'");
    // The sweep must reach it whatever Telegram did.
    const jobs = read('src/modules/wms/notices/arrival-jobs.ts');
    expect(jobs.indexOf('staffPendingNotices')).toBeLessThan(jobs.indexOf('if (!token)'));
    expect(jobs).not.toContain("'no_bot_token'");
  });

  it('the fill block is gated, scoped, and drawn by ONE component', () => {
    const home = read('src/app/(protected)/admin-dashboard.tsx');
    expect(home).toContain('warehouseFill(whScope, staleDays)');
    expect(home).toContain('cargo ? warehouseFill');
    expect(home).toContain('<WarehouseFillRows');
    const dash = read('src/app/(protected)/dashboard/page.tsx');
    expect(dash).toContain('<WarehouseFillRows');
    // Tailwind compiles what it can SEE — the colours are a literal map.
    const comp = read('src/components/warehouse-fill.tsx');
    expect(comp).toMatch(/const BAR: Record<[^>]+> = \{/);
    expect(comp).not.toMatch(/`(bg|text)-\$\{/);
  });
});
