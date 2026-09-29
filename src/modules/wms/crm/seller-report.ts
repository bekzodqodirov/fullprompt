import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { clients, clientTransactions, users } from '@/modules/platform/db/schema';
import { profitByClient } from '../accounting/reports';
import { marginPct } from '../accounting/margin';
import { REVENUE_TYPES } from '../finance/ledger-kinds';
import { revenueUsdSql } from '../finance/ledger-sql';
import { stampedCargo, unstampedCargo } from '../staff/cargo';

/**
 * Sotuvchi samaradorligi (docs/VED.md, the Reports line; owner 2026-08-25:
 * «2 ha qur · 3 tannarx korinmasin sotuvchiga»).
 *
 * TWO functions with TWO return types, and that split IS the law: the own
 * shape has no profit, no cost and no margin PROPERTY, so no forged
 * parameter and no forgotten conditional can print a cost-derived number to
 * a seller — the code path that could compute one does not exist
 * (`SearchHit`'s shape, #492; «scope is a REQUIRED argument», #790).
 * `sellerPerformanceOwn` must never call `profitByClient` — the fence test
 * reads this file and refuses the name below the marker line.
 *
 * TWO attributions, one per half, and the screen labels both (0117):
 *  - the CARGO (prixodlar, m³, kg) is the receipt's own seller stamp, carton
 *    by carton on the day it was received (`staff/cargo.ts`, the KPI's one
 *    reader — his 1a/2a: a client moved to another seller keeps the old cargo
 *    with whoever sold to them that day). Unstamped cargo is the «—» row's.
 *  - the MONEY (revenue, cost, profit) is still `clients.sales_manager_id` —
 *    round 91's money-scope column — the book as it stands. Moving it to the
 *    stamp would split one charge over two sellers and make this table and
 *    /accounting/profit's client rows disagree (open point 4 put to him).
 * It is a DIFFERENT clock from tahlil's sellers table on purpose: tahlil
 * counts leads won by `leads.owner_id` at QUOTED money, this screen counts a
 * manager's clients at CHARGED money and received cargo — the funnel's
 * promise vs the ledger's fact.
 *
 * Two period vocabularies meet here and are converted ONCE: `readPeriod`'s
 * `dan`/`gacha` are the INCLUSIVE day strings `profitByClient` expects
 * (it compares `date` columns with gte/lte), while `from`/`to` are the
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
  costUsd: number;
  profitUsd: number;
  /** Null over revenue that is not positive (`marginPct`, 0105). */
  marginPct: number | null;
}

/** The seller's own shape. NO cost-derived property exists on it. */
export type SellerOwnRow = SellerCargo;

const num = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;

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
 * The full table: every manager, the «—» cohort, and a totals row that
 * reconciles with /accounting/profit's CLIENT rows — 1,402 of the book's
 * 1,692 clients carried no manager on deploy day, so a roll-up that dropped
 * NULL would silently shed most of the company and read as a complete answer.
 * Not with that tab's Jami: unclaimed cargo and money that reached no box
 * (`clientProfitGaps`) are nobody's client and nobody's score, so they stay
 * out of every seller row and are named on the profit tab alone (U19).
 */
export async function sellerPerformanceAll(period: {
  from: Date;
  to: Date;
  dan: string;
  gacha: string;
}): Promise<{ rows: SellerAllRow[]; totals: SellerAllRow; unassignedClients: number }> {
  const [profitRows, cargoRows, unstamped, clientRows] = await Promise.all([
    // dan/gacha: profitByClient compares DATE columns inclusively.
    profitByClient(period.dan, period.gacha),
    // from/to: the half-open received_at pair, stamp by stamp (0117).
    stampedCargo(db, period, { kind: 'all' }),
    unstampedCargo(db, period),
    clientsByManager(),
  ]);

  // client → manager, ONE query for every client profit named (#432).
  const ids = [...new Set(profitRows.map((r) => r.clientId).filter((v): v is string => v !== null))];
  const managerOf = new Map<string, string | null>();
  if (ids.length > 0) {
    const rows = await db
      .select({ id: clients.id, managerId: clients.salesManagerId })
      .from(clients)
      .where(inArray(clients.id, ids));
    for (const r of rows) managerOf.set(r.id, r.managerId);
  }

  const byManager = new Map<string | null, SellerAllRow>();
  const rowFor = (managerId: string | null): SellerAllRow => {
    let row = byManager.get(managerId);
    if (!row) {
      row = {
        managerId,
        managerName: null,
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

  for (const p of profitRows) {
    const row = rowFor(p.clientId === null ? null : (managerOf.get(p.clientId) ?? null));
    row.revenueUsd = num(row.revenueUsd + p.revenueUsd);
    row.costUsd = num(row.costUsd + p.costUsd);
    row.profitUsd = num(row.profitUsd + p.profitUsd);
  }
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

  const managerIds = [...byManager.keys()].filter((v): v is string => v !== null);
  if (managerIds.length > 0) {
    const names = await db
      .select({ id: users.id, name: users.fullName })
      .from(users)
      .where(inArray(users.id, managerIds));
    for (const n of names) {
      const row = byManager.get(n.id);
      if (row) row.managerName = n.name;
    }
  }

  const rows = [...byManager.values()]
    .map((row) => ({
      ...row,
      marginPct: marginPct(row.profitUsd, row.revenueUsd),
    }))
    // Named sellers by profit; the «—» cohort LAST, where a footer row would
    // sit — it is the book's unassigned remainder, not somebody's score.
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
      revenueUsd: num(t.revenueUsd + r.revenueUsd),
      costUsd: num(t.costUsd + r.costUsd),
      profitUsd: num(t.profitUsd + r.profitUsd),
    }),
    {
      managerId: null,
      managerName: null,
      clients: 0,
      receipts: 0,
      weightKg: 0,
      volumeM3: 0,
      revenueUsd: 0,
      costUsd: 0,
      profitUsd: 0,
      marginPct: null,
    } as SellerAllRow,
  );
  totals.marginPct = marginPct(totals.profitUsd, totals.revenueUsd);

  return { rows, totals, unassignedClients };
}

/* ------------------------------------------------------------------ */
/* OWN — everything below this line is the seller's view. It must not  */
/* name profitByClient, costEntries or costAllocations: the fence test */
/* reads this file and goes red on any of the three.                   */
/* ------------------------------------------------------------------ */

/**
 * The seller's own row: clients, received cargo, charged revenue. Revenue is
 * a figure the seller already reads (law 10 hands sellers the prices; the
 * charges are on the client cards they own) — cost and profit are not, and
 * cannot be produced here at all.
 *
 * The revenue predicate restates `profitByClient`'s revenue side (non-void
 * rows through the one revenue rule — prices minus compensations for lost
 * cargo, 0105 — inclusive day bounds) — cross-referenced there, and pinned
 * by an integration test asserting the two agree on one fixture — because
 * importing the whole profit function to use a third of it would put the
 * cost query INTO this path, which is the one thing this path must not hold.
 */
export async function sellerPerformanceOwn(
  actorId: string,
  period: { from: Date; to: Date; dan: string; gacha: string },
): Promise<SellerOwnRow> {
  const [cargoRows, clientRows, revenueRows] = await Promise.all([
    stampedCargo(db, period, { kind: 'own', userId: actorId }),
    clientsByManager(actorId),
    db
      .select({ revenueUsd: sql<string>`coalesce(sum(${revenueUsdSql()}), 0)` })
      .from(clientTransactions)
      .innerJoin(clients, eq(clientTransactions.clientId, clients.id))
      .where(
        and(
          eq(clients.salesManagerId, actorId),
          inArray(clientTransactions.type, [...REVENUE_TYPES]),
          isNull(clientTransactions.voidedAt),
          gte(clientTransactions.txDate, period.dan),
          lte(clientTransactions.txDate, period.gacha),
        ),
      ),
  ]);
  const cargo = cargoRows[0];
  return {
    clients: Number(clientRows[0]?.n ?? 0),
    receipts: cargo?.receipts ?? 0,
    weightKg: Math.round((cargo?.kg ?? 0) * 1000) / 1000,
    volumeM3: Math.round((cargo?.m3 ?? 0) * 1000) / 1000,
    revenueUsd: num(revenueRows[0]?.revenueUsd),
  };
}
