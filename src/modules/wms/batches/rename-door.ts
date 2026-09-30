import { inScope, type ScopedActor } from '../../platform/rbac/scope';
import { mayOpenBatchCard, type BatchEnds } from './card-door';

/**
 * Who may rename a truck, and when (the owner's 1a / 2a / 3a, 2026-09-30:
 * «jo‘nagandan keyin ham nomini o‘zgartirish kerak … faqat admin va logist
 * … tushirish tugaguncha»). Pure, so the card draws the ✏️ and the service
 * obeys it off ONE predicate (#513), and the decision is provable over every
 * seeded role without a request.
 *
 * Three stages, and the third is a FACT as well as a status: «unloading
 * finished» is written by exactly one press, `finishUnload`, and the codebase
 * already records that some warehouses never press it (unload.ts's own
 * sentence, `notices/arrival.ts`). A truck standing `arrived` with nothing
 * left to scan off is finished whether or not anybody said so — the aboard
 * count is `awaitingUnloadWhere`'s, the unload screen's own counter.
 *
 * Anything this function does not recognise is CLOSED: a status added
 * tomorrow must not open a door by falling through.
 */
export type RenameStage = 'loading' | 'road' | 'closed';

export function renameStageOf(status: string, stillAboard: number): RenameStage {
  switch (status) {
    case 'forming':
    case 'loading':
      return 'loading';
    case 'in_transit':
    case 'arrived':
      return stillAboard > 0 ? 'road' : 'closed';
    default:
      return 'closed';
  }
}

/** The person asking, WITH their identity and their grants. */
export interface RenameDoorActor extends ScopedActor {
  id: string;
  permissions: ReadonlySet<string>;
}

/**
 * What `renameBatch` demands, and the only way to get one is `renameDoorFor`
 * — the count door's shape (`count-door.ts` `CountDoor`): branded, so a
 * service handed a hand-built «planner, unscoped» object refuses at COMPILE
 * time, and minted only for a person who holds the grant at all. It is a
 * frozen snapshot of the actor the ACTION authorised; the service still
 * judges the truck's ends and stage from it on the row it locks, and refuses
 * a door whose `id` is not the audit context's actor, so a door minted for
 * somebody else opens nothing either. `null` — nobody asked, or the answer
 * was no — is refused by the service like any other closed door (#790).
 */
declare const RENAME_DOOR: unique symbol;
export type RenameDoor = Readonly<RenameDoorActor> & { readonly [RENAME_DOOR]: true };

export function renameDoorFor(a: RenameDoorActor): RenameDoor | null {
  if (!a.id || !a.permissions.has('plans.manage')) return null;
  return Object.freeze({
    id: a.id,
    permissions: new Set(a.permissions),
    warehouseScoped: a.warehouseScoped,
    warehouseIds: [...a.warehouseIds],
  }) as unknown as RenameDoor;
}

/**
 * The permission half: `plans.manage` — on the seed exactly super_admin,
 * admin and logist, his 2a «faqat admin va logist», the same grant the count
 * doors use for the same words, editable on /admin/roles (#170) — plus the
 * truck card's own two-ends door (never restated). NOT `batches.depart_close`:
 * the warehouse manager holds it, and his answer excluded him.
 */
export function renameDoorOpens(
  a: Pick<RenameDoorActor, 'permissions' | 'warehouseScoped' | 'warehouseIds'>,
  b: BatchEnds,
): boolean {
  return a.permissions.has('plans.manage') && mayOpenBatchCard(a, b);
}

/**
 * The whole rule. Before departure the door is today's (plans.manage at the
 * ORIGIN — the cargo is still there); on the road either end, which is the
 * card's own door; once closed, nobody, admin included.
 */
export function mayRenameBatch(
  a: Pick<RenameDoorActor, 'permissions' | 'warehouseScoped' | 'warehouseIds'>,
  b: BatchEnds,
  stage: RenameStage,
): boolean {
  if (stage === 'closed') return false;
  if (!renameDoorOpens(a, b)) return false;
  return stage === 'road' || inScope(a, b.originWarehouseId);
}
