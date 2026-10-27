import type PgBoss from 'pg-boss';
import { logger } from '@/modules/platform/logger';
import { sectionParts, type CalcSectionName } from './pricing';
import { notifyOverdueCalcs } from './service';
import { notifyDictionaryReview } from './review';
import { sendLinkAsks } from './link-ask';

export const JOB_CALC_OVERDUE = 'calc.overdue';
export const JOB_CALC_REVIEW = 'calc.dict-review';
export const JOB_CALC_PREFILL = 'calc.prefill';
export const JOB_CALC_LINK_ASK = 'calc.link-ask';
/**
 * A yolkira job's tariff reply (his 2.5 b) — its OWN queue, because pg-boss
 * 10.4.2's worker fetches one job and awaits its handler before the next
 * (`batchSize` 1): on the customs queue a tariff lookup that takes
 * milliseconds would wait behind every customs pass in flight, each up to
 * 2 × 60 s per model call. Priority would not help — it cannot overtake the
 * job already running.
 */
export const JOB_CALC_TARIFF_REPLY = 'calc.tariff-reply';

/**
 * How long a claimed customs pass may run before pg-boss re-delivers it.
 *
 * Every model step asks the pass's clock BEFORE it starts (review perf-3), so
 * a pass overruns `PASS_DEADLINE_MS` (10 minutes) by one step at most, and
 * the longest step there is is the grouping of a full request:
 * MAX_CALC_ITEMS (1000) rows in AI_BATCH_SIZE (200) batches of up to 2 × 60 s
 * each — another 10 minutes (`calc-prefill-wire.test.ts` derives it). 1800 s
 * clears both, so the queue never starts a second pass beside one still
 * running; the default 15 minutes would have. Not counted, stated: a save's
 * own customs-file scans carry no ceiling of their own.
 *
 * THE COST, stated (review CONC-6): a pass KILLED mid-run — the container is
 * rebuilt on every deploy, and nothing here stops pg-boss gracefully on
 * SIGTERM — is re-delivered only when this expiry lapses: the seller waits up
 * to 30 minutes, not 15, and is then told PASS_FAILED (`unfinished`), while
 * the request sits in the VED's queue the whole time. The trade is the one
 * above: a shorter expiry re-delivers a LIVE pass beside itself.
 */
export const PASS_EXPIRE_S = 1800;
/** A tariff reply is a few queries; five minutes is generous. */
export const TARIFF_EXPIRE_S = 300;

export interface CalcPrefillJob {
  requestId: string;
  /** Whose job it is — the audit actor AND who is told the answer. */
  staffId: string;
  /** The revision the request stood at when this was queued — see
   * `prefillStanding`. Absent on a job queued before this field existed,
   * which then falls back to the confirmed/closed checks alone. */
  rev?: number | null;
  /**
   * The request's section when it was queued (docs/SAKKIZ-R2.md K16), so the
   * worker can tell a customs pass from a tariff reply without a database
   * read. Absent on a job queued before this field existed — which was a
   * customs job, the only kind there was.
   */
  section?: string | null;
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
 * «Bu prixodlar hisobingizga tegishlimi?» (0119) — every five minutes, and
 * only 03:00-14:55 UTC = 08:00-19:55 in Tashkent (his answer 12a): a question with buttons at 23:00 is a question
 * answered wrong or not at all. The sweep claims before it sends, so two
 * overlapping runs split the work.
 */
export async function registerCalcLinkAskWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_CALC_LINK_ASK);
  await boss.schedule(JOB_CALC_LINK_ASK, '*/5 3-14 * * *');
  await boss.work(JOB_CALC_LINK_ASK, async () => {
    try {
      const sent = await sendLinkAsks();
      if (sent > 0) logger.info({ sent }, 'calc link asks sent');
    } catch (err) {
      logger.error({ err }, 'calc link ask sweep failed');
      throw err;
    }
  });
}

/** The seller's sentence when the pass itself failed. */
export const PASS_FAILED = '🤖 AI bu so‘rovni hisoblay olmadi — so‘rov VED navbatida, narxni VED beradi.';
/** …and when a yolkira job's tariff reply failed (§2.8) — no AI was asked. */
export const TARIFF_PASS_FAILED = '🧮 Yo‘lkira taxmini chiqmadi — so‘rov VED navbatida, narxni VED beradi.';

/**
 * Why the machine stood down: `prefillStanding`'s answer, or `unfinished` — a
 * re-delivered pass that found the revision moved (`attemptStanding`).
 */
export type StandDown = Exclude<import('./prefill').PrefillStand, 'ok'> | 'unfinished';

/**
 * What the seller is told when the machine stands down (2026-10-21, the round
 * plan's «stand-down message»). Keyed by why; null = nothing to say (a
 * request that no longer exists has nobody waiting on it).
 */
export const STOOD_DOWN: Record<StandDown, string | null> = {
  touched: '🤖 AI hisoblamadi: VED bu so‘rovni allaqachon ochib ishlayapti — narxni VED beradi.',
  confirmed: '🤖 AI hisoblamadi: VED guruhlarni tasdiqlab bo‘lgan — narxni VED beradi.',
  closed: '🤖 AI hisoblamadi: so‘rov allaqachon yopilgan.',
  not_found: null,
  unfinished: PASS_FAILED,
};

/**
 * The tariff queue's own words where they differ (§2.8). A request that has
 * since gained a customs half («touched» by a section change) stands down in
 * the customs sentence: the VED is on it either way.
 */
export const TARIFF_STOOD_DOWN: Record<TariffStandDown, string | null> = {
  closed: '🧮 Yo‘lkira taxmini yuborilmadi: so‘rov allaqachon yopilgan.',
  not_found: STOOD_DOWN.not_found,
  unfinished: TARIFF_PASS_FAILED,
};

/**
 * What a tariff reply can stand down for (review concurrency-9). It writes
 * nothing, so a person's work — a moved revision, a ✅ — is nothing it could
 * overwrite and never a reason to withhold the tariff's figure: those keys
 * are not in its map, so no sentence is invented for a state that answers.
 */
export type TariffStandDown = Exclude<StandDown, 'touched' | 'confirmed'>;

/** The sentence for a stand-down, from its own queue's words. */
export function standDownWords(standing: StandDown, writes: boolean): string | null {
  if (writes) return STOOD_DOWN[standing];
  // `attemptStanding` answers 'ok' for both on the tariff queue; nothing
  // reaches here with them.
  if (standing === 'touched' || standing === 'confirmed') return null;
  return TARIFF_STOOD_DOWN[standing];
}

/**
 * The standing, read with the attempt (round-1 review, a18).
 *
 * `touched` means «the revision moved since this was queued», and on a FIRST
 * attempt only a person can have moved it. A RE-DELIVERED job is the process
 * dying mid-pass (the handler never rethrows), and the dead pass's own writes
 * — the memory save, the groups, the codes — moved the clock under the
 * machine's name: telling the seller «VED bu so'rovni allaqachon ochib
 * ishlayapti» then is a sentence about a person nobody saw, repeated to the
 * customer. A retry is `unfinished` — the AI did not finish, the VED has the
 * job. `confirmed` and `closed` only a person produces (the machine never
 * ticks ✅ and never seals), so they stand on any attempt.
 *
 * `writes`: does this queue's pass WRITE (a customs pass) or only answer (a
 * tariff reply, §6.8)? A tariff reply writes nothing, so neither a moved
 * revision nor a group a person has ✅ed is anything it could overwrite —
 * both answer (review concurrency-9: a ✅ landing between the job's INSERT
 * and its ticket used to withhold the tariff's figure with the customs
 * sentence), and `unfinished` cannot arise. A request whose SECTION moved is
 * the pass's own stand-down (`aiPrefill`'s `expectCustoms`).
 */
export function attemptStanding(
  standing: import('./prefill').PrefillStand,
  retryCount: number,
  writes: boolean,
): import('./prefill').PrefillStand | 'unfinished' {
  if (!writes) return standing === 'touched' || standing === 'confirmed' ? 'ok' : standing;
  return standing === 'touched' && retryCount > 0 ? 'unfinished' : standing;
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
 * TWO queues, ONE handler (§6.8): customs passes on `JOB_CALC_PREFILL`, the
 * yolkira tariff reply on `JOB_CALC_TARIFF_REPLY`, so a reply that takes
 * milliseconds never waits behind a pass that takes minutes. Both are created
 * and worked here, which is where `boss.ts` already looks.
 *
 * The answer is delivered through the notification drain rather than the
 * grammy context that no longer exists by then: the drain owns the claim
 * (0082) and round 101's transient-vs-permanent budget, so a Telegram 429
 * costs a retry instead of the message. And it goes through `sayOnce`: ONE
 * machine message per request, so a re-delivered job sends nothing at all
 * once one is queued — no second reply, no second lenta note, no «hisoblay
 * olmadi» after a real answer.
 *
 * A failure is NOT rethrown. The pass is best-effort by construction — the
 * request is in the VED's queue whatever happens here, and a person will
 * answer it — so five retries of a model that refused would spend money to
 * change nothing. What IS worth retrying is the process dying mid-pass, and
 * that is a job pg-boss re-delivers on its own.
 */
export async function registerCalcPrefillWorker(boss: PgBoss): Promise<void> {
  // The customs queue FIRST: its registration is the one every older pin reads.
  for (const queue of [JOB_CALC_PREFILL, JOB_CALC_TARIFF_REPLY]) {
    await boss.createQueue(queue);
    // `includeMetadata`: the stand-down sentence depends on whether this is a
    // re-delivery (`attemptStanding`) — customs/jobs.ts asks for it the same way.
    await boss.work<CalcPrefillJob>(queue, { includeMetadata: true }, async (jobs) => {
      for (const job of jobs) await runPrefillJob(job.data, job.retryCount ?? 0);
    });
  }
}

/** One job, on either queue — the payload's section says which pass it is. */
async function runPrefillJob(data: CalcPrefillJob, retryCount: number): Promise<void> {
  const { requestId, staffId } = data;
  // K16: the section rides the payload, so this is no database read. A job
  // queued before round 2 carries none — it was a customs job, the only kind.
  const writes = sectionParts((data.section ?? 'rastamojka') as CalcSectionName).customs;
  try {
    const { aiPrefill, prefillStanding } = await import('./prefill');
    const { sayOnce } = await import('./say-once');
    // A person may have reached the request first — the queue drains
    // when it drains, and pg-boss re-delivers. The machine stands down
    // rather than deleting their groups and un-ticking their ✅.
    const standing = attemptStanding(await prefillStanding(requestId, data.rev ?? null), retryCount, writes);
    if (standing !== 'ok') {
      logger.info({ requestId, standing, retryCount }, '[calc-prefill] stood down — the request has moved');
      // Said, not silent (2026-10-21): the seller was promised a figure in
      // this chat, and a pass that stood down used to leave him waiting.
      const said = standDownWords(standing, writes);
      if (said) await sayOnce(requestId, { userIds: [staffId], type: 'CalcPrefilled', text: said });
      return;
    }
    // NOBODY typed this. The pass ran under the seller's id, so every
    // TNVED code, every rate and every baza the machine wrote was
    // recorded in `audit_log` under the name of a person who never saw
    // them — and this company reads that log to answer «who put this
    // number here». `actorId: null` is the module's own idiom for a
    // machine acting (the stale-lead sweep writes the same way: nobody
    // causes a silence). Who ASKED is not lost — `calc_requests.
    // requested_by` records it, and the answer goes to them.
    // `replyTo`: the answer's link is chosen for the person it is sent to
    // (`calcJobHrefFor`) — a stranger's lead is the VED's own when the VED
    // sent it, and the CRM card bounces him.
    // `expectRev`: the revision the standing above was CHECKED against —
    // the pass's compare-and-set chain starts there, so a save landing after
    // this check is a conflict and never the machine's base.
    const expected = { expectCustoms: writes, expectRev: data.rev ?? null };
    const out = await aiPrefill(requestId, { actorId: null }, { replyTo: staffId }, expected);
    if (out.stood) {
      // The section moved since queueing (§2.8) — the customs sentence — or
      // the pass stood down mid-run: the VED closed the request (CONC-1), or
      // a person overtook the machine before it wrote anything (CONC-5).
      logger.info({ requestId, stood: out.stood, overtaken: out.overtaken }, '[calc-prefill] stood down mid-pass');
      const said = STOOD_DOWN[out.stood];
      if (said) await sayOnce(requestId, { userIds: [staffId], type: 'CalcPrefilled', text: said });
      return;
    }
    // `whileOpen` (review CONC-1): the request is read under the claim's own
    // lock, and a VED who closed it after the pass's last step — «Готово»,
    // a hand-back — has sent the official answer; the machine's reply and its
    // lenta note must not follow it.
    const spoke = await sayOnce(requestId, { userIds: [staffId], type: 'CalcPrefilled', text: out.text }, { whileOpen: true });
    if (!spoke) {
      // Withheld because the request closed: the seller is told so, once. Or
      // withheld because a message already went out (a re-delivery): the
      // claim drops this one too.
      const closed = (writes ? STOOD_DOWN : TARIFF_STOOD_DOWN).closed;
      if (closed) await sayOnce(requestId, { userIds: [staffId], type: 'CalcPrefilled', text: closed });
    }
    // His answer 2a: the SAME text onto the card's lenta. Two audiences
    // for one answer — the seller reads it on a phone and forgets it, the
    // VED opens the card tomorrow and needs to see what the machine told
    // the customer's seller. Behind a setting because it is a matter of
    // taste how noisy a lenta should be, and best-effort because a note
    // that failed to write must not cost the message that was delivered.
    // The LINKLESS rendering: on the card a link is a door to where the
    // reader already stands, or one the seller reading it is bounced from.
    // Only when THIS run spoke: a re-delivery writes no second note.
    if (spoke) {
      await writeReplyToLenta(requestId, out.lentaText).catch((err) =>
        logger.warn({ err, requestId }, '[calc-prefill] lenta note not written'),
      );
    }
    logger.info(
      {
        requestId,
        codesStamped: out.codesStamped,
        picked: out.picked,
        aiUsed: out.aiUsed,
        // Which step a person's save stopped the machine at, if any (CONC-5):
        // the reply alone cannot tell an overtaken pass from a clean one.
        overtaken: out.overtaken,
        pastDeadline: out.pastDeadline,
        spoke,
        writes,
      },
      '[calc-prefill] pass finished',
    );
  } catch (err) {
    logger.error({ err, requestId }, '[calc-prefill] pass failed — the VED still has the job');
    // …and the seller is told so, rather than waiting for a figure that
    // will not come — unless a message for this request already went out.
    // Best-effort: the drain may be what failed.
    try {
      const { sayOnce } = await import('./say-once');
      await sayOnce(requestId, { userIds: [staffId], type: 'CalcPrefilled', text: writes ? PASS_FAILED : TARIFF_PASS_FAILED });
    } catch {
      /* the log line above is the record */
    }
  }
}

/**
 * The AI-VED's own answer, on the card where the job lives (his answer 2a).
 *
 * Written as a SYSTEM note — `crm_activities.created_by` has been nullable
 * since 0066 and the lenta renders a null-author note — because nobody typed
 * it. Under the machine's own idiom (`actorId: null`, `system: true`), the
 * same one the stale-lead sweep and the advert intake use.
 */
async function writeReplyToLenta(requestId: string, text: string): Promise<void> {
  const { getSetting } = await import('@/modules/platform/settings/service');
  if (!(await getSetting('ai_calc_reply_lenta'))) return;
  const { db } = await import('@/modules/platform/db/client');
  const { calcRequests } = await import('@/modules/platform/db/schema');
  const { eq } = await import('drizzle-orm');
  const [row] = await db
    .select({ entityType: calcRequests.entityType, entityId: calcRequests.entityId })
    .from(calcRequests)
    .where(eq(calcRequests.id, requestId));
  if (!row) return;
  const { addActivity } = await import('@/modules/wms/crm/service');
  await addActivity(
    {
      entityType: row.entityType as 'deal' | 'lead',
      entityId: row.entityId,
      kind: 'note',
      note: text,
    },
    { actorId: null },
    { system: true },
  );
}
