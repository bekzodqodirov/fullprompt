import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { calcRequests } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { sectionParts, type CalcSectionName } from './pricing';
import type { JOB_CALC_PREFILL, JOB_CALC_TARIFF_REPLY } from './jobs';

/**
 * Which queue a section's pass runs on — the routing `queueCalcPrefill` has
 * always done, given one home (docs/SAKKIZ-R3.md K15) because the ticket's
 * reader must ask the SAME queue for the job's state. A request with no
 * section was a customs job, the only kind there was. Literal strings, typed
 * against jobs.ts's constants: jobs.ts is reached dynamically from here.
 */
export function passQueueOf(section: string | null): typeof JOB_CALC_PREFILL | typeof JOB_CALC_TARIFF_REPLY {
  const customs = section ? sectionParts(section as CalcSectionName).customs : true;
  return customs ? 'calc.prefill' : 'calc.tariff-reply';
}

/**
 * How long a ticket whose job pg-boss does not know may still be a send in
 * flight. `queueCalcPrefill` takes the ticket and only THEN sends the job —
 * two statements, and the first send after a deploy starts pg-boss between
 * them — so for that moment the ticket reads exactly like one whose job is
 * gone. An enqueue that throws clears its own ticket; only a process killed
 * between the two leaves one behind, and this window lets it go.
 */
export const TICKET_SEND_WINDOW_S = 60;

/** The ticket cleared — the settle's and a dead ticket's one statement. */
const clearTicket = (requestId: string, job: string) => sql`
  UPDATE calc_requests SET ai_pass_rev = NULL, ai_pass_at = NULL, ai_pass_job = NULL
   WHERE id = ${requestId}::uuid AND ai_pass_job::text = ${job}
`;

/**
 * Does a machine pass stand on this request — owed or running (docs/SAKKIZ-R3.md
 * §10.2.1)? The ONE home for «busy»: the add door's standing asks it, and so
 * does the sender before it queues a second pass.
 *
 * A pass stands when the request carries a ticket (`ai_pass_job`, 0138) and
 * pg-boss still has THAT job waiting or running. It is a fact about a job,
 * never a time window: under a deep queue a window cleared «busy» before the
 * landing's pass had even started (the first draft's 35 minutes), and the
 * seller's addition then ran under a pass that went on to call him «started».
 * A ticket whose job is terminal or gone (a pass killed by a deploy past its
 * expiry, a job pruned) is cleared HERE, conditionally on that same job id,
 * so a ticket taken meanwhile by a new pass is never the one cleared.
 *
 * A YOUNG ticket with no job is not dead: it is its own send still in
 * flight (`TICKET_SEND_WINDOW_S`). Cleared as dead, a second press of one
 * note took a second ticket and queued a second pass, and a seller's next
 * addition was written under a pass that then stood down calling a VED who
 * never came «allaqachon ishlayapti» (review p5-spec-1, p5-adv-4).
 */
export async function ticketStanding(requestId: string): Promise<'live' | 'none'> {
  const [row] = await db
    .select({
      job: calcRequests.aiPassJob,
      section: calcRequests.section,
      young: sql<boolean>`${calcRequests.aiPassAt} > now() - make_interval(secs => ${TICKET_SEND_WINDOW_S})`,
    })
    .from(calcRequests)
    .where(eq(calcRequests.id, requestId));
  if (!row?.job) return 'none';
  const { jobState } = await import('../../platform/jobs/boss');
  const state = await jobState(passQueueOf(row.section), row.job);
  if (state === 'created' || state === 'retry' || state === 'active') return 'live';
  if (state === null && row.young === true) return 'live';
  await db.execute(clearTicket(requestId, row.job));
  logger.info({ requestId, job: row.job, state }, '[calc-prefill] a dead pass ticket cleared');
  return 'none';
}

/**
 * Take the ticket — the request's own row says a pass is owed, and which job
 * runs it — in ONE statement: only on an open request, only when no ticket
 * stands, and only at `atRev` when the caller names one. The ticket is the
 * revision the job will quote back (`CalcPrefillJob.rev`). `rev` and
 * `updated_at` are not moved: the clock stays the person-touch detector.
 */
async function takeTicket(requestId: string, job: string, atRev: number | undefined): Promise<number | null> {
  const [row] = await db.execute<{ rev: number }>(sql`
    UPDATE calc_requests SET ai_pass_rev = rev, ai_pass_at = now(), ai_pass_job = ${job}::uuid
     WHERE id = ${requestId}::uuid AND completed_at IS NULL AND ai_pass_rev IS NULL
       AND (${atRev ?? null}::int IS NULL OR rev = ${atRev ?? null}::int)
    RETURNING rev
  `);
  return row ? Number(row.rev) : null;
}

/**
 * Hand a just-landed job to the machine — from ANY of the three doors, and
 * since round 3 from the add door too (a seller's addition queues the pass
 * again, under its own `pass` key).
 *
 * The bot has queued the pass since sub-round B; the seller's card form and
 * the thread door landed identical requests and got nothing, so which of
 * three buttons a seller happened to use decided whether the machine ever
 * looked at their cargo. One sender now, called by all of them.
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
 *
 * THE TICKET (docs/SAKKIZ-R3.md §10.2.1): one pass at a time per request.
 * Uch band's retried landings and the add door's redo can each ask for a
 * pass that already stands; the request's row is taken atomically, so two
 * resumes of one cut-off landing queue ONE pass, and a second ask while a
 * pass stands answers «yes, queued» without queueing — the landing's ✅
 * (`replyQueued`, which feeds `tariffFollows`) stays truthful.
 *
 * True: a pass is queued (or already stands). False: the request is closed,
 * a person moved it since `atRev`, or the queue refused — the request is in
 * the VED's queue whatever this answers.
 */
export async function queueCalcPrefill(input: {
  requestId: string;
  staffId: string;
  section: string | null;
  /** Which pass this is (`sayOnce`'s key); absent = the landing's. */
  pass?: string;
  /** Queue only while the request still stands at this revision — a person
   * who moved it since the commit that asked for the pass wins. */
  atRev?: number;
}): Promise<boolean> {
  try {
    const { enqueue } = await import('../../platform/jobs/boss');
    const { PASS_EXPIRE_S, TARIFF_EXPIRE_S } = await import('./jobs');
    const { requestId, staffId, section } = input;
    const pass = input.pass ?? 'landing';
    const job = randomUUID();
    let rev = await takeTicket(requestId, job, input.atRev);
    if (rev === null) {
      // A pass stands already: this ask is answered by it. Otherwise the
      // standing cleared a DEAD ticket (or there was none) — the ticket is
      // taken once more, and refused only by what refused it the first time.
      if ((await ticketStanding(requestId)) === 'live') return true;
      rev = await takeTicket(requestId, job, input.atRev);
      if (rev === null) return false;
    }
    // Expiry above the pass's own deadline plus one worst step on the customs
    // queue, so pg-boss never re-delivers a pass that is still running; a
    // tariff reply is a few queries.
    const expireInSeconds = passQueueOf(section) === 'calc.prefill' ? PASS_EXPIRE_S : TARIFF_EXPIRE_S;
    try {
      // The section travels with the job (K16, `CalcPrefillJob.section`): the
      // worker routes and words its answer by it without a query. The id is
      // the ticket's, so «does this pass still stand» is asked of THIS job.
      await enqueue(passQueueOf(section), { requestId, staffId, rev, section, pass }, { id: job, expireInSeconds });
    } catch (err) {
      // A ticket naming a job that was never sent would read «busy» until
      // its job's state came back null — clear it now, by its own id.
      await db.execute(clearTicket(requestId, job)).catch(() => {});
      throw err;
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

/**
 * The pass has ended — whichever way: an answer, a stand-down, a failure
 * (docs/SAKKIZ-R3.md §10.2.2). ONLY the ticket is cleared, and only while it
 * still names THIS job: a redelivery or a later pass's ticket is never
 * touched. The hands-off stamp is NOT moved here — every machine save moves
 * it inside its own transaction (`advanceHandsOffInTx`), so a pass killed
 * mid-way, which runs no settle, leaves it at its last committed write
 * (durability-6).
 *
 * Then any addition the seller made while this pass ran is written now, by
 * its own job, without a second press (`requeueWaitingAmendments`,
 * product-fit-6). Called from the worker's `finally`, inside its own catch.
 */
export async function settlePass(requestId: string, jobId: string): Promise<void> {
  await db.execute(clearTicket(requestId, jobId));
  // Dynamically: the add door's writer reaches this module for its standing.
  const { requeueWaitingAmendments } = await import('./amend');
  await requeueWaitingAmendments(requestId);
}
