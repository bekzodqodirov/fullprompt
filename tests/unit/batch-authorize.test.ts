import { describe, expect, it } from 'vitest';
import { AuthError } from '@/modules/platform/rbac/authorize';
import { ROLE_MATRIX, WAREHOUSE_SCOPED_ROLES, type RoleCode } from '@/modules/platform/rbac/catalog';
import { mayOpenBatchCard } from '@/modules/wms/batches/card-door';
import { assertOnBatchCard } from '@/modules/wms/batches/batch-authorize';

/**
 * The scope half of the truck actions' door (docs/CARD-TABS.md, «Holes found
 * on the way»), over the SEEDED roles — the matrix he edits with checkboxes,
 * never a list of role names written here (count-door.test.ts's shape).
 *
 * Eight truck actions called `authorize(code, {})`, which judges no warehouse
 * at all. The three `batches.vehicle_info` ones — the map pin that drives the
 * customer's stage and arrival date, pairing and revoking the driver's phone —
 * are held by warehouse-SCOPED roles, so a Yiwu operator could press them on
 * a truck that never touched Yiwu.
 */
const ORIGIN = '00000000-0000-4000-8000-00000000b001';
const DEST = '00000000-0000-4000-8000-00000000b002';
const THIRD = '00000000-0000-4000-8000-00000000b003';
const TRUCK = { originWarehouseId: ORIGIN, destWarehouseId: DEST };

const ROLES = Object.keys(ROLE_MATRIX) as RoleCode[];

function actor(role: RoleCode, warehouseIds: string[]) {
  return {
    id: `user-${role}`,
    permissions: new Set<string>(ROLE_MATRIX[role]),
    warehouseScoped: WAREHOUSE_SCOPED_ROLES.includes(role),
    warehouseIds,
  };
}

/** `null` when the door opens, else the refusal's code — authorize's own kind. */
function refusal(who: ReturnType<typeof actor>, batch = TRUCK): string | null {
  try {
    assertOnBatchCard(who, batch);
    return null;
  } catch (err) {
    if (err instanceof AuthError) return err.code;
    throw err;
  }
}

describe('the truck door, judged at the truck’s two ends', () => {
  it('a scoped operator at the ORIGIN may act on the truck', () => {
    expect(refusal(actor('warehouse_operator', [ORIGIN]))).toBeNull();
  });

  it('a scoped operator at the DESTINATION only may act on it too — a trip belongs to both ends', () => {
    expect(refusal(actor('warehouse_operator', [DEST]))).toBeNull();
  });

  it('a scoped operator at a THIRD warehouse is refused, with authorize’s own «forbidden»', () => {
    expect(refusal(actor('warehouse_operator', [THIRD]))).toBe('forbidden');
    expect(refusal(actor('warehouse_manager', [THIRD]))).toBe('forbidden');
  });

  it('an unscoped person is admitted on any truck, with or without a warehouse assigned', () => {
    expect(refusal(actor('logist', []))).toBeNull();
    expect(refusal(actor('logist', [THIRD]))).toBeNull();
    expect(refusal(actor('ved_manager', []))).toBeNull();
  });

  it('a scoped person holding NO warehouse is refused everywhere — never «no filter»', () => {
    expect(refusal(actor('warehouse_operator', []))).toBe('forbidden');
  });

  it('the hole was real: the seed gives batches.vehicle_info to scoped roles, and away from their warehouses they are refused', () => {
    const holders = ROLES.filter((role) => ROLE_MATRIX[role].includes('batches.vehicle_info'));
    // The premise, read off the matrix: without a scoped holder the missing
    // warehouse was theoretical. warehouse_manager and warehouse_operator.
    expect(holders.filter((role) => WAREHOUSE_SCOPED_ROLES.includes(role)).length).toBeGreaterThan(0);
    for (const role of holders) {
      const scoped = WAREHOUSE_SCOPED_ROLES.includes(role);
      expect([role, refusal(actor(role, [THIRD]))]).toEqual([role, scoped ? 'forbidden' : null]);
      expect([role, refusal(actor(role, [ORIGIN]))]).toEqual([role, null]);
      expect([role, refusal(actor(role, [DEST]))]).toEqual([role, null]);
    }
  });

  it('refuses exactly when the card itself would not open — the card’s door, never a copy of it', () => {
    const places = [[], [ORIGIN], [DEST], [THIRD], [ORIGIN, THIRD], [DEST, THIRD]];
    for (const role of ROLES) {
      for (const warehouseIds of places) {
        const who = actor(role, warehouseIds);
        expect([role, warehouseIds, refusal(who)]).toEqual([
          role,
          warehouseIds,
          mayOpenBatchCard(who, TRUCK) ? null : 'forbidden',
        ]);
      }
    }
  });
});
