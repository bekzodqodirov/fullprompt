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
 * all of them shared ONE deal (`soleDealOf`), so the commonest busy client
 * saw nothing at all. Each deal now gets its share of the cargo, and the
 * screen prints the sum on top.
 */
export interface DealShare {
  dealId: string;
  dealCode: string | null;
  m3: number;
  kg: number;
  receipts: number;
}

export function dealSharesOf(
  lots: { dealId: string | null; dealCode: string | null; m3: number; kg: number; receiptId: string }[],
): { shares: DealShare[]; receipts: number; unlinkedReceipts: number } {
  const byDeal = new Map<string, DealShare & { ids: Set<string> }>();
  const unlinked = new Set<string>();
  for (const lot of lots) {
    if (!lot.dealId) {
      unlinked.add(lot.receiptId);
      continue;
    }
    const share = byDeal.get(lot.dealId) ?? {
      dealId: lot.dealId,
      dealCode: lot.dealCode,
      m3: 0,
      kg: 0,
      receipts: 0,
      ids: new Set<string>(),
    };
    share.m3 += lot.m3;
    share.kg += lot.kg;
    share.ids.add(lot.receiptId);
    byDeal.set(lot.dealId, share);
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
