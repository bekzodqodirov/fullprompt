import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db } from '../../platform/db/client';
import { clients, kbFacts } from '../../platform/db/schema';
import { normalizeDigits } from './digits';
import { extractNumbers, PHONE_RE, urlsIn } from './numbers';
import { codeCandidates } from '../calc/channel-post';

/**
 * What the agent may say as FACT (spec §7.1, review leak-2, money-9).
 *
 * A general fact is the company's and is read in every chat; a client or lead
 * fact is that customer's alone (`scope`, three CHECKs in 0136 — a lead's fact
 * must never read as a general one). A fact is never a price: a money figure
 * in the kb is refused at the WRITE («Narx bilimga yozilmaydi — ✏️ Narx yozaman
 * orqali»), and the policy never counts a kb number as money anyway.
 */

export interface KbHit {
  id: string;
  /** «F1a2b3c4d» — what the model cites in used_fact_ids. */
  ref: string;
  answer: string;
  phones: string[];
  urls: string[];
}

export interface KbScope {
  /** The chat's client and its phone siblings. */
  clientIds: readonly string[];
  leadId: string | null;
}

// The id's random TAIL: a v7 id's head is its clock, shared by facts approved the same minute.
export const kbRef = (id: string) => `F${id.replace(/-/gu, '').slice(-8)}`;

/**
 * A fact as every run READS it — its question and its answer, one line. The
 * money refusal asks this same text (final review K6): the question is served
 * into the prompt beside the answer and each of its figures is a G1 source,
 * so a price that sits in the QUESTION is a price in the knowledge.
 */
export function servedText(question: string | null, answer: string): string {
  return question ? `${question} — ${answer}` : answer;
}

/** Does a text state money (P1 — a bare figure in a text that names money anywhere is money too)? */
export function carriesMoney(text: string): boolean {
  return extractNumbers(text).some((f) => f.kind === 'money');
}

/**
 * The first figure a fact reads as money, and why (ident fix F7): `own` — its
 * answer, or its question, states it on its own; `context` — neither does,
 * but SERVED together (K6) the price word of one makes the other's bare
 * figure a price: «Narx qayerdan hisoblanadi? — … Futian ko‘chasi 88». The
 * write refuses both, because the joined text is what every prompt reads —
 * but it says which, and names the figure, instead of telling him «a price
 * is not knowledge» about a text with no price in it.
 */
export function moneyIn(question: string | null, answer: string): { raw: string; why: 'own' | 'context' } | null {
  const first = (text: string) => extractNumbers(text).find((f) => f.kind === 'money')?.raw ?? null;
  const own = first(answer) ?? (question ? first(question) : null);
  if (own) return { raw: own, why: 'own' };
  const joined = first(servedText(question, answer));
  return joined ? { raw: joined, why: 'context' } : null;
}

function hitOf(row: { id: string; answer: string; question: string | null }): KbHit {
  const text = normalizeDigits(row.answer);
  return {
    id: row.id,
    ref: kbRef(row.id),
    answer: servedText(row.question, row.answer),
    phones: [...text.matchAll(PHONE_RE)].map((m) => m[0]),
    urls: urlsIn(text),
  };
}

const live = and(isNull(kbFacts.retiredAt), or(isNotNull(kbFacts.approvedAt), inArray(kbFacts.source, ['seed', 'site'])));

/** Every approved GENERAL fact — the stable head of the prompt (cached). Capped, oldest first: the order must not move. */
export async function generalFacts(limit = 60): Promise<KbHit[]> {
  const rows = await db
    .select({ id: kbFacts.id, answer: kbFacts.answer, question: kbFacts.question })
    .from(kbFacts)
    .where(and(live, eq(kbFacts.scope, 'general')))
    .orderBy(asc(kbFacts.createdAt), asc(kbFacts.id))
    .limit(limit);
  return rows.map(hitOf);
}

/**
 * The facts for THIS chat that match the query: general ones and the chat's
 * own (its client and siblings, or its lead) — never another customer's.
 * The table is the company's own short list (dozens of rows), so the
 * similarity is computed over all of it; the trigram index is there for the
 * day it is not.
 */
export async function kbSearch(scope: KbScope, query: string, limit = 8): Promise<KbHit[]> {
  const q = normalizeDigits(query).trim().slice(0, 200);
  const owner = or(
    eq(kbFacts.scope, 'general'),
    scope.clientIds.length > 0 ? and(eq(kbFacts.scope, 'client'), inArray(kbFacts.clientId, [...scope.clientIds])) : sql`false`,
    scope.leadId ? and(eq(kbFacts.scope, 'lead'), eq(kbFacts.leadId, scope.leadId)) : sql`false`,
  );
  const doc = sql`(coalesce(${kbFacts.question}, '') || ' ' || ${kbFacts.answer})`;
  const rows = await db
    .select({ id: kbFacts.id, answer: kbFacts.answer, question: kbFacts.question })
    .from(kbFacts)
    .where(and(live, owner, q ? sql`word_similarity(${q}, ${doc}) > 0.2` : sql`true`))
    .orderBy(q ? desc(sql`word_similarity(${q}, ${doc})`) : desc(kbFacts.createdAt))
    .limit(limit);
  if (rows.length > 0) {
    await db
      .update(kbFacts)
      .set({ usesCount: sql`${kbFacts.usesCount} + 1`, lastUsedAt: new Date() })
      .where(inArray(kbFacts.id, rows.map((r) => r.id)));
  }
  return rows.map(hitOf);
}

/**
 * The names a text must not carry, as the needles that find them: each whole
 * name AND each of its words of three or more characters that has a letter
 * (review I3). A customer is greeted by a PART of the stored name — «Laylo
 * opa» for «Laylo Karimova» — so the whole name alone let the first name
 * through. A bare number is no name (the code and phone checks own numbers).
 * Longest first, so a mask replaces «Laylo Karimova» before «Laylo».
 */
export function nameNeedles(knownNames: readonly (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const raw of knownNames) {
    const name = (raw ?? '').trim();
    if ([...name].length >= 3) out.add(name);
    // The Uzbek apostrophes stay inside a word: «O'ktam» is one name, never «ktam».
    for (const piece of name.split(/[^\p{L}\p{N}'ʻʼ‘’]+/u)) {
      const word = piece.replace(/^['ʻʼ‘’]+|['ʻʼ‘’]+$/gu, '');
      if ([...word].length >= 3 && /\p{L}/u.test(word)) out.add(word);
    }
  }
  return [...out].sort((a, b) => [...b].length - [...a].length);
}

/**
 * Uzbek Cyrillic and Russian in Latin, letter by letter — the one way a name
 * stored in Latin is still found written in Cyrillic («Шахзод ака» for
 * «Shahzod»). ъ/ь write nothing.
 */
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', ғ: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', қ: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', ў: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ҳ: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * One spelling for a name and for the text it hides in (review I3): lower
 * case, Cyrillic in Latin, the apostrophes of o‘/g‘ and the tutuq belgisi
 * dropped in every shape they are typed in (', ʻ, ʼ, ‘, ’, `), and the letter
 * pairs one name is written both ways with folded together — x/h
 * («Shahzod»/«Шахзод»), q/k, and «ye» as «e» (the Cyrillic е after a vowel
 * is the Latin «ye»: «Xo'jayev»/«Хўжаев», «Aliyev»/«Алиев»). Each folded
 * character remembers the span of the input it came from, so a mask covers
 * the text as he wrote it.
 */
function fold(text: string): { out: string[]; from: number[]; to: number[] } {
  const out: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const ch of text) {
    const lower = ch.toLowerCase();
    const latin = /['ʻʼ‘’`]/u.test(ch) ? '' : (CYRILLIC[lower] ?? (lower === 'x' ? 'h' : lower === 'q' ? 'k' : lower));
    // By code UNIT, so an index into the joined string is an index into these arrays.
    for (const c of latin.split('')) {
      if (c === 'e' && out[out.length - 1] === 'y') {
        // «ye» → «e», spanning both inputs.
        out[out.length - 1] = 'e';
        to[to.length - 1] = i + ch.length;
        continue;
      }
      out.push(c);
      from.push(i);
      to.push(i + ch.length);
    }
    i += ch.length;
  }
  return { out, from, to };
}

/** The folded text as one string — one array element per code unit, so a match index maps back through `from`/`to`. */
const foldedText = (text: string) => fold(text).out.join('');

/**
 * Where one folded needle sits in the folded text, as a pattern. A name is
 * the START of a word: Uzbek greets by suffixing it — «Shahzodjon»,
 * «Layloxon», «Shahzodga», and Russian declines it — so a needle of four
 * letters or more takes any letters after it (refusing too much is the safe
 * direction: he picks «👤 Faqat shu mijoz» instead). A three-letter needle
 * («Ali») would also start «Alibaba», so it takes only the endings a name
 * takes.
 */
const SHORT_NAME_ENDINGS = '(?:jon|hon|bek|boy|oy|ga|ni|ning|dan|da|lar)?';

function nameRe(folded: string, flags: string): RegExp {
  const esc = folded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tail = [...folded].length >= 4 ? '\\p{L}*' : `${SHORT_NAME_ENDINGS}(?![\\p{L}])`;
  return new RegExp(`(?<![\\p{L}])${esc}${tail}`, flags);
}

/** Every needle, folded, beside the name it was cut from — a needle that folds to under three letters is dropped. */
function foldedNeedles(knownNames: readonly (string | null | undefined)[]): { name: string; folded: string }[] {
  return nameNeedles(knownNames)
    .map((name) => ({ name, folded: foldedText(name) }))
    .filter((n) => [...n.folded.replace(/[^\p{L}]/gu, '')].length >= 3);
}

/** The spans of the ORIGINAL text that carry a known name, merged, left to right. */
function nameSpans(text: string, knownNames: readonly (string | null | undefined)[]): [number, number][] {
  const needles = foldedNeedles(knownNames);
  if (needles.length === 0) return [];
  const f = fold(text);
  const folded = f.out.join('');
  const spans: [number, number][] = [];
  for (const n of needles) {
    for (const m of folded.matchAll(nameRe(n.folded, 'gu'))) {
      const at = m.index ?? 0;
      if (m[0].length === 0) continue;
      spans.push([f.from[at]!, f.to[at + m[0].length - 1]!]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  return merged;
}

/**
 * The client codes a text carries. A code is ONE token as it is written on a
 * carton — «GS555», «gs-555» — never a word and a number a space apart:
 * `codeCandidates` joins the runs either side of one separator (the price
 * channel's scrub wants «GS 555» too, and over-scrubbing a post is safe), and
 * read that way the company's own minimum, «1 kub yoki 100 kg», carried a
 * code YOKI100 (answers review). Nor is a piece of a link one: the Yandex
 * map's path «/-/CXQr78ni» is no customer, so every link `urlsIn` finds is
 * cut out first. A pair a space apart that the client book DOES hold — «GS
 * 555» — is the writer's question (`spacedBookCodes`): only the book can tell
 * a customer from two words.
 */
function codesIn(text: string): string[] {
  return codeCandidates(withoutLinks(text).split(/\s+/u).filter((token) => token !== '')).filter(isCodeShaped);
}

const isCodeShaped = (c: string) => /^[A-Z]{1,4}\d{2,}/u.test(c);

function withoutLinks(text: string): string {
  let t = text;
  for (const u of urlsIn(t)) t = t.split(u).join(' ');
  return t;
}

/**
 * A code written with a space, «GS 555», that IS a customer's: the client
 * book holds it. `codesIn` never joins across a space (the company's «1 kub
 * yoki 100 kg» is no YOKI100), so the joined spelling is asked of the book
 * instead — the price channel's rule (`identitiesIn`: candidates →
 * `clients_code_unique`) — and a pair the book does not hold is two words.
 * Read on the pool: the writer below opens no transaction (#714).
 */
async function spacedBookCodes(text: string): Promise<string[]> {
  const t = withoutLinks(text);
  const tokens = new Set(codesIn(t));
  const joined = codeCandidates([t]).filter((c) => isCodeShaped(c) && !tokens.has(c));
  if (joined.length === 0) return [];
  const rows = await db.select({ code: clients.clientCode }).from(clients).where(inArray(clients.clientCode, joined));
  return rows.map((r) => r.code);
}

/**
 * What would make a text PERSONAL — another customer's code, a phone, a name
 * the caller knows (whole, or any word of it, in either script, with its
 * suffixes). A general fact is written only from text in which this finds
 * nothing (leak-2); the style guide is proposed through the same mask.
 */
export function personalBits(text: string, knownNames: readonly (string | null | undefined)[] = []): string[] {
  const t = normalizeDigits(text);
  const out: string[] = [];
  out.push(...codesIn(t));
  for (const m of t.matchAll(PHONE_RE)) out.push(m[0]);
  const folded = foldedText(t);
  for (const n of foldedNeedles(knownNames)) if (nameRe(n.folded, 'u').test(folded)) out.push(n.name);
  return out;
}

/**
 * `personalBits`, and a spaced code the client book holds (`spacedBookCodes`)
 * — what a WRITE of a general fact refuses. The pure one stays for a caller
 * with no book to ask: the style script checks a guide the model wrote from
 * `maskForModel`'s text, where every «GS 555» was already «[kod]».
 */
export async function personalBitsWithBook(text: string, knownNames: readonly (string | null | undefined)[] = []): Promise<string[]> {
  return [...personalBits(text, knownNames), ...(await spacedBookCodes(normalizeDigits(text)))];
}

/** The text with every personal bit masked — what the style proposal shows him (leak-1). */
export function maskForModel(text: string, knownNames: readonly (string | null | undefined)[] = []): string {
  let t = normalizeDigits(text);
  // Right to left, so a span replaced never moves the ones still to come.
  for (const [start, end] of nameSpans(t, knownNames).reverse()) t = `${t.slice(0, start)}[ism]${t.slice(end)}`;
  t = t.replace(PHONE_RE, '[telefon]');
  for (const u of urlsIn(t)) t = t.split(u).join('[havola]');
  t = t.replace(/\b[A-Za-z]{1,4}\s?-?\s?\d{2,}[A-Za-z0-9-]*\b/gu, '[kod]');
  return t.replace(/\d+(?:[.,]\d+)?/gu, 'N');
}

/**
 * `money` — the fact states a price; `money_context` — it reads as one only
 * because the question's price word sits beside the answer's bare figure
 * (`moneyIn`). Both carry the figure as `detail`.
 */
export type KbRefusal = 'money' | 'money_context' | 'personal' | 'empty' | 'too_long' | 'scope';

export class KbError extends Error {
  constructor(
    public readonly code: KbRefusal,
    public readonly detail?: string,
  ) {
    super(code);
  }
}

/** One personal bit as compared across an edit: a phone by its digits (spacing is not a new number), the rest by letters. */
function bitKey(bit: string): string {
  const digits = bit.replace(/\D/gu, '');
  return digits.length >= 7 ? digits : bit.toLowerCase();
}

/**
 * Write a fact HE approved. A general fact must carry nothing personal; no
 * fact may carry money (money-9). The text is exactly what he saw.
 *
 * `kept` is the approved fact these words correct (the page's ✎, review A7):
 * the «nothing personal» refusal is about a NEW datum, and a fact already
 * approved may carry the company's own phone or a contact's name — his
 * Toshkent sklad fact names Umriddin and his number — so a bit the kept
 * words already carried is not refused again. Every other refusal is the
 * same; this is the one writer, edit or not.
 */
export async function writeKbFact(
  input: {
    scope: 'general' | 'client' | 'lead';
    clientId?: string | null;
    leadId?: string | null;
    question: string | null;
    answer: string;
    locale?: string | null;
    sourceRef?: Record<string, unknown> | null;
    knownNames?: readonly (string | null | undefined)[];
    kept?: { question: string | null; answer: string } | null;
  },
  ctx: AuditContext,
): Promise<string> {
  const answer = input.answer.trim();
  if (!answer) throw new KbError('empty');
  if ([...answer].length > 2000) throw new KbError('too_long');
  // The text as it is SERVED, question included (K6): a figure in the question
  // reaches every prompt this fact reaches, exactly like one in the answer —
  // refused naming the figure, and saying when only the joining made it one.
  const money = moneyIn(input.question?.trim() || null, answer);
  if (money) throw new KbError(money.why === 'own' ? 'money' : 'money_context', money.raw);
  if (input.scope === 'general') {
    const names = input.knownNames ?? [];
    const bits = await personalBitsWithBook(`${input.question ?? ''}\n${answer}`, names);
    const approved = input.kept
      ? new Set((await personalBitsWithBook(`${input.kept.question ?? ''}\n${input.kept.answer}`, names)).map(bitKey))
      : null;
    const fresh = approved ? bits.filter((b) => !approved.has(bitKey(b))) : bits;
    if (fresh.length > 0) throw new KbError('personal', fresh[0]);
  }
  if ((input.scope === 'client') !== Boolean(input.clientId) || (input.scope === 'lead') !== Boolean(input.leadId)) {
    throw new KbError('scope');
  }
  const [row] = await db
    .insert(kbFacts)
    .values({
      scope: input.scope,
      clientId: input.scope === 'client' ? input.clientId! : null,
      leadId: input.scope === 'lead' ? input.leadId! : null,
      question: input.question?.trim() || null,
      answer,
      locale: input.locale ?? null,
      source: 'owner',
      sourceRef: input.sourceRef ?? null,
      approvedAt: new Date(),
      approvedBy: ctx.actorId,
    })
    .returning({ id: kbFacts.id });
  await writeAudit(db, ctx, { entityType: 'kb_fact', entityId: row!.id, action: 'create', after: { scope: input.scope } });
  return row!.id;
}
