import type PgBoss from 'pg-boss';
import type { AmendSubmission } from '../../wms/calc/amend-types';
import type { InlineKeyboard, IntakeState } from './calc-intake';
import type { CollectorReply, PressCtx } from './calc-dialog';
import type { OnceKey } from './once';
import { answerPress } from './press';

/**
 * «➕ Shu so‘rovga qo‘shish» — the add door (his 1.9 a, docs/SAKKIZ-R3.md K10):
 * a seller adds lines or files to a request he already sent. P4 fills it
 * behind these signatures; every K body is inert, and the dispatcher's calls
 * into it answer exactly what the bot answered before. The wms shapes are
 * TYPE imports only — platform never imports wms at run time.
 */

/** Uch band's conc-13 sentence, verbatim — what a press about no live collection hears. */
const NO_COLLECTION =
  'Bu so‘rov yopilgan — saqlangan bo‘lsa, kartada turibdi. Yangisini «🧮 Hisoblatish» tugmasidan boshlang.';

/**
 * «➕ Shu so‘rovga qo‘shish». `mode`: 'plain' (`ca:`), 'restart' (`cg:`, the
 * «🗑 Ha, uni o‘chirib …» twin), 'replied' (`cf:`, an offer under a forward or
 * a plain file — the message the offer replies to becomes the first material).
 * `restartKey`: the dispatcher's claim for the restart form (K11). K: no
 * message carries the button yet — «Bu tugma eskirgan.».
 */
export async function pressAdd(
  ctx: PressCtx,
  _chatId: bigint,
  _requestId: string,
  _mode: 'plain' | 'restart' | 'replied',
  _restartKey: OnceKey | null,
): Promise<void> {
  await answerPress(ctx, 'Bu tugma eskirgan.');
}

/**
 * Door B's extra rows: one `➕ {card} so‘roviga qo‘shish` (`cf:<id>`) per open
 * request the staff member sent in the last `ADD_OFFER_DAYS` (at most two,
 * newest first). K: none, so Door B's keyboard is today's.
 */
export async function addOfferRows(_chatId: bigint): Promise<{ text: string; callback_data: string }[][]> {
  return [];
}

/**
 * A plain photo or document with nothing to take it: the one offer line, as a
 * reply to it, when such a request exists. True = answered. K: false (today's
 * silence).
 */
export async function offerAddForMedia(_ctx: CollectorReply & { message: unknown }, _chatId: bigint): Promise<boolean> {
  return false;
}

/**
 * «✅ Qo‘shish» on an add collection: flush + enqueue `calc.amend-save` (P4).
 * K: unreachable — `amend` is always null — and answered with the sentence a
 * press about no live collection hears.
 */
export async function saveAmendment(ctx: CollectorReply, _chatId: bigint, _state: IntakeState): Promise<void> {
  await ctx.reply(NO_COLLECTION);
}

/** The sweep's view of a frozen add collection: is its save job alive? K: true. */
export async function savingAlive(_state: IntakeState): Promise<boolean> {
  return true;
}

/** The sweep's release of a dead save (P4). K: no-op. */
export async function releaseDeadSave(_chatId: bigint, _state: IntakeState): Promise<void> {}

/** The add door's save as a pg-boss job (P4). */
export const JOB_CALC_AMEND_SAVE = 'calc.amend-save';

export interface AmendSaveJob {
  chatId: string;
  staffId: string;
  requestId: string;
  noteId: string;
  /** A fresh press carries the submission; a stored («waiting») one carries its row id. */
  submission: AmendSubmission | null;
  amendmentId: string | null;
  savingToken: string | null;
}

/** One save job. Nothing enqueues it in K. */
export async function runAmendSave(_data: AmendSaveJob, _retryCount: number): Promise<void> {}

/** The save's queue and its one worker (boss.ts registers it). */
export async function registerCalcAmendSaveWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_CALC_AMEND_SAVE);
  await boss.work<AmendSaveJob>(JOB_CALC_AMEND_SAVE, { includeMetadata: true }, async (jobs) => {
    for (const job of jobs) await runAmendSave(job.data, job.retryCount ?? 0);
  });
}

/**
 * The ✅ landing reply's inline markup, or null = today's persistent-keyboard
 * re-send. K: null.
 */
export function landedReplyMarkup(_target: { queued?: boolean; requestId?: string | null }): InlineKeyboard | null {
  return null;
}

/**
 * A TEXT sent as a REPLY to an AI answer that carries ➕: it always handles the
 * message (it sends everything itself, by chat id), so the reply door answers
 * HANDLED with no text (regression-2). K: never called.
 */
export async function openAmendFromReply(
  _chatId: bigint,
  _requestId: string,
  _msg: { text: string | null; date: number; messageId: number },
): Promise<void> {}

/**
 * A text replying to ANOTHER request's ➕-bearing message while a collection is
 * live: words naming both, nothing written. True = handled. K: false.
 */
export async function foreignAddReply(
  _ctx: CollectorReply,
  _chatId: bigint,
  _intake: IntakeState,
  _replyTo: number | null,
): Promise<boolean> {
  return false;
}
