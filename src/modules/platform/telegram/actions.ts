'use server';

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { db } from '../db/client';
import { telegramLinks } from '../db/schema';
import { requireActor } from '../rbac/authorize';
import { getBotUsername } from './bot';

/** Profile → "Connect Telegram": mint a one-time code and deep link. */
export async function createTelegramLinkAction(): Promise<void> {
  const actor = await requireActor();
  const code = randomBytes(12).toString('base64url');
  await db
    .insert(telegramLinks)
    .values({ userId: actor.id, linkCode: code, status: 'pending' })
    .onConflictDoUpdate({
      target: telegramLinks.userId,
      set: { linkCode: code, status: 'pending' },
    });
  const username = await getBotUsername();
  if (username) {
    redirect(`https://t.me/${username}?start=${code}`);
  }
  redirect('/profile?telegram=nobot');
}

export async function telegramLinkStatus(userId: string) {
  return db.query.telegramLinks.findFirst({ where: eq(telegramLinks.userId, userId) });
}
