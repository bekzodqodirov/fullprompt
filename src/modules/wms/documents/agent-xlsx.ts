import { DOC } from './labels';
import { and, asc, eq, inArray } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { db } from '../../platform/db/client';
import {
  attachments,
  clients,
  loadPlanLines,
  loadPlans,
  loadPlanVersions,
  receiptLots,
  receipts,
  warehouses,
} from '../../platform/db/schema';
import { getStorage } from '../../platform/files/storage';

/**
 * Agent approval Excel (W3, spec 6.3): one row per planned line with an
 * embedded box photo — the logist sends this file to the agent outside the
 * system (owner's rule) and records the verdict manually.
 */
export async function buildAgentXlsx(planId: string, versionNo: number): Promise<Buffer | null> {
  const plan = await db.query.loadPlans.findFirst({ where: eq(loadPlans.id, planId) });
  if (!plan) return null;
  const version = await db.query.loadPlanVersions.findFirst({
    where: and(eq(loadPlanVersions.planId, planId), eq(loadPlanVersions.versionNo, versionNo)),
  });
  if (!version) return null;

  const [origin, dest] = await Promise.all([
    db.query.warehouses.findFirst({ where: eq(warehouses.id, plan.originWarehouseId) }),
    db.query.warehouses.findFirst({ where: eq(warehouses.id, plan.destWarehouseId) }),
  ]);

  const lines = await db
    .select({
      line: loadPlanLines,
      lot: receiptLots,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
    })
    .from(loadPlanLines)
    .innerJoin(receiptLots, eq(loadPlanLines.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(eq(loadPlanLines.versionId, version.id))
    .orderBy(asc(loadPlanLines.id));

  // ALL photos of every lot go side by side after the data columns (owner's
  // request — one photo was not enough for the agent to judge the cargo).
  const lotIds = [...new Set(lines.map((l) => l.lot.id))];
  const photoRows = lotIds.length
    ? await db
        .select()
        .from(attachments)
        .where(
          and(
            eq(attachments.entityType, 'receipt_lot'),
            inArray(attachments.entityId, lotIds),
            eq(attachments.kind, 'photo'),
          ),
        )
        .orderBy(asc(attachments.createdAt))
    : [];
  const photosByLot = new Map<string, string[]>();
  for (const att of photoRows) {
    photosByLot.set(att.entityId, [...(photosByLot.get(att.entityId) ?? []), att.id]);
  }
  const maxPhotos = Math.max(1, ...[...photosByLot.values()].map((ids) => ids.length));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(`План v${versionNo}`);
  sheet.columns = [
    { header: DOC.code, key: 'code', width: 14 },
    { header: DOC.product, key: 'product', width: 40 },
    { header: DOC.boxes, key: 'boxCount', width: 10 },
    { header: DOC.kg, key: 'kg', width: 10 },
    { header: DOC.m3, key: 'm3', width: 10 },
    { header: DOC.density, key: 'density', width: 10 },
    ...Array.from({ length: maxPhotos }, (_, i) => ({
      header: i === 0 ? DOC.photo : '',
      key: `photo${i}`,
      width: 14,
    })),
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.insertRow(1, [
    `План ${origin?.code} → ${dest?.code} · v${versionNo} · ${version.totalBoxes} кор. · ${version.totalKg} кг · ${version.totalM3} м³`,
  ]);
  sheet.getRow(1).font = { bold: true, size: 13 };

  // Photo thumbnails: exceljs embeds png/jpeg only; thumbs are webp — convert.
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

  const PHOTO_START_COL = 6; // zero-based: right after кг/м³
  let rowNo = 3;
  for (const { line, lot, clientCode, marking } of lines) {
    const density =
      Number(line.plannedM3) > 0 ? Math.round(Number(line.plannedKg) / Number(line.plannedM3)) : '';
    sheet.getRow(rowNo).values = {
      code: `${clientCode ?? marking ?? '?'}-${lot.letter ?? ''}`,
      product: `${lot.productNameZh}${lot.productNameRu ? ` (${lot.productNameRu})` : ''}`,
      boxCount: line.plannedBoxCount,
      kg: Number(line.plannedKg),
      m3: Number(line.plannedM3),
      density,
    };
    sheet.getRow(rowNo).height = 60;
    const photoIds = photosByLot.get(lot.id) ?? [];
    photoIds.forEach((photoId, i) => {
      const thumb = thumbs.get(photoId);
      if (!thumb) return;
      const imageId = workbook.addImage({ buffer: thumb as unknown as ExcelJS.Buffer, extension: 'jpeg' });
      sheet.addImage(imageId, {
        tl: { col: PHOTO_START_COL + i + 0.1, row: rowNo - 1 + 0.1 },
        ext: { width: 78, height: 72 },
      });
    });
    rowNo += 1;
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
