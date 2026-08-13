'use server';

import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '../db/client';
import { users } from '../db/schema';
import { writeAudit } from '../audit/service';
import { findUserByIdentifier } from './identify';
import { verifyPassword } from './password';
import { accountLocked, addressBlocked, recordLoginAttempt } from './rate-limit';
import {
  createSession,
  destroySession,
  getSessionUser,
  requestMeta,
  revokeOtherSessions,
} from './session';

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
});

export interface LoginState {
  error?: 'invalid' | 'rate_limited' | 'validation';
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    identifier: formData.get('identifier'),
    password: formData.get('password'),
  });
  if (!parsed.success) return { error: 'validation' };

  const { identifier, password } = parsed.data;
  const { ip, userAgent } = await requestMeta();
  const ipForLimit = ip ?? '0.0.0.0';

  // VERIFY, then throttle. The address net comes first because argon2 is
  // expensive and a flood of guesses would otherwise tie up the one Node
  // process; the ACCOUNT lock is consulted only once a password has actually
  // failed, so the account's own owner is never refused a correct password
  // by somebody else's wrong ones (the pre-go-live audit's find).
  if (await addressBlocked(ipForLimit)) {
    return { error: 'rate_limited' };
  }

  const user = await findUserByIdentifier(identifier);

  const valid = user && user.active && (await verifyPassword(user.passwordHash, password));
  await recordLoginAttempt(identifier, ipForLimit, Boolean(valid));
  if (!valid || !user) {
    return { error: (await accountLocked(identifier)) ? 'rate_limited' : 'invalid' };
  }

  await createSession(user.id);
  await writeAudit(
    db,
    { actorId: user.id, ip, userAgent },
    { entityType: 'user', entityId: user.id, action: 'login' },
  );
  redirect('/');
}

export async function logoutAction(): Promise<void> {
  const user = await getSessionUser();
  if (user) {
    const { ip, userAgent } = await requestMeta();
    await writeAudit(
      db,
      { actorId: user.id, ip, userAgent },
      { entityType: 'user', entityId: user.id, action: 'logout' },
    );
  }
  await destroySession();
  redirect('/login');
}

export async function logoutOtherDevicesAction(): Promise<void> {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  await revokeOtherSessions(user.id, user.sessionId);
}

const localeSchema = z.enum(['ru', 'uz', 'zh-CN', 'en']);

export async function changeLocaleAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const locale = localeSchema.safeParse(formData.get('locale'));
  if (!locale.success) return;
  await db.update(users).set({ locale: locale.data }).where(eq(users.id, user.id));
}
