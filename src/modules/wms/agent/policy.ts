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
 * G2: what may never be promised from his account by a machine, in every
 * language a reply can be written in (money-8). A CLOSED table: a category is
 * a business decision someone else's door makes (a discount is the VED's, a
 * release on credit is `counterDebtRelease`'s, a refund is the accountant's),
 * and his Q8 ⭐ — none of the website's extras exists in the system, so none
 * is stated. Run over EVERY language at once: a Russian promise inside an
 * Uzbek reply is still a promise.
 */
export const PROMISE_TABLE: Record<PromiseCategory, readonly RegExp[]> = {
  discount: [
    /chegirma|skidka|arzonroq|arzonlashtir|arzon\s+qilib/iu,
    /чегирма|арзонроқ|арзонлаштир/iu,
    /скидк|дешевле|уступ(лю|им|ка)/iu,
    /\bdiscount|\bcheaper\b|lower\s+(the\s+)?price|reduce\s+(the\s+)?price/iu,
    /تخفیف|ارزان‌تر|ارزانتر/u,
    /折扣|优惠|打折|便宜点|减价|让利/u,
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
    /қарзга|насия/iu,
    /в\s+долг|в\s+кредит|рассрочк|оплатите\s+(потом|позже)|потом\s+заплатите/iu,
    /on\s+credit|pay\s+later|deferred\s+payment/iu,
    /نسیه|قرضی|بعدا\s+پرداخت/u,
    /赊账|赊欠|先发货后付款|后付款/u,
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
    /(ertaga|bugun|indinga)\s+(jo['‘’ʻ]?nat|yubor|ketadi|chiqadi|yetib)|(jo['‘’ʻ]?nat|yubor)\p{L}*\s+(ertaga|bugun|indinga)|va['‘’ʻ]?da\s+(beraman|beramiz)|kafolatlay/iu,
    /(эртага|бугун)\s+(жўнат|юбор|кетади|чиқади)|ваъда\s+бер/iu,
    /(завтра|сегодня)\s+(отправ|выед|уед|будет\s+у\s+вас)|(отправ|выед|уед)\p{L}*\s+(завтра|сегодня)|обеща/iu,
    /(ship|send|dispatch)\p{L}*\s+(it\s+)?(today|tomorrow)|\bi\s+promise|\bwe\s+promise|will\s+arrive\s+(by|on)\b/iu,
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

function wholeWord(text: string, phrase: string): boolean {
  const p = phrase.trim();
  if ([...p].length < 3) return false;
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/gu, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/** Codes in a text that are not this chat's: a book code, or the prefix followed by digits. */
export function foreignCodes(
  text: string,
  ctx: { ownCodes: readonly string[]; bookCodes: ReadonlySet<string>; codePrefix: string },
): string[] {
  const own = new Set(ctx.ownCodes.map((c) => c.toUpperCase()));
  const prefix = ctx.codePrefix.trim().toUpperCase();
  const out = new Set<string>();
  for (const c of codeCandidates([text])) {
    if (own.has(c)) continue;
    const prefixed = prefix !== '' && c.startsWith(prefix) && /^\d+$/u.test(c.slice(prefix.length));
    if (ctx.bookCodes.has(c) || prefixed) out.add(c);
  }
  return [...out];
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
  return PROMISE_CATEGORIES.filter((c) => PROMISE_TABLE[c].some((re) => re.test(t)));
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
  for (const re of SYSTEM_SHAPE_RES) {
    const m = re.exec(text);
    if (m) blocks.push({ rule: 'G6', code: 'system_code', detail: m[0] });
  }
  for (const p of foreignPhones(text, input.allowedPhones)) blocks.push({ rule: 'G6', code: 'foreign_phone', detail: p });
  for (const name of input.staffNames) {
    if (wholeWord(text, name)) blocks.push({ rule: 'G6', code: 'staff_name', detail: name });
  }
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

  return { ok: blocks.length === 0, blocks: dedupe(blocks), warnings, ledger };
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
