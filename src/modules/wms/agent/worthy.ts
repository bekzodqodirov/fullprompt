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
  /**
   * A run of the MODEL would be dishonest here (Q3, Q4 ⭐): it cannot hear a voice note or write Pashto. Since stage 1a
   * the code answers such a burst with a tayyor matn (system-reply.ts), and the owner is told only when that line was
   * already said in this silence. «Botmisiz?» left this list (his 1 b): the run goes on and the honest line is put in
   * front of its reply (run `withBotAnswer`).
   */
  | { worthy: false; reason: 'voice_only' | 'pashto'; notice: true };

const CLOSING =
  /^(?:ok(?:ey|ay)?|okk+|хорошо|хоп|xop|hop|ha|ҳа|ха|да|yes|ya|rahmat|raxmat|ташаккур|tashakkur|рахмат|раҳмат|спасибо|спс|сп|благодарю|thanks?|thank\s+you|thx|ty|mersi|мерси|ممنون|مرسی|متشکرم|تشکر|سپاس|谢谢|謝謝|好的|好|嗯|收到|明白|tushundim|тушундим|понятно|ясно|got\s+it|kelishdik|келишдик|договорились|bo['‘’ʻ]?pti|бўпти|майли|mayli|alright|fine|👍+|🙏+|👌+|✅|❤️|😊|🙂)[\s.!,)]*$/iu;

const GREETING =
  /^(?:salom|assalomu\s+alaykum|assalom|салом|ассалому\s+алайкум|здравствуйте|здравствуй|привет|добрый\s+(?:день|вечер)|доброе\s+утро|hello|hi|hey|good\s+(?:morning|afternoon|evening)|سلام|درود|你好|您好|hayrli\s+kun|хайрли\s+кун)[\s.!,)]*$/iu;

const NUDGE = /^(?:[?？؟!.…]+|алло|ало|ау|аууу?|hello\?+|hmm+|ммм+|javob\s+bering|ответьте|reply|kutyapman|жду|\?\s*\?)[\s?？؟!.]*$/iu;

/**
 * Letters only Pashto writes beside Persian's alphabet — less «ې» (U+06D0), which Uyghur writes too (J7: «يۈكنى ئېلىپ
 * كېلىڭ» was told to write in Persian or Russian). A Pashto line nearly always carries one of the others.
 */
const PASHTO = /[ټډړږښګڼۍځڅ]/u;
/** …and Uyghur's own letters: a line carrying one is Uyghur, whatever else it shares with Pashto. */
const UYGHUR = /[ۈۆڭۋ]/u;

/**
 * «Are you a bot?» in the six languages — as QUESTIONS about us, in whole words (J6). A word that only contains «bot»,
 * «ai» or «机器人» is the customer's goods or a place: «ботинки», «Dubaimi» («Dubai?»), «Shanxaimi», 扫地机器人 (a robot
 * vacuum), «Робот-пылесос», «ربات آشپزخانه» — under stage 1a each would be answered «yes, I am an AI». 机器人 / ربات /
 * «robot» count only inside a «you are …» question; «бот» / «bot» / «ai» only as words of their own.
 */
const B = '(?<![\\p{L}\\p{N}-])';
const E = '(?![\\p{L}\\p{N}-])';
const BOT_QUESTION = new RegExp(
  [
    // Uzbek, both scripts: «botmisiz», «robotmi», «AImisiz», «odammisiz», «bot emasmi», «siz bot».
    `${B}(?:bot|robot|odam|ai|бот|робот|одам)\\s*(?:mi|misiz|misan|ми|мисиз|мисан)${E}`,
    `${B}(?:bot|robot|бот|робот)\\s+(?:emasmi|emasmisiz|эмасми|эмасмисиз)${E}`,
    `${B}(?:siz|sen|сиз|сен)\\s+(?:bot|robot|бот|робот)${E}`,
    `${B}sun['‘’ʻ\`]?iy\\s+intellekt(?:mi|misiz|misan)${E}`,
    // Russian: «вы бот?», «это робот?», «ты бот или человек», «я с ботом общаюсь?», «вы живой человек?», «бот?».
    `${B}(?:вы|ты|это)\\s+(?:бот|робот|ии|нейросеть|искусственный\\s+интеллект)${E}`,
    `${B}(?:бот|робот)\\s*\\?`,
    `${B}с\\s+бот(?:ом)?${E}`,
    `${B}(?:вы|ты)\\s+(?:живой\\s+|реальный\\s+)?человек${E}`,
    // English: «are you a bot?», «are you a real person», «is this a bot?», «am I talking to a bot?».
    `${B}(?:are|r)\\s+(?:you|u)\\s+(?:a\\s+|an\\s+)?(?:real\\s+|live\\s+)?(?:bot|robot|ai|human|person)(?=\\s*(?:[?.!,]|$|or${E}|and${E}))`,
    `${B}is\\s+(?:this|it)\\s+(?:a\\s+|an\\s+)?(?:bot|robot|ai)(?=\\s*(?:[?.!,]|$|or${E}))`,
    `${B}(?:talking|chatting|speaking|writing)\\s+(?:to|with)\\s+(?:a\\s+|an\\s+)?(?:bot|robot|ai|human|real\\s+person)${E}`,
    // Persian: «شما ربات هستید؟», «آیا ربات هستی؟» — never «ربات آشپزخانه» (a kitchen robot).
    '(?:شما|تو)\\s+(?:یک\\s+)?(?:ربات|هوش\\s+مصنوعی)',
    '(?:ربات|هوش\\s+مصنوعی)\\s*(?:هستی|هستید|ای)(?![\\p{L}])',
    // Chinese: «你是机器人吗», «你是不是机器人», «您是AI吗», «是真人还是机器人» — never 扫地机器人.
    '(?:你|您)(?:是|是不是)(?:一个)?(?:机器人|AI|ai|人工智能|真人)',
    '真人还是机器人|机器人还是真人|是机器人吗',
  ].join('|'),
  'iu',
);

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
  return PASHTO.test(text) && !UYGHUR.test(text);
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
  if (texts.length === 0) {
    const voice = burst.every((m) => m.media === 'voice' || m.media === 'audio');
    return voice ? { worthy: false, reason: 'voice_only', notice: true } : { worthy: false, reason: 'media_only' };
  }
  if (!lastOutAsked && texts.every(isClosing)) return { worthy: false, reason: 'closing' };
  return { worthy: true, greetingOnly: texts.every(isGreeting) };
}
