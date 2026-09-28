import { mayOpenClientCard } from '../../platform/clients/card-door';
import { mayOpenClientLedger, type MoneyActor } from '../finance/scope';

/**
 * The client card's tabs (docs/CARD-TABS.md): «Umumiy» (the card), «Yuklar»
 * (where the cargo is now) and «Pul» (the ledger), each drawn exactly when
 * the door its page asks admits the viewer — the strip and the pages call the
 * same predicates, so a drawn tab can never bounce.
 *
 * «Yuklar» asks the card's own door, `mayOpenClientCard`, not a copy of it:
 * the tab is the card's cargo block given room, read by the same people
 * (super_admin, admin, logist, sales_manager today), and the accountant and
 * the VED — who open the ledger but never the card — are refused it exactly
 * as they are refused «Umumiy». It carries no money, so no money door.
 */
export const CLIENT_TABS = ['umumiy', 'yuklar', 'pul'] as const;
export type ClientTab = (typeof CLIENT_TABS)[number];

export function clientTabsFor(
  actor: MoneyActor,
  client: { salesManagerId: string | null },
): ClientTab[] {
  const card = mayOpenClientCard(actor);
  return CLIENT_TABS.filter((tab) => (tab === 'pul' ? mayOpenClientLedger(actor, client) : card));
}

/** Where each tab lives — no URL moved (docs/CARD-TABS.md rule 1). */
export function clientTabHref(tab: ClientTab, clientId: string): string {
  if (tab === 'pul') return `/finance/${clientId}`;
  if (tab === 'yuklar') return `/admin/clients/${clientId}/yuklar`;
  return `/admin/clients/${clientId}`;
}
