import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db } from '../../platform/db/client';
import { kbFacts } from '../../platform/db/schema';
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

function hitOf(row: { id: string; answer: string; question: string | null }): KbHit {
  const text = normalizeDigits(row.answer);
  return {
    id: row.id,
    ref: kbRef(row.id),
    answer: row.question ? `${row.question} — ${row.answer}` : row.answer,
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
 * What would make a text PERSONAL — another customer's code, a phone, a name
 * the caller knows. A general fact is written only from text in which this
 * finds nothing (leak-2); the style guide is proposed through the same mask.
 */
export function personalBits(text: string, knownNames: readonly string[] = []): string[] {
  const t = normalizeDigits(text);
  const out: string[] = [];
  for (const c of codeCandidates([t])) if (/^[A-Z]{1,4}\d{2,}/u.test(c)) out.push(c);
  for (const m of t.matchAll(PHONE_RE)) out.push(m[0]);
  for (const n of knownNames) {
    if ([...n.trim()].length >= 3 && new RegExp(`(?<![\\p{L}])${n.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'iu').test(t)) {
      out.push(n.trim());
    }
  }
  return out;
}

/** The text with every personal bit masked — what the style proposal shows him (leak-1). */
export function maskForModel(text: string, knownNames: readonly string[] = []): string {
  let t = normalizeDigits(text);
  for (const n of knownNames) {
    if ([...n.trim()].length >= 3) {
      t = t.replace(new RegExp(`(?<![\\p{L}])${n.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'giu'), '[ism]');
    }
  }
  t = t.replace(PHONE_RE, '[telefon]');
  for (const u of urlsIn(t)) t = t.split(u).join('[havola]');
  t = t.replace(/\b[A-Za-z]{1,4}\s?-?\s?\d{2,}[A-Za-z0-9-]*\b/gu, '[kod]');
  return t.replace(/\d+(?:[.,]\d+)?/gu, 'N');
}

export type KbRefusal = 'money' | 'personal' | 'empty' | 'too_long' | 'scope';

export class KbError extends Error {
  constructor(
    public readonly code: KbRefusal,
    public readonly detail?: string,
  ) {
    super(code);
  }
}

/**
 * Write a fact HE approved. A general fact must carry nothing personal; no
 * fact may carry money (money-9). The text is exactly what he saw.
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
    knownNames?: readonly string[];
  },
  ctx: AuditContext,
): Promise<string> {
  const answer = input.answer.trim();
  if (!answer) throw new KbError('empty');
  if ([...answer].length > 2000) throw new KbError('too_long');
  if (extractNumbers(answer).some((f) => f.kind === 'money')) throw new KbError('money');
  if (input.scope === 'general') {
    const bits = personalBits(`${input.question ?? ''}\n${answer}`, input.knownNames ?? []);
    if (bits.length > 0) throw new KbError('personal', bits[0]);
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
