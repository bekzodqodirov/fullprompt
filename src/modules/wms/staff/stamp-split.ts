/**
 * WHOSE revenue and cost a seller row carries (4a — his «a) yuk kelgan kundagi
 * sotuvchiga», 2026-09-29): the branching and the arithmetic, with no imports,
 * so each rule is tested with literals. The SQL that feeds it is
 * stamp-revenue.ts (cost-free — the seller's own card imports it) and
 * stamp-cost.ts (the full table only).
 *
 * The rules, one sentence each (the full statement is the DECISIONS entry):
 *  - WHO: a price belongs to the seller STAMPED on the prixod(s) it prices
 *    (`receipts.sales_manager_id`, written the day the cargo got its client),
 *    never to the client's seller now — the book answers only rule 4's last
 *    clause.
 *  - WHICH prixods: the most specific cargo the row names. A compensation
 *    names its prixod (the CHECK) and its deal is ignored; a truck price
 *    names the client's RIDERS on that truck (the price door's relation,
 *    `clientAboardSql`) and never falls through to its deal — batch beats
 *    deal, as the unpriced rule says; a job's price names the job's
 *    confirmed prixods of that client.
 *  - FALLBACK: a row that names no cargo that is there goes to the stamp of
 *    the client's newest confirmed prixod received by the row's Tashkent day,
 *    and to the book only when the client had no prixod by then.
 *  - SPLIT: cargo of several stamps under one price shares it by a basis
 *    EVERY carton carries — m³, else kg, else the carton count — so a carton
 *    is never worth $0 of a price it rode under. Integer arithmetic, and a
 *    throw rather than an invented or lost cent.
 *  - A NULL stamp is the «—» row, never the book.
 */

export type SellerKey = string | null;

/** One stamp's cartons under one price. Integers — never floats. */
export interface CargoShare {
  sellerId: SellerKey;
  /** Σ over the cartons of lot m³ ÷ box_count, in millionths of a m³. */
  m3u: number;
  /** The same for kg, in millionths of a kg. */
  kgu: number;
  /** Cartons. */
  n: number;
  /** Cartons whose lot carries no positive m³ / kg (staff/cargo.ts's `unmeasured`). */
  noM3: number;
  noKg: number;
}

export interface LedgerRow {
  id: string;
  clientId: string;
  /** The row's Tashkent day, 'YYYY-MM-DD'. */
  txDate: string;
  /** Signed revenue in cents — revenueUsdSql's value (a price +, a compensation −). */
  cents: number;
  /** Only a compensation names a prixod (CHECK) — and that prixod's stamp. */
  receiptId: string | null;
  receiptSellerId: SellerKey;
  batchId: string | null;
  dealId: string | null;
  /** The client's seller NOW — read only when the client had no prixod by txDate. */
  bookSellerId: SellerKey;
}

export type Via = 'receipt' | 'truck' | 'deal' | 'lastPrixod' | 'book';

export interface RevenuePart {
  txId: string;
  clientId: string;
  sellerId: SellerKey;
  cents: number;
  via: Via;
  split: boolean;
}

export interface CargoLookup {
  truck(batchId: string, clientId: string): readonly CargoShare[] | undefined;
  deal(dealId: string, clientId: string): readonly CargoShare[] | undefined;
  /** The stamp of the client's newest confirmed prixod received on or before that Tashkent day; undefined = none. */
  lastPrixod(clientId: string, txDate: string): { sellerId: SellerKey } | undefined;
}

export interface MoneyFigure {
  charges: number;
  cents: number;
}

export interface StampRevenueRow {
  clientId: string;
  sellerId: SellerKey;
  cents: number;
  /** Of `cents`: parts that named no cargo (via lastPrixod or book). */
  unlinkedCents: number;
  /** Of `cents`: parts of a price split over two or more stamps. */
  splitCents: number;
}

export interface StampRevenue {
  rows: StampRevenueRow[];
  unlinked: MoneyFigure;
  split: MoneyFigure;
}

/**
 * A money text in whole cents — `profitByClient`'s `money()` ×100
 * (accounting/reports.ts), the one rounding a reconciliation may use. Used
 * ONLY for the per-client cost TARGET, so the target is computed exactly as
 * «Mijoz foydasi» computes its figure.
 */
export function centsOf(value: unknown): number {
  return Math.round(Number(value ?? 0) * 100);
}

/**
 * An exact decimal text as integer units of 10^-scale: a ledger row (scale 2,
 * numeric(14,2)) or an allocation sum (scale 4, numeric(14,4)). It never
 * rounds — a digit past the scale is a column this file misread, a throw.
 */
export function unitsOf(text: string, scale: 2 | 4): number {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`stamp_units_text ${text}`);
  const [, sign, whole, fraction = ''] = match;
  if (/[1-9]/.test(fraction.slice(scale))) throw new Error(`stamp_units_scale ${text}`);
  const units = Number(`${whole}${fraction.slice(0, scale).padEnd(scale, '0')}`);
  if (!Number.isSafeInteger(units)) throw new Error(`stamp_units_range ${text}`);
  return sign === '-' && units !== 0 ? -units : units;
}

/** Same seller summed, input order kept. */
function mergeShares(shares: readonly CargoShare[]): CargoShare[] {
  const out: CargoShare[] = [];
  for (const s of shares) {
    const seen = out.find((o) => o.sellerId === s.sellerId);
    if (seen) {
      seen.m3u += s.m3u;
      seen.kgu += s.kgu;
      seen.n += s.n;
      seen.noM3 += s.noM3;
      seen.noKg += s.noKg;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** sellerId ascending, the «—» (null) last. */
function bySeller(a: SellerKey, b: SellerKey): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

const cmpBig = (a: bigint, b: bigint) => (a > b ? -1 : a < b ? 1 : 0);

/** Remainder desc, then weight desc, then seller id ascending with «—» last. */
function byRemainder(
  a: number,
  b: number,
  rems: readonly bigint[],
  weights: readonly bigint[],
  merged: readonly CargoShare[],
): number {
  return cmpBig(rems[a]!, rems[b]!) || cmpBig(weights[a]!, weights[b]!) || bySeller(merged[a]!.sellerId, merged[b]!.sellerId);
}

/** `f` with the sign of `cents`, never `-0`. */
function signed(f: bigint, cents: number): number {
  const n = Number(f);
  if (n === 0) return 0;
  return cents < 0 ? -n : n;
}

/**
 * One row's cents over the stamps under it — largest remainder over the basis
 * every carton carries. Σ parts === cents by integer arithmetic; the last
 * line makes any edit that breaks that a throw rather than a drift.
 */
export function apportionCents(cents: number, shares: readonly CargoShare[]): { sellerId: SellerKey; cents: number }[] {
  if (!Number.isSafeInteger(cents)) throw new Error('stamp_split_cents');
  const merged = mergeShares(shares); // same sellerId summed; input order kept
  if (merged.length === 0) throw new Error('stamp_split_empty');
  if (merged.length === 1) return [{ sellerId: merged[0]!.sellerId, cents }];
  // The basis EVERY carton carries: a carton is never worth $0 of a price it rode under.
  const basis = merged.every((s) => s.noM3 === 0 && s.m3u > 0)
    ? 'm3u'
    : merged.every((s) => s.noKg === 0 && s.kgu > 0)
      ? 'kgu'
      : 'n';
  const weights = merged.map((s) => BigInt(s[basis]));
  const total = weights.reduce((sum, w) => sum + w, 0n);
  if (total <= 0n) throw new Error('stamp_split_basis');
  const whole = BigInt(Math.abs(cents));
  const floors = weights.map((w) => (whole * w) / total);
  const rems = weights.map((w) => (whole * w) % total);
  const left = whole - floors.reduce((sum, f) => sum + f, 0n);
  const order = merged.map((_, i) => i).sort((a, b) => byRemainder(a, b, rems, weights, merged));
  for (let i = 0; i < Number(left); i += 1) floors[order[i]!]! += 1n;
  const out = merged.map((s, i) => ({ sellerId: s.sellerId, cents: signed(floors[i]!, cents) }));
  if (out.reduce((sum, p) => sum + p.cents, 0) !== cents) throw new Error('stamp_split_reconcile');
  return out;
}

/**
 * A client's cost in 1e-4 units per stamp, rounded to cents so the stamps sum
 * to `targetCents` — `centsOf` of the client's exact sum, «Mijoz foydasi»'s
 * own figure (rule 6). Each part is floored; the cents left go by the largest
 * remainder, then seller id with «—» last. A target outside
 * [Σfloor, Σfloor + k] cannot be `centsOf` of these parts' sum: a throw.
 */
export function roundPreservingTotal(
  parts: readonly { sellerId: SellerKey; units: number }[],
  targetCents: number,
): { sellerId: SellerKey; cents: number }[] {
  const floors = parts.map((p) => Math.floor(p.units / 100));
  const rems = parts.map((p, i) => p.units - 100 * floors[i]!);
  const left = targetCents - floors.reduce((sum, f) => sum + f, 0);
  if (!Number.isInteger(left) || left < 0 || left > parts.length) throw new Error('stamp_cost_reconcile');
  const order = parts
    .map((_, i) => i)
    .sort((a, b) => rems[b]! - rems[a]! || bySeller(parts[a]!.sellerId, parts[b]!.sellerId));
  for (let i = 0; i < left; i += 1) floors[order[i]!]! += 1;
  return parts.map((p, i) => ({ sellerId: p.sellerId, cents: floors[i]! }));
}

/** Rule 3 for a row that names no prixod: the truck's riders, else the job's prixods — or nothing. */
export function namedCargo(
  row: LedgerRow,
  cargo: CargoLookup,
): { via: 'truck' | 'deal'; shares: readonly CargoShare[] } | null {
  // A truck price names the client's riders on that truck (the price door's relation). Batch beats deal:
  // a truck price whose cargo is not aboard names NOTHING — never its deal.
  if (row.batchId !== null) {
    const shares = cargo.truck(row.batchId, row.clientId);
    return shares !== undefined && shares.length > 0 ? { via: 'truck' as const, shares } : null;
  }
  // A job's price names the job's confirmed prixods of this client.
  if (row.dealId !== null) {
    const shares = cargo.deal(row.dealId, row.clientId);
    return shares !== undefined && shares.length > 0 ? { via: 'deal' as const, shares } : null;
  }
  return null;
}

/** The rows the fallback statement is asked about — the same sentence attributeRow branches on. */
export function needsFallback(row: LedgerRow, cargo: CargoLookup): boolean {
  return row.receiptId === null && namedCargo(row, cargo) === null;
}

function part(row: LedgerRow, sellerId: SellerKey, cents: number, via: Via, split: boolean): RevenuePart {
  return { txId: row.id, clientId: row.clientId, sellerId, cents, via, split };
}

/** One ledger row → the sellers it credits. No branching on kind: the sign is revenueUsdSql's. */
export function attributeRow(row: LedgerRow, cargo: CargoLookup): RevenuePart[] {
  // 1. A row that names a prixod is that prixod's (only a compensation does — CHECK); its deal is ignored.
  if (row.receiptId !== null) return [part(row, row.receiptSellerId, row.cents, 'receipt', false)];
  // 2-3. The truck's riders, else the job's prixods.
  const named = namedCargo(row, cargo);
  if (named !== null) {
    const pieces = apportionCents(row.cents, named.shares);
    return pieces.map((p) => part(row, p.sellerId, p.cents, named.via, pieces.length > 1));
  }
  // 4. It names no cargo that is there: the seller of the client's newest prixod by that day…
  const last = cargo.lastPrixod(row.clientId, row.txDate);
  if (last !== undefined) return [part(row, last.sellerId, row.cents, 'lastPrixod', false)];
  // …and the client's seller NOW only when the client had no prixod by then.
  return [part(row, row.bookSellerId, row.cents, 'book', false)];
}

/** Parts → one row per (client, seller), plus the two figures the full table names under itself. */
export function foldParts(parts: readonly RevenuePart[]): StampRevenue {
  const rows = new Map<string, StampRevenueRow>();
  const unlinkedTx = new Set<string>();
  const splitTx = new Set<string>();
  let unlinkedCents = 0;
  let splitCents = 0;
  for (const p of parts) {
    const key = `${p.clientId}|${p.sellerId ?? ''}`;
    let row = rows.get(key);
    if (!row) {
      row = { clientId: p.clientId, sellerId: p.sellerId, cents: 0, unlinkedCents: 0, splitCents: 0 };
      rows.set(key, row);
    }
    row.cents += p.cents;
    if (p.via === 'lastPrixod' || p.via === 'book') {
      row.unlinkedCents += p.cents;
      unlinkedTx.add(p.txId);
      unlinkedCents += p.cents;
    }
    if (p.split) {
      row.splitCents += p.cents;
      splitTx.add(p.txId);
      splitCents += p.cents;
    }
  }
  return {
    rows: [...rows.values()].sort(
      (a, b) => (a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : bySeller(a.sellerId, b.sellerId)),
    ),
    unlinked: { charges: unlinkedTx.size, cents: unlinkedCents },
    split: { charges: splitTx.size, cents: splitCents },
  };
}
