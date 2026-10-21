import { sql, type SQL } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { logger } from '../../platform/logger';
import { groupDigits } from '../../platform/telegram/format';
import { canLogInSql } from '../../platform/users/login';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { receivedMonthSql } from '../staff/cargo';
import { kpiPaidMonthSql, takeKpiSellerLocks } from '../staff/kpi-lock';
import { FTL_OFFICE_PERMISSIONS, FtlError, type FtlDoor } from './door';
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
 * THE inheritance, one statement for every writer (#513). `scope` picks the
 * prixods (`r.id = $R`, `r.deal_id = $D`, a stamped set); `lockedSellers`,
 * when given, pins the stamps the caller holds the KPI lock for — a prixod
 * restamped to somebody else in between is left alone rather than written
 * unlocked. `presser`, when given, is the person whose press links the prixod
 * to the deal (the confirm, a re-file): the office reaches what the mark
 * reaches, anybody else only cargo stamped to HIM — filing a colleague's
 * prixod onto an FTL job must not take it out of the colleague's KPI. The
 * deal's own cascade and the stamping pass none: their door was the mark's.
 *
 * Returns the prixods that BECAME FTL (`xmax = 0` = the row was inserted): a
 * row that was already FTL from an earlier deal is re-pointed at this one but
 * is no change of mode — counting or auditing it would say «ltl → ftl» about
 * a prixod that was FTL all along.
 */
function inheritSql(
  scope: SQL,
  opts: { actorId: string | null; lockedSellers: readonly string[] | null; presser: FtlDoor | null },
): SQL {
  const pin =
    opts.lockedSellers === null
      ? sql`true`
      : opts.lockedSellers.length === 0
        ? sql`r.sales_manager_id IS NULL`
        : sql`(r.sales_manager_id IS NULL OR r.sales_manager_id IN (${ids(opts.lockedSellers)}))`;
  const pressed =
    opts.presser === null || opts.presser.office ? sql`true` : sql`r.sales_manager_id = ${opts.presser.actorId}::uuid`;
  return sql`
    INSERT INTO receipt_load_mode (receipt_id, mode, hand, from_deal_id, set_by)
    SELECT r.id, 'ftl', false, d.id, ${opts.actorId}::uuid
      FROM receipts r
      JOIN deals d ON d.id = r.deal_id AND d.client_id = r.client_id
      JOIN deal_ftl df ON df.deal_id = d.id
     WHERE ${scope}
       AND (df.by_office OR r.sales_manager_id = df.marked_by)
       AND ${pressed}
       AND NOT EXISTS (SELECT 1 FROM receipt_load_mode h WHERE h.receipt_id = r.id AND h.hand)
       AND NOT ${kpiPaidMonthSql('r')}
       AND ${pin}
    ON CONFLICT (receipt_id) DO UPDATE
       SET mode = 'ftl', from_deal_id = EXCLUDED.from_deal_id, set_by = EXCLUDED.set_by, set_at = now()
     WHERE NOT receipt_load_mode.hand
    RETURNING receipt_id, from_deal_id::text AS from_deal_id, (xmax = 0) AS inserted`;
}

/**
 * Run the inheritance and write the one history line every door owes a
 * prixod whose KPI mode it changed (the cascade, the confirm, a re-file, the
 * stamping): «why did my kub drop» is read off the prixod's own history.
 */
async function inheritTx(
  tx: Tx,
  scope: SQL,
  opts: { lockedSellers: readonly string[] | null; presser: FtlDoor | null },
  ctx: AuditContext,
): Promise<string[]> {
  const rows = (await tx.execute(
    inheritSql(scope, { actorId: ctx.actorId ?? null, lockedSellers: opts.lockedSellers, presser: opts.presser }),
  )) as unknown as { receipt_id: string; from_deal_id: string; inserted: boolean }[];
  const fresh = [...rows].filter((row) => row.inserted);
  for (const row of fresh) {
    await writeAudit(tx, ctx, {
      entityType: 'receipt',
      entityId: row.receipt_id,
      action: 'update',
      before: { freightMode: 'ltl' },
      after: { freightMode: 'ftl', deal: row.from_deal_id },
    });
  }
  return fresh.map((row) => row.receipt_id);
}

/**
 * A prixod that just got its deal — the confirm's INSERT or a re-file —
 * inherits that deal's FTL in the same transaction, when the PRESSER may
 * reach it (above). The confirm passes no lock: a new prixod can never land
 * in a PAID month (the office back-dates at most 7 days and a month closes on
 * the 8th), so the freeze clause is a belt only there. A re-file takes the
 * stamp's lock first and passes it. True when the prixod became FTL.
 */
export async function inheritFromDealTx(
  tx: Tx,
  receiptId: string,
  presser: FtlDoor,
  lockedSellers: readonly string[] | null,
  ctx: AuditContext,
): Promise<boolean> {
  const fresh = await inheritTx(tx, sql`r.id = ${receiptId}::uuid`, { lockedSellers, presser }, ctx);
  return fresh.length > 0;
}

/**
 * Cargo that has just been STAMPED to a seller (`stampUnattributedCargo`:
 * the client got its first seller after the cargo came) takes that seller's
 * own FTL mark now — while the stamp was empty the mark could not reach it,
 * and the day the client is named the whole-truck job must not enter his KPI
 * as LTL. The caller holds the seller's KPI lock and passes it.
 */
export async function inheritStampedTx(
  tx: Tx,
  receiptIds: readonly string[],
  sellerId: string,
  ctx: AuditContext,
): Promise<number> {
  if (receiptIds.length === 0) return 0;
  const fresh = await inheritTx(tx, sql`r.id IN (${ids(receiptIds)})`, { lockedSellers: [sellerId], presser: null }, ctx);
  return fresh.length;
}

/**
 * A CLIENT correction (`assignReceiptClient`, A → B) takes back the FTL the
 * old client's job gave the prixod, and a seller's own hand mark: both were
 * decided about the old client's cargo and its seller, and left standing they
 * would cut the NEW client's seller's KPI on a decision nobody made for his
 * job. The office's hand mark stays — it was a decision about this cargo, not
 * about whose it is. No freeze here: the correction itself moves the prixod
 * between sellers' months (0117's rule — the payout's netting absorbs it), so
 * the mode that leaves with the old job follows the same rule. The caller
 * holds both stamps' KPI locks. True when the prixod turned back to LTL.
 */
export async function dropFtlOnClientChangeTx(tx: Tx, receiptId: string, ctx: AuditContext): Promise<boolean> {
  const rows = (await tx.execute(sql`
    DELETE FROM receipt_load_mode rlm
     WHERE rlm.receipt_id = ${receiptId}::uuid AND rlm.mode = 'ftl' AND (NOT rlm.hand OR NOT rlm.by_office)
    RETURNING rlm.hand`)) as unknown as { hand: boolean }[];
  const [row] = [...rows];
  if (!row) return false;
  await writeAudit(tx, ctx, {
    entityType: 'receipt',
    entityId: receiptId,
    action: 'update',
    before: { freightMode: 'ftl' },
    after: { freightMode: 'ltl', freightModeReason: 'clientChanged' },
  });
  return true;
}

/** Why a cascade left a linked prixod as it was — named on the screen, never silent. */
export type CascadeSkip = 'kpi_paid' | 'hand' | 'other_seller' | 'no_seller' | 'other_client' | 'stamp_moved';
export const CASCADE_SKIPS: readonly CascadeSkip[] = ['kpi_paid', 'hand', 'other_seller', 'no_seller', 'other_client', 'stamp_moved'];

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
    changed = await inheritTx(tx, sql`r.deal_id = ${dealId}::uuid`, { lockedSellers: locked, presser: null }, ctx);
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
    for (const receiptId of changed) {
      await writeAudit(tx, ctx, {
        entityType: 'receipt',
        entityId: receiptId,
        action: 'update',
        before: { freightMode: 'ftl' },
        after: { freightMode: 'ltl', deal: dealId },
      });
    }
  }

  // What stayed, and why — read after the move, under the same locks. Every
  // row gets a reason (the last arm is the pin: a stamp that moved between the
  // read above and the write), so nothing reaches the screen as a silence and
  // LIMIT spends its slots only on real skips.
  const skipRows = (await tx.execute(
    ftl
      ? sql`
        SELECT r.id, r.number,
               CASE WHEN r.client_id IS DISTINCT FROM d.client_id THEN 'other_client'
                    WHEN h.hand THEN 'hand'
                    WHEN NOT df.by_office AND r.sales_manager_id IS NULL THEN 'no_seller'
                    WHEN NOT df.by_office AND r.sales_manager_id IS DISTINCT FROM df.marked_by THEN 'other_seller'
                    WHEN ${kpiPaidMonthSql('r')} THEN 'kpi_paid'
                    ELSE 'stamp_moved'
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
        SELECT r.id, r.number,
               CASE WHEN ${kpiPaidMonthSql('r')} THEN 'kpi_paid' ELSE 'stamp_moved' END AS why
          FROM receipt_load_mode rlm JOIN receipts r ON r.id = rlm.receipt_id
         WHERE rlm.from_deal_id = ${dealId}::uuid AND NOT rlm.hand AND rlm.mode = 'ftl'
         ORDER BY r.number NULLS LAST
         LIMIT ${SKIP_LIMIT}`,
  )) as unknown as { id: string; number: string | null; why: CascadeSkip }[];

  return {
    changed: changed.length,
    skipped: [...skipRows].map((row) => ({ receiptId: row.id, number: row.number, why: row.why })),
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
      INSERT INTO receipt_load_mode (receipt_id, mode, hand, by_office, from_deal_id, set_by)
      VALUES (${receiptId}::uuid, ${mode}, true, ${door.office}, NULL, ${door.actorId}::uuid)
      ON CONFLICT (receipt_id) DO UPDATE
         SET mode = EXCLUDED.mode, hand = true, by_office = EXCLUDED.by_office, from_deal_id = NULL,
             set_by = EXCLUDED.set_by, set_at = now()`);
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
 *
 * FTL pressed on a deal that is ALREADY FTL is the office taking the mark as
 * its own: a seller's mark reaches only his own stamp, so the colleagues' and
 * the unstamped cargo of that whole-truck job stayed LTL, and so did a prixod
 * filed onto it by somebody the confirm/re-file door would not let reach it.
 * The mark becomes the office's and the inheritance runs again over the deal
 * (no revert step — nothing is taken back). Unchanged when the mark already
 * was the office's and nothing new was reached.
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
    const [mark] = (await tx.execute(sql`
      SELECT by_office FROM deal_ftl WHERE deal_id = ${dealId}::uuid`)) as unknown as { by_office: boolean }[];
    const before = mark !== undefined;
    const after = mode === 'ftl';
    if (!before && !after) return { changed: false, cascade: null };
    const cascade = await setDealFtlTx(tx, dealId, after, { actorId: door.actorId, office: true }, ctx);
    const widened = before && after;
    if (widened && mark!.by_office && cascade.changed === 0) return { changed: false, cascade };
    await writeAudit(tx, ctx, {
      entityType: 'deal',
      entityId: dealId,
      action: 'update',
      before: { freightMode: before ? 'ftl' : 'ltl', ...(widened ? { freightModeBy: mark!.by_office ? 'office' : 'seller' } : {}) },
      after: { freightMode: mode, ...(widened ? { freightModeBy: 'office' } : {}) },
    });
    return { changed: true, cascade };
  });
}

/**
 * Exactly the people the door calls the office (`mayRevertFtl`): holders of
 * one of `FTL_OFFICE_PERMISSIONS` with no warehouse-scoped role (actorGrants'
 * rule — any scoped role scopes the person). Permission codes, never role
 * names (#170): a role he gives «Rejalar» on /admin/roles hears of a seller's
 * mark it may take back, a logist whose grant was unticked does not.
 */
export async function ftlOfficeUsers(): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT ur.user_id::text AS id
      FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      JOIN users u ON u.id = ur.user_id
     WHERE p.code IN (${sql.join(FTL_OFFICE_PERMISSIONS.map((code) => sql`${code}`), sql`, `)})
       AND ${canLogInSql('u')}
       AND NOT EXISTS (
         SELECT 1 FROM user_roles sur JOIN roles sr ON sr.id = sur.role_id
          WHERE sur.user_id = ur.user_id AND sr.warehouse_scoped)`)) as unknown as { id: string }[];
  return [...rows].map((row) => row.id);
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
  const office = await ftlOfficeUsers();
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
