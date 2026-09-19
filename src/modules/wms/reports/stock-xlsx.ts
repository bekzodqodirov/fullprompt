import ExcelJS from 'exceljs';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { attachments } from '../../platform/db/schema';
import { getStorage } from '../../platform/files/storage';
import { runPooled } from '../../../components/pooled';
import { parseCols, visibleColumns } from '../../platform/lists/columns';
import { STOCK_COLUMNS } from '../inventory/columns';
import { reportLabels } from './labels';

/**
 * The stock (Ostatka) sheet.
 *
 * Lifted out of `/api/reports/stock` in the round that gave it photographs
 * and the XYZ column (owner, 2026-09-19), for the reason every other export
 * in this codebase is a module: `buildPackingPhotosXlsx`, `buildAgentXlsx`
 * and `buildManifestXlsx` are all built by a test that loads the bytes back
 * and reads the headers, and a builder living inside a route handler is the
 * one that cannot be. The route keeps the door, the parameters, the query
 * and the audit row; this file decides what the spreadsheet says.
 */

export interface StockSheetLine {
  lot: {
    id: string;
    receiptId: string;
    letter: string | null;
    productNameZh: string;
    productNameRu: string | null;
    boxCount: number;
    totalWeightKg: string;
    totalVolumeM3: string;
    boxLengthCm: number | null;
    boxWidthCm: number | null;
    boxHeightCm: number | null;
    note: string | null;
  };
  receivedAt: Date;
  marking: string | null;
  whCode: string;
  whId: string;
  clientCode: string | null;
  inStock: number;
}

export async function buildStockXlsx(input: {
  lines: StockSheetLine[];
  arrivalCodes: Map<string, string[]>;
  cols: string | undefined;
  locale: string | null | undefined;
  can: (permission: string) => boolean;
}): Promise<{ buffer: Buffer; visible: Set<string> }> {
  const { lines, arrivalCodes } = input;
  const L = reportLabels(input.locale);
  const chosen = parseCols(input.cols);

  const visible = new Set(
    visibleColumns(STOCK_COLUMNS, chosen, (permission) => input.can(permission)).map(
      (column) => column.key,
    ),
  );
  const SHEET_COLUMNS: { key: string; column: Partial<ExcelJS.Column>; always?: true }[] = [
    /**
     * The photograph, which this file used to skip with the note «the photo
     * has no spreadsheet equivalent». It has one — `buildPackingPhotosXlsx`
     * has embedded lot photos since feedback round 8 — and the owner asked
     * for it here (2026-09-19): «rasimlari bn qoyilgan bolsin excelda».
     *
     * It follows the SCREEN's own 📷 column rather than being unconditional,
     * which is what makes a small file reachable: untick 📷 on /stock and the
     * download is text again.
     */
    { key: 'photo', column: { header: '📷', key: 'photo', width: 12 } },
    { key: 'whCode', column: { header: L.warehouse, key: 'wh', width: 8 } },
    { key: 'code', column: { header: L.code, key: 'code', width: 14 } },
    { key: 'product', column: { header: L.product, key: 'product', width: 40 } },
    { key: 'boxes', column: { header: L.boxes, key: 'boxCount', width: 10 } },
    { key: 'perBoxKg', column: { header: L.kgPerBox, key: 'perBoxKg', width: 10 } },
    { key: 'stockKg', column: { header: L.sumKg, key: 'totalKg', width: 10 } },
    { key: 'stockM3', column: { header: L.m3, key: 'totalM3', width: 10 } },
    /**
     * EXPORT-ONLY, beside the cube it explains — the same standing as «days
     * in stock», and for the same reason: a sheet is read at a desk where
     * that question gets asked, and /stock is already 860 px on a phone.
     *
     * Empty when the lot carries no measurements, which is his own rule:
     * «agar xyz kirgizilmagan bolsa yani umumiy hajm va kg kirgizilgan
     * bolsa xyz qatori bosh qolsin». The wizard lets an operator type the
     * total volume INSTEAD of the three sides, so a blank here is a real
     * answer and not missing data.
     */
    { key: 'xyz', column: { header: L.xyzCm, key: 'xyz', width: 14 }, always: true },
    { key: 'density', column: { header: L.density, key: 'density', width: 10 } },
    { key: 'note', column: { header: L.note, key: 'note', width: 30 } },
    { key: 'partiya', column: { header: L.batch, key: 'batch', width: 12 } },
    { key: 'receivedAt', column: { header: L.date, key: 'date', width: 12 } },
  ];

  /**
   * The photographs, if the screen's 📷 column is on.
   *
   * Which picture: the LOT's own, falling back to the receipt's general box
   * photo — the order /stock itself leads with, because this sheet answers
   * «what is standing in the warehouse», not «which carton do I load» (the
   * truck card asks that one and takes the outside first).
   *
   * BOUNDED, and the bound is the point. The row query caps at 10 000 lots;
   * at roughly 10 KB a thumbnail that is a 100 MB download and a container
   * holding all of it in memory at once. Past the cap the rows still export
   * and the header says the pictures stopped, rather than the file quietly
   * being a different thing from the one before it.
   */
  const PHOTO_CAP = 600;
  const wantPhotos = visible.has('photo');
  const thumbs = new Map<string, Buffer>();
  const photoByLot = new Map<string, string>();
  let photosSkipped = 0;

  if (wantPhotos && lines.length > 0) {
    const lotIds = lines.map((line) => line.lot.id);
    const receiptIds = [...new Set(lines.map((line) => line.lot.receiptId))];
    const pick = async (entityType: 'receipt_lot' | 'receipt', ids: string[]) =>
      ids.length === 0
        ? []
        : db
            .select({
              entityId: attachments.entityId,
              id: attachments.id,
              thumbKey: attachments.thumb200Key,
              storageKey: attachments.storageKey,
            })
            .from(attachments)
            .where(
              and(
                eq(attachments.entityType, entityType),
                inArray(attachments.entityId, ids),
                eq(attachments.kind, 'photo'),
              ),
            )
            .orderBy(asc(attachments.createdAt));
    const [lotAtt, receiptAtt] = await Promise.all([
      pick('receipt_lot', lotIds),
      pick('receipt', receiptIds),
    ]);

    const firstOf = (rows: typeof lotAtt) => {
      const map = new Map<string, (typeof rows)[number]>();
      for (const row of rows) if (!map.has(row.entityId)) map.set(row.entityId, row);
      return map;
    };
    const byLot = firstOf(lotAtt);
    const byReceipt = firstOf(receiptAtt);

    const needed = new Map<string, { thumbKey: string | null; storageKey: string }>();
    for (const line of lines) {
      const att = byLot.get(line.lot.id) ?? byReceipt.get(line.lot.receiptId);
      if (!att) continue;
      if (needed.size >= PHOTO_CAP && !needed.has(att.id)) {
        photosSkipped += 1;
        continue;
      }
      photoByLot.set(line.lot.id, att.id);
      needed.set(att.id, { thumbKey: att.thumbKey, storageKey: att.storageKey });
    }

    // exceljs embeds png/jpeg only; thumbs are webp — convert, and fetch a
    // few at a time rather than one after another (#102's own lesson, from
    // the other end of the same pipe).
    const sharp = (await import('sharp')).default;
    await runPooled([...needed.entries()], 8, async ([id, keys]) => {
      try {
        const bytes = await getStorage().get(keys.thumbKey ?? keys.storageKey);
        thumbs.set(id, await sharp(bytes).jpeg({ quality: 70 }).toBuffer());
      } catch {
        /* photo unavailable — the cell simply stays empty */
      }
    });
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Stock');
  sheet.columns = [
    ...SHEET_COLUMNS.filter((entry) => entry.always || visible.has(entry.key)).map(
      (entry) => entry.column,
    ),
    { header: L.days, key: 'aging', width: 8 },
  ];
  sheet.getRow(1).font = { bold: true };
  /** Zero-based index of the 📷 column, or -1 when the screen has it hidden. */
  const photoCol = (sheet.columns ?? []).findIndex((column) => column.key === 'photo');
  if (photosSkipped > 0) {
    // Said only when it bites (#74's idiom): a header that always carried a
    // number would read as an error on every ordinary download.
    const cell = sheet.getRow(1).getCell('photo');
    cell.value = `📷 (${PHOTO_CAP})`;
    cell.note = `${photosSkipped} ${L.photosCapped}`;
  }

  const now = Date.now();
  for (const line of lines) {
    const perBoxKg = Number(line.lot.totalWeightKg) / line.lot.boxCount;
    const stockKg = perBoxKg * Number(line.inStock);
    const stockM3 = (Number(line.lot.totalVolumeM3) / line.lot.boxCount) * Number(line.inStock);
    const density =
      Number(line.lot.totalVolumeM3) > 0
        ? Number(line.lot.totalWeightKg) / Number(line.lot.totalVolumeM3)
        : null;
    /**
     * All three or nothing. A lot with a length and no height has no cube
     * either — the wizard computes the volume from the sides — so printing
     * «40×30×» would state a measurement nobody took.
     */
    const { boxLengthCm: x, boxWidthCm: y, boxHeightCm: z } = line.lot;
    const xyz = x && y && z ? `${x}×${y}×${z}` : '';
    const row = sheet.addRow({
      xyz,
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
      batch: (arrivalCodes.get(`${line.lot.id}|${line.whId}`) ?? []).join(', '),
      date: line.receivedAt.toISOString().slice(0, 10),
    });

    const photoId = photoByLot.get(line.lot.id);
    const thumb = photoId ? thumbs.get(photoId) : undefined;
    if (thumb && photoCol >= 0) {
      // Only a row that HAS a picture grows: a 450-row sheet where every row
      // is 60pt tall is four screens of white space on the rows that do not.
      row.height = 60;
      sheet.addImage(
        workbook.addImage({ buffer: thumb as unknown as ExcelJS.Buffer, extension: 'jpeg' }),
        { tl: { col: photoCol + 0.1, row: row.number - 1 + 0.1 }, ext: { width: 78, height: 72 } },
      );
    }
  }


  return { buffer: Buffer.from(await workbook.xlsx.writeBuffer()), visible };
}
