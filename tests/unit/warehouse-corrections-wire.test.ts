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

  it('a found box tells the planners, and both found paths land by warehouse TYPE', () => {
    const src = read('src/modules/wms/inventory/service.ts');
    const accept = src.slice(src.indexOf('export async function acceptFoundBox'));
    expect(accept).toContain("type: 'BoxFoundHere'");
    // resolveMissing's rule, in BOTH found paths: customs/distribution lands
    // ready_for_pickup, or the box hides from every «tayyor» list.
    expect(
      [...src.matchAll(/\['customs', 'distribution'\]\.includes\(warehouse\.type\)/g)],
    ).toHaveLength(2);
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
