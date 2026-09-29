'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getActor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { db } from '@/modules/platform/db/client';
import { mayEditKpiTable, mayPayCommission, maySeeStaffMoney } from '@/modules/wms/staff/door';
import { stampToCurrentSeller } from '@/modules/wms/staff/stamp';
import { KpiError, payKpi, setStaffCategory } from '@/modules/wms/staff/kpi-service';
import { KpiTableRefusal, parseKpiGridPost, saveKpiTable } from '@/modules/wms/staff/kpi-table';
import type { KpiCell } from '@/modules/wms/staff/kpi-engine';

export interface StaffFormState {
  ok?: boolean;
  /** A refusal code — the screen prints `hodimlar.refusal.<code>` (a union-derived map, never a bare code). */
  error?: string;
  /** The month a `kpi_month_refused` names, and why. */
  month?: string;
  reason?: string;
  paidUsd?: number;
}

const uuid = z.string().uuid();

/**
 * «KPI to'lash» — the kassa holder who may also see whose commission it is
 * (`mayPayCommission`, the same pair the upsale payout asks). The AMOUNT is
 * the server's: `expectedUsd` is only what the payer SAW, and a figure that
 * moved in between is refused rather than paid.
 */
export async function payKpiAction(
  sellerId: string,
  input: { accountId: string; currency: string; expenseDate: string; expectedUsd: number; note?: string },
): Promise<StaffFormState> {
  const actor = await getActor();
  if (!actor) return { error: 'unauthenticated' };
  if (!mayPayCommission(actor)) return { error: 'forbidden' };
  // A posted id is a forged post until proven (#514); the service re-checks it exists.
  if (!uuid.safeParse(sellerId).success || !uuid.safeParse(input.accountId).success) return { error: 'not_found' };
  if (!Number.isFinite(input.expectedUsd)) return { error: 'amount_moved' };
  const meta = await requestMeta();
  try {
    const res = await payKpi(sellerId, input, { actorId: actor.id, ...meta });
    revalidatePath('/hodimlar');
    revalidatePath('/accounting/expenses');
    return { ok: true, paidUsd: res.paidUsd };
  } catch (err) {
    if (err instanceof KpiError) return { error: err.code, month: err.month, reason: err.reason };
    // 0117's tables. On deploy morning this screen says a sentence (#472).
    if (isServerBehind(err)) {
      logger.error({ err }, '[hodimlar] server behind — migration 0117 not applied');
      return { error: 'server_behind' };
    }
    throw err;
  }
}

/** The table editor: ONE full grid as a new version (`admin.settings.manage`). */
export async function saveKpiTableAction(_prev: StaffFormState, formData: FormData): Promise<StaffFormState> {
  const actor = await getActor();
  if (!actor) return { error: 'unauthenticated' };
  if (!mayEditKpiTable(actor)) return { error: 'forbidden' };

  let cells: KpiCell[] | null;
  try {
    // The one pure parser (kpi-table.ts): a blank cell is refused, never $0.
    cells = parseKpiGridPost(JSON.parse(String(formData.get('grid') ?? '[]')) as unknown);
  } catch {
    return { error: 'grid_empty' };
  }
  if (!cells) return { error: 'grid_empty' };
  const meta = await requestMeta();
  try {
    await saveKpiTable(cells, String(formData.get('month') ?? ''), { actorId: actor.id, ...meta });
    revalidatePath('/hodimlar');
    return { ok: true };
  } catch (err) {
    if (err instanceof KpiTableRefusal) return { error: err.code };
    if (isServerBehind(err)) return { error: 'server_behind' };
    throw err;
  }
}

/** The KPI payout's and the salary's categories — a company setting, the upsale picker's door. */
export async function setStaffCategoryAction(_prev: StaffFormState, formData: FormData): Promise<StaffFormState> {
  const actor = await getActor();
  if (!actor) return { error: 'unauthenticated' };
  if (!mayEditKpiTable(actor)) return { error: 'forbidden' };
  const key = String(formData.get('key') ?? '');
  // Exactly the two keys this screen owns — never a setting named by the post.
  if (key !== 'kpi_expense_category_id' && key !== 'salary_expense_category_id') return { error: 'forbidden' };
  const meta = await requestMeta();
  try {
    await setStaffCategory(key, String(formData.get('categoryId') ?? ''), { actorId: actor.id, ...meta });
    revalidatePath('/hodimlar');
    return { ok: true };
  } catch (err) {
    if (err instanceof KpiError) return { error: err.code };
    throw err;
  }
}

/**
 * «Sotuvchisiz yuk»'s repair: a client whose card names a seller while some
 * of its receipts still carry none (a prixod confirmed in the very moment the
 * first seller was named — `unstampedCargo`'s `currentSellerId`). The button
 * applies the decision the client card already holds and chooses nobody: the
 * seller is re-read from the client row, never taken from the post. Asked by
 * the page's own door (`maySeeStaffMoney`), the list's only reader.
 */
export async function stampClientCargoAction(_prev: StaffFormState, formData: FormData): Promise<StaffFormState> {
  const actor = await getActor();
  if (!actor) return { error: 'unauthenticated' };
  if (!maySeeStaffMoney(actor.permissions)) return { error: 'forbidden' };
  const clientId = String(formData.get('clientId') ?? '');
  if (!uuid.safeParse(clientId).success) return { error: 'not_found' };
  const meta = await requestMeta();
  try {
    const res = await stampToCurrentSeller(db, clientId, { actorId: actor.id, ...meta });
    if (!res) return { error: 'no_seller' };
    revalidatePath('/hodimlar');
    return { ok: true };
  } catch (err) {
    if (isServerBehind(err)) return { error: 'server_behind' };
    throw err;
  }
}
