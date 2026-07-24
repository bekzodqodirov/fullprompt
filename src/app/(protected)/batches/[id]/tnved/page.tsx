import { and, eq, inArray, sql } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { attachments, batches, boxes, receiptLots, scanEvents } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { tnvedFor, productKey } from '@/modules/wms/tnved/service';
import { BackLink } from '@/components/back-link';
import { TnvedEditor, type TnvedRow } from './tnved-editor';

/** ТНВЭД codes for a batch's products (Phase 1.5) — memory-first + AI. */
export default async function BatchTnvedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('ved.docs') && !actor.permissions.has('plans.manage')) redirect('/');
  const t = await getTranslations('tnved');

  const batch = await db.query.batches.findFirst({ where: eq(batches.id, id) });
  if (!batch) notFound();

  // Lots on the batch: current members while forming/loading, load-scan
  // history afterwards (so the page works after unload/close too).
  const current = await db
    .selectDistinct({ lot: receiptLots })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(eq(boxes.currentBatchId, id));
  const scanned = current.length
    ? []
    : await db
        .selectDistinct({ lot: receiptLots })
        .from(scanEvents)
        .innerJoin(boxes, eq(scanEvents.boxId, boxes.id))
        .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
        .where(and(eq(scanEvents.batchId, id), eq(scanEvents.type, 'load')));
  const lots = (current.length ? current : scanned)
    .map((r) => r.lot)
    .sort((a, b) => (a.letter ?? '').localeCompare(b.letter ?? ''));

  const lotIds = lots.map((l) => l.id);
  const photoRows = lotIds.length
    ? await db
        .select({
          entityId: attachments.entityId,
          photoId: sql<string>`(array_agg(${attachments.id} ORDER BY ${attachments.createdAt}))[1]`,
        })
        .from(attachments)
        .where(
          and(
            eq(attachments.entityType, 'receipt_lot'),
            inArray(attachments.entityId, lotIds),
            eq(attachments.kind, 'photo'),
          ),
        )
        .groupBy(attachments.entityId)
    : [];
  const photoByLot = new Map(photoRows.map((r) => [r.entityId, r.photoId]));
  const memory = await tnvedFor(lots.map((l) => l.productNameZh));

  // One row per distinct product name — the code belongs to the PRODUCT.
  const byProduct = new Map<string, TnvedRow>();
  for (const lot of lots) {
    const key = productKey(lot.productNameZh);
    const existing = byProduct.get(key);
    if (existing) {
      existing.boxCount += lot.boxCount;
      if (!existing.photoId) existing.photoId = photoByLot.get(lot.id) ?? null;
      continue;
    }
    const stored = memory.get(key);
    byProduct.set(key, {
      lotId: lot.id,
      nameZh: lot.productNameZh,
      nameRu: lot.productNameRu ?? stored?.productNameRu ?? null,
      photoId: photoByLot.get(lot.id) ?? null,
      boxCount: lot.boxCount,
      code: stored?.tnvedCode ?? '',
      source: stored ? (stored.source as 'manual' | 'ai') : null,
    });
  }

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-2xl">
      <BackLink href={`/batches/${id}`} label={batch.code} />
      <h1 className="text-xl font-bold">🏷 {t('title')}</h1>
      {byProduct.size === 0 ? (
        <p className="text-sm text-gray-500">{t('empty')}</p>
      ) : (
        <TnvedEditor rows={[...byProduct.values()]} />
      )}
    </div>
  );
}
