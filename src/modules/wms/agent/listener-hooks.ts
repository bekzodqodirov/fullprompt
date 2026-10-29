import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { tgChatRules } from '../../platform/db/schema';
import { isTelegramServicePeer, TELEGRAM_SERVICE_PEER } from '../crm/telegram-import';
import { agentTablesReady } from './config';

/**
 * The small database questions the listener's event handlers ask for the
 * agent (spec §17.3.1). Each is one statement and each asks
 * `agentTablesReady()` first, so a listener ahead of its database does
 * exactly what it did before.
 */

/**
 * «The customer is typing» (fit-9): the worker waits while the peer types,
 * so a question in three lines is answered once. Only for a chat this
 * system already KEEPS — a friend's typing on his personal account must not
 * become a row about that friend (the tray's «counted, never named» rule),
 * which is why the insert is gated on a stored message rather than on the
 * update alone.
 */
export async function stampPeerTyping(managerUserId: string, peerId: bigint): Promise<boolean> {
  if (!(await agentTablesReady())) return false;
  const rows = await db.execute<{ peer_id: string }>(sql`
    INSERT INTO agent_conversations (manager_user_id, peer_id, peer_typing_at, updated_at)
    SELECT ${managerUserId}::uuid, ${peerId.toString()}::bigint, now(), now()
     WHERE EXISTS (
       SELECT 1 FROM tg_messages m
        WHERE m.manager_user_id = ${managerUserId}::uuid AND m.peer_id = ${peerId.toString()}::bigint)
    ON CONFLICT (manager_user_id, peer_id) DO UPDATE
      SET peer_typing_at = now(), updated_at = now()
    RETURNING peer_id`);
  return rows.length > 0;
}

/**
 * Is this message the chat's newest live inbound (regression-10)? An edit of
 * an OLDER line rewrites the record but asks nothing new of the reply to the
 * newest one; an edit of the newest is a new question in the old message's
 * place, and the draft written against its first words must be re-thought.
 */
export async function isNewestInbound(managerUserId: string, peerId: bigint, tgMessageId: bigint): Promise<boolean> {
  if (!(await agentTablesReady())) return false;
  const rows = await db.execute<{ tg_message_id: string }>(sql`
    SELECT m.tg_message_id::text AS tg_message_id FROM tg_messages m
      LEFT JOIN tg_message_flags f ON f.message_id = m.id
     WHERE m.manager_user_id = ${managerUserId}::uuid
       AND m.peer_id = ${peerId.toString()}::bigint
       AND m.direction = 'in'
       AND f.deleted_at IS NULL
     ORDER BY m.tg_message_id DESC
     LIMIT 1`);
  return rows[0]?.tg_message_id === tgMessageId.toString();
}

// Telegram's own service account: API-terms and limitation notices, login
// codes, «new login» alerts — all from this one id. One home, in the import's
// classifier, which also keeps it out of every stored chat.
export { TELEGRAM_SERVICE_PEER };

/**
 * Pure: is this line a notice from Telegram itself (his ⭐2, final review
 * K33)? Its own inbound line in its private chat — never his Saved Messages,
 * never a group or a channel whose id happens to read the same, never a line
 * of his. The listener asks it of a LIVE message only, before anything else
 * decides about it, and what follows is `agentTelegramNotice` — nothing of
 * the message is stored by that.
 */
export function isTelegramServiceNotice(
  peer: { id: bigint; isPrivate: boolean; isSelf?: boolean },
  out: boolean,
): boolean {
  return !out && peer.isSelf !== true && isTelegramServicePeer(peer);
}

/**
 * What a line from Telegram's service account is: the account's own LOGIN
 * traffic, or a NOTICE about the account (K33's follow-up).
 */
export type TelegramNoticeKind = 'login' | 'notice';

/** «Login code: 12345.» / «Код для входа в Telegram: 12345.» — the code is the first line's own number. */
const LOGIN_CODE = /[:：]\s*\d{5,6}(?!\d)/u;
/** The «new login» alert names the session's address the same way in every language: «(IP = 1.2.3.4)». */
const NEW_LOGIN = /\(\s*IP\s*=\s*[0-9A-Fa-f.:]+\s*\)/u;

/**
 * Pure: is this 777000 line his own login — the code Telegram sends when
 * somebody signs in (Telegram Desktop at the office, a new phone, his own
 * re-connect on /suhbatlar/ulash), or the «new login» alert that follows it
 * — or a notice about the account?
 *
 * The difference is what the agent's «off» costs: it cancels every approved
 * reply still waiting (the night-held ✅s included) and expires every live
 * draft, the one being edited too, and none of them comes back when he
 * switches it on again. His ⭐2 is about the warnings an account gets before
 * a ban — the API terms, a limitation — and those are never a login code.
 * So only the two shapes Telegram itself gives its login lines in every
 * language count as login, and ANYTHING else, an empty line or a shape this
 * does not know included, is a notice: guessing wrong toward «notice» costs a
 * routine morning's queue, guessing wrong toward «login» would keep the
 * machine talking through a warning. The text is only looked at here — never
 * kept, never logged, never copied into an alarm (it may be a login code).
 */
export function telegramNoticeKind(text: string): TelegramNoticeKind {
  const firstLine = text.split('\n', 1)[0] ?? '';
  if (LOGIN_CODE.test(firstLine)) return 'login';
  if (NEW_LOGIN.test(text)) return 'login';
  return 'notice';
}

/** What the gramjs user says about itself — read off the chat a stranger's message came from. */
export interface StrangerUser {
  /** In his contacts (or mutually so): a friend or a colleague, never a lead (review fit-7). */
  contact: boolean;
  /** A deleted account: nobody is left to answer. */
  deleted: boolean;
}

/**
 * Pure: the two flags off a raw `User`, or null for anything that is not a
 * PERSON — a group, a channel, a bot, his own Saved Messages, nothing. The
 * verdicts that ask already exclude the last three; refusing them here too
 * keeps `noteStranger`'s promise its own.
 */
export function strangerUserOf(chat: unknown): StrangerUser | null {
  const user = chat as
    | { className?: string; contact?: unknown; mutualContact?: unknown; deleted?: unknown; bot?: unknown; self?: unknown }
    | null
    | undefined;
  if (!user || user.className !== 'User' || user.bot === true || user.self === true) return null;
  return { contact: user.contact === true || user.mutualContact === true, deleted: user.deleted === true };
}

/**
 * A stranger wrote to the agent owner's account (spec §17.11, his Q18 ⭐,
 * review fit-7) — the listener's half of the stranger card; the card itself
 * is the app's sweep.
 *
 *   (a) `agent_conversations.peer_contact`, from the user Telegram handed
 *       over with the message: the sweep sends no card for a contact. A
 *       contact is somebody he saved — a friend, a colleague, family — and a
 *       «yangi lid?» about them is the machine asking about his private life.
 *   (b) A HIDDEN number ('no_phone' — the tray had nothing to ask with) from
 *       a real person who is not a contact gets the pending rule a phone
 *       would have given it, with no phone and the name Telegram shows, so
 *       the «📵 raqam yashirin» card has a rule to act on. ON CONFLICT DO
 *       NOTHING: a rule somebody already decided is never touched, and a
 *       pending one stays as it was. A pending rule decides nothing
 *       (`classifyWithRules`), so the next line is the same `no_phone`.
 *       Every button of that card works: «🆕 Yangi lid» opens the lead BY
 *       NAME through `openLeadForChat(…, { phoneless: 'agent_stranger' })`,
 *       the one door that may (the tray's own still refuses
 *       `chat_no_phone`). Only on a PERSONAL number: on a work number a
 *       hidden number's line is a lead by itself (his «1 a», 2026-10-29) and
 *       is kept, so it never reaches the not-kept branch that asks this.
 *
 *
 *   (c) `reopened` — the listener has just retired its own binding of this
 *       chat because the binding's lead closed (chat-lead `settlePassedChat`,
 *       the 2026-10-29 review): the chat is a new stranger again and its
 *       question a NEW one, so the one-card-per-peer claim an earlier card
 *       spent (`stranger_card_at`) is given back and the sweep asks once more
 *       — without it a chat once carded, then bound, then lost was never
 *       asked about again by the bot.
 *
 * Nothing about the message is stored — no text, no row in tg_messages: the
 * chat stays unkept until he answers the card (round 79's promise). The
 * caller asks this only on the agent owner's account and only for an inbound
 * line; a deleted account gets nothing. One migration behind, nothing at all.
 */
export async function noteStranger(input: {
  managerUserId: string;
  peerId: bigint;
  title: string;
  verdict: 'ask' | 'no_phone';
  user: StrangerUser;
  reopened?: boolean;
}): Promise<{ contactStamped: boolean; ruleAdded: boolean }> {
  const none = { contactStamped: false, ruleAdded: false };
  if (input.user.deleted || input.peerId <= 0n) return none;
  if (!(await agentTablesReady())) return none;
  const m = sql`${input.managerUserId}::uuid`;
  const p = sql`${input.peerId.toString()}::bigint`;
  const stamped = await db.execute<{ peer_id: string }>(sql`
    INSERT INTO agent_conversations (manager_user_id, peer_id, peer_contact, updated_at)
    VALUES (${m}, ${p}, ${input.user.contact}, now())
    ON CONFLICT (manager_user_id, peer_id) DO UPDATE
      SET peer_contact = EXCLUDED.peer_contact, updated_at = now()
      WHERE agent_conversations.peer_contact IS DISTINCT FROM EXCLUDED.peer_contact
    RETURNING peer_id`);
  let ruleAdded = false;
  if (input.verdict === 'no_phone' && !input.user.contact) {
    // Through the builder, not raw SQL: the rule's id is minted in JS (uuidv7), as every other writer mints it.
    const added = await db
      .insert(tgChatRules)
      .values({
        managerUserId: input.managerUserId,
        peerId: input.peerId,
        decision: 'pending',
        peerTitle: input.title.slice(0, 200),
        peerPhone: null,
      })
      .onConflictDoNothing({ target: [tgChatRules.managerUserId, tgChatRules.peerId] })
      .returning({ id: tgChatRules.id });
    ruleAdded = added.length > 0;
  }
  if (input.reopened && !input.user.contact) {
    await db.execute(sql`
      UPDATE agent_conversations SET stranger_card_at = NULL, updated_at = now()
       WHERE manager_user_id = ${m} AND peer_id = ${p} AND stranger_card_at IS NOT NULL`);
  }
  return { contactStamped: stamped.length > 0, ruleAdded };
}
