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

/**
 * The person asking, WITH their identity. The service refuses a door whose
 * `id` is not the audit context's actor, so a door built for somebody else —
 * or a literal «planner, unscoped» object handed in beside another person's
 * id — opens nothing (the count door's rule, `count-door.ts` `doorOpens`).
 */
export interface RenameDoorActor extends ScopedActor {
  id: string;
  permissions: ReadonlySet<string>;
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
