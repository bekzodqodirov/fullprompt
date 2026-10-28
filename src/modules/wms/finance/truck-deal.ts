/**
 * A truck price's deal — which jobs a client's cargo on a truck rides under,
 * and what the person setting the price chose (owner's R3a, 2026-09-24, and
 * his Q8 «c», 2026-10-27: «logist o'zi tanlaydi»).
 *
 * Pure and import-free on purpose: the price door asks it on the pool and
 * again inside its transaction, the «Narx» tab and the client ledger draw
 * their question from it, and the two forms that post the answer run it in
 * the browser — one arithmetic everywhere (#513).
 */

/**
 * A rider's deal as far as ITS client's money is concerned: the receipt's
 * deal when that deal is the client's own, else none. `assignReceiptClient`
 * moves a prixod to another client and leaves `receipts.deal_id` on the old
 * client's job (unpriced.ts), and no price, quote or share of this client may
 * reach somebody else's job through that stale link. Every pricing reader
 * asks this one predicate — the candidates, the deal block's shares, the
 * quotes it loads — so the screen and the price door cannot disagree about
 * which deals a client's cargo belongs to (#513).
 */
export function ownDealOf(row: { dealId: string | null; dealClientId: string | null }, clientId: string): string | null {
  return row.dealId && row.dealClientId === clientId ? row.dealId : null;
}

/**
 * Which deals a price for this client on this truck may be written to (the
 * owner's R3a, 2026-09-24, and his Q8 «c», 2026-10-27).
 *
 * - `deals` — the client's OWN deals among its riders, sorted (`ownDealOf`).
 * - `none` — some of its riders have no deal of theirs.
 * - `sole` — R3a: the one deal when the client's cargo aboard is that deal's
 *   and nothing else. The price is then that job's money too, derived and
 *   announced, never asked.
 * - `ambiguous` — two or more of the client's deals ride this truck: his «c»,
 *   «logist o'zi tanlaydi». The person setting the price CHOOSES the deal
 *   (or, when some cargo is deal-less, «bitimsiz»), and the door refuses a
 *   price with no choice.
 * - `key` — what the form was drawn with, echoed back (`dealsSeen`), so a
 *   prixod re-filed between the drawing and the press is a refusal instead
 *   of a price on a deal nobody chose.
 *
 * One deal beside deal-less cargo is NOT ambiguous and names no deal, as
 * R3a always said: the price covers all the client's goods aboard while a
 * deal's profit counts the cost of its own boxes only, so the deal-less
 * goods' price riding onto it would print a margin nobody earned. His
 * question was about two deals; that mix stays as it was.
 */
export interface DealCandidates {
  deals: string[];
  none: boolean;
  sole: string | null;
  ambiguous: boolean;
  key: string;
}

export function dealCandidatesOf(
  rows: { dealId: string | null; dealClientId: string | null }[],
  clientId: string,
): DealCandidates {
  const own = new Set<string>();
  let none = false;
  for (const row of rows) {
    const deal = ownDealOf(row, clientId);
    if (deal) own.add(deal);
    else none = true;
  }
  const deals = [...own].sort();
  return {
    deals,
    none,
    sole: deals.length === 1 && !none ? deals[0]! : null,
    ambiguous: deals.length >= 2,
    key: `${deals.join(',')}${none ? '|none' : ''}`,
  };
}

/**
 * What the person asked a truck price's deal to be. Read off the form ONCE
 * (`addTransaction`), so the «bitimsiz» sentinel never reaches a uuid column
 * or a uuid query.
 */
export type TruckDealChoice = { kind: 'deal'; dealId: string } | { kind: 'none' } | { kind: 'derive' };

export type TruckDealRefusal =
  | 'deals_changed'
  | 'deal_not_aboard'
  | 'deal_choice_required'
  | 'deal_choice_invalid';

/**
 * The truck price's deal, decided — the ONE rule, asked by the price door on
 * the pool and again inside its transaction (pure, so both are the same
 * arithmetic). Every door that writes a truck price comes through it: the
 * «Narx» tab, the client's ledger form, a script.
 */
export function truckDealDecision(
  candidates: DealCandidates,
  choice: TruckDealChoice,
  seen: string | undefined,
):
  | { ok: true; dealId: string | null; via: 'chosen' | 'derived' | 'none' }
  | { ok: false; code: TruckDealRefusal } {
  // The form says which question it drew. A different question now is a
  // page drawn before the cargo moved — never answered on its behalf.
  if (seen !== undefined && seen !== candidates.key) return { ok: false, code: 'deals_changed' };
  if (choice.kind === 'deal') {
    if (!candidates.deals.includes(choice.dealId)) return { ok: false, code: 'deal_not_aboard' };
    // One deal beside deal-less cargo names no deal (R3a): the deal's own
    // id posted there is refused, not quietly honoured.
    if (!candidates.ambiguous && choice.dealId !== candidates.sole) return { ok: false, code: 'deal_choice_invalid' };
    return { ok: true, dealId: choice.dealId, via: 'chosen' };
  }
  if (choice.kind === 'none') {
    // «Bitimsiz» is the deal-less PART of a two-deal client's cargo. On a
    // truck that carries only his deals it is option (a), which he turned
    // down; anywhere unambiguous it answers a question nobody asked.
    if (!candidates.ambiguous || !candidates.none) return { ok: false, code: 'deal_choice_invalid' };
    return { ok: true, dealId: null, via: 'none' };
  }
  if (candidates.ambiguous) return { ok: false, code: 'deal_choice_required' };
  return { ok: true, dealId: candidates.sole, via: 'derived' };
}

/**
 * The choice a deal select shows: the person's own, while it was made under
 * the question drawn now and is still one of its options; else nothing.
 *
 * The form keeps its state across a revalidation while the page redraws the
 * options around it, and a controlled select whose value matches no option is
 * shown — and POSTED — as its first enabled option: the first deal, which
 * nobody chose (review). Blank instead, and `required` asks again.
 */
export function shownDealChoice(
  choice: { deal: string; seen: string } | null,
  seen: string,
  options: string[],
): string {
  return choice && choice.seen === seen && options.includes(choice.deal) ? choice.deal : '';
}

/**
 * «Bu mashinadagi narxlar»: each of an asked client's deals that has no price
 * of its own on this truck, and what to say about it.
 *
 * - `card` — the deal carries a live price of its own off any truck; the
 *   unpriced rule's deal clause covers its cartons here, so «narx yo'q» would
 *   invite a second bill for the same job.
 * - `whole` — a price with NO deal is already on the truck while none of the
 *   client's cargo here is deal-less (`!none`). It is not a chosen «bitimsiz»
 *   part (none is offered on such a truck): it is a whole-cargo price, written
 *   before the deals were known or before Q8, and it covers every carton of
 *   the client aboard. Said so, muted — bold «narx yo'q» under it invited two
 *   more bills (review).
 * - `missing` — nothing covers this deal's part on the truck yet; loud only
 *   once the client has some price here (before that, «Narx: —» says it).
 */
export function unpricedDealsOf(
  candidates: DealCandidates,
  prices: { dealId: string | null }[],
  cardPriced: (dealId: string) => boolean,
): { dealId: string; why: 'card' | 'whole' | 'missing'; loud: boolean }[] {
  if (!candidates.ambiguous) return [];
  const whole = !candidates.none && prices.some((price) => price.dealId === null);
  return candidates.deals
    .filter((dealId) => !prices.some((price) => price.dealId === dealId))
    .map((dealId) => {
      if (cardPriced(dealId)) return { dealId, why: 'card' as const, loud: false };
      if (whole) return { dealId, why: 'whole' as const, loud: false };
      return { dealId, why: 'missing' as const, loud: prices.length > 0 };
    });
}
