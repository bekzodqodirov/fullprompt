import { codeCandidates } from '../calc/channel-post';
import { normalizeDigits, unverifiableNumeral } from './digits';
import { AGENT_LIMITS } from './limits';
import { dominantScript, scriptOf, type AgentLocale, type ScriptName } from './locale';
import { extractNumbers, numberLedger, phoneDigits, PHONE_RE, urlsIn, type LedgerEntry, type NumberSource } from './numbers';

/**
 * The rules a reply must pass before ✅ exists (spec §6, review §17.6).
 *
 * PURE and BLOCKING: every hit is a reason the card carries no ✅ and
 * `decideDraft` re-runs this on the stored body and refuses. «Everything is a
 * draft anyway» was the first design's sentence and it is exactly how a
 * warning line beside a live button gets pressed past (leak-3). The model is
 * told these rules too, but nothing here trusts it: they are checked after it.
 *
 * Every check reads the DIGIT-NORMALISED text (leak-7).
 */

export type PolicyRule = 'G1' | 'G2' | 'G4' | 'G5' | 'G6' | 'G10' | 'G11';

export type PolicyCode =
  | 'number_unverifiable'
  | 'number_unsourced'
  | 'promise'
  | 'too_long'
  | 'questions'
  | 'empty'
  | 'wrong_script'
  | 'other_client_code'
  | 'system_code'
  | 'foreign_phone'
  | 'staff_name'
  | 'canary'
  | 'ai_denial'
  | 'url'
  | 'mention'
  | 'map_unasked'
  | 'fingerprint'
  | 'url_cap'
  | 'estimate_unhedged';

export interface PolicyHit {
  rule: PolicyRule;
  code: PolicyCode;
  /** What was found — a category, a code, the figure. Shown on the card in words. */
  detail?: string;
}

export const PROMISE_CATEGORIES = [
  'discount',
  'guarantee',
  'credit_release',
  'refund',
  'free_extras',
  'dispatch_promise',
  'customs_included',
  'no_duty',
] as const;
export type PromiseCategory = (typeof PROMISE_CATEGORIES)[number];

/**
 * Leaving and arriving in the FUTURE or present tense, per language — read by
 * the day rule below and by `timePromise`. The past («yetib keldi»,
 * «jo'natildi», «отправили», «shipped») is a fact about cargo, never a promise.
 */
const GOING_UZ =
  "jo['‘’ʻ]?nat(?:amiz|aman|adi|iladi|ib\\s+beramiz)|yubor(?:amiz|aman|adi|iladi|ib\\s+beramiz)|yetkaz(?:amiz|aman|adi|iladi|ib\\s+beramiz)|yetib\\s+(?:keladi|boradi|kelamiz|boramiz|kelar|borar)|(?<![\\p{L}])(?:chiqadi|ketadi)(?![\\p{L}])";
const GOING_UZ_CYRL =
  'жўнат(?:амиз|аман|ади|илади)|юбор(?:амиз|аман|ади|илади)|етказ(?:амиз|аман|ади|илади)|етиб\\s+(?:келади|боради|келамиз|борамиз)|(?<![\\p{L}])(?:чиқади|кетади)(?![\\p{L}])';
const GOING_RU =
  'отправ(?:им|лю|ят|ится|ятся)|выед(?:ет|ем|ут)|уед(?:ет|ем|ут)|прид[её]т|придут|прибуд(?:ет|ут)|достав(?:им|ят|ится|лю)|доед(?:ет|ут)|дойд[её]т|будет\\s+у\\s+вас';

/**
 * G2: what may never be promised from his account by a machine, in every
 * language a reply can be written in (money-8). A CLOSED table: a category is
 * a business decision someone else's door makes (a discount is the VED's, a
 * release on credit is `counterDebtRelease`'s, a refund is the accountant's),
 * and his Q8 ⭐ — none of the website's extras exists in the system, so none
 * is stated. Run over EVERY language at once: a Russian promise inside an
 * Uzbek reply is still a promise.
 *
 * The review measured everyday phrasings passing the whole policy (P2):
 * «narxni tushirib beraman», «arzon qilamiz», «10% kamroq qilamiz», «скинем
 * 10%», «сбавлю цену», «10% off», «ertaga albatta jo'natamiz» (one word
 * between the day and the verb), «pulini keyin berasiz», «оплатите после
 * получения». Each stem is tied to the money or the day it is about, because
 * the bare verb is ordinary work here: «yukni tushiramiz» is unloading,
 * «скиньте фото» is «send a photo», «narxni tushuntiraman» explains a price,
 * and «отправим после оплаты» is the opposite of credit.
 */
export const PROMISE_TABLE: Record<PromiseCategory, readonly RegExp[]> = {
  discount: [
    /chegirma|skidka|arzonroq|arzonlashtir|arzon\s+qilib/iu,
    /narx\p{L}*\s+(?:[\p{L}'‘’ʻ]+\s+)?(?:tushir|tushib\s+ber|pasay|kamay|arzonlash|arzon\s+qil)/iu,
    /arzon(?:roq)?\s+(?:qil|ber|chiqar)|kamroq\s+(?:qil|ber|olamiz|olaman|olib)/iu,
    /чегирма|арзонроқ|арзонлаштир/iu,
    /нарх\p{L}*\s+(?:\p{L}+\s+)?(?:тушир|тушиб\s+бер|пасай|камай|арзонлаш|арзон\s+қил)|арзон(?:роқ)?\s+(?:қил|бер)|камроқ\s+(?:қил|бер|олам)/iu,
    /скидк|дешевле|уступ(лю|им|ка)/iu,
    /скин\p{L}*\s+(?:\p{L}+\s+){0,2}(?:\d+\s*%|цен|процент)|сбав(?:лю|им|ит|ить|ляем|ляю)|сниз\p{L}*\s+(?:\p{L}+\s+)?цен|цен\p{L}*\s+(?:\p{L}+\s+)?сниз/iu,
    /\bdiscount|\bcheaper\b|lower\s+(the\s+)?price|reduce\s+(the\s+)?price/iu,
    /\boff\s+the\s+price|price\s+(?:cut|drop)|knock\s+(?:\p{L}+\s+){0,2}off\b/iu,
    // A percent taken off, in any language: «10% kamroq», «10 foiz arzonroq», «10% off», «10%优惠».
    /\d+(?:[.,]\d+)?\s*(?:%|٪|foiz\p{L}*|фоиз\p{L}*|процент\p{L}*|percent)\s*(?:\p{L}+\s+)?(?:kam|arzon|chegirma|skidka|кам|арзон|скид|дешевле|меньше|off\b|less\b|cheaper|تخفیف|کمتر|折|优惠|便宜|少)/iu,
    /تخفیف|ارزان‌تر|ارزانتر/u,
    /(?:قیمت|نرخ)\s+(?:\p{L}+\s+){0,2}کم(?:تر)?(?!\p{L})/u,
    /折扣|优惠|打折|便宜点|减价|让利/u,
    /便宜(?:些|一点|一些)|给(?:你|您)便宜|算(?:你|您)?便宜|降价|少收|打\d+折/u,
  ],
  guarantee: [
    /kafolat|garantiya|muammo\s+bo['‘’ʻ]?lmaydi|muammosiz/iu,
    /кафолат|муаммо\s+бўлмайди/iu,
    /гарант|без\s+проблем|100\s?%\s+(будет|придет|доставим)/iu,
    /guarantee|no\s+problem\b|definitely\s+(arrive|deliver)/iu,
    /تضمین|ضمانت|بدون\s+مشکل/u,
    /保证|担保|肯定没问题|百分之百/u,
  ],
  credit_release: [
    /qarzga|nasiya|keyin\s+to['‘’ʻ]?laysiz|to['‘’ʻ]?lovsiz\s+(beramiz|beraman|olib\s+ketasiz)/iu,
    // «Pulini keyin berasiz», «to'lovni keyinroq qilasiz» — the money, later, paid by you.
    /(?:pul|to['‘’ʻ]?lov|haq|summa)\p{L}*\s+(?:[\p{L}'‘’ʻ]+\s+){0,2}keyin\p{L}*\s+(?:berasiz|bersangiz|qilasiz|o['‘’ʻ]?tkazasiz|to['‘’ʻ]?laysiz|to['‘’ʻ]?lasangiz)/iu,
    /keyin\p{L}*\s+(?:to['‘’ʻ]?la(?:ysiz|sangiz)|o['‘’ʻ]?tkazasiz)/iu,
    /қарзга|насия/iu,
    /(?:пул|тўлов)\p{L}*\s+(?:\p{L}+\s+){0,2}кейин\p{L}*\s+(?:берасиз|қиласиз|тўлайсиз)|кейин\p{L}*\s+тўлайсиз/iu,
    /в\s+долг|в\s+кредит|рассрочк|оплатите\s+(потом|позже)|потом\s+заплатите/iu,
    // «Оплатите после получения» is credit; «отправим после оплаты» is the opposite and is not matched.
    /(?:оплат|заплат|рассчита)\p{L}*\s+(?:\p{L}+\s+)?(?:потом|позже|после\s+(?:получения|прибытия|доставки))/iu,
    /on\s+credit|pay\s+later|deferred\s+payment/iu,
    /pay\p{L}*\s+(?:\p{L}+\s+){0,2}(?:later|after\s+(?:delivery|arrival|you\s+(?:get|receive)))/iu,
    /نسیه|قرضی|بعدا\s+پرداخت/u,
    /بعد(?:اً|ًا|ا)?\s+(?:\p{L}+\s+)?(?:پرداخت|بپردازید)|پرداخت\s+(?:\p{L}+\s+)?بعد(?:اً|ًا|ا)?(?!\p{L})/u,
    /赊账|赊欠|先发货后付款|后付款/u,
    /以后(?:再)?付|晚点付|过后付|到货(?:后|再)付/u,
  ],
  refund: [
    /pul\p{L}*\s+qaytar|qaytarib\s+beramiz|kompensatsiya|tovon/iu,
    /пул\p{L}*\s+қайтар|компенсация|товон/iu,
    /верн(ём|ем|у)\s+деньги|возврат\s+денег|компенсац|возмест/iu,
    /refund|compensat|money\s+back|reimburs/iu,
    /بازپرداخت|پس\s+می‌?دهیم|جبران\s+خسارت|غرامت/u,
    /退款|赔偿|退钱|补偿/u,
  ],
  free_extras: [
    /bepul|tekin|sug['‘’ʻ]?urta|eshikkacha|uyingizgacha|fotootchet|foto\s*hisobot|qayta\s+qadoq/iu,
    /бепул|текин|суғурта|эшиккача/iu,
    /бесплатн|страхов|до\s+двери|фотоотч|переупаков/iu,
    /\bfree\b|insurance|door[\s-]to[\s-]door|door\s+delivery|photo\s+report|repack/iu,
    /رایگان|مجانی|بیمه|درب\s+منزل/u,
    /免费|保险|送货上门|拍照报告|重新包装/u,
  ],
  dispatch_promise: [
    // Up to two words between the day and the verb — «ertaga albatta jo'natamiz», «bugun kechqurun yuboramiz» —
    // and the verb in the FUTURE: «yukingiz bugun Toshkentga yetib keldi» is the commonest status there is.
    new RegExp(`(?:ertaga|bugun|indinga)\\s+(?:[\\p{L}'‘’ʻ]+\\s+){0,2}(?:${GOING_UZ})|(?:${GOING_UZ})\\s+(?:ertaga|bugun|indinga)|va['‘’ʻ]?da\\s+(beraman|beramiz)|kafolatlay`, 'iu'),
    new RegExp(`(?:эртага|бугун|индинга)\\s+(?:\\p{L}+\\s+){0,2}(?:${GOING_UZ_CYRL})|ваъда\\s+бер`, 'iu'),
    new RegExp(`(?:завтра|сегодня)\\s+(?:\\p{L}+\\s+){0,2}(?:${GOING_RU})|(?:${GOING_RU})\\s+(?:завтра|сегодня)|обеща`, 'iu'),
    /(?:ship|send|dispatch)(?:es|s|ing)?\s+(?:\p{L}+\s+){0,2}(?:today|tomorrow)|\bi\s+promise|\bwe\s+promise|will\s+arrive\s+(by|on)\b/iu,
    /قول\s+می‌?دهم|فردا\s+ارسال|امروز\s+ارسال/u,
    /承诺|明天发货|今天发货|保证到/u,
  ],
  customs_included: [
    /(boj|bojxona|rastamojka)\p{L}*\s+(ham\s+)?(narx(ga|ida)?\s+)?(kiradi|ichida|bilan\s+birga)/iu,
    /(бож|божхона|растаможка)\p{L}*\s+(ҳам\s+)?(киради|ичида)/iu,
    /(растаможк|таможн|пошлин)\p{L}*\s+(тоже\s+)?включ|с\s+растаможкой|включая\s+(таможн|растаможк|пошлин)/iu,
    /(customs|duty|duties)\s+(is\s+|are\s+)?included|including\s+(customs|duty|duties)/iu,
    /(گمرک|عوارض)\s+(هم\s+)?شامل/u,
    /包税|含税|包清关|含关税/u,
  ],
  no_duty: [
    /bojsiz|boj\s+yo['‘’ʻ]?q|boj\s+to['‘’ʻ]?lamaysiz/iu,
    /божсиз|бож\s+йўқ/iu,
    /без\s+пошлин|пошлин\p{L}*\s+нет|без\s+растаможки/iu,
    /duty[\s-]free|no\s+(customs\s+)?dut(y|ies)|without\s+dut(y|ies)/iu,
    /بدون\s+(گمرک|عوارض)|معاف\s+از\s+گمرک/u,
    /免税|免关税|不用交税/u,
  ],
};

/**
 * An arrival or a dispatch in the FUTURE tense — «yetib keladi», «придёт»,
 * «will arrive». The past («yetib keldi», «arrived») is a fact about cargo
 * that came, and is no promise.
 */
const ARRIVAL_VERB: readonly RegExp[] = [
  // With a day count a bare «keladi» / «boradi» is the cargo's: «mashina 5 kunda boradi».
  new RegExp(`${GOING_UZ}|(?<![\\p{L}])(?:keladi|boradi)(?![\\p{L}])`, 'iu'),
  new RegExp(`${GOING_UZ_CYRL}|(?<![\\p{L}])(?:келади|боради)(?![\\p{L}])`, 'iu'),
  new RegExp(GOING_RU, 'iu'),
  /\b(?:arrive|arrives|deliver|delivers|ship|ships|reach|reaches|dispatch)\b|get\s+there/iu,
  /می‌?\s?رسد|میرسد|می‌?\s?رسه|ارسال\s+می|تحویل\s+می|می‌?\s?فرستیم/u,
  /到达|送到|运到|到货|发货|能到|会到|送达|抵达/u,
];

/** «Taxminan», «odatda», «примерно», «usually», «大约» — the words that make a day count an estimate. */
const ESTIMATE_HEDGE =
  /taxmin|odatda|o['‘’ʻ]?rtacha|chamasi|тахмин|одатда|ўртача|чамаси|примерн|ориентировочн|приблизительн|обычно|в\s+среднем|около|approx|estimat|\babout\b|\baround\b|usually|typically|roughly|تقریب|حدود|معمولا|大约|约|大概|预计|通常|一般|左右|~/iu;

/** …and the words that make it a promise again, hedged or not: «taxminan 2 kunda ALBATTA yetib boradi». */
const CERTAINTY =
  /albatta|shubhasiz|kafolat|албатта|шубҳасиз|кафолат|обязательно|непременно|гарантир|definitely|certainly|guarantee|for\s+sure|\bpromise|حتما|حتماً|قطعا|قطعاً|تضمین|一定|肯定|保证|绝对|100\s*%/iu;

/** «Har 3 kunda», «каждые 3 дня», «every 3 days» — a timetable, not a promise. */
const FREQUENCY = /(?<![\p{L}])(?:har|ҳар|каждые|каждый|каждую|every|هر)\s+\d|每/iu;

/** A text's sentences — a decimal point is not a full stop. */
function sentencesOf(text: string): string[] {
  return text.split(/[!?؟。！？\n]+|\.(?=\s|$)/u).filter((s) => s.trim() !== '');
}

/**
 * G2 for a day count (P2, his §17.14 answer): «2 kunda yetib keladi» is a
 * promise; «taxminan 2-5 kunda yetib boradi» — the avia window he said the AI
 * may give — is an ESTIMATE and passes, with G1 checking the days against
 * the tool's source. A sentence that says when cargo arrives or leaves, with
 * a duration, and no hedge — or a certainty word — is a dispatch promise; a
 * timetable («mashina har 3 kunda chiqadi») is a fact about the company.
 * The hedge must be in the SAME sentence: «Taxminan shunday. 2 kunda yetib
 * keladi.» still promises two days.
 */
export function timePromise(text: string): boolean {
  for (const s of sentencesOf(normalizeDigits(text))) {
    if (!ARRIVAL_VERB.some((re) => re.test(s))) continue;
    if (!extractNumbers(s).some((f) => f.kind === 'duration')) continue;
    if (CERTAINTY.test(s)) return true;
    if (!ESTIMATE_HEDGE.test(s) && !FREQUENCY.test(s)) return true;
  }
  return false;
}

/** «I am not a bot» in every language — never written by a machine about itself (spec G6). */
const AI_DENIAL = [
  /bot\s+emas(man)?|men\s+(odam|inson)(man)?\b|robot\s+emas/iu,
  /бот\s+эмас|мен\s+(одам|инсон)/iu,
  /я\s+не\s+(бот|робот)|я\s+(живой\s+)?человек/iu,
  /\bi['’]?m\s+not\s+a\s+(bot|robot)|\bi\s+am\s+not\s+a\s+(bot|robot)|\bi\s+am\s+(a\s+)?(real\s+)?human/iu,
  /ربات\s+نیستم|من\s+انسان/u,
  /我不是机器人|我是真人/u,
];

/** Spec G11: the approximation word, per language. */
const APPROX: Record<AgentLocale, RegExp> = {
  uz: /taxmin/iu,
  uz_cyrl: /тахмин/iu,
  ru: /примерн|ориентировочн|приблизительн/iu,
  en: /approx|estimat|about\b|around\b/iu,
  fa: /تقریب|حدود/u,
  zh: /大约|约|大概|预计|估/u,
};

/** Spec G11: «boj va QQS alohida», per language — each word that must be there. */
const EXCLUSION: Record<AgentLocale, readonly RegExp[]> = {
  uz: [/boj/iu, /qqs/iu, /alohida/iu],
  uz_cyrl: [/бож/iu, /ққс|ҚҚС/u, /алоҳида/iu],
  ru: [/пошлин/iu, /ндс/iu, /отдельно/iu],
  en: [/dut(y|ies)/iu, /vat/iu, /separate/iu],
  fa: [/عوارض|گمرک/u, /مالیات/u, /جداگانه/u],
  zh: [/关税/u, /增值税/u, /另/u],
};

/** The exclusion sentence as the reply should carry it — the model is told it, and the policy checks it. */
export const EXCLUSION_SENTENCE: Record<AgentLocale, string> = {
  uz: 'Boj va QQS alohida hisoblanadi.',
  uz_cyrl: 'Бож ва ҚҚС алоҳида ҳисобланади.',
  ru: 'Пошлина и НДС считаются отдельно.',
  en: 'Customs duty and VAT are calculated separately.',
  fa: 'عوارض گمرکی و مالیات بر ارزش افزوده جداگانه محاسبه می‌شود.',
  zh: '关税和增值税另行计算。',
};

/** The system's own minted shapes (crate, box, receipt, pickup, deal) — never in a customer reply. */
const SYSTEM_SHAPE_RES: readonly RegExp[] = [
  /\bCR-[A-Za-z0-9]*\d{2}-\d{5,}/u,
  /\b[A-Za-z][A-Za-z0-9]*\d{2}-\d{6,}/u,
  /\b[A-Za-z0-9]+\s?-\s?IN\s?-\s?\d{6}\s?-\s?\d+/u,
  /\bZR-\d{5,}/u,
  /\b[BБ](?:\s?[-‐‑‒–—_]\s?\d{6,}|\d{6,})/u,
];

const QUESTION_MARKS = /[?؟？]/gu;
const MENTION = /(?<![\p{L}\p{N}])@[A-Za-z][A-Za-z0-9_]{3,}/u;

export interface PolicyInput {
  body: string;
  /** The reply's language (compose_reply.language). */
  language: AgentLocale;
  /** The dominant script of the customer's last inbound messages; null = too little text to say. */
  customerScript: ScriptName | null;
  /** Every figure source of THIS run (tools, the offer, the customer's own figures, kb facts). */
  numberSources: readonly NumberSource[];
  /** Taken out whole before any figure is read: the persona's phone, an approved link. */
  removeWhole: readonly string[];
  /** This chat's own client codes (the chat's client and its phone siblings). */
  ownCodes: readonly string[];
  /** Of the draft's code candidates, those the client book holds — the IO layer asks. */
  bookCodes: ReadonlySet<string>;
  /** The client-code prefix setting (GS) — a prefix + digits is a code even when the book was not asked. */
  codePrefix: string;
  /** Phones that may appear: kb facts' phones, the customer's own manager's. Compared as digits. */
  allowedPhones: readonly string[];
  /** Links that may appear (approved kb facts). */
  allowedUrls: readonly string[];
  /** The map link — allowed only when the customer asked where (his Q12 ⭐). */
  mapUrls: readonly string[];
  askedLocation: boolean;
  /** Active staff names that may NOT appear (the customer's own manager is left out by the caller). */
  staffNames: readonly string[];
  /** The customer's own name — a colleague's namesake is not a colleague (G6, P3). Absent = nobody's name is exempt. */
  customerNames?: readonly string[];
  /** A random token inside the system prompt; seeing it in a reply is a prompt leak. */
  canary: string;
  /** Distinct OTHER peers that got this reply's fingerprint in the last 24 h. */
  fingerprintPeers: number;
  /** AI messages with a link: to this chat in 7 days, and on the account today. */
  urlsToChat7d: number;
  urlsToday: number;
  /** A yo'lkira figure from the tool is in the reply's sources (G11 applies). */
  hasEstimate: boolean;
}

export interface PolicyResult {
  ok: boolean;
  blocks: PolicyHit[];
  warnings: PolicyHit[];
  ledger: LedgerEntry[];
}

/**
 * A phrase as a word of the text, case-insensitive, with up to `suffix`
 * letters of case ending after it — Uzbek and Russian put the case on the
 * name itself («Karimovga», «Каримову»).
 */
function wordIn(text: string, phrase: string, suffix = 0): boolean {
  const p = phrase.trim();
  if ([...p].length < 3) return false;
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/gu, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}\\p{L}{0,${suffix}}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/**
 * G6 in the other script (P3): «ГС778» is GS778 to anyone who reads it, and
 * the shipped check matched Latin only, so another customer's code spelled
 * in Cyrillic — or with one Cyrillic «С» inside a Latin code — passed. A
 * text is checked as written AND as two Latin shadows: by SHAPE (Cyrillic and
 * Greek letters drawn like Latin ones — «СR-», «В-000124», «ΑΒ123») and by
 * SOUND (the Uzbek Latin transliteration — «ГС» → GS, «Умриддин» → Umriddin).
 * Keys are lower-case; an upper-case letter maps to the upper-cased value.
 */
const BY_SHAPE: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', х: 'x', у: 'y', і: 'i', ј: 'j', ѕ: 's',
  α: 'a', β: 'b', ε: 'e', ζ: 'z', η: 'h', ι: 'i', κ: 'k', μ: 'm', ν: 'n', ο: 'o', ρ: 'p', τ: 't', υ: 'y', χ: 'x',
};
const BY_SOUND: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: "'",
  ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: "o'", қ: 'q', ғ: "g'", ҳ: 'h', і: 'i',
  α: 'a', β: 'b', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x',
  ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'x', ψ: 'ps', ω: 'o',
};

function mapLetters(text: string, map: Record<string, string>): string {
  let out = '';
  for (const ch of text) {
    const low = ch.toLowerCase();
    const to = map[low];
    out += to === undefined ? ch : ch === low ? to : to.toUpperCase();
  }
  return out;
}

/** The text as written and its two Latin shadows, distinct. */
function scriptShadows(text: string): string[] {
  return [...new Set([text, mapLetters(text, BY_SHAPE), mapLetters(text, BY_SOUND)])];
}

const APOSTROPHE = /[‘’ʻʼ`´]/gu;

/** How a name is compared: transliterated by sound, one apostrophe. «Ғулом» and «G‘ulom» are one name. */
function nameShadow(s: string): string {
  return mapLetters(s, BY_SOUND).replace(APOSTROPHE, "'");
}

/** Words of a full name that name nobody — «o'g'li», «qizi», «aka». */
const NAME_FILLER = new Set(["o'g'li", "og'li", 'ogli', 'ugli', 'qizi', 'kizi', 'aka', 'opa']);

/**
 * Every client-code candidate of a text in any of its spellings — what G6
 * judges and what the client book is asked about (policy-input.ts).
 */
export function codeCandidatesIn(text: string): string[] {
  return codeCandidates(scriptShadows(normalizeDigits(text)));
}

/** Codes in a text that are not this chat's: a book code, or the prefix followed by digits. */
export function foreignCodes(
  text: string,
  ctx: { ownCodes: readonly string[]; bookCodes: ReadonlySet<string>; codePrefix: string },
): string[] {
  const own = new Set(ctx.ownCodes.map((c) => c.toUpperCase()));
  const prefix = ctx.codePrefix.trim().toUpperCase();
  const out = new Set<string>();
  for (const c of codeCandidatesIn(text)) {
    if (own.has(c)) continue;
    const prefixed = prefix !== '' && c.startsWith(prefix) && /^\d+$/u.test(c.slice(prefix.length));
    if (ctx.bookCodes.has(c) || prefixed) out.add(c);
  }
  return [...out];
}

/**
 * G6 for a colleague's name (P3), decided: the FULL stored name — in either
 * script, with its case ending — BLOCKS, as it always did. One word of it
 * («Umriddin», «Karimovga») only WARNS: Uzbek first names and surnames are
 * shared by half the customers, so a block there would fire on the
 * customer's own name and on every namesake, costing him a ✏️ rewrite each
 * time — while the warning sits on the card beside ✅, which in phase 1 he
 * reads before anything is sent, so the colleague is never named unseen. A
 * word of the customer's own name is neither (a namesake is not a colleague);
 * a three-letter word must stand alone («Ali» is not «Alisher»).
 */
function staffNameHits(
  text: string,
  staffNames: readonly string[],
  customerNames: readonly string[],
  blocks: PolicyHit[],
  warnings: PolicyHit[],
): void {
  const seen = [text.replace(APOSTROPHE, "'"), nameShadow(text)];
  const customer = new Set(customerNames.flatMap((n) => nameShadow(n).toLowerCase().split(/\s+/u)).filter(Boolean));
  for (const name of staffNames) {
    const words = name.trim().split(/\s+/u).filter(Boolean);
    const shadowWords = words.map((w) => nameShadow(w));
    if (shadowWords.length === 0 || shadowWords.every((w) => customer.has(w.toLowerCase()))) continue;
    if (seen.some((s) => wordIn(s, shadowWords.join(' '), 5))) {
      blocks.push({ rule: 'G6', code: 'staff_name', detail: name });
      continue;
    }
    shadowWords.forEach((w, i) => {
      const low = w.toLowerCase();
      if (customer.has(low) || NAME_FILLER.has(low) || [...w].length < 3) return;
      if (seen.some((s) => wordIn(s, w, [...w].length >= 4 ? 5 : 0))) {
        warnings.push({ rule: 'G6', code: 'staff_name', detail: words[i]! });
      }
    });
  }
}

/** Phones in a text that are not allowed. */
export function foreignPhones(text: string, allowed: readonly string[]): string[] {
  const ok = new Set(allowed.map(phoneDigits).filter((d) => d.length >= 9).map((d) => d.slice(-9)));
  const found: string[] = [];
  for (const m of text.matchAll(PHONE_RE)) {
    const d = phoneDigits(m[0]);
    if (!ok.has(d.slice(-9))) found.push(m[0]);
  }
  return found;
}

/**
 * G10's fingerprint: what makes two replies «the same text» to Telegram's
 * spam heuristics — case, digits and spacing folded, the customer's own name
 * and codes taken out (they differ per chat by construction).
 */
export function textFingerprint(text: string, strip: readonly string[] = []): string {
  let t = normalizeDigits(text).toLowerCase();
  for (const s of strip) if (s.trim()) t = t.split(s.trim().toLowerCase()).join(' ');
  return t.replace(/\d+/gu, '#').replace(/[\s\p{P}]+/gu, ' ').trim();
}

export function questionCount(text: string): number {
  return (text.match(QUESTION_MARKS) ?? []).length;
}

/** Which promise categories a text hits. */
export function promiseHits(text: string): PromiseCategory[] {
  const t = normalizeDigits(text);
  return PROMISE_CATEGORIES.filter(
    (c) => PROMISE_TABLE[c].some((re) => re.test(t)) || (c === 'dispatch_promise' && timePromise(t)),
  );
}

/** The full check of a MACHINE reply. */
export function checkAgentReply(input: PolicyInput): PolicyResult {
  const blocks: PolicyHit[] = [];
  const warnings: PolicyHit[] = [];
  const text = normalizeDigits(input.body);
  const trimmed = text.trim();

  if (trimmed === '') blocks.push({ rule: 'G4', code: 'empty' });
  if ([...trimmed].length > AGENT_LIMITS.maxReplyChars) {
    blocks.push({ rule: 'G4', code: 'too_long', detail: String([...trimmed].length) });
  }
  if (questionCount(trimmed) > 1) blocks.push({ rule: 'G4', code: 'questions', detail: String(questionCount(trimmed)) });

  // G5 — the customer's script; Uzbek Cyrillic and Russian are one script here.
  const draftScript = dominantScript(trimmed);
  if (input.customerScript && draftScript !== 'none' && draftScript !== input.customerScript) {
    blocks.push({ rule: 'G5', code: 'wrong_script', detail: `${input.customerScript}→${draftScript}` });
  }
  if (draftScript !== 'none' && draftScript !== scriptOf(input.language)) {
    blocks.push({ rule: 'G5', code: 'wrong_script', detail: `${input.language}→${draftScript}` });
  }

  // G1 — numbers.
  const unverifiable = unverifiableNumeral(text);
  if (unverifiable) blocks.push({ rule: 'G1', code: 'number_unverifiable', detail: unverifiable });
  const removeWhole = [...input.removeWhole, ...input.allowedUrls, ...input.mapUrls];
  const ledger = numberLedger(text, input.numberSources, removeWhole);
  for (const e of ledger) {
    if (e.source === null) blocks.push({ rule: 'G1', code: 'number_unsourced', detail: e.raw });
  }

  // G2 — promises.
  for (const c of promiseHits(text)) blocks.push({ rule: 'G2', code: 'promise', detail: c });

  // G6 — whose things these are.
  for (const code of foreignCodes(text, input)) blocks.push({ rule: 'G6', code: 'other_client_code', detail: code });
  const shadows = scriptShadows(text);
  for (const re of SYSTEM_SHAPE_RES) {
    const m = shadows.map((s) => re.exec(s)).find((x) => x !== null);
    if (m) blocks.push({ rule: 'G6', code: 'system_code', detail: m[0] });
  }
  for (const p of foreignPhones(text, input.allowedPhones)) blocks.push({ rule: 'G6', code: 'foreign_phone', detail: p });
  staffNameHits(text, input.staffNames, input.customerNames ?? [], blocks, warnings);
  if (input.canary && text.includes(input.canary)) blocks.push({ rule: 'G6', code: 'canary' });
  if (AI_DENIAL.some((re) => re.test(text))) blocks.push({ rule: 'G6', code: 'ai_denial' });
  if (MENTION.test(text)) blocks.push({ rule: 'G6', code: 'mention' });
  const urls = urlsIn(text);
  for (const u of urls) {
    const isMap = input.mapUrls.some((m) => u.startsWith(m) || m.startsWith(u));
    if (isMap) {
      if (!input.askedLocation) blocks.push({ rule: 'G10', code: 'map_unasked', detail: u });
    } else if (!input.allowedUrls.some((a) => u.startsWith(a) || a.startsWith(u))) {
      blocks.push({ rule: 'G6', code: 'url', detail: u });
    }
  }

  // G10 — the same text to many, links too often.
  if (input.fingerprintPeers > AGENT_LIMITS.fingerprintPeers) {
    blocks.push({ rule: 'G10', code: 'fingerprint', detail: String(input.fingerprintPeers) });
  }
  if (urls.length > 0 && (input.urlsToChat7d >= 1 || input.urlsToday >= AGENT_LIMITS.urlPerDay)) {
    blocks.push({ rule: 'G10', code: 'url_cap' });
  }

  // G11 — a yo'lkira figure is an approximation and says what it leaves out.
  if (input.hasEstimate && ledger.some((e) => e.kind === 'money' && e.source !== null)) {
    const approx = APPROX[input.language].test(text);
    const exclusion = EXCLUSION[input.language].every((re) => re.test(text));
    if (!approx || !exclusion) blocks.push({ rule: 'G11', code: 'estimate_unhedged' });
  }

  return { ok: blocks.length === 0, blocks: dedupe(blocks), warnings: dedupe(warnings), ledger };
}

/**
 * His own ✏️ text — his words are his (§17.6): only what Telegram or the
 * outbox would refuse blocks; another client's code is a WARNING (he may mean
 * it, and he is the one who would know).
 */
export function checkOwnerReply(input: {
  body: string;
  ownCodes: readonly string[];
  bookCodes: ReadonlySet<string>;
  codePrefix: string;
}): PolicyResult {
  const blocks: PolicyHit[] = [];
  const warnings: PolicyHit[] = [];
  const text = normalizeDigits(input.body).trim();
  if (text === '') blocks.push({ rule: 'G4', code: 'empty' });
  if ([...text].length > 4000) blocks.push({ rule: 'G4', code: 'too_long', detail: String([...text].length) });
  for (const code of foreignCodes(text, input)) warnings.push({ rule: 'G6', code: 'other_client_code', detail: code });
  return { ok: blocks.length === 0, blocks, warnings, ledger: [] };
}

function dedupe(hits: PolicyHit[]): PolicyHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = `${h.rule}:${h.code}:${h.detail ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The figures a text holds — exported for the tools that build sources from tool outputs. */
export { extractNumbers };
