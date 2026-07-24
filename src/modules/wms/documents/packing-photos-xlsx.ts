import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { db } from '../../platform/db/client';
import {
  attachments,
  batches,
  boxes,
  clients,
  receiptLots,
  receipts,
  scanEvents,
  warehouses,
} from '../../platform/db/schema';
import { getStorage } from '../../platform/files/storage';

/**
 * Packing list WITH photos (owner's request, feedback round 8): after loading,
 * one row per lot actually ON the batch — code, product zh/ru, boxes, kg, m³ —
 * with every lot photo embedded to the right (same layout as the agent file).
 * Built from load scan events so it stays correct after unload/close.
 */
export async function buildPackingPhotosXlsx(batchId: string): Promise<Buffer | null> {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return null;
  const [origin, dest] = await Promise.all([
    db.query.warehouses.findFirst({ where: eq(warehouses.id, batch.originWarehouseId) }),
    db.query.warehouses.findFirst({ where: eq(warehouses.id, batch.destWarehouseId) }),
  ]);

  const rows = await db
    .select({
      lot: receiptLots,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
      loaded: sql<number>`count(DISTINCT ${boxes.id})`,
    })
    .from(scanEvents)
    .innerJoin(boxes, eq(scanEvents.boxId, boxes.id))
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(and(eq(scanEvents.batchId, batchId), eq(scanEvents.type, 'load')))
    .groupBy(receiptLots.id, clients.clientCode, receipts.unclaimedMarking)
    .orderBy(asc(receiptLots.letter));
  if (rows.length === 0) return null;

  const lotIds = rows.map((r) => r.lot.id);
  const photoRows = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.entityType, 'receipt_lot'),
        inArray(attachments.entityId, lotIds),
        eq(attachments.kind, 'photo'),
      ),
    )
    .orderBy(asc(attachments.createdAt));
  const photosByLot = new Map<string, string[]>();
  for (const att of photoRows) {
    photosByLot.set(att.entityId, [...(photosByLot.get(att.entityId) ?? []), att.id]);
  }
  const maxPhotos = Math.max(1, ...[...photosByLot.values()].map((ids) => ids.length));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('PACKING LIST');
  sheet.columns = [
    { header: 'Код', key: 'code', width: 14 },
    { header: 'Товар', key: 'product', width: 40 },
    { header: 'Коробок', key: 'boxCount', width: 10 },
    { header: 'кг', key: 'kg', width: 10 },
    { header: 'м³', key: 'm3', width: 10 },
    ...Array.from({ length: maxPhotos }, (_, i) => ({
      header: i === 0 ? 'Фото' : '',
      key: `photo${i}`,
      width: 14,
    })),
  ];
  sheet.getRow(1).font = { bold: true };

  let totalBoxes = 0;
  let totalKg = 0;
  let totalM3 = 0;
  for (const row of rows) {
    totalBoxes += Number(row.loaded);
    totalKg += (Number(row.lot.totalWeightKg) / row.lot.boxCount) * Number(row.loaded);
    totalM3 += (Number(row.lot.totalVolumeM3) / row.lot.boxCount) * Number(row.loaded);
  }
  sheet.insertRow(1, [
    `PACKING LIST · ${batch.code} · ${origin?.code} → ${dest?.code} · ${totalBoxes} кор. · ${totalKg.toFixed(1)} кг · ${totalM3.toFixed(2)} м³`,
  ]);
  sheet.getRow(1).font = { bold: true, size: 13 };

  // exceljs embeds png/jpeg only; thumbs are webp — convert.
  const thumbs = new Map<string, Buffer>();
  if (photoRows.length) {
    const sharp = (await import('sharp')).default;
    for (const att of photoRows) {
      try {
        const bytes = await getStorage().get(att.thumb200Key ?? att.storageKey);
        thumbs.set(att.id, await sharp(bytes).jpeg({ quality: 70 }).toBuffer());
      } catch {
        /* photo unavailable — leave the cell empty */
      }
    }
  }

  const PHOTO_START_COL = 5; // zero-based: right after м³
  let rowNo = 3;
  for (const { lot, clientCode, marking, loaded } of rows) {
    const kg = (Number(lot.totalWeightKg) / lot.boxCount) * Number(loaded);
    const m3 = (Number(lot.totalVolumeM3) / lot.boxCount) * Number(loaded);
    sheet.getRow(rowNo).values = {
      code: `${clientCode ?? marking ?? '?'}-${lot.letter ?? ''}`,
      product: `${lot.productNameZh}${lot.productNameRu ? ` (${lot.productNameRu})` : ''}`,
      boxCount: Number(loaded),
      kg: Number(kg.toFixed(1)),
      m3: Number(m3.toFixed(3)),
    };
    sheet.getRow(rowNo).height = 60;
    const photoIds = photosByLot.get(lot.id) ?? [];
    photoIds.forEach((photoId, i) => {
      const thumb = thumbs.get(photoId);
      if (!thumb) return;
      const imageId = workbook.addImage({
        buffer: thumb as unknown as ExcelJS.Buffer,
        extension: 'jpeg',
      });
      sheet.addImage(imageId, {
        tl: { col: PHOTO_START_COL + i + 0.1, row: rowNo - 1 + 0.1 },
        ext: { width: 78, height: 72 },
      });
    });
    rowNo += 1;
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
