'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { setSourceWebhookSecret } from '@/modules/wms/crm/inbound';
import { CrmError } from '@/modules/wms/crm/service';

export interface DoorActionResult {
  ok?: boolean;
  error?: string;
}

/**
 * Switching a platform's own lead form on or off.
 *
 * Gated `admin.settings.manage`, NOT `crm.manage` (which opens this screen):
 * reading which adverts are running is a supervision job, and minting a
 * password that writes into the funnel is a settings one. The button is drawn
 * only for holders and the service checks again — a hidden control is a
 * request, never a permission (#519's rule for published templates).
 *
 * Catches, because migration 0068 adds the column this writes and the one
 * machine where the schema is behind is production on deploy morning (#472).
 */
export async function setSourceWebhookAction(
  key: string,
  enabled: boolean,
): Promise<DoorActionResult> {
  try {
    const actor = await authorize('admin.settings.manage');
    await setSourceWebhookSecret(key, enabled, { actorId: actor.id, ...(await requestMeta()) });
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    if (err instanceof CrmError) return { error: err.code };
    console.error('[leads-in] webhook toggle failed', err);
    return { error: 'failed' };
  }
  revalidatePath('/crm/kelganlar');
  return { ok: true };
}
