import { and, eq, isNull } from 'drizzle-orm';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db } from '../../platform/db/client';
import { kbFacts } from '../../platform/db/schema';
import { AgentConfigError, agentTablesReady } from './config';
import { writeKbFact } from './kb';
import { knownNamesForMask } from './style';
import { factSeenBySql, type WebViewer } from './web-page';

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
 * May this reader correct or retire this fact? Exactly when the page LISTS it
 * to him (`factSeenBySql`, final review K10): a customer's fact belongs to the
 * chat it was learned in, and an id posted from the form is no wider a door
 * than the list. A fact he may not see reads «not found», like one that is not.
 */
export async function assertFactSeen(viewer: WebViewer, factId: string): Promise<void> {
  const [row] = await db
    .select({ id: kbFacts.id })
    .from(kbFacts)
    .where(and(eq(kbFacts.id, factId), factSeenBySql(viewer)));
  if (!row) throw new RetireError('not_found');
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
 * The «nothing personal» refusal is about a NEW datum (review A7): his
 * Toshkent sklad fact carries Umriddin's number, and refusing every edit of
 * it would freeze it. So the old words go to `writeKbFact` as `kept`, and a
 * bit they already carried is not refused again. (The map link and the
 * minimum's «yoki 100 kg» are no personal bits at all — `codesIn`.)
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
    // The ORIGINAL provenance travels with the new words (final review K8): a
    // 👤 fact remembers the draft — and so the chat — it was born in
    // (`draftId`), and the purge finds a chat's facts by exactly that. An
    // edit that dropped it left the corrected copy live, served to that
    // client's chats and listed here, after the chat itself was purged.
    sourceRef: { ...((old.sourceRef ?? {}) as Record<string, unknown>), door: 'web', replaces: old.id },
  };
  let newId: string;
  if (old.scope === 'general') {
    // Only the names the new words can contain: the mask builds one pattern per name.
    const text = `${question ?? ''}\n${answer}`.toLowerCase();
    const names = (await knownNamesForMask(false)).filter((n) => text.includes(n.toLowerCase()));
    newId = await writeKbFact({ ...fact, knownNames: names, kept: { question: old.question, answer: old.answer } }, ctx);
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
    // Lengths, never the words (K8): audit_log takes no DELETE, so a client
    // fact's text written here would outlive the purge of its chat for good.
    // The words themselves stay on the retired row, which the purge reaches.
    await writeAudit(tx, ctx, {
      entityType: 'kb_fact',
      entityId: old.id,
      action: 'update',
      before: { answerChars: [...old.answer].length, questionChars: old.question ? [...old.question].length : 0 },
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
