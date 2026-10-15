import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX, WAREHOUSE_SCOPED_ROLES, type RoleCode } from '@/modules/platform/rbac/catalog';
import {
  mayRenameBatch,
  renameDoorFor,
  renameDoorOpens,
  renameStageOf,
  type RenameStage,
} from '@/modules/wms/batches/rename-door';

/**
 * Who may rename a truck, and when (the owner's 1a / 2a / 3a). Behavioural
 * over EVERY seeded role — the matrix is his to edit with checkboxes — in
 * border-queue-door.test.ts's shape, plus an invented scoped role holding
 * the permission, which is the case the warehouse clauses exist for.
 */
const ORIGIN = '00000000-0000-4000-8000-00000000c001';
const DEST = '00000000-0000-4000-8000-00000000c002';
const THIRD = '00000000-0000-4000-8000-00000000c003';
const TRUCK = { originWarehouseId: ORIGIN, destWarehouseId: DEST };

const ROLES = Object.keys(ROLE_MATRIX) as RoleCode[];

/** A seeded role; a scoped one sits at the ORIGIN, as a Yiwu hand would. */
function seeded(role: RoleCode) {
  const scoped = WAREHOUSE_SCOPED_ROLES.includes(role);
  return {
    permissions: new Set<string>(ROLE_MATRIX[role]),
    warehouseScoped: scoped,
    warehouseIds: scoped ? [ORIGIN] : [],
  };
}

function admitted(stage: RenameStage): RoleCode[] {
  return ROLES.filter((role) => mayRenameBatch(seeded(role), TRUCK, stage)).sort();
}

describe('renameStageOf', () => {
  it('reads the stage from the status AND what is still aboard', () => {
    const table: [string, number, RenameStage][] = [
      ['forming', 0, 'loading'],
      ['loading', 3, 'loading'],
      ['in_transit', 5, 'road'],
      ['arrived', 3, 'road'],
      // Nothing left to scan off = unloading finished, button or no button.
      ['arrived', 0, 'closed'],
      ['in_transit', 0, 'closed'],
      ['unloaded', 4, 'closed'],
      ['closed', 0, 'closed'],
      ['cancelled', 0, 'closed'],
      // A status nobody taught this function fails CLOSED.
      ['bogus', 9, 'closed'],
    ];
    for (const [status, aboard, stage] of table) {
      expect(renameStageOf(status, aboard), `${status}/${aboard}`).toBe(stage);
    }
  });
});

describe('mayRenameBatch over the seeded roles', () => {
  it('admits exactly super_admin, admin and logist — his 2a — before departure and on the road', () => {
    const expected = ROLES.filter(
      (role) => ROLE_MATRIX[role].includes('plans.manage') && !WAREHOUSE_SCOPED_ROLES.includes(role),
    ).sort();
    expect(admitted('loading')).toEqual(expected);
    expect(admitted('road')).toEqual(expected);
    expect(expected).toEqual(['admin', 'logist', 'super_admin']);
    // The warehouse manager holds depart/close and is NOT his answer.
    expect(admitted('road')).not.toContain('warehouse_manager');
  });

  it('admits nobody once the truck is closed, admin included', () => {
    expect(admitted('closed')).toEqual([]);
  });
});

describe('an invented scoped role holding plans.manage', () => {
  const scopedAt = (ids: string[]) => ({
    permissions: new Set(['plans.manage']),
    warehouseScoped: true,
    warehouseIds: ids,
  });

  it('on the road: either end of the truck, never a third warehouse', () => {
    expect(mayRenameBatch(scopedAt([ORIGIN]), TRUCK, 'road')).toBe(true);
    expect(mayRenameBatch(scopedAt([DEST]), TRUCK, 'road')).toBe(true);
    expect(mayRenameBatch(scopedAt([THIRD]), TRUCK, 'road')).toBe(false);
    expect(mayRenameBatch(scopedAt([]), TRUCK, 'road')).toBe(false);
  });

  it('before departure: the ORIGIN only — the cargo is still there', () => {
    expect(mayRenameBatch(scopedAt([ORIGIN]), TRUCK, 'loading')).toBe(true);
    expect(mayRenameBatch(scopedAt([DEST]), TRUCK, 'loading')).toBe(false);
  });

  it('the door half alone is the card door plus the permission', () => {
    expect(renameDoorOpens(scopedAt([DEST]), TRUCK)).toBe(true);
    expect(renameDoorOpens(scopedAt([THIRD]), TRUCK)).toBe(false);
    expect(
      renameDoorOpens({ permissions: new Set(['batches.depart_close']), warehouseScoped: false, warehouseIds: [] }, TRUCK),
    ).toBe(false);
  });
});

describe('renameDoorFor — the only way to hand the service a door', () => {
  const base = { id: '00000000-0000-4000-8000-0000000000a1', warehouseScoped: false, warehouseIds: [] as string[] };

  it('is minted only for a person who holds plans.manage, with an identity', () => {
    expect(renameDoorFor({ ...base, permissions: new Set(['batches.depart_close']) })).toBeNull();
    expect(renameDoorFor({ ...base, id: '', permissions: new Set(['plans.manage']) })).toBeNull();
    expect(renameDoorFor({ ...base, permissions: new Set(['plans.manage']) })).not.toBeNull();
  });

  it('is a frozen snapshot: changing the actor afterwards changes nothing the service reads', () => {
    const grants = new Set(['plans.manage']);
    const scope = [ORIGIN];
    const door = renameDoorFor({ ...base, permissions: grants, warehouseScoped: true, warehouseIds: scope })!;
    grants.delete('plans.manage');
    grants.add('admin.everything');
    scope.push(THIRD);
    expect(Object.isFrozen(door)).toBe(true);
    expect(door.permissions.has('plans.manage')).toBe(true);
    expect(door.warehouseIds).toEqual([ORIGIN]);
  });
});
