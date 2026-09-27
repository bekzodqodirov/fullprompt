import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db/client';
import { clients, clientTelegramLinks } from '../db/schema';
import type { ClientLocale } from './client-labels';
import { setCabinetMenuButton } from './menu-button';

/**
 * The language of a CHAT — one writer, two doors (round C).
 *
 * A customer switches language in the bot (🌐 Til) or, since round C, from
 * inside the Mini App. Both must do the same three things or the chat ends up
 * speaking two languages: every code linked to the chat takes the choice (one
 * person holds 777, 555 and 444, and a reply about each must not come back in
 * a different language), and the corner button — the one word the customer
 * sees before opening anything — follows. The third thing, the reply
 * keyboard, can only change by SENDING a message, so each door does that
 * itself with the keyboard `replyKeyboardFor` derives.
 *
 * Platform tables only (clients and their links), so no wms import.
 */
export async function setChatLocale(chatId: bigint, locale: ClientLocale): Promise<string[]> {
  const linked = await db
    .select({ id: clientTelegramLinks.clientId })
    .from(clientTelegramLinks)
    .where(
      and(eq(clientTelegramLinks.telegramChatId, chatId), eq(clientTelegramLinks.status, 'linked')),
    );
  const ids = [...new Set(linked.map((r) => r.id))];
  if (ids.length === 0) return [];
  await db.update(clients).set({ locale }).where(inArray(clients.id, ids));
  // Best-effort: a corner button that fails to change leaves the old word,
  // never a broken chat.
  await setCabinetMenuButton(Number(chatId), locale);
  return ids;
}

/**
 * The language a person chose, read from the chat rather than one code.
 *
 * A code that joins an existing cabinet (a second code on the same phone)
 * starts with NO language of its own, so a message written «in the new
 * code's language» came out in the Russian fallback to a person who had
 * picked Uzbek (the scouts found it on «yangi kod qo'shildi»). The OLDEST
 * link with a language wins — the rule `clientsForChat` orders by.
 */
export async function chatLocaleFor(chatId: bigint): Promise<string | null> {
  const [row] = await db
    .select({ locale: clients.locale })
    .from(clientTelegramLinks)
    .innerJoin(clients, eq(clients.id, clientTelegramLinks.clientId))
    .where(
      and(
        eq(clientTelegramLinks.telegramChatId, chatId),
        eq(clientTelegramLinks.status, 'linked'),
        isNotNull(clients.locale),
      ),
    )
    .orderBy(asc(clientTelegramLinks.linkedAt), asc(clients.clientCode))
    .limit(1);
  return row?.locale ?? null;
}
