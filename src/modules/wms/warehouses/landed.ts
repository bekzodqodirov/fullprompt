/**
 * Where cargo LANDS, said once (#513).
 *
 * A box that arrives at a warehouse the client collects from is
 * `ready_for_pickup`; anywhere else it is ordinary `in_stock`. The rule was
 * written four times — `ingestUnloadScans`, `resolveMissing`,
 * `reconcileInventory` and `acceptFoundBox` — and the E1 audit found the
 * fourth copy MISSING, which is the whole reason it now has a home: a box
 * landed `in_stock` at a customs or distribution warehouse never reaches any
 * «tayyor» list, and in Uzbekistan every destination is one of the two.
 *
 * The restore path (`boxes/status.ts`) is the fifth caller and had the same
 * hole: a Tashkent write-off undone came back `in_stock` and the client's
 * cabinet said «O'zbekistonda» for ever.
 *
 * `type` is `warehouses.type`, one of origin | hub | customs | distribution
 * (the column's own CHECK).
 */
export const COLLECTION_WAREHOUSE_TYPES = ['customs', 'distribution'] as const;

export function landedStatusFor(warehouseType: string): 'ready_for_pickup' | 'in_stock' {
  return (COLLECTION_WAREHOUSE_TYPES as readonly string[]).includes(warehouseType)
    ? 'ready_for_pickup'
    : 'in_stock';
}
