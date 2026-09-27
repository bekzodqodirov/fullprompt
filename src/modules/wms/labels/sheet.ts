import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import QRCode from 'qrcode';
import { db } from '@/modules/platform/db/client';
import {
  boxes,
  clients,
  receiptLots,
  receipts,
  warehouses,
} from '@/modules/platform/db/schema';
import { writeAudit, type AuditContext } from '@/modules/platform/audit/service';
import { QR_ECC, QR_MARGIN_MODULES } from './geometry';
import type { LabelData } from './renderer';
import { qrlessBoxSql } from './qrless-sql';

/**
 * WHICH labels a print covers, decided in one place.
 *
 * There are two ways out of this app to a printer now — the PDF (share sheet,
 * RawBT) and the HTML sheet that opens the phone's own print dialog — and they
 * must put the same stickers on the same boxes. Building the list twice is the
 * mistake this codebase keeps having to unlearn (#163, #166): the copies agree
 * on the day they are written and drift on the first change to a lot's weight
 * rule. So the query, the per-box weight maths and the unclaimed-marking rule
 * live here, and both routes call this.
 */
export interface LabelSheet {
  receiptId: string;
  receiptNumber: string;
  warehouseId: string;
  warehouseCode: string;
  labels: LabelData[];
  boxIds: string[];
}

export async function labelsForReceipt(
  receiptId: string,
  filter: { lotId?: string; boxId?: string },
): Promise<LabelSheet | null> {
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
  if (!receipt) return null;

  const warehouse = (await db.query.warehouses.findFirst({
    where: eq(warehouses.id, receipt.warehouseId),
  }))!;
  const client = receipt.clientId
    ? await db.query.clients.findFirst({ where: eq(clients.id, receipt.clientId) })
    : null;

  const lots = await db
    .select()
    .from(receiptLots)
    .where(
      filter.lotId
        ? and(eq(receiptLots.receiptId, receiptId), eq(receiptLots.id, filter.lotId))
        : eq(receiptLots.receiptId, receiptId),
    )
    .orderBy(asc(receiptLots.seq));
  if (lots.length === 0) return null;

  const lotIds = lots.map((l) => l.id);
  const boxRows = await db
    .select()
    .from(boxes)
    .where(
      and(
        filter.boxId
          ? and(inArray(boxes.lotId, lotIds), eq(boxes.id, filter.boxId))
          : inArray(boxes.lotId, lotIds),
        // A QR-siz carton (0112, the owner's Q8) is not on this sheet: it has
        // no sticker of ours, and a sheet printed here stamps every row it
        // carries — which is what turns a carton into «expect a scan». Only
        // the print-later door's explicit «stikerlar yopishtirildi» may do
        // that (labels/qrless.ts), for the cartons standing where it prints.
        sql`NOT ${qrlessBoxSql()}`,
      ),
    )
    .orderBy(asc(boxes.seqInLot));
  if (boxRows.length === 0) return null;

  const origin: LabelOrigin = {
    warehouseCode: warehouse.code,
    timezone: warehouse.timezone,
    receiptNumber: receipt.number,
    receivedAt: receipt.receivedAt,
    unclaimedMarking: receipt.unclaimedMarking,
    clientCode: client?.clientCode ?? null,
  };
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const labels: LabelData[] = boxRows.map((box) => labelFor(origin, lotById.get(box.lotId)!, box));

  return {
    receiptId,
    receiptNumber: receipt.number ?? '',
    warehouseId: warehouse.id,
    warehouseCode: warehouse.code,
    labels,
    boxIds: boxRows.map((b) => b.id),
  };
}

/** Where a sticker says the cargo came from: the RECEIPT's warehouse, day and number. */
export interface LabelOrigin {
  warehouseCode: string;
  timezone: string;
  receiptNumber: string | null;
  receivedAt: Date;
  unclaimedMarking: string | null;
  clientCode: string | null;
}

type LabelLot = Pick<
  typeof receiptLots.$inferSelect,
  | 'letter'
  | 'productNameZh'
  | 'productNameRu'
  | 'boxCount'
  | 'dimsMode'
  | 'boxWeightKg'
  | 'totalWeightKg'
  | 'boxLengthCm'
  | 'boxWidthCm'
  | 'boxHeightCm'
>;

/**
 * One sticker, from its receipt, lot and box — the ONE shape both sheets
 * draw (the receipt's, and the print-later sheet of QR-siz cartons in
 * labels/qrless.ts). A sticker printed weeks later in Tashkent still says
 * where and when the cargo was RECEIVED: it is the same sticker the box would
 * have carried from the first day, so the two sheets must not disagree.
 */
export function labelFor(
  origin: LabelOrigin,
  lot: LabelLot,
  box: { seqInLot: number; shortCode: string },
): LabelData {
  const perBoxWeight =
    lot.dimsMode === 'uniform' && lot.boxWeightKg
      ? lot.boxWeightKg
      : (Number(lot.totalWeightKg) / lot.boxCount).toFixed(1);
  return {
    warehouseCode: origin.warehouseCode,
    dateLocal: new Intl.DateTimeFormat('ru-RU', {
      timeZone: origin.timezone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(origin.receivedAt),
    receiptNumber: origin.receiptNumber ?? '',
    // The MARKING wins when there is one — the box physically carries it, so
    // once written it is the box's code for life (round 98). A receipt
    // claimed from birth has no marking and prints the client code as before.
    clientCodeWithLetter: origin.unclaimedMarking
      ? `${origin.unclaimedMarking}-${lot.letter}`
      : origin.clientCode
        ? `${origin.clientCode}-${lot.letter}`
        : '#UNKNOWN',
    unclaimed: !origin.clientCode,
    productZh: lot.productNameZh,
    productRu: lot.productNameRu,
    boxSeq: box.seqInLot,
    boxTotal: lot.boxCount,
    weightKg: perBoxWeight,
    dimsCm:
      lot.dimsMode === 'uniform'
        ? `${lot.boxLengthCm}×${lot.boxWidthCm}×${lot.boxHeightCm}`
        : null,
    shortCode: box.shortCode,
  };
}

/**
 * "These stickers were printed."
 *
 * Also in one place, because `/reports/label-prints` is somebody deciding
 * whether a box really was labelled, and two print paths writing two shapes of
 * audit row would make that report answer differently depending on which
 * button the operator happened to press.
 */
export async function recordLabelPrint(
  context: AuditContext,
  sheet: LabelSheet,
  shortCodes: string[],
): Promise<void> {
  // Re-asked in the WHERE: a lot marked QR-siz between the sheet being read
  // and this record keeps its cartons QR-siz — the one writer allowed to clear
  // that is the explicit «stikerlar yopishtirildi» (labels/qrless.ts).
  await db
    .update(boxes)
    .set({ labelPrintedAt: new Date() })
    .where(and(inArray(boxes.id, sheet.boxIds), sql`NOT ${qrlessBoxSql()}`));
  await writeAudit(
    db,
    { ...context, warehouseId: sheet.warehouseId },
    {
      entityType: 'receipt',
      entityId: sheet.receiptId,
      action: 'label_print',
      after: { count: shortCodes.length, boxes: shortCodes },
    },
  );
}

/**
 * The QR as inline SVG rather than a PNG data URI.
 *
 * A print engine does not necessarily wait for an <img> to decode before it
 * paints the page, and this sheet calls `window.print()` itself — a raster QR
 * would race the dialog and can come out blank on the first page. Inline SVG
 * is part of the DOM the moment the HTML arrives, so there is nothing to wait
 * for, it is a quarter the size of the PNG, and a thermal head at 203 dpi
 * renders vector edges cleanly where a scaled bitmap blurs the modules the
 * scanner has to read.
 */
export async function qrSvg(code: string): Promise<string> {
  return QRCode.toString(code, {
    type: 'svg',
    errorCorrectionLevel: QR_ECC,
    margin: QR_MARGIN_MODULES,
    // Sized by CSS; the viewBox is what matters.
    width: 400,
  });
}
