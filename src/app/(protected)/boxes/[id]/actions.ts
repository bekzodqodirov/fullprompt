'use server';

import { eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { boxes } from '@/modules/platform/db/schema';
import { authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { BoxStatusError, setBoxStatus, setBoxStatusSchema } from '@/modules/wms/boxes/status';

/**
 * Manager-level gate (DECISIONS #43 proxy): holders of `receipts.void` may
 * change box status.
 */
export async function setBoxStatusAction(input: unknown): Promise<{ ok: boolean; error?: string }> {
  const parsed = setBoxStatusSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const box = await db.query.boxes.findFirst({ where: eq(boxes.id, parsed.data.boxId) });
  if (!box) return { ok: false, error: 'box_not_found' };
  const actor = await authorize('receipts.void', {
    warehouseId: box.currentWarehouseId ?? undefined,
  });
  const meta = await requestMeta();
  try {
    await setBoxStatus(parsed.data, { actorId: actor.id, ...meta });
    return { ok: true };
  } catch (err) {
    if (err instanceof BoxStatusError) return { ok: false, error: err.code };
    throw err;
  }
}
