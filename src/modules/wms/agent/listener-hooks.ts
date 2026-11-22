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
 * The text is only looked at here — never kept, never copied into an alarm, and
 * never logged UNREDACTED (it may be a login code): the listener logs its shape
 * through `redactNotice`, from which no code can be read back.
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

/** The most of a redacted line the log carries — a code sits in the first two lines, the shape in the first few. */
const REDACTED_MAX = 400;

/** A link with a scheme («https://t.me/login/52814», «tg://login?token=…») — its host kept, the rest cut. */
const SCHEME_LINK = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#]*)(\S*)/giu;
/** A link with none («my.telegram.org/auth?…», «t.me/login/52814»): a dotted host followed by a path or a query. */
const BARE_LINK = /(?<![\p{L}\p{N}@.\/])((?:[a-z0-9-]+\.)+[a-z]{2,})([/?#]\S*)/giu;
/** A query value outside a link that was cut — any `name=value`: «?code=…», «token=AQABx…». */
const QUERY_VALUE = /(?<![\p{L}\p{N}_.-])([\p{L}\p{N}_.-]+=)[^\s&#]+/gu;
/**
 * A word as the redaction judges it: letters, their marks and digits in any script, and the «-» and «_» between them.
 * my.telegram.org's code is eleven characters of [A-Za-z0-9_-]; cut at «-» and «_» («fFyIb-grNZv», «Zx_Qw-Er_Ty») it
 * fell into pieces each too short or too plain to look like one, and the pieces read back as the code.
 */
const WORD = /[\p{L}\p{M}\p{N}_-]+/gu;

/**
 * A hyphenated word that reads as an ordinary one: no capital, or one capital opening it («third-party», «Third-party»,
 * «Telegram-аккаунт», «кто-то», «из-за», «e-mail»), and no part empty. `ACCOUNT_WARNING` reads «third-party» and
 * «кто-то пыта…», and the log exists to settle that rule against the real texts — so such a word keeps its letters,
 * while a capital anywhere else («fFyIb-grNZv», «aBcDe-FgHiJ», «xu-Ijpkbgub») takes the whole word with it.
 */
const PLAIN_HYPHENATED = /^[\p{Lu}\p{Lt}]?[^\p{Lu}\p{Lt}-]+(?:-[^\p{Lu}\p{Lt}-]+)+$/u;

/**
 * A greeting's name: «Dear Aziz,» (the web login code and the new-login alert open with it) and its Russian and Uzbek
 * forms — his name has no business in a docker log. Up to four words, and only when the comma closes it on that line.
 */
const GREETING_NAME = /(?<!\p{L})(dear|уважаем\p{L}*|hurmatli|ҳурматли)([ \t\u00a0]+)([\p{L}\p{M}'’ʻ.-]+(?:[ \t\u00a0]+[\p{L}\p{M}'’ʻ.-]+){0,3})(?=[ \t\u00a0]*,)/giu;

/**
 * The new-login alert's «Location: …» — where he signed in, city and country, is his and not the shape. The field's
 * name stays (`LOGIN_FIELD` reads it); its value — on that line, or on the next when the name ends its own — goes to
 * the line's end, or to the next field when the alert writes them inline («Location: Tashkent, Uzbekistan. Device: …»
 * keeps «Device:») — never to a mere full stop, or «St. Petersburg» would leave the city behind.
 */
const LOCATION_VALUE =
  /((?<!\p{L})(?:location|местоположение|местонахождение|місцезнаходження|розташування|joylashuv|жойлашув|орналасқан\s+жері|konum|مکان|موقعیت|الموقع|standort|ubicación|emplacement)|位置|地点|地點)([ \t\u00a0]*[:：][ \t\u00a0]*(?:\r?\n[ \t\u00a0]*)?)([^\r\n]+?)(?=[.,;]?[ \t\u00a0]+\p{L}[\p{L}\p{M}]*(?:[ \t\u00a0]+\p{L}[\p{L}\p{M}]*)?[ \t\u00a0]*[:：]|[\r\n]|$)/gimu;

/** The «code» word ending a stretch of text — `CODE_WORD`, the one list of how a login line says «code». */
const CODE_WORD_AT_END = new RegExp(`(?:${CODE_WORD.source})\\s+$`, 'u');

/**
 * A token: what stands between spaces — a no-break space (U+00A0, U+2007, U+202F) glues and does not part, or a code
 * written «aBcDe FgHiJ» with one inside would leave its second half behind.
 */
const TOKEN = String.raw`\S+(?:[\u00a0\u2007\u202f]+\S+)*`;
/** The colon of «Login code: …», «Your code: …», «登录代码：…» — and the token after it, on that line or the next. */
const COLON_TOKEN = new RegExp(String.raw`([:：])(\s*?)(${TOKEN})`, 'gu');
/** «Your login code is …» — the English «is» and the token after it. */
const IS_TOKEN = new RegExp(String.raw`(?<![\p{L}\p{N}])(is)(\s+?)(${TOKEN})`, 'giu');
/** A line that is one token and nothing else. */
const LONE_TOKEN = new RegExp(`^${TOKEN}$`, 'u');

/**
 * The token a code word announces — after «code:» (the code word on the colon's own line, at most `BEFORE_CODE`
 * characters before it, as `telegramNoticeKind` reads it) or after «code is» — goes whole as «‹…›», whatever its
 * shape: an all-capital or all-small code (my.telegram.org's «WYBJEPLZXVE», «yfssilqzwzk») looks like no code to the
 * word rule and is one here. A token with no letter keeps its «#» shape — its digits say nothing, and their count is
 * what the rule reads.
 */
function redactAnnounced(text: string): string {
  const announced = (token: string): string => (/\p{L}/u.test(token) ? '‹…›' : token);
  return text
    .replace(COLON_TOKEN, (whole, colon: string, space: string, token: string, at: number, all: string) => {
      const lineStart = all.lastIndexOf('\n', at - 1) + 1;
      const before = all.slice(Math.max(lineStart, at - BEFORE_CODE), at).toLowerCase();
      return CODE_WORD.test(before) ? `${colon}${space}${announced(token)}` : whole;
    })
    .replace(IS_TOKEN, (whole, is: string, space: string, token: string, at: number, all: string) => {
      const before = all.slice(Math.max(0, at - BEFORE_CODE), at).toLowerCase();
      return CODE_WORD_AT_END.test(before) ? `${is}${space}${announced(token)}` : whole;
    });
}

/** A script written without spaces: a whole Chinese or Japanese sentence is one token, and is no code. */
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/**
 * A line that is one token holding a letter goes whole: that is where my.telegram.org puts its code («This is your
 * login code:» ⏎ «aB3dE9fG2»), and a code of letters alone in one case reads as a word to every other rule. Kept: a
 * line holding «/» (a link, already cut to its host), one ending in a colon (a field's name, its value below), and
 * one in a script written without spaces («新登录。» is a sentence) — a code there is the colon's (`redactAnnounced`).
 */
function redactLoneTokens(text: string): string {
  return text
    .split(/(\r?\n|\r)/u)
    .map((line) => {
      const token = line.trim();
      if (token === '' || !LONE_TOKEN.test(token) || !/\p{L}/u.test(token)) return line;
      if (token.includes('/') || /[:：]$/u.test(token) || UNSPACED_SCRIPT.test(token)) return line;
      return line.replace(token, '‹…›');
    })
    .join('');
}

/** One word, judged: a code's shape goes whole, a number keeps its count of «#», an ordinary word stays. */
function redactWord(word: string): string {
  const letters = /\p{L}/u.test(word);
  const digits = /\p{N}/u.test(word);
  if (digits && letters) return '‹…›';
  if (digits) return word.replace(/\p{N}/gu, '#');
  if (!letters) return word;
  if (word.includes('_')) return '‹…›';
  if (word.includes('-')) return PLAIN_HYPHENATED.test(word) ? word : '‹…›';
  if ([...word].length >= 6 && /\p{Ll}.*\p{Lu}/u.test(word)) return '‹…›';
  return word;
}

/**
 * Pure: the SHAPE of a 777000 line, for the listener's log — so the real texts Telegram sends his account can be read
 * off his server and the rule (`telegramNoticeKind`) settled against them, though nobody here can see one. What is
 * kept is what the rule reads: the words in their places, how many digits a number has and how they are spaced
 * («Login code: #####.», «## ###», «##.##.####»), the line breaks as « ⏎ » (the rule looks at the first two lines).
 *
 * A login code cannot be read back from it: Telegram's codes are digits only and EVERY digit, in any script (Persian
 * and Arabic-Indic too), becomes «#» — the count stays, the value never does. my.telegram.org's code is letters,
 * digits, «-» and «_», and it goes whole as «‹…›» three ways, any one of them enough: a word holding a digit and a
 * letter, a «_», a «-» in a word with a capital past its first letter, or six letters with a capital after a small one
 * (`redactWord`, on the word WITH its «-» and «_»); a line that is one token (`redactLoneTokens`); the token after
 * «code:» or «code is» (`redactAnnounced`). A link keeps only its host (a login link carries the code in its path, a
 * token in its query), and a query value outside one goes too. The greeting's name and the alert's «Location:» value
 * go — they are his, not the shape. Invisible marks are taken out FIRST, or a zero-width space would split a code into
 * pieces too short to look like one. At most `REDACTED_MAX` characters.
 *
 * Not caught, and stated: a code of letters alone in one case (or capitals then small ones, or small ones joined by
 * «-») standing in the middle of a sentence with no code word before it — no rule tells it from a word without a
 * dictionary; my.telegram.org puts its code on its own line after «login code:», where two of the three rules take it.
 */
export function redactNotice(text: string): string {
  const cut = text
    .replace(/\p{Cf}/gu, '')
    .replace(SCHEME_LINK, (_link, scheme: string, host: string, rest: string) => `${scheme}${host}${rest === '' ? '' : '/…'}`)
    .replace(BARE_LINK, (_link, host: string) => `${host}/…`)
    .replace(QUERY_VALUE, '$1‹…›')
    .replace(GREETING_NAME, '$1$2‹…›')
    .replace(LOCATION_VALUE, '$1$2‹…›');
  const shape = redactLoneTokens(redactAnnounced(cut))
    .replace(WORD, redactWord)
    .replace(/\r?\n|\r/gu, ' ⏎ ');
  const chars = [...shape];
  return chars.length <= REDACTED_MAX ? shape : `${chars.slice(0, REDACTED_MAX - 1).join('')}…`;
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
