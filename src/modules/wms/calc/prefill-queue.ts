import { logger } from '../../platform/logger';
import { sectionParts, type CalcSectionName } from './pricing';
import { prefillTicket } from './prefill';

/**
 * Hand a just-landed job to the machine — from ANY of the three doors.
 *
 * The bot has queued the pass since sub-round B; the seller's card form and
 * the thread door landed identical requests and got nothing, so which of
 * three buttons a seller happened to use decided whether the machine ever
 * looked at their cargo. One sender now, called by all three.
 *
 * Through pg-boss and never a `void` promise: the pass belongs to something
 * that outlives the container the owner restarts on every deploy (#905's
 * round). The revision travels WITH the job, because the queue drains when
 * it drains and the machine must not overwrite what a person did meanwhile.
 *
 * EVERY section is queued now, and the section picks the QUEUE. The owner's
 * decision 8 («the AI prices rastamojka and nothing else») was overturned on
 * 2026-09-26 (item 13), and his 2.5 b on 2026-10-21 asked a yolkira request
 * to be answered at once from the tariff table. A yolkira job therefore goes
 * to its own queue, where the reply is a few queries and no model call, and
 * never waits behind a customs pass (docs/SAKKIZ-R2.md §6.8).
 */
export async function queueCalcPrefill(input: {
  requestId: string;
  staffId: string;
  section: string | null;
}): Promise<boolean> {
  const parts = input.section
    ? sectionParts(input.section as CalcSectionName)
    : { customs: true, freight: true, extras: true };
  try {
    const { enqueue } = await import('../../platform/jobs/boss');
    const { JOB_CALC_PREFILL, JOB_CALC_TARIFF_REPLY, PASS_EXPIRE_S, TARIFF_EXPIRE_S } = await import('./jobs');
    const rev = await prefillTicket(input.requestId);
    // The section travels with the job (K16, `CalcPrefillJob.section`): the
    // worker routes and words its answer by it without a query.
    const { requestId, staffId, section } = input;
    if (parts.customs) {
      // Expiry above the pass's own deadline plus one worst step, so pg-boss
      // never re-delivers a pass that is still running.
      await enqueue(JOB_CALC_PREFILL, { requestId, staffId, rev, section }, { expireInSeconds: PASS_EXPIRE_S });
    } else {
      await enqueue(JOB_CALC_TARIFF_REPLY, { requestId, staffId, rev, section }, { expireInSeconds: TARIFF_EXPIRE_S });
    }
    return true;
  } catch (err) {
    // The queue being unreachable must not cost the seller the confirmation
    // they are about to read: the request is saved and a VED will answer it
    // whether or not the machine got there first.
    logger.warn({ err, requestId: input.requestId }, 'calc prefill could not be queued');
    return false;
  }
}
