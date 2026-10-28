import type PgBoss from 'pg-boss';
import { randomUUID } from 'node:crypto';
import { logger } from '../logger';
import {
  analyzeCollected,
  answeredRoute,
  mergeLineAnswers,
  mergeTotalsAnswer,
  sameRouteAnswer,
  sameTotalsAnswer,
  unansweredAmbiguity,
  type IntakeState,
} from './calc-intake';
import { activeIntake, updateIntake } from './calc-store';
import { loadIntakeFiles, invoiceChoiceKeyboard, otherFilesKeyboard } from './calc-files';
import { deliverNextStep, type CollectorReply } from './calc-dialog';
import { CLIENT_QUESTION, doneKeyboard, pricedZonesNow, zoneKeyboard } from './calc-keyboards';

/**
 * The reading — «✅ Bo‘ldi», the model's pass over what was collected, and
 * where its answer lands — MOVED out of staff-handlers.ts (docs/SAKKIZ-R3.md
 * K8), which re-exports `settleAnalysis`. K keeps today's in-process reading
 * (off the poller, #706); the pg-boss job and the sweep's four questions are
 * seams P2 fills behind these signatures, each inert here.
 */

/** How long the in-process reading may spend loading the collection's files (K). */
const FILES_DEADLINE_MS = 60_000;

/**
 * «✅ Bo‘ldi — tahlil qil» / «🔄 AI qayta o‘qisin»: the guards, the token, the
 * notice, and the reading dispatched off the middleware chain.
 */
export async function pressAnalyse(ctx: CollectorReply, chatId: bigint, state: IntakeState): Promise<void> {
  // One analysis at a time: a second press used to start a second paid
  // call whose result overwrote the first (cause 7).
  if (state.analysing) {
    await ctx.reply('⏳ Tahlil davom etmoqda — natijani kuting.');
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
  const owned = updateIntake(chatId, { analysing: token }) ?? state;
  // The notice must not decide whether the analysis runs (round-1 review,
  // c3): the token is already written, only the analysis releases it, and
  // a refused notice — a 429 past `briefRetry`'s five seconds, a blip to
  // api.telegram.org — used to throw before the dispatch, leaving every
  // later «Bo'ldi» and «Tasdiqlash» answering «Tahlil davom etmoqda» for an
  // analysis that never started, until the seller threw the collection away.
  await ctx.reply('⏳ AI o‘qiyapti… (3 daqiqagacha)').catch((err: unknown) =>
    logger.warn({ err }, '[calc-intake] analysing notice not sent'),
  );
  // OFF the middleware chain, exactly like the assistant's answer (#706):
  // grammy's poller is sequential and the same bot serves every customer,
  // so awaiting an Opus call over twenty thousand characters here freezes
  // every cabinet tap, every /start and every «yukingiz keldi» until it
  // returns.
  void analyseIntakeAndReply(ctx, chatId, owned, token);
}

/**
 * Analyse the collected material off the middleware chain, and send the
 * summary when it lands. Everything is caught: a rejection here would be an
 * unhandled promise, and the person is left with «⏳ Tahlil qilinmoqda…» and
 * no answer, so the failure has to say so in the chat.
 *
 * The files the model reads are loaded from storage first (K5): the
 * collection holds attachment ids, never the bytes.
 */
export async function analyseIntakeAndReply(
  ctx: CollectorReply,
  chatId: bigint,
  state: Parameters<typeof analyzeCollected>[0],
  token: string,
): Promise<void> {
  try {
    const files = await loadIntakeFiles(state, { deadline: Date.now() + FILES_DEADLINE_MS });
    const analysed = await analyzeCollected(state, files);
    const outcome = settleAnalysis(activeIntake(chatId), state, analysed, token);
    if (outcome.kind === 'gone') return;
    updateIntake(chatId, outcome.state);
    if (outcome.kind === 'arrived') {
      await ctx.reply(
        `Tahlil paytida yana ${outcome.arrived} ta xabar/fayl keldi — ular hali o‘qilmagan.\n` +
          'Hammasini birga o‘qish uchun «Bo‘ldi» ni yana bosing.',
        { reply_markup: doneKeyboard },
      );
      return;
    }
    // ONE exit from the analysis: ask about the first line that cannot be
    // priced, else offer the confirm. Both shapes are the same function, so
    // the summary the seller reads is identical whichever way they arrive.
    await deliverNextStep(ctx, chatId, outcome.state);
  } catch (err) {
    logger.warn({ err }, '[calc-intake] analysis failed');
    const live = activeIntake(chatId);
    if (live?.analysing === token) updateIntake(chatId, { analysing: null, stage: 'material' });
    await ctx.reply('Tahlil qilib bo‘lmadi. «Bo‘ldi» ni qayta bosing.', { reply_markup: doneKeyboard }).catch(() => {});
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
    // The reading's bills, appended to the snapshot's (2.9 c) — one analysis
    // runs at a time (the token), so the snapshot's are the live ones.
    usages: analysed.usages,
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
 * One reading job. Nothing enqueues it in K; P2 enqueues it with its own `{ id,
 * expireInSeconds: 300, retryLimit }` — never pg-boss's 15-minute default — and
 * the delivery-only follow-up adds `startAfter`. K: returns.
 */
export async function runIntakeRead(_data: IntakeReadJob, _retryCount: number): Promise<void> {}

/** The reading's queue and its one worker (boss.ts registers it). */
export async function registerCalcIntakeReadWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_CALC_INTAKE_READ);
  await boss.work<IntakeReadJob>(JOB_CALC_INTAKE_READ, { includeMetadata: true }, async (jobs) => {
    for (const job of jobs) await runIntakeRead(job.data, job.retryCount ?? 0);
  });
}

/** For the sweep: is this collection's reading alive (its pg-boss job not terminal)? K: true. */
export async function readingAlive(_state: IntakeState): Promise<boolean> {
  return true;
}

/** For the sweep: release a dead reading's token and say «Tahlil qilib bo‘lmadi…» once. K: no-op. */
export async function releaseDeadReading(_chatId: bigint, _state: IntakeState): Promise<void> {}

/**
 * For the sweep: send a stored `pendingReply` whose delivery never happened (a
 * flood wait outlived the job's retries, durability-16). K: no-op.
 */
export async function deliverStoredReply(_chatId: bigint, _state: IntakeState): Promise<void> {}

/** For the sweep: is a delivery-only follow-up of this stored reply alive? K: false. */
export async function pendingDeliveryAlive(_state: IntakeState): Promise<boolean> {
  return false;
}
