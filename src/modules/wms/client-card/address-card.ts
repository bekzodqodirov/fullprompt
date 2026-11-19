import { eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { phoneDigits } from '../../platform/clients/phone';
import { newClientNotes } from '../../platform/notes/service';
import { newClientPlan, noteCaption } from '../../platform/notes/plan';
import { cardLink } from '../../platform/notifications/links';
import { NEW_CLIENT_CARD } from '../../platform/notifications/note-card';
import { notifyStaffTelegram, reachOf, type Reach } from '../../platform/notifications/staff';
import { clientLabels } from '../../platform/telegram/client-labels';
import { GS_REMINDER } from '../agent/seed-kb';

/**
 * «Yangi mijozga manzil xabari» — the address card a new client code sends
 * (0151, the owner, 2026-11-19: «klient code ochilganda sklad adresi
 * zametkada bor … code berganda shu adreslar va botga ssilka qoshilib
 * berilsin telegramga kelsin sotuvchilar shuni ozini pereslat qilishsin»).
 *
 * The seller of the new code gets, in the staff bot: the instruction («🆕
 * GS777 · Ism», then «Pastdagi N ta xabarni … forward qiling ⬇️», the client
 * card as «↗️ Ochish»), and under it the part he forwards to the customer —
 * the company zametkalar the owner ticked «🆕 Yangi mijozga» (his «Xitoy
 * sklad» note: three addresses and a picture), merged into one message, then
 * the footer: the marking line, his own reminder, the bot link.
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

/**
 * Where the card went, said on the screen that minted the code:
 *   - `seller`  — to the code's seller, the usual way (nothing is said);
 *   - `presser` — the seller's Telegram is not linked, so to the person who
 *                 pressed, when that is somebody else the bot can reach;
 *   - `muted`   — the seller switched these messages off on /profile: his
 *                 choice, so the card goes to NOBODY (judge R14 — a mute never
 *                 moves his work onto somebody else);
 *   - `nobody`  — nobody who could get it has a linked Telegram;
 *   - `failed`  — OUR fault: the card could not be queued (a database blip, a
 *                 read under it), never blamed on anybody's Telegram.
 */
export type AddressCardOutcome = 'seller' | 'presser' | 'muted' | 'nobody' | 'failed';

/** How long a mint press may wait for the bot's own name (a getMe on a cold process). */
const BOT_NAME_WAIT_MS = 3_000;

/**
 * The footer under the addresses, built where his reminder lives (#513 — one
 * home for the string): the marking line in his two languages, his reminder
 * verbatim, and the generic bot link in the customer's words.
 *
 * The reminder is left out only when the ticked notes already carry its
 * CHINESE instruction («唛头») — the half written for the supplier the customer
 * forwards this to. A passing Uzbek «markirovka» in a note says nothing to that
 * supplier, so it no longer drops both halves (review CUST-5). The bot line is
 * left out when there is no bot name to build it from (never «t.me/null»).
 */
export function newClientFooter(input: {
  code: string;
  notesText: string;
  botUrl: string | null;
  locale?: string | null;
}): string {
  const lines = [`Markirovka / 唛头: ${input.code}`];
  if (!input.notesText.includes('唛头')) lines.push(GS_REMINDER);
  // A new client's language is NULL — the office writes customers in Uzbek.
  if (input.botUrl) lines.push(clientLabels(input.locale ?? 'uz').newClientBotLine.replace('{url}', input.botUrl));
  return lines.join('\n');
}

/**
 * The staff line — the card's first message, the seller's alone. Plain text
 * (the drain dresses it: the FIRST line bold when a line follows — and only
 * when it fits its 80-character title rule, which is why the code and the
 * name stand alone on it (review RG-2) — and the card's link lifted into
 * «↗️ Ochish»).
 */
export function newClientStaffText(input: {
  code: string;
  name: string;
  messages: number;
  noNote: boolean;
  /** No phone on the card that the bot's «send your number» could ever match (review CUST-1). */
  noPhone: boolean;
  /** The bot line is not in the forwardable part — no bot name in time, or no token (review CUST-6). */
  noBotLink: boolean;
  alreadyLinked: boolean;
  cardUrl: string | null;
}): string {
  const lines = [`🆕 ${input.code} · ${input.name}`, `Pastdagi ${input.messages} ta xabarni belgilab mijozga forward qiling ⬇️`];
  // The deploy morning (judge O10): nothing is ticked yet, and the code and
  // the bot are still worth sending — but the seller must know the address is
  // missing BEFORE he forwards it.
  if (input.noNote) lines.push('⚠ Manzil zametkasi belgilanmagan — bu xabarda sklad manzili yo‘q');
  // The bot connects a customer by the number on the card and nothing else
  // (`linkAllClientsForPhone`): with none, the link can only answer «not
  // found». The seller cannot add a phone himself — the office can.
  if (input.noPhone) lines.push('⚠ Mijoz kartasida telefon yo‘q — botdagi havola uni ulay olmaydi: raqamini kartaga yozdiring (admin)');
  if (input.noBotLink) lines.push('⚠ Bot havolasi qo‘shilmadi — mijoz kartasidagi «📨» bilan keyinroq qayta oling');
  // A sibling code on a number that already has the cabinet (judge SEC-14):
  // the code joined it by itself, so the bot line is not news to this customer.
  if (input.alreadyLinked) lines.push('ℹ️ Mijoz botga allaqachon ulangan');
  if (input.cardUrl) lines.push(input.cardUrl);
  return lines.join('\n');
}

/**
 * Does the card hold a phone the bot's self-service door could ever match?
 * The matcher's own rule (`activeClientsByPhone`): a phones value that is not
 * an array is no phones at all, and a number of fewer than seven digits
 * matches nothing.
 */
export function hasLinkablePhone(phones: unknown): boolean {
  return Array.isArray(phones) && phones.some((one) => typeof one === 'string' && phoneDigits(one).length >= 7);
}

/**
 * WHO gets the card (judge O7, R14): the client's seller when the bot can
 * reach him; when his Telegram is not linked (or there is no seller), the
 * person who pressed, when that is somebody else the bot can reach; when the
 * seller MUTED these messages, nobody — his choice is not moved onto a
 * colleague, and the screen says so.
 */
export function cardRecipient(
  seller: string | null,
  presser: string | null,
  reach: Map<string, Reach>,
): { to: string | null; outcome: Exclude<AddressCardOutcome, 'failed'> } {
  const sellerReach = seller ? reach.get(seller) ?? 'no_chat' : 'no_chat';
  if (seller && sellerReach === 'ok') return { to: seller, outcome: 'seller' };
  if (seller && sellerReach === 'muted') return { to: null, outcome: 'muted' };
  if (presser && presser !== seller && reach.get(presser) === 'ok') return { to: presser, outcome: 'presser' };
  return { to: null, outcome: 'nobody' };
}

interface CardClient {
  id: string;
  clientCode: string;
  name: string;
  salesManagerId: string | null;
  locale: string | null;
  phones: unknown;
  active: boolean;
}

async function readClient(clientId: string): Promise<CardClient | null> {
  const row = await db.query.clients.findFirst({
    where: eq(clients.id, clientId),
    columns: { id: true, clientCode: true, name: true, salesManagerId: true, locale: true, phones: true, active: true },
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
  const link = await botUrl();
  const footer = newClientFooter({
    code: client.clientCode,
    notesText: notes.map((one) => noteCaption(one.note)).join('\n'),
    botUrl: link,
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
    noPhone: !hasLinkablePhone(client.phones),
    noBotLink: link === null,
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
 * The card for a code just minted, to `cardRecipient`'s choice. A row certain
 * to be settled «muted / telegram not linked» proves nothing, so none is
 * written and the screen says why instead (`AddressCardOutcome`).
 */
export async function sendNewClientCard(clientId: string, presserId: string | null): Promise<AddressCardOutcome> {
  try {
    const client = await readClient(clientId);
    if (!client) return 'failed';
    const seller = client.salesManagerId;
    const reach = await reachOf([seller, presserId].filter((id): id is string => !!id), NEW_CLIENT_CARD);
    const { to, outcome } = cardRecipient(seller, presserId, reach);
    if (!to) {
      logger.info({ clientId, seller: seller ? reach.get(seller) : null, outcome }, '[new-client-card] not sent');
      return outcome;
    }
    // Nothing queued for a recipient the bot could reach a moment ago: the
    // reach changed between the two reads — nobody has it, and nothing broke.
    return (await queueCard(client, to, false)) > 0 ? outcome : 'nobody';
  } catch (err) {
    logger.error({ err, clientId }, '[new-client-card] not queued');
    return 'failed';
  }
}

export type ResendOutcome = 'queued' | 'no_chat' | 'failed' | 'inactive';

/**
 * «📨 Manzil xabarini menga yuborish» on the client card — the same card, to
 * the PERSON WHO PRESSED, for an old code or a message lost in a chat. Past
 * their own mute (`ignoreMute`): they asked for it this second. The link in it
 * carries no secret, so whoever may open the card may have it.
 *
 * Never for a DEACTIVATED code (review P1-DOORS-4): the card would tell a
 * supplier to mark cartons with a retired code, and the bot's link could not
 * connect it (the phone matcher reads active cards only) — winLead's attach
 * refuses the same mistake as `client_inactive`.
 */
export async function resendNewClientCard(clientId: string, presserId: string): Promise<ResendOutcome> {
  try {
    const client = await readClient(clientId);
    if (!client) return 'failed';
    if (!client.active) return 'inactive';
    const reach = (await reachOf([presserId], NEW_CLIENT_CARD)).get(presserId);
    if (reach === 'no_chat') return 'no_chat';
    return (await queueCard(client, presserId, true)) > 0 ? 'queued' : 'failed';
  } catch (err) {
    logger.error({ err, clientId }, '[new-client-card] resend not queued');
    return 'failed';
  }
}
