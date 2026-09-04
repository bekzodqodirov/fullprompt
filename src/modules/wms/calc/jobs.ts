import type PgBoss from 'pg-boss';
import { logger } from '@/modules/platform/logger';
import { notifyOverdueCalcs } from './service';
import { notifyDictionaryReview } from './review';

export const JOB_CALC_OVERDUE = 'calc.overdue';
export const JOB_CALC_REVIEW = 'calc.dict-review';
export const JOB_CALC_PREFILL = 'calc.prefill';

export interface CalcPrefillJob {
  requestId: string;
  /** Whose job it is — the audit actor AND who is told the answer. */
  staffId: string;
}

/**
 * The lateness watch for calculations (round 28, reopened in VED phase A).
 *
 * Every five minutes rather than the digests' once-a-morning: the deadlines
 * here are 30–120 MINUTES, and a red flag that arrives the next day is an
 * anecdote, not an alert. Five minutes is also the most the flag can lag its
 * deadline, which on a half-hour SLA is noise.
 *
 * The sweep itself claims its rows in the UPDATE before anything leaves
 * (0082's rule), so two overlapping sweeps split the work instead of both
 * announcing it.
 */
export async function registerCalcWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_CALC_OVERDUE);
  await boss.schedule(JOB_CALC_OVERDUE, '*/5 * * * *');
  await boss.work(JOB_CALC_OVERDUE, async () => {
    try {
      const sent = await notifyOverdueCalcs();
      if (sent > 0) logger.info({ sent }, 'calc overdue flags sent');
    } catch (err) {
      logger.error({ err }, 'calc overdue sweep failed');
      throw err;
    }
  });
}

/**
 * «Har oyda bir marta ko'rib chiqish» — the dictionary review reminder.
 *
 * Scheduled DAILY and claimed monthly, rather than scheduled monthly. A
 * `0 6 1 * *` cron fires once, and if the container is down that minute — a
 * deploy, a restart, the one morning the VPS is being resized — the month is
 * simply skipped with nothing to notice it. A daily attempt that claims the
 * month cannot miss: whichever day the process is first alive, it speaks.
 *
 * 06:00 UTC is 11:00 in Tashkent — inside the office day, like the stale-lead
 * sweep, because this message can reach Telegram.
 */
export async function registerCalcReviewWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_CALC_REVIEW);
  await boss.schedule(JOB_CALC_REVIEW, '0 6 * * *');
  await boss.work(JOB_CALC_REVIEW, async () => {
    try {
      const sent = await notifyDictionaryReview();
      if (sent > 0) logger.info({ sent }, 'calc dictionary review reminder sent');
    } catch (err) {
      logger.error({ err }, 'calc dictionary review sweep failed');
      throw err;
    }
  });
}

/**
 * The AI VED hodimi's pass, OWNED.
 *
 * It was dispatched with `void` from the staff bot, which polls inside the
 * Next.js app process — the one the owner restarts on every deploy
 * (`docker compose build migrate app`). A restart 90 seconds after a seller
 * pressed ✅ left a request carrying AI groups that `applyProposal` had
 * already committed, no bazas, no row anywhere saying a prefill was owed,
 * no retry, and a seller who had been promised an answer and got silence.
 * The precedent is one directory over and was written in this same
 * sub-round: the customs parse is a pg-boss job for exactly this reason.
 *
 * The answer is delivered through `notifyStaffTelegram` rather than the
 * grammy context that no longer exists by then: the drain owns the claim
 * (0082) and round 101's transient-vs-permanent budget, so a Telegram 429
 * costs a retry instead of the message.
 *
 * A failure is NOT rethrown. The pass is best-effort by construction — the
 * request is in the VED's queue whatever happens here, and a person will
 * answer it — so five retries of a model that refused would spend money to
 * change nothing. What IS worth retrying is the process dying mid-pass, and
 * that is a job pg-boss re-delivers on its own.
 */
export async function registerCalcPrefillWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_CALC_PREFILL);
  await boss.work<CalcPrefillJob>(JOB_CALC_PREFILL, async (jobs) => {
    for (const job of jobs) {
      const { requestId, staffId } = job.data;
      try {
        const { aiPrefill } = await import('./prefill');
        const { notifyStaffTelegram } = await import('@/modules/platform/notifications/staff');
        const out = await aiPrefill(requestId, { actorId: staffId });
        await notifyStaffTelegram({
          userIds: [staffId],
          type: 'CalcPrefilled',
          text: out.text,
        });
        logger.info(
          { requestId, codesStamped: out.codesStamped, picked: out.picked, aiUsed: out.aiUsed },
          '[calc-prefill] pass finished',
        );
      } catch (err) {
        logger.error({ err, requestId }, '[calc-prefill] pass failed — the VED still has the job');
      }
    }
  });
}
