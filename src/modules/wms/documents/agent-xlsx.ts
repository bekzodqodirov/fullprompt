import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
      photoId: sql<string | null>`(
        SELECT a.id FROM attachments a
        WHERE a.entity_type = 'receipt_lot' AND a.entity_id = ${receiptLots.id} AND a.kind = 'photo'
        ORDER BY a.created_at LIMIT 1
      )`,
    })
    .from(loadPlanLines)
    .innerJoin(receiptLots, eq(loadPlanLines.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(eq(loadPlanLines.versionId, version.id))
    .orderBy(asc(loadPlanLines.id));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(`План v${versionNo}`);
  sheet.columns = [
    { header: 'Фото', key: 'photo', width: 14 },
    { header: 'Код', key: 'code', width: 14 },
    { header: 'Товар', key: 'product', width: 40 },
    { header: 'Коробок', key: 'boxCount', width: 10 },
    { header: 'кг', key: 'kg', width: 10 },
    { header: 'м³', key: 'm3', width: 10 },
    { header: 'кг/м³', key: 'density', width: 10 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.insertRow(1, [
    `План ${origin?.code} → ${dest?.code} · v${versionNo} · ${version.totalBoxes} кор. · ${version.totalKg} кг · ${version.totalM3} м³`,
  ]);
  sheet.getRow(1).font = { bold: true, size: 13 };

  // Photo thumbnails: exceljs embeds png/jpeg only; thumbs are webp — convert.
  const photoIds = lines.map((l) => l.photoId).filter(Boolean) as string[];
  const thumbs = new Map<string, Buffer>();
  if (photoIds.length) {
    const rows = await db
      .select()
      .from(attachments)
      .where(inArray(attachments.id, photoIds));
    const sharp = (await import('sharp')).default;
    for (const att of rows) {
      try {
        const bytes = await getStorage().get(att.thumb200Key ?? att.storageKey);
        thumbs.set(att.id, await sharp(bytes).jpeg({ quality: 70 }).toBuffer());
      } catch {
        /* photo unavailable — leave the cell empty */
      }
    }
  }

  let rowNo = 3;
  for (const { line, lot, clientCode, marking, photoId } of lines) {
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
    const thumb = photoId ? thumbs.get(photoId) : undefined;
    if (thumb) {
      const imageId = workbook.addImage({ buffer: thumb as unknown as ExcelJS.Buffer, extension: 'jpeg' });
      sheet.addImage(imageId, {
        tl: { col: 0.1, row: rowNo - 1 + 0.1 },
        ext: { width: 78, height: 72 },
      });
    }
    rowNo += 1;
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
