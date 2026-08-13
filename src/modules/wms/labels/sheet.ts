import { and, asc, eq, inArray } from 'drizzle-orm';
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
import type { LabelData } from './renderer';

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
      filter.boxId
        ? and(inArray(boxes.lotId, lotIds), eq(boxes.id, filter.boxId))
        : inArray(boxes.lotId, lotIds),
    )
    .orderBy(asc(boxes.seqInLot));
  if (boxRows.length === 0) return null;

  const dateLocal = new Intl.DateTimeFormat('ru-RU', {
    timeZone: warehouse.timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(receipt.receivedAt);

  const lotById = new Map(lots.map((l) => [l.id, l]));
  const labels: LabelData[] = boxRows.map((box) => {
    const lot = lotById.get(box.lotId)!;
    const perBoxWeight =
      lot.dimsMode === 'uniform' && lot.boxWeightKg
        ? lot.boxWeightKg
        : (Number(lot.totalWeightKg) / lot.boxCount).toFixed(1);
    return {
      warehouseCode: warehouse.code,
      dateLocal,
      receiptNumber: receipt.number ?? '',
      // The MARKING wins when there is one — the box physically carries it, so
      // once written it is the box's code for life (round 98). A receipt
      // claimed from birth has no marking and prints the client code as before.
      clientCodeWithLetter: receipt.unclaimedMarking
        ? `${receipt.unclaimedMarking}-${lot.letter}`
        : client
          ? `${client.clientCode}-${lot.letter}`
          : '#UNKNOWN',
      unclaimed: !client,
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
  });

  return {
    receiptId,
    receiptNumber: receipt.number ?? '',
    warehouseId: warehouse.id,
    warehouseCode: warehouse.code,
    labels,
    boxIds: boxRows.map((b) => b.id),
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
  await db
    .update(boxes)
    .set({ labelPrintedAt: new Date() })
    .where(inArray(boxes.id, sheet.boxIds));
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
    errorCorrectionLevel: 'M',
    margin: 2,
    // Sized by CSS; the viewBox is what matters.
    width: 400,
  });
}
