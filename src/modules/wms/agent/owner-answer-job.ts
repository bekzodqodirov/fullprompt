import { eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { agentDrafts } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { HAND_BACK_RETRY_S, NO_DRAFT_WORDS } from './calc-loop';
import { releaseAnswering } from './decide';
import { ownerAnswerInstruction } from './owner-answer';
import { JOB_AGENT_OWNER_ANSWER, type AgentOwnerAnswerJob } from './queues';
import { passesByItself, runOwnerTriggered, type RunDeps, type RunResult } from './run';
import type { DraftPolicyJson, OwnerAnswer } from './types';

/**
 * The worker's side of `JOB_AGENT_OWNER_ANSWER` (spec SPEC-P1-v2 §2.2): the reply his ✍️ answer makes, drafted by the
 * owner-triggered run under the source key `answer:<question>:<his message>` — never one shared with another kind
 * of run, or a second job would answer «duplicate» in silence.
 *
 * Nothing is retired before the run: the question draft is superseded INSIDE the redraft's own transaction
 * (`createDraft`'s `answers`). Every outcome that is not a draft is SAID — the question goes back to him (`pending`,
 * ready for ✏️, the lines that stood down asked again) and the notice quotes his answer back, so the customer's
 * missing reply never waits on a card that is not coming. One retry for a refusal that passes by itself (a tg-listen
 * rebuild), the hand-back's precedent.
 */

export interface OwnerAnswerDeps extends RunDeps {
  /** Tests: the retry's sender (pg-boss's `enqueue` otherwise). */
  requeue?: (job: AgentOwnerAnswerJob, startAfterS: number) => Promise<void>;
}

/** The question was decided after his answer — ✅, ❌, 🙋, his ✏️, a newer answer, the sweep handing it back. */
export const QUESTION_DECIDED_WORDS = 'savol kartasi javobingizdan keyin boshqacha hal qilingan (✅, ✏️, ❌ yoki 🙋)';

/** Why his answer made no draft, in words — one for every outcome but a draft (exhaustive over `RunResult`). */
export function answerNoDraftWhy(out: RunResult): string | null {
  switch (out.outcome) {
    case 'draft':
      return null;
    case 'refused':
      return NO_DRAFT_WORDS[out.reason];
    case 'capped':
      return 'bugungi AI byudjeti tugadi';
    case 'error':
      return 'AI xato qildi';
    case 'no_reply':
      return 'AI mijozga javob kerak emas deb topdi';
    case 'skipped':
      if (out.reason === 'no_fresh_inbound') return 'mijozning oxirgi xabari 24 soatdan eski';
      if (out.reason === 'agent_off') return "AI o'chirilgan";
      if (out.reason === 'ai_not_configured') return 'AI ulanmagan (kalit yo‘q)';
      if (out.reason === 'not_ready') return 'server hali yangilanmagan';
      return 'AI bu chatga yozmaydi';
    case 'stood_down':
      if (out.reason === 'question_gone') return QUESTION_DECIDED_WORDS;
      if (out.reason === 'duplicate') return 'bu javob bo‘yicha AI allaqachon ishlagan';
      return 'chatda boshqa qoralama tahrirda';
    case 'rescheduled':
    case 'notice':
      return 'AI hozir yozolmadi';
  }
}

/** The notice beside his card: no reply was drafted, why, and his answer back so he can send it himself. */
export async function tellNoAnswerDraft(
  q: Pick<typeof agentDrafts.$inferSelect, 'managerUserId' | 'peerId' | 'policy'>,
  answer: Pick<OwnerAnswer, 'text'>,
  why: string,
): Promise<void> {
  const label = ((q.policy ?? {}) as Partial<DraftPolicyJson>).card?.customerLabel ?? '—';
  await notifyStaffTelegram({
    userIds: [q.managerUserId],
    type: 'AgentNotice',
    text: `✍️ AI mijozga javob yozmadi — ${label}\nSabab: ${why}.\nJavobingiz: «${answer.text}»\nKartadagi «✏️ O‘zgartirish» bilan mijozga o‘zingiz yozing.`,
    // The chat the purge finds a notice by — this one quotes his answer about it.
    extra: { peerId: String(q.peerId) },
  });
}

export async function handleOwnerAnswer(job: AgentOwnerAnswerJob, deps: OwnerAnswerDeps = {}): Promise<RunResult | null> {
  const [q] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, job.draftId));
  const p = (q?.policy ?? {}) as Partial<DraftPolicyJson>;
  const answer = p.ownerAnswer;
  // A job for an answer since replaced by a newer one (whose own job speaks), or a chat since purged: nothing to say.
  if (!q || q.managerUserId !== job.managerUserId || !answer || answer.messageId !== job.messageId) return null;
  // This very answer already made its reply (the job delivered twice): the question says so on its own card, and
  // «AI javob yozmadi» beside the reply it wrote would be false.
  if (q.status === 'superseded' && (p as { stale?: unknown }).stale === 'owner_answered') return null;
  if (q.status !== 'editing' || !p.answering) {
    await tellNoAnswerDraft(q, answer, QUESTION_DECIDED_WORDS);
    return null;
  }
  // A throw before the run has a row of its own (the chat's context not read, the database blinking) is an outcome
  // like any other: said now and the question handed back, never left for the sweep's quarter of an hour.
  const out: RunResult = await runOwnerTriggered(
    {
      trigger: 'owner_edit',
      managerUserId: job.managerUserId,
      peerId: q.peerId,
      sourceKey: `answer:${q.id}:${job.messageId}`,
      instruction: ownerAnswerInstruction(answer.text, q.ownerQuestion),
      answer: {
        questionDraftId: q.id,
        questionAnchor: q.anchorTgMessageId,
        questionAnchorEditedAt: q.anchorEditedAt,
        questionDraftedAt: q.createdAt,
        messageId: job.messageId,
        text: answer.text,
      },
    },
    deps,
  ).catch((err: unknown): RunResult => {
    logger.error({ err, draftId: q.id }, '[agent] owner answer run threw');
    return { outcome: 'error', reason: err instanceof Error ? err.message.slice(0, 300) : 'error' };
  });
  // The source key is taken: another delivery of this job is drafting it right now, or died with it — that one
  // speaks (or the sweep does, `ANSWER_RUN_STALE_MS`). Handing the question back here would take it from under the
  // run that is writing its reply.
  if (out.outcome === 'stood_down' && out.reason === 'duplicate') return out;
  if (out.outcome === 'refused' && passesByItself(out.reason) && (job.attempt ?? 0) < 1) {
    const next: AgentOwnerAnswerJob = { ...job, attempt: (job.attempt ?? 0) + 1 };
    const send =
      deps.requeue ??
      (async (data: AgentOwnerAnswerJob, startAfterS: number) =>
        (await import('../../platform/jobs/boss')).enqueue(JOB_AGENT_OWNER_ANSWER, data, { startAfter: startAfterS, retryLimit: 0 }));
    await send(next, HAND_BACK_RETRY_S);
    return out;
  }
  const why = answerNoDraftWhy(out);
  if (why === null) return out;
  // The question is his again — unless it was decided already, which is its own answer.
  if (!(out.outcome === 'stood_down' && out.reason === 'question_gone')) {
    await releaseAnswering(q.id, { note: `✍️ AI javob yozmadi: ${why}.`, redraft: true }).catch((err: unknown) =>
      logger.warn({ err, draftId: q.id }, '[agent] answered question not handed back'),
    );
  }
  await tellNoAnswerDraft(q, answer, why);
  return out;
}
