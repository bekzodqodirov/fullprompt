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
import { getSetting } from '../../platform/settings/service';
import { productKey, tnvedFor } from '../tnved/service';
import { batchMemberFilter } from '../scanning/unload';

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
    // Membership by what DEPARTED, not by the live pointer: unloading clears
    // `current_batch_id` box by box, so a customs document regenerated after
    // the truck reached the border came out EMPTY — and these are the papers
    // the export agent works from. Same predicate as costing (#121, #152).
    .where(batchMemberFilter(batchId))
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
 * INVOICE & PACKING LIST draft (W6) mirroring the owner's real ka23 invoice
 * file (feedback round 6): the same header block (Invoice №, date, container,
 * Sender / Seller / Consignee requisites from settings, transport + delivery
 * terms) and the same table columns incl. ТНВЭД. Prices, ТНВЭД codes and the
 * netto correction are left for the VED manager; the amount column and totals
 * are live formulas.
 */
export async function buildInvoiceXlsx(batchId: string): Promise<Buffer | null> {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return null;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('invoice packinglist');
  sheet.columns = [
    { width: 4 }, { width: 46 }, { width: 13 }, { width: 8 }, { width: 11 },
    { width: 11 }, { width: 13 }, { width: 14 }, { width: 12 }, { width: 15 },
  ];

  const [sender, seller, consignee, transport, delivery, customsPost] = await Promise.all([
    getSetting('ved_sender'),
    getSetting('ved_seller'),
    getSetting('ved_consignee'),
    getSetting('ved_transport'),
    getSetting('ved_delivery_terms'),
    getSetting('ved_customs_post'),
  ]);

  const today = new Date();
  const dateCompact = today.toISOString().slice(0, 10).replaceAll('-', '');
  const setWrapped = (cell: string, value: string) => {
    sheet.getCell(cell).value = value;
    sheet.getCell(cell).alignment = { wrapText: true, vertical: 'top' };
  };

  sheet.mergeCells('B1:I1');
  sheet.getCell('B1').value = 'I N V O I C E  &  PACKING LIST';
  sheet.getCell('B1').font = { bold: true, size: 14 };
  sheet.getCell('B1').alignment = { horizontal: 'center' };

  sheet.getCell('A3').value = 'Invoice № :';
  sheet.getCell('B3').value = `${dateCompact}${batch.code.replace('-', '').toLowerCase()}`;
  sheet.getCell('A4').value = 'Date :';
  sheet.getCell('B4').value = today.toISOString().slice(0, 10);
  sheet.getCell('A5').value = '№ Контейнер /Container:';
  sheet.getCell('B5').value = batch.vehiclePlate ?? 'by track';

  sheet.getCell('A7').value = 'Отправитель/Sender:';
  sheet.mergeCells('B7:I8');
  setWrapped('B7', String(sender));
  sheet.getCell('A10').value = 'Seller/ Продавец:';
  sheet.mergeCells('B10:I11');
  setWrapped('B10', String(seller));
  sheet.getCell('A13').value = 'Получатель/Consignee:';
  sheet.mergeCells('B13:I15');
  setWrapped('B13', String(consignee));

  sheet.getCell('A17').value = 'Способ транспортировки:';
  sheet.getCell('B17').value = String(transport);
  sheet.getCell('H17').value = String(customsPost);
  sheet.getCell('A18').value = 'Условия поставки:';
  sheet.getCell('B18').value = String(delivery);

  const head = sheet.getRow(20);
  head.values = [
    '№', DOC.productName, DOC.hsCode, DOC.unit, DOC.quantity, DOC.places,
    DOC.netWeight, DOC.grossWeight, DOC.price, DOC.totalAmount,
  ];
  head.font = { bold: true };
  head.alignment = { wrapText: true, vertical: 'middle' };

  const rows = await batchLines(batchId);
  const byLot = new Map<string, { product: string; nameZh: string; boxCount: number; kg: number }>();
  for (const { lot } of rows) {
    const agg = byLot.get(lot.id) ?? {
      product: lot.productNameRu?.trim() || lot.productNameZh,
      nameZh: lot.productNameZh,
      boxCount: 0,
      kg: 0,
    };
    agg.boxCount += 1;
    agg.kg += Number(lot.totalWeightKg) / lot.boxCount;
    byLot.set(lot.id, agg);
  }
  // ТНВЭД memory (Phase 1.5): known products prefill; unknown stay blank.
  const tnved = await tnvedFor([...byLot.values()].map((a) => a.nameZh));

  let n = 0;
  let rowNo = head.number;
  for (const agg of byLot.values()) {
    n += 1;
    rowNo += 1;
    const kg = Math.round(agg.kg * 10) / 10;
    const row = sheet.getRow(rowNo);
    // ТНВЭД prefills from memory (still editable in Excel); price stays for
    // the VED manager; measured weight goes into both netto and brutto —
    // netto is corrected by hand when the tare matters. Amount is live.
    const code = tnved.get(productKey(agg.nameZh))?.tnvedCode ?? '';
    row.values = [n, agg.product, code, 'кг', kg, agg.boxCount, kg, kg, '', ''];
    row.getCell(10).value = { formula: `I${rowNo}*E${rowNo}` };
  }
  const total = sheet.getRow(rowNo + 1);
  total.font = { bold: true };
  total.getCell(6).value = { formula: `SUM(F${head.number + 1}:F${rowNo})` };
  total.getCell(7).value = { formula: `SUM(G${head.number + 1}:G${rowNo})` };
  total.getCell(8).value = { formula: `SUM(H${head.number + 1}:H${rowNo})` };
  total.getCell(10).value = { formula: `SUM(J${head.number + 1}:J${rowNo})` };

  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.font = { ...(cell.font ?? {}), name: 'Arial' };
    });
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Packing list DRAFT (W6): per lot/crate rows with boxes/kg/m³ + totals. */
export async function buildPackingXlsx(batchId: string): Promise<Buffer | null> {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return null;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Packing list');
  await header(sheet, batchId, 'PACKING LIST (draft)');

  const head = sheet.addRow(['№', DOC.code, DOC.product, DOC.packaging, DOC.boxes, DOC.weightKg, DOC.m3]);
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
    '', DOC.total, '', '', totalBoxes, Math.round(totalKg * 10) / 10, Math.round(totalM3 * 1000) / 1000,
  ]);
  total.font = { bold: true };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
