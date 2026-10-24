import { and, eq, isNull } from 'drizzle-orm';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db } from '../../platform/db/client';
import { kbFacts } from '../../platform/db/schema';
import { AgentConfigError, agentTablesReady } from './config';
import { KbError, personalBits, writeKbFact } from './kb';
import { extractNumbers } from './numbers';
import { knownNamesForMask } from './style';

/**
 * «Bilimlar» on `/suhbatlar/ai` (spec §17.12): the company's facts, added and
 * retired by the people who run the agent. The page's own door
 * (`mayRunAgent`) is asked by the ACTION; these are the writes behind it.
 */

/**
 * A GENERAL fact typed on the page. It goes through `writeKbFact` — the one
 * writer, so the money refusal and the «nothing personal» check (leak-2,
 * money-9) are the bot's exactly — with every name the client book and the
 * staff list hold as `knownNames`, because a fact typed here belongs to no
 * chat and could name anybody.
 */
export async function addGeneralFact(
  input: { question: string | null; answer: string },
  ctx: AuditContext,
): Promise<string> {
  if (!(await agentTablesReady())) throw new AgentConfigError('not_ready');
  const text = `${input.question ?? ''}\n${input.answer}`.toLowerCase();
  // Only the names the text can contain: the mask builds one pattern per name.
  const names = (await knownNamesForMask(false)).filter((n) => text.includes(n.toLowerCase()));
  return writeKbFact(
    {
      scope: 'general',
      question: input.question,
      answer: input.answer,
      locale: 'uz',
      sourceRef: { door: 'web' },
      knownNames: names,
    },
    ctx,
  );
}

export type RetireRefusal = 'not_found' | 'already_retired';

export class RetireError extends Error {
  constructor(public readonly code: RetireRefusal) {
    super(code);
  }
}

/**
 * Correct a fact's words on the page (§17.14: «bilimlar turadigan page …
 * qo'shiladi, o'zgartiriladi, olib tashlanadi»). Never an UPDATE of the row:
 * what the agent said yesterday was said with yesterday's words, so the old
 * row is RETIRED and a new approved one is written in its place — through
 * `writeKbFact`, the one writer, so the money and «nothing personal»
 * refusals are the add form's exactly, and they refuse BEFORE anything moves.
 * The new row names the one it replaces; both writes are audited.
 *
 * `writeKbFact` runs on the pool, so it cannot sit inside the retiring
 * transaction (#714). The order is therefore write-then-retire, and an edit
 * that loses a race to another retire takes its own new row back and says so
 * — a fact is never live twice.
 *
 * The «nothing personal» refusal is about a NEW datum (review A7). A fact
 * already approved may carry the company's own phone, map link or a word the
 * mask reads as a code — his Toshkent sklad fact carries Umriddin's number,
 * the map fact a Yandex link, the minimum «yoki 100 kg» (read as «YOKI100») —
 * and refusing every edit of those would freeze them. So an edit is refused
 * only for a personal bit the OLD text did not already carry; one whose bits
 * are all inherited is written by `writeKeptFact`, which is `writeKbFact`
 * with that one check narrowed and every other refusal the same.
 */
export async function editKbFact(
  factId: string,
  input: { question: string | null; answer: string },
  ctx: AuditContext,
): Promise<string> {
  if (!(await agentTablesReady())) throw new AgentConfigError('not_ready');
  const [old] = await db.select().from(kbFacts).where(eq(kbFacts.id, factId));
  if (!old) throw new RetireError('not_found');
  if (old.retiredAt) throw new RetireError('already_retired');
  const question = input.question?.trim() || null;
  const answer = input.answer.trim();
  if (question === (old.question ?? null) && answer === old.answer) return old.id;
  const fact = {
    scope: old.scope as 'general' | 'client' | 'lead',
    clientId: old.clientId,
    leadId: old.leadId,
    question,
    answer,
    locale: old.locale ?? 'uz',
    sourceRef: { door: 'web', replaces: old.id },
  };
  let newId: string;
  if (old.scope === 'general') {
    const all = await knownNamesForMask(false);
    const namesIn = (t: string) => all.filter((n) => t.toLowerCase().includes(n.toLowerCase()));
    const newText = `${question ?? ''}\n${answer}`;
    const oldText = `${old.question ?? ''}\n${old.answer}`;
    const kept = new Set(personalBits(oldText, namesIn(oldText)).map(bitKey));
    const names = namesIn(newText);
    const bits = personalBits(newText, names);
    const fresh = bits.find((b) => !kept.has(bitKey(b)));
    if (fresh !== undefined) throw new KbError('personal', fresh);
    // Nothing personal at all: the one writer, as the add form.
    newId = bits.length === 0 ? await writeKbFact({ ...fact, knownNames: names }, ctx) : await writeKeptFact(fact, ctx);
  } else {
    newId = await writeKbFact({ ...fact, knownNames: [] }, ctx);
  }
  const retired = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(kbFacts)
      .set({ retiredAt: new Date() })
      .where(and(eq(kbFacts.id, old.id), isNull(kbFacts.retiredAt)))
      .returning({ id: kbFacts.id });
    if (!row) return false;
    await writeAudit(tx, ctx, {
      entityType: 'kb_fact',
      entityId: old.id,
      action: 'update',
      before: { answer: old.answer, question: old.question },
      after: { retired: true, replacedBy: newId },
    });
    return true;
  });
  if (!retired) {
    await retireKbFact(newId, ctx);
    throw new RetireError('already_retired');
  }
  return newId;
}

/** One personal bit as compared across an edit: a phone by its digits (spacing is not a new number), the rest by letters. */
function bitKey(bit: string): string {
  const digits = bit.replace(/\D/gu, '');
  return digits.length >= 7 ? digits : bit.toLowerCase();
}

/**
 * A general fact's corrected words whose personal bits were all approved
 * before (`editKbFact`). `writeKbFact`'s insert and audit exactly, and its
 * refusals in its order — empty, too long, a money figure — minus the
 * personal one, which the caller has narrowed to «nothing new».
 */
async function writeKeptFact(
  input: { question: string | null; answer: string; locale: string; sourceRef: Record<string, unknown> },
  ctx: AuditContext,
): Promise<string> {
  const answer = input.answer.trim();
  if (!answer) throw new KbError('empty');
  if ([...answer].length > 2000) throw new KbError('too_long');
  if (extractNumbers(answer).some((f) => f.kind === 'money')) throw new KbError('money');
  const [row] = await db
    .insert(kbFacts)
    .values({
      scope: 'general',
      question: input.question?.trim() || null,
      answer,
      locale: input.locale,
      source: 'owner',
      sourceRef: input.sourceRef,
      approvedAt: new Date(),
      approvedBy: ctx.actorId,
    })
    .returning({ id: kbFacts.id });
  await writeAudit(db, ctx, { entityType: 'kb_fact', entityId: row!.id, action: 'create', after: { scope: 'general' } });
  return row!.id;
}

/**
 * Retire a fact: it stops being read by every run from this moment (kb.ts's
 * `live` predicate), and stays in the table — what the agent once said is a
 * fact about the past, and the audit row names who took it back.
 */
export async function retireKbFact(factId: string, ctx: AuditContext): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(kbFacts)
      .set({ retiredAt: new Date() })
      .where(and(eq(kbFacts.id, factId), isNull(kbFacts.retiredAt)))
      .returning({ id: kbFacts.id, scope: kbFacts.scope });
    if (!row) {
      const [exists] = await tx.select({ id: kbFacts.id }).from(kbFacts).where(eq(kbFacts.id, factId));
      throw new RetireError(exists ? 'already_retired' : 'not_found');
    }
    await writeAudit(tx, ctx, {
      entityType: 'kb_fact',
      entityId: factId,
      action: 'void',
      after: { scope: row.scope, retired: true },
    });
  });
}
