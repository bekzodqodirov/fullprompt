import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { boxes, clients, lotChecks, receiptLots, receipts, warehouses } from '@/modules/platform/db/schema';
import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';
import { warehouseScope } from '@/modules/platform/rbac/scope';
import { arrivalCodesForPairs } from '@/modules/wms/documents/arrivals';
import { buildStockXlsx } from '@/modules/wms/reports/stock-xlsx';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { stockTextWhere } from '@/modules/wms/inventory/stock-filter';
import {
  askableSql,
  checkFilterSql,
  lotCheckStateOrNullSql,
  readCheckFilter,
  withLotCheckJoins,
  type LotCheckState,
} from '@/modules/wms/receipts/lot-check-sql';
import { lotChecksReady } from '@/modules/wms/receipts/lot-check-ready';

/**
 * Stock report XLSX (spec §9/§13 report 1) with the current stock-browser
 * filter applied. Download-only (owner's answer Q6) — official archived
 * reports arrive with M6.
 *
 * Round 57: it also takes the screen's `cols`, so a saved view downloads as
 * itself. THREE columns are export-only and do NOT follow the screen: «days
 * in stock», XYZ and the PHOTOGRAPHS, all three because a sheet is read at a
 * desk where those questions get asked.
 *
 * The photograph followed the screen's tick for one commit and that was
 * wrong: the tick exists to keep a phone-width table readable (round 68), and
 * `/stock` redirects a bare visit to a saved default view — so one view saved
 * without 📷 made every Ostatka download photoless, silently, for ever. The
 * owner reported it the same day («excel fileda hech qanday rasim
 * korinmadi»). The gate now lives nowhere; `stock-xlsx` says why.
 *
 * This handler stays the DOOR: permission, filter, query, audit, filename.
 * The sheet itself is built by `wms/reports/stock-xlsx`, because a builder
 * living inside a route handler cannot be imported and therefore cannot be
 * measured — every other xlsx in this codebase is tested by reading its bytes
 * back.
 */
export async function GET(request: Request) {
  let actor;
  try {
    actor = await requireActor();
  } catch (err) {
    if (err instanceof AuthError) return new Response('Unauthorized', { status: 401 });
    throw err;
  }

  const url = new URL(request.url);
  const wh = url.searchParams.get('wh') ?? '';
  const q = url.searchParams.get('q') ?? '';
  // The screen's check filter, read by the same rule (#514): anything else is dropped.
  const tek = readCheckFilter(url.searchParams.get('tek'));

  // Match the stock browser: everything physically in the warehouse,
  // including planned/loading reservations and ready_for_pickup boxes.
  const filters: SQL[] = [
    inArray(boxes.status, ['in_stock', 'planned', 'loading', 'ready_for_pickup']),
  ];
  const scope = warehouseScope(actor, boxes.currentWarehouseId);
  if (scope) filters.push(scope);
  if (wh) filters.push(eq(boxes.currentWarehouseId, wh));
  // The screen's own predicate (#513).
  if (q) filters.push(stockTextWhere(q));
  // …and the check's one sentence (lot-check-sql.ts), so the file is the
  // screen: the same joins, the same filter after grouping, and the same
  // pre-0123 shape when the migration has not landed (#472).
  const checksOn = await lotChecksReady();
  const checkTek = checksOn ? tek : null;
  const checkState = lotCheckStateOrNullSql(checksOn, {
    lot: sql`${receiptLots}`,
    receipt: sql`${receipts}`,
    check: sql`${lotChecks}`,
  });
  const askable = askableSql(sql`${warehouses}`);

  const linesQuery = db
    .select({
      lot: receiptLots,
      receivedAt: receipts.receivedAt,
      marking: receipts.unclaimedMarking,
      whCode: warehouses.code,
      whId: warehouses.id,
      clientCode: clients.clientCode,
      inStock: sql<number>`count(*)`,
      // Aggregates, so the GROUP BY stays as it was: one lot, one prixod and
      // one warehouse per group answer one state.
      check: sql<LotCheckState>`min(${checkState})`,
      askable: sql<boolean>`bool_and(${askable})`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .innerJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .$dynamic();
  const lines = await withLotCheckJoins(linesQuery, checksOn)
    .where(and(...filters))
    .groupBy(
      receiptLots.id,
      receipts.receivedAt,
      receipts.unclaimedMarking,
      warehouses.id,
      warehouses.code,
      clients.clientCode,
    )
    .having(checkTek ? checkFilterSql(checkTek, sql`min(${checkState})`, sql`bool_and(${askable})`) : undefined)
    .orderBy(asc(warehouses.code), asc(receipts.receivedAt))
    .limit(10_000);

  // The screen's partiya column, from the same one home (round 92's rule).
  const arrivalCodes = await arrivalCodesForPairs(
    lines.map((line) => ({ lotId: line.lot.id, warehouseId: line.whId })),
  );

  // The screen's own column set, resolved by the shared helper. `whCode` is
  // written first here whatever the screen's order: a stock sheet is read
  // warehouse by warehouse and always has been.
  const { buffer, visible, photos, photosSkipped } = await buildStockXlsx({
    lines,
    arrivalCodes,
    cols: url.searchParams.get('cols') ?? undefined,
    locale: actor.locale,
    can: (permission) => actor.permissions.has(permission),
  });

  const meta = await requestMeta();
  await writeAudit(db, { actorId: actor.id, ...meta, warehouseId: wh || null }, {
    entityType: 'report',
    entityId: '00000000-0000-0000-0000-000000000002',
    action: 'export',
    after: {
      report: 'stock_xlsx',
      wh: wh || null,
      q: q || null,
      tek: checkTek,
      rows: lines.length,
      cols: [...visible].join(','),
      // How big the file actually was. `cols` says «photo» whether the sheet
      // carried one picture or three thousand, and the pictures are the whole
      // cost of this download.
      photos,
      photosSkipped,
    },
  });

  const stamp = tashkentDay();
  // Buffer -> Uint8Array: the builder hands back a node Buffer (what every
  // other xlsx module in this codebase returns) and the web Response type
  // does not accept one directly.
  return new Response(new Uint8Array(buffer), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="stock-${stamp}.xlsx"`,
    },
  });
}
