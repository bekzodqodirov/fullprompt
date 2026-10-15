'use server';

import { revalidatePath } from 'next/cache';
import { getActor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { isUuidShaped } from '@/modules/platform/audit/fields';
import { companyMoneySight } from '@/modules/wms/finance/scope';
import { mayPickTill } from '@/modules/wms/accounting/till-door';
import { ackTwinPair, TwinAckError } from '@/modules/wms/accounting/twins';

/**
 * «✓ Ikki xil pul» on the spending map. The door is the map's own
 * (`companyMoneySight`) AND the expense book's (`mayPickTill`) — the people
 * who answer the twin warning at the save answer it here too; the button is
 * drawn for nobody else. The pair is re-decided by the service from the rows
 * as they stand: two posted ids are a forged post until then.
 */
export async function ackTwinPairAction(input: {
  costId: string;
  expenseId: string;
}): Promise<{ ok: boolean; error?: 'forbidden' | 'not_found' | 'not_a_twin' }> {
  const actor = await getActor();
  if (!actor || !companyMoneySight(actor) || !mayPickTill(actor.permissions)) return { ok: false, error: 'forbidden' };
  if (!isUuidShaped(input?.costId) || !isUuidShaped(input?.expenseId)) return { ok: false, error: 'not_found' };
  try {
    const meta = await requestMeta();
    await ackTwinPair(input.costId, input.expenseId, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof TwinAckError) return { ok: false, error: err.code };
    throw err;
  }
  revalidatePath('/accounting/sarflar');
  return { ok: true };
}
