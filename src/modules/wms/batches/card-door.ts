import { inScope, type ScopedActor } from '../../platform/rbac/scope';
import { pricingSight } from '../finance/pricing-view';

/**
 * The truck card's doors — ONE predicate per tab, asked by the tab's page AND
 * by the card's strip, so a drawn tab can never bounce and a tab the page
 * admits is never hidden (docs/CARD-TABS.md, rule 2; #1023's «a link that
 * bounces is worse than no link»).
 *
 * The card itself is judged by its TWO ends, exactly the rule the batch list
 * uses: a trip belongs to both warehouses. It carries no permission of its
 * own — sellers reach a truck from a client's cargo, the accountant from the
 * money screens — and narrowing it is not this round's call (stated).
 */
export interface BatchEnds {
  originWarehouseId: string;
  destWarehouseId: string;
}

export function mayOpenBatchCard(actor: ScopedActor, batch: BatchEnds): boolean {
  return inScope(actor, batch.originWarehouseId) || inScope(actor, batch.destWarehouseId);
}

type Grants = { has(code: string): boolean };

/** «Xarajatlar»: whoever enters a truck's bills, or reads every warehouse's reports. */
export function mayOpenBatchCosts(permissions: Grants): boolean {
  return permissions.has('costs.enter_batch') || permissions.has('reports.all_warehouses');
}

/** «Narx» — the pricing page's own answer (`pricingSight`), nothing restated. */
export function mayOpenBatchPricing(permissions: ReadonlySet<string>, internal: boolean): boolean {
  return pricingSight(permissions, internal) !== 'none';
}

/** «Bojxona»: the VED's papers, customs and TNVED codes — and the logist who plans the truck. */
export function mayOpenBatchVed(permissions: Grants): boolean {
  return permissions.has('ved.docs') || permissions.has('plans.manage');
}

/** The card's six tabs, in the strip's order. A key is also the testid suffix. */
export const BATCH_TABS = ['tarkib', 'yuklash', 'xarajat', 'narx', 'bojxona', 'yol'] as const;
export type BatchTab = (typeof BATCH_TABS)[number];

/** Where each tab lives — the existing URLs keep their names (rule 1). */
export function batchTabHref(batchId: string, tab: BatchTab): string {
  const base = `/batches/${batchId}`;
  switch (tab) {
    case 'tarkib':
      return base;
    case 'yuklash':
      return `${base}/yuklash`;
    case 'xarajat':
      return `${base}/xarajatlar`;
    case 'narx':
      return `${base}/pricing`;
    case 'bojxona':
      return `${base}/tnved`;
    case 'yol':
      return `${base}/yol`;
  }
}

/**
 * Which tabs this person is offered on this truck. The card door is asked by
 * the caller first (every tab is behind it); the rest are the tab pages' own
 * predicates above.
 */
export function batchTabsFor(
  actor: ScopedActor & { permissions: ReadonlySet<string> },
  internal: boolean,
): BatchTab[] {
  return BATCH_TABS.filter((tab) => {
    switch (tab) {
      case 'tarkib':
      case 'yuklash':
      case 'yol':
        return true;
      case 'xarajat':
        return mayOpenBatchCosts(actor.permissions);
      case 'narx':
        return mayOpenBatchPricing(actor.permissions, internal);
      case 'bojxona':
        return mayOpenBatchVed(actor.permissions);
    }
  });
}
