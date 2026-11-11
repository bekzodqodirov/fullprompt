import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import type { Tx } from '../../platform/db/client';
import { deals, dealStages } from '../../platform/db/schema';
import type { ReceiptDealState } from '../../platform/notifications/receipt-arrival';
import { ownDealOf } from '../finance/truck-deal';

/**
 * A prixod's deal, as its seller is told about it — decided ONCE, on the
 * transaction that writes the fact (docs/PRIXOD-XABARI.md §C.2).
 *
 * Two readers used to derive this separately and could disagree: the
 * `ReceiptConfirmed` event («bitimga biriktirilmagan» / «bitimi yo‘q») and
 * price control (attach / price / compare). Now the confirm asks here, puts
 * the answer on the event and HANDS it to price control — which is what lets
 * the seller's two messages be one.
 *
 * «The prixod's deal» is `ownDealOf`'s: a deal of ANOTHER client — left on
 * the row by a client correction, or posted by a stale form — is no deal of
 * this prixod's. It is never named to this client's seller and never
 * compared against.
 *
 * On the caller's own transaction handle; the pool is off-limits inside one
 * (#714).
 */
export interface ReceiptDeal {
  state: ReceiptDealState;
  /** The prixod's OWN deal — null when it has none. */
  dealId: string | null;
  dealCode: string | null;
  /** The client's open deals worth attaching to — only read when the prixod has no deal of its own. */
  openDealCodes: string[];
}

export async function receiptDealInTx(
  tx: Tx,
  input: { clientId: string; dealId: string | null },
): Promise<ReceiptDeal> {
  const [linked] = input.dealId
    ? await tx
        .select({ id: deals.id, code: deals.code, clientId: deals.clientId, quotedAmount: deals.quotedAmount })
        .from(deals)
        .where(eq(deals.id, input.dealId))
        .limit(1)
    : [];
  const own = linked && ownDealOf({ dealId: linked.id, dealClientId: linked.clientId }, input.clientId) ? linked : null;
  if (own) {
    // The AMOUNT decides, never «incomparable»: a deal priced at $4,000 with
    // no volume or weight on it is properly quoted (price control's own rule).
    return {
      state: own.quotedAmount === null ? 'unpriced' : 'priced',
      dealId: own.id,
      dealCode: own.code,
      openDealCodes: [],
    };
  }
  const open = await tx
    .select({ code: deals.code })
    .from(deals)
    .innerJoin(dealStages, eq(deals.stageId, dealStages.id))
    .where(
      and(
        eq(deals.clientId, input.clientId),
        eq(dealStages.kind, 'open'),
        // …and it must be something a person could ATTACH cargo to. An empty
        // deal is not: round 111 opens one automatically with every client
        // code, and round 107 already opens one on every won lead, so without
        // this the first arrival for nearly every new customer would read
        // «biriktiring» — pointing at a shell with no price — instead of
        // «narx qo'ying», and the seller who attached it would then have
        // silenced the alarm for good. A deal carries weight once somebody
        // has put a price or a goods list on it.
        or(
          isNotNull(deals.quotedAmount),
          // `${deals}.id`, not `${deals.id}` — inside a correlated subquery
          // drizzle would render the bare column against deal_lines and the
          // EXISTS would be true for every deal that has any line at all
          // (#128).
          sql`EXISTS (SELECT 1 FROM deal_lines WHERE deal_lines.deal_id = ${deals}.id)`,
        ),
      ),
    )
    .limit(4);
  const openDealCodes = open.map((row) => row.code);
  return { state: openDealCodes.length > 0 ? 'attachable' : 'none', dealId: null, dealCode: null, openDealCodes };
}
