import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { isServerBehind } from '../../platform/db/errors';
import { logger } from '../../platform/logger';
import { kpiPaidMonthSql } from '../staff/kpi-lock';
import { receivedMonthSql } from '../staff/cargo';
import { ftlReady } from './service';
import type { LoadMode } from './sql';

/**
 * What the SCREENS read about LTL / FTL (0135). Every reader answers «not
 * there yet» (null / empty) one migration behind instead of throwing (#472):
 * the cards and the boards must never break because a side table is missing,
 * and «nothing known» draws as LTL — the default — with the controls hidden.
 */

async function guarded<T>(fallback: T, read: () => Promise<T>, what: string): Promise<T> {
  if (!(await ftlReady())) return fallback;
  try {
    return await read();
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err }, `[ftl] ${what}: server behind`);
    return fallback;
  }
}

/** The lead's / deal's mode, or null when the server is behind. */
export async function leadLoadMode(leadId: string): Promise<LoadMode | null> {
  return guarded<LoadMode | null>(null, async () => {
    const rows = (await db.execute(sql`SELECT 1 FROM lead_ftl WHERE lead_id = ${leadId}::uuid`)) as unknown as unknown[];
    return [...rows].length > 0 ? 'ftl' : 'ltl';
  }, 'lead mode');
}

export async function dealLoadMode(dealId: string): Promise<LoadMode | null> {
  return guarded<LoadMode | null>(null, async () => {
    const rows = (await db.execute(sql`SELECT 1 FROM deal_ftl WHERE deal_id = ${dealId}::uuid`)) as unknown as unknown[];
    return [...rows].length > 0 ? 'ftl' : 'ltl';
  }, 'deal mode');
}

const idList = (ids: readonly string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);

/** Which of these leads / deals are FTL — one read per board, never one per card (#432). */
export async function ftlLeadIds(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  return guarded(new Set<string>(), async () => {
    const rows = (await db.execute(sql`SELECT lead_id::text AS id FROM lead_ftl WHERE lead_id IN (${idList(ids)})`)) as unknown as {
      id: string;
    }[];
    return new Set([...rows].map((row) => row.id));
  }, 'board leads');
}

export async function ftlDealIds(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  return guarded(new Set<string>(), async () => {
    const rows = (await db.execute(sql`SELECT deal_id::text AS id FROM deal_ftl WHERE deal_id IN (${idList(ids)})`)) as unknown as {
      id: string;
    }[];
    return new Set([...rows].map((row) => row.id));
  }, 'board deals');
}

/**
 * Everything the prixod card says about its mode — and why. The SOURCE is
 * worked out from the stored row and the deal as it stands now, so the
 * sentence never claims «from the deal» about a prixod with no deal, or about
 * one re-filed from an FTL deal onto an LTL one.
 */
export interface ReceiptLoadView {
  mode: LoadMode;
  source:
    | 'hand'
    /** Inherited from the deal it is on now. */
    | 'deal'
    /** Inherited from a deal it has since left (a re-file never downgrades). */
    | 'earlier_deal'
    /** No row and no FTL deal: the default. */
    | 'default'
    /** No row, the deal IS FTL, but the mark did not reach this prixod — `notReached` says why. */
    | 'not_reached';
  /**
   * Why an FTL deal's mark stopped short of this prixod (source `not_reached`):
   * it now belongs to another client; its month is paid; the mark is a
   * seller's and the prixod is stamped to nobody or to a colleague; or it was
   * filed onto the deal by somebody whose press may not reach it (`linked` —
   * the office confirms the mark and it passes).
   */
  notReached: 'other_client' | 'kpi_paid' | 'no_seller' | 'other_seller' | 'linked' | null;
  /** The deal's FTL mark is the office's (it reaches every prixod of the client). */
  dealMarkByOffice: boolean;
  fromDealCode: string | null;
  deal: { id: string; code: string; ftl: boolean } | null;
  sellerId: string | null;
  /** The KPI month is PAID to its seller — frozen (his 6a). */
  paid: { month: string; sellerName: string | null } | null;
}

export async function receiptLoadView(receiptId: string): Promise<ReceiptLoadView | null> {
  return guarded<ReceiptLoadView | null>(null, async () => {
    const [row] = (await db.execute(sql`
      SELECT coalesce(rlm.mode, 'ltl') AS mode, rlm.hand, rlm.from_deal_id::text AS from_deal_id,
             fd.code AS from_deal_code,
             r.deal_id::text AS deal_id, d.code AS deal_code,
             (df.deal_id IS NOT NULL) AS deal_ftl, coalesce(df.by_office, false) AS deal_office,
             CASE WHEN df.deal_id IS NULL THEN NULL
                  WHEN r.client_id IS DISTINCT FROM d.client_id THEN 'other_client'
                  WHEN ${kpiPaidMonthSql('r')} THEN 'kpi_paid'
                  WHEN NOT df.by_office AND r.sales_manager_id IS NULL THEN 'no_seller'
                  WHEN NOT df.by_office AND r.sales_manager_id IS DISTINCT FROM df.marked_by THEN 'other_seller'
                  ELSE 'linked'
             END AS reach,
             r.sales_manager_id::text AS seller_id, u.full_name AS seller_name,
             ${receivedMonthSql(sql`r.received_at`)} AS month,
             ${kpiPaidMonthSql('r')} AS paid
        FROM receipts r
        LEFT JOIN receipt_load_mode rlm ON rlm.receipt_id = r.id
        LEFT JOIN deals fd ON fd.id = rlm.from_deal_id
        LEFT JOIN deals d ON d.id = r.deal_id
        LEFT JOIN deal_ftl df ON df.deal_id = r.deal_id
        LEFT JOIN users u ON u.id = r.sales_manager_id
       WHERE r.id = ${receiptId}::uuid`)) as unknown as {
      mode: LoadMode;
      hand: boolean | null;
      from_deal_id: string | null;
      from_deal_code: string | null;
      deal_id: string | null;
      deal_code: string | null;
      deal_ftl: boolean;
      deal_office: boolean;
      reach: NonNullable<ReceiptLoadView['notReached']> | null;
      seller_id: string | null;
      seller_name: string | null;
      month: string;
      paid: boolean;
    }[];
    if (!row) return null;
    const source: ReceiptLoadView['source'] = row.hand
      ? 'hand'
      : row.from_deal_id
        ? row.from_deal_id === row.deal_id
          ? 'deal'
          : 'earlier_deal'
        : row.deal_ftl
          ? 'not_reached'
          : 'default';
    return {
      mode: row.mode,
      source,
      notReached: source === 'not_reached' ? row.reach : null,
      dealMarkByOffice: row.deal_office,
      fromDealCode: row.from_deal_code,
      deal: row.deal_id ? { id: row.deal_id, code: row.deal_code ?? '—', ftl: row.deal_ftl } : null,
      sellerId: row.seller_id,
      paid: row.paid ? { month: row.month, sellerName: row.seller_name } : null,
    };
  }, 'receipt mode');
}
