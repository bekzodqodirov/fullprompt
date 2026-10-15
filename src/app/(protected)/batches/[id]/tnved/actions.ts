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
  productKey,
  saveTnved,
  suggestTnved,
  TnvedError,
  type TnvedSuggestion,
} from '@/modules/wms/tnved/service';
import { batchTnvedProducts } from '@/modules/wms/tnved/batch-lots';
import { isBusyError, isServerBehind } from '@/modules/platform/db/errors';
import { isUuidShaped } from '@/modules/platform/audit/fields';
import {
  CompositionError,
  mayWriteComposition,
  paperCompositionsFor,
  setLineCodes,
} from '@/modules/wms/receipts/lot-composition';

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
  // A malformed id is a forged post: «forbidden», never a 22P02 error page.
  if (!isUuidShaped(batchId) || !isUuidShaped(lotId)) return { ok: false, error: 'forbidden' };
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

/**
 * Save codes into the shared memory — PRODUCT rows of THIS truck only.
 *
 * It took a list of names alone and asked no truck door at all, so any
 * holder of the permission could write any name into the company-wide
 * memory (the lot tarkibi judge's Access-5). Now the truck's card door is
 * asked, `departed` is derived from the truck row, and a name that is not a
 * product row of `batchTnvedProducts` on this truck is refused
 * `not_on_truck` — which is also what makes «a composition line's code never
 * writes the memory» a server rule and not a promise of the editor (#531).
 */
export async function saveTnvedAction(
  batchId: string,
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
  if (!isUuidShaped(batchId)) return { ok: false, error: 'forbidden' };
  const batch = await db.query.batches.findFirst({
    where: eq(batches.id, batchId),
    columns: { originWarehouseId: true, destWarehouseId: true, departedAt: true },
  });
  if (!batch || !mayOpenBatchCard(actor, batch)) return { ok: false, error: 'forbidden' };
  const products = await batchTnvedProducts(batchId, batch.departedAt !== null);
  const productKeys = new Set(products.filter((row) => !row.line).map((row) => productKey(row.nameZh)));
  if (entries.some((entry) => entry.code.trim() && !productKeys.has(productKey(entry.nameZh)))) {
    return { ok: false, error: 'not_on_truck' };
  }
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

/**
 * The Bojxona tab's codes for composition LINES (lot tarkibi §5): stored on
 * the line, never in the memory. The truck's card door, the composition's
 * writer, and every lot must have a carton that is a member of THIS truck. A
 * ticked truck prints its frozen copy, so its line codes are read-only here
 * (`frozen`). Entries are GROUPED per lot into ONE `setLineCodes` call each —
 * two calls for one lot would refuse the second by the first's revision bump
 * — and the revisions of the lots that DID commit travel with the first
 * refusal, so the editor never keeps posting dead ones. No revalidatePath:
 * the editor refreshes after both saves (#1242).
 */
export async function saveLineCodesAction(
  batchId: string,
  entries: { lotId: string; lineId: string; rev: number; code: string }[],
): Promise<{ ok: boolean; revs: Record<string, number>; saved?: number; error?: string }> {
  const revs: Record<string, number> = {};
  const actor = await vedActor();
  if (!actor || !mayWriteComposition(actor.permissions)) return { ok: false, revs, error: 'forbidden' };
  // Every id is bound into a uuid comparison below: a malformed one is a
  // forged post and answers «forbidden», never a 22P02 error page.
  if (!isUuidShaped(batchId) || entries.some((e) => !isUuidShaped(e.lotId) || !isUuidShaped(e.lineId))) {
    return { ok: false, revs, error: 'forbidden' };
  }
  const batch = await db.query.batches.findFirst({
    where: eq(batches.id, batchId),
    columns: { originWarehouseId: true, destWarehouseId: true },
  });
  if (!batch || !mayOpenBatchCard(actor, batch)) return { ok: false, revs, error: 'forbidden' };
  const byLot = new Map<string, { rev: number; codes: { lineId: string; code: string }[] }>();
  for (const entry of entries) {
    const group = byLot.get(entry.lotId) ?? { rev: entry.rev, codes: [] };
    group.codes.push({ lineId: entry.lineId, code: entry.code });
    byLot.set(entry.lotId, group);
  }
  for (const lotId of byLot.keys()) {
    const [aboard] = await db
      .select({ id: boxes.id })
      .from(boxes)
      .where(and(eq(boxes.lotId, lotId), batchMemberFilter(batchId)))
      .limit(1);
    if (!aboard) return { ok: false, revs, error: 'forbidden' };
  }
  const papers = await paperCompositionsFor(batchId, [...byLot.keys()]);
  if ([...papers.values()].some((comp) => comp.frozen)) return { ok: false, revs, error: 'frozen' };
  const meta = await requestMeta();
  let saved = 0;
  for (const [lotId, group] of byLot) {
    try {
      const res = await setLineCodes({ lotId, seenRev: group.rev, codes: group.codes }, actor, {
        actorId: actor.id,
        ...meta,
      });
      revs[lotId] = res.rev;
      saved += group.codes.length;
    } catch (err) {
      if (err instanceof CompositionError) return { ok: false, revs, saved, error: err.code };
      if (isBusyError(err)) return { ok: false, revs, saved, error: 'busy' };
      if (isServerBehind(err)) return { ok: false, revs, saved, error: 'server_behind' };
      throw err;
    }
  }
  return { ok: true, revs, saved };
}
