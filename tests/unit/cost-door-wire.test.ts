import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The cost doors (2026-09-24). An action calls `authorize()`, so no
 * integration test can press it (#531) — the wiring is pinned by source
 * shape, comments stripped first (#725).
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const ACTIONS = strip(readFileSync('src/app/(protected)/costs/actions.ts', 'utf8'));

describe('voiding a prixod cost', () => {
  const voidAction = ACTIONS.slice(ACTIONS.indexOf('export async function voidCostEntryAction'));

  it('refuses a receipt cost whose receipt is gone instead of authorising «any warehouse»', () => {
    expect(voidAction).toMatch(/if \(!receipt\) return \{ ok: false, error: 'not_found' \}/);
  });

  it('opens the grid\'s own door for a cell the grid typed (the truck stamp)', () => {
    expect(voidAction).toContain('voidReceiptCostDoor(receipt.warehouseId, entry.batchId)');
    const door = ACTIONS.slice(ACTIONS.indexOf('async function voidReceiptCostDoor'));
    expect(door.indexOf("authorize('costs.enter_receipt'")).toBeGreaterThan(-1);
    expect(door.indexOf("authorize('costs.enter_batch'")).toBeGreaterThan(
      door.indexOf("authorize('costs.enter_receipt'"),
    );
    // Only a stamped cell falls back; an unstamped receipt cost keeps one door.
    expect(door).toMatch(/if \(!\(err instanceof AuthError\) \|\| !stampedBatchId\) throw err;/);
  });
});
