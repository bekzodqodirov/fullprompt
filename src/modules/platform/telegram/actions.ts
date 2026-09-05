'use server';

import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { db } from '../db/client';
import { telegramLinks } from '../db/schema';
import { requireActor } from '../rbac/authorize';
import { getBotUsername } from './bot';
import { mintTelegramLinkCode } from './staff-bot';

/**
 * Profile → «Telegram ulash» / «Qayta ulash»: mint a one-time code and open
 * the bot's deep link.
 *
 * The one rule worth writing down: a row that is ALREADY `linked` keeps its
 * status and its chat id. Flipping it to `pending` is what the obvious version
 * does, and it is a notification OUTAGE — every reader demands `status =
 * 'linked'`, so from the press until the person opens Telegram they are not a
 * staff chat at all: `staffForChat` answers null, the drain settles every
 * queued notification terminally `muted / telegram not linked`, and `muted` is
 * excluded from `notificationProblemCount`, so nothing on any screen ever says
 * it happened. Abandon the press and you are off Telegram for ever.
 *
 * Leaving the row alone costs nothing: `/start <code>` looks the code up by
 * `link_code` and refuses only a `revoked` row, so a code on a live link
 * redeems and `linkStaffChat` moves the chat id — the old phone keeps working
 * right up to the moment the new one takes over, and then it is told.
 */
export async function createTelegramLinkAction(): Promise<void> {
  const actor = await requireActor();
  const code = await mintTelegramLinkCode(actor.id);
  const username = await getBotUsername();
  if (username) {
    redirect(`https://t.me/${username}?start=${code}`);
  }
  redirect('/profile?telegram=nobot');
}

export async function telegramLinkStatus(userId: string) {
  return db.query.telegramLinks.findFirst({ where: eq(telegramLinks.userId, userId) });
}
