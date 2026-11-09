/**
 * The price the seller SOLD this cargo at, beside the box where the truck's
 * price is typed (the owner, 2026-09-26: «partiyada narx berayotganda … bitim
 * … sotgan narxi … ogohlantirish bolib korib tursin kam yokida kop narx berib
 * qoymaslikni oldini oladi»), and his rule for when to stop the press: a
 * difference over 5 % asks for a confirmation, then saves.
 *
 * Pure, so the browser's check and its test are the same arithmetic. A deal
 * is quoted for its WHOLE cargo, and a truck may carry part of it, so the
 * expected price is the quote scaled by this truck's share of the quoted
 * measure — m³ first, then kg, else the whole quote. Only a dollar quote is
 * compared: a so'm quote has no honest dollar figure without a rate.
 */
import { ownDealOf } from './truck-deal';

export const PRICE_DEVIATION_LIMIT = 0.05;

export interface DealQuote {
  amount: number | null;
  currency: string | null;
  m3: number | null;
  kg: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function expectedPriceFor(quote: DealQuote, cargo: { m3: number; kg: number }): number | null {
  if (quote.amount === null || !(quote.amount > 0) || quote.currency !== 'USD') return null;
  if (quote.m3 !== null && quote.m3 > 0 && cargo.m3 > 0) return round2((quote.amount * cargo.m3) / quote.m3);
  if (quote.kg !== null && quote.kg > 0 && cargo.kg > 0) return round2((quote.amount * cargo.kg) / quote.kg);
  return round2(quote.amount);
}

/** Signed share of the difference, e.g. −0.12 = 12 % under the deal. */
export function deviationOf(typedUsd: number, expectedUsd: number): number | null {
  if (!Number.isFinite(typedUsd) || !(expectedUsd > 0)) return null;
  return (typedUsd - expectedUsd) / expectedUsd;
}

export function needsConfirmation(typedUsd: number, expectedUsd: number | null): boolean {
  if (expectedUsd === null) return false;
  const d = deviationOf(typedUsd, expectedUsd);
  return d !== null && Math.abs(d) > PRICE_DEVIATION_LIMIT;
}

/**
 * One deal's part of a client's cargo on a truck.
 *
 * The owner, 2026-09-26: «agar 1 ta klientni 3 4 ta prixodiga narx beriladgan
 * bolsa tepasida umumiy bitim qiymatlari korinsin». The price box is ONE per
 * client (his 1c), while the client's goods aboard may belong to several
 * prixods and several deals — and the deal block used to appear only when
 * all of them shared ONE deal (R3a's sole deal), so the commonest busy
 * client saw nothing at all. Each deal now gets its share of the cargo, and
 * the screen prints the sum on top.
 *
 * Only the client's OWN deals (`ownDealOf`): a prixod re-assigned to this
 * client still names its old client's deal, and that job's quote, floor and
 * upsale are not this client's — such a lot reads as unlinked here, exactly
 * as the price door treats it. `clientId` is required: an optional one would
 * fail open.
 */
export interface DealShare {
  dealId: string;
  dealCode: string | null;
  m3: number;
  kg: number;
  receipts: number;
}

export function dealSharesOf(
  lots: {
    dealId: string | null;
    dealClientId: string | null;
    dealCode: string | null;
    m3: number;
    kg: number;
    receiptId: string;
  }[],
  clientId: string,
): { shares: DealShare[]; receipts: number; unlinkedReceipts: number } {
  const byDeal = new Map<string, DealShare & { ids: Set<string> }>();
  const unlinked = new Set<string>();
  for (const lot of lots) {
    const dealId = ownDealOf(lot, clientId);
    if (!dealId) {
      unlinked.add(lot.receiptId);
      continue;
    }
    const share = byDeal.get(dealId) ?? {
      dealId,
      dealCode: lot.dealCode,
      m3: 0,
      kg: 0,
      receipts: 0,
      ids: new Set<string>(),
    };
    share.m3 += lot.m3;
    share.kg += lot.kg;
    share.ids.add(lot.receiptId);
    byDeal.set(dealId, share);
  }
  const shares = [...byDeal.values()].map(({ ids, ...share }) => ({
    ...share,
    m3: Math.round(share.m3 * 1000) / 1000,
    kg: Math.round(share.kg * 10) / 10,
    receipts: ids.size,
  }));
  return {
    shares,
    receipts: new Set(lots.map((lot) => lot.receiptId)).size,
    unlinkedReceipts: unlinked.size,
  };
}

/**
 * The price the deals say THIS truck's goods were sold for — each deal's
 * quote scaled on its own share, summed. Null (so nothing is compared and
 * nothing asks for a confirmation) the moment any part is unknown: goods on
 * no deal, or a deal with no dollar quote. A sum over part of the cargo
 * would call an honest price «too high» by exactly the part it skipped.
 */
export function expectedForDeals(
  quotes: Map<string, DealQuote>,
  shares: DealShare[],
  unlinkedReceipts: number,
): number | null {
  if (shares.length === 0 || unlinkedReceipts > 0) return null;
  let sum = 0;
  for (const share of shares) {
    const quote = quotes.get(share.dealId);
    if (!quote) return null;
    const expected = expectedPriceFor(quote, { m3: share.m3, kg: share.kg });
    if (expected === null) return null;
    sum += expected;
  }
  return round2(sum);
}

/**
 * Dollars rounded UP to the cent — the pre-fill's one rounding. The upsale's
 * invoice check (`due_price_usd`, calc/upsale.ts) rounds the SAME product to
 * the nearest cent and refuses anything below it, so a pre-fill rounded the
 * ordinary way lands a cent short half the time and the deal reads
 * «hisob-faktura yo'q» for ever (judge P1-prefill-basis). A product that is
 * already a whole cent stays where it is: floating point must not push
 * 1000 × 0.3 / 0.3 to $1000.01.
 */
export function ceilCents(usd: number): number {
  const cents = usd * 100;
  const near = Math.round(cents);
  return (Math.abs(cents - near) < 1e-6 ? near : Math.ceil(cents)) / 100;
}

/**
 * A deal's EXACT share of the cargo on this truck — Σ of its lots' stored
 * volume and weight × boxes aboard ÷ boxes in the lot, never rounded. The lot
 * rows round m³ to three places and the deal's sum rounds again
 * (`dealSharesOf`); the upsale sums the stored four-place volume exactly, and a
 * bill built on the rounded figure undercuts it (judge P1-prefill-basis). Own
 * deals only, by the one predicate (`ownDealOf`).
 */
export function exactSharesOf(
  lots: {
    dealId: string | null;
    dealClientId: string | null;
    lotM3: number;
    lotKg: number;
    onBatch: number;
    lotBoxCount: number;
  }[],
  clientId: string,
): Map<string, { m3: number; kg: number }> {
  const out = new Map<string, { m3: number; kg: number }>();
  for (const lot of lots) {
    const dealId = ownDealOf(lot, clientId);
    if (!dealId || !(lot.lotBoxCount > 0)) continue;
    const share = lot.onBatch / lot.lotBoxCount;
    const sum = out.get(dealId) ?? { m3: 0, kg: 0 };
    sum.m3 += lot.lotM3 * share;
    sum.kg += lot.lotKg * share;
    out.set(dealId, sum);
  }
  return out;
}

/**
 * The price a deal SOLD this truck's part of its cargo at — for a BILL, not a
 * hint. Unlike `expectedPriceFor` it never falls back to the whole quote: a
 * quote with no measure, or cargo here with none on the quote's basis, has no
 * part on one truck that anybody stated, and the whole quote pre-filled on
 * every truck the deal rides bills the client once per truck (judges F5,
 * P1-prefill-whole-quote). The basis is the upsale's own (`cargo_factor`,
 * calc/upsale.ts): kg when the deal's freight was priced per kg, else m³,
 * else kg — so the figure is the very product its invoice check compares
 * with, rounded UP (`ceilCents`).
 */
export function expectedPartFor(
  quote: DealQuote,
  cargo: { m3: number; kg: number },
  perKg: boolean,
): { usd: number; basis: 'm3' | 'kg' } | null {
  if (quote.amount === null || !(quote.amount > 0) || quote.currency !== 'USD') return null;
  const basis: 'm3' | 'kg' | null =
    perKg && quote.kg !== null && quote.kg > 0
      ? 'kg'
      : quote.m3 !== null && quote.m3 > 0
        ? 'm3'
        : quote.kg !== null && quote.kg > 0
          ? 'kg'
          : null;
  if (basis === null) return null;
  const here = basis === 'm3' ? cargo.m3 : cargo.kg;
  const quoted = basis === 'm3' ? quote.m3! : quote.kg!;
  if (!(here > 0)) return null;
  return { usd: ceilCents((quote.amount * here) / quoted), basis };
}

/**
 * Why a row of the price table is NOT pre-filled — in the order the row says
 * it (the most useful reason first).
 */
export type PrefillWhy =
  | 'sight'
  | 'continuation'
  | 'whole'
  | 'off_elsewhere'
  | 'priced_here'
  | 'priced_card'
  | 'priced_elsewhere'
  | 'follows'
  | 'no_quote'
  | 'discount'
  | 'unscaled'
  | 'currency';

/**
 * What the price table knows about one deal row, for its pre-fill. Built on
 * the server; for a reader without the quote sight every money fact is
 * absent (`partUsd` null, `quoted`/`discounted` false), because the VED never
 * reads a client price (law 4).
 */
export interface PrefillFacts {
  /** The owner's and the accountant's sight (`dealPriceSight`). */
  sight: boolean;
  /** `expectedPartFor(…).usd` — null when the deal has no part to state. */
  partUsd: number | null;
  /** The deal carries a positive dollar quote. */
  quoted: boolean;
  /** A recorded damage discount: the quote is gross of it. */
  discounted: boolean;
  /** The deal's own live price on THIS truck. */
  pricedHere: boolean;
  /** …on its card (no truck). */
  pricedCard: boolean;
  /** …on other trucks: their codes. */
  pricedOn: string[];
  /** A carton of the deal aboard whose price sits on an earlier truck («davomi»). */
  follows: boolean;
  /** The whole trip is a continuation: nothing here is priced at all. */
  continuation: boolean;
  /** The client has another truck's price whose dropped cartons ride this one. */
  offElsewhere: boolean;
  /** A whole-cargo price stands for the client here (`pricedHereReading`). */
  whole: boolean;
}

/**
 * The pre-fill of one deal row (the owner's 1a/2a, 2026-11-08: each row
 * pre-filled with the deal's own sold price for its cargo on this truck, for
 * the owner and the accountant), as a PURE rule so the screen, its test and
 * the reason the row prints are one (#166).
 *
 * A value only when everything holds — each exclusion is a way this page
 * already knows the deal's cargo here is priced, or a figure nobody stated,
 * and a pre-fill is one tap away from a bill (judges F5, P1-UX-1/2/4): the
 * quote sight; no continuation trip; no whole-cargo price; no other truck's
 * price whose cartons ride here; the deal priced nowhere yet (here, on its
 * card, on another truck — a deal split over two trucks is pre-filled on the
 * first only); no «davomi» carton of the deal aboard; a dollar quote with no
 * discount, scaled by a measure; and dollars typed. Asked in the browser too,
 * with the currency the select holds NOW.
 */
export function prefillFor(facts: PrefillFacts, currency: string): { usd: number } | { none: PrefillWhy } {
  if (!facts.sight) return { none: 'sight' };
  if (facts.continuation) return { none: 'continuation' };
  if (facts.whole) return { none: 'whole' };
  if (facts.offElsewhere) return { none: 'off_elsewhere' };
  if (facts.pricedHere) return { none: 'priced_here' };
  if (facts.pricedCard) return { none: 'priced_card' };
  if (facts.pricedOn.length > 0) return { none: 'priced_elsewhere' };
  if (facts.follows) return { none: 'follows' };
  if (!facts.quoted) return { none: 'no_quote' };
  if (facts.discounted) return { none: 'discount' };
  if (facts.partUsd === null || !(facts.partUsd > 0)) return { none: 'unscaled' };
  if (currency !== 'USD') return { none: 'currency' };
  return { usd: facts.partUsd };
}
