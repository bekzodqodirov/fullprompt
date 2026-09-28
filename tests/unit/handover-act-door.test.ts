import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX, WAREHOUSE_SCOPED_ROLES, type RoleCode } from '@/modules/platform/rbac/catalog';
import { handoverActRefusal, mayReadHandoverAct } from '@/modules/wms/issue/act-door';

/**
 * Who may read a handover's act — behavioural over every seeded role,
 * because the act carries the receiver's name and PHONE and the answer is a
 * property of a matrix the owner edits with checkboxes. The route, the
 * attachment gate and the «Akt» links are source-fenced onto this one door
 * (`document-route-gates.test.ts`); THIS is what says the door itself is
 * right.
 *
 * The case that matters most is the warehouse operator: the person who hands
 * the cargo over holds `scan.issue` and NOT `receipts.unclaimed.resolve`, so
 * an `||` turned into «both» would take the act from exactly the person who
 * gets it signed — and every other reader the tests used to name (the owner,
 * holding both) would still pass.
 */
const WH = '00000000-0000-4000-8000-00000000b001';
const OTHER = '00000000-0000-4000-8000-00000000b002';

function actor(role: RoleCode, warehouseIds: string[] = [WH]) {
  return {
    permissions: new Set<string>(ROLE_MATRIX[role]),
    warehouseScoped: WAREHOUSE_SCOPED_ROLES.includes(role),
    warehouseIds,
  };
}

describe('the handover act door', () => {
  it('opens for the people who hand cargo over, and for nobody else the seed ships', () => {
    const opens = (Object.keys(ROLE_MATRIX) as RoleCode[]).filter((r) => mayReadHandoverAct(actor(r), WH)).sort();
    expect(opens).toEqual(['admin', 'logist', 'super_admin', 'warehouse_manager', 'warehouse_operator']);
  });

  it('the warehouse operator — scan.issue alone — reads the act of their own warehouse', () => {
    const operator = actor('warehouse_operator');
    expect(operator.permissions.has('scan.issue')).toBe(true);
    expect(operator.permissions.has('receipts.unclaimed.resolve')).toBe(false);
    expect(mayReadHandoverAct(operator, WH)).toBe(true);
    expect(handoverActRefusal(operator, WH)).toBeNull();
  });

  it('…and is refused another warehouse’s, and a handover whose warehouse is unknown', () => {
    const operator = actor('warehouse_operator');
    expect(handoverActRefusal(operator, OTHER)).toBe('out-of-scope');
    expect(mayReadHandoverAct(operator, OTHER)).toBe(false);
    expect(handoverActRefusal(operator, null)).toBe('out-of-scope');
    expect(handoverActRefusal({ ...operator, warehouseIds: [] }, WH)).toBe('out-of-scope');
  });

  it('a seller, the accountant and the VED hold neither grant — «no permission», wherever the handover is', () => {
    for (const role of ['sales_manager', 'accountant', 'ved_manager', 'viewer'] as RoleCode[]) {
      expect([role, handoverActRefusal(actor(role), WH)]).toEqual([role, 'no-permission']);
      expect([role, handoverActRefusal(actor(role), OTHER)]).toEqual([role, 'no-permission']);
    }
  });

  it('an unscoped role reads every warehouse’s act', () => {
    for (const role of ['super_admin', 'admin', 'logist'] as RoleCode[]) {
      expect([role, mayReadHandoverAct(actor(role, []), OTHER)]).toEqual([role, true]);
    }
  });

  it('the boolean is the refusal’s «none», for every role and both warehouses', () => {
    for (const role of Object.keys(ROLE_MATRIX) as RoleCode[]) {
      for (const wh of [WH, OTHER]) {
        expect([role, wh, mayReadHandoverAct(actor(role), wh)]).toEqual([
          role,
          wh,
          handoverActRefusal(actor(role), wh) === null,
        ]);
      }
    }
  });
});
