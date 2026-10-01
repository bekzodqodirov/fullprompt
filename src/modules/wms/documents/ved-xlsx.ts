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
import { cartonsBefore, compositionMode, paperLines } from '../receipts/composition-math';
import { lotTrucksFor, paperCompositionsFor } from '../receipts/lot-composition';
import {
  ESTIMATE_FILL,
  estimateNote,
  invoiceRowCells,
  packingBoxesCell,
  packingProductCell,
} from './composition-cells';
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
 *
 * The PARTS are the core (lot tarkibi, §4): a composed lot splits its loose
 * cartons and its pallets between its lines differently, so it needs them
 * apart; `invoicePlaces` is their sum and nothing else (one home).
 */
export function invoicePlaceParts(
  rows: readonly {
    lotId: string;
    letter: string | null;
    crateId: string | null;
    crateKind: string | null;
  }[],
): Map<string, { loose: number; pallets: number }> {
  const parts = new Map<string, { loose: number; pallets: number }>();
  const pallets = new Map<string, Map<string, { letter: string; n: number }>>();
  const partOf = (lotId: string) => {
    const p = parts.get(lotId) ?? { loose: 0, pallets: 0 };
    parts.set(lotId, p);
    return p;
  };
  for (const row of rows) {
    if (row.crateId && row.crateKind === 'palet') {
      const byLot = pallets.get(row.crateId) ?? new Map<string, { letter: string; n: number }>();
      const entry = byLot.get(row.lotId) ?? { letter: row.letter ?? '', n: 0 };
      entry.n += 1;
      byLot.set(row.lotId, entry);
      pallets.set(row.crateId, byLot);
      partOf(row.lotId);
    } else {
      partOf(row.lotId).loose += 1;
    }
  }
  for (const byLot of pallets.values()) {
    const [owner] = [...byLot.entries()].sort(
      ([, a], [, b]) => b.n - a.n || a.letter.localeCompare(b.letter),
    );
    if (owner) partOf(owner[0]).pallets += 1;
  }
  return parts;
}

export function invoicePlaces(
  rows: readonly {
    lotId: string;
    letter: string | null;
    crateId: string | null;
    crateKind: string | null;
  }[],
): Map<string, number> {
  const places = new Map<string, number>();
  for (const [lotId, p] of invoicePlaceParts(rows)) places.set(lotId, p.loose + p.pallets);
  return places;
}

/**
 * What every paper of THIS truck reads about its composed lots: the
 * composition (frozen while the truck is ticked «hujjat yuborildi») and the
 * cumulative offset of each lot's cartons on its earlier crossing trucks.
 */
async function paperContext(batchId: string, lotIds: string[]) {
  const [compositions, trucks] = await Promise.all([
    paperCompositionsFor(batchId, lotIds),
    lotTrucksFor(db, lotIds),
  ]);
  return {
    compositions,
    before: (lotId: string) => cartonsBefore(trucks.get(lotId) ?? [], batchId),
  };
}

const lotTotalsOf = (lot: typeof receiptLots.$inferSelect) => ({
  boxCount: lot.boxCount,
  kg: lot.totalWeightKg,
  m3: lot.totalVolumeM3,
});

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
  const placeRows = rows.map(({ lot, crateId, crateKind }) => ({ lotId: lot.id, letter: lot.letter, crateId, crateKind }));
  const places = invoicePlaces(placeRows);
  const placeParts = invoicePlaceParts(placeRows);
  const byLot = new Map<
    string,
    { lot: typeof receiptLots.$inferSelect; product: string; nameZh: string; boxCount: number; kg: number }
  >();
  for (const { lot } of rows) {
    const agg = byLot.get(lot.id) ?? {
      lot,
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
  // Lot tarkibi: a composed lot prints one row per line on this truck.
  const papers = await paperContext(batchId, [...byLot.keys()]);

  let n = 0;
  let rowNo = head.number;
  for (const [lotId, agg] of byLot) {
    const kg = Math.round(agg.kg * 10) / 10;
    const comp = papers.compositions.get(lotId);
    if (comp) {
      // The composed lot's rows: the line's own name and code (never the
      // memory's — a line has no memory key), netto = brutto = the line's
      // kg, which sum to exactly the single figure the lot printed before.
      const view = paperLines(comp, lotTotalsOf(agg.lot), {
        before: papers.before(lotId),
        cartons: agg.boxCount,
        kg,
        places: placeParts.get(lotId) ?? { loose: agg.boxCount, pallets: 0 },
      });
      for (const line of view.lines) {
        n += 1;
        rowNo += 1;
        const cells = invoiceRowCells(line);
        const row = sheet.getRow(rowNo);
        row.values = [n, cells.product, cells.code, cells.unit, cells.quantity, cells.places, cells.kg, cells.kg, '', ''];
        row.getCell(10).value = { formula: `I${rowNo}*E${rowNo}` };
        if (view.estimate) {
          row.getCell(2).note = estimateNote(view, agg.boxCount, agg.lot.boxCount);
          row.getCell(2).fill = ESTIMATE_FILL;
        }
      }
      continue;
    }
    n += 1;
    rowNo += 1;
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
  type Group = { lotId: string; code: string; product: string; pack: string; boxCount: number; kg: number; m3: number };
  const byKey = new Map<string, Group>();
  const lotsById = new Map<string, typeof receiptLots.$inferSelect>();
  for (const { lot, clientCode, marking, crateCode } of rows) {
    lotsById.set(lot.id, lot);
    const key = `${lot.id}:${crateCode ?? ''}`;
    const agg = byKey.get(key) ?? {
      lotId: lot.id,
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
  // Lot tarkibi: a composed lot collapses ALL its (lot, crate) groups into
  // one block of line rows — per-crate line rows would print a second, finer
  // estimate (deviation D5).
  const papers = await paperContext(batchId, [...lotsById.keys()]);
  const groupsOfLot = new Map<string, Group[]>();
  for (const agg of byKey.values()) groupsOfLot.set(agg.lotId, [...(groupsOfLot.get(agg.lotId) ?? []), agg]);
  const printedLots = new Set<string>();
  let n = 0;
  let totalKg = 0;
  let totalM3 = 0;
  let totalBoxes = 0;
  for (const agg of byKey.values()) {
    // The footer keeps accumulating the RAW per-group figures as it always
    // has, so a composed row's rounding can never move it.
    totalKg += agg.kg;
    totalM3 += agg.m3;
    totalBoxes += agg.boxCount;
    const comp = papers.compositions.get(agg.lotId);
    if (comp) {
      if (printedLots.has(agg.lotId)) continue;
      printedLots.add(agg.lotId);
      const groups = groupsOfLot.get(agg.lotId) ?? [agg];
      const lot = lotsById.get(agg.lotId)!;
      const cartons = groups.reduce((s, g) => s + g.boxCount, 0);
      const rawKg = groups.reduce((s, g) => s + g.kg, 0);
      const rawM3 = groups.reduce((s, g) => s + g.m3, 0);
      const view = paperLines(comp, lotTotalsOf(lot), {
        before: papers.before(agg.lotId),
        cartons,
        kg: Math.round(rawKg * 10) / 10,
        m3: Math.round(rawM3 * 1000) / 1000,
      });
      const mode = compositionMode(comp.lines) === 'separate' ? 'separate' : 'mixed';
      const pack = groups.map((g) => `${g.pack} ×${g.boxCount}`).join('; ');
      view.lines.forEach((line, i) => {
        n += 1;
        const row = sheet.addRow([
          n, agg.code, packingProductCell(line), pack, packingBoxesCell(line, mode, i === 0, cartons),
          line.kg, line.m3 ?? '',
        ]);
        if (view.estimate) {
          row.getCell(3).note = estimateNote(view, cartons, lot.boxCount);
          row.getCell(3).fill = ESTIMATE_FILL;
        }
      });
      continue;
    }
    n += 1;
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
