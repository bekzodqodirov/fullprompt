'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { mayClassifyFx } from '@/modules/wms/finance/fx-door';
import { maySeeStaffMoney } from '@/modules/wms/partners/staff';
import { closeAllLegacyFx, closeLegacyFxResidue, FxLegacyError } from '@/modules/wms/finance/fx-legacy';

export interface FxLegacyResult {
  ok: boolean;
  error?: string;
  closed?: number;
  changed?: number;
}

/**
 * «Kurs qoldiqlari»'s doors (0103, design §5.5.8): `finance.manage` AND
 * `finance.reports` — a kurs farqi row moves the P&L, and the VED holds the
 * first without the second. Staff rows also need `finance.expenses`, judged
 * by the service on the ROW (M3a).
 */
async function door() {
  const actor = await authorize('finance.manage');
  if (!mayClassifyFx(actor.permissions)) throw new AuthError('fx_forbidden', 'forbidden');
  return actor;
}

function done() {
  revalidatePath('/accounting/kurs-farqi');
  revalidatePath('/accounting/pnl');
  revalidatePath('/finance');
  revalidatePath('/kontragentlar');
}

const closeSchema = z.object({
  ledger: z.enum(['client', 'partner']),
  ownerId: z.string().uuid(),
  anchorId: z.string().uuid(),
  currency: z.string().trim().min(3).max(3),
});

export async function closeLegacyAction(input: unknown): Promise<FxLegacyResult> {
  const parsed = closeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  let actor;
  try {
    actor = await door();
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
  try {
    await closeLegacyFxResidue(parsed.data, { actorId: actor.id, ...(await requestMeta()) }, {
      mayClassify: mayClassifyFx(actor.permissions),
      maySeeStaff: maySeeStaffMoney(actor.permissions),
    });
  } catch (err) {
    if (err instanceof FxLegacyError) return { ok: false, error: err.code };
    throw err;
  }
  done();
  return { ok: true };
}

export async function closeAllLegacyAction(): Promise<FxLegacyResult> {
  let actor;
  try {
    actor = await door();
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
  try {
    const result = await closeAllLegacyFx({ actorId: actor.id, ...(await requestMeta()) }, {
      mayClassify: mayClassifyFx(actor.permissions),
      maySeeStaff: maySeeStaffMoney(actor.permissions),
    });
    done();
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof FxLegacyError) return { ok: false, error: err.code };
    throw err;
  }
}
