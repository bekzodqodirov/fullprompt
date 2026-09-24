import type { BatchLot } from '../batches/lots';
import type { LotLandedCost } from '../costing/service';

/**
 * «Partiya moliyasi», assembled (owner, 2026-09-24: the truck's money by
 * GOODS, the price still one per client — his answer 1c).
 *
 * Pure, so the arithmetic the header prints can be tested without a page:
 * which lots belong to whom, what each client's goods cost, which charges
 * have no cargo left under them, and the three totals. The page only draws.
 */
export interface PricingCharge {
  clientId: string;
  clientCode: string;
  clientName: string;
  type: string;
  amountUsd: number;
}

export interface PricingClientGroup {
  clientId: string;
  code: string;
  name: string;
  lots: BatchLot[];
  boxes: number;
  kg: number;
  m3: number;
  costUsd: number;
  /** The part of `costUsd` the cargo brought with it — «shu reysgacha». */
  prevUsd: number;
  chargedUsd: number;
  /** Null until a price exists: before that every client reads as a loss. */
  marginUsd: number | null;
}

export interface PricingView {
  clients: PricingClientGroup[];
  /** Cargo no client has claimed: it cost money, and it has no price yet. */
  unclaimed: { lots: BatchLot[]; costUsd: number };
  /** Charges on this truck for clients with nothing on it any more. */
  orphans: { clientId: string; code: string; name: string; chargedUsd: number }[];
  totals: { costUsd: number; prevUsd: number; chargedUsd: number; marginUsd: number; priced: number };
}

const cents = (value: number) => Math.round(value * 100) / 100;

export function pricingView(
  lots: BatchLot[],
  lotCost: Map<string, LotLandedCost>,
  charges: PricingCharge[],
): PricingView {
  // The price is the CHARGE and nothing else: a payment tagged with the
  // truck is money received, not money asked, and must not read as a price.
  const charged = new Map<string, { usd: number; code: string; name: string }>();
  for (const row of charges) {
    if (row.type !== 'charge') continue;
    const prev = charged.get(row.clientId);
    charged.set(row.clientId, {
      usd: (prev?.usd ?? 0) + row.amountUsd,
      code: row.clientCode,
      name: row.clientName,
    });
  }

  const costOf = (lot: BatchLot) => lotCost.get(lot.lotId);
  const sumCost = (list: BatchLot[]) => cents(list.reduce((a, l) => a + (costOf(l)?.totalUsd ?? 0), 0));
  const sumPrev = (list: BatchLot[]) =>
    cents(
      list.reduce((a, l) => {
        const cost = costOf(l);
        return a + (cost ? cost.totalUsd - cost.batchUsd : 0);
      }, 0),
    );

  const byClient = new Map<string, { code: string; name: string; lots: BatchLot[] }>();
  const unclaimedLots: BatchLot[] = [];
  for (const lot of lots) {
    if (!lot.clientId) {
      unclaimedLots.push(lot);
      continue;
    }
    const group = byClient.get(lot.clientId) ?? {
      code: lot.clientCode ?? '—',
      name: lot.clientName ?? '',
      lots: [],
    };
    group.lots.push(lot);
    byClient.set(lot.clientId, group);
  }

  const clients: PricingClientGroup[] = [...byClient.entries()].map(([clientId, group]) => {
    const costUsd = sumCost(group.lots);
    const chargedUsd = cents(charged.get(clientId)?.usd ?? 0);
    return {
      clientId,
      code: group.code,
      name: group.name,
      lots: group.lots,
      boxes: group.lots.reduce((a, l) => a + l.onBatch, 0),
      kg: Math.round(group.lots.reduce((a, l) => a + l.kg, 0) * 10) / 10,
      m3: Math.round(group.lots.reduce((a, l) => a + l.m3, 0) * 1000) / 1000,
      costUsd,
      prevUsd: sumPrev(group.lots),
      chargedUsd,
      marginUsd: chargedUsd > 0 ? cents(chargedUsd - costUsd) : null,
    };
  });

  const orphans = [...charged.entries()]
    .filter(([clientId]) => !byClient.has(clientId))
    .map(([clientId, row]) => ({ clientId, code: row.code, name: row.name, chargedUsd: cents(row.usd) }))
    .sort((a, b) => a.code.localeCompare(b.code));

  // The header answers «did this truck earn money?» over EVERYTHING on it:
  // unclaimed cargo cost us money too, and a charge whose client has left
  // the truck is still money asked for this truck.
  const costUsd = sumCost(lots);
  const chargedUsd = cents([...charged.values()].reduce((a, row) => a + row.usd, 0));
  return {
    clients,
    unclaimed: { lots: unclaimedLots, costUsd: sumCost(unclaimedLots) },
    orphans,
    totals: {
      costUsd,
      prevUsd: sumPrev(lots),
      chargedUsd,
      marginUsd: cents(chargedUsd - costUsd),
      priced: clients.filter((group) => group.chargedUsd > 0).length,
    },
  };
}
