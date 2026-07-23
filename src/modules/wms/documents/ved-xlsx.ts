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
import { getSetting } from '../../platform/settings/service';

async function batchLines(batchId: string) {
  return db
    .select({
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
    .where(eq(boxes.currentBatchId, batchId))
    .orderBy(asc(receiptLots.letter), asc(boxes.seqInLot));
}

async function header(sheet: ExcelJS.Worksheet, batchId: string, title: string) {
  const batch = (await db.query.batches.findFirst({ where: eq(batches.id, batchId) }))!;
  const [origin, dest] = await Promise.all([
    db.query.warehouses.findFirst({ where: eq(warehouses.id, batch.originWarehouseId) }),
    db.query.warehouses.findFirst({ where: eq(warehouses.id, batch.destWarehouseId) }),
  ]);
  const companyName = String(await getSetting('company_name'));
  const companyAddress = String(await getSetting('company_address'));
  const companyPhone = String(await getSetting('company_phone'));
  sheet.addRow([companyName]);
  sheet.getRow(1).font = { bold: true, size: 14 };
  sheet.addRow([`${companyAddress} · ${companyPhone}`]);
  sheet.addRow([
    `${title} · ${batch.code} · ${origin?.code} → ${dest?.code}` +
      (batch.vehiclePlate ? ` · ${batch.vehiclePlate}` : '') +
      ` · ${new Date().toISOString().slice(0, 10)}`,
  ]);
  sheet.getRow(3).font = { bold: true };
  sheet.addRow([]);
  return batch;
}

/**
 * Invoice DRAFT (W6, spec 6.6): rows from the actual manifest; price/amount
 * columns left blank for the VED manager to fill in Excel before sending —
 * the file is a draft, not a final document.
 */
export async function buildInvoiceXlsx(batchId: string): Promise<Buffer | null> {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return null;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Invoice');
  await header(sheet, batchId, 'INVOICE (draft)');

  const head = sheet.addRow(['№', 'Код', 'Описание товара', 'Кол-во кор.', 'Вес, кг', 'Цена/кг, USD', 'Сумма, USD']);
  head.font = { bold: true };
  sheet.columns = [
    { width: 5 }, { width: 14 }, { width: 44 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 14 },
  ];

  const rows = await batchLines(batchId);
  const byLot = new Map<string, { code: string; product: string; boxCount: number; kg: number }>();
  for (const { lot, clientCode, marking } of rows) {
    const agg = byLot.get(lot.id) ?? {
      code: `${clientCode ?? marking ?? '?'}-${lot.letter ?? ''}`,
      product: `${lot.productNameZh}${lot.productNameRu ? ` / ${lot.productNameRu}` : ''}`,
      boxCount: 0,
      kg: 0,
    };
    agg.boxCount += 1;
    agg.kg += Number(lot.totalWeightKg) / lot.boxCount;
    byLot.set(lot.id, agg);
  }
  let n = 0;
  let totalKg = 0;
  let totalBoxes = 0;
  for (const agg of byLot.values()) {
    n += 1;
    totalKg += agg.kg;
    totalBoxes += agg.boxCount;
    const row = sheet.addRow([n, agg.code, agg.product, agg.boxCount, Math.round(agg.kg * 10) / 10, '', '']);
    // Amount = price × kg, live formula so the VED manager only fills prices.
    row.getCell(7).value = { formula: `E${row.number}*F${row.number}` };
  }
  const total = sheet.addRow(['', 'ИТОГО', '', totalBoxes, Math.round(totalKg * 10) / 10, '', '']);
  total.font = { bold: true };
  total.getCell(7).value = {
    formula: `SUM(G${head.number + 1}:G${total.number - 1})`,
  };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Packing list DRAFT (W6): per lot/crate rows with boxes/kg/m³ + totals. */
export async function buildPackingXlsx(batchId: string): Promise<Buffer | null> {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return null;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Packing list');
  await header(sheet, batchId, 'PACKING LIST (draft)');

  const head = sheet.addRow(['№', 'Код', 'Товар', 'Упаковка', 'Кол-во кор.', 'Вес, кг', 'Объём, м³']);
  head.font = { bold: true };
  sheet.columns = [
    { width: 5 }, { width: 14 }, { width: 40 }, { width: 16 }, { width: 10 }, { width: 12 }, { width: 10 },
  ];

  const rows = await batchLines(batchId);
  const byKey = new Map<string, { code: string; product: string; pack: string; boxCount: number; kg: number; m3: number }>();
  for (const { lot, clientCode, marking, crateCode } of rows) {
    const key = `${lot.id}:${crateCode ?? ''}`;
    const agg = byKey.get(key) ?? {
      code: `${clientCode ?? marking ?? '?'}-${lot.letter ?? ''}`,
      product: `${lot.productNameZh}${lot.productNameRu ? ` / ${lot.productNameRu}` : ''}`,
      pack: crateCode ?? 'короб',
      boxCount: 0,
      kg: 0,
      m3: 0,
    };
    agg.boxCount += 1;
    agg.kg += Number(lot.totalWeightKg) / lot.boxCount;
    agg.m3 += Number(lot.totalVolumeM3) / lot.boxCount;
    byKey.set(key, agg);
  }
  let n = 0;
  let totalKg = 0;
  let totalM3 = 0;
  let totalBoxes = 0;
  for (const agg of byKey.values()) {
    n += 1;
    totalKg += agg.kg;
    totalM3 += agg.m3;
    totalBoxes += agg.boxCount;
    sheet.addRow([
      n, agg.code, agg.product, agg.pack, agg.boxCount,
      Math.round(agg.kg * 10) / 10, Math.round(agg.m3 * 1000) / 1000,
    ]);
  }
  const total = sheet.addRow([
    '', 'ИТОГО', '', '', totalBoxes, Math.round(totalKg * 10) / 10, Math.round(totalM3 * 1000) / 1000,
  ]);
  total.font = { bold: true };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
