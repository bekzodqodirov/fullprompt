/**
 * Boxes the system EXPECTS to be physically present at a warehouse: what a
 * stocktake walks, and what the office's print list for stickerless cartons
 * offers (0112). One list, because «which cartons should be standing here»
 * must be one answer on every screen that asks it (#513).
 *
 * Deliberately narrower than the stock screen's `SHELF_STATUSES`: a carton
 * already `loading` is on a truck's floor, not on the shelf a stocktake
 * counts, and writing it off as missing would be a lie about a box that is
 * one scan from leaving.
 */
export const PRESENT_STATUSES = ['in_stock', 'planned', 'ready_for_pickup'] as const;
export type PresentStatus = (typeof PRESENT_STATUSES)[number];
