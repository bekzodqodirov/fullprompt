import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { withoutJit } from '@/modules/platform/db/no-jit';
import { clients, users } from '@/modules/platform/db/schema';
import { marginPct } from '../accounting/margin';
import { stampedCargo, unstampedCargo } from '../staff/cargo';
import { costByStamp } from '../staff/stamp-cost';
import { revenueByStamp } from '../staff/stamp-revenue';

/**
 * Sotuvchi samaradorligi (docs/VED.md, the Reports line; owner 2026-08-25:
 * «2 ha qur · 3 tannarx korinmasin sotuvchiga»).
 *
 * TWO functions with TWO return types, and that split IS the law: the own
 * shape has no profit, no cost and no margin PROPERTY, so no forged
 * parameter and no forgotten conditional can print a cost-derived number to
 * a seller — the code path that could compute one does not exist
 * (`SearchHit`'s shape, #492; «scope is a REQUIRED argument», #790).
 * `sellerPerformanceOwn` must never call `profitByClient` or `costByStamp` —
 * the fence test reads this file and refuses the names below the marker line.
 *
 * ONE attribution for both halves — the prixod's stamp (0117; his 4a, «a) yuk
 * kelgan kundagi sotuvchiga», 2026-09-29, which overturns #1212's «the money
 * stays on the book»):
 *  - the CARGO (prixodlar, m³, kg) is the receipt's own seller stamp, carton
 *    by carton on the day it was received (`staff/cargo.ts`, the KPI's one
 *    reader — his 1a/2a: a client moved to another seller keeps the old cargo
 *    with whoever sold to them that day). Unstamped cargo is the «—» row's.
 *  - the MONEY follows the same stamp: a price belongs to the seller stamped
 *    on the prixod(s) it prices — a compensation its prixod's, a truck price
 *    the client's riders on that truck (split by m³, else kg, else cartons
 *    when two stamps rode under it), a job's price the job's prixods; a price
 *    that names no cargo there goes to the client's newest prixod by that
 *    day, and to the client's seller NOW only when there was none
 *    (`staff/stamp-split.ts` holds the rules). Cost goes carton by carton to
 *    its prixod's stamp (`staff/stamp-cost.ts`). The clocks are unchanged —
 *    revenue on `tx_date`, cost on `cost_date` — so per CLIENT the sellers sum
 *    to /accounting/profit's client row to the cent, and the totals row is the
 *    sum of those client rows.
 *  - only the «Mijozlar» column is the book (who the seller is NOW), and so is
 *    money ACCESS (round 91): access is not attribution.
 * It is a DIFFERENT clock from tahlil's sellers table on purpose: tahlil
 * counts leads won by `leads.owner_id` at QUOTED money, this screen counts a
 * manager's clients at CHARGED money and received cargo — the funnel's
 * promise vs the ledger's fact.
 *
 * Two period vocabularies meet here and are converted ONCE: `readPeriod`'s
 * `dan`/`gacha` are the INCLUSIVE day strings the money readers expect
 * (`revenueByStamp`/`costByStamp` compare `date` columns inclusively, as
 * `profitByClient` does), while `from`/`to` are the
 * half-open timestamptz pair (`to` = next midnight, EXCLUSIVE) the
 * `received_at` predicate needs. Mixing them counts one extra day at every
 * month end.
 */
export interface SellerCargo {
  clients: number;
  receipts: number;
  weightKg: number;
  volumeM3: number;
  revenueUsd: number;
}

export interface SellerAllRow extends SellerCargo {
  /** null = the unassigned cohort — a first-class «—» row, never dropped. */
  managerId: string | null;
  managerName: string | null;
  /** false = deactivated (shown «(faol emas)»); null = the «—» cohort. */
  managerActive: boolean | null;
  costUsd: number;
  profitUsd: number;
  /** Null over revenue that is not positive (`marginPct`, 0105). */
  marginPct: number | null;
}

/** A counted figure the full table names under itself. */
export interface MoneyNote {
  charges: number;
  usd: number;
}

/** The seller's own shape. NO cost-derived property exists on it. */
export type SellerOwnRow = SellerCargo;

/** Active clients per manager — the book as it stands, not period-bound. */
async function clientsByManager(managerId?: string) {
  return db
    .select({
      managerId: clients.salesManagerId,
      n: sql<string>`count(*)`,
    })
    .from(clients)
    .where(and(eq(clients.active, true), managerId ? eq(clients.salesManagerId, managerId) : undefined))
    .groupBy(clients.salesManagerId);
}

/**
 * The full table: every seller by the stamp, the «—» cohort, and a totals row
 * equal to the SUM OF /accounting/profit's CLIENT rows — never that tab's Jami,
 * which adds «Egasiz yuk» as a row of its own (nobody's cargo, nobody's
 * score), nor the P&L's unallocated money (`clientProfitGaps`, U19). 1,402 of
 * the book's 1,692 clients carried no manager on deploy day, so a roll-up that
 * dropped NULL would silently shed most of the company and read as a complete
 * answer. What the stamp could not place is NAMED under the table: the
 * prices that name no cargo (`unlinked`) and the prices split over two
 * stamps (`split`).
 */
export async function sellerPerformanceAll(period: {
  from: Date;
  to: Date;
  dan: string;
  gacha: string;
}): Promise<{
  rows: SellerAllRow[];
  totals: SellerAllRow;
  unassignedClients: number;
  unlinked: MoneyNote;
  split: MoneyNote;
}> {
  const [money, cargoRows, unstamped, clientRows] = await Promise.all([
    // ONE pool connection, sequential statements, JIT off (no-jit.ts) — the rider walk is company-wide.
    withoutJit(async (exec) => {
      const revenue = await revenueByStamp(exec, period, { kind: 'all' });
      const cost = await costByStamp(exec, period);
      return { revenue, cost };
    }),
    // from/to: the half-open received_at pair, stamp by stamp (0117).
    stampedCargo(db, period, { kind: 'all' }),
    unstampedCargo(db, period),
    clientsByManager(),
  ]);

  // CENTS per seller key — integers until the last division, so the totals
  // row is the exact sum of the client rows and never a sum of roundings.
  const revenueCents = new Map<string | null, number>();
  const costCents = new Map<string | null, number>();
  for (const r of money.revenue.rows) revenueCents.set(r.sellerId, (revenueCents.get(r.sellerId) ?? 0) + r.cents);
  for (const c of money.cost) costCents.set(c.sellerId, (costCents.get(c.sellerId) ?? 0) + c.cents);

  const byManager = new Map<string | null, SellerAllRow>();
  const rowFor = (managerId: string | null): SellerAllRow => {
    let row = byManager.get(managerId);
    if (!row) {
      row = {
        managerId,
        managerName: null,
        managerActive: null,
        clients: 0,
        receipts: 0,
        weightKg: 0,
        volumeM3: 0,
        revenueUsd: 0,
        costUsd: 0,
        profitUsd: 0,
        marginPct: null,
      };
      byManager.set(managerId, row);
    }
    return row;
  };

  for (const key of new Set([...revenueCents.keys(), ...costCents.keys()])) rowFor(key);
  const addCargo = (row: SellerAllRow, c: { receipts: number; kg: number; m3: number }) => {
    row.receipts += c.receipts;
    row.weightKg = Math.round((row.weightKg + c.kg) * 1000) / 1000;
    row.volumeM3 = Math.round((row.volumeM3 + c.m3) * 1000) / 1000;
  };
  for (const c of cargoRows) addCargo(rowFor(c.sellerId), c);
  // Cargo nobody was named on the day it came is the «—» cohort's — the same
  // row as the book's managerless clients, so the totals still cover it all.
  for (const c of unstamped) addCargo(rowFor(null), c);
  let unassignedClients = 0;
  for (const c of clientRows) {
    rowFor(c.managerId).clients = Number(c.n);
    if (c.managerId === null) unassignedClients = Number(c.n);
  }

  let totalRevenue = 0;
  let totalCost = 0;
  for (const [key, row] of byManager) {
    const rev = revenueCents.get(key) ?? 0;
    const cost = costCents.get(key) ?? 0;
    row.revenueUsd = rev / 100;
    row.costUsd = cost / 100;
    row.profitUsd = (rev - cost) / 100;
    totalRevenue += rev;
    totalCost += cost;
  }

  const managerIds = [...byManager.keys()].filter((v): v is string => v !== null);
  if (managerIds.length > 0) {
    const names = await db
      .select({ id: users.id, name: users.fullName, active: users.active })
      .from(users)
      .where(inArray(users.id, managerIds));
    for (const n of names) {
      const row = byManager.get(n.id);
      if (row) {
        row.managerName = n.name;
        row.managerActive = n.active;
      }
    }
  }

  const rows = [...byManager.values()]
    .map((row) => ({
      ...row,
      marginPct: marginPct(row.profitUsd, row.revenueUsd),
    }))
    // Named sellers by profit; the «—» cohort LAST, where a footer row would
    // sit — it is nobody's score.
    .sort((a, b) =>
      a.managerId === null ? 1 : b.managerId === null ? -1 : b.profitUsd - a.profitUsd,
    );

  const totals = rows.reduce(
    (t, r) => ({
      ...t,
      clients: t.clients + r.clients,
      receipts: t.receipts + r.receipts,
      weightKg: Math.round((t.weightKg + r.weightKg) * 1000) / 1000,
      volumeM3: Math.round((t.volumeM3 + r.volumeM3) * 1000) / 1000,
    }),
    {
      managerId: null,
      managerName: null,
      managerActive: null,
      clients: 0,
      receipts: 0,
      weightKg: 0,
      volumeM3: 0,
      revenueUsd: totalRevenue / 100,
      costUsd: totalCost / 100,
      profitUsd: (totalRevenue - totalCost) / 100,
      marginPct: null,
    } as SellerAllRow,
  );
  totals.marginPct = marginPct(totals.profitUsd, totals.revenueUsd);

  const note = (figure: { charges: number; cents: number }): MoneyNote => ({
    charges: figure.charges,
    usd: figure.cents / 100,
  });
  return {
    rows,
    totals,
    unassignedClients,
    unlinked: note(money.revenue.unlinked),
    split: note(money.revenue.split),
  };
}

/* ------------------------------------------------------------------ */
/* OWN — everything below this line is the seller's view. It must not  */
/* name profitByClient, costByStamp, costEntries or costAllocations:   */
/* the fence test reads this file and goes red on any of the four.     */
/* ------------------------------------------------------------------ */

/**
 * The seller's own row: clients, received cargo, charged revenue. Revenue is
 * a figure the seller already reads (law 10 hands sellers the prices) — cost
 * and profit are not, and cannot be produced here at all.
 *
 * The own «Hisoblangan» is the revenue the stamp credits to this seller (4a):
 * prices on the cargo received while they were the client's seller —
 * INCLUDING on clients since moved to someone else — as one total. The
 * ledgers of those clients stay closed to them (round 91's money scope is the
 * book: access is not attribution).
 *
 * The full table and this card call ONE function (`revenueByStamp`, the own
 * scope filtering the parts before anything is folded), so they agree by
 * construction; the integration test still pins it. That function names no
 * cost source, so this path still cannot hold the cost query.
 */
export async function sellerPerformanceOwn(
  actorId: string,
  period: { from: Date; to: Date; dan: string; gacha: string },
): Promise<SellerOwnRow> {
  const [cargoRows, clientRows, revenue] = await Promise.all([
    stampedCargo(db, period, { kind: 'own', userId: actorId }),
    clientsByManager(actorId),
    withoutJit((exec) => revenueByStamp(exec, period, { kind: 'own', userId: actorId })),
  ]);
  const cargo = cargoRows[0];
  return {
    clients: Number(clientRows[0]?.n ?? 0),
    receipts: cargo?.receipts ?? 0,
    weightKg: Math.round((cargo?.kg ?? 0) * 1000) / 1000,
    volumeM3: Math.round((cargo?.m3 ?? 0) * 1000) / 1000,
    revenueUsd: revenue.rows.reduce((sum, row) => sum + row.cents, 0) / 100,
  };
}
