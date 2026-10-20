import { sql, type SQL } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { logger } from '../../platform/logger';
import { groupDigits } from '../../platform/telegram/format';
import { usersWithPermission, usersWithRoles } from '../../platform/notifications/service';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { receivedMonthSql } from '../staff/cargo';
import { kpiPaidMonthSql, takeKpiSellerLocks } from '../staff/kpi-lock';
import { FtlError, type FtlDoor } from './door';
import type { LoadMode } from './sql';

/**
 * The ONE writer of LTL / FTL (0135, the owner's 1a 2a 6a). Every rule of the
 * round is a sentence here, and every door — the lead/deal forms, winLead,
 * the prixod confirm, the deal link, the prixod card — calls in rather than
 * writing the three tables itself (a derived fence holds that).
 *
 *  - A LEAD or DEAL is FTL when it has a row (`lead_ftl` / `deal_ftl`); the row
 *    says who marked it and whether that was the office.
 *  - A PRIXOD inherits FTL from its deal through ONE statement (`inheritSql`)
 *    — at confirm, at a re-file, and when the deal itself turns FTL — and only
 *    when the deal is the prixod's client's, the mark reaches it (an office
 *    mark: every prixod; a seller's: only cargo stamped to HIM — never a
 *    colleague's KPI), nobody pinned the prixod by hand, and its KPI month is
 *    not PAID.
 *  - Nothing downgrades by accident: a re-file to an LTL deal or a detach
 *    keeps the prixod's mode; FTL → LTL is only ever the office's explicit
 *    decision (the deal's revert takes back exactly what THAT deal gave, by
 *    `from_deal_id`, wherever the prixod went since).
 *  - A PAID month is frozen (his 6a): `kpiPaidMonthSql`, under the payout's
 *    own seller lock, taken first and in sorted order (staff/kpi-lock.ts).
 */

type Exec = Db | Tx;

let ready = false;

/**
 * Are 0135's tables there? (#472: a deploy whose migration did not land.)
 * Asked BEFORE a transaction by the doors receiving and the CRM depend on —
 * on «no» the prixod confirm inherits nothing, the forms hide the choice and
 * the FTL doors answer `server_behind`, so the round can never take receiving
 * down one migration behind. Remembered once «yes» (tables do not disappear
 * under a running process); «no» is asked again, so it comes back the moment
 * the migration lands. Pool only, pre-transaction only (#714).
 */
export async function ftlReady(): Promise<boolean> {
  if (ready) return true;
  try {
    const rows = (await db.execute(sql`
      SELECT to_regclass('public.lead_ftl') IS NOT NULL
         AND to_regclass('public.deal_ftl') IS NOT NULL
         AND to_regclass('public.receipt_load_mode') IS NOT NULL AS ok`)) as unknown as { ok: boolean }[];
    ready = rows[0]?.ok === true;
  } catch (err) {
    logger.error({ err }, '[ftl] readiness probe failed');
    return false;
  }
  return ready;
}

/** Only for a test that drops the tables to prove the probe. */
export function forgetFtlReady(): void {
  ready = false;
}

const ids = (list: readonly string[]): SQL => sql.join(
  list.map((id) => sql`${id}::uuid`),
  sql`, `,
);

/**
 * THE inheritance, one statement for the three writers (#513). `scope` picks
 * the prixods (`r.id = $R`, or `r.deal_id = $D`); `lockedSellers`, when given,
 * pins the stamps the caller holds the KPI lock for — a prixod restamped to
 * somebody else in between is left alone rather than written unlocked.
 */
function inheritSql(scope: SQL, actorId: string | null, lockedSellers: readonly string[] | null): SQL {
  const pin =
    lockedSellers === null
      ? sql`true`
      : lockedSellers.length === 0
        ? sql`r.sales_manager_id IS NULL`
        : sql`(r.sales_manager_id IS NULL OR r.sales_manager_id IN (${ids(lockedSellers)}))`;
  return sql`
    INSERT INTO receipt_load_mode (receipt_id, mode, hand, from_deal_id, set_by)
    SELECT r.id, 'ftl', false, d.id, ${actorId}::uuid
      FROM receipts r
      JOIN deals d ON d.id = r.deal_id AND d.client_id = r.client_id
      JOIN deal_ftl df ON df.deal_id = d.id
     WHERE ${scope}
       AND (df.by_office OR r.sales_manager_id = df.marked_by)
       AND NOT EXISTS (SELECT 1 FROM receipt_load_mode h WHERE h.receipt_id = r.id AND h.hand)
       AND NOT ${kpiPaidMonthSql('r')}
       AND ${pin}
    ON CONFLICT (receipt_id) DO UPDATE
       SET mode = 'ftl', from_deal_id = EXCLUDED.from_deal_id, set_by = EXCLUDED.set_by, set_at = now()
     WHERE NOT receipt_load_mode.hand
    RETURNING receipt_id`;
}

/**
 * A prixod that just got its deal — the confirm's INSERT or a re-file —
 * inherits that deal's FTL in the same transaction. The confirm passes no
 * lock: a new prixod can never land in a PAID month (the office back-dates
 * at most 7 days and a month closes on the 8th), so the freeze clause is a
 * belt only there. A re-file takes the stamp's lock first and passes it.
 */
export async function inheritFromDealTx(
  tx: Tx,
  receiptId: string,
  actorId: string | null,
  lockedSellers: readonly string[] | null,
): Promise<boolean> {
  const rows = (await tx.execute(inheritSql(sql`r.id = ${receiptId}::uuid`, actorId, lockedSellers))) as unknown as unknown[];
  return [...rows].length > 0;
}

/** Why a cascade left a linked prixod as it was — named on the screen, never silent. */
export type CascadeSkip = 'kpi_paid' | 'hand' | 'other_seller' | 'other_client';

export interface CascadeResult {
  changed: number;
  skipped: { receiptId: string; number: string | null; why: CascadeSkip }[];
}

const SKIP_LIMIT = 20;

/**
 * Turn a deal FTL or back, with its prixods, inside the caller's transaction.
 * The caller holds the DEAL ROW (updateDeal's UPDATE, or `setDealLoad`'s
 * `FOR NO KEY UPDATE`), and has already decided the door; this writes the
 * mark, takes the sellers' KPI locks in sorted order and moves the prixods.
 */
export async function setDealFtlTx(
  tx: Tx,
  dealId: string,
  ftl: boolean,
  mark: { actorId: string | null; office: boolean },
  ctx: AuditContext,
): Promise<CascadeResult> {
  if (ftl) {
    await tx.execute(sql`
      INSERT INTO deal_ftl (deal_id, marked_by, by_office) VALUES (${dealId}::uuid, ${mark.actorId}::uuid, ${mark.office})
      ON CONFLICT (deal_id) DO UPDATE SET marked_by = EXCLUDED.marked_by, by_office = EXCLUDED.by_office, marked_at = now()`);
  } else {
    await tx.execute(sql`DELETE FROM deal_ftl WHERE deal_id = ${dealId}::uuid`);
  }

  // The stamps the move can touch, locked before any prixod row is written.
  const stampRows = (await tx.execute(
    ftl
      ? sql`SELECT DISTINCT r.sales_manager_id AS id FROM receipts r WHERE r.deal_id = ${dealId}::uuid`
      : sql`SELECT DISTINCT r.sales_manager_id AS id
              FROM receipt_load_mode rlm JOIN receipts r ON r.id = rlm.receipt_id
             WHERE rlm.from_deal_id = ${dealId}::uuid AND NOT rlm.hand`,
  )) as unknown as { id: string | null }[];
  const locked = await takeKpiSellerLocks(tx, [...stampRows].map((row) => row.id));

  let changed: string[];
  if (ftl) {
    const rows = (await tx.execute(inheritSql(sql`r.deal_id = ${dealId}::uuid`, mark.actorId, locked))) as unknown as {
      receipt_id: string;
    }[];
    changed = [...rows].map((row) => row.receipt_id);
  } else {
    const pin =
      locked.length === 0
        ? sql`r.sales_manager_id IS NULL`
        : sql`(r.sales_manager_id IS NULL OR r.sales_manager_id IN (${ids(locked)}))`;
    const rows = (await tx.execute(sql`
      DELETE FROM receipt_load_mode rlm
       USING receipts r
       WHERE r.id = rlm.receipt_id
         AND rlm.from_deal_id = ${dealId}::uuid AND NOT rlm.hand
         AND NOT ${kpiPaidMonthSql('r')}
         AND ${pin}
      RETURNING rlm.receipt_id`)) as unknown as { receipt_id: string }[];
    changed = [...rows].map((row) => row.receipt_id);
  }

  // What stayed, and why — read after the move, under the same locks.
  const skipRows = (await tx.execute(
    ftl
      ? sql`
        SELECT r.id, r.number,
               CASE WHEN r.client_id IS DISTINCT FROM d.client_id THEN 'other_client'
                    WHEN h.hand THEN 'hand'
                    WHEN NOT df.by_office AND r.sales_manager_id IS DISTINCT FROM df.marked_by THEN 'other_seller'
                    WHEN ${kpiPaidMonthSql('r')} THEN 'kpi_paid'
               END AS why
          FROM receipts r
          JOIN deals d ON d.id = r.deal_id
          JOIN deal_ftl df ON df.deal_id = d.id
          LEFT JOIN receipt_load_mode h ON h.receipt_id = r.id
         WHERE r.deal_id = ${dealId}::uuid AND r.status <> 'voided'
           AND coalesce(h.mode, 'ltl') <> 'ftl'
         ORDER BY r.number NULLS LAST
         LIMIT ${SKIP_LIMIT}`
      : sql`
        SELECT r.id, r.number, 'kpi_paid' AS why
          FROM receipt_load_mode rlm JOIN receipts r ON r.id = rlm.receipt_id
         WHERE rlm.from_deal_id = ${dealId}::uuid AND NOT rlm.hand AND rlm.mode = 'ftl'
         ORDER BY r.number NULLS LAST
         LIMIT ${SKIP_LIMIT}`,
  )) as unknown as { id: string; number: string | null; why: CascadeSkip | null }[];

  for (const receiptId of changed) {
    await writeAudit(tx, ctx, {
      entityType: 'receipt',
      entityId: receiptId,
      action: 'update',
      before: { freightMode: ftl ? 'ltl' : 'ftl' },
      after: { freightMode: ftl ? 'ftl' : 'ltl', deal: dealId },
    });
  }
  return {
    changed: changed.length,
    skipped: [...skipRows]
      .filter((row) => row.why !== null)
      .map((row) => ({ receiptId: row.id, number: row.number, why: row.why! })),
  };
}

/** Lead FTL on or off (the door was asked by the caller). A lead has no prixods, so nothing cascades. */
export async function setLeadFtlTx(
  tx: Exec,
  leadId: string,
  ftl: boolean,
  mark: { actorId: string | null; office: boolean },
): Promise<void> {
  if (ftl) {
    await tx.execute(sql`
      INSERT INTO lead_ftl (lead_id, marked_by, by_office) VALUES (${leadId}::uuid, ${mark.actorId}::uuid, ${mark.office})
      ON CONFLICT (lead_id) DO UPDATE SET marked_by = EXCLUDED.marked_by, by_office = EXCLUDED.by_office, marked_at = now()`);
  } else {
    await tx.execute(sql`DELETE FROM lead_ftl WHERE lead_id = ${leadId}::uuid`);
  }
}

/**
 * The won lead's mark becomes its deal's (winLead): who marked it and whether
 * that was the office travel with it — the lead's door was asked when the mark
 * was set, so the presser of «Yutildi» is not asked again (a colleague winning
 * an FTL lead must not be refused AFTER the client was written, #882's shape).
 * A new deal has no prixods yet, so there is nothing to cascade.
 */
export async function carryLeadFtlTx(tx: Tx, leadId: string, dealId: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    INSERT INTO deal_ftl (deal_id, marked_by, by_office)
    SELECT ${dealId}::uuid, lf.marked_by, lf.by_office FROM lead_ftl lf WHERE lf.lead_id = ${leadId}::uuid
    ON CONFLICT (deal_id) DO NOTHING
    RETURNING deal_id`)) as unknown as unknown[];
  return [...rows].length > 0;
}

/** Is the lead / deal FTL? Inside a transaction or on the pool. */
export async function leadIsFtl(exec: Exec, leadId: string): Promise<boolean> {
  const rows = (await exec.execute(sql`SELECT 1 FROM lead_ftl WHERE lead_id = ${leadId}::uuid`)) as unknown as unknown[];
  return [...rows].length > 0;
}

export async function dealIsFtl(exec: Exec, dealId: string): Promise<boolean> {
  const rows = (await exec.execute(sql`SELECT 1 FROM deal_ftl WHERE deal_id = ${dealId}::uuid`)) as unknown as unknown[];
  return [...rows].length > 0;
}

export interface ReceiptLoadResult {
  changed: boolean;
  mode: LoadMode;
}

/**
 * The prixod card's door: a person decides this prixod's mode by hand.
 * The office may write either mode on any prixod; anybody else may only ever
 * write FTL, and only on cargo stamped to HIMSELF (an LTL write by a seller
 * would pin his cargo against the office's later FTL — refused, whatever the
 * current mode). A write equal to the current mode changes nothing — no pin,
 * no audit. A PAID month is refused in words (his 6a).
 */
export async function setReceiptLoad(
  receiptId: string,
  mode: LoadMode,
  door: FtlDoor,
  ctx: AuditContext,
): Promise<ReceiptLoadResult> {
  if (!(await ftlReady())) throw new FtlError('server_behind');
  if (!door.office && mode !== 'ftl') throw new FtlError('ftl_office_only');

  const result = await db.transaction(async (tx) => {
    const [seen] = (await tx.execute(sql`
      SELECT r.sales_manager_id AS seller_id FROM receipts r WHERE r.id = ${receiptId}::uuid`)) as unknown as {
      seller_id: string | null;
    }[];
    if (!seen) throw new FtlError('not_found');
    await takeKpiSellerLocks(tx, [seen.seller_id]);
    const [row] = (await tx.execute(sql`
      SELECT r.sales_manager_id AS seller_id, u.full_name AS seller_name, r.number,
             ${receivedMonthSql(sql`r.received_at`)} AS month,
             coalesce(rlm.mode, 'ltl') AS mode,
             ${kpiPaidMonthSql('r')} AS paid
        FROM receipts r
        LEFT JOIN users u ON u.id = r.sales_manager_id
        LEFT JOIN receipt_load_mode rlm ON rlm.receipt_id = r.id
       WHERE r.id = ${receiptId}::uuid
       FOR NO KEY UPDATE OF r`)) as unknown as {
      seller_id: string | null;
      seller_name: string | null;
      number: string | null;
      month: string;
      mode: LoadMode;
      paid: boolean;
    }[];
    if (!row) throw new FtlError('not_found');
    if (row.seller_id !== seen.seller_id) throw new FtlError('stamp_moved');
    if (row.mode === mode) return { changed: false, mode, number: row.number };
    if (!door.office && row.seller_id !== door.actorId) throw new FtlError('ftl_not_yours');
    if (row.paid) throw new FtlError('kpi_paid', { month: row.month, sellerName: row.seller_name });

    await tx.execute(sql`
      INSERT INTO receipt_load_mode (receipt_id, mode, hand, from_deal_id, set_by)
      VALUES (${receiptId}::uuid, ${mode}, true, NULL, ${door.actorId}::uuid)
      ON CONFLICT (receipt_id) DO UPDATE
         SET mode = EXCLUDED.mode, hand = true, from_deal_id = NULL, set_by = EXCLUDED.set_by, set_at = now()`);
    await writeAudit(tx, ctx, {
      entityType: 'receipt',
      entityId: receiptId,
      action: 'update',
      before: { freightMode: row.mode },
      after: { freightMode: mode },
    });
    return { changed: true, mode, number: row.number };
  });

  if (result.changed && !door.office) {
    await notifyFtlMarked({ kind: 'receipt', id: receiptId, actorId: door.actorId }).catch((err) =>
      logger.error({ err, receiptId }, '[ftl] FtlMarked notice failed'),
    );
  }
  return { changed: result.changed, mode: result.mode };
}

/**
 * The office's narrow deal door (the accountant cannot open a deal card — this
 * is his «Bitimni ham LTL qilish» on the prixod card, and the logist's too).
 * The same cascade as the ✏️ form, under the same deal-row lock.
 */
export async function setDealLoad(
  dealId: string,
  mode: LoadMode,
  door: FtlDoor,
  ctx: AuditContext,
): Promise<{ changed: boolean; cascade: CascadeResult | null }> {
  if (!(await ftlReady())) throw new FtlError('server_behind');
  if (!door.office) throw new FtlError('ftl_office_only');
  return db.transaction(async (tx) => {
    const [deal] = (await tx.execute(sql`
      SELECT d.id FROM deals d WHERE d.id = ${dealId}::uuid FOR NO KEY UPDATE`)) as unknown as { id: string }[];
    if (!deal) throw new FtlError('not_found');
    const before = await dealIsFtl(tx, dealId);
    const after = mode === 'ftl';
    if (before === after) return { changed: false, cascade: null };
    const cascade = await setDealFtlTx(tx, dealId, after, { actorId: door.actorId, office: true }, ctx);
    await writeAudit(tx, ctx, {
      entityType: 'deal',
      entityId: dealId,
      action: 'update',
      before: { freightMode: before ? 'ftl' : 'ltl' },
      after: { freightMode: mode },
    });
    return { changed: true, cascade };
  });
}

/**
 * A SELLER marked his own job FTL — told to the office (FtlMarked, alerts):
 * dropping a light lot from his month can LIFT its density band and his rate
 * with it, so «it only costs him» is not the whole story. Names the record and
 * its size, no money. After the commit, on the pool.
 */
export async function notifyFtlMarked(q: { kind: 'lead' | 'deal' | 'receipt'; id: string; actorId: string }): Promise<void> {
  const [who] = (await db.execute(sql`SELECT full_name FROM users WHERE id = ${q.actorId}::uuid`)) as unknown as {
    full_name: string | null;
  }[];
  const appUrl = process.env.APP_URL ?? '';
  let line: string;
  let link: string;
  if (q.kind === 'receipt') {
    const [r] = (await db.execute(sql`
      SELECT r.number, c.client_code, coalesce(sum(rl.total_volume_m3), 0)::float8 AS m3,
             coalesce(sum(rl.total_weight_kg), 0)::float8 AS kg
        FROM receipts r
        LEFT JOIN clients c ON c.id = r.client_id
        LEFT JOIN receipt_lots rl ON rl.receipt_id = r.id
       WHERE r.id = ${q.id}::uuid
       GROUP BY r.number, c.client_code`)) as unknown as { number: string | null; client_code: string | null; m3: number; kg: number }[];
    if (!r) return;
    line = `prixod ${r.number ?? '—'}${r.client_code ? ` · ${r.client_code}` : ''} — ${groupDigits(r.m3)} kub · ${groupDigits(Math.round(r.kg))} kg`;
    link = `${appUrl}/receipts/${q.id}`;
  } else {
    const table = q.kind === 'deal' ? sql`deals` : sql`leads`;
    const [r] = (await db.execute(sql`
      SELECT ${q.kind === 'deal' ? sql`t.code` : sql`t.name`} AS label,
             t.quoted_volume_m3::float8 AS m3, t.quoted_weight_kg::float8 AS kg
        FROM ${table} t WHERE t.id = ${q.id}::uuid`)) as unknown as { label: string | null; m3: number | null; kg: number | null }[];
    if (!r) return;
    const size = [r.m3 ? `${groupDigits(r.m3)} kub` : '', r.kg ? `${groupDigits(Math.round(r.kg))} kg` : '']
      .filter(Boolean)
      .join(' · ');
    line = `${q.kind === 'deal' ? 'bitim' : 'lid'} ${r.label ?? '—'}${size ? ` — ${size}` : ''}`;
    link = `${appUrl}/${q.kind === 'deal' ? 'bitimlar' : 'crm/leads'}/${q.id}`;
  }
  const office = [...new Set([...(await usersWithPermission('finance.reports')), ...(await usersWithRoles(['logist']))])];
  if (office.length === 0) return;
  await notifyStaffTelegram({
    userIds: office,
    type: 'FtlMarked',
    exceptUserId: q.actorId,
    text:
      `🚛 FTL belgilandi\n` +
      `${who?.full_name ?? 'Sotuvchi'}: ${line}\n` +
      `Bu yuk KPI va reytingga kirmaydi. Noto'g'ri bo'lsa — LTL'ga qaytaring.\n` +
      link,
  });
}
