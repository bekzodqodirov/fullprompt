import type PgBoss from 'pg-boss';
import { randomUUID } from 'node:crypto';
import { logger } from '../logger';
import { enqueue, jobState, type JobState } from '../jobs/boss';
import {
  analyzeCollected,
  answeredRoute,
  mergeTotalsAnswer,
  placeByName,
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
import { intakeNextStep, tableContext, tableHashOf, type CollectorReply } from './calc-dialog';
import { CLIENT_QUESTION, doneKeyboard, pricedZonesNow, zoneKeyboard } from './calc-keyboards';
import { isStopping } from './lifecycle';
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
 * the collections (durability-9) — normally milliseconds. ONE home, the
 * store's (`loadIntake` waits it, #513): re-exported here so the job's time
 * sum is pinned on the figure the store actually waits.
 */
export { INTAKE_HYDRATE_WAIT_MS } from './calc-store';
/**
 * A token older than this is taken over by the next press. Only a backstop:
 * the sweep releases a dead job's token by its pg-boss state long before. The
 * last 300 s are the queue's wait, because `analysingAt` is the press's time
 * (re-stamped once its notice is out, a few seconds later at most).
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
/** How often an attempt a stopping process holds open looks at the clock. */
const HAND_ON_TICK_MS = 1_000;

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

const ARRIVED_LEAD = 'Tahlil paytida yana ';
const arrivedWords = (n: number) =>
  `${ARRIVED_LEAD}${n} ta xabar/fayl keldi — ular hali o‘qilmagan.\n` +
  'Hammasini birga o‘qish uchun «Bo‘ldi» ni yana bosing.';

/**
 * Is this stored reply the «arrived» words rather than a reading's table?
 * Decided by what was STORED (reviews spec-4, adv-6), never by the stage at
 * delivery: the seller may type between the settle and the send.
 */
function isArrivedReply(reply: { text: string }): boolean {
  return reply.text.startsWith(ARRIVED_LEAD);
}

/** Telegram refusing the CHAT, not our message: the bot blocked, the chat gone. */
const CHAT_GONE = /chat not found|bot was blocked|bot was kicked|user is deactivated|have no rights|not enough rights|CHAT_WRITE_FORBIDDEN|PEER_ID_INVALID/i;

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
    await sayOwn(ctx, chatId, 'Avval ikkinchi fayl haqida javob bering:', { reply_markup: invoiceChoiceKeyboard() });
    return;
  }
  if (state.aiGoods === 'ask') {
    await sayOwn(ctx, chatId, 'Avval javob bering: AI o‘qiydigan fayl — boshqa zavodning tovarlarimi?', {
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
  // and more, and the stale one must not land after it. No job id yet — and
  // never the previous reading's, which the sweep would find finished.
  updateIntake(chatId, {
    analysing: token,
    analysingAt: Date.now(),
    analysingJob: null,
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
  // Cancelled, or ended, while the notice went out: nothing left to read.
  if (activeIntake(chatId)?.analysing !== token) return;
  // The job's id — and the clock its minute of grace runs on — only now
  // (review adv-14): grammy's send has no short deadline, and a notice that
  // hung past that minute with the id already stored read to the sweep as «no
  // such job, a minute old», i.e. dead, and released a press whose job was
  // never enqueued. Until here the token is judged by its staleness alone.
  updateIntake(chatId, { analysingAt: Date.now(), analysingJob: jobId }, { quiet: true });
  // This chat's write only (performance-10), and its answer is OBEYED (review
  // adv-10): the token must be in the row before the job can exist, or a job
  // redelivered to a new process finds no token and returns in silence under
  // a «⏳» nobody will ever answer. Sealed by a stop, or a write that failed:
  // refused here, in words, and the seller presses again.
  if (!(await flushIntakeWrites(chatId))) {
    logger.warn({ chatId: String(chatId) }, '[calc-intake] reading not started — the collection is not written');
    await refuseStart(ctx, chatId, token);
    return;
  }
  try {
    await enqueue<IntakeReadJob>(
      JOB_CALC_INTAKE_READ,
      { chatId: String(chatId), noteId: state.noteId, token, noticeMessageId: notice?.message_id ?? null },
      { id: jobId, expireInSeconds: INTAKE_READ_EXPIRE_S, retryLimit: INTAKE_READ_RETRY },
    );
  } catch (err) {
    logger.error({ err }, '[calc-intake] reading not enqueued');
    await refuseStart(ctx, chatId, token);
  }
}

/**
 * The reading could not be started: the token released — or every later press
 * says «Tahlil davom etmoqda» about a reading that never started (round-1
 * review c3's stranded lock) — and the seller told, under a «Bo‘ldi» of his own.
 */
async function refuseStart(ctx: CollectorReply, chatId: bigint, token: string): Promise<void> {
  if (activeIntake(chatId)?.analysing === token) {
    updateIntake(chatId, { analysing: null, analysingAt: null, analysingJob: null }, { quiet: true });
  }
  await sayOwn(ctx, chatId, READING.queueRefused, { reply_markup: doneKeyboard });
}

/**
 * A message whose buttons the dispatcher judges by `ownsPress` («Bo‘ldi»,
 * the invoice and other-files choices): it joins `ownMessageIds`, or every
 * button on it answers «Bu tugma eskirgan.» under the very sentence that asked
 * for the press (review adv-1). A refused send is logged, never thrown.
 */
async function sayOwn(ctx: CollectorReply, chatId: bigint, text: string, extra: Record<string, unknown>): Promise<void> {
  const sent = await ctx.reply(text, extra).catch((err: unknown) => {
    logger.warn({ err, chatId: String(chatId) }, '[calc-intake] reading answer not sent');
    return null;
  });
  if (sent) noteOwnMessage(chatId, sent.message_id);
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
  // The LIVE answers are placed on the reading, and where each landed is what
  // the collection keeps (`placeByName`'s write-back, docs/SAKKIZ-R3.md
  // §8.2.8): stored at the snapshot's old index, an answer re-read onto
  // another line was overwritten by the next answer to the line now there.
  const placed = placeByName(analysed.facts.goods ?? [], live.lineAnswers);
  const facts = {
    ...analysed.facts,
    ...(routeMeanwhile ? answeredRoute(live.routeAnswer, null) : {}),
    goods: placed.goods,
  };
  const state: IntakeState = {
    ...live,
    // The LIVE answers go back on top (round-1 review, c2): the reading was
    // merged with the SNAPSHOT's answers, and a line answered while it ran —
    // into `answers`, not material, so nothing counts it as «arrived» —
    // landed without its figure. Re-applying an answer the snapshot already
    // had is idempotent, so both outcomes take the same merge.
    //
    // The live totals answer too, when it is new (above).
    facts: answeredMeanwhile ? mergeTotalsAnswer(live.totalsAnswer, facts) : facts,
    lineAnswers: placed.entries,
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

/** A delivery-only follow-up's own fence: a second, smaller job about the same reply. */
const deliverFence = (token: string) => `${token}:deliver`;

/** Is a reading or a delivery of this token running in THIS process right now? */
function runningHere(token: string): boolean {
  return inFlight.has(token) || inFlight.has(deliverFence(token));
}

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

/** Thrown at the handler's deadline by an attempt a stopping process held open, and outlived. */
class HandedOn extends Error {
  constructor() {
    super('calc intake reading handed on — this process is stopping');
    this.name = 'HandedOn';
  }
}

/**
 * A process that is stopping neither pays for a reading nor sends one (review
 * adv-3): the attempt is held OPEN until the handler's own deadline. Thrown at
 * once, it was retried within seconds by this same dying process — its four
 * workers poll every two — and the retries were spent where nothing could be
 * stored; the last one then completed the job in silence, and the next
 * process's sweep said «bo‘lmadi» about a reading that had worked. Held, it
 * dies with the process, and pg-boss's expiry hands it to the next one, which
 * reads the collection from the durable row. The clock is looked at every
 * second, so a test's moved clock ends it.
 */
async function handOn(deadline: number): Promise<never> {
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(HAND_ON_TICK_MS, deadline - Date.now())));
  }
  throw new HandedOn();
}

/**
 * One reading job (§7.2.4). `retryCount` is pg-boss's (`includeMetadata`):
 * the last attempt answers the seller itself and never rethrows, the earlier
 * ones rethrow so pg-boss retries.
 */
export async function runIntakeRead(data: IntakeReadJob, retryCount: number): Promise<void> {
  // A delivery-only follow-up shares the token with its reading, and must not
  // be turned away by it: it is a second, smaller job about the same reply.
  const fence = data.deliverOnly ? deliverFence(data.token) : data.token;
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
  // An earlier attempt settled and stored its reply: send THAT, and never ask
  // the model again for it.
  if (state.pendingReply?.token === data.token) {
    await deliver(chatId, state.pendingReply, data, deadline);
    return;
  }
  // Anything else — a newer press, a cancel, a reply already out — is not
  // this job's any more.
  if (data.deliverOnly || state.analysing !== data.token) return;

  // Each storage read is bounded and the whole set capped (#915: a dead
  // stream is a hang); what does not come in time is counted and SAID by
  // the reading's notes (`filesMissingNote`).
  const files = await loadIntakeFiles(state, { deadline: Date.now() + INTAKE_FILES_BUDGET_MS });
  // Never a model call by a process that is going away (review adv-3): its
  // answer could not be stored, and the next process reads again anyway.
  if (isStopping()) return handOn(deadline);
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

  // From the answer to the stored reply every step is deterministic — the
  // laws read catches its own errors, the rest is pure or memory — so a throw
  // here would throw the same way on every retry, and each retry would pay for
  // the same answer again (review adv-12). It is the reading's end, said once.
  let pendingReply: NonNullable<IntakeState['pendingReply']>;
  try {
    // The laws on the pool BEFORE the live collection is taken: from here to
    // the store's write nothing is awaited, so no press can land in between
    // and the words stored are the words of the state stored (K's review, U4).
    // The table's own context (laws, the wms module, an addition's stale
    // totals): the table this job sends is the one every later edit redraws.
    const tc = await tableContext(analysed);
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
      const step = intakeNextStep(outcome.state, tc.laws, tc.intake, { stale: tc.stale });
      patch = { ...outcome.state, ...step.patch };
      text = step.text;
      keyboard = step.keyboard;
    }
    pendingReply = { token: data.token, text, keyboard, at: Date.now(), jobId: null, noticeMessageId: data.noticeMessageId };
    // The token is HELD until the reply is out (review adv-2): every door that
    // asks «is a reading running?» — «Tasdiqlash», ⏭, the certificate, a line
    // answer, the table's edit — asks `analysing`, and a reading stored but
    // not yet delivered (a flood wait, a retry, the sweep's late send) used to
    // read as finished: an older table's «Tasdiqlash» landed facts the seller
    // had never seen, and a certificate press drew a table the late send then
    // buried. It is released by the delivery, or by whatever ends the reply.
    updateIntake(chatId, { ...patch, analysing: data.token, pendingReply }, { quiet: true });
  } catch (err) {
    logger.error({ err, chatId: data.chatId }, '[calc-intake] reading answered but not settled');
    const live = activeIntake(chatId);
    if (live && live.noteId === data.noteId && live.analysing === data.token && live.pendingReply?.token !== data.token) {
      await saidDead(chatId, live, { notice: data.noticeMessageId, brief: true });
    }
    return;
  }
  if (Date.now() > deadline) logger.warn({ chatId: data.chatId }, '[calc-intake] reading past its own deadline');
  await deliver(chatId, pendingReply, data, deadline);
}

/**
 * Send a stored reply (§7.2.4 step 7), bounded. Sent → it leaves the store,
 * the token is released and the notice points down; the chat refused it for
 * good → dropped; Telegram refused the MESSAGE → the reading is said to have
 * failed; a long flood wait → one delivery-only follow-up at Telegram's own
 * `retry_after` (no retry is spent inside one flood wait — pg-boss's doubling
 * backoff would have spent all of them in ten seconds and the last would say
 * «bo‘lmadi» about a reading that worked); anything else → thrown, and the
 * retry sends the STORED text without a model call.
 */
async function deliver(
  chatId: bigint,
  reply: NonNullable<IntakeState['pendingReply']>,
  data: IntakeReadJob,
  deadline: number,
): Promise<void> {
  // Sent only from a DURABLE reply: a stop that sealed the store, or a write
  // that failed, would otherwise send the table now and the redelivery in the
  // next process — which hydrated the row from before the settle — would read
  // and send it a second time. The one flush, so the settle and every later
  // delivery of the same reply ask the same question.
  const durable = durableIntakes();
  const stored = !durable || (await flushIntakeWrites(chatId));
  // Stopping: written or not, nothing is sent from here — a reply sent after
  // the store is sealed would keep its `pendingReply` in the row, and the next
  // process would send it again. The attempt is handed on (review adv-3).
  if (durable && isStopping()) return handOn(deadline);
  if (!stored) throw new ReplyNotStored();
  // Still this collection's reply? A newer press dropped it during the flush
  // (review adv-6): sent now, it would land after the reading that replaced it.
  if (activeIntake(chatId)?.pendingReply?.token !== reply.token) return;
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
  if (sent.status === 403 || (sent.status === 400 && CHAT_GONE.test(sent.description))) {
    // The chat refused it for good (the bot blocked, the chat gone): nothing
    // will ever send it, and the collection must not keep a reply for ever.
    logger.warn({ chatId: String(chatId), status: sent.status, description: sent.description }, '[calc-intake] reading reply refused');
    clearPending(chatId, reply.token);
    return;
  }
  if (sent.status === 400) {
    // Telegram refused THIS message (too long, a shape it will not take), not
    // the chat: it will never go out as it is, and a seller left under «⏳»
    // would press «Bo‘ldi» into the same silence (review adv-8). The reading
    // is said to have failed, and the collection is back at its material.
    logger.warn({ chatId: String(chatId), description: sent.description }, '[calc-intake] reading reply refused as a message');
    const live = activeIntake(chatId);
    if (live?.pendingReply?.token === reply.token) {
      await saidDead(chatId, live, { notice: data.noticeMessageId, brief: true });
    }
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

/** The reply went out: off the store, the token released, and a table remembered for every later edit. */
function settleDelivered(chatId: bigint, reply: NonNullable<IntakeState['pendingReply']>, messageId: number | null): void {
  const live = activeIntake(chatId);
  if (!live) return;
  const ours = live.pendingReply?.token === reply.token;
  // Only a TABLE is edited in place by the answers that follow, and only the
  // collection's current one (reviews spec-4, adv-6): the «arrived» words
  // leave the collection in `material` and must never become the message an
  // answer rewrites, and a reply a newer press replaced is no table at all.
  // Decided by the reply as stored, not by the stage now — the seller may have
  // typed since, and a table did go out.
  const table = ours && messageId !== null && !isArrivedReply(reply);
  updateIntake(
    chatId,
    {
      ...(ours ? { pendingReply: null } : {}),
      ...(ours && live.analysing === reply.token ? { analysing: null } : {}),
      ...(table ? { tableMessageId: messageId, tableHash: tableHashOf(reply) } : {}),
    },
    { quiet: true },
  );
  if (messageId !== null) noteOwnMessage(chatId, messageId);
}

/** A reply nothing will ever send: dropped, and the token it held released. */
function clearPending(chatId: bigint, token: string): void {
  const live = activeIntake(chatId);
  if (live?.pendingReply?.token !== token) return;
  updateIntake(chatId, { pendingReply: null, ...(live.analysing === token ? { analysing: null } : {}) }, { quiet: true });
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
  await saidDead(chatId, live, { notice: data.noticeMessageId, brief: true });
}

/**
 * Release a reading's token and say «Tahlil qilib bo‘lmadi …» (§2.6).
 *
 * Said once because the patch clears the token BEFORE the send is awaited:
 * every caller — the last attempt, the settle that threw, a refused message,
 * the sweep — asks first whether the token is still the collection's, so none
 * reaches here twice for one token (review spec-3). `readingSaidDead` is a belt
 * for a row hydrated mid-way, not what makes it once.
 *
 * From a job (`brief`) the send waits out one short flood wait — the job may
 * sleep, the sweep may not — and a send that still fails turns the seller's
 * «⏳» notice into the sentence instead (review adv-7): the token is already
 * released, so nothing would ever say it again.
 */
async function saidDead(
  chatId: bigint,
  state: IntakeState,
  how: { notice: number | null; brief: boolean },
): Promise<void> {
  updateIntake(
    chatId,
    { analysing: null, analysingAt: null, analysingJob: null, stage: 'material', readingSaidDead: true, pendingReply: null },
    { quiet: true },
  );
  if (state.readingSaidDead) return;
  const msg = { chatId, text: READING.failed, replyMarkup: doneKeyboard };
  const said = how.brief ? await sendTextBriefRetry(msg) : await sendText(msg);
  if (said.ok) {
    if (said.messageId !== null) noteOwnMessage(chatId, said.messageId);
    return;
  }
  logger.warn({ chatId: String(chatId), status: said.status }, '[calc-intake] «bo‘lmadi» not sent');
  if (how.notice !== null) {
    // HTML-only (send.ts); the sentence holds no markup character. The notice
    // is the collection's own message already, so its new «Bo‘ldi» is owned.
    await editText({ chatId, messageId: how.notice, html: READING.failed, replyMarkup: doneKeyboard }).catch(() => null);
  }
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
 * terminal? A reading whose reply is STORED is not dead: it is done, and only
 * its delivery waits (`pendingDeliveryAlive` is that question). One running in
 * this process is alive whatever pg-boss says (review adv-4): an attempt that
 * outran its expiry is failed and retried by pg-boss, the in-process fence
 * turns the retry away at once, and the job then reads «completed» while the
 * first run is still reading. A press younger than a minute counts as alive
 * even with no job yet (its enqueue may still be on the way); a token with no
 * job id at all — its notice still going out — is judged by the press's own
 * staleness.
 */
export async function readingAlive(state: IntakeState): Promise<boolean> {
  if (state.analysing === null) return false;
  if (state.pendingReply?.token === state.analysing) return true;
  if (inFlight.has(state.analysing)) return true;
  const age = state.analysingAt === null ? Number.POSITIVE_INFINITY : Date.now() - state.analysingAt;
  if (state.analysingJob === null) return age <= ANALYSIS_STALE_MS;
  const life = await jobLife(state.analysingJob);
  return life === 'alive' || (life === 'missing' && age < ENQUEUE_GRACE_MS);
}

/**
 * For the sweep: release a dead reading's token and say «Tahlil qilib
 * bo‘lmadi…» once. Only the token it was handed: a newer press's reading is
 * not this one's to end.
 */
export async function releaseDeadReading(chatId: bigint, state: IntakeState): Promise<void> {
  const live = activeIntake(chatId);
  if (!live || live.noteId !== state.noteId || live.analysing === null || live.analysing !== state.analysing) return;
  // A reading that succeeded and only waits for its delivery is never «dead».
  if (live.pendingReply?.token === live.analysing) return;
  // Nor one still running here, whatever its job says (review adv-4).
  if (inFlight.has(live.analysing)) return;
  // The sweep never sleeps, and knows no notice to edit.
  await saidDead(chatId, live, { notice: null, brief: false });
}

/**
 * For the sweep: send a stored `pendingReply` whose delivery never happened (a
 * flood wait outlived the job's retries, durability-16; the last attempt's
 * send failed), bounded like the job's own delivery — the reading itself is
 * never re-run for it. Never while this process is delivering it already (a
 * retry, a follow-up): the table would arrive twice (reviews spec-6, adv-5).
 *
 * The notice above it is pointed down here too: the sweep has no job payload,
 * so the stored reply carries the notice's id (reviews spec-5, adv-11) — a
 * table that came late is still not left under «⏳ AI o‘qiyapti…».
 */
export async function deliverStoredReply(chatId: bigint, state: IntakeState): Promise<void> {
  const live = activeIntake(chatId);
  const reply = live?.pendingReply;
  if (!live || !reply || live.noteId !== state.noteId) return;
  if (runningHere(reply.token)) return;
  const job = { chatId: String(chatId), noteId: live.noteId, token: reply.token, noticeMessageId: reply.noticeMessageId ?? null };
  // No job, so no deadline to wait for: a stopping process hands nothing on.
  await deliver(chatId, reply, job, Date.now());
}

/**
 * For the sweep: will something else still deliver this stored reply — a run
 * in this process, its delivery-only follow-up, or, when there is none, the
 * reading's own job (a retry after a failed send, or a job a dead process left
 * `active` until pg-boss's expiry hands it over)? The sweep sends it only when
 * nothing will (reviews spec-6, adv-5).
 */
export async function pendingDeliveryAlive(state: IntakeState): Promise<boolean> {
  const reply = state.pendingReply;
  if (!reply) return false;
  if (runningHere(reply.token)) return true;
  const jobId = reply.jobId ?? state.analysingJob;
  return jobId !== null && (await jobLife(jobId)) === 'alive';
}
