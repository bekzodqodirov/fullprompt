import { asc, eq, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { clients, crates, loadPlanLines, receiptLots, receipts } from '@/modules/platform/db/schema';
import { lotRuShownSql } from '../receipts/lot-name';

/**
 * What the plan's own screen (/plans/<id>) lists: ONE row per plan line — a
 * lot, never a good.
 *
 * The owner's answer of 2026-11-11 to «"yuklama" deganingiz — rejadagi "Agent
 * uchun Excel"?» was the star: only that FILE prints a row per good
 * (documents/agent-xlsx.ts); the screen keeps the lot whole and names it as
 * every list does — a standing tarkib's «first +N», else the lot's own
 * (receipts/lot-name.ts). The query lived inline in the page, where nothing
 * could ask it a question; here a test reads it (lot-name-warehouse.integration:
 * a lot with a three-line tarkib is one row named «Клавиатура +2»).
 *
 * It reads NAMES only. A screen under `planning/` may not read the tarkib's
 * lines — tests/unit/lot-composition-fence.test.ts — and has no reason to.
 */
export async function planLinesView(versionId: string) {
  return db
    .select({
      line: loadPlanLines,
      lot: receiptLots,
      // The Russian name as the lists show it (lot-name.ts): a standing
      // tarkib's «first +N», else the lot's own.
      shownNameRu: sql<string | null>`${lotRuShownSql(sql`${receiptLots}`)}`,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
      crateCode: crates.code,
    })
    .from(loadPlanLines)
    .innerJoin(receiptLots, eq(loadPlanLines.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .leftJoin(crates, eq(loadPlanLines.crateId, crates.id))
    .where(eq(loadPlanLines.versionId, versionId))
    .orderBy(asc(loadPlanLines.id));
}

export type PlanLineView = Awaited<ReturnType<typeof planLinesView>>[number];
