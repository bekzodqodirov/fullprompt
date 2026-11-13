import { eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { agentDrafts, agentLessons } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { HAND_BACK_RETRY_S } from './calc-loop';
import { clearLessonRedraft, lessonInstruction, tellNoLessonDraft } from './lessons';
import { answerNoDraftWhy, type OwnerAnswerDeps } from './owner-answer-job';
import { JOB_AGENT_OWNER_ANSWER, type AgentOwnerAnswerJob } from './queues';
import { passesByItself, runOwnerTriggered, type RunResult } from './run';
import type { DraftPolicyJson } from './types';

/**
 * The worker's side of a LESSON's rewrite (spec SPEC-P1-v2 §3.4) — «through the same queued job» as his ✍️ answer
 * (`JOB_AGENT_OWNER_ANSWER`, a job that names its `lessonId`): the reply he judged wrong on a card still waiting
 * for his ✅ is written again by the owner-triggered run, with the lesson as its INSTRUCTION (never a source), keyed
 * `lesson:<lessonId>` — never the key an answer on the same draft takes — and with NO «o'zi yuborish» plan.
 *
 * Nothing is retired before the run: the old reply is superseded INSIDE the rewrite's own transaction (`createDraft`'s
 * `redrafts`), and only while it still carries this lesson's mark. Every outcome that is not a draft is SAID — the
 * mark comes off the card (it is an ordinary card again, his ✅ and ✏️ as they were) and a notice names the reason
 * and that the lesson is kept. One retry for a refusal that passes by itself (a tg-listen rebuild).
 */

/** The card was decided — or the customer wrote again — after the lesson was saved: the rewrite has nothing to replace. */
export const LESSON_CARD_MOVED_WORDS = 'karta saboqdan keyin o‘zgardi (o‘zingiz hal qildingiz yoki mijoz yana yozdi)';

export async function handleLessonRedraft(job: AgentOwnerAnswerJob, deps: OwnerAnswerDeps = {}): Promise<RunResult | null> {
  if (!job.lessonId) return null;
  const [lesson] = await db.select().from(agentLessons).where(eq(agentLessons.id, job.lessonId));
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, job.draftId));
  // A chat since purged: nothing to rewrite and nobody to tell.
  if (!d || d.managerUserId !== job.managerUserId) return null;
  if (!lesson || lesson.confirmedAt === null || !lesson.active) {
    // He took the lesson back on the page (deleted, switched off) before the worker came: there is nothing to
    // rewrite FROM. The mark comes off in silence — the card is an ordinary card again, and he knows why.
    await clearLessonRedraft(d.id, job.lessonId, null);
    return null;
  }
  const p = (d.policy ?? {}) as Partial<DraftPolicyJson> & { stale?: unknown };
  // This very lesson already made its rewrite (the job delivered twice): the old card says so itself.
  if (d.status === 'superseded' && p.stale === 'owner_lesson') return null;
  // The mark is gone, or is a NEWER lesson's: whoever took it has spoken (the sweep's hand-back, that lesson's job).
  if (p.lessonRedraft?.lessonId !== lesson.id) return null;
  if (d.status !== 'pending' || d.finalBody !== null) {
    await clearLessonRedraft(d.id, lesson.id, null);
    await tellNoLessonDraft(d, lesson.text, LESSON_CARD_MOVED_WORDS);
    return null;
  }
  // A throw before the run has a row of its own is an outcome like any other: said now, never left for the sweep.
  const out: RunResult = await runOwnerTriggered(
    {
      trigger: 'owner_edit',
      managerUserId: job.managerUserId,
      peerId: d.peerId,
      sourceKey: `lesson:${lesson.id}`,
      instruction: lessonInstruction(lesson.text, d.proposedBody),
      lesson: { draftId: d.id, lessonId: lesson.id },
    },
    deps,
  ).catch((err: unknown): RunResult => {
    logger.error({ err, draftId: d.id }, '[agent] lesson rewrite run threw');
    return { outcome: 'error', reason: err instanceof Error ? err.message.slice(0, 300) : 'error' };
  });
  if (out.outcome === 'draft') return out;
  // The source key is taken: another delivery of this job is writing it right now, or died with it — that one
  // speaks (or the sweep does). Clearing the mark here would take the card from under the run that is rewriting it.
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
  const moved = out.outcome === 'stood_down' && out.reason === 'question_gone';
  if (moved) {
    // What the rewrite found in the old reply's place, read again: a NEWER lesson's mark (its own rewrite speaks),
    // or a twin delivery's finished rewrite — neither is «the card moved».
    const [now] = await db.select({ status: agentDrafts.status, policy: agentDrafts.policy }).from(agentDrafts).where(eq(agentDrafts.id, d.id));
    const after = (now?.policy ?? {}) as Partial<DraftPolicyJson> & { stale?: unknown };
    if (after.lessonRedraft && after.lessonRedraft.lessonId !== lesson.id) return out;
    if (now?.status === 'superseded' && after.stale === 'owner_lesson') return out;
  }
  const why = moved ? LESSON_CARD_MOVED_WORDS : (answerNoDraftWhy(out) ?? 'AI hozir yozolmadi');
  // The mark comes off only while it is still this lesson's — a newer lesson that took the card speaks for itself.
  const cleared = await clearLessonRedraft(d.id, lesson.id, moved ? null : `📝 AI javobni qayta yozmadi: ${why}.`).catch((err: unknown) => {
    logger.warn({ err, draftId: d.id }, '[agent] lesson mark not cleared');
    return false;
  });
  if (cleared || moved) await tellNoLessonDraft(d, lesson.text, why);
  return out;
}
