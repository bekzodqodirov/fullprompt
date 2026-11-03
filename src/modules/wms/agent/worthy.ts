import { normalizeDigits } from './digits';

/**
 * Does this burst deserve a reply at all — decided BEFORE a run is reserved
 * (review fit-1). The listener stores every sticker, every photo with no
 * caption, every voice note and every «ok»/«rahmat»; each was going to be a
 * model run, a card and a slot of the day's cap. Pure; the policy's
 * live-head check asks the same `isNudge` so «??» after his ✅ does not cancel
 * the reply it is waiting for (fit-8 c).
 */

export interface BurstMessage {
  text: string | null;
  /** 'photo' | 'document' | 'voice' | 'audio' | 'video' | 'sticker' … — anything stored beside the text. */
  media: string | null;
}

export type Worthiness =
  | { worthy: true; greetingOnly: boolean }
  | { worthy: false; reason: 'empty' | 'media_only' | 'closing' }
  /** A run would be dishonest here: the owner is told, nothing is drafted (Q3, Q4 ⭐). */
  | { worthy: false; reason: 'voice_only' | 'pashto' | 'bot_question'; notice: true };

const CLOSING =
  /^(?:ok(?:ey|ay)?|okk+|хорошо|хоп|xop|hop|ha|ҳа|ха|да|yes|ya|rahmat|raxmat|ташаккур|tashakkur|рахмат|раҳмат|спасибо|спс|сп|благодарю|thanks?|thank\s+you|thx|ty|mersi|мерси|ممنون|مرسی|متشکرم|تشکر|سپاس|谢谢|謝謝|好的|好|嗯|收到|明白|tushundim|тушундим|понятно|ясно|got\s+it|kelishdik|келишдик|договорились|bo['‘’ʻ]?pti|бўпти|майли|mayli|alright|fine|👍+|🙏+|👌+|✅|❤️|😊|🙂)[\s.!,)]*$/iu;

const GREETING =
  /^(?:salom|assalomu\s+alaykum|assalom|салом|ассалому\s+алайкум|здравствуйте|здравствуй|привет|добрый\s+(?:день|вечер)|доброе\s+утро|hello|hi|hey|good\s+(?:morning|afternoon|evening)|سلام|درود|你好|您好|hayrli\s+kun|хайрли\s+кун)[\s.!,)]*$/iu;

const NUDGE = /^(?:[?？؟!.…]+|алло|ало|ау|аууу?|hello\?+|hmm+|ммм+|javob\s+bering|ответьте|reply|kutyapman|жду|\?\s*\?)[\s?？؟!.]*$/iu;

/** Letters only Pashto writes (beside Persian's alphabet). */
const PASHTO = /[ټډړږښګڼۍېځڅ]/u;

const BOT_QUESTION =
  /(?:bot(mi|misiz|misan)\b|robot(mi|misiz)|siz\s+botmisiz|ai\s*(mi|misiz)\b|sun['‘’ʻ]?iy\s+intellekt|ботмисиз|бот\s*\?|вы\s+бот|ты\s+бот|это\s+бот|робот\s*\?|are\s+you\s+(?:a\s+)?(?:bot|robot|ai|human)|is\s+this\s+(?:a\s+)?(?:bot|ai)|ربات|هوش\s+مصنوعی|机器人|人工智能|你是ai|你是AI)/iu;

function clean(text: string | null): string {
  return normalizeDigits(text ?? '').trim();
}

/** A text that asks nothing new — «??», «alo», a closing token. */
export function isNudge(text: string): boolean {
  const t = clean(text);
  return t === '' || NUDGE.test(t) || CLOSING.test(t);
}

export function isGreeting(text: string): boolean {
  return GREETING.test(clean(text));
}

export function isClosing(text: string): boolean {
  return CLOSING.test(clean(text));
}

export function asksIfBot(text: string): boolean {
  return BOT_QUESTION.test(clean(text));
}

export function isPashto(text: string): boolean {
  return PASHTO.test(text);
}

/**
 * Rail, in the agent's six languages (his 2026-10-24: «Temir yo'l mendan
 * so'rasin narxini»), as customers actually type it — «temir yul», «temiryul»,
 * «poyzd», «ж.д.», «вагоном», «по железке», «班列». Whole words where a short
 * form is a piece of another word: «жд» is the start of «жду» (I am
 * waiting), «rail» sits inside «trailer», «temir yul» starts «temir yulduz»
 * (a star). «железн…» also matches iron goods («железные изделия») — a false
 * positive only puts the question to him, which is the safe direction; but
 * «железки» alone is the hardware a customer sends, so the slang counts only
 * as «по / на железке» (#1540).
 */
const RAIL =
  /temir[\s-]?y[ou]['‘’ʻ`]?l(?!duz)|po(?:ye|e|y)zd|темир[\s-]?й[ўу]л|поезд(?!к)|(?<!\p{L})ж\s?[./]?\s?д\.?(?!\p{L})|железнодорож|железн\p{L}*\s+дорог|(?:по|на)\s+железк|вагон|vagon|(?<!\p{L})rail(?:way|road)?s?(?!\p{L})|(?<!\p{L})trains?(?!\p{L})|قطار|راه[\s‌]?آهن|铁路|火车|班列/iu;

/** The question the draft carries for him when a burst asks about rail and the model asked none. */
export const RAIL_OWNER_QUESTION = "Mijoz temir yo'l narxini so'rayapti — narxni siz ayting.";

/** Does any message of the burst ask about rail? */
export function mentionsRail(texts: readonly (string | null)[]): boolean {
  return texts.some((t) => RAIL.test(clean(t)));
}

/**
 * The burst = the customer's messages since our last out row, oldest first.
 * `lastOutAsked` = our last message ended with a question — then «ok» is an
 * ANSWER and deserves a reply.
 */
export function draftWorthy(burst: readonly BurstMessage[], lastOutAsked: boolean): Worthiness {
  if (burst.length === 0) return { worthy: false, reason: 'empty' };
  const texts = burst.map((m) => clean(m.text)).filter((t) => t !== '');
  if (texts.some(isPashto)) return { worthy: false, reason: 'pashto', notice: true };
  if (texts.some(asksIfBot)) return { worthy: false, reason: 'bot_question', notice: true };
  if (texts.length === 0) {
    const voice = burst.every((m) => m.media === 'voice' || m.media === 'audio');
    return voice ? { worthy: false, reason: 'voice_only', notice: true } : { worthy: false, reason: 'media_only' };
  }
  if (!lastOutAsked && texts.every(isClosing)) return { worthy: false, reason: 'closing' };
  return { worthy: true, greetingOnly: texts.every(isGreeting) };
}
