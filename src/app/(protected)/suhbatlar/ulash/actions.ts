'use server';

import { revalidatePath } from 'next/cache';
import { getActor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { writeAudit } from '@/modules/platform/audit/service';
import { db } from '@/modules/platform/db/client';
import { disconnectAccount } from '@/modules/wms/crm/telegram-accounts';
import { beginTgLogin, completeTgLogin } from '@/modules/wms/crm/telegram-connect';

/**
 * The connect flow's two doors — round 21.
 *
 * ALWAYS the actor's own account: `beginTgLogin(actor.id, …)` binds the
 * stored session to the person pressing the button, exactly as the reply
 * path binds sending. There is no way to type a colleague's user in — the
 * whole class of "connected under the wrong person" that the CLI's `--user`
 * flag made possible is gone with the flag.
 */

export interface ConnectState {
  stage: 'phone' | 'code' | 'done';
  needPassword?: boolean;
  error?: string;
}

/** Same gate as the conversations screen — connecting is part of that job. */
async function connector() {
  const actor = await getActor();
  if (!actor) return null;
  if (!actor.permissions.has('crm.leads') && !actor.permissions.has('clients.manage')) return null;
  return actor;
}

export async function beginConnectAction(
  _prev: ConnectState,
  form: FormData,
): Promise<ConnectState> {
  const actor = await connector();
  if (!actor) return { stage: 'phone', error: 'forbidden' };
  const result = await beginTgLogin(actor.id, String(form.get('phone') ?? ''));
  if (!result.ok) return { stage: 'phone', error: result.error };
  return { stage: 'code' };
}

export async function completeConnectAction(
  _prev: ConnectState,
  form: FormData,
): Promise<ConnectState> {
  const actor = await connector();
  if (!actor) return { stage: 'phone', error: 'forbidden' };
  const password = String(form.get('password') ?? '');
  const result = await completeTgLogin(
    actor.id,
    String(form.get('code') ?? ''),
    password || undefined,
  );
  if (!result.ok) {
    // 2FA: the login is still alive — the screen asks for the password and
    // resubmits the same code with it.
    if (result.error === 'password_needed') return { stage: 'code', needPassword: true };
    if (result.error === 'expired') return { stage: 'phone', error: 'expired' };
    return {
      stage: 'code',
      needPassword: result.error === 'password_invalid' || password.length > 0,
      error: result.error,
    };
  }
  return { stage: 'done' };
}

/**
 * «Chiqish» — take my Telegram back off this server (round 50).
 *
 * ALWAYS the actor's own account, exactly as connecting is: there is no form
 * field for whose. Somebody else's Telegram is theirs to disconnect, and a
 * screen that could sign a colleague out of their own phone is a screen that
 * can silence a customer's conversations without them knowing.
 *
 * Audited, because it is not a preference: it destroys a credential and fails
 * whatever was still queued to go out under it.
 */
export async function disconnectAction(): Promise<ConnectState> {
  const actor = await connector();
  if (!actor) return { stage: 'phone', error: 'forbidden' };
  const removed = await disconnectAccount(actor.id);
  if (!removed) return { stage: 'phone', error: 'no_account' };
  await writeAudit(db, { actorId: actor.id, ...(await requestMeta()) }, {
    entityType: 'user',
    entityId: actor.id,
    action: 'update',
    after: { telegram: 'disconnected' },
  });
  revalidatePath('/suhbatlar/ulash');
  revalidatePath('/suhbatlar', 'layout');
  return { stage: 'phone' };
}
