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
 * One row of the «Narx» tab's table (the owner, 2026-11-08, his 1a: «1
 * mashinada 1 clientda 10 15 ta prixoda va har birida bitim bolsa narx
 * berishda faqat 1 dona bitim tanlaydigan bolib qolgan»): a deal's own part,
 * or the «bitimsiz» part, with its typed amount. `derive` is no part — the
 * table is drawn only where somebody has to choose.
 */
export type TruckDealPart = { choice: TruckDealChoice; amount: number };

export type TruckDealPartsRefusal = TruckDealRefusal | 'deal_parts_empty' | 'deal_part_duplicate';

/** The part a refusal is about, as the table posts it: the deal's id, or 'none'. */
export const partKeyOf = (choice: TruckDealChoice): string =>
  choice.kind === 'deal' ? choice.dealId : choice.kind;

/**
 * One press of the table, decided — beside `truckDealDecision` and built from
 * it, so a part is admitted by exactly the branches a single price is (#513).
 * Asked by the price door on the pool and again inside its transaction.
 *
 * The order is the refusals' priority: a page drawn under another question
 * first (Q8's rule — nothing else it says can be trusted), then a table posted
 * for a client nobody has to ask (a stale or forged post: the table is drawn
 * only for an ambiguous client), then the shape of the press, then each part.
 * `at` names the part a refusal is about, so the screen can mark its row.
 */
export function truckDealParts(
  candidates: DealCandidates,
  parts: TruckDealPart[],
  seen: string,
):
  | { ok: true; parts: { dealId: string | null; via: 'chosen' | 'none'; amount: number }[] }
  | { ok: false; code: TruckDealPartsRefusal; at?: string } {
  if (seen !== candidates.key) return { ok: false, code: 'deals_changed' };
  if (!candidates.ambiguous) return { ok: false, code: 'deal_choice_invalid' };
  if (parts.length === 0) return { ok: false, code: 'deal_parts_empty' };
  const keys = new Set<string>();
  const out: { dealId: string | null; via: 'chosen' | 'none'; amount: number }[] = [];
  for (const part of parts) {
    const at = partKeyOf(part.choice);
    if (keys.has(at)) return { ok: false, code: 'deal_part_duplicate', at };
    keys.add(at);
    // On an ambiguous truck `derive` would answer «choose» — but a table
    // row always names its deal, so a derived part is a malformed post.
    if (part.choice.kind === 'derive') return { ok: false, code: 'deal_choice_invalid', at };
    const decided = truckDealDecision(candidates, part.choice, seen);
    if (!decided.ok) return { ok: false, code: decided.code, at };
    // `derived` is unreachable here (no derive part); narrowed for the type.
    out.push({ dealId: decided.dealId, via: decided.via === 'none' ? 'none' : 'chosen', amount: part.amount });
  }
  return { ok: true, parts: out };
}

/**
 * A live price of the client on this truck, as the «already priced here»
 * reading needs it. `chosenNone` — its create audit says the person CHOSE
 * «bitimsiz» (`dealVia: 'none'`); every other deal-less price was written
 * before the deals were known or before Q8, and is the whole cargo's.
 */
export interface TruckPriceHere {
  id: string;
  dealId: string | null;
  usd: number;
  chosenNone: boolean;
}

/**
 * What already stands for a client on a truck — the ONE reading behind «Bu
 * mashinadagi narxlar» (`unpricedDealsOf`) and every row of the price table
 * (its pre-fill and its ask), so the two cannot disagree about which price
 * covers what (#513; judge P1-UX-4).
 *
 * - `byDeal` — each offered deal's own live prices here;
 * - `none` — the chosen «bitimsiz» part (`chosenNone`);
 * - `whole` — every OTHER deal-less price here, on a truck with deal-less
 *   cargo too (a pre-Q8 price there is still the whole cargo's: the audit
 *   tells it from a chosen part), and every price on a deal that is no longer
 *   among the candidates. Truck coverage ignores the deal (unpriced.ts), so
 *   each of them already covers every carton of the client aboard: while one
 *   stands nothing is pre-filled and every filled row asks, naming it.
 */
export interface PricedHereReading {
  byDeal: Map<string, TruckPriceHere[]>;
  none: TruckPriceHere[];
  whole: TruckPriceHere[];
}

export function pricedHereReading(candidates: DealCandidates, prices: TruckPriceHere[]): PricedHereReading {
  const byDeal = new Map<string, TruckPriceHere[]>();
  const none: TruckPriceHere[] = [];
  const whole: TruckPriceHere[] = [];
  for (const price of prices) {
    if (price.dealId !== null && candidates.deals.includes(price.dealId)) {
      byDeal.set(price.dealId, [...(byDeal.get(price.dealId) ?? []), price]);
    } else if (price.dealId === null && price.chosenNone) {
      none.push(price);
    } else {
      whole.push(price);
    }
  }
  return { byDeal, none, whole };
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
 * - `whole` — a whole-cargo price stands (`pricedHereReading`): a deal-less
 *   price nobody chose as «bitimsiz» — written before the deals were known or
 *   before Q8, on a truck with or without deal-less cargo — or a price on a
 *   deal whose cargo left. It covers every carton of the client aboard. Said
 *   so, muted — bold «narx yo'q» under it invited two more bills (review).
 * - `missing` — nothing covers this deal's part on the truck yet; loud only
 *   once the client has some price here (before that, «Narx: —» says it).
 */
export function unpricedDealsOf(
  candidates: DealCandidates,
  prices: TruckPriceHere[],
  cardPriced: (dealId: string) => boolean,
): { dealId: string; why: 'card' | 'whole' | 'missing'; loud: boolean }[] {
  if (!candidates.ambiguous) return [];
  const reading = pricedHereReading(candidates, prices);
  const whole = reading.whole.length > 0;
  return candidates.deals
    .filter((dealId) => !reading.byDeal.has(dealId))
    .map((dealId) => {
      if (cardPriced(dealId)) return { dealId, why: 'card' as const, loud: false };
      if (whole) return { dealId, why: 'whole' as const, loud: false };
      return { dealId, why: 'missing' as const, loud: prices.length > 0 };
    });
}
