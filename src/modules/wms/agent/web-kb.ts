import { and, eq, isNull } from 'drizzle-orm';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db } from '../../platform/db/client';
import { kbFacts } from '../../platform/db/schema';
import { AgentConfigError, agentTablesReady } from './config';
import { writeKbFact } from './kb';
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
