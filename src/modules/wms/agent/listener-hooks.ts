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

/**
 * A login code as Telegram writes it: five or six digits, with at most one space or dash inside («52 814»,
 * «528-140») — never glued to letters («GS52814», a client code), never a piece of a longer number (a phone
 * «+998 90 123 45 67», a date, an appeal number of seven digits, a decimal).
 */
const CODE = /(?<![\p{L}\d])(?<!\d[ \u00a0\u2009\u202f\-‐‑–.,/])(?:\d{5,6}|\d{2,3}[ \u00a0\u2009\u202f\-‐‑–]\d{3})(?![\p{L}\d])(?![ \u00a0\u2009\u202f\-‐‑–.,/]\d)/gu;

/**
 * The word «code» in the languages Telegram writes its login lines in — a code word next to a code-shaped number
 * is how every one of them reads: «Login code: …», «… is your login code», «Your code: …», «Код для входа в
 * Telegram: …», «Kirish kodi …», «Кириш коди …», «Giriş kodu …», «登录代码：…», «کد ورود: …», «رمز الدخول …».
 * Uzbek and Turkish suffix the word («kodingiz», «kodunuz»), so the stem takes a short tail.
 */
const CODE_WORD =
  /(?<!\p{L})(?:codes?|kod\p{L}{0,7}|kód\p{L}{0,3}|koodi|código|codice|код\p{L}{0,7}|коди|коды|кодингиз|کد|كود|رمز)(?!\p{L})|码|碼|代码|代碼|コード|코드/u;

/** How far a code word may stand from the code: «Your login code for Telegram Desktop: 52814» — 38 characters before. */
const BEFORE_CODE = 48;
/** …and after it: «52814 is your Telegram login code», «52814 — Telegramga kirish kodingiz». */
const AFTER_CODE = 32;

/**
 * The «new login» alert's TITLE: the header words alone, opening one of the first two lines and ENDING there — a full
 * stop, a comma, a colon or the line's end after them: «New login.», «Новый вход в аккаунт.», «Yangi kirish.», «Янги
 * кириш.», «Yeni giriş.», «Жаңа кіру.», «新登录。». A title that QUALIFIES the login is another message whatever fields
 * follow it, in every language at once and with no word list to keep: «New login attempt / denied / prevented»,
 * «Новый вход не подтверждён / запрещён», «Yangi kirish urinishi / taqiqlandi», «Yangi kirishga urinish», «新登录尝试»,
 * «新登录已被阻止», «Yeni giriş denemesi», «Жаңа кіру әрекеті», «Neue Anmeldung blockiert», «ورود جدید ناموفق» — and
 * one whose qualifier comes FIRST («تلاش ورود جدید», the attempt of a new login) does not open the line with it.
 */
const NEW_LOGIN_TITLE =
  /^[^\p{L}\p{N}]*(?:new\s+login(?:\s+(?:in)?to\s+your\s+account)?|нов(?:ый|ий)\s+вх(?:од|ід)(?:\s+(?:в|до)\s+(?:ваш\s+)?(?:аккаунт|акаунт))?|yangi\s+kirish|янги\s+кириш|yeni\s+giriş|жаңа\s+кіру|新登录|新的登录|新登入|ورود\s+جدید|تسجيل\s+دخول\s+جديد|neue\s+anmeldung|nuevo\s+inicio\s+de\s+sesión|nouvelle\s+connexion|nuovo\s+accesso)\s*(?:[.!:;,。！：；，،]|$)/mu;

/**
 * …and its older form, a SENTENCE in the first two lines with no title («Aziz, we detected a login into your account
 * from a new device …», «Aziz, мы зарегистрировали вход в Ваш аккаунт с нового устройства …»). Only the English and
 * the Russian sentence: the Uzbek and Kazakh «yangi qurilmadan kiri…» also opened «yangi qurilmadan kirishga harakat
 * qilindi» — an attempt — and every alert in those languages carries its title anyway. «log in» with a space is the
 * verb and never opens an alert: «Someone tried to log in to your account from a new device» is not one of these.
 */
const NEW_LOGIN_SENTENCE =
  /detected\s+a\s+(?:new\s+)?login\s+(?:in)?to\s+your\s+account|login\s+(?:in)?to\s+your\s+account\s+from\s+a\s+new\s+device|(?:обнаружили|зарегистрировали|зафиксировали|виявили)\s+вх(?:од|ід)/u;

/**
 * A field of that alert: «Device: …», «Location: …» (on their own lines, or inline after a full stop), their
 * translations, or Telegram's own «(IP = 1.2.3.4)» / «(IP=1.2.3.4)». The header alone, or a field alone, is no
 * alert: both together are.
 */
const LOGIN_FIELD =
  /(?:^|[\s.,;(])(?:device|location|устройство|местоположение|местонахождение|пристрій|місцезнаходження|розташування|qurilma|joylashuv|қурилма|жойлашув|құрылғы|орналасқан\s+жері|cihaz|konum|设备|設備|位置|地点|地點|دستگاه|مکان|موقعیت|الجهاز|الموقع|gerät|standort|dispositivo|ubicación|appareil|emplacement)\s*[:：]|\(\s*ip\s*=\s*[0-9a-f.:]+\s*\)/mu;

/**
 * Words that WARN about the account — a limitation, spam reports, the terms of service, a ban or a freeze, a
 * deletion, a restriction, an unofficial or third-party app, suspicious activity, an appeal, and «someone TRIED to
 * log in» (a security alert, not his sign-in), a compromised account, a login refused or left unconfirmed. Any of
 * them ANYWHERE makes the line a notice, whatever else it carries: a code or a «Device:» field beside them is no
 * excuse to keep talking. Only the past «tried», the noun «attempt» and their translations — never the gerund («by
 * trying to log in on another device», «kirishga urinib», «пытаясь войти», «尝试登录», «بمحاولة تسجيل الدخول», «кіруге
 * тырысу»), which Telegram's own login line uses in every language to say «ignore this if it was not you». Where a
 * language says the attempt with the gerund's own word (zh, ar), the alert is caught by its TITLE
 * (`NEW_LOGIN_TITLE`), never by the word.
 */
const ACCOUNT_WARNING =
  /limit(?:ed|ation)|restrict|spam|report(?:s|ed)(?!\p{L})|(?<!\p{L})bann?(?:ed)?(?!\p{L})|blocked|suspend|frozen|freez|terms\s+of\s+(?:service|use)|violat|delet|(?:tried|attempted)\s+to\s+(?:log|sign)|attempt|refused|unconfirm|not\s+confirmed|compromis|unofficial|third[-\s]party|suspicious|unauthori[sz]ed|hack|appeal|fraud|scam|abuse|ограничен|спам|жалоб|заблокир|блокир|заморож|удал[её]н|удален|удалит|нарушен|нарушил|услови[яй]\s+(?:использования|обслуживания)|пыта(?:лся|лась|лись)\s+(?:войти|зайти)|кто-то\s+пыта|попытк[аиуеой]\s+вход|подозрит|неофициальн|сторонн\p{L}*\s+(?:приложени|клиент)|взлом|скомпрометир|мошенн|апелляц|обмежен|скарг|заблоков|видален|порушен|намага(?:вся|лася|лися)|спроб[аиу]\s+вход|підозріл|cheklan|cheklov|shikoyat|bloklan|muzlat|o'chiril|o'chirish\s+so'rov|qoida\p{L}*\s+buz|qoidabuzar|buzil|foydalanish\s+shart|urin(?:di|gan)|shubhali|norasmiy|buzib\s+kir|firibgar|apellyatsiya|чеклан|чеклов|шикоят|блоклан|музлат|ўчирил|ўчириш\s+сўров|қоида\p{L}*\s+буз|бузил|фойдаланиш\s+шарт|урин(?:ди|ган)|шубҳали|норасмий|шектел|шағым|бұғатта|жойыл|жою|күдікті|тырысты|тырысқан|kısıtlan|şikayet|engellen|silin|silme|ihlal|şüpheli|dondurul|限制|垃圾|举报|舉報|违反|違反|删除|刪除|注销|註銷|封禁|冻结|凍結|可疑|非官方|محدود|اسپم|گزارش|حذف|مسدود|مشکوک|نقض|مقيد|تقييد|سبام|بلاغ|حظر|مشبوه|انتهاك|eingeschränkt|beschränkt|gesperrt|gelöscht|löschung|verstoß|verdächtig|limitad|restringid|bloquead|eliminad|eliminación|infracci|sospechos/u;

/**
 * Invisible marks (zero-width spaces, direction marks) taken out, apostrophes made one, letters made small. The
 * Arabic-Indic and Persian digits are deliberately NOT read as digits: a Persian or Arabic warning carries its own
 * number beside a code word («کد پیگیری: ۵۲۸۱۴۰», a tracking code) and the warning list cannot know every way those
 * languages say «deactivated» — folded, such a warning read as his login and the AI talked through it. A login code
 * written in them («کد ورود: ۵۲۸۱۴») is a notice: a morning's queue, the safe direction.
 */
function normalisedNotice(text: string): string {
  return text
    .replace(/\p{Cf}/gu, '')
    .replace(/[ʻʼ‘’`´]/gu, "'")
    .toLowerCase();
}

/** A code-shaped number in `head` with a code word beside it (`BEFORE_CODE` before, `AFTER_CODE` after). */
function codeBesideWord(head: string): boolean {
  for (const m of head.matchAll(CODE)) {
    const at = m.index ?? 0;
    const before = head.slice(Math.max(0, at - BEFORE_CODE), at);
    const after = head.slice(at + m[0].length, at + m[0].length + AFTER_CODE);
    if (CODE_WORD.test(before) || CODE_WORD.test(after)) return true;
  }
  return false;
}

/**
 * Pure: is this 777000 line his own login — the code Telegram sends when
 * somebody signs in (Telegram Desktop at the office, a new phone, his own
 * re-connect on /suhbatlar/ulash, Telegram Web, a QR sign-in's alert), or the
 * «new login» alert that follows it — or a notice about the account?
 *
 * The difference is what the agent's «off» costs: it cancels every approved
 * reply still waiting (the night-held ✅s included) and expires every live
 * draft, the one being edited too, and none of them comes back when he
 * switches it on again. The first rule knew two shapes («…: 12345» on the
 * first line, «(IP = …)» anywhere) and read everything else as a notice — and
 * on 2026-11-19 two of his own sign-ins switched the AI off for two and a half
 * days (current Telegram's alert names no IP; a code reads «12 345», sits on
 * the second line, or comes before its word).
 *
 * The rule, in this order:
 *  1. a WARNING word anywhere (`ACCOUNT_WARNING`) — a notice, whatever else the
 *     line carries: his ⭐2 is about the warnings an account gets before a ban,
 *     and a code beside one (a deletion request's, an appeal's) is no reason to
 *     keep talking;
 *  2. a login CODE (`CODE`) next to a code word (`CODE_WORD`) in the first two
 *     lines (a greeting may come first, the code may sit on its own line) —
 *     login;
 *  3. the new-login alert in the first two lines — its unqualified TITLE
 *     (`NEW_LOGIN_TITLE`) or its older SENTENCE (`NEW_LOGIN_SENTENCE`) —
 *     together with a device or location field (`LOGIN_FIELD`) — login;
 *  4. anything else, an empty line or a shape this does not know included — a
 *     notice: guessing wrong toward «notice» costs a morning's queue (and the
 *     reminders of `off-reminder.ts` say so every two hours until he switches it
 *     on), guessing wrong toward «login» would keep the machine talking through
 *     a warning.
 *
 * The text is only looked at here — never kept, never logged, never copied into
 * an alarm (it may be a login code).
 */
export function telegramNoticeKind(text: string): TelegramNoticeKind {
  const all = normalisedNotice(text);
  if (ACCOUNT_WARNING.test(all)) return 'notice';
  const head = all
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 2)
    .join('\n');
  if (codeBesideWord(head)) return 'login';
  if ((NEW_LOGIN_TITLE.test(head) || NEW_LOGIN_SENTENCE.test(head)) && LOGIN_FIELD.test(all)) return 'login';
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
