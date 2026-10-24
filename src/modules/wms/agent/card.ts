import { CUT_MARK, STAFF_TEXT_CAP } from '../../platform/notifications/staff-html';
import type { LedgerEntry, NumberKind } from './numbers';
import type { PolicyCode, PolicyHit, PromiseCategory } from './policy';

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

export function hitWords(hit: PolicyHit): string {
  const base = POLICY_WORDS[hit.code];
  if (hit.code === 'promise' && hit.detail) {
    return `${base}: ${PROMISE_WORDS[hit.detail as PromiseCategory] ?? hit.detail}`;
  }
  return hit.detail && hit.code !== 'canary' ? `${base}: ${hit.detail}` : base;
}

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
}

export class CardTooLong extends Error {}

export function agentCardText(c: CardInput): string {
  const fixed: string[] = [`${c.title} — ${c.customerLabel}`];
  if (c.statusLine) fixed.push(c.statusLine);
  for (const n of c.notes) fixed.push(`ℹ️ ${n}`);
  if (c.blocks.length > 0) {
    fixed.push('⛔ ✅ yo‘q — tuzatish kerak:');
    for (const b of c.blocks) fixed.push(`• ${hitWords(b)}`);
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

/** The payload a card's notification row carries — the bot draws buttons from it. */
export function cardExtra(draft: { id: string; body: string; actions: unknown[]; blocked: boolean; live: boolean; kind: string }) {
  return {
    draftId: draft.id,
    digest: cardDigest(draft.body, draft.actions),
    blocked: draft.blocked,
    live: draft.live,
    kind: draft.kind,
  };
}

