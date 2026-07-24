import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { db } from '@/modules/platform/db/client';
import {
  boxes,
  clients,
  receiptLots,
  receipts,
  warehouses,
} from '@/modules/platform/db/schema';
import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';

/**
 * Stock report XLSX (spec §9/§13 report 1) with the current stock-browser
 * filter applied. Download-only (owner's answer Q6) — official archived
 * reports arrive with M6.
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
  if (actor.warehouseScoped && actor.warehouseIds.length) {
    filters.push(inArray(boxes.currentWarehouseId, actor.warehouseIds));
  }
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
      warehouses.code,
      clients.clientCode,
    )
    .orderBy(asc(warehouses.code), asc(receipts.receivedAt))
    .limit(10_000);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Stock');
  sheet.columns = [
    { header: 'Склад', key: 'wh', width: 8 },
    { header: 'Код', key: 'code', width: 14 },
    { header: 'Товар', key: 'product', width: 40 },
    { header: 'Коробок', key: 'boxCount', width: 10 },
    { header: 'кг/кор', key: 'perBoxKg', width: 10 },
    { header: 'Σ кг', key: 'totalKg', width: 10 },
    { header: 'м³', key: 'totalM3', width: 10 },
    { header: 'кг/м³', key: 'density', width: 10 },
    { header: 'Дней', key: 'aging', width: 8 },
    { header: 'Примечание', key: 'note', width: 30 },
    { header: 'Дата', key: 'date', width: 12 },
  ];
  sheet.getRow(1).font = { bold: true };

  const now = Date.now();
  for (const line of lines) {
    const perBoxKg = Number(line.lot.totalWeightKg) / line.lot.boxCount;
    const stockKg = perBoxKg * Number(line.inStock);
    const stockM3 = (Number(line.lot.totalVolumeM3) / line.lot.boxCount) * Number(line.inStock);
    const density =
      Number(line.lot.totalVolumeM3) > 0
        ? Number(line.lot.totalWeightKg) / Number(line.lot.totalVolumeM3)
        : null;
    sheet.addRow({
      wh: line.whCode,
      code: `${line.clientCode ?? line.marking ?? '?'}-${line.lot.letter ?? ''}`,
      product: `${line.lot.productNameZh}${line.lot.productNameRu ? ` (${line.lot.productNameRu})` : ''}`,
      boxCount: Number(line.inStock),
      perBoxKg: Math.round(perBoxKg * 10) / 10,
      totalKg: Math.round(stockKg * 10) / 10,
      totalM3: Math.round(stockM3 * 1000) / 1000,
      density: density === null ? '' : Math.round(density),
      aging: Math.floor((now - line.receivedAt.getTime()) / 86_400_000),
      note: line.lot.note ?? '',
      date: line.receivedAt.toISOString().slice(0, 10),
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const meta = await requestMeta();
  await writeAudit(db, { actorId: actor.id, ...meta, warehouseId: wh || null }, {
    entityType: 'report',
    entityId: '00000000-0000-0000-0000-000000000002',
    action: 'export',
    after: { report: 'stock_xlsx', wh: wh || null, q: q || null, rows: lines.length },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(buffer, {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="stock-${stamp}.xlsx"`,
    },
  });
}
