import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX, WAREHOUSE_SCOPED_ROLES, type RoleCode } from '@/modules/platform/rbac/catalog';
import { countDoorFor, doorOpens, mayCountMove, type CountDoor } from '@/modules/wms/scanning/count-door';

/**
 * Who may COUNT cargo onto or off a truck (0112, the owner's Q3: «faqat admin
 * va logist, istalgan sklad, ofisdan»). Behavioural over every seeded role,
 * because the answer is a property of a matrix he edits with checkboxes —
 * never a list of role names written here.
 */
const WH = '00000000-0000-4000-8000-00000000a001';
const OTHER = '00000000-0000-4000-8000-00000000a002';

function actor(role: RoleCode, warehouseIds: string[] = [WH]) {
  return {
    id: `user-${role}`,
    permissions: new Set<string>(ROLE_MATRIX[role]),
    warehouseScoped: WAREHOUSE_SCOPED_ROLES.includes(role),
    warehouseIds,
  };
}

describe('the count door', () => {
  it('opens for super_admin, admin and logist — and for nobody else the seed ships', () => {
    const opens = (Object.keys(ROLE_MATRIX) as RoleCode[]).filter((r) => countDoorFor(actor(r), WH) !== null).sort();
    expect(opens).toEqual(['admin', 'logist', 'super_admin']);
    for (const role of Object.keys(ROLE_MATRIX) as RoleCode[]) {
      expect([role, mayCountMove(actor(role), WH)]).toEqual([role, countDoorFor(actor(role), WH) !== null]);
    }
  });

  it('the warehouse manager holds receipts.void and still gets no door', () => {
    const manager = actor('warehouse_manager');
    expect(manager.permissions.has('receipts.void')).toBe(true);
    expect(countDoorFor(manager, WH)).toBeNull();
  });

  it('a scoped actor holding plans.manage opens only their own warehouse', () => {
    const scoped = { ...actor('logist'), warehouseScoped: true, warehouseIds: [WH] };
    expect(countDoorFor(scoped, WH)).not.toBeNull();
    expect(countDoorFor(scoped, OTHER)).toBeNull();
    expect(countDoorFor({ ...scoped, warehouseIds: [] }, WH)).toBeNull();
  });

  it('a door opens only its own warehouse, for its own person', () => {
    const door = countDoorFor(actor('logist'), WH);
    expect(doorOpens(door, WH, 'user-logist')).toBe(true);
    expect(doorOpens(door, OTHER, 'user-logist')).toBe(false);
    expect(doorOpens(door, WH, 'user-admin')).toBe(false);
    expect(doorOpens(null, WH, 'user-logist')).toBe(false);
    expect(doorOpens(door, WH, null)).toBe(false);
  });

  it('cannot be written by hand', () => {
    // @ts-expect-error — a CountDoor is minted by countDoorFor and nowhere else.
    const forged: CountDoor = { actorId: 'x', warehouseId: WH };
    expect(forged).toBeDefined();
    expect(Object.isFrozen(countDoorFor(actor('admin'), WH))).toBe(true);
  });
});
