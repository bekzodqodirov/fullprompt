import { eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { newClientNotes } from '../../platform/notes/service';
import { newClientPlan, noteCaption } from '../../platform/notes/plan';
import { cardLink } from '../../platform/notifications/links';
import { NEW_CLIENT_CARD } from '../../platform/notifications/note-card';
import { notifyStaffTelegram, reachOf } from '../../platform/notifications/staff';
import { clientLabels } from '../../platform/telegram/client-labels';
import { GS_REMINDER } from '../agent/seed-kb';

/**
 * «Yangi mijozga manzil xabari» — the address card a new client code sends
 * (0151, the owner, 2026-11-19: «klient code ochilganda sklad adresi
 * zametkada bor … code berganda shu adreslar va botga ssilka qoshilib
 * berilsin telegramga kelsin sotuvchilar shuni ozini pereslat qilishsin»).
 *
 * The seller of the new code gets, in the staff bot: one instruction line
 * («🆕 GS777 · Ism — pastdagi N ta xabarni … forward qiling», the client card
 * as «↗️ Ochish»), and under it the part he forwards to the customer — the
 * company zametkalar the owner ticked «🆕 Yangi mijozga» (his «Xitoy sklad»
 * note: three addresses and a picture), merged into one message, then the
 * footer: the marking line, his own reminder, the bot link.
 *
 * Called at exactly THREE doors — the quick «+», the full client form and a
 * won lead that minted its code — after the code is committed, beside the
 * round-111 deal and the 0134 celebration, and for their reasons NOT in
 * `createClient`: the import mints the whole book through the service (1,700
 * cards to one seller), and a fence holds it there.
 *
 * Never throws, like the two beside it: the code goes on the cartons, and a
 * card that could not be queued must never cost the press that minted it — a
 * retry of the «+» mints a SECOND code.
 */

export type AddressCardOutcome = 'seller' | 'presser' | 'nobody';

/** How long a mint press may wait for the bot's own name (a getMe on a cold process). */
const BOT_NAME_WAIT_MS = 3_000;

/**
 * The footer under the addresses, built where his reminder lives (#513 — one
 * home for the string): the marking line in his two languages, his reminder
 * verbatim, and the generic bot link in the customer's words.
 *
 * The reminder is left out when the ticked notes already say it — a note he
 * wrote with «唛头» or «markirovka» in it would otherwise print the same
 * instruction twice to a supplier. The bot line is left out when there is no
 * bot name to build it from (never «t.me/null»).
 */
export function newClientFooter(input: {
  code: string;
  notesText: string;
  botUrl: string | null;
  locale?: string | null;
}): string {
  const lines = [`Markirovka / 唛头: ${input.code}`];
  if (!/唛头|markirovka/i.test(input.notesText)) lines.push(GS_REMINDER);
  // A new client's language is NULL — the office writes customers in Uzbek.
  if (input.botUrl) lines.push(clientLabels(input.locale ?? 'uz').newClientBotLine.replace('{url}', input.botUrl));
  return lines.join('\n');
}

/**
 * The staff line — the card's first message, the seller's alone. Plain text
 * (the drain dresses it: the first line bold when a line follows, the card's
 * link lifted into «↗️ Ochish»).
 */
export function newClientStaffText(input: {
  code: string;
  name: string;
  messages: number;
  noNote: boolean;
  alreadyLinked: boolean;
  cardUrl: string | null;
}): string {
  const lines = [`🆕 ${input.code} · ${input.name} — pastdagi ${input.messages} ta xabarni belgilab mijozga forward qiling`];
  // The deploy morning (judge O10): nothing is ticked yet, and the code and
  // the bot are still worth sending — but the seller must know the address is
  // missing BEFORE he forwards it.
  if (input.noNote) lines.push('⚠ Manzil zametkasi belgilanmagan — bu xabarda sklad manzili yo‘q');
  // A sibling code on a number that already has the cabinet (judge SEC-14):
  // the code joined it by itself, so the bot line is not news to this customer.
  if (input.alreadyLinked) lines.push('ℹ️ Mijoz botga allaqachon ulangan');
  if (input.cardUrl) lines.push(input.cardUrl);
  return lines.join('\n');
}

interface CardClient {
  id: string;
  clientCode: string;
  name: string;
  salesManagerId: string | null;
  locale: string | null;
}

async function readClient(clientId: string): Promise<CardClient | null> {
  const row = await db.query.clients.findFirst({
    where: eq(clients.id, clientId),
    columns: { id: true, clientCode: true, name: true, salesManagerId: true, locale: true },
  });
  return row ?? null;
}

async function botUrl(): Promise<string | null> {
  try {
    const { mijozBotLink } = await import('../../platform/telegram/bot');
    return await Promise.race([
      mijozBotLink(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), BOT_NAME_WAIT_MS)),
    ]);
  } catch {
    return null;
  }
}

/** The one queue write both doors share — the card built NOW, for this recipient. */
async function queueCard(client: CardClient, recipientId: string, ignoreMute: boolean): Promise<number> {
  // Through the visibility rule, with the person the card goes to (the fence).
  const notes = await newClientNotes(recipientId);
  const footer = newClientFooter({
    code: client.clientCode,
    notesText: notes.map((one) => noteCaption(one.note)).join('\n'),
    botUrl: await botUrl(),
    locale: client.locale,
  });
  const plan = newClientPlan(
    notes.map((one) => one.note),
    notes.flatMap((one) => one.files),
    footer,
  );
  const linked = await db.execute<{ linked: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM client_telegram_links
       WHERE client_id = ${client.id}::uuid AND status = 'linked' AND telegram_chat_id IS NOT NULL
    ) AS linked`);
  const text = newClientStaffText({
    code: client.clientCode,
    name: client.name,
    messages: plan.messages,
    noNote: notes.length === 0,
    alreadyLinked: linked[0]?.linked === true,
    cardUrl: cardLink('client', client.id),
  });
  // NO `exceptUserId` (judge D5): on the «+» the presser IS the seller, and
  // the house idiom would silently drop the one row this exists to write.
  return notifyStaffTelegram({
    userIds: [recipientId],
    type: NEW_CLIENT_CARD,
    text,
    extra: { clientId: client.id, card: { steps: plan.steps, done: 0, head: null, ids: [], maybe: [] } },
    ...(ignoreMute ? { ignoreMute: true } : {}),
  });
}

/**
 * The card for a code just minted. WHO (judge O7): the client's seller when
 * the bot can reach him; otherwise the person who pressed, when that is
 * somebody else the bot can reach; otherwise nobody — a row certain to be
 * settled «muted / telegram not linked» proves nothing, and the screen says
 * so instead (`AddressCardOutcome`).
 */
export async function sendNewClientCard(clientId: string, presserId: string | null): Promise<AddressCardOutcome> {
  try {
    const client = await readClient(clientId);
    if (!client) return 'nobody';
    const seller = client.salesManagerId;
    const reach = await reachOf([seller, presserId].filter((id): id is string => !!id), NEW_CLIENT_CARD);
    let to: string | null = null;
    let outcome: AddressCardOutcome = 'nobody';
    if (seller && reach.get(seller) === 'ok') {
      to = seller;
      outcome = 'seller';
    } else if (presserId && presserId !== seller && reach.get(presserId) === 'ok') {
      to = presserId;
      outcome = 'presser';
    }
    if (!to) {
      logger.info({ clientId, seller: seller ? reach.get(seller) : null }, '[new-client-card] nobody to send it to');
      return 'nobody';
    }
    return (await queueCard(client, to, false)) > 0 ? outcome : 'nobody';
  } catch (err) {
    logger.error({ err, clientId }, '[new-client-card] not queued');
    return 'nobody';
  }
}

export type ResendOutcome = 'queued' | 'no_chat' | 'failed';

/**
 * «📨 Manzil xabarini menga yuborish» on the client card — the same card, to
 * the PERSON WHO PRESSED, for an old code or a message lost in a chat. Past
 * their own mute (`ignoreMute`): they asked for it this second. The link in it
 * carries no secret, so whoever may open the card may have it.
 */
export async function resendNewClientCard(clientId: string, presserId: string): Promise<ResendOutcome> {
  try {
    const reach = (await reachOf([presserId], NEW_CLIENT_CARD)).get(presserId);
    if (reach === 'no_chat') return 'no_chat';
    const client = await readClient(clientId);
    if (!client) return 'failed';
    return (await queueCard(client, presserId, true)) > 0 ? 'queued' : 'failed';
  } catch (err) {
    logger.error({ err, clientId }, '[new-client-card] resend not queued');
    return 'failed';
  }
}
