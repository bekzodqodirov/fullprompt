import type { BatchLot } from '../batches/lots';
import type { LotLandedCost } from '../costing/service';
import type { TripCoverage } from './unpriced';
import { moneyHidden } from '../../platform/rbac/money-sight';

/**
 * What «Partiya moliyasi» shows this reader (owner, 2026-09-25, Q19) — ONE
 * answer for the page, its door on the batch card and every link that points
 * at it (#513: a link that bounces is worse than no link, #1023).
 *
 * - `full`  — cost, price and margin: the accountant, the admins, the owner.
 * - `price` — the goods, kg/m³, their fate, the price and its form, and no
 *   cost at all: the VED. He forbade SEEING the tannarx, not pricing (the
 *   VED prices trucks since Phase 2.1, #108), so the page stays his and
 *   never READS the tannarx for him.
 * - `none`  — no door: no `finance.manage`, or an internal leg for the VED,
 *   whose page is a cost page and nothing else (C1a).
 */
export type PricingSight = 'full' | 'price' | 'none';

export function pricingSight(permissions: ReadonlySet<string>, internal: boolean): PricingSight {
  if (!permissions.has('finance.manage')) return 'none';
  if (!moneyHidden('results', permissions)) return 'full';
  return internal ? 'none' : 'price';
}

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
  /**
   * The cartons' fate (U35), counted over the same lots: lost and still
   * missing are INSIDE `boxes`/`kg` (their cost stays, #833), left-behind
   * ones are not on this truck at all. `arrivedKg` is what a per-kilo price
   * is honestly measured against.
   */
  fate: { lost: number; missing: number; leftBehind: number; arrivedBoxes: number; arrivedKg: number };
  costUsd: number;
  /** The part of `costUsd` the cargo brought with it — «shu reysgacha». */
  prevUsd: number;
  chargedUsd: number;
  /** Null until a price exists: before that every client reads as a loss. */
  marginUsd: number | null;
  /**
   * The deal a price typed here is ALSO written to (`soleDealOf`), so the
   * screen says so before the press; null when there is none to name.
   */
  dealId: string | null;
  dealCode: string | null;
}

export interface PricingView {
  clients: PricingClientGroup[];
  /** Cargo no client has claimed: it cost money, and it has no price yet. */
  unclaimed: { lots: BatchLot[]; costUsd: number };
  /** Charges on this truck for clients with nothing on it any more. */
  orphans: { clientId: string; code: string; name: string; chargedUsd: number }[];
  /**
   * `noCargoUsd` (0104, Q21 under his (a)) is a PART of `chargedUsd`, never
   * subtracted from it: the orphans' prices stay in the truck's «Narx» and
   * margin, and the header says «shundan … — yuki ketmagan mijozlar» beside
   * them. «Partiya foydasi» prints the same part (`noCargoChargeUsd`).
   */
  totals: {
    costUsd: number;
    prevUsd: number;
    chargedUsd: number;
    noCargoUsd: number;
    marginUsd: number;
  };
}

const cents = (value: number) => Math.round(value * 100) / 100;

/**
 * The one deal a client's cargo on a truck belongs to — or null (owner's
 * R3a, 2026-09-24: «mashinada qo'yilgan narx bitimga ham yozilsin»). A price
 * set on the truck is then that job's money too, and `addTransaction` writes
 * it onto the charge.
 *
 * Strict on purpose: a mix of deal and deal-less cargo is null, not the deal.
 * The price covers ALL the client's goods aboard while a deal's profit counts
 * the cost of its own boxes only — so the deal-less goods' price riding onto
 * it would print a margin nobody earned. Two deals is null for the same
 * reason from the other side: splitting one price between them is an
 * allocation nobody made.
 */
export function soleDealOf(lots: { dealId: string | null }[]): string | null {
  const ids = new Set(lots.map((lot) => lot.dealId));
  if (ids.size !== 1) return null;
  return [...ids][0] ?? null;
}

/** The fate counts of a set of lots (U35), summed as the rows print them. */
export function fateOf(lots: BatchLot[]): PricingClientGroup['fate'] {
  const lost = lots.reduce((a, l) => a + l.lostCount, 0);
  const missing = lots.reduce((a, l) => a + l.missingCount, 0);
  return {
    lost,
    missing,
    leftBehind: lots.reduce((a, l) => a + l.leftBehindCount, 0),
    arrivedBoxes: lots.reduce((a, l) => a + l.onBatch, 0) - lost - missing,
    arrivedKg: Math.round(lots.reduce((a, l) => a + l.arrivedKg, 0) * 10) / 10,
  };
}

/**
 * `batchCharges` rows as the view reads them — ONE mapping for the pricing
 * page and the truck card's header, which print the same totals (#513).
 */
export function pricingChargesOf(
  rows: { tx: { clientId: string; type: string; amountUsd: string | null }; clientCode: string; clientName: string }[],
): PricingCharge[] {
  return rows.map(({ tx, clientCode, clientName }) => ({
    clientId: tx.clientId,
    clientCode,
    clientName,
    type: tx.type,
    amountUsd: Number(tx.amountUsd),
  }));
}

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
    const dealId = soleDealOf(group.lots);
    return {
      clientId,
      code: group.code,
      name: group.name,
      lots: group.lots,
      boxes: group.lots.reduce((a, l) => a + l.onBatch, 0),
      kg: Math.round(group.lots.reduce((a, l) => a + l.kg, 0) * 10) / 10,
      m3: Math.round(group.lots.reduce((a, l) => a + l.m3, 0) * 1000) / 1000,
      fate: fateOf(group.lots),
      costUsd,
      prevUsd: sumPrev(group.lots),
      chargedUsd,
      marginUsd: chargedUsd > 0 ? cents(chargedUsd - costUsd) : null,
      dealId,
      dealCode: dealId ? (group.lots.find((lot) => lot.dealId === dealId)?.dealCode ?? null) : null,
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
      noCargoUsd: cents(orphans.reduce((a, row) => a + row.chargedUsd, 0)),
      marginUsd: cents(chargedUsd - costUsd),
    },
  };
}

/**
 * «Narx qo'yilgan» for one client on a truck — the header's «N / M» and the
 * pricing page's line under its totals, one answer (#513). Priced when a
 * price sits on THIS truck, or when the unpriced rule (`tripCoverageOn`)
 * finds every carton of theirs aboard covered — by the China truck, by the
 * deal (owner's 1a, 2026-09-28: the handover gate already lets that cargo
 * out, and «0 / 5» on a truck whose cargo is all paid for sent the
 * accountant to price it twice). A client with nothing covered and nothing
 * charged here stays unpriced, and so does one whose cargo is covered only
 * in part.
 *
 * Deliberately NOT «only what the rule covers»: a price typed on this truck
 * before it departs covers nothing yet (the live pointer never counts, Q21),
 * and one on a local leg never covers cargo received in China (Q1) — the
 * accountant's own price on the screen above must not read as «not priced».
 * Those disagreements are the «Narxsiz yuk» list's to name.
 *
 * Its count's charge-only predecessor (`totals.priced`) is gone rather than
 * kept beside it, so no header can go on counting the old way.
 */
export function tripPriced(group: { clientId: string; chargedUsd: number }, coverage: TripCoverage): boolean {
  if (group.chargedUsd > 0) return true;
  return coverage.covered.has(group.clientId) && !coverage.unpriced.has(group.clientId);
}

export function tripPricedCount(clients: { clientId: string; chargedUsd: number }[], coverage: TripCoverage): number {
  return clients.filter((group) => tripPriced(group, coverage)).length;
}
