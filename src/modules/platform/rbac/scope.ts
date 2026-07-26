import { inArray, sql, type Column, type SQL } from 'drizzle-orm';

/**
 * The warehouse filter for a read query.
 *
 * Thirteen screens wrote this by hand as
 * `scoped && ids.length ? inArray(col, ids) : undefined`, and the `: undefined`
 * is the bug: a warehouse-scoped person with NO warehouse assigned — a new
 * hire, or someone whose assignment was pulled — produced no WHERE clause at
 * all and read every warehouse in the company. The failure was silent and in
 * the permissive direction, which is the worst combination.
 *
 * This helper cannot express "no filter" for a scoped user. Three answers and
 * no fourth:
 *  - not scoped → no filter (the owner, the accountant, the logist)
 *  - scoped with warehouses → those warehouses
 *  - scoped with none → NOTHING, not everything
 *
 * A screen where the empty result would be confusing should also say why —
 * `hasNoWarehouse()` is the test for rendering the "no warehouse assigned"
 * card that `/receive` already gets right.
 */
export interface ScopedActor {
  warehouseScoped: boolean;
  warehouseIds: string[];
}

export function warehouseScope(actor: ScopedActor, column: Column): SQL | undefined {
  if (!actor.warehouseScoped) return undefined;
  if (actor.warehouseIds.length === 0) return sql`false`;
  return inArray(column, actor.warehouseIds);
}

/**
 * Same, for a row that belongs to EITHER of two warehouses — a batch is at its
 * origin until it arrives at its destination, and both warehouses have a
 * legitimate reason to see it.
 */
export function warehouseScopeEither(
  actor: ScopedActor,
  first: Column,
  second: Column,
): SQL | undefined {
  if (!actor.warehouseScoped) return undefined;
  if (actor.warehouseIds.length === 0) return sql`false`;
  return sql`(${inArray(first, actor.warehouseIds)} OR ${inArray(second, actor.warehouseIds)})`;
}

/** Is this person scoped to warehouses and holding none? */
export function hasNoWarehouse(actor: ScopedActor): boolean {
  return actor.warehouseScoped && actor.warehouseIds.length === 0;
}

/** May this person read a row belonging to this warehouse? */
export function inScope(actor: ScopedActor, warehouseId: string | null | undefined): boolean {
  if (!actor.warehouseScoped) return true;
  return Boolean(warehouseId) && actor.warehouseIds.includes(warehouseId!);
}
