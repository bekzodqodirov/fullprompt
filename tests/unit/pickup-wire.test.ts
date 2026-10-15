import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NAV } from '@/modules/platform/rbac/nav';
import { mayReadPickups } from '@/modules/wms/pickups/service';

const read = (path: string) => readFileSync(path, 'utf8');

/**
 * «Zavod reysi» (0100) — the halves that live in actions and screens, which
 * an integration test cannot press (#531).
 */
describe('zavod reysi wiring', () => {
  it('the menu entry promises exactly the list door', () => {
    const item = NAV.flatMap((section) => section.items).find((i) => i.href === '/zavod');
    expect(item, 'nav has /zavod').toBeTruthy();
    // Every grant the menu names opens the door, and nothing else does.
    for (const code of item!.permissions ?? []) expect(mayReadPickups(new Set([code]))).toBe(true);
    for (const code of ['receipts.create', 'scan.load', 'crm.leads', 'finance.view', 'ved.docs']) {
      expect(mayReadPickups(new Set([code])), code).toBe(false);
    }
  });

  it('a truck cost can be entered AND voided — the void no longer falls into the receipt branch', () => {
    const actions = read('src/app/(protected)/costs/actions.ts');
    expect(actions).toContain("parsed.data.scope === 'pickup'");
    expect(actions).toContain("entry.scope === 'pickup' && entry.pickupId");
  });

  it("the annul's empty-scope sweep is NOT taught the pickup scope", () => {
    // A half-received truck has an «empty» base that is not «money with no
    // cargo»; voiding it would destroy the freight and the firm's debt.
    const annul = read('src/modules/wms/receipts/annul.ts');
    const sweep = annul.slice(annul.indexOf('Empty-scope sweep'), annul.indexOf('let emptyScopeVoided'));
    expect(sweep).not.toMatch(/pickup/i);
  });

  it('the receive door checks the stop INSIDE the transaction and writes it on the INSERT', () => {
    const service = read('src/modules/wms/receipts/service.ts');
    const tx = service.slice(service.indexOf('const result = await db.transaction(async (tx) => {'));
    expect(tx.indexOf('assertStopReceivable(tx,')).toBeGreaterThan(-1);
    expect(tx.indexOf('assertStopReceivable(tx,')).toBeLessThan(tx.indexOf('.insert(receipts)'));
    expect(tx).toContain('pickupStopId: input.pickupStopId ?? null');
  });

  it('the wizard posts the stop it was opened from', () => {
    const wizard = read('src/app/(protected)/receive/receive-wizard.tsx');
    expect(wizard).toContain('...postedPickupFields(draft!)');
    expect(read('src/app/(protected)/receive/pickup-draft.ts')).toContain('pickupStopId: d.pickupStopId ?? null');
  });

  it('moveReceipt asks the stop, under the receipt lock, before it moves a box (ZAVOD-YOPISH §5)', () => {
    // The arrival rule names a trip only at the warehouse it was heading to;
    // a prixod moved away under its link would be that trip's cargo nowhere.
    const move = read('src/modules/wms/receipts/move.ts');
    const body = move.slice(move.indexOf('export async function moveReceipt('));
    const lock = body.indexOf(".for('update')");
    const ask = body.indexOf("if (receipt.pickupStopId) throw new MoveError('pickup_linked')");
    expect(lock).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(lock);
    expect(ask).toBeLessThan(body.indexOf('.update(receipts)'));
    // …and the refusal has words in every bundle (a missing key throws at render).
    for (const locale of ['ru', 'uz', 'zh-CN', 'en']) {
      const bundle = JSON.parse(read(`messages/${locale}.json`)) as {
        receipts: { moveErrors: Record<string, string> };
      };
      expect(bundle.receipts.moveErrors.pickup_linked, locale).toBeTruthy();
    }
  });
});
