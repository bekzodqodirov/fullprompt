import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every door that writes a carton off — lost or void — asks the funnel
 * whether that finished a deal (`advanceDealsAfterWriteOff`). The funnel's
 * own ear hears only a handover, so a deal whose last outstanding carton was
 * written off rather than handed over parked at «qisman topshirildi» for good
 * (U38's review, one door at a time). The integration file drives three of
 * the doors; this pins the wiring of all of them, the untested ones included.
 *
 * Source-shape on purpose: comments are stripped first, or a sentence that
 * names the call would satisfy the fence (#725).
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function body(path: string, fn: string): string {
  const src = stripComments(readFileSync(path, 'utf8'));
  const start = src.indexOf(`export async function ${fn}(`);
  expect(start, `${fn} in ${path}`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf('\nexport ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

const DOORS: [path: string, fn: string, call: string][] = [
  ['src/modules/wms/receipts/service.ts', 'markBoxLost', 'advanceDealsAfterWriteOff('],
  ['src/modules/wms/receipts/service.ts', 'voidReceipt', 'advanceDealsAfterWriteOff('],
  ['src/modules/wms/boxes/status.ts', 'setBoxStatus', 'advanceDealsAfterWriteOff('],
  ['src/modules/wms/inventory/service.ts', 'reconcileInventory', 'advanceDealsAfterWriteOff('],
  ['src/modules/wms/scanning/unload.ts', 'resolveMissing', 'advanceDealsAfterWriteOff('],
  ['src/modules/wms/receipts/annul.ts', 'annulReceipt', 'dealsAfterAnnul('],
];

describe('a write-off asks the funnel whether it finished a deal', () => {
  it.each(DOORS)('%s %s', (path, fn, call) => {
    expect(body(path, fn)).toContain(call);
  });

  it('the annul asks it on BOTH of its paths (the first press and the repair re-press)', () => {
    const annul = body('src/modules/wms/receipts/annul.ts', 'annulReceipt');
    expect([...annul.matchAll(/await dealsAfterAnnul\(receiptId, ctx\)/g)]).toHaveLength(2);
    const src = stripComments(readFileSync('src/modules/wms/receipts/annul.ts', 'utf8'));
    const helper = src.slice(src.indexOf('async function dealsAfterAnnul('));
    expect(helper.slice(0, 600)).toContain('advanceDealsAfterWriteOff(');
  });

  it('the box card asks only for a write-off, never for a restore', () => {
    const src = body('src/modules/wms/boxes/status.ts', 'setBoxStatus');
    const at = src.indexOf('advanceDealsAfterWriteOff(');
    expect(src.slice(Math.max(0, at - 250), at)).toContain("input.to !== 'in_stock'");
  });
});
