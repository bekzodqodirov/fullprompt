import { DOC } from './labels';
import { asc, eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { db } from '../../platform/db/client';
import {
  batches,
  boxes,
  clients,
  crates,
  receiptLots,
  receipts,
  warehouses,
} from '../../platform/db/schema';
import { batchMemberFilter } from '../scanning/unload';

/**
 * Actual manifest XLSX (W4/spec 6.4): what really departed — per-box list with
 * crate membership and on-spot flags, plus a per-lot summary. Generated from
 * box state, not the plan (the plan is intent; the manifest is fact).
 */
export async function buildManifestXlsx(batchId: string): Promise<Buffer | null> {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return null;
  const [origin, dest] = await Promise.all([
    db.query.warehouses.findFirst({ where: eq(warehouses.id, batch.originWarehouseId) }),
    db.query.warehouses.findFirst({ where: eq(warehouses.id, batch.destWarehouseId) }),
  ]);

  const rows = await db
    .select({
      box: boxes,
      lot: receiptLots,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
      crateCode: crates.code,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .leftJoin(crates, eq(boxes.crateId, crates.id))
    // "What really departed" — which the live pointer cannot say once
    // unloading starts clearing it box by box (same fix as ved-xlsx.ts).
    .where(batchMemberFilter(batchId))
    .orderBy(asc(receiptLots.letter), asc(boxes.seqInLot));

  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet(DOC.sheetSummary);
  summary.columns = [
    { header: DOC.code, key: 'code', width: 14 },
    { header: DOC.product, key: 'product', width: 40 },
    { header: DOC.boxes, key: 'boxCount', width: 10 },
    { header: DOC.kg, key: 'kg', width: 12 },
    { header: DOC.m3, key: 'm3', width: 10 },
  ];
  const detail = workbook.addWorksheet(DOC.sheetBoxes);
  detail.columns = [
    { header: '№', key: 'n', width: 6 },
    { header: DOC.barcode, key: 'shortCode', width: 16 },
    { header: DOC.code, key: 'code', width: 14 },
    { header: DOC.product, key: 'product', width: 36 },
    { header: DOC.crate, key: 'crate', width: 16 },
    { header: DOC.offPlan, key: 'onSpot', width: 10 },
  ];

  const header = `Партия ${batch.code} · ${origin?.code} → ${dest?.code}` +
    (batch.vehiclePlate ? ` · ${batch.vehiclePlate}` : '') +
    (batch.driverName ? ` · ${batch.driverName}${batch.driverPhone ? ` (${batch.driverPhone})` : ''}` : '') +
    (batch.departedAt ? ` · ${batch.departedAt.toISOString().slice(0, 10)}` : '');
  for (const sheet of [summary, detail]) {
    sheet.insertRow(1, [header]);
    sheet.getRow(1).font = { bold: true, size: 13 };
    sheet.getRow(2).font = { bold: true };
  }

  const byLot = new Map<string, { code: string; product: string; boxCount: number; kg: number; m3: number }>();
  let n = 0;
  for (const { box, lot, clientCode, marking, crateCode } of rows) {
    n += 1;
    const code = `${clientCode ?? marking ?? '?'}-${lot.letter ?? ''}`;
    const product = `${lot.productNameZh}${lot.productNameRu ? ` (${lot.productNameRu})` : ''}`;
    detail.addRow({
      n,
      shortCode: box.shortCode,
      code,
      product,
      crate: crateCode ?? '',
      onSpot: box.flags && Array.isArray(box.flags) && box.flags.includes('added_on_spot') ? '⚠' : '',
    });
    const agg = byLot.get(lot.id) ?? { code, product, boxCount: 0, kg: 0, m3: 0 };
    agg.boxCount += 1;
    agg.kg += Number(lot.totalWeightKg) / lot.boxCount;
    agg.m3 += Number(lot.totalVolumeM3) / lot.boxCount;
    byLot.set(lot.id, agg);
  }
  let totalKg = 0;
  let totalM3 = 0;
  for (const agg of byLot.values()) {
    summary.addRow({
      code: agg.code,
      product: agg.product,
      boxCount: agg.boxCount,
      kg: Math.round(agg.kg * 10) / 10,
      m3: Math.round(agg.m3 * 1000) / 1000,
    });
    totalKg += agg.kg;
    totalM3 += agg.m3;
  }
  const totalRow = summary.addRow({
    code: DOC.total,
    product: '',
    boxCount: n,
    kg: Math.round(totalKg * 10) / 10,
    m3: Math.round(totalM3 * 1000) / 1000,
  });
  totalRow.font = { bold: true };

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
