import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { boxes, clients, receiptLots, receipts, warehouses } from '@/modules/platform/db/schema';
import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';
import { warehouseScope } from '@/modules/platform/rbac/scope';
import { arrivalCodesForPairs } from '@/modules/wms/documents/arrivals';
import { buildStockXlsx } from '@/modules/wms/reports/stock-xlsx';

/**
 * Stock report XLSX (spec §9/§13 report 1) with the current stock-browser
 * filter applied. Download-only (owner's answer Q6) — official archived
 * reports arrive with M6.
 *
 * Round 57: it also takes the screen's `cols`, so a saved view downloads as
 * itself. Two columns are export-only and do NOT follow the screen: «days in
 * stock» and XYZ, both because a sheet is read at a desk where those
 * questions get asked. The photo used to be a third — «it has no spreadsheet
 * equivalent» — and the owner answered that (2026-09-19): it does, so it
 * follows the screen's own tick like every ordinary column.
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

  // Match the stock browser: everything physically in the warehouse,
  // including planned/loading reservations and ready_for_pickup boxes.
  const filters: SQL[] = [
    inArray(boxes.status, ['in_stock', 'planned', 'loading', 'ready_for_pickup']),
  ];
  const scope = warehouseScope(actor, boxes.currentWarehouseId);
  if (scope) filters.push(scope);
  if (wh) filters.push(eq(boxes.currentWarehouseId, wh));
  if (q) {
    filters.push(
      sql`(${clients.clientCode} ILIKE ${'%' + q + '%'} OR ${receiptLots.productNameZh} ILIKE ${'%' + q + '%'} OR ${receiptLots.productNameRu} ILIKE ${'%' + q + '%'} OR ${receipts.unclaimedMarking} ILIKE ${'%' + q + '%'})`,
    );
  }

  const lines = await db
    .select({
      lot: receiptLots,
      receivedAt: receipts.receivedAt,
      marking: receipts.unclaimedMarking,
      whCode: warehouses.code,
      whId: warehouses.id,
      clientCode: clients.clientCode,
      inStock: sql<number>`count(*)`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .innerJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(and(...filters))
    .groupBy(
      receiptLots.id,
      receipts.receivedAt,
      receipts.unclaimedMarking,
      warehouses.id,
      warehouses.code,
      clients.clientCode,
    )
    .orderBy(asc(warehouses.code), asc(receipts.receivedAt))
    .limit(10_000);

  // The screen's partiya column, from the same one home (round 92's rule).
  const arrivalCodes = await arrivalCodesForPairs(
    lines.map((line) => ({ lotId: line.lot.id, warehouseId: line.whId })),
  );

  // The screen's own column set, resolved by the shared helper. `whCode` is
  // written first here whatever the screen's order: a stock sheet is read
  // warehouse by warehouse and always has been.
  const { buffer, visible } = await buildStockXlsx({
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
      rows: lines.length,
      cols: [...visible].join(','),
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
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
