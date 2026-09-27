import { inScope } from '../../platform/rbac/scope';

/**
 * Who may COUNT cargo onto or off a truck (0112, the owner's Q3: «faqat admin
 * va logist, istalgan sklad, ofisdan»).
 *
 * A count moves cartons with no per-carton witness, so it is the logistics
 * office's power and not the warehouse's: `plans.manage` — held on the seed by
 * super_admin, admin and logist, exactly his answer, and editable on
 * /admin/roles like every grant (#170) — at a warehouse the person may act in
 * (an unscoped logist: everywhere; a scoped one: their own). No new
 * permission code; `receipts.void` is deliberately NOT it, because the
 * warehouse manager holds that one and his answer excluded them.
 *
 * ONE predicate for every count door — load, accept, per-lot missing,
 * dropping a QR-siz lot, print-later of a planned carton, the office receipt
 * (#513). The branded `CountDoor` is what the services demand: it can only be
 * minted here, so a service handed a forged object refuses at compile time,
 * and a caller that forgot to ask gets `null`, which every door refuses (#790:
 * an absent answer must fail CLOSED).
 */
declare const COUNT_DOOR: unique symbol;
export type CountDoor = {
  readonly [COUNT_DOOR]: true;
  readonly actorId: string;
  readonly warehouseId: string;
};

export interface CountDoorActor {
  id: string;
  permissions: ReadonlySet<string>;
  warehouseScoped: boolean;
  warehouseIds: readonly string[];
}

/** The boolean form, for a screen deciding whether to draw a button. */
export function mayCountMove(a: Omit<CountDoorActor, 'id'>, warehouseId: string): boolean {
  if (!warehouseId) return false;
  if (!a.permissions.has('plans.manage')) return false;
  return inScope({ warehouseScoped: a.warehouseScoped, warehouseIds: [...a.warehouseIds] }, warehouseId);
}

/** The door itself, for one person at one warehouse — or null. */
export function countDoorFor(a: CountDoorActor, warehouseId: string): CountDoor | null {
  if (!a.id || !mayCountMove(a, warehouseId)) return null;
  return Object.freeze({ actorId: a.id, warehouseId }) as unknown as CountDoor;
}

/**
 * The service's check: a door, for THIS warehouse, minted for THIS person.
 * A door carried from another warehouse or another request opens nothing.
 */
export function doorOpens(
  d: CountDoor | null | undefined,
  warehouseId: string,
  actorId: string | null | undefined,
): d is CountDoor {
  return !!d && !!actorId && d.warehouseId === warehouseId && d.actorId === actorId;
}
