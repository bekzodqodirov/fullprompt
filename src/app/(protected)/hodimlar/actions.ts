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
import {
  editNoLoginPerson,
  mintNoLoginPerson,
  setNoLoginPersonActive,
  UserWriteError,
} from '@/modules/platform/users/service';

export interface StaffFormState {
  ok?: boolean;
  /** A refusal code — the screen prints `hodimlar.refusal.<code>` (a union-derived map, never a bare code). */
  error?: string;
  /** The month a `kpi_month_refused` names, and why. */
  month?: string;
  reason?: string;
  paidUsd?: number;
  /** The person a mint just wrote — the form lands on their card (2b). */
  id?: string;
  /** `same_name`: who is already listed under the name (≤ 5), each a link. */
  matches?: { id: string; name: string; active: boolean; loginEnabled: boolean }[];
  /** `same_name`: how many more than `matches` share it. */
  more?: number;
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

// ---------------------------------------------------------------------------
// A person who never signs in (0120, the owner's 2b). The door is the page's
// own (`maySeeStaffMoney` = `finance.expenses`, the staff account's); the
// posted values are forged until parsed (#514), and the SERVICE decides —
// platform/users/service.ts is the one writer of a person (#531).
// ---------------------------------------------------------------------------

const personInput = z.object({ fullName: z.string().trim().min(1).max(200), phone: z.string().max(40) });
const mintInput = personInput.extend({ confirmSameName: z.boolean() });

/** A failed parse in words: the phone box or the name box. */
function personInputRefusal(error: z.ZodError): StaffFormState {
  return { error: error.issues[0]?.path[0] === 'phone' ? 'bad_phone' : 'name_required' };
}

/** A writer's refusal, or the deploy-morning sentence; anything else is not ours to name. */
function personRefusal(err: unknown): StaffFormState | null {
  if (err instanceof UserWriteError) {
    return {
      error: err.code,
      matches: err.same?.matches,
      more: err.same ? err.same.total - err.same.matches.length : undefined,
    };
  }
  if (isServerBehind(err)) {
    logger.error({ err }, '[hodimlar] server behind — migration 0120 not applied');
    return { error: 'server_behind' };
  }
  return null;
}

/** «➕ Tizimga kirmaydigan hodim qo'shish». */
export async function mintPersonAction(input: {
  fullName: string;
  phone: string;
  confirmSameName: boolean;
}): Promise<StaffFormState> {
  const actor = await getActor();
  if (!actor) return { error: 'unauthenticated' };
  if (!maySeeStaffMoney(actor.permissions)) return { error: 'forbidden' };
  const parsed = mintInput.safeParse(input);
  if (!parsed.success) return personInputRefusal(parsed.error);
  const meta = await requestMeta();
  let id: string;
  try {
    ({ id } = await mintNoLoginPerson(parsed.data, { actorId: actor.id, ...meta }));
  } catch (err) {
    const refusal = personRefusal(err);
    if (refusal) return refusal;
    throw err;
  }
  revalidatePath('/hodimlar');
  revalidatePath('/admin/users');
  return { ok: true, id };
}

/** «✏️ Ism, telefon» on a no-login person's card. */
export async function editPersonAction(id: string, input: { fullName: string; phone: string }): Promise<StaffFormState> {
  const actor = await getActor();
  if (!actor) return { error: 'unauthenticated' };
  if (!maySeeStaffMoney(actor.permissions)) return { error: 'forbidden' };
  if (!uuid.safeParse(id).success) return { error: 'not_found' };
  const parsed = personInput.safeParse(input);
  if (!parsed.success) return personInputRefusal(parsed.error);
  const meta = await requestMeta();
  try {
    await editNoLoginPerson(id, parsed.data, { actorId: actor.id, ...meta });
  } catch (err) {
    const refusal = personRefusal(err);
    if (refusal) return refusal;
    throw err;
  }
  revalidatePath('/hodimlar');
  revalidatePath('/admin/users');
  return { ok: true };
}

/** «Ishdan ketdi» / «Qayta faollashtirish» on a no-login person's card. */
export async function setPersonActiveAction(id: string, active: boolean): Promise<StaffFormState> {
  const actor = await getActor();
  if (!actor) return { error: 'unauthenticated' };
  if (!maySeeStaffMoney(actor.permissions)) return { error: 'forbidden' };
  if (!uuid.safeParse(id).success || typeof active !== 'boolean') return { error: 'not_found' };
  const meta = await requestMeta();
  try {
    await setNoLoginPersonActive(id, active, { actorId: actor.id, ...meta });
  } catch (err) {
    const refusal = personRefusal(err);
    if (refusal) return refusal;
    throw err;
  }
  revalidatePath('/hodimlar');
  revalidatePath('/admin/users');
  return { ok: true };
}
