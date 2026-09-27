import { DOC } from './labels';
import { and, asc, eq, inArray } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { db } from '../../platform/db/client';
import {
  batches,
  boxes,
  clients,
  crates,
  receiptLots,
  receipts,
  scanEvents,
  warehouses,
} from '../../platform/db/schema';
import { getSetting } from '../../platform/settings/service';
import { productKey, tnvedFor } from '../tnved/service';
import { batchMemberFilter } from '../scanning/unload';
import { tashkentDay } from '@/modules/platform/time/tashkent';

async function batchLines(batchId: string) {
  const rows = await db
    .select({
      boxId: boxes.id,
      lot: receiptLots,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
      liveCrateId: boxes.crateId,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    // Membership by what DEPARTED, not by the live pointer: unloading clears
    // `current_batch_id` box by box, so a customs document regenerated after
    // the truck reached the border came out EMPTY — and these are the papers
    // the export agent works from. Same predicate as costing (#121, #152).
    .where(batchMemberFilter(batchId))
    .orderBy(asc(receiptLots.letter), asc(boxes.seqInLot));
  // The crate a carton rode THIS truck in comes from this truck's own load
  // events, not from the live pointer — the manifest's rule: handing a
  // pallet over or dissolving it at the hub clears `crate_id`, and building
  // a new one there sets it, so an invoice re-downloaded later said 10 places
  // for what crossed as one, or 1 for what crossed as ten (review cargo-4).
  // A carton not loaded yet (the invoice drafted off the plan) has no event
  // and keeps its live crate.
  const events = rows.length
    ? await db
        .select({ boxId: scanEvents.boxId, crateId: scanEvents.crateId })
        .from(scanEvents)
        .where(and(eq(scanEvents.batchId, batchId), eq(scanEvents.type, 'load')))
        .orderBy(asc(scanEvents.createdAt), asc(scanEvents.id))
    : [];
  const rodeIn = new Map<string, string | null>();
  for (const event of events) rodeIn.set(event.boxId, event.crateId);
  const crateOf = (row: (typeof rows)[number]) =>
    rodeIn.has(row.boxId) ? rodeIn.get(row.boxId)! : row.liveCrateId;
  const crateIds = [...new Set(rows.map(crateOf).filter((id): id is string => id !== null))];
  const crateRows = crateIds.length
    ? await db
        .select({ id: crates.id, code: crates.code, kind: crates.kind })
        .from(crates)
        .where(inArray(crates.id, crateIds))
    : [];
  const crateById = new Map(crateRows.map((c) => [c.id, c]));
  return rows.map((row) => {
    const crate = crateOf(row);
    return {
      lot: row.lot,
      clientCode: row.clientCode,
      marking: row.marking,
      crateCode: crate ? (crateById.get(crate)?.code ?? null) : null,
      crateId: crate,
      crateKind: crate ? (crateById.get(crate)?.kind ?? null) : null,
    };
  });
}

/**
 * «Кол-во мест» per lot on the customs invoice (0112, the owner's Q2 = b):
 * ONLY a pallet is one place — a pallet goes through customs as one wrapped
 * unit, while a yashik or a karkas stays counted by the cartons inside it, as
 * it always has (changing those would renumber the papers of trucks already
 * on the road).
 *
 * A pallet can carry two lots of one client, and a place belongs to ONE line
 * of the invoice, so it goes to the lot holding most of its cartons, a tie
 * to the earlier letter. So the column sums to «loose cartons + one per
 * pallet» — the count the customs officer makes at the truck.
 */
export function invoicePlaces(
  rows: readonly {
    lotId: string;
    letter: string | null;
    crateId: string | null;
    crateKind: string | null;
  }[],
): Map<string, number> {
  const places = new Map<string, number>();
  const pallets = new Map<string, Map<string, { letter: string; n: number }>>();
  for (const row of rows) {
    if (row.crateId && row.crateKind === 'palet') {
      const byLot = pallets.get(row.crateId) ?? new Map<string, { letter: string; n: number }>();
      const entry = byLot.get(row.lotId) ?? { letter: row.letter ?? '', n: 0 };
      entry.n += 1;
      byLot.set(row.lotId, entry);
      pallets.set(row.crateId, byLot);
      places.set(row.lotId, places.get(row.lotId) ?? 0);
    } else {
      places.set(row.lotId, (places.get(row.lotId) ?? 0) + 1);
    }
  }
  for (const byLot of pallets.values()) {
    const [owner] = [...byLot.entries()].sort(
      ([, a], [, b]) => b.n - a.n || a.letter.localeCompare(b.letter),
    );
    if (owner) places.set(owner[0], (places.get(owner[0]) ?? 0) + 1);
  }
  return places;
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
      ` · ${tashkentDay()}`,
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

  // The office's day (R5) — the invoice number is built from it, so in UTC
  // an invoice made before 05:00 carried yesterday's number and date.
  const today = tashkentDay();
  const dateCompact = today.replaceAll('-', '');
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
  sheet.getCell('B4').value = today;
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
  const places = invoicePlaces(
    rows.map(({ lot, crateId, crateKind }) => ({ lotId: lot.id, letter: lot.letter, crateId, crateKind })),
  );
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
  for (const [lotId, agg] of byLot) {
    n += 1;
    rowNo += 1;
    const kg = Math.round(agg.kg * 10) / 10;
    const row = sheet.getRow(rowNo);
    // ТНВЭД prefills from memory (still editable in Excel); price stays for
    // the VED manager; measured weight goes into both netto and brutto —
    // netto is corrected by hand when the tare matters. Amount is live.
    const code = tnved.get(productKey(agg.nameZh))?.tnvedCode ?? '';
    row.values = [n, agg.product, code, 'кг', kg, places.get(lotId) ?? agg.boxCount, kg, kg, '', ''];
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
