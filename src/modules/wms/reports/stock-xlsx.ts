import ExcelJS from 'exceljs';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { attachments } from '../../platform/db/schema';
import { getStorage } from '../../platform/files/storage';
import { runPooled } from '../../../components/pooled';
import { parseCols, visibleColumns } from '../../platform/lists/columns';
import { STOCK_COLUMNS } from '../inventory/columns';
import { reportLabels } from './labels';
import { dayIn, OFFICE_TZ } from '@/modules/platform/time/tashkent';

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

/**
 * The sheet's three photograph bounds, exported because they are MEASURED
 * numbers rather than taste — a test asserts them so lowering one is a
 * deliberate act with the measurement in front of you, not a tidy-up.
 *
 *  · `download` — DISTINCT images fetched and re-encoded. THE ONE THAT BINDS:
 *    every row's lot photograph is unique to that row, so ~450 rows spend
 *    ~450 of it before a single carton shot is admitted. At 600 his own
 *    Ostatka drew 900 of 1,800 and SKIPPED 900 — half the photographs, on the
 *    thing he asked to see. Measured: 600 -> 900 drawn / 900 skipped / 776 ms
 *    / RSS 161->238 MB; 3,000 -> 1,800 drawn / 0 skipped / 1,012 ms / RSS
 *    237->248 MB. The whole cost of not dropping them is ~240 ms and ~10 MB.
 *  · `placements` — anchors on the sheet, and the real MEMORY fence: exceljs
 *    builds `xl/drawings/drawing1.xml` as ONE string before zipping. Measured:
 *    3,000 = 150 MB RSS, 5,000 = 195 MB, 30,000 = 577 MB, on the single Node
 *    process that serves every screen.
 *  · `columns` — a fence against a pathological row, not a budget: the owner
 *    said «hamma rasimi kerak, 1 2 rasim emas hammasi kerak», and Excel's own
 *    limit is 16,384 columns.
 */
export const STOCK_PHOTO_BOUNDS = { download: 3000, placements: 6000, columns: 50 } as const;

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
  /**
   * The three photo bounds, injectable ONLY so a test can reach them: the
   * owner's own data holds at most one photograph per lot today, so nothing
   * a fixture can seed would ever push a real sheet past the shipped
   * defaults. Appended after `arrivalCodes` in the route's call on purpose —
   * `partiya-wire` reads a 200-character window from the call to it.
   */
  photoCap?: number;
  placementCap?: number;
  photoColsCap?: number;
}): Promise<{ buffer: Buffer; visible: Set<string>; photos: number; photosSkipped: number }> {
  const { lines, arrivalCodes } = input;
  const L = reportLabels(input.locale);
  const chosen = parseCols(input.cols);

  const visible = new Set(
    visibleColumns(STOCK_COLUMNS, chosen, (permission) => input.can(permission)).map(
      (column) => column.key,
    ),
  );
  const SHEET_COLUMNS: { key: string; column: Partial<ExcelJS.Column>; always?: true }[] = [
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
   * EVERY photograph of that prixod line, not one (owner, 2026-09-19: «usha
   * prixotdagi hamma rasim kerak boladi»).
   *
   * Order is the row's own story: the LOT's own photographs first — what the
   * goods are — then the receipt's general shots of the cartons as they
   * stood. A receipt's general photo belongs to every lot of that receipt, so
   * it appears on each of their rows; that is the point of it.
   *
   * Three separate bounds, because they cost different things:
   *
   *  · `PHOTO_DOWNLOAD_CAP` — DISTINCT images fetched from the object store
   *    and re-encoded. This is the network and the CPU.
   *  · `PLACEMENT_CAP` — anchors drawn on the sheet. This is the memory:
   *    exceljs builds `xl/drawings/drawing1.xml` as ONE string (~900 bytes an
   *    anchor) before zipping, so the placements are what turns a download
   *    into a container's worth of heap — and the old single cap bounded
   *    downloads only, which a shared receipt photo makes nearly free.
   *    (The 6,000 figure is about ANCHORS. Reaching thirteen photographs on
   *    every one of 450 rows also needs the DOWNLOAD bound to admit them,
   *    which is why that one moved to 3,000 — see it below.)
   *    MEASURED here: 3,000 placements = 150 MB RSS, 5,000 = 195 MB,
   *    30,000 = 577 MB. Six thousand covers his own Ostatka (~450 rows) at
   *    thirteen photographs a row and still leaves the one Node process
   *    that serves every screen its head.
   *  · `PHOTO_COLS_CAP` — columns. NOT a product decision: the owner was
   *    asked and said «hamma rasimi kerak, 1 2 rasim emas hammasi kerak»,
   *    and the receive wizard puts no limit on how many photographs a lot
   *    carries. Fifty is a fence against a pathological row (Excel's own
   *    limit is 16,384 columns and a sheet that wide is unreadable), not a
   *    budget — no prixod this company has ever received comes near it.
   *
   * The bound is spent BREADTH-FIRST: every row's first photograph before any
   * row's second, so a warehouse over the cap still shows one picture per line
   * rather than four pictures on the first quarter of it.
   */
  /**
   * THREE THOUSAND, and the old 600 was cutting his sheet in half.
   *
   * Every row's own lot photograph is unique to that row, so ~450 rows spend
   * ~450 of the bound before a single carton shot is admitted — and the carton
   * shots are the ones he asked for («usha prixotdagi hamma rasim kerak
   * boladi»). MEASURED on his real shape (450 rows, 150 prixods, one lot photo
   * each plus three general photos a prixod = 900 distinct, 1,800 placements):
   *
   *   cap 600  -> 900 drawn, 900 SKIPPED, 776 ms, RSS 161->238 MB
   *   cap 3000 -> 1,800 drawn, 0 skipped, 1,012 ms, RSS 237->248 MB
   *
   * So exactly half the photographs were being dropped, and the whole cost of
   * not dropping them is ~240 ms and ~10 MB. Production thumbnails are the
   * common case by a mile (round 102: 401 of 406 photographs have one) and a
   * 200 px thumbnail is a few hundred bytes to a few KB.
   *
   * `PLACEMENT_CAP` stays the real memory fence — it is the anchors, not the
   * downloads, that build `drawing1.xml` as one string.
   */
  const PHOTO_DOWNLOAD_CAP = input.photoCap ?? STOCK_PHOTO_BOUNDS.download;
  const PLACEMENT_CAP = input.placementCap ?? STOCK_PHOTO_BOUNDS.placements;
  const PHOTO_COLS_CAP = input.photoColsCap ?? STOCK_PHOTO_BOUNDS.columns;
  /**
   * The photographs are EXPORT-ALWAYS — the THIRD column that does not follow
   * the screen's tick, beside XYZ and «days in stock».
   *
   * It shipped as `visible.has('photo')` and that made the feature invisible
   * to the person who asked for it (owner, 2026-09-19: «excel fileda hech
   * qanday rasim korinmadi»). MEASURED on his own data: with a `?cols=` that
   * does not name the photo the sheet comes out with zero pictures, zero
   * anchors and no 📷 column at all — no error, nothing on screen to say why.
   * And `/stock` redirects a bare visit to a personal default view
   * (`stock/page.tsx:69-74`), so ONE view saved without 📷 makes every
   * download photoless for ever.
   *
   * This is round 57's own defect one screen over, and `columns.ts` already
   * wrote the rule down in its own words: «`optional` exists to keep a
   * phone-width table readable, not to keep anything out of a spreadsheet: a
   * sheet is read at a desk.» Back then it was the client book's spreadsheet
   * quietly losing its phone-numbers column.
   *
   * Both photo sheets already in production carry their pictures
   * unconditionally (`packing-photos-xlsx.ts:137`, `agent-xlsx.ts:183`) and
   * the owner's instruction is «hamma rasimi kerak». The screen's 📷 tick
   * keeps its real job, which is the PHONE: ~450 thumbnails are the reason
   * round 68 paged that table at all.
   *
   * Cost stated rather than hidden: every Ostatka download now pays for the
   * pictures. The three bounds below are what keeps the one Node process
   * standing; if a warehouse-wide download becomes slow, that is a measured
   * follow-up and not a reason to hide the feature again.
   */
  const wantPhotos = true;
  // …and the audit row must not say «no photo column» about a file that has
  // one. `visible` is what the route records as `cols`.
  visible.add('photo');
  const thumbs = new Map<string, Buffer>();
  /** Admitted photographs per row index, in the order they must be drawn. */
  const photosByRow = new Map<number, string[]>();
  let photosSkipped = 0;

  if (wantPhotos && lines.length > 0) {
    const lotIds = lines.map((line) => line.lot.id);
    const receiptIds = [...new Set(lines.map((line) => line.lot.receiptId))];
    type PhotoRow = {
      entityId: string;
      id: string;
      thumbKey: string | null;
      storageKey: string;
    };
    const pick = async (
      entityType: 'receipt_lot' | 'receipt',
      ids: string[],
    ): Promise<PhotoRow[]> =>
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
            // `attachments` has no order column and the wizard uploads four at
            // a time, so `created_at` alone can tie — and a tie here is the
            // photographs changing places between two downloads of the same
            // warehouse. `id` is uuidv7, so it is a deterministic tiebreak
            // that needs no migration.
            .orderBy(asc(attachments.createdAt), asc(attachments.id));
    const [lotAtt, receiptAtt] = await Promise.all([
      pick('receipt_lot', lotIds),
      pick('receipt', receiptIds),
    ]);

    const groupBy = (rows: PhotoRow[]) => {
      const map = new Map<string, PhotoRow[]>();
      for (const row of rows) {
        const list = map.get(row.entityId);
        if (list) list.push(row);
        else map.set(row.entityId, [row]);
      }
      return map;
    };
    const byLot = groupBy(lotAtt);
    const byReceipt = groupBy(receiptAtt);
    const keysById = new Map<string, { thumbKey: string | null; storageKey: string }>();
    for (const att of [...lotAtt, ...receiptAtt]) {
      keysById.set(att.id, { thumbKey: att.thumbKey, storageKey: att.storageKey });
    }

    /** One flat list of (row, photo, rank), so the bound can be spent by rank. */
    const candidates: { rowIndex: number; attId: string; rank: number }[] = [];
    lines.forEach((line, rowIndex) => {
      const own = byLot.get(line.lot.id) ?? [];
      const general = byReceipt.get(line.lot.receiptId) ?? [];
      [...own, ...general].forEach((att, rank) => {
        if (rank < PHOTO_COLS_CAP) candidates.push({ rowIndex, attId: att.id, rank });
        else photosSkipped += 1;
      });
    });
    // By RANK first: every row's first photograph is admitted before any
    // row's second. Ties by row keep the sheet's own order, and because the
    // list is already (rank, row) sorted each row's admitted photographs come
    // out in lot-photos-first order with no second pass.
    candidates.sort((a, b) => a.rank - b.rank || a.rowIndex - b.rowIndex);

    const needed = new Set<string>();
    let placements = 0;
    for (const candidate of candidates) {
      const fresh = !needed.has(candidate.attId);
      if (placements >= PLACEMENT_CAP || (fresh && needed.size >= PHOTO_DOWNLOAD_CAP)) {
        photosSkipped += 1;
        continue;
      }
      needed.add(candidate.attId);
      placements += 1;
      const list = photosByRow.get(candidate.rowIndex);
      if (list) list.push(candidate.attId);
      else photosByRow.set(candidate.rowIndex, [candidate.attId]);
    }
    /**
     * exceljs embeds png/jpeg only and thumbs are webp — convert, four at a
     * time (#102's own lesson from the other end of the same pipe).
     *
     * RESIZED first, and that is not decoration: `thumb200Key` is NULL
     * whenever the thumbnail job has not run (and for every photo this
     * container has), and the fallback is the ORIGINAL — a 3-4 MB phone
     * photograph re-encoded at full resolution to be drawn at 78×72 px.
     */
    const sharp = (await import('sharp')).default;
    await runPooled([...needed], 8, async (id) => {
      const keys = keysById.get(id);
      if (!keys) return;
      try {
        const bytes = await getStorage().get(keys.thumbKey ?? keys.storageKey);
        thumbs.set(
          id,
          await sharp(bytes)
            .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 70 })
            .toBuffer(),
        );
      } catch {
        /* photo unavailable — the cell simply stays empty */
      }
    });
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Stock');

  /**
   * How many photo columns this sheet needs — counted over the photographs
   * that were ADMITTED, never over the query, or one eight-photo prixod at
   * row 9,000 grows eight columns on a sheet where nothing past the bound has
   * a picture at all.
   *
   * At least one whenever the screen's 📷 is ticked: a warehouse where nobody
   * has photographed anything must still download the column they asked for,
   * empty, rather than a file with a column silently missing (the packing
   * list's own `Math.max(1, …)`).
   */
  const photoCols = wantPhotos
    ? Math.min(PHOTO_COLS_CAP, Math.max(1, ...[...photosByRow.values()].map((ids) => ids.length)))
    : 0;
  /**
   * The photo block sits at the END, after every column a person reads, and
   * both existing photo sheets in this codebase do the same (`agent-xlsx`,
   * `packing-photos-xlsx`). With eight of them in FRONT the client code lands
   * around column I — six hundred pixels of photographs before the first fact
   * about the cargo. The first two columns are frozen instead, so the code
   * stays on screen while the reader scrolls right into the pictures.
   *
   * ONE key — `'photo'` — survives in `STOCK_COLUMNS` and in `visible`, so
   * the screen's tick, the `?cols=` vocabulary and the audit row all keep
   * saying the same word; the block is expanded here, after the filter.
   */
  const dataColumns = [
    ...SHEET_COLUMNS.filter((entry) => entry.always || visible.has(entry.key)).map(
      (entry) => entry.column,
    ),
    { header: L.days, key: 'aging', width: 8 },
  ];
  sheet.columns = [
    ...dataColumns,
    ...Array.from({ length: photoCols }, (_, i) => ({
      header: i === 0 ? '📷' : '',
      key: `photo${i}`,
      width: 12,
    })),
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];
  // The header row repeats on every printed page. A fifteen-column sheet is
  // three pages wide on A4 and page two otherwise carries numbers with no
  // names over them.
  sheet.pageSetup = { ...sheet.pageSetup, printTitlesRow: '1:1' };
  /** Zero-based index of the FIRST photo column, or -1 when there is none. */
  const photoCol = photoCols > 0 ? dataColumns.length : -1;
  if (photoCol >= 0) {
    const cell = sheet.getRow(1).getCell(photoCol + 1);
    /**
     * A pinned note, and it is worth its one line: the pictures are FLOATING
     * drawings anchored to a cell, not cell contents, so Excel's own Sort
     * rewrites the values underneath them and leaves every photograph where
     * it was. Sorting an Ostatka by Σ kg is the first thing a desk reader
     * does, and nothing in the file would otherwise say that the pictures
     * stopped belonging to their rows.
     */
    cell.note = L.photoSortNote;
    if (photosSkipped > 0) {
      // Said only when it bites (#74's idiom): a header that always carried a
      // number would read as an error on every ordinary download.
      /**
       * In the cell's VALUE and not only its note: a note needs a hover, and
       * the person reading this sheet is checking whether every photograph is
       * there. `📷 (2)` told him the column count, which is not the question.
       */
      cell.value = `📷 ⚠️ −${photosSkipped}`;
      cell.note = `${photosSkipped} ${L.photosCapped}\n${L.photoSortNote}`;
    }
  }

  /**
   * Placements are collected and emitted AFTER the rows, grouped by image.
   *
   * This is not tidiness — it is the one shape that is correct. exceljs 4.4.0
   * keeps `drawingRelsHash` in TWO key spaces inside one array
   * (`worksheet-xform.js:226-231`): it WRITES at `drawing.rels.length` and
   * READS at `medium.imageId` only when the PREVIOUS placement carried the
   * same image. Emit the same image twice with another in between and the
   * second one takes the most recently created relationship — i.e. **the
   * sheet draws a different photograph**, silently, with no error anywhere.
   * Today's code never met it because it called `addImage` fresh for every
   * single placement; sharing a receipt's general photo across its lots is
   * exactly what arms it. So: one `addImage` per distinct photograph, minted
   * in the order the images are first drawn, and every placement of that
   * image emitted contiguously.
   */
  const placements: { attId: string; col: number; row: number }[] = [];

  const now = Date.now();
  lines.forEach((line, rowIndex) => {
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
      date: dayIn(line.receivedAt, OFFICE_TZ),
    });

    const ids = (photosByRow.get(rowIndex) ?? []).filter((id) => thumbs.has(id));
    if (ids.length > 0 && photoCol >= 0) {
      // Only a row that HAS a picture grows: a 450-row sheet where every row
      // is 60pt tall is four screens of white space on the rows that do not.
      row.height = 60;
      ids.forEach((attId, i) => {
        if (i >= photoCols) return;
        placements.push({ attId, col: photoCol + i, row: row.number - 1 });
      });
    }
  });

  const imageIdOf = new Map<string, number>();
  for (const placement of placements) {
    if (imageIdOf.has(placement.attId)) continue;
    imageIdOf.set(
      placement.attId,
      workbook.addImage({
        buffer: thumbs.get(placement.attId) as unknown as ExcelJS.Buffer,
        extension: 'jpeg',
      }),
    );
  }
  const byImage = [...placements].sort(
    (a, b) =>
      (imageIdOf.get(a.attId) ?? 0) - (imageIdOf.get(b.attId) ?? 0) || a.row - b.row || a.col - b.col,
  );
  for (const placement of byImage) {
    sheet.addImage(imageIdOf.get(placement.attId)!, {
      tl: { col: placement.col + 0.1, row: placement.row + 0.1 },
      ext: { width: 78, height: 72 },
    });
  }

  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    visible,
    /** What the file actually carries — the audit row could not tell a
     *  twelve-photograph export from a three-thousand-photograph one. */
    photos: placements.length,
    photosSkipped,
  };
}
