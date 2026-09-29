import { sql } from 'drizzle-orm';
import { settlesUsd } from './ledger-kinds';
import { deferredPerDealSql } from './service';
import { fifoOrder, settleCharges, type FifoCharge } from './fifo';
import { uncoveredCtes, unpricedScopeSql, type Exec, type UnpricedScope } from './unpriced';
import { MONEY_EPSILON } from '../calc/upsale';
import { receivedMonthSql } from '../staff/cargo';

/**
 * The PAID part of a scope's cargo — ONE reader, two folds (0117, the owner's
 * 6b: «KPI is earned only on cargo the client has paid for, like the
 * upsale»; and his 3a, 2026-09-29: «Upsale uchun «to'langan yuk» qoidasi KPI
 * bilan bir xil bo'lsin — eng eski qarzdan boshlab yopiladi»).
 *
 * A carton is paid when:
 *  - at least one LIVE, non-zeroed charge COVERS it — the unpriced rule's own
 *    `u_pair.covers` (finance/unpriced.ts), never re-derived here: which price
 *    belongs to which cargo is that file's one sentence (#513). A carton
 *    covered only by a price the lost-cargo door lowered to zero is NOT paid:
 *    nobody paid anything for it;
 *  - and EVERY live charge covering it is settled — `settleCharges`
 *    (finance/fifo.ts) over the client's whole live ledger: a compensation
 *    first onto its own receipt's charges, a deferral onto its own deal's,
 *    then the money oldest charge first. So a client who ships all the time
 *    and has paid for the old months has PAID cargo in those months while the
 *    newest truck is still owed (open point 3, the default).
 *
 * Two readers fold it, and neither restates it:
 *  - the KPI (`staff/kpi-paid.ts` `paidM3ByMonth`) per seller × month, over
 *    the `stamped` scope — exactly `stampedCartonsSql`'s cartons, so the paid
 *    m³ is always a part of the month's m³ and never more;
 *  - the upsale (`dealCargoPaid` below, his 3a) per DEAL, over the `deals`
 *    scope — whose client clause keeps a prixod moved to another client out
 *    of the deal it still names.
 *
 * `elsewhere` exists for the upsale's WORDS only («the price is on a truck
 * this cargo has not left on yet») and decides nothing; the KPI passes
 * `false`, which emits a constant, so its SQL cost does not grow.
 *
 * `clientCargo` (finance/client-cargo.ts) calls `settleCharges` with
 * different inputs on purpose — general credit only, the client card's
 * «which trip is paid» — so it is a stated divergence and not a third copy of
 * this rule.
 *
 * Every read runs on the executor handed in (#714 — payKpi and payUpsale walk
 * inside their own transactions, the screens pass a `withoutJit` read).
 */

export interface PaidCarton {
  boxId: string;
  receiptId: string;
  clientId: string;
  dealId: string | null;
  /** The receipt's seller STAMP (0117); null on an unstamped prixod. */
  sellerId: string | null;
  /** `YYYY-MM`, Tashkent month of `received_at` (`receivedMonthSql`). */
  month: string;
  /** The carton's share of its lot — `u_box`'s own expression. */
  m3: number;
  /** The live, non-zeroed charges covering it (`u_pair.covers AND NOT uc.zeroed`). */
  covering: string[];
  covered: boolean;
  /** Covered, and every covering charge settled by the FIFO. */
  paid: boolean;
  /**
   * `opts.elsewhere` only (false otherwise): a live price of the client sits
   * on a truck this prixod TOUCHED and does not cover this carton — the
   * unpriced rule's own «narx YW-001 da» tag (`u_pair.elsewhere`): a truck
   * still loading, or a local leg. Read only for an uncovered carton.
   */
  elsewhere: boolean;
}

/** A live charge of an in-scope client, after the FIFO. */
export interface SettledCharge extends FifoCharge {
  clientId: string;
  owedUsd: number;
}

export interface PaidCargo {
  cartons: PaidCarton[];
  /** Every live charge of the scope's clients, by id, with what is still owed on it. */
  charges: Map<string, SettledCharge>;
}

const ids = (list: string[]) =>
  sql.join(
    list.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

export async function paidCargo(exec: Exec, scope: UnpricedScope, opts: { elsewhere: boolean }): Promise<PaidCargo> {
  // 1. The cartons and, per carton, the live non-zeroed charges covering it.
  //    One `u_box` row per box, so the three columns beside the KPI's own do
  //    not change the grouping.
  const rows = (await exec.execute(sql`
    WITH ${uncoveredCtes(unpricedScopeSql(scope), { landedOnly: false })}
    SELECT ub.box_id, ub.client_id, ub.receipt_id, ub.deal_id, ub.m3::text AS m3,
           r.sales_manager_id AS seller_id,
           ${receivedMonthSql(sql`r.received_at`)} AS month,
           string_agg(up.charge_id::text, ',') FILTER (WHERE up.covers AND NOT uc.zeroed) AS charges,
           ${opts.elsewhere ? sql`coalesce(bool_or(up.elsewhere), false)` : sql`false`} AS elsewhere
      FROM u_box ub
      JOIN receipts r ON r.id = ub.receipt_id
      LEFT JOIN u_pair up ON up.box_id = ub.box_id
      LEFT JOIN u_charge uc ON uc.id = up.charge_id
     GROUP BY ub.box_id, ub.client_id, ub.receipt_id, ub.deal_id, ub.m3, r.sales_manager_id, r.received_at`)) as unknown as {
    box_id: string;
    client_id: string;
    receipt_id: string;
    deal_id: string | null;
    m3: string;
    seller_id: string | null;
    month: string;
    charges: string | null;
    elsewhere: boolean;
  }[];

  const clientIds = [...new Set(rows.map((c) => c.client_id))];
  if (clientIds.length === 0) return { cartons: [], charges: new Map() };

  // 2. The clients' whole LIVE ledger — a payment settles the oldest price
  //    whichever month, seller or deal it belongs to.
  const ledger = (await exec.execute(sql`
    SELECT ct.id, ct.client_id, ct.type, ct.amount_usd::text AS amount_usd, ct.tx_date::text AS tx_date,
           ct.created_at::text AS created_at, ct.deal_id, ct.receipt_id
      FROM client_transactions ct
     WHERE ct.client_id IN (${ids(clientIds)}) AND ct.voided_at IS NULL`)) as unknown as {
    id: string;
    client_id: string;
    type: string;
    amount_usd: string;
    tx_date: string;
    created_at: string;
    deal_id: string | null;
    receipt_id: string | null;
  }[];

  // 3. The live deferrals, per deal — the handover gate's own rule.
  const deferrals = (await exec.execute(deferredPerDealSql(clientIds))) as unknown as {
    client_id: string;
    deal_id: string;
    owed: string;
  }[];

  // 4. Which charges cover a COMPENSATED receipt — the compensation's target,
  //    asked of the same rule over exactly those receipts (they may sit in
  //    another month, another seller's stamp or another deal).
  const compensated = [
    ...new Set(ledger.filter((row) => row.type === 'compensation' && row.receipt_id).map((row) => row.receipt_id!)),
  ];
  const coversReceipts = new Map<string, Set<string>>();
  if (compensated.length > 0) {
    const pairs = (await exec.execute(sql`
      WITH ${uncoveredCtes(unpricedScopeSql({ kind: 'receipts', receiptIds: compensated }), { landedOnly: false })}
      SELECT DISTINCT ub.receipt_id, up.charge_id
        FROM u_pair up
        JOIN u_box ub ON ub.box_id = up.box_id
        JOIN u_charge uc ON uc.id = up.charge_id
       WHERE up.covers AND NOT uc.zeroed`)) as unknown as { receipt_id: string; charge_id: string }[];
    for (const pair of pairs) {
      const set = coversReceipts.get(pair.charge_id) ?? new Set<string>();
      set.add(pair.receipt_id);
      coversReceipts.set(pair.charge_id, set);
    }
  }

  // 5. Settle each client, once.
  const owed = new Map<string, number>();
  for (const clientId of clientIds) {
    const own = ledger.filter((row) => row.client_id === clientId);
    const charges: FifoCharge[] = own
      .filter((row) => row.type === 'charge')
      .map((row) => ({
        id: row.id,
        txDate: row.tx_date,
        createdAt: row.created_at,
        amountUsd: Number(row.amount_usd),
        dealId: row.deal_id,
        coversReceipts: [...(coversReceipts.get(row.id) ?? [])],
      }));
    const settled = settleCharges(charges, {
      generalUsd: own.reduce((sum, row) => sum + settlesUsd({ type: row.type, amountUsd: Number(row.amount_usd) }), 0),
      compensations: own
        .filter((row) => row.type === 'compensation' && row.receipt_id)
        .map((row) => ({ receiptId: row.receipt_id!, amountUsd: Number(row.amount_usd) })),
      deferrals: deferrals
        .filter((row) => row.client_id === clientId)
        .map((row) => ({ dealId: row.deal_id, owedUsd: Number(row.owed) })),
    });
    for (const [id, left] of settled) owed.set(id, left);
  }

  // The settled charges — what the upsale's hint and its «own invoice» clause
  // read. Every live charge of the in-scope clients, the covering ones and the
  // rest alike.
  const charges = new Map<string, SettledCharge>();
  for (const row of ledger) {
    if (row.type !== 'charge') continue;
    charges.set(row.id, {
      id: row.id,
      clientId: row.client_id,
      dealId: row.deal_id,
      txDate: row.tx_date,
      createdAt: row.created_at,
      amountUsd: Number(row.amount_usd),
      // settleCharges answers for every charge it was given; if not, fail CLOSED (owed).
      owedUsd: owed.get(row.id) ?? Number(row.amount_usd),
    });
  }

  // 6. A carton is paid when something covers it and everything covering it is settled.
  const cartons = rows.map((c): PaidCarton => {
    const covering = (c.charges ?? '').split(',').filter(Boolean);
    return {
      boxId: c.box_id,
      receiptId: c.receipt_id,
      clientId: c.client_id,
      dealId: c.deal_id,
      sellerId: c.seller_id,
      month: c.month,
      m3: Number(c.m3),
      covering,
      covered: covering.length > 0,
      paid: covering.length > 0 && covering.every((id) => (owed.get(id) ?? Infinity) <= MONEY_EPSILON),
      elsewhere: Boolean(c.elsewhere),
    };
  });
  return { cartons, charges };
}

/** One deal's paid-cargo walk (3a), folded from `paidCargo`. */
export interface DealCargoPaid {
  /** Live cartons (CARGO_STATUSES) of the deal's confirmed prixods OF THE DEAL'S CLIENT. */
  cartons: number;
  /** …with no live, non-zeroed covering price. */
  uncovered: number;
  /** …of those, a price of the client sits on a truck the prixod touched (loading, or a local leg). */
  uncoveredElsewhere: number;
  /** …covered, but some covering price is not settled yet. */
  unpaid: number;
  /** Live prices STAMPED with this deal still owed after the FIFO (money-O1). */
  ownChargesOwed: number;
  /**
   * What the client must still pay, oldest first, before every price this job
   * waits on is settled: Σ owed over the client's charges at or before the
   * newest waiting price in `fifoOrder`. 0 when nothing waits; null when it
   * cannot be said (a waiting price missing from the ledger read — fail closed).
   */
  toOpenUsd: number | null;
  /** An OLDER price that is neither this job's nor one it waits on is still owed — the money went there first. */
  olderOwedElsewhere: boolean;
}

/**
 * The upsale's fold (3a) — PURE, exported for its unit test. Every asked id
 * is in the answer, all zeros when the deal has no live carton of its client.
 *
 * Why `toOpenUsd` is exact: a new payment is general money, applied oldest
 * first to whatever is still owed — so paying exactly `toOpenUsd` settles
 * exactly the charges up to the newest one this job waits on, and not one
 * cent of it lands on a newer debt.
 */
export function foldDealCargo(dealIds: readonly string[], cargo: PaidCargo): Map<string, DealCargoPaid> {
  const empty = (): DealCargoPaid => ({
    cartons: 0,
    uncovered: 0,
    uncoveredElsewhere: 0,
    unpaid: 0,
    ownChargesOwed: 0,
    toOpenUsd: 0,
    olderOwedElsewhere: false,
  });
  const out = new Map(dealIds.map((id) => [id, empty()]));
  const waits = new Map<string, Set<string>>();
  const wait = (dealId: string, chargeId: string) => {
    const set = waits.get(dealId) ?? new Set<string>();
    set.add(chargeId);
    waits.set(dealId, set);
  };
  const owedOf = (id: string) => cargo.charges.get(id)?.owedUsd ?? Infinity;

  for (const c of cargo.cartons) {
    const d = c.dealId ? out.get(c.dealId) : undefined;
    if (!d || !c.dealId) continue;
    d.cartons += 1;
    if (!c.covered) {
      d.uncovered += 1;
      if (c.elsewhere) d.uncoveredElsewhere += 1;
      continue;
    }
    if (!c.paid) d.unpaid += 1;
    for (const id of c.covering) if (owedOf(id) > MONEY_EPSILON) wait(c.dealId, id);
  }
  // The job's own invoice (money-O1): a price stamped with the deal is the
  // deal's, whether or not it covers a carton — the Andijan → Tashkent leg
  // covers nothing and is still what the client was billed for this job.
  for (const ch of cargo.charges.values()) {
    const d = ch.dealId ? out.get(ch.dealId) : undefined;
    if (!d || !ch.dealId || !(ch.owedUsd > MONEY_EPSILON)) continue;
    d.ownChargesOwed += 1;
    wait(ch.dealId, ch.id);
  }
  for (const [dealId, waiting] of waits) {
    const d = out.get(dealId)!;
    const blocking = [...waiting].map((id) => cargo.charges.get(id));
    if (blocking.some((b) => b === undefined)) {
      d.toOpenUsd = null;
      continue;
    }
    const newest = (blocking as SettledCharge[]).sort(fifoOrder).at(-1)!;
    const first = [...cargo.charges.values()].filter(
      (ch) => ch.clientId === newest.clientId && ch.owedUsd > MONEY_EPSILON && fifoOrder(ch, newest) <= 0,
    );
    d.toOpenUsd = Math.round(first.reduce((sum, ch) => sum + ch.owedUsd, 0) * 100) / 100;
    d.olderOwedElsewhere = first.some((ch) => !waiting.has(ch.id) && ch.dealId !== dealId);
  }
  return out;
}

/** Every asked id is in the answer ({0,…} when it has no live carton): a missing key means «not asked». */
export async function dealCargoPaid(exec: Exec, dealIds: string[]): Promise<Map<string, DealCargoPaid>> {
  const asked = [...new Set(dealIds)].filter(Boolean);
  if (asked.length === 0) return new Map();
  return foldDealCargo(asked, await paidCargo(exec, { kind: 'deals', dealIds: asked }, { elsewhere: true }));
}
