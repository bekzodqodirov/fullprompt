import { CUT_MARK, STAFF_TEXT_CAP } from '../../platform/notifications/staff-html';
import type { UnverifiableNumeral } from './digits';
import type { AgentLocale, ScriptName } from './locale';
import type { LedgerEntry, NumberKind } from './numbers';
import type { PolicyCode, PolicyHit, PromiseCategory } from './policy';
import type { AgentInboundJob } from './queues';

/**
 * The card he approves from (spec §17.7, review leak-3).
 *
 * Every staff text is capped at 3 900 characters by keeping the FIRST part,
 * and the first design put the reply, the warnings and the action at the
 * end — so the cut would have taken exactly what he must see before pressing
 * ✅. The order here is the fix: what he decides on comes first and is never
 * cut (the action, every warning, the WHOLE reply and its gloss, each figure
 * beside its source, our last message), and only the customer's own lines
 * at the foot are clipped — oldest first, each line marked «│» so a cut is
 * visible as a cut. If the fixed part alone would not fit, this THROWS: a
 * card that cannot show the whole reply is not a card to approve from.
 *
 * PLAIN text (payload.text is plain everywhere; the drain makes the HTML).
 */

export const POLICY_WORDS: Record<PolicyCode, string> = {
  number_unverifiable: "o'qib bo'lmaydigan raqam bor (boshqa yozuvdagi son)",
  number_unsourced: 'manbasi yo‘q raqam',
  promise: 'va’da',
  too_long: 'juda uzun',
  questions: 'bittadan ko‘p savol',
  empty: 'javob bo‘sh',
  memory_missing: 'qoralamaning tekshiruv ma’lumoti saqlanmagan — AI matnini qayta tekshirib bo‘lmaydi',
  wrong_script: 'mijoz yozgan alifboda emas',
  other_client_code: 'boshqa mijozning kodi',
  system_code: 'tizim kodi (partiya, yashik, prixod, bitim)',
  foreign_phone: 'begona telefon raqami',
  staff_name: 'hodim ismi',
  canary: 'ichki ko‘rsatma matni sizib chiqqan',
  ai_denial: '«men bot emasman» degan gap',
  url: 'ruxsat etilmagan havola',
  mention: '@ belgili murojaat',
  map_unasked: 'xarita havolasi so‘ralmagan',
  fingerprint: 'bir xil matn ko‘p mijozga ketgan',
  url_cap: 'havola juda tez-tez',
  estimate_unhedged: '«taxminan» yoki «boj va QQS alohida» yo‘q',
  warehouse_condition: '«Xitoydagi omborimizdan» sharti yoki «zavoddan omborgacha alohida» yo‘q',
  gloss_missing: 'o‘zbekcha tarjimasi yo‘q — ✏️ bilan o‘zingiz yozing yoki ❌',
  avia_address: 'avia yukka Xitoy omborining manzili yozilgan — avia manzilini siz berasiz (✏️)',
  avia_maybe: 'avia ham gapirilgan va javobda Xitoy omborimizning manzili bor — yuk avia bo‘lsa, manzilni o‘zingiz yozing (✏️)',
};

export const PROMISE_WORDS: Record<PromiseCategory, string> = {
  discount: 'chegirma',
  guarantee: 'kafolat',
  credit_release: 'qarzga berish',
  refund: 'pul qaytarish / kompensatsiya',
  free_extras: 'bepul xizmat',
  dispatch_promise: 'jo‘natish/yetib kelish va’dasi',
  customs_included: 'bojxona narx ichida',
  no_duty: '«boj yo‘q»',
};

const KIND_WORDS: Record<NumberKind, string> = {
  money: 'pul',
  measure: 'o‘lchov',
  duration: 'muddat',
  date: 'sana',
  count: 'soni',
  percent: 'foiz',
  plain: 'son',
};

/**
 * Why a figure could not be read, in words (`unverifiableNumeral`'s union).
 * The base sentence's «(boshqa yozuvdagi son)» is right for one of the three
 * only, so a known reason replaces it rather than following it.
 */
const UNVERIFIABLE_WORDS: Record<UnverifiableNumeral, string> = {
  other_script_digit: 'raqam boshqa yozuvdagi belgi bilan yozilgan',
  han_numeral: 'son xitoycha ieroglif bilan yozilgan',
  word_numeral: 'son so‘z bilan yozilgan',
};

const SCRIPT_WORDS: Record<Exclude<ScriptName, 'none'>, string> = {
  latin: 'lotin',
  cyrillic: 'kirill',
  arabic: 'arab',
  han: 'xitoy',
};

const LANGUAGE_WORDS: Record<AgentLocale, string> = {
  uz: 'o‘zbekcha (lotin)',
  uz_cyrl: 'o‘zbekcha (kirill)',
  ru: 'ruscha',
  en: 'inglizcha',
  fa: 'forscha',
  zh: 'xitoycha',
};

/**
 * `wrong_script`'s «latin→cyrillic» (what the customer writes → what the
 * reply is in) or «uz_cyrl→latin» (the reply's language → its script), as
 * words. A side the tables do not know is printed as it came, and so is a
 * detail that is not a pair — the card never throws over a reason.
 */
function scriptPairWords(detail: string): string {
  const sides = detail.split('→');
  if (sides.length !== 2) return detail;
  const word = (side: string) =>
    (SCRIPT_WORDS as Record<string, string>)[side] ?? (LANGUAGE_WORDS as Record<string, string>)[side] ?? side;
  return `${word(sides[0]!)} → ${word(sides[1]!)}`;
}

/**
 * One block or warning as he reads it: the rule's words and, after them, what
 * was found — a detail that is a CODE (a numeral's kind, a script pair, a
 * promise's category) in words, any other detail (a figure, a client code, a
 * phone) as it stands. Old stored drafts carry the same codes, so they read
 * the same words on their next render.
 */
export function hitWords(hit: PolicyHit): string {
  const base = POLICY_WORDS[hit.code];
  if (hit.code === 'promise' && hit.detail) {
    return `${base}: ${PROMISE_WORDS[hit.detail as PromiseCategory] ?? hit.detail}`;
  }
  if (hit.code === 'number_unverifiable' && hit.detail) {
    const why = (UNVERIFIABLE_WORDS as Record<string, string>)[hit.detail];
    return why ? `o‘qib bo‘lmaydigan raqam bor: ${why}` : `${base}: ${hit.detail}`;
  }
  if (hit.code === 'wrong_script' && hit.detail) return `${base}: ${scriptPairWords(hit.detail)}`;
  if (hit.code === 'too_long' && hit.detail && /^\d+$/u.test(hit.detail)) return `${base}: ${hit.detail} belgi`;
  return hit.detail && hit.code !== 'canary' ? `${base}: ${hit.detail}` : base;
}

/**
 * What a blocked card tells him to do, per surface (the incident of
 * 2026-10-29: a card with no ✅ and no way named, so he answered the customer
 * in Telegram himself and the drafted work was thrown away). TRUE to the
 * flow: the bot's ✏️ arms a wait and his next text there becomes the card's
 * body (bot-door `agentPress` 'e', decide `submitOwnText`); the page's ✏️
 * opens a box on the page; a message he writes to the customer himself
 * retires the draft (jobs `retireOnHumanReply`).
 */
export const BLOCK_REMEDY: Record<'bot' | 'web', string> = {
  bot: '👉 «✏️ O‘zgartirish»ni bosing va to‘g‘ri matnni shu botga yozing — men uni kartaga qo‘yaman, keyin ✅ Yuborish chiqadi. Mijozga Telegramda o‘zingiz yozsangiz, bu qoralama yopiladi.',
  web: '👉 «✏️ O‘zgartirish»ni bosing va to‘g‘ri matnni shu yerda yozing — keyin ✅ Yuborish chiqadi. Mijozga Telegramda o‘zingiz yozsangiz, bu qoralama yopiladi.',
};

export interface CardInput {
  /** «GS777 · Ali Valiyev» or «Lid: Bobur» — who the customer is, first. */
  customerLabel: string;
  /** «🤖 Javob qoralamasi», «💵 Narx javobi» … */
  title: string;
  /** A line about where the draft stands (sent at, held to 08:30, superseded …). */
  statusLine: string | null;
  blocks: readonly PolicyHit[];
  warnings: readonly PolicyHit[];
  /** Words the server adds (identity strength, «tinglovchi yangilanmagan», a refused landing …). */
  notes: readonly string[];
  reply: string;
  /** For fa/zh/en replies — his Q3 ⭐a. */
  gloss: string | null;
  ledger: readonly LedgerEntry[];
  /** Human lines for what ✅ will also do. */
  actions: readonly string[];
  ownerQuestion: string | null;
  lastOut: string | null;
  /** The customer's recent lines, oldest first — the ONLY clippable part. */
  customerLines: readonly string[];
  /**
   * The line under a blocked card's reasons that says what to do. Absent =
   * the bot's (`BLOCK_REMEDY.bot`); null = none — a draft he is already
   * editing says it in its status line.
   */
  remedy?: string | null;
}

export class CardTooLong extends Error {}

export function agentCardText(c: CardInput): string {
  const fixed: string[] = [`${c.title} — ${c.customerLabel}`];
  if (c.statusLine) fixed.push(c.statusLine);
  for (const n of c.notes) fixed.push(`ℹ️ ${n}`);
  if (c.blocks.length > 0) {
    fixed.push('⛔ Bu matn shunday yuborilmaydi (✅ yo‘q). Sabab:');
    for (const b of c.blocks) fixed.push(`• ${hitWords(b)}`);
    const remedy = c.remedy === undefined ? BLOCK_REMEDY.bot : c.remedy;
    if (remedy) fixed.push(remedy);
  }
  for (const w of c.warnings) fixed.push(`⚠️ ${hitWords(w)}`);
  if (c.ownerQuestion) fixed.push(`❓ Sizdan savol: ${c.ownerQuestion}`);
  for (const a of c.actions) fixed.push(`➕ ${a}`);
  fixed.push('', '✉️ Javob:', c.reply.trim() === '' ? '—' : c.reply.trim());
  if (c.gloss && c.gloss.trim() !== '') fixed.push('', `🇺🇿 Tarjima: ${c.gloss.trim()}`);
  if (c.ledger.length > 0) {
    fixed.push('', '🔢 Raqamlar:');
    for (const e of c.ledger) fixed.push(`• ${e.raw} (${KIND_WORDS[e.kind]}) — ${e.source ?? '⛔ manbasi yo‘q'}`);
  }
  if (c.lastOut && c.lastOut.trim() !== '') fixed.push('', `↩️ Oxirgi javobimiz: ${c.lastOut.trim()}`);

  const head = fixed.join('\n');
  if (head.length > STAFF_TEXT_CAP - 200) throw new CardTooLong(String(head.length));

  // The customer's lines, newest kept: walk back from the newest until the cap.
  const room = STAFF_TEXT_CAP - head.length - 40;
  const lines = c.customerLines.map((l) => `│ ${l.replace(/\s*\n\s*/gu, ' ').trim()}`);
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (used + line.length + 1 > room) {
      const left = room - used - CUT_MARK.length - 4;
      if (left > 40) kept.unshift(`${line.slice(0, left)}…`);
      kept.unshift(`│ ${CUT_MARK}`);
      break;
    }
    kept.unshift(line);
    used += line.length + 1;
  }
  return kept.length > 0 ? `${head}\n\n💬 Mijoz:\n${kept.join('\n')}` : head;
}

/**
 * The words ✅ sends — the TRIMMED body, his own when he wrote one. The one
 * home for «the body the digest is over»: the card's button, the web page and
 * `decideDraft` all digest this, so a body stored with a trailing newline can
 * no longer draw a button whose digest the decision never matches (A12 — it
 * answered `stale_card` for ever).
 */
export function digestBody(d: { finalBody: string | null; proposedBody: string | null }): string {
  return (d.finalBody ?? d.proposedBody ?? '').trim();
}

/**
 * JSON with every object's keys sorted — so the actions digest the same
 * whether they come from the writer's object or back out of `jsonb`, which
 * stores keys in ITS order (shortest first), not the insertion order. Without
 * it the card written by `createDraft` carried a digest over
 * `{type, section, facts, …}` and `decideDraft` recomputed it over the stored
 * `{type, facts, section, …}`: every draft with an action answered
 * `stale_card` to its own first ✅.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * A short, stable digest of what ✅ approves — the button carries it, a
 * changed card refuses the old press (leak-3). Over the trimmed body whatever
 * the caller passed (whitespace at the ends is not part of what is sent), and
 * over the actions' canonical JSON (key order is not part of what they say).
 */
export function cardDigest(body: string, actions: readonly unknown[]): string {
  const s = `${body.trim()}\u0000${canonicalJson(actions)}`;
  // FNV-1a, 32 bits, as eight hex characters — the callback grammar's `[0-9a-f]{8}`.
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Does the card draw ✅ — ONE rule for the bot's keyboard (`cardExtra`'s
 * `blocked` is its negation), the page (web-page `pageDrawsSend`) and what
 * `decideDraft` accepts: nothing holds it (the policy, or a card too long to
 * show — `blocked` here carries both), and it is live — `editing` only while
 * he has written nothing for it, because ✅ then sends the machine's words
 * (C7); a second ✏️ over his own words waits for the new ones, and a button
 * there was a press answered «Avval o'z matningizni yozing» under a status
 * line promising the ✅ would come (review).
 */
export function cardDrawsSend(d: { blocked: boolean; status: string; ownText: boolean }): boolean {
  return !d.blocked && (d.status === 'pending' || (d.status === 'editing' && !d.ownText));
}

/**
 * The payload a card's notification row carries — the bot draws buttons from
 * it. `blocked` is «no ✅»: every writer passes `!cardDrawsSend(…)`.
 */
export function cardExtra(draft: { id: string; body: string; actions: unknown[]; blocked: boolean; live: boolean; kind: string }) {
  return {
    draftId: draft.id,
    digest: cardDigest(draft.body, draft.actions),
    blocked: draft.blocked,
    live: draft.live,
    kind: draft.kind,
  };
}


/** A card written later than this after the customer's message says how long he has waited. */
export const LATE_CARD_MS = 3 * 60_000;

/**
 * Why a run started late, when its job says (queues `AgentInboundJob.origin`):
 * a pull follows his answer to a stranger — the customer's lines were not
 * kept until then (bot-door `queuePull`), and that answer is given at TWO
 * doors: the bot's stranger card («🆕 Yangi lid», a confirmed «👤 Mijoz —
 * kod») and the web tray on /suhbatlar/qaysi («Yangi lid», «Bu mijoz» —
 * chat-rules `pullForAgent`), so the words name what both did, never one
 * door's buttons; the sweep's gap pass re-asks a message no run took; an
 * edit re-asks the anchor; his ✅/❌ on a card the chat had moved past asks
 * the newest line again (decide `redraftNewest`) — his press, never «the AI
 * looked again». A live or typing-wait run that is late has no cause the job
 * can name, and none is invented.
 */
const LATE_CAUSE: Partial<Record<AgentInboundJob['origin'], string>> = {
  pull: '(chat lid yoki mijoz deb belgilangandan keyin yozildi)',
  sweep: '(AI qayta tekshirganda yozildi)',
  edit: '(mijoz xabarini tahrirlagandan keyin)',
  redraft: '(✅/❌ bosilganda chat o‘zgargani uchun qayta yozildi)',
};

/**
 * The note on a LATE card (2026-10-29: a card 23 minutes after the
 * customer's lines looked like a fresh one, and nothing said why). Late is
 * judged from the ANCHOR — the message the draft answers — at the moment the
 * draft is written; the wait is counted from the customer's FIRST unanswered
 * line, which is when he started waiting. Null when the card is not late.
 */
export function lateNote(input: {
  anchorSentAt: Date;
  waitingSince: Date | null;
  writtenAt: Date;
  origin: AgentInboundJob['origin'] | null;
}): string | null {
  if (input.writtenAt.getTime() - input.anchorSentAt.getTime() <= LATE_CARD_MS) return null;
  const since = input.waitingSince && input.waitingSince < input.anchorSentAt ? input.waitingSince : input.anchorSentAt;
  const minutes = Math.floor((input.writtenAt.getTime() - since.getTime()) / 60_000);
  const wait = minutes < 120 ? `${minutes} daqiqadan` : `${Math.floor(minutes / 60)} soatdan`;
  const cause = input.origin ? LATE_CAUSE[input.origin] : undefined;
  return `⏱ Mijoz ${wait} beri javob kutyapti${cause ? ` ${cause}` : ''}`;
}
