import { DOC } from './labels';
import { and, asc, eq, inArray } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { db } from '../../platform/db/client';
import {
  batches,
  boxes,
  clients,
  crates,
  partners,
  receiptLots,
  receipts,
  scanEvents,
  warehouses,
} from '../../platform/db/schema';
import { getSetting } from '../../platform/settings/service';
import { productKey, tnvedFor } from '../tnved/service';
import { batchMemberFilter } from '../scanning/unload';
import { compositionMode, paperLines, truckSegments } from '../receipts/composition-math';
import { lotTrucksFor, paperCompositionsFor } from '../receipts/lot-composition';
import {
  ESTIMATE_FILL,
  estimateNote,
  invoiceRowCells,
  packingBoxesCell,
  packingPiecesCell,
  packingProductCell,
} from './composition-cells';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { effectiveCustoms } from '../partners/customs';
import {
  NO_MERGE,
  invoiceModel,
  labelRuns,
  positionEstimateNote,
  positionPiecesNote,
  type InvoiceMergeAnswer,
  type InvoiceSourceRow,
} from './invoice-rows';

async function batchLines(batchId: string) {
  const rows = await db
    .select({
      boxId: boxes.id,
      lot: receiptLots,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
      liveCrateId: boxes.crateId,
      receiptId: receipts.id,
      clientId: receipts.clientId,
      customsPartnerId: receipts.customsPartnerId,
      customsByClient: receipts.customsByClient,
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
      receiptId: row.receiptId,
      clientId: row.clientId,
      customsPartnerId: row.customsPartnerId,
      customsByClient: row.customsByClient,
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
): Map<string, { loose: number; pallets: number; onPallets: number }> {
  const parts = new Map<string, { loose: number; pallets: number; onPallets: number }>();
  const pallets = new Map<string, Map<string, { letter: string; n: number }>>();
  const partOf = (lotId: string) => {
    const p = parts.get(lotId) ?? { loose: 0, pallets: 0, onPallets: 0 };
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
      partOf(row.lotId).onPallets += 1;
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
 * composition (frozen while the truck is ticked «hujjat yuborildi») and
 * where each lot's cartons on this truck sit in the lot's order — after its
 * earlier crossing trucks, or, on a sent truck, where they sat at the tick.
 */
async function paperContext(batchId: string, lotIds: string[]) {
  const [compositions, trucks] = await Promise.all([
    paperCompositionsFor(batchId, lotIds),
    lotTrucksFor(db, lotIds),
  ]);
  return {
    compositions,
    segments: (lotId: string) => truckSegments(trucks.get(lotId) ?? [], batchId),
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
 * What a sticker of this lot says, as the invoice's «Маркировка» column
 * writes it: the client's code and the lot's letter («GS777-AB» — his
 * «klient kodini va berilgan kod (AA, AB, AC)»). Cargo received under a
 * hand-written marking and claimed later still CARRIES the marking on its
 * cartons, so it follows in brackets; unclaimed cargo has only the marking.
 */
export function invoiceLotLabel(lot: { clientCode: string | null; marking: string | null; letter: string | null }): string {
  const letter = lot.letter ?? '';
  if (lot.clientCode && lot.marking) return `${lot.clientCode}-${letter} (${lot.marking})`;
  return `${lot.clientCode ?? lot.marking ?? '?'}-${letter}`;
}

/** Who clears a scope, for the dialog — absent for the truck's own answer. */
export interface InvoiceScopeNote {
  kind: 'client' | 'firm';
  name: string;
}

export interface InvoiceSource {
  batch: typeof batches.$inferSelect;
  rows: InvoiceSourceRow[];
  /** scope token → who clears it, only for the scopes that are NOT the truck's own. */
  scopes: Map<string, InvoiceScopeNote>;
}

/**
 * The invoice's SOURCE rows (docs/TARKIB-TUZATISH.md §6.1) — exactly what
 * this builder printed before positions existed, unmerged: one row per lot
 * with no tarkib (its own name, the memory's code, «кг»), one per printed
 * tarkib line (the line's own name and code — never the memory's, a line has
 * no memory key; «шт» when its pieces land here). The sheet AND the dialog
 * that asks «qo'shaymi?» are computed from this one list (#513).
 *
 * Lots stand in a TOTAL order — letter, then label, then id: the query's
 * `ORDER BY letter, seq_in_lot` interleaves lots that share a letter, so the
 * same truck could print its rows in another order on the next download, and
 * a merged position takes its FIRST member's slot.
 */
export async function invoiceSourceRows(batchId: string): Promise<InvoiceSource | null> {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return null;
  const rows = await batchLines(batchId);
  const placeRows = rows.map(({ lot, crateId, crateKind }) => ({ lotId: lot.id, letter: lot.letter, crateId, crateKind }));
  const places = invoicePlaces(placeRows);
  const placeParts = invoicePlaceParts(placeRows);
  const byLot = new Map<
    string,
    {
      lot: typeof receiptLots.$inferSelect;
      product: string;
      nameZh: string;
      boxCount: number;
      kg: number;
      label: string;
      at: number;
      first: (typeof rows)[number];
    }
  >();
  // The letters in the query's own order (the database's collation, NULL last).
  const letterAt = new Map<string | null, number>();
  for (const row of rows) {
    const { lot } = row;
    if (!letterAt.has(lot.letter)) letterAt.set(lot.letter, letterAt.size);
    const agg = byLot.get(lot.id) ?? {
      lot,
      product: lot.productNameRu?.trim() || lot.productNameZh,
      nameZh: lot.productNameZh,
      boxCount: 0,
      kg: 0,
      label: invoiceLotLabel({ clientCode: row.clientCode, marking: row.marking, letter: lot.letter }),
      at: letterAt.get(lot.letter)!,
      first: row,
    };
    agg.boxCount += 1;
    agg.kg += Number(lot.totalWeightKg) / lot.boxCount;
    byLot.set(lot.id, agg);
  }
  const lots = [...byLot.entries()].sort(
    ([idA, a], [idB, b]) => a.at - b.at || (a.label < b.label ? -1 : a.label > b.label ? 1 : idA < idB ? -1 : 1),
  );
  // ТНВЭД memory (Phase 1.5): known products prefill; unknown stay blank.
  const tnved = await tnvedFor(lots.map(([, a]) => a.nameZh));
  // Lot tarkibi: a composed lot prints one row per line on this truck.
  const papers = await paperContext(batchId, lots.map(([id]) => id));

  // Who clears each prixod (the Rastamojka panel's own rule): rows of
  // different answers never share a position.
  const own = effectiveCustoms({ customsPartnerId: null, customsByClient: null }, batch);
  const scopeOf = (row: (typeof rows)[number]) => {
    const choice = effectiveCustoms(row, batch);
    return {
      key: choice.byClient ? `client:${row.clientId ?? row.receiptId}` : `firm:${choice.partnerId ?? ''}`,
      choice,
    };
  };
  const ownKey = own.byClient ? null : `firm:${own.partnerId ?? ''}`;
  const firmIds = [...new Set(lots.map(([, a]) => scopeOf(a.first).choice.partnerId).filter((id): id is string => id !== null))];
  const firms = firmIds.length
    ? await db.select({ id: partners.id, name: partners.name }).from(partners).where(inArray(partners.id, firmIds))
    : [];
  const firmName = new Map(firms.map((f) => [f.id, f.name]));
  const scopes = new Map<string, InvoiceScopeNote>();

  const out: InvoiceSourceRow[] = [];
  for (const [lotId, agg] of lots) {
    const kg = Math.round(agg.kg * 10) / 10;
    const comp = papers.compositions.get(lotId);
    const { key: scope, choice } = scopeOf(agg.first);
    if (scope !== ownKey && !scopes.has(scope)) {
      scopes.set(
        scope,
        choice.byClient
          ? { kind: 'client', name: agg.first.clientCode ?? agg.first.marking ?? '?' }
          : { kind: 'firm', name: choice.partnerId ? (firmName.get(choice.partnerId) ?? '?') : '—' },
      );
    }
    const lot = { lotId, label: agg.label, lines: comp ? comp.lines.length : 0 };
    if (comp) {
      // The composed lot's rows: netto = brutto = the line's kg, which sum to
      // exactly the single figure the lot printed before.
      const view = paperLines(comp, lotTotalsOf(agg.lot), {
        segments: papers.segments(lotId),
        cartons: agg.boxCount,
        kg,
        places: placeParts.get(lotId) ?? { loose: agg.boxCount, pallets: 0, onPallets: 0 },
      });
      const estimate = view.estimate ? estimateNote(view, agg.boxCount, agg.lot.boxCount) : null;
      for (const line of view.lines) {
        const cells = invoiceRowCells(line);
        out.push({
          lot,
          name: cells.product,
          code: cells.code,
          unit: cells.unit,
          pieces: cells.unit === 'шт' ? cells.quantity : null,
          places: line.places,
          kgTenths: Math.round(cells.kg * 10),
          estimate,
          scope,
        });
      }
      continue;
    }
    // ТНВЭД prefills from memory (still editable in Excel); the measured
    // weight goes into both netto and brutto — netto is corrected by hand
    // when the tare matters.
    out.push({
      lot,
      name: agg.product,
      code: tnved.get(productKey(agg.nameZh))?.tnvedCode ?? '',
      unit: 'кг',
      pieces: null,
      places: places.get(lotId) ?? agg.boxCount,
      kgTenths: Math.round(kg * 10),
      estimate: null,
      scope,
    });
  }
  return { batch, rows: out, scopes };
}

/** The red of a sticker that may hold another good — bold too, so it survives a black-and-white print. */
const RED_MARK = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFC00000' } } as const;
const PLAIN_MARK = { name: 'Arial', size: 11 } as const;

/**
 * INVOICE & PACKING LIST draft (W6) mirroring the owner's real ka23 invoice
 * file (feedback round 6): the same header block (Invoice №, date, container,
 * Sender / Seller / Consignee requisites from settings, transport + delivery
 * terms) and the same table columns incl. ТНВЭД. Prices and the netto
 * correction are left for the VED manager; the amount column and totals are
 * live formulas.
 *
 * Since 2026-11-10 (his item 6) the rows are POSITIONS (`invoice-rows.ts`):
 * same code + same name + same unit is one row; a code that still holds
 * several rows is merged only by the answers the address carries (`answer`);
 * column B names the stickers behind each row, and a sticker whose lot holds
 * several goods that do not stand in one row is RED — «shu karobkani
 * ochganimda 3-4 TNVED koddagi tovardan birini ochishim mumkin».
 */
export async function buildInvoiceXlsx(batchId: string, answer: InvoiceMergeAnswer = NO_MERGE): Promise<Buffer | null> {
  const source = await invoiceSourceRows(batchId);
  if (!source) return null;
  const { batch } = source;
  const model = invoiceModel(source.rows, answer);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('invoice packinglist');
  sheet.columns = [
    { width: 4 }, { width: 22 }, { width: 46 }, { width: 13 }, { width: 8 }, { width: 11 },
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

  // The header's VALUES stand in column C since «Маркировка» took B — and B
  // is left empty beside the labels of column A, which is only 4 wide: with a
  // value beside it «Отправитель/Sender:» was cut to «Отпр»; with none the
  // label spills over and reads whole.
  sheet.mergeCells('C1:J1');
  sheet.getCell('C1').value = 'I N V O I C E  &  PACKING LIST';
  sheet.getCell('C1').font = { bold: true, size: 14 };
  sheet.getCell('C1').alignment = { horizontal: 'center' };

  sheet.getCell('A3').value = 'Invoice № :';
  sheet.getCell('C3').value = `${dateCompact}${batch.code.replace('-', '').toLowerCase()}`;
  sheet.getCell('A4').value = 'Date :';
  sheet.getCell('C4').value = today;
  sheet.getCell('A5').value = '№ Контейнер /Container:';
  sheet.getCell('C5').value = batch.vehiclePlate ?? 'by track';

  sheet.getCell('A7').value = 'Отправитель/Sender:';
  sheet.mergeCells('C7:J8');
  setWrapped('C7', String(sender));
  sheet.getCell('A10').value = 'Seller/ Продавец:';
  sheet.mergeCells('C10:J11');
  setWrapped('C10', String(seller));
  sheet.getCell('A13').value = 'Получатель/Consignee:';
  sheet.mergeCells('C13:J15');
  setWrapped('C13', String(consignee));

  sheet.getCell('A17').value = 'Способ транспортировки:';
  sheet.getCell('C17').value = String(transport);
  sheet.getCell('I17').value = String(customsPost);
  sheet.getCell('A18').value = 'Условия поставки:';
  sheet.getCell('C18').value = String(delivery);

  const head = sheet.getRow(20);
  head.values = [
    '№', DOC.lotMarks, DOC.productName, DOC.hsCode, DOC.unit, DOC.quantity, DOC.places,
    DOC.netWeight, DOC.grossWeight, DOC.price, DOC.totalAmount,
  ];
  head.font = { bold: true };
  head.alignment = { wrapText: true, vertical: 'middle' };

  let n = 0;
  let rowNo = head.number;
  for (const position of model.positions) {
    n += 1;
    rowNo += 1;
    const row = sheet.getRow(rowNo);
    const kg = position.kgTenths / 10;
    row.values = [
      n,
      '',
      position.name,
      position.code,
      position.unit,
      position.quantity,
      position.places === 'part' ? DOC.partOfPlace : (position.places ?? ''),
      kg,
      kg,
      '',
      '',
    ];
    // Price stays for the VED manager; the amount is live.
    row.getCell(11).value = { formula: `J${rowNo}*F${rowNo}` };

    // Column B: the stickers behind the row. Rich text only where something
    // is red — every run names its own face, because the «all Arial» pass
    // below sets the CELL's font and does not reach runs.
    const marks = labelRuns(position, model.redLabels);
    const cell = row.getCell(2);
    cell.alignment = { wrapText: true, vertical: 'top' };
    if (marks.some((m) => m.red)) {
      cell.value = {
        richText: marks.flatMap((m, i) => [
          ...(i > 0 ? [{ text: ', ', font: { ...PLAIN_MARK } }] : []),
          { text: m.text, font: m.red ? { ...RED_MARK } : { ...PLAIN_MARK } },
        ]),
      };
    } else {
      cell.value = marks.map((m) => m.text).join(', ');
    }

    const estimate = positionEstimateNote(position);
    if (estimate) {
      row.getCell(3).note = estimate;
      row.getCell(3).fill = ESTIMATE_FILL;
    }
    const pieces = positionPiecesNote(position);
    if (pieces) row.getCell(6).note = pieces;
  }
  const total = sheet.getRow(rowNo + 1);
  total.font = { bold: true };
  total.getCell(7).value = { formula: `SUM(G${head.number + 1}:G${rowNo})` };
  total.getCell(8).value = { formula: `SUM(H${head.number + 1}:H${rowNo})` };
  total.getCell(9).value = { formula: `SUM(I${head.number + 1}:I${rowNo})` };
  total.getCell(11).value = { formula: `SUM(K${head.number + 1}:K${rowNo})` };

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

  // His 8.5: «Кол-во, шт» right BEFORE the carton count, blank when unknown.
  const head = sheet.addRow(['№', DOC.code, DOC.product, DOC.packaging, DOC.pieces, DOC.boxes, DOC.weightKg, DOC.m3]);
  head.font = { bold: true };
  sheet.columns = [
    { width: 5 }, { width: 14 }, { width: 40 }, { width: 16 }, { width: 10 }, { width: 10 }, { width: 12 }, { width: 10 },
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
        segments: papers.segments(agg.lotId),
        cartons,
        kg: Math.round(rawKg * 10) / 10,
        m3: Math.round(rawM3 * 1000) / 1000,
      });
      const mode = compositionMode(comp.lines) === 'separate' ? 'separate' : 'mixed';
      const pack = groups.map((g) => `${g.pack} ×${g.boxCount}`).join('; ');
      view.lines.forEach((line, i) => {
        n += 1;
        const row = sheet.addRow([
          n, agg.code, packingProductCell(line, { zh: lot.productNameZh, ru: lot.productNameRu }), pack, packingPiecesCell(line),
          packingBoxesCell(line, mode, i === 0, cartons), line.kg, line.m3 ?? '',
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
      n, agg.code, agg.product, agg.pack, '', agg.boxCount,
      Math.round(agg.kg * 10) / 10, Math.round(agg.m3 * 1000) / 1000,
    ]);
  }
  const total = sheet.addRow([
    // No pieces total: pieces of different goods do not add.
    '', DOC.total, '', '', '', totalBoxes, Math.round(totalKg * 10) / 10, Math.round(totalM3 * 1000) / 1000,
  ]);
  total.font = { bold: true };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
