'use server';

import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { attachments, batches, boxes, receiptLots } from '@/modules/platform/db/schema';
import { requestMeta } from '@/modules/platform/auth/session';
import { getStorage } from '@/modules/platform/files/storage';
import { requireActor } from '@/modules/platform/rbac/authorize';
import { mayOpenBatchCard } from '@/modules/wms/batches/card-door';
import { batchMemberFilter } from '@/modules/wms/scanning/unload';
import {
  saveTnved,
  suggestTnved,
  TnvedError,
  type TnvedSuggestion,
} from '@/modules/wms/tnved/service';

async function vedActor() {
  const actor = await requireActor();
  if (!actor.permissions.has('ved.docs') && !actor.permissions.has('plans.manage')) return null;
  return actor;
}

/**
 * The model's guess for one lot of THIS truck.
 *
 * It took a lot id alone, so anybody holding the permission could name any
 * lot in the company: its photo was read and sent to the model, and the AI
 * budget paid for it. Now the truck's card door is asked (its two ends,
 * `mayOpenBatchCard`), and the lot must have a carton that is a member of the
 * truck by the invoice's own rule (`batchMemberFilter`) — both before the
 * photo is touched. A truck that is not there answers like one the person may
 * not open, so the refusal says nothing about which ids exist.
 */
export async function suggestTnvedForLotAction(
  batchId: string,
  lotId: string,
): Promise<{ ok: boolean; suggestion?: TnvedSuggestion; error?: string }> {
  const actor = await vedActor();
  if (!actor) return { ok: false, error: 'forbidden' };
  const batch = await db.query.batches.findFirst({
    where: eq(batches.id, batchId),
    columns: { originWarehouseId: true, destWarehouseId: true },
  });
  if (!batch || !mayOpenBatchCard(actor, batch)) return { ok: false, error: 'forbidden' };
  const lot = await db.query.receiptLots.findFirst({ where: eq(receiptLots.id, lotId) });
  if (!lot) return { ok: false, error: 'not_found' };
  const [aboard] = await db
    .select({ id: boxes.id })
    .from(boxes)
    .where(and(eq(boxes.lotId, lotId), batchMemberFilter(batchId)))
    .limit(1);
  if (!aboard) return { ok: false, error: 'forbidden' };

  // First photo of the lot, smaller variant preferred — enough for the AI.
  const photoRow = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.entityType, 'receipt_lot'),
        eq(attachments.entityId, lotId),
        eq(attachments.kind, 'photo'),
      ),
    )
    .orderBy(asc(attachments.createdAt))
    .limit(1);
  let photo: { data: Buffer; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' } | null = null;
  const att = photoRow[0];
  if (att) {
    try {
      const key = att.thumb800Key ?? att.storageKey;
      const data = await getStorage().get(key);
      const mediaType = key.endsWith('.webp')
        ? ('image/webp' as const)
        : att.contentType === 'image/png'
          ? ('image/png' as const)
          : ('image/jpeg' as const);
      photo = { data, mediaType };
    } catch {
      /* photo unavailable — classify from the name alone */
    }
  }

  try {
    const suggestion = await suggestTnved({
      nameZh: lot.productNameZh,
      nameRu: lot.productNameRu,
      photo,
    });
    return { ok: true, suggestion };
  } catch (err) {
    if (err instanceof TnvedError) return { ok: false, error: err.code };
    throw err;
  }
}

export async function saveTnvedAction(
  entries: {
    nameZh: string;
    nameRu: string | null;
    code: string;
    source: 'manual' | 'ai';
    aiReasoning?: string | null;
  }[],
): Promise<{ ok: boolean; saved?: number; error?: string }> {
  const actor = await vedActor();
  if (!actor) return { ok: false, error: 'forbidden' };
  const meta = await requestMeta();
  let saved = 0;
  try {
    for (const entry of entries) {
      if (!entry.code.trim()) continue;
      await saveTnved(entry, { actorId: actor.id, ...meta });
      saved += 1;
    }
    return { ok: true, saved };
  } catch (err) {
    if (err instanceof TnvedError) return { ok: false, error: err.code };
    throw err;
  }
}
