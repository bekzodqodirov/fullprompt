import { logger } from '../../platform/logger';
import { sectionParts, type CalcSectionName } from './pricing';
import { prefillTicket } from './prefill';

/**
 * Hand a just-landed job to the AI VED hodimi — from ANY of the three doors.
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
 * A yolkira job is NOT queued. The AI prices rastamojka and nothing else
 * (the owner's decision 8), so a freight-only request would spend a model
 * call to answer «I do not price this».
 */
export async function queueCalcPrefill(input: {
  requestId: string;
  staffId: string;
  section: string | null;
}): Promise<boolean> {
  const parts = input.section
    ? sectionParts(input.section as CalcSectionName)
    : { customs: true, freight: true, extras: true };
  if (!parts.customs) return false;
  try {
    const { enqueue } = await import('../../platform/jobs/boss');
    const { JOB_CALC_PREFILL } = await import('./jobs');
    const rev = await prefillTicket(input.requestId);
    await enqueue(JOB_CALC_PREFILL, { requestId: input.requestId, staffId: input.staffId, rev });
    return true;
  } catch (err) {
    // The queue being unreachable must not cost the seller the confirmation
    // they are about to read: the request is saved and a VED will answer it
    // whether or not the machine got there first.
    logger.warn({ err, requestId: input.requestId }, 'calc prefill could not be queued');
    return false;
  }
}
