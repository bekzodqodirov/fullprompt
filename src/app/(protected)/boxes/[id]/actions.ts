'use server';

import { eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { boxes } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { BoxStatusError, setBoxStatus, setBoxStatusSchema } from '@/modules/wms/boxes/status';

/**
 * Manager-level gate (DECISIONS #43 proxy): holders of `receipts.void` may
 * change box status — authorised AT the box's warehouse, or, for a carton
 * lost on the road that stands in none, at the warehouse it is being
 * restored into (the manager says where it turned up; U38).
 */
export async function setBoxStatusAction(
  input: unknown,
): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const parsed = setBoxStatusSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const box = await db.query.boxes.findFirst({ where: eq(boxes.id, parsed.data.boxId) });
  if (!box) return { ok: false, error: 'box_not_found' };
  let actor;
  try {
    actor = await authorize('receipts.void', {
      warehouseId: box.currentWarehouseId ?? parsed.data.foundAtWarehouseId ?? undefined,
    });
  } catch (err) {
    // An AuthError thrown from an onClick has no boundary and reaches the
    // manager as nothing at all.
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    await setBoxStatus(parsed.data, { actorId: actor.id, ...meta });
    return { ok: true };
  } catch (err) {
    if (err instanceof BoxStatusError) return { ok: false, error: err.code, detail: err.detail };
    throw err;
  }
}
