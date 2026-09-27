import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { usersWithPermission } from '../../platform/notifications/service';
import { internalLegSql } from '../batches/internal';
import { FOUND_BACK_CAUSES, FOUND_BACK_SQL, clientAboardSql, riderRowsSql, rideMovementSql } from '../batches/riders';
import type { Exec } from './unpriced';

/**
 * A price whose cargo left the truck (owner, 2026-09-25, Q21a: «ogohlantirish
 * bersin»; Q2: the carton scanned onto A and found back in Yiwu is priced on
 * B). DERIVED, never stored: a (truck, client) pair of live charges that is
 * either
 *
 * - `no_cargo` — nothing of the client is a rider of the truck (the money
 *   rule, `clientAboardSql`: the live pointer before departure, the rides
 *   after). Timing does not matter: a price with nothing of the client aboard
 *   is always named.
 * - `partial` — the client rides, and some of its cartons left the truck
 *   AFTER the price: short-loaded or removed at loading, or scanned as
 *   departed and found back at the truck's origin. A price typed after the
 *   drop saw the truck without those cartons (the pricing page counts
 *   riders), so it is not warned about — which is also what makes the
 *   warning resolve itself once the accountant re-enters the price.
 *
 * - `grew` — the client rides, nothing left the truck, and the truck holds
 *   cartons of the client the price never saw (review money-4, 0112): an
 *   office count that went beyond the truck — the origin's spare stock, or
 *   cartons minted onto the prixod (Q3 b) — a plan widened after the price,
 *   a carton landed without a scan. A carton was SEEN when, at the moment of
 *   the price, its newest movement on this truck put it aboard (planned,
 *   loaded, departed, landed) rather than took it off (short-loaded,
 *   removed, found back at the origin). `grewBoxIds` is carried on every
 *   kind, so a pair that both dropped and grew says both.
 *
 * The moment of a price is the earliest `created_at` of its live charges.
 * «🚚 Ko'chirish» (`moveCharge`) copies `created_at`, so a moved price keeps
 * its original moment and still warns when it should.
 *
 * Internal CN → CN trucks are left out: they are never priced (C1a) and keep
 * their own «priced before the rule» section (#982).
 *
 * Every reader takes the executor first (`Exec`, the unpriced module's rule):
 * the screens pass `db`, nothing here runs inside a transaction today.
 */
export interface OffTruckPrice {
  batchId: string;
  batchCode: string;
  batchStatus: string;
  /** The truck's origin warehouse code — where a found-back carton was found. */
  originCode: string | null;
  clientId: string;
  clientCode: string;
  clientName: string;
  /** Σ of the live charges on the truck for the client, dollars. */
  chargedUsd: number;
  /** min(created_at) of those charges. */
  pricedAt: Date;
  kind: 'no_cargo' | 'partial' | 'grew';
  /** The client's cartons aboard that no price decision had seen (money-4). */
  grewBoxIds: string[];
  dropCause: 'short_loaded' | 'found_back' | 'mixed' | null;
  /** The pair's own dropped cartons (never the truck's whole manifest). */
  droppedBoxIds: string[];
  /** Where the dropped cartons ride now (pointer or ride), code-sorted. */
  droppedTo: { batchId: string; code: string; boxes: number }[];
  /** The live charges behind `chargedUsd`, for «🚚 Ko'chirish» (own currency). */
  charges: { id: string; amount: number; currency: string }[];
}

export type OffTruckScope = { batchIds: string[] } | { clientIds: string[] };

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

export async function offTruckPrices(exec: Exec, scope: OffTruckScope): Promise<OffTruckPrice[]> {
  const ids = 'batchIds' in scope ? scope.batchIds : scope.clientIds;
  if (ids.length === 0) return [];
  const where: SQL =
    'batchIds' in scope ? sql`ct.batch_id IN (${idList([...new Set(ids)])})` : sql`ct.client_id IN (${idList([...new Set(ids)])})`;

  const rows = (await exec.execute(sql`
    WITH
    -- \`priced_at\` is when the price on this pair was last DECIDED, not the
    -- row's clock: moveCharge and the lost-cargo door keep \`created_at\` for
    -- the kurs farqi order (Q18), so after the accountant split A's price
    -- correctly A's remaining part still pre-dated the drop and the banner,
    -- the card's chip and the «🚚 Ko'chirish» door never cleared (review of
    -- the gate, U24). The re-post's own audit row carries the decision.
    ot_priced AS (
      SELECT ct.batch_id, ct.client_id, sum(ct.amount_usd) AS charged_usd,
             min(greatest(ct.created_at, coalesce((
               SELECT max(pa.created_at) FROM audit_log pa
                WHERE pa.entity_type = 'client_transaction' AND pa.entity_id = ct.id AND pa.action = 'create'
                  AND (pa.after ? 'movedFrom' OR pa.after ? 'repricedFrom')), ct.created_at))) AS priced_at,
             -- The LAST decision, for growth: a charge the accountant added
             -- for the extra cartons is an answer to them, while a dropped
             -- carton is judged against the first price, which billed it.
             max(greatest(ct.created_at, coalesce((
               SELECT max(pa.created_at) FROM audit_log pa
                WHERE pa.entity_type = 'client_transaction' AND pa.entity_id = ct.id AND pa.action = 'create'
                  AND (pa.after ? 'movedFrom' OR pa.after ? 'repricedFrom')), ct.created_at))) AS priced_last
        FROM client_transactions ct
        JOIN batches bt ON bt.id = ct.batch_id
        JOIN warehouses o ON o.id = bt.origin_warehouse_id
        JOIN warehouses d ON d.id = bt.dest_warehouse_id
       WHERE ct.type = 'charge' AND ct.voided_at IS NULL AND ct.batch_id IS NOT NULL
         AND NOT ${internalLegSql('o', 'd')}
         AND ${where}
       GROUP BY ct.batch_id, ct.client_id
    ),
    ot_aboard AS (
      SELECT p.batch_id, p.client_id, ${clientAboardSql(sql`p.batch_id`, sql`p.client_id`)} AS aboard
        FROM ot_priced p
    ),
    ot_drops AS (
      SELECT DISTINCT p.batch_id, p.client_id, dm.box_id,
             CASE WHEN dm.cause = 'batch_departed' THEN 'found_back' ELSE 'short_loaded' END AS how
        FROM ot_priced p
        JOIN box_movements dm ON dm.ref_type = 'batch' AND dm.ref_id = p.batch_id
                             AND dm.cause IN ('short_loaded', 'load_removed', 'batch_departed')
        JOIN boxes dbx ON dbx.id = dm.box_id AND dbx.status <> 'void'
        JOIN receipt_lots drl ON drl.id = dbx.lot_id
        JOIN receipts dr ON dr.id = drl.receipt_id AND dr.client_id = p.client_id
       WHERE dbx.current_batch_id IS DISTINCT FROM p.batch_id
         AND NOT EXISTS (
           SELECT 1 FROM box_movements rx
            WHERE rx.box_id = dm.box_id AND rx.ref_type = 'batch' AND rx.ref_id = p.batch_id
              AND rx.cause IN ('batch_departed', 'undocumented_transfer') AND ${rideMovementSql('rx')}
         )
         AND (
           (dm.cause IN ('short_loaded', 'load_removed') AND dm.created_at > p.priced_at)
           OR (dm.cause = 'batch_departed' AND EXISTS (
             SELECT 1 FROM box_movements fb
               JOIN batches fbt ON fbt.id = p.batch_id
              WHERE fb.box_id = dm.box_id AND fb.cause IN ${FOUND_BACK_SQL}
                AND fb.to_warehouse_id = fbt.origin_warehouse_id
                AND (fb.created_at, fb.id) > (dm.created_at, dm.id)
                AND fb.created_at > p.priced_at))
         )
    ),
    -- Money-4: every carton of the pair touched by the truck after the last
    -- decision is a candidate (\`box_movements_ref_idx\`, bounded by the
    -- client's own cargo) — a carton that joined can only have joined through
    -- a movement on this truck.
    ot_cand AS (
      SELECT DISTINCT p.batch_id, p.client_id, p.priced_last, cm.box_id
        FROM ot_priced p
        JOIN box_movements cm ON cm.ref_type = 'batch' AND cm.ref_id = p.batch_id AND cm.created_at > p.priced_last
        JOIN boxes cbx ON cbx.id = cm.box_id AND cbx.status <> 'void'
        JOIN receipt_lots cl ON cl.id = cbx.lot_id
        JOIN receipts cr ON cr.id = cl.receipt_id AND cr.client_id = p.client_id
    ),
    ot_grew AS (
      SELECT c.batch_id, c.client_id, c.box_id
        FROM ot_cand c
        JOIN (${riderRowsSql({ boxes: sql`SELECT box_id FROM ot_cand` })}) gr
          ON gr.box_id = c.box_id AND gr.batch_id = c.batch_id
       WHERE NOT EXISTS (
         -- Seen: at the price, the carton's newest movement on this truck put
         -- it aboard. Two writes of one transaction share a clock; the id
         -- breaks the tie (riders.ts).
         SELECT 1 FROM box_movements sm
          WHERE sm.box_id = c.box_id AND sm.ref_type = 'batch' AND sm.ref_id = c.batch_id
            AND sm.created_at <= c.priced_last
            AND sm.cause NOT IN ('short_loaded', 'load_removed', 'lot_edit_remove', ${sql.raw(FOUND_BACK_CAUSES.map((cause) => `'${cause}'`).join(', '))})
            AND NOT EXISTS (
              SELECT 1 FROM box_movements sx
               WHERE sx.box_id = sm.box_id AND sx.ref_type = 'batch' AND sx.ref_id = c.batch_id
                 AND sx.created_at <= c.priced_last
                 AND (sx.created_at, sx.id) > (sm.created_at, sm.id)
            )
       )
    ),
    ot_dest AS (
      SELECT d.batch_id AS from_batch, d.client_id, rr.batch_id AS to_batch, count(DISTINCT d.box_id)::int AS boxes
        FROM ot_drops d
        JOIN (${riderRowsSql({ boxes: sql`SELECT box_id FROM ot_drops` })}) rr
          ON rr.box_id = d.box_id AND rr.batch_id <> d.batch_id
       GROUP BY 1, 2, 3
    )
    SELECT p.batch_id, p.client_id, p.charged_usd, p.priced_at, a.aboard,
           bt.code AS batch_code, bt.status AS batch_status, ow.code AS origin_code,
           c.client_code, c.name AS client_name,
           coalesce((SELECT array_agg(DISTINCT d.box_id::text) FROM ot_drops d
                      WHERE d.batch_id = p.batch_id AND d.client_id = p.client_id), '{}') AS dropped_ids,
           coalesce((SELECT array_agg(DISTINCT g.box_id::text) FROM ot_grew g
                      WHERE g.batch_id = p.batch_id AND g.client_id = p.client_id), '{}') AS grew_ids,
           (SELECT CASE WHEN count(DISTINCT d.how) > 1 THEN 'mixed' ELSE min(d.how) END
              FROM ot_drops d WHERE d.batch_id = p.batch_id AND d.client_id = p.client_id) AS drop_cause,
           coalesce((SELECT json_agg(json_build_object('batchId', nb.id, 'code', nb.code, 'boxes', x.boxes) ORDER BY nb.code)
                       FROM ot_dest x JOIN batches nb ON nb.id = x.to_batch
                      WHERE x.from_batch = p.batch_id AND x.client_id = p.client_id), '[]'::json) AS dropped_to,
           (SELECT json_agg(json_build_object('id', lc.id, 'amount', lc.amount, 'currency', lc.currency)
                            ORDER BY lc.created_at, lc.id)
              FROM client_transactions lc
             WHERE lc.batch_id = p.batch_id AND lc.client_id = p.client_id
               AND lc.type = 'charge' AND lc.voided_at IS NULL) AS charges
      FROM ot_priced p
      JOIN ot_aboard a ON a.batch_id = p.batch_id AND a.client_id = p.client_id
      JOIN batches bt ON bt.id = p.batch_id
      LEFT JOIN warehouses ow ON ow.id = bt.origin_warehouse_id
      JOIN clients c ON c.id = p.client_id
     WHERE NOT a.aboard
        OR EXISTS (SELECT 1 FROM ot_drops d WHERE d.batch_id = p.batch_id AND d.client_id = p.client_id)
        OR EXISTS (SELECT 1 FROM ot_grew g WHERE g.batch_id = p.batch_id AND g.client_id = p.client_id)
     ORDER BY bt.code, c.client_code
  `)) as unknown as {
    batch_id: string;
    client_id: string;
    charged_usd: string;
    priced_at: string;
    aboard: boolean;
    batch_code: string;
    batch_status: string;
    origin_code: string | null;
    client_code: string;
    client_name: string;
    dropped_ids: string[];
    grew_ids: string[];
    drop_cause: 'short_loaded' | 'found_back' | 'mixed' | null;
    dropped_to: { batchId: string; code: string; boxes: number }[] | string;
    charges: { id: string; amount: string | number; currency: string }[] | null;
  }[];

  return rows.map((row) => ({
    batchId: row.batch_id,
    batchCode: row.batch_code,
    batchStatus: row.batch_status,
    originCode: row.origin_code,
    clientId: row.client_id,
    clientCode: row.client_code,
    clientName: row.client_name,
    chargedUsd: Math.round(Number(row.charged_usd) * 100) / 100,
    pricedAt: new Date(row.priced_at),
    kind: !row.aboard
      ? ('no_cargo' as const)
      : (row.dropped_ids ?? []).length > 0
        ? ('partial' as const)
        : ('grew' as const),
    grewBoxIds: row.grew_ids ?? [],
    dropCause: row.drop_cause,
    droppedBoxIds: row.dropped_ids ?? [],
    droppedTo: (typeof row.dropped_to === 'string' ? JSON.parse(row.dropped_to) : row.dropped_to).map(
      (d: { batchId: string; code: string; boxes: number }) => ({ batchId: d.batchId, code: d.code, boxes: Number(d.boxes) }),
    ),
    charges: (row.charges ?? []).map((c) => ({ id: c.id, amount: Number(c.amount), currency: c.currency })),
  }));
}

/**
 * The rows the NEXT truck's page names (Q2 / Q21): prices on another truck
 * whose dropped cartons ride `batchId` now. Filtered on `droppedTo`, never on
 * the row's own truck — that is T's page, not B's.
 */
export function pricedElsewhereFor(rows: OffTruckPrice[], batchId: string): OffTruckPrice[] {
  return rows.filter((row) => row.batchId !== batchId && row.droppedTo.some((d) => d.batchId === batchId));
}

/**
 * «Narx qo'yilgan, yuki qoldi» at the end of loading (Q21a), on the pool,
 * AFTER `finishLoading`'s transaction — a Telegram row must never roll a load
 * back. IDEMPOTENT: only the prices whose dropped cartons include THIS call's
 * short-loaded ids are announced, so a second press (or a retried one), which
 * short-loads nothing, says nothing (the money lens's minor 6). A carton
 * removed by hand earlier is named on the pricing page, not pushed again.
 *
 * Told: law 4's audience (`finance.reports` — the accountant and the admins;
 * the VED does not hold it, Q19) and whoever typed the price. Never the
 * presser.
 */
export async function notifyPricedCargoLeft(
  batchId: string,
  shortLoadedIds: string[],
  actorId: string | null | undefined,
): Promise<void> {
  if (shortLoadedIds.length === 0) return;
  const now = new Set(shortLoadedIds);
  const rows = (await offTruckPrices(db, { batchIds: [batchId] })).filter((row) =>
    row.droppedBoxIds.some((id) => now.has(id)),
  );
  if (rows.length === 0) return;
  const clientIds = rows.map((row) => row.clientId);
  const [readers, authors, aboard] = await Promise.all([
    usersWithPermission('finance.reports'),
    db.execute(sql`
      SELECT DISTINCT ct.created_by FROM client_transactions ct
       WHERE ct.batch_id = ${batchId}::uuid AND ct.type = 'charge' AND ct.voided_at IS NULL
         AND ct.client_id IN (${idList(clientIds)}) AND ct.created_by IS NOT NULL
    `) as unknown as Promise<{ created_by: string }[]>,
    // Riders before departure are the live pointer: what is still aboard.
    db.execute(sql`
      SELECT r.client_id, count(*)::int AS n FROM boxes b
        JOIN receipt_lots rl ON rl.id = b.lot_id JOIN receipts r ON r.id = rl.receipt_id
       WHERE b.current_batch_id = ${batchId}::uuid AND b.status <> 'void'
         AND r.client_id IN (${idList(clientIds)})
       GROUP BY r.client_id
    `) as unknown as Promise<{ client_id: string; n: number }[]>,
  ]);
  const staying = new Map(aboard.map((row) => [row.client_id, Number(row.n)]));
  const lines = rows.slice(0, 12).map((row) => {
    const left = row.droppedBoxIds.filter((id) => now.has(id)).length;
    const kept = staying.get(row.clientId) ?? 0;
    return kept === 0
      ? `${row.clientCode} $${row.chargedUsd.toFixed(2)} — ${left} ta karobkaning hammasi yuklanmadi`
      : `${row.clientCode} $${row.chargedUsd.toFixed(2)} — ${left} karobka yuklanmadi (${left + kept} tadan)`;
  });
  const appUrl = process.env.APP_URL ?? '';
  await notifyStaffTelegram({
    userIds: [...readers, ...authors.map((row) => row.created_by)],
    type: 'PricedCargoLeft',
    exceptUserId: actorId ?? null,
    text:
      `💰 ${rows[0]!.batchCode} — narx qo‘yilgan, yuki qoldi\n` +
      lines.join('\n') +
      (rows.length > lines.length ? `\n… +${rows.length - lines.length}` : '') +
      `\nNarxni yuk ketgan mashinaga buxgalter ko‘chiradi (🚚 Ko‘chirish).` +
      `\n${appUrl}/batches/${batchId}/pricing`,
  });
}

/**
 * «Narx qo'yilgan, keyin yuk ko'paydi» after an office count went beyond the
 * truck (review money-4, 0112) — on the pool, AFTER the press's commits, and
 * never failing it (the caller catches). Only the pairs whose unseen cartons
 * include this lot's are announced, so a count of another lot says nothing
 * about a price it did not change. Told: `finance.reports` and whoever typed
 * the price — never the presser (Q6c).
 */
export async function notifyPricedCargoGrew(
  batchId: string,
  lotId: string,
  actorId: string | null | undefined,
): Promise<void> {
  const rows = await offTruckPrices(db, { batchIds: [batchId] });
  const grew = rows.filter((row) => row.grewBoxIds.length > 0);
  if (grew.length === 0) return;
  const lotBoxes = (await db.execute(sql`
    SELECT b.id FROM boxes b
     WHERE b.lot_id = ${lotId}::uuid AND b.id IN (${idList(grew.flatMap((row) => row.grewBoxIds))})
  `)) as unknown as { id: string }[];
  const mine = new Set(lotBoxes.map((row) => row.id));
  const told = grew.filter((row) => row.grewBoxIds.some((id) => mine.has(id)));
  if (told.length === 0) return;
  const [readers, authors] = await Promise.all([
    usersWithPermission('finance.reports'),
    db.execute(sql`
      SELECT DISTINCT ct.created_by FROM client_transactions ct
       WHERE ct.batch_id = ${batchId}::uuid AND ct.type = 'charge' AND ct.voided_at IS NULL
         AND ct.client_id IN (${idList(told.map((row) => row.clientId))}) AND ct.created_by IS NOT NULL
    `) as unknown as Promise<{ created_by: string }[]>,
  ]);
  const appUrl = process.env.APP_URL ?? '';
  await notifyStaffTelegram({
    userIds: [...readers, ...authors.map((row) => row.created_by)],
    type: 'PricedCargoGrew',
    exceptUserId: actorId ?? null,
    text:
      `💰 ${told[0]!.batchCode} — narx qo‘yilgandan keyin yuk ko‘paydi\n` +
      told.map((row) => `${row.clientCode} $${row.chargedUsd.toFixed(2)} — +${row.grewBoxIds.length} karobka narxsiz`).join('\n') +
      `\nQo‘shilgan karobkalarga narx qo‘ying yoki narxni qayta kiriting.` +
      `\n${appUrl}/batches/${batchId}/pricing`,
  });
}
