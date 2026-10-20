import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { logger } from '../../platform/logger';
import { logistsForTruck } from '../../platform/notifications/service';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { batchLots } from '../batches/lots';
import { phonesMatch } from '../client-cabinet/service';
import { batchCarriageOf } from '../costing/service';
import { markingOfCode } from '../pickups/owner-match';
import { isContinuationTrip } from '../reports/dashboard-math';
import { kpiPaidMonthSql } from '../staff/kpi-lock';
import { ftlHintText, type HintReceipt } from './hint-text';
import { ftlReady } from './service';
import { soleOwnerOf } from './sole-owner';

/**
 * The logist's hint (0135, the owner's 7a): a truck left carrying ONE
 * client's cargo only — «Bu FTL bo'lishi mumkin — tekshiring».
 *
 * WHEN: after `departBatch` COMMITS — departure is one door, pressed once, and
 * final (a departed truck cannot be cancelled), while «yuklash tugadi» can be
 * pressed again and scans can still change the cargo after it. Never in the
 * event drain (order-dependent across the suite's files).
 *
 * WHICH TRUCKS: every one that is not a «davomi» — a continuation's cargo was
 * priced on an earlier truck, which is where its hint was. NO internal-leg
 * skip: Yiwu → Kashgar is CN → CN and it is exactly the truck a whole-truck
 * job leaves China on (his 21a: every China truck unloads at Kashgar or
 * Horgos), so skipping it would make the hint arrive after the month closes.
 *
 * WHAT IT NAMES: the owner's prixods aboard that are LTL and can still change —
 * not frozen by a paid month (his 6a), not pinned LTL by the office's own hand —
 * and only if at least one was not named by an earlier hint (the Kashgar truck
 * must not repeat Yiwu's message). Nothing to name = silence.
 *
 * WHO: the logists who can open the truck (`logistsForTruck`, his «logistga»);
 * the presser is not excluded — he did not cause the one-client truck.
 *
 * The cheap test first: `batchLots` and the pure `soleOwnerOf` decide most
 * trucks (every multi-client one) before anything else is read. Failure is
 * logged and never fails the departure.
 */
export async function notifyFtlSuspected(batchId: string): Promise<void> {
  try {
    if (!(await ftlReady())) return;
    const lots = await batchLots(batchId);
    if (lots.length === 0) return;

    const claimedIds = [...new Set(lots.map((lot) => lot.clientId).filter((id): id is string => !!id))];
    const phones = new Map<string, string[]>();
    if (claimedIds.length > 1) {
      const rows = (await db.execute(sql`
        SELECT id::text AS id, phones FROM clients
         WHERE id IN (${sql.join(claimedIds.map((id) => sql`${id}::uuid`), sql`, `)})`)) as unknown as {
        id: string;
        phones: unknown;
      }[];
      for (const row of rows) {
        phones.set(row.id, Array.isArray(row.phones) ? row.phones.filter((p): p is string => typeof p === 'string') : []);
      }
    }
    // An all-unclaimed truck names its owner by the markings' code prefixes.
    const markingOwners = new Map<string, { clientId: string; clientCode: string } | null>();
    if (claimedIds.length === 0) {
      for (const marking of new Set(lots.map((lot) => lot.marking).filter((m): m is string => !!m))) {
        const rows = (await db.execute(sql`
          SELECT id::text AS id, client_code FROM clients
           WHERE active AND upper(btrim(${marking})) LIKE upper(btrim(client_code)) || '%'`)) as unknown as {
          id: string;
          client_code: string;
        }[];
        const owners = [...rows].filter((row) => markingOfCode(marking, row.client_code));
        markingOwners.set(marking, owners.length === 1 ? { clientId: owners[0]!.id, clientCode: owners[0]!.client_code } : null);
      }
    }

    const owner = soleOwnerOf(lots, {
      samePerson: (a, b) => (phones.get(a) ?? []).some((p) => (phones.get(b) ?? []).some((q) => phonesMatch(p, q))),
      markingOf: markingOfCode,
      markingOwner: (marking) => markingOwners.get(marking) ?? null,
    });
    if (!owner) return;
    if (isContinuationTrip(await batchCarriageOf(batchId))) return;

    // The owner's prixods aboard, and which of them can still be decided.
    const receiptIds = [...new Set(lots.map((lot) => lot.receiptId))];
    const states = (await db.execute(sql`
      SELECT r.id::text AS id, coalesce(rlm.mode, 'ltl') AS mode, coalesce(rlm.hand, false) AS hand,
             ${kpiPaidMonthSql('r')} AS paid, u.full_name AS seller
        FROM receipts r
        LEFT JOIN receipt_load_mode rlm ON rlm.receipt_id = r.id
        LEFT JOIN users u ON u.id = r.sales_manager_id
       WHERE r.id IN (${sql.join(receiptIds.map((id) => sql`${id}::uuid`), sql`, `)})`)) as unknown as {
      id: string;
      mode: string;
      hand: boolean;
      paid: boolean;
      seller: string | null;
    }[];
    const open = new Set([...states].filter((s) => s.mode === 'ltl' && !s.hand && !s.paid).map((s) => s.id));
    if (open.size === 0) return;
    const named = (await db.execute(sql`
      SELECT DISTINCT jsonb_array_elements_text(n.payload->'receiptIds') AS id
        FROM notifications n
       WHERE n.type = 'FtlSuspected'
         AND n.payload->'receiptIds' ?| ARRAY[${sql.join([...open].map((id) => sql`${id}`), sql`, `)}]::text[]`)) as unknown as {
      id: string;
    }[];
    const already = new Set([...named].map((row) => row.id));
    if ([...open].every((id) => already.has(id))) return;

    const [batch] = (await db.execute(sql`
      SELECT b.code, b.origin_warehouse_id::text AS origin, b.dest_warehouse_id::text AS dest,
             (SELECT lp.max_m3::float8 FROM load_plans lp WHERE lp.batch_id = b.id LIMIT 1) AS plan_m3
        FROM batches b WHERE b.id = ${batchId}::uuid`)) as unknown as {
      code: string;
      origin: string;
      dest: string;
      plan_m3: number | null;
    }[];
    if (!batch) return;
    const [deal] = (await db.execute(sql`
      SELECT d.code FROM deals d
        JOIN deal_ftl df ON df.deal_id = d.id
        JOIN deal_stages s ON s.id = d.stage_id AND s.kind = 'open'
       WHERE d.client_id IN (${sql.join(owner.map((id) => sql`${id}::uuid`), sql`, `)})
       ORDER BY d.created_at DESC LIMIT 1`)) as unknown as { code: string }[];

    const byReceipt = new Map<string, HintReceipt>();
    for (const lot of lots) {
      if (!open.has(lot.receiptId)) continue;
      const row = byReceipt.get(lot.receiptId) ?? { number: lot.receiptNumber, dealCode: lot.dealCode, m3: 0, kg: 0 };
      row.m3 += lot.m3;
      row.kg += lot.kg;
      byReceipt.set(lot.receiptId, row);
    }
    const first = lots.find((lot) => lot.clientId) ?? lots[0]!;
    const userIds = await logistsForTruck(batch.origin, batch.dest);
    if (userIds.length === 0) return;
    await notifyStaffTelegram({
      userIds,
      type: 'FtlSuspected',
      exceptUserId: null,
      text: ftlHintText({
        batchCode: batch.code,
        clientCode: first.clientCode ?? (first.marking ? markingOwners.get(first.marking)?.clientCode ?? null : null),
        clientName: first.clientName,
        sellerNames: [...new Set([...states].map((s) => s.seller).filter((s): s is string => !!s))],
        boxes: lots.reduce((sum, lot) => sum + lot.onBatch, 0),
        m3: lots.reduce((sum, lot) => sum + lot.m3, 0),
        kg: lots.reduce((sum, lot) => sum + lot.kg, 0),
        planM3: batch.plan_m3,
        receipts: [...byReceipt.values()],
        ftlDealCode: deal?.code ?? null,
        link: `${process.env.APP_URL ?? ''}/batches/${batchId}`,
      }),
      // The prixods this message named, so the next leg of the same cargo stays quiet.
      extra: { receiptIds: [...open], batchId },
    });
  } catch (err) {
    logger.error({ err, batchId }, '[ftl-hint] departure hint failed');
  }
}
