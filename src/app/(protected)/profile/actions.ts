'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/modules/platform/db/client';
import { users } from '@/modules/platform/db/schema';
import { getSessionUser, requestMeta } from '@/modules/platform/auth/session';
import { writeAudit } from '@/modules/platform/audit/service';
import { listFromGroups, MUTE_GROUPS, type MuteGroup } from '@/modules/platform/notifications/mutes';
import { CallsError, createCallDevice, revokeCallDevice } from '@/modules/wms/calls/service';
import { enqueue, JOB_PROCESS_EVENTS } from '@/modules/platform/jobs/boss';
import { amountRefusal } from '@/modules/wms/finance/money-bounds';
import {
  ExpenseRequestError,
  expenseRequestSchema,
  reporterWarehouses,
  requestExpense,
} from '@/modules/wms/accounting/expense-requests';

/** Self-service Telegram mute settings (spec §11) — no special permission. */
export async function setNotificationMutesAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;

  const all = formData.get('mute_all') === 'on';
  const groups = Object.fromEntries(
    (Object.keys(MUTE_GROUPS) as MuteGroup[]).map((g) => [g, formData.get(`mute_${g}`) === 'on']),
  ) as Record<MuteGroup, boolean>;
  const list = listFromGroups(all, groups);

  const before = await db.query.users.findFirst({
    columns: { mutedNotificationTypes: true },
    where: eq(users.id, user.id),
  });
  await db.update(users).set({ mutedNotificationTypes: list }).where(eq(users.id, user.id));
  const meta = await requestMeta();
  await writeAudit(db, { actorId: user.id, ...meta }, {
    entityType: 'user',
    entityId: user.id,
    action: 'update',
    before: { mutedNotificationTypes: before?.mutedNotificationTypes ?? [] },
    after: { mutedNotificationTypes: list },
  });
  revalidatePath('/profile');
}

export interface CallDeviceState {
  ok?: boolean;
  error?: string;
}

/** Own phone only — the service takes the actor, never a chosen user id. */
export async function createCallDeviceAction(
  _prev: CallDeviceState,
  formData: FormData,
): Promise<CallDeviceState> {
  const user = await getSessionUser();
  if (!user) return { error: 'unauthenticated' };
  const meta = await requestMeta();
  try {
    await createCallDevice(
      { label: String(formData.get('label') ?? '').trim().slice(0, 100) || null },
      { actorId: user.id, ...meta },
    );
  } catch (err) {
    // The schema-behind morning (#472): a coded refusal, never a digest.
    if (err instanceof CallsError) return { error: err.code };
    console.error('[call-device]', err);
    return { error: 'failed' };
  }
  revalidatePath('/profile');
  return { ok: true };
}

export async function revokeCallDeviceAction(deviceId: string): Promise<CallDeviceState> {
  const user = await getSessionUser();
  if (!user) return { error: 'unauthenticated' };
  const meta = await requestMeta();
  try {
    await revokeCallDevice(deviceId, { actorId: user.id, ...meta });
  } catch (err) {
    if (err instanceof CallsError) return { error: err.code };
    console.error('[call-device]', err);
    return { error: 'failed' };
  }
  revalidatePath('/profile');
  return { ok: true };
}

/**
 * The rasxod xabari from /profile (owner M1a): the seller, the logist and the
 * VED spend money too and belong to no warehouse, so this door asks for a
 * signed-in, ACTIVE person and nothing more (`getSessionUser` answers null
 * for a deactivated account) — no `receipts.create`, which none of them hold.
 * The reporter is the SESSION's user, never an id from the post; a warehouse,
 * when one is named, must be one of their own assignments (#514).
 */
export async function requestOwnExpenseAction(
  input: unknown,
): Promise<{ ok?: boolean; error?: string }> {
  const user = await getSessionUser();
  if (!user) return { error: 'unauthenticated' };
  const parsed = expenseRequestSchema.safeParse(input);
  if (!parsed.success) return { error: amountRefusal(parsed.error) ?? 'validation' };
  try {
    const warehouseId = parsed.data.warehouseId;
    if (warehouseId) {
      const own = await reporterWarehouses(user.id);
      if (!own.some((wh) => wh.id === warehouseId)) return { error: 'forbidden' };
    }
    const meta = await requestMeta();
    await requestExpense(parsed.data, { actorId: user.id, ...meta });
    await enqueue(JOB_PROCESS_EVENTS, {}).catch(() => {});
  } catch (err) {
    if (err instanceof ExpenseRequestError) return { error: err.code };
    // #472's morning: 0101 made the warehouse nullable, and the one machine
    // where it may still be NOT NULL is production mid-deploy.
    console.error('[rasxod]', err);
    return { error: 'failed' };
  }
  revalidatePath('/profile');
  return { ok: true };
}
