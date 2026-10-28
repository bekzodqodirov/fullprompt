import type PgBoss from 'pg-boss';
import { createHash, randomUUID } from 'node:crypto';
import { logger } from '../logger';
import { enqueue, jobState, type JobState } from '../jobs/boss';
import {
  analyzeCollected,
  answeredRoute,
  mergeLineAnswers,
  mergeTotalsAnswer,
  sameRouteAnswer,
  sameTotalsAnswer,
  unansweredAmbiguity,
  type InlineKeyboard,
  type IntakeState,
} from './calc-intake';
import {
  activeIntake,
  durableIntakes,
  flushIntakeWrites,
  loadIntake,
  noteOwnMessage,
  updateIntake,
} from './calc-store';
import { loadIntakeFiles, invoiceChoiceKeyboard, otherFilesKeyboard } from './calc-files';
import { intakeLaws, intakeNextStep, type CollectorReply } from './calc-dialog';
import { CLIENT_QUESTION, doneKeyboard, pricedZonesNow, zoneKeyboard } from './calc-keyboards';
import { editText, sendText, sendTextBriefRetry, type SendResult } from './send';

/**
 * The reading — «✅ Bo‘ldi», the model's pass over what was collected, and
 * where its answer lands (docs/SAKKIZ-R3.md §7, P2).
 *
 * The press only ENQUEUES: the reading is a pg-boss job on its own queue, so a
 * deploy in the middle of it re-delivers the job instead of losing the
 * seller's «⏳» for ever (the in-process `void` it replaces died with the
 * container), and nothing about it ever waits on grammy's sequential poller
 * (#706). The job reads the stored files, calls the model, settles against
 * the LIVE collection, stores its reply in the collection and only then sends
 * it — all under one wall clock that ends before pg-boss's expiry, because
 * pg-boss 10 RACES a handler against `expireInSeconds` and retries the job
 * while the loser keeps running: without the clock a slow MinIO or a slow
 * delivery made a second paid model call on the same token.
 */

/** pg-boss's leash on one attempt — never its fifteen-minute default. */
export const INTAKE_READ_EXPIRE_S = 300;
/** Retries after the first attempt; the last one says «bo‘lmadi» itself. */
export const INTAKE_READ_RETRY = 2;
/**
 * Readings at once in this process. pg-boss 10's worker is a serial loop, so
 * the fifth seller pressing «Bo‘ldi» within one reading's time waits — the
 * unbounded `void` this replaces had no such bound at all. Each worker is one
 * fetch every two seconds on pg-boss's own pool.
 */
export const INTAKE_READ_WORKERS = 4;
/** Every storage read of one reading together (`readWithin` each, the sum capped). */
export const INTAKE_FILES_BUDGET_MS = 30_000;
/**
 * The delivery after the model: one send at 10 s, its HTML→plain and keyboard
 * fallbacks at 10 s each, one brief 429 wait of at most 5 s — and the same
 * once more.
 */
export const INTAKE_DELIVERY_RESERVE_MS = 70_000;
/** The book's laws, the settle's flush and the bill. */
export const INTAKE_STEP_SLACK_MS = 30_000;
/**
 * How long a job fetched in the boot window waits for this process to hydrate
 * the collections (durability-9) — normally milliseconds. The store reads its
 * own wait (P1, `loadIntake`); this is the figure the sum below is pinned on.
 */
export const INTAKE_HYDRATE_WAIT_MS = 10_000;
/**
 * A token older than this is taken over by the next press. Only a backstop:
 * the sweep releases a dead job's token by its pg-boss state long before. The
 * last 300 s are the queue's wait, because `analysingAt` is the PRESS's time.
 */
export const ANALYSIS_STALE_MS = (INTAKE_READ_EXPIRE_S * (INTAKE_READ_RETRY + 1) + 120 + 300) * 1000;
/** Under this much model time left the model is not called at all: the reading settles as «timeout». */
export const INTAKE_MIN_LEASH_MS = 30_000;
/** The handler's own margin before pg-boss's expiry. */
const DEADLINE_MARGIN_MS = 10_000;
/** One send of the stored reply (send.ts's default is 20 s). */
const DELIVERY_SEND_MS = 10_000;
/** A press's job may not have reached pg-boss yet: «no such job» this young is not «dead». */
const ENQUEUE_GRACE_MS = 60_000;

/** The pg-boss states in which a job will still run. */
const ALIVE: ReadonlySet<JobState> = new Set<JobState>(['created', 'retry', 'active']);

/** §2.6's words. */
const READING = {
  notice: '⏳ AI o‘qiyapti… (3 daqiqagacha)',
  live: '⏳ Tahlil davom etmoqda — natijani kuting.',
  queueRefused: 'Tahlilni boshlab bo‘lmadi — «Bo‘ldi» ni qayta bosing.',
  failed: 'Tahlil qilib bo‘lmadi. «Bo‘ldi» ni qayta bosing.',
  delivered: '✅ O‘qildi — natija pastda ⬇️',
} as const;

const arrivedWords = (n: number) =>
  `Tahlil paytida yana ${n} ta xabar/fayl keldi — ular hali o‘qilmagan.\n` +
  'Hammasini birga o‘qish uchun «Bo‘ldi» ni yana bosing.';

/** Is the collection's reading still running (or about to), by the press's own clock? */
function readingLive(state: IntakeState, now: number): boolean {
  return state.analysing !== null && state.analysingAt !== null && now - state.analysingAt <= ANALYSIS_STALE_MS;
}

/**
 * «✅ Bo‘ldi — tahlil qil» / «🔄 AI qayta o‘qisin»: the guards, the token, the
 * notice — and the job, enqueued. The model is NEVER called here.
 */
export async function pressAnalyse(ctx: CollectorReply, chatId: bigint, state: IntakeState): Promise<void> {
  // One reading at a time: a second press used to start a second paid call
  // whose result overwrote the first (cause 7). A token past its staleness —
  // a job that died where no sweep saw it — is taken over, never obeyed for
  // ever.
  if (readingLive(state, Date.now())) {
    await ctx.reply(READING.live);
    return;
  }
  if (state.stage === 'client' || state.stage === 'section') {
    await ctx.reply(
      state.stage === 'client' ? CLIENT_QUESTION : 'Avval yuk qayerdan chiqishini tanlang.',
      state.stage === 'client' ? { parse_mode: 'Markdown' } : { reply_markup: zoneKeyboard(await pricedZonesNow()) },
    );
    return;
  }
  if (state.pendingInvoice) {
    await ctx.reply('Avval ikkinchi fayl haqida javob bering:', { reply_markup: invoiceChoiceKeyboard() });
    return;
  }
  if (state.aiGoods === 'ask') {
    await ctx.reply('Avval javob bering: AI o‘qiydigan fayl — boshqa zavodning tovarlarimi?', {
      reply_markup: otherFilesKeyboard(),
    });
    return;
  }
  if (state.material.length === 0 && state.fileCount === 0) {
    await ctx.reply('Hali hech narsa yuborilmadi.');
    return;
  }
  const token = randomUUID();
  const jobId = randomUUID();
  // A seller's press (it slides the clock). A reply an earlier reading stored
  // and never got out is dropped: this reading answers for the same material
  // and more, and the stale one must not land after it.
  updateIntake(chatId, {
    analysing: token,
    analysingAt: Date.now(),
    analysingJob: jobId,
    readingSaidDead: false,
    pendingReply: null,
  });
  // The notice must not decide whether the reading runs (round-1 review, c3):
  // a refused notice — a 429 past the brief retry, a blip to api.telegram.org —
  // used to throw before the dispatch and strand the token.
  const notice = await ctx.reply(READING.notice).catch((err: unknown) => {
    logger.warn({ err }, '[calc-intake] analysing notice not sent');
    return null;
  });
  if (notice) noteOwnMessage(chatId, notice.message_id);
  // This chat's write only (performance-10): the token is in the row BEFORE
  // the job can exist, so a job redelivered to a new process finds it.
  await flushIntakeWrites(chatId);
  try {
    await enqueue<IntakeReadJob>(
      JOB_CALC_INTAKE_READ,
      { chatId: String(chatId), noteId: state.noteId, token, noticeMessageId: notice?.message_id ?? null },
      { id: jobId, expireInSeconds: INTAKE_READ_EXPIRE_S, retryLimit: INTAKE_READ_RETRY },
    );
  } catch (err) {
    // Released, or every later press says «Tahlil davom etmoqda» about a
    // reading that never started (round-1 review c3's stranded lock).
    logger.error({ err }, '[calc-intake] reading not enqueued');
    const live = activeIntake(chatId);
    if (live?.analysing === token) {
      updateIntake(chatId, { analysing: null, analysingAt: null, analysingJob: null }, { quiet: true });
    }
    await ctx.reply(READING.queueRefused, { reply_markup: doneKeyboard }).catch(() => {});
  }
}

/**
 * Where an analysis lands (the diagnosis' cause 7). Pure, so the race is
 * tested without a bot.
 *
 *  - `gone`: the collection was cancelled, restarted (a new note id), or a
 *    newer analysis owns it — the result is thrown away, never written back
 *    over somebody's fresh start;
 *  - `arrived`: messages or files came in while it ran — the reading is kept
 *    for its facts, but the LIVE material stays and the seller is asked to
 *    press «Bo'ldi» again, so nothing the bot answered «Qabul qilindi» to is
 *    erased or left unread;
 *  - `done`: the result replaces the facts, and everything else is the live
 *    collection's own.
 */
export function settleAnalysis(
  live: IntakeState | null,
  snapshot: IntakeState,
  analysed: IntakeState,
  token: string,
):
  | { kind: 'gone' }
  | { kind: 'arrived'; state: IntakeState; arrived: number }
  | { kind: 'done'; state: IntakeState } {
  if (!live || live.noteId !== snapshot.noteId || live.analysing !== token) return { kind: 'gone' };
  const arrived =
    live.material.length - snapshot.material.length + (live.fileCount - snapshot.fileCount);
  // A totals answer typed WHILE the reading ran is newer than everything the
  // reading saw, and goes on top (judge concurrency-4). Otherwise the
  // reading's own verdict on the answer stands — re-merging the snapshot's
  // answer here would put back a figure the reading held open because later
  // material doubts it (review CONC-2).
  const answeredMeanwhile = !sameTotalsAnswer(live.totalsAnswer, snapshot.totalsAnswer);
  // The route answer by the same rule (docs/SAKKIZ-R3.md K15): only a route
  // answered WHILE the reading ran goes on top; otherwise the reading's own
  // verdict on the answer stands.
  const routeMeanwhile = !sameRouteAnswer(live.routeAnswer, snapshot.routeAnswer);
  const facts = {
    ...analysed.facts,
    ...(routeMeanwhile ? answeredRoute(live.routeAnswer, null) : {}),
    goods: mergeLineAnswers(analysed.facts.goods ?? [], live.lineAnswers),
  };
  const state: IntakeState = {
    ...live,
    // The LIVE answers go back on top (round-1 review, c2): the reading was
    // merged with the SNAPSHOT's answers, and a line answered while it ran —
    // into `answers`, not material, so nothing counts it as «arrived» —
    // landed without its figure. Re-applying an answer the snapshot already
    // had is idempotent, so both outcomes take the same merge.
    //
    // The live totals answer too, when it is new (above); `totalsAsked` is
    // the reading's own verdict over it.
    facts: answeredMeanwhile ? mergeTotalsAnswer(live.totalsAnswer, facts) : facts,
    totalsAsked: analysed.totalsAsked,
    steps: analysed.steps,
    notes: analysed.notes,
    aiUsed: analysed.aiUsed,
    aiFailure: analysed.aiFailure,
    // The reading's bill is no longer carried here: the job writes it to the
    // ledger the moment the model answered (§7.2.10), so the collection's
    // own count would bill it twice.
    // The reading's two-way totals, less what the seller answered while it
    // ran — the live answer above is on the facts (review P3-3).
    ambiguousTotals: answeredMeanwhile
      ? unansweredAmbiguity(analysed.ambiguousTotals, live.totalsAnswer)
      : analysed.ambiguousTotals,
    analysing: null,
    stage: arrived > 0 ? 'material' : 'review',
  };
  return arrived > 0 ? { kind: 'arrived', state, arrived } : { kind: 'done', state };
}

/** The reading as a pg-boss job (P2). */
export const JOB_CALC_INTAKE_READ = 'calc.intake-read';

export interface IntakeReadJob {
  chatId: string;
  noteId: string;
  token: string;
  noticeMessageId: number | null;
  /** A follow-up that only sends the stored reply (a flood wait, durability-16). */
  deliverOnly?: boolean;
}

/**
 * The tokens whose run is in flight in THIS process. pg-boss fails an attempt
 * that outlives its expiry and hands the retry to the next free worker while
 * the first one is still running — the retry carries the same token, and
 * without this it called the paid model a second time. The first run
 * delivers. On `globalThis` like the store, so every chunk shares one set.
 */
const globalForRead = globalThis as unknown as { calcIntakeReads?: Set<string> };
const inFlight = (globalForRead.calcIntakeReads ??= new Set<string>());

/** Thrown when this process may not send what it stored: the store did not take it. */
class ReplyNotStored extends Error {
  constructor() {
    super('calc intake reply not stored');
    this.name = 'ReplyNotStored';
  }
}

/** Thrown for a delivery worth one more attempt (5xx, the network, a dead token). */
class DeliveryFailed extends Error {
  constructor(result: SendResult) {
    super(`calc intake reply not delivered: ${result.status} ${result.description}`);
    this.name = 'DeliveryFailed';
  }
}

/**
 * One reading job (§7.2.4). `retryCount` is pg-boss's (`includeMetadata`):
 * the last attempt answers the seller itself and never rethrows, the earlier
 * ones rethrow so pg-boss retries.
 */
export async function runIntakeRead(data: IntakeReadJob, retryCount: number): Promise<void> {
  // A delivery-only follow-up shares the token with its reading, and must not
  // be turned away by it: it is a second, smaller job about the same reply.
  const fence = data.deliverOnly ? `${data.token}:deliver` : data.token;
  if (inFlight.has(fence)) return;
  inFlight.add(fence);
  try {
    await readOnce(data);
  } catch (err) {
    if (retryCount < INTAKE_READ_RETRY) {
      logger.warn({ err, chatId: data.chatId, retryCount }, '[calc-intake] reading failed — will retry');
      throw err;
    }
    logger.error({ err, chatId: data.chatId, retryCount }, '[calc-intake] reading failed for the last time');
    await lastAttemptFailed(data);
  } finally {
    inFlight.delete(fence);
  }
}

async function readOnce(data: IntakeReadJob): Promise<void> {
  const start = Date.now();
  const deadline = start + INTAKE_READ_EXPIRE_S * 1000 - DEADLINE_MARGIN_MS;
  const chatId = BigInt(data.chatId);
  // Waits for this process's hydrate and throws `IntakesNotReady` when it does
  // not come: pg-boss re-delivers rather than completing on an empty memory.
  const state = await loadIntake(chatId);
  if (!state || state.noteId !== data.noteId) return;
  if (data.deliverOnly || state.analysing !== data.token) {
    // An earlier attempt settled and stored its reply: send THAT, and never
    // ask the model again for it. Anything else — a newer press, a cancel —
    // is not this job's any more.
    if (state.pendingReply?.token === data.token) await deliver(chatId, state.pendingReply, data);
    return;
  }

  // Each storage read is bounded and the whole set capped (#915: a dead
  // stream is a hang); what does not come in time is counted and SAID by
  // the reading's notes (`filesMissingNote`).
  const files = await loadIntakeFiles(state, { deadline: Date.now() + INTAKE_FILES_BUDGET_MS });
  const { INTAKE_TIMEOUT_MS } = await import('../../wms/calc/intake-ai');
  const leash = Math.min(INTAKE_TIMEOUT_MS, deadline - Date.now() - INTAKE_DELIVERY_RESERVE_MS);
  // Too little left to read well: the model is not called (a leash of nothing
  // is no call) and the reading settles as R1's «timeout», in words.
  const analysed = await analyzeCollected(state, files, { timeoutMs: leash < INTAKE_MIN_LEASH_MS ? 0 : leash });

  // Billed NOW, the day the model answered (concurrency-11), on the
  // collection's note — a collection abandoned after this point is still
  // counted against the day's budget. Each row in its own try: bookkeeping
  // never stands in front of the work.
  const { recordAiPass } = await import('../../wms/calc/ai-cost');
  for (const u of analysed.answered) {
    try {
      await recordAiPass({
        kind: 'intake',
        requestId: state.amend?.requestId ?? null,
        intakeNoteId: state.noteId,
        staffId: state.staffId,
        model: u.model,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        // `at` is when the model answered; a reading that carries none is
        // billed now rather than lost to an unreadable date.
        createdAt: Number.isFinite(u.at) ? new Date(u.at) : null,
      });
    } catch (err) {
      logger.warn({ err, noteId: state.noteId }, '[calc-intake] reading not billed');
    }
  }

  // The laws on the pool BEFORE the live collection is taken: from here to the
  // store's write nothing is awaited, so no press can land in between and the
  // words stored are the words of the state stored (K's review, U4).
  const laws = await intakeLaws(analysed);
  const intake = await import('../../wms/calc/intake');
  const outcome = settleAnalysis(activeIntake(chatId), state, analysed, data.token);
  if (outcome.kind === 'gone') return;
  let patch: Partial<IntakeState>;
  let text: string;
  let keyboard: InlineKeyboard | null;
  if (outcome.kind === 'arrived') {
    patch = outcome.state;
    text = arrivedWords(outcome.arrived);
    keyboard = doneKeyboard;
  } else {
    // No keyboard is built here: the step's own (the derived `c:` fence reads
    // every button where it is built).
    const step = intakeNextStep(outcome.state, laws, intake);
    patch = { ...outcome.state, ...step.patch };
    text = step.text;
    keyboard = step.keyboard;
  }
  const pendingReply = { token: data.token, text, keyboard, at: Date.now(), jobId: null };
  updateIntake(chatId, { ...patch, pendingReply }, { quiet: true });
  if (Date.now() > deadline) logger.warn({ chatId: data.chatId }, '[calc-intake] reading past its own deadline');
  await deliver(chatId, pendingReply, data);
}

/**
 * Send a stored reply (§7.2.4 step 7), bounded. Sent → it leaves the store and
 * the notice points down; refused for good → dropped; a long flood wait → one
 * delivery-only follow-up at Telegram's own `retry_after` (no retry is spent
 * inside one flood wait — pg-boss's doubling backoff would have spent all of
 * them in ten seconds and the last would say «bo‘lmadi» about a reading that
 * worked); anything else → thrown, and the retry sends the STORED text without
 * a model call.
 */
async function deliver(
  chatId: bigint,
  reply: NonNullable<IntakeState['pendingReply']>,
  data: IntakeReadJob,
): Promise<void> {
  // Sent only from a DURABLE reply: a stop that sealed the store, or a write
  // that failed, would otherwise send the table now and the redelivery in the
  // next process — which hydrated the row from before the settle — would read
  // and send it a second time. The one flush, so the settle and every later
  // delivery of the same reply ask the same question.
  if (durableIntakes() && !(await flushIntakeWrites(chatId))) throw new ReplyNotStored();
  const sent = await sendTextBriefRetry({
    chatId,
    text: reply.text,
    ...(reply.keyboard ? { replyMarkup: reply.keyboard } : {}),
    timeoutMs: DELIVERY_SEND_MS,
  });
  if (sent.ok) {
    settleDelivered(chatId, reply, sent.messageId);
    if (data.noticeMessageId !== null) {
      // HTML-only (send.ts), and the sentence holds no markup character.
      void editText({ chatId, messageId: data.noticeMessageId, html: READING.delivered }).catch(() => {});
    }
    return;
  }
  if (sent.status === 400 || sent.status === 403) {
    // The chat refused it for good (the bot blocked, the chat gone): nothing
    // will ever send it, and the collection must not keep a reply for ever.
    logger.warn({ chatId: String(chatId), status: sent.status, description: sent.description }, '[calc-intake] reading reply refused');
    clearPending(chatId, reply.token);
    return;
  }
  if (sent.status === 429 && sent.retryAfter !== null) {
    const followId = randomUUID();
    try {
      await enqueue<IntakeReadJob>(
        JOB_CALC_INTAKE_READ,
        { ...data, deliverOnly: true },
        {
          id: followId,
          startAfter: sent.retryAfter + 1,
          expireInSeconds: INTAKE_READ_EXPIRE_S,
          retryLimit: INTAKE_READ_RETRY,
        },
      );
      const live = activeIntake(chatId);
      if (live?.pendingReply?.token === reply.token) {
        updateIntake(chatId, { pendingReply: { ...live.pendingReply, jobId: followId } }, { quiet: true });
      }
    } catch (err) {
      // No follow-up: the stored reply waits for the sweep's `deliver_pending`.
      logger.warn({ err, chatId: String(chatId) }, '[calc-intake] delivery follow-up not enqueued');
    }
    return;
  }
  throw new DeliveryFailed(sent);
}

/** The reply went out: off the store, and the table remembered for every later edit. */
function settleDelivered(chatId: bigint, reply: NonNullable<IntakeState['pendingReply']>, messageId: number | null): void {
  const live = activeIntake(chatId);
  if (!live) return;
  const ours = live.pendingReply?.token === reply.token;
  // Only a TABLE is edited in place by the answers that follow: the «arrived»
  // words leave the collection in `material`, and must never become the
  // message an answer rewrites.
  const table = messageId !== null && live.stage === 'review';
  updateIntake(
    chatId,
    {
      ...(ours ? { pendingReply: null } : {}),
      ...(table ? { tableMessageId: messageId, tableHash: replyHash(reply) } : {}),
    },
    { quiet: true },
  );
  if (messageId !== null) noteOwnMessage(chatId, messageId);
}

/**
 * What a drawn table is compared by — its text AND its keyboard (a certificate
 * press changes only the button), the table edit's own rule (P3's
 * `tableHashOf`, calc-dialog.ts), so an answer that leaves the table as it was
 * edits nothing.
 */
function replyHash(reply: { text: string; keyboard: InlineKeyboard | null }): string {
  return createHash('sha1').update(reply.text).update(JSON.stringify(reply.keyboard)).digest('base64');
}

function clearPending(chatId: bigint, token: string): void {
  const live = activeIntake(chatId);
  if (live?.pendingReply?.token === token) updateIntake(chatId, { pendingReply: null }, { quiet: true });
}

/**
 * The last attempt failed (§7.2.4 step 8). A reply stored for this token means
 * the READING worked and only its delivery did not — that is said by nobody:
 * the sweep's `deliver_pending` sends it late, never «bo‘lmadi» about a table
 * that exists. Otherwise the token is released (if still ours) and the seller
 * told once. Never rethrows.
 */
async function lastAttemptFailed(data: IntakeReadJob): Promise<void> {
  const chatId = BigInt(data.chatId);
  // Not hydrated even now: there is nothing here to release, and the sweep
  // says it once the collection is back.
  const live = activeIntake(chatId);
  if (!live || live.noteId !== data.noteId) return;
  if (live.pendingReply?.token === data.token) return;
  if (data.deliverOnly || live.analysing !== data.token) return;
  await saidDead(chatId, live);
}

/** Release a reading's token and say «Tahlil qilib bo‘lmadi …» — once per token. */
async function saidDead(chatId: bigint, state: IntakeState): Promise<void> {
  updateIntake(
    chatId,
    { analysing: null, analysingAt: null, analysingJob: null, stage: 'material', readingSaidDead: true },
    { quiet: true },
  );
  if (state.readingSaidDead) return;
  const said = await sendText({ chatId, text: READING.failed, replyMarkup: doneKeyboard });
  if (said.ok && said.messageId !== null) noteOwnMessage(chatId, said.messageId);
  else logger.warn({ chatId: String(chatId), status: said.status }, '[calc-intake] «bo‘lmadi» not sent');
}

/**
 * The reading's queue and its workers (boss.ts registers it). Four `work`
 * calls — pg-boss 10's worker is one serial loop — each with `batchSize` 1
 * (pg-boss fails a whole batch for one job's error) and `includeMetadata`, or
 * the handler cannot know its last attempt.
 */
export async function registerCalcIntakeReadWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_CALC_INTAKE_READ);
  for (let i = 0; i < INTAKE_READ_WORKERS; i += 1) {
    await boss.work<IntakeReadJob>(JOB_CALC_INTAKE_READ, { includeMetadata: true }, async (jobs) => {
      for (const job of jobs) await runIntakeRead(job.data, job.retryCount ?? 0);
    });
  }
}

/**
 * A named job's liveness: its pg-boss state, `null` when there is no such job.
 * A database blip answers «alive» — the sweep must never release on a blip.
 */
async function jobLife(id: string): Promise<'alive' | 'dead' | 'missing'> {
  try {
    const state = await jobState(JOB_CALC_INTAKE_READ, id);
    if (state === null) return 'missing';
    return ALIVE.has(state) ? 'alive' : 'dead';
  } catch (err) {
    logger.warn({ err, id }, '[calc-intake] reading job state unreadable — taken as alive');
    return 'alive';
  }
}

/**
 * For the sweep: is this collection's reading alive — its pg-boss job not
 * terminal? A press younger than a minute counts as alive even with no job
 * yet (its enqueue may still be on the way); a token with no job id at all is
 * judged by the press's own staleness.
 */
export async function readingAlive(state: IntakeState): Promise<boolean> {
  if (state.analysing === null) return false;
  const age = state.analysingAt === null ? Number.POSITIVE_INFINITY : Date.now() - state.analysingAt;
  if (state.analysingJob === null) return age <= ANALYSIS_STALE_MS;
  const life = await jobLife(state.analysingJob);
  return life === 'alive' || (life === 'missing' && age < ENQUEUE_GRACE_MS);
}

/**
 * For the sweep: release a dead reading's token and say «Tahlil qilib
 * bo‘lmadi…» once (`readingSaidDead`). Only the token it was handed: a newer
 * press's reading is not this one's to end.
 */
export async function releaseDeadReading(chatId: bigint, state: IntakeState): Promise<void> {
  const live = activeIntake(chatId);
  if (!live || live.noteId !== state.noteId || live.analysing === null || live.analysing !== state.analysing) return;
  // A reading that succeeded and only waits for its delivery is never «dead».
  if (live.pendingReply?.token === live.analysing) return;
  await saidDead(chatId, live);
}

/**
 * For the sweep: send a stored `pendingReply` whose delivery never happened (a
 * flood wait outlived the job's retries, durability-16), bounded like the
 * job's own delivery — the reading itself is never re-run for it.
 */
export async function deliverStoredReply(chatId: bigint, state: IntakeState): Promise<void> {
  const live = activeIntake(chatId);
  const reply = live?.pendingReply;
  if (!live || !reply || live.noteId !== state.noteId) return;
  await deliver(chatId, reply, { chatId: String(chatId), noteId: live.noteId, token: reply.token, noticeMessageId: null });
}

/** For the sweep: is a delivery-only follow-up of this stored reply alive? */
export async function pendingDeliveryAlive(state: IntakeState): Promise<boolean> {
  const jobId = state.pendingReply?.jobId ?? null;
  return jobId !== null && (await jobLife(jobId)) === 'alive';
}
