import type PgBoss from 'pg-boss';
import { logger } from '../logger';
import { tashkentDay, tashkentMinute } from '../time/tashkent';
import {
  activeIntake,
  BOOT_GRACE_MS,
  durableIntakes,
  endIntake,
  expireIntake,
  INTAKE_TTL_MS,
  intakeIsEmpty,
  liveIntakes,
  noteOwnMessage,
  peekIntake,
  REMIND_AFTER_MS,
  retryUnsaid,
  sayOrRetry,
  updateIntake,
} from './calc-store';
import type { IntakeState } from './calc-intake';
import {
  deliverNextStep,
  drawPromptSoon,
  landingReplyText,
  landingRetryWords,
  QUEUE_REFUSAL,
  queueRefusal,
  type CalcPressCtx,
  type CollectorReply,
  type EditApi,
} from './calc-dialog';
import { deliverStoredReply, pendingDeliveryAlive, readingAlive, releaseDeadReading } from './calc-read';
import { landedReplyMarkup, releaseDeadSave, savingAlive } from './calc-amend';
import { activeCapture } from './note-capture';
import { activeDraft } from './task-draft';
import { waitingAnswerWords } from './agent-bot';
import { bootedAtSec } from './lifecycle';
import { quietHour, sendText } from './send';
import { landCollectedIntake, landingLinkFor, staffForChat } from './staff-bot';
import type { CalcSection } from '../../wms/calc/intake';

/**
 * The collection's clock (docs/SAKKIZ-R3.md §6.2.13-15, his 1.8 c «2 soatdan
 * keyin bot davom etamizmi deb so‘rasin, 24 soat kutsin»): the reminder, the
 * end, a dead reading or save released, a stored reply delivered, and a
 * landing cut off halfway finished — one pg-boss sweep every five minutes,
 * deciding through ONE pure function (`sweepAction`).
 *
 * It acts on MEMORY — the collections live in the process that polls — so in
 * any other process (no bot, `TELEGRAM_POLLING=0`) it does nothing.
 */

export const JOB_CALC_INTAKE_SWEEP = 'calc.intake-sweep';

/**
 * The sweep ends nothing in its first two minutes after boot, so the backlog
 * — answers written before the 24 hours ran out — is applied before an expiry
 * is judged (durability-12 c). One constant with the store's own reads.
 */
export { BOOT_GRACE_MS };
/**
 * Failed resumes a cut-off landing gets once its collection is past its 24
 * hours; then it is let go, so a refusal that never clears cannot keep it —
 * and the chat it holds — for ever.
 */
export const RESUME_TRIES = 3;
/** How long a resume keeps a collection past its 24 hours alive for the landing — parked, never holding. */
const RESUME_ALIVE_MS = 5 * 60_000;
/** A press that started a landing this recently is left to finish it (the press says the ✅). */
export const LANDING_PRESS_QUIET_MS = 60_000;
/** A stored reply this old with no delivery alive is sent by the sweep (durability-16). */
export const PENDING_REPLY_STALE_MS = 60_000;

export async function registerCalcIntakeSweep(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_CALC_INTAKE_SWEEP);
  await boss.schedule(JOB_CALC_INTAKE_SWEEP, '*/5 * * * *');
  await boss.work(JOB_CALC_INTAKE_SWEEP, async () => {
    try {
      const done = await runIntakeSweep();
      const acted = Object.entries(done).filter(([action, n]) => action !== 'none' && n > 0);
      if (acted.length > 0) logger.info(Object.fromEntries(acted), '[calc-intake] sweep');
    } catch (err) {
      logger.error({ err }, '[calc-intake] sweep failed');
      throw err;
    }
  });
}

export type SweepAction =
  | 'none'
  | 'remind'
  | 'end_silent'
  | 'end_said'
  | 'release_reading'
  | 'release_saving'
  | 'resume_landing'
  | 'deliver_pending';

/** Every action in words, for the log — a new action without its words does not compile. */
export const SWEEP_ACTION_WORDS: Record<SweepAction, string> = {
  none: 'nothing to do',
  remind: 'reminded «davom etamizmi?»',
  end_silent: 'ended an empty collection in silence',
  end_said: 'ended a collection with «⌛ … o‘chirildi»',
  release_reading: 'released a dead reading',
  release_saving: 'released a dead save',
  resume_landing: 'finished a landing cut off halfway',
  deliver_pending: 'delivered a stored reply',
};

/** What the sweep reads about a collection BEFORE it decides — the pure function's whole input. */
export interface SweepFacts {
  /** The reading's pg-boss job is not terminal (P2's `readingAlive`). */
  readingAlive: boolean;
  /** For a new-request collection in the table stage: where its landing stands (`landingState`). */
  landing: 'none' | 'landed' | 'note_only';
  /** A delivery-only follow-up of the stored reply is alive (P2). */
  pendingDeliveryAlive: boolean;
  /** The add door's save job is alive (P4's `savingAlive`). */
  savingAlive: boolean;
  /** Ms since a «Tasdiqlash» press started this chat's landing, or null. */
  pressLandingMs: number | null;
  /** Ms since this process booted (Infinity when it never did — a test). */
  sinceBootMs: number;
}

/**
 * The ONE decision (pure). In order:
 *  - a landing cut off halfway (or landed and kept) is finished — unless a
 *    press is landing it right now;
 *  - 24 hours since the seller's last action end it (said, unless it is
 *    empty) — not in the boot's grace, when the backlog may still revive it;
 *  - a dead reading's token is released (a pre-boot one not in the grace,
 *    when its redelivered press may still take it over); a stored reply
 *    nobody delivered is sent; a dead save is released;
 *  - two hours idle reminds it once per idle stretch — not an empty one, not
 *    one frozen by a save, not one being read.
 */
export function sweepAction(state: IntakeState, now: number, facts: SweepFacts): SweepAction {
  if (facts.landing !== 'none' && (facts.pressLandingMs === null || facts.pressLandingMs >= LANDING_PRESS_QUIET_MS)) {
    return 'resume_landing';
  }
  if (now >= state.touchedAt + INTAKE_TTL_MS) {
    if (facts.sinceBootMs < BOOT_GRACE_MS) return 'none';
    return intakeIsEmpty(state) ? 'end_silent' : 'end_said';
  }
  if (state.analysing !== null && !facts.readingAlive) {
    // A job-less token minted before this boot — a «Bo‘ldi» the old process
    // was still answering (dur-3): the backlog carries that press, which
    // takes the token over. Released only past the grace (fix review
    // fdur-7): a tick first said «Tahlil qilib bo‘lmadi» just before the
    // redelivered press said «AI o‘qiyapti».
    const bootMs = now - facts.sinceBootMs;
    if (facts.sinceBootMs < BOOT_GRACE_MS && state.analysingJob === null && (state.analysingAt ?? 0) < bootMs) return 'none';
    return 'release_reading';
  }
  if (
    state.pendingReply !== null &&
    now - state.pendingReply.at >= PENDING_REPLY_STALE_MS &&
    !facts.pendingDeliveryAlive
  ) {
    return 'deliver_pending';
  }
  if (state.saving !== null && !facts.savingAlive) return 'release_saving';
  if (
    state.remindedAt === null &&
    now - state.touchedAt >= REMIND_AFTER_MS &&
    !intakeIsEmpty(state) &&
    state.saving === null &&
    state.analysing === null
  ) {
    return 'remind';
  }
  return 'none';
}

/** A cut-off landing's failed resumes: how many, and whether the queue's refusal was said. */
interface ResumeFailures {
  count: number;
  refusalSaid: boolean;
}

/**
 * The press and the sweep share what they know about a landing, in this
 * process (on `globalThis`, like the store): which chat the sweep is landing
 * right now, when a press last started one, which chat's press the sweep's
 * ✅ was to answer, and how a note's resumes have failed.
 */
const globalForSweep = globalThis as unknown as {
  calcIntakeSweep?: {
    resuming: Set<string>;
    landingPressAt: Map<string, number>;
    silenced: Set<string>;
    resumeFailures: Map<string, ResumeFailures>;
  };
};
const sweepMemory = (globalForSweep.calcIntakeSweep ??= {
  resuming: new Set(),
  landingPressAt: new Map(),
  silenced: new Set(),
  resumeFailures: new Map(),
});

/** Has the collection reached a reading the seller was shown — the only stage a landing starts from. */
function reviewed(state: IntakeState): boolean {
  return state.stage !== 'section' && state.stage !== 'client' && state.stage !== 'material';
}

/**
 * The facts that need a read, about the collection as the tick SAW it. The
 * press's landing stamp is not among them: it is read after these awaits,
 * beside the re-read of the collection, so a press that starts its landing
 * meanwhile keeps the tick away.
 */
async function factsFor(state: IntakeState, sinceBootMs: number): Promise<Omit<SweepFacts, 'pressLandingMs'>> {
  let landing: SweepFacts['landing'] = 'none';
  if (state.amend === null && reviewed(state)) {
    const { landingState } = await import('../../wms/calc/intake-ended');
    landing = await landingState(state.noteId, state.staffId);
  }
  return {
    readingAlive: state.analysing !== null ? await readingAlive(state) : true,
    landing,
    pendingDeliveryAlive: state.pendingReply !== null ? await pendingDeliveryAlive(state) : false,
    savingAlive: state.saving !== null ? await savingAlive(state) : true,
    sinceBootMs,
  };
}

/**
 * Is the collection still the one whose facts were read — the same note AND
 * the same reading, save and stored reply? A fact is about one token: «this
 * reading's job is dead» said of the reading the seller's «Bo‘ldi» started
 * during the awaits would release a LIVE one.
 */
function sameWork(live: IntakeState, seen: IntakeState): boolean {
  return (
    live.noteId === seen.noteId &&
    live.analysing === seen.analysing &&
    (live.saving?.jobId ?? null) === (seen.saving?.jobId ?? null) &&
    (live.pendingReply?.token ?? null) === (seen.pendingReply?.token ?? null)
  );
}

/**
 * One tick. First the goodbyes a failed send left unsaid. Then every
 * collection in memory is decided on what it is NOW (re-read after the facts'
 * awaits — the seller may have written meanwhile; one whose reading, save or
 * stored reply changed under them waits for the next tick) and acted on in its
 * own try, so one chat's failure never stops the rest. Then the additions that
 * waited for a machine pass are handed back (P4).
 */
export async function runIntakeSweep(now: number = Date.now()): Promise<Record<SweepAction, number>> {
  const done: Record<SweepAction, number> = {
    none: 0,
    remind: 0,
    end_silent: 0,
    end_said: 0,
    release_reading: 0,
    release_saving: 0,
    resume_landing: 0,
    deliver_pending: 0,
  };
  if (!durableIntakes()) return done;
  for (const [chat, at] of sweepMemory.landingPressAt) {
    if (now - at >= LANDING_PRESS_QUIET_MS) sweepMemory.landingPressAt.delete(chat);
  }
  try {
    await retryUnsaid();
  } catch (err) {
    logger.warn({ err }, '[calc-intake] unsaid goodbyes not retried');
  }
  const boot = bootedAtSec();
  const sinceBootMs = boot > 0 ? now - boot * 1000 : Number.POSITIVE_INFINITY;
  for (const [chatId, seen] of liveIntakes()) {
    try {
      const read = await factsFor(seen, sinceBootMs);
      const state = peekIntake(chatId);
      if (!state || !sameWork(state, seen)) continue;
      const pressedAt = sweepMemory.landingPressAt.get(String(chatId));
      const facts: SweepFacts = { ...read, pressLandingMs: pressedAt === undefined ? null : now - pressedAt };
      const action = sweepAction(state, now, facts);
      done[action] += 1;
      await act(chatId, state, action, now, facts);
    } catch (err) {
      logger.warn({ err, chatId: String(chatId) }, '[calc-intake] sweep failed for a chat');
    }
  }
  try {
    const { requeueWaitingAmendments } = await import('../../wms/calc/amend');
    await requeueWaitingAmendments();
  } catch (err) {
    logger.warn({ err }, '[calc-intake] waiting additions not handed back');
  }
  return done;
}

async function act(chatId: bigint, state: IntakeState, action: SweepAction, now: number, facts: SweepFacts): Promise<void> {
  switch (action) {
    case 'none':
      return;
    case 'remind':
      await remind(chatId, state, now);
      return;
    case 'end_silent':
    case 'end_said':
      // The one end path (calc-store.ts): it says the line unless empty.
      expireIntake(chatId, state);
      return;
    case 'release_reading':
      await releaseDeadReading(chatId, state);
      return;
    case 'release_saving':
      await releaseDeadSave(chatId, state);
      return;
    case 'deliver_pending':
      await deliverStoredReply(chatId, state);
      return;
    case 'resume_landing':
      if (facts.landing !== 'none') await resumeLanding(chatId, state, facts.landing, now);
      return;
  }
}

/** The reminder's two buttons (§2.7): its ✖️ ends at once — the message asks «davom etamizmi?» itself. */
export function reminderKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '▶️ Davom etamiz', callback_data: 'c:resume' }],
      [{ text: '✖️ Bekor qilish', callback_data: 'c:cancel' }],
    ],
  };
}

/**
 * §2.7's reminder, pure. `client` = `intakeClientSummary(clientHintRaw)`. The
 * «Yuborilgan:» line names only what is there; the end is Tashkent's clock,
 * «ertaga» when it is not today.
 */
export function reminderText(
  state: IntakeState,
  now: number,
  sections: Record<CalcSection, string>,
  client: string | null,
): string {
  const head = state.amend
    ? `⏸ Tugallanmagan qo‘shimcha: ➕ ${state.amend.cardLabel} · ${sections[state.section]}`
    : `⏸ Tugallanmagan hisoblatish: ${sections[state.section]} · ${client ?? 'mijoz hali yozilmagan'}`;
  const messages = state.material.length + state.answers.length;
  const parts = [
    messages > 0 ? `${messages} ta xabar` : null,
    state.fileCount > 0 ? `${state.fileCount} ta fayl` : null,
  ].filter((p): p is string => p !== null);
  const [endDay, endTime] = tashkentMinute(new Date(state.touchedAt + INTAKE_TTL_MS)).split(' ');
  const when = endDay === tashkentDay(new Date(now)) ? `soat ${endTime} da` : `ertaga soat ${endTime} da`;
  return [
    head,
    ...(parts.length > 0 ? [`Yuborilgan: ${parts.join(' · ')}`] : []),
    `Davom etamizmi? Tugatilmasa ${when} o‘chiriladi.`,
  ].join('\n');
}

/**
 * The claim first — `remindedAt`, quiet, so the mark slides nothing — then
 * the send (`sendText`: a sweep never sleeps). A refusal that can never
 * succeed (400/403: the bot blocked, no such chat) stays claimed, or every
 * tick would knock; any other failure — a 429, the token down, a 5xx, no
 * answer — RELEASES it, so the next tick tries again (durability-19). The
 * reminder is the person's own work and passes no notification mute.
 */
async function remind(chatId: bigint, state: IntakeState, now: number): Promise<void> {
  updateIntake(chatId, { remindedAt: now }, { quiet: true });
  const { SECTION_LABEL } = await import('../../wms/calc/intake');
  const { intakeClientSummary } = await import('./calc-intake');
  const sent = await sendText({
    chatId,
    text: reminderText(state, now, SECTION_LABEL, intakeClientSummary(state.clientHintRaw)),
    replyMarkup: reminderKeyboard(),
    silent: quietHour(new Date(now)),
  });
  if (sent.ok) {
    if (sent.messageId !== null) noteOwnMessage(chatId, sent.messageId);
    return;
  }
  if (sent.permanent) {
    logger.warn({ chatId: String(chatId), status: sent.status }, '[calc-intake] reminder refused for good');
    return;
  }
  const live = peekIntake(chatId);
  if (live && live.noteId === state.noteId && live.remindedAt === now) {
    updateIntake(chatId, { remindedAt: null }, { quiet: true });
  }
}

/**
 * A landing cut off between its note and its request (durability-3), or one
 * that landed and survived: `landCollectedIntake` → `landIntake` again, which
 * converges by itself — `cardOfNote` finds the note's own card ('retried'),
 * `rootRequestOfNote` its request when one exists, K2's note lock keeps a
 * concurrent twin to one request — and the ✅ is the save branch's own, with
 * Uch band's retried words. `resuming` keeps a press in the same moment
 * silent (`landedAlreadyReply`): this ✅ answers it, sent BEFORE the
 * collection ends, so a press in the ✅'s own round trip still finds
 * `resuming` and says nothing (§2.7).
 *
 * The clock is not moved for the landing — the sweep is not the seller's
 * action, and a resume that failed and slid it would never expire and would
 * hold the chat for good. Only a collection already past its 24 hours (a long
 * outage) is kept alive for it, set just inside the window so it stays PARKED,
 * and put back when the landing fails. A failure is tried again at the next
 * ticks; past the 24 hours, after RESUME_TRIES failures, the collection is let
 * go. The queue's refusals are the press path's own (staff-handlers.ts, the
 * save branch): said once, in its words, and a job too big for the queue or
 * a note already written ends the collection there.
 */
async function resumeLanding(
  chatId: bigint,
  state: IntakeState,
  landing: 'landed' | 'note_only',
  now: number,
): Promise<void> {
  const k = String(chatId);
  if (sweepMemory.resuming.has(k)) return;
  const failed = sweepMemory.resumeFailures.get(state.noteId) ?? { count: 0, refusalSaid: false };
  if (now >= state.touchedAt + INTAKE_TTL_MS && failed.count >= RESUME_TRIES) {
    // Let go. A note that never got its request ends as any collection ends,
    // with the line; a job that LANDED stands on its card — only its ✅ could
    // not be made — and ends in silence rather than with «o‘chirildi».
    sweepMemory.resumeFailures.delete(state.noteId);
    if (landing === 'landed') endIntake(chatId);
    else expireIntake(chatId, state);
    return;
  }
  sweepMemory.resuming.add(k);
  const real = Date.now();
  const revivedAt = real >= state.touchedAt + INTAKE_TTL_MS ? real - INTAKE_TTL_MS + RESUME_ALIVE_MS : null;
  if (revivedAt !== null) updateIntake(chatId, { touchedAt: revivedAt }, { quiet: true });
  try {
    const staff = await staffForChat(chatId);
    const target = await landCollectedIntake(chatId, state.staffId, staff?.fullName ?? '');
    if (!target) return;
    const link = await landingLinkFor(state.staffId, target);
    const { sectionParts } = await import('../../wms/calc/pricing');
    const tariffFollows = target.replyQueued === true && !sectionParts(state.section).customs;
    const { replyKeyboardFor } = await import('./keyboards');
    const markup = landedReplyMarkup(target) ?? (await replyKeyboardFor(chatId));
    // The ✅ says what the REQUEST's door promises (docs/IKKI-ESHIK.md §2.3,
    // §3.5) — read off the row the landing wrote, as the pass reads it; the
    // landing reads it for both senders (as-built review DOORS-3).
    await sayOrRetry({
      chatId,
      text: landingReplyText(target, { link, tariffFollows, door: target.door, aiAvailable: target.aiAvailable }),
      replyMarkup: markup,
    });
    endIntake(chatId);
    sweepMemory.resumeFailures.delete(state.noteId);
  } catch (err) {
    // Put the clock back, unless the seller acted meanwhile.
    const live = peekIntake(chatId);
    if (revivedAt !== null && live && live.noteId === state.noteId && live.touchedAt === revivedAt) {
      updateIntake(chatId, { touchedAt: state.touchedAt }, { quiet: true });
    }
    failed.count += 1;
    sweepMemory.resumeFailures.set(state.noteId, failed);
    if (failed.count === 1) logger.warn({ err, chatId: k }, '[calc-intake] a cut-off landing could not be finished — kept');
    const code = (err as { code?: unknown } | null)?.code;
    const refused = typeof code === 'string' && code in QUEUE_REFUSAL ? code : null;
    if (refused) {
      const ends = refused === 'too_many_items' || refused === 'note_taken';
      if (ends) endIntake(chatId);
      if (ends || !failed.refusalSaid) {
        failed.refusalSaid = true;
        const { replyKeyboardFor } = await import('./keyboards');
        await sayOrRetry({ chatId, text: `⚠️ Saqlanmadi: ${queueRefusal(refused)}`, replyMarkup: await replyKeyboardFor(chatId) });
      }
    } else if (sweepMemory.silenced.has(k)) {
      // A «Tasdiqlash» this resume kept silent is owed an answer: the press
      // path's own words for a landing that failed — the press that was made,
      // «👤 VED hisoblasin» included (docs/FAYL-OQISH.md §1.2).
      await sayOrRetry({ chatId, text: landingRetryWords(peekIntake(chatId) ?? state) });
    }
  } finally {
    sweepMemory.resuming.delete(k);
    sweepMemory.silenced.delete(k);
  }
}

/** What a press with no live collection hears — Uch band's conc-13 sentence, verbatim. */
const NO_COLLECTION =
  'Bu so‘rov yopilgan — saqlangan bo‘lsa, kartada turibdi. Yangisini «🧮 Hisoblatish» tugmasidan boshlang.';

/** §2.7's words for a press while a task draft or a zametka capture is live. */
const RESUME_BUSY = 'Avval topshiriqni (zametkani) tugating yoki bekor qiling — keyin «▶️ Davom etamiz».';

/**
 * Another collector — or a one-text wait — is live beside a PARKED
 * collection: the words to answer a press with, or null. ONE predicate
 * (review REG-2, COMP-5), asked by «▶️ Davom etamiz» and by every press that
 * would make the parked collection hold the chat again (the dispatcher's
 * 'own' steps, a reply to its own table): a holding collection is asked
 * FIRST by the text ladder, so the draft's next line, the zametka's name, a
 * «Bajarildi» result or the AI sotuvchi's ✏️ text would be filed as its
 * material. On main each door refused the other and the state could not
 * exist; a parked collection now lets the others open (§6.2.7).
 */
export function otherCollectorLive(chatId: bigint): string | null {
  if (activeDraft(chatId) || activeCapture(chatId)) return RESUME_BUSY;
  return waitingAnswerWords(chatId);
}

/**
 * «▶️ Davom etamiz» and the restart question's «Yo‘q, davom etaman»: the live
 * stage is asked again, exactly where it stands — the zone keyboard, the
 * customer question, the «Bo‘ldi» prompt, or the table, sent fresh (the
 * table stage has no question to re-send — docs/SAKKIZ-R3.md §8.1, the
 * one-question loop is retired).
 *
 * A press is the seller's action, so it un-parks the collection (a touch).
 * Not while a task draft, a zametka capture or a one-text wait is live
 * (`otherCollectorLive`): those work while the collection is parked, and the
 * person finishes one thing first. True = resumed; false = refused or nothing
 * to resume, said — a caller that would write into it does not (fix review
 * FR-1).
 */
export async function pressResume(ctx: CalcPressCtx, chatId: bigint, lead: string | null = null): Promise<boolean> {
  const state = activeIntake(chatId);
  if (!state) {
    await ctx.reply(NO_COLLECTION);
    return false;
  }
  // A reading is running (the restart question can be reached during the
  // «AI o‘qiyapti» minutes): the live stage's honest prompt is the reading's
  // own — a stale summary's «✅ Tasdiqlash» would only answer this same line.
  if (state.analysing) {
    await ctx.reply('⏳ Tahlil davom etmoqda — natijani kuting.');
    return false;
  }
  const busy = otherCollectorLive(chatId);
  if (busy) {
    await ctx.reply(busy);
    return false;
  }
  // The touch: the seller pressed, so the collection holds the chat again.
  updateIntake(chatId, {});
  if (state.stage === 'section' || state.stage === 'client' || state.stage === 'material') {
    // The open question or the prompt, redrawn ONCE as the last message
    // (docs/IKKI-ESHIK.md §1.4-§1.6) — the pressed notice is newer, so it
    // moves below it. The press ctx carries the api in production (grammy's
    // own); a test's fake without one gets a fresh copy.
    // `lead`: a door's one line on top (▶️'s «Davom etamiz.» when its take read
    // nothing) — the draw's own lead, so whichever call of the burst draws
    // says it (§1.4 as built, as-built review BURST-7).
    drawPromptSoon(ctx as CalcPressCtx & { api?: EditApi }, chatId, lead);
    return true;
  }
  // The table is sent at once, so the line opens its FIRST message.
  await deliverNextStep(lead ? headed(ctx, lead) : ctx, chatId, state);
  return true;
}

/**
 * The FIRST message a speaker sends opens with `head` — a door's one line,
 * printed as the first line of what it answers with, never as a message of
 * its own (§1.4). Only for a step sent at once (`deliverNextStep`): a
 * kept-last draw takes the line as its lead instead, since it runs with the
 * newest call's ctx (as-built review BURST-7).
 */
function headed<S extends CollectorReply>(sp: S, head: string): S {
  let said = false;
  const reply: CollectorReply['reply'] = (text, extra) => {
    const first = !said;
    said = true;
    return sp.reply(first ? `${head}\n${text}` : text, extra);
  };
  // Over the speaker, never a copy of it: a grammy ctx carries its
  // `callbackQuery` and `chat` as prototype getters a spread would drop.
  return Object.assign(Object.create(sp) as S, { reply });
}

/**
 * True = the sweep is finishing THIS chat's landing right now (`resuming`),
 * so the press says nothing and the sweep's ✅ answers it. Otherwise the press
 * lands as it always did — `landIntake` converges by itself on a re-press —
 * and its moment is noted, so a tick in the next minute leaves that landing
 * to the press (the save branch is frozen and cannot join `resuming` itself).
 */
export async function landedAlreadyReply(
  _ctx: CollectorReply,
  chatId: bigint,
  _state: IntakeState,
): Promise<boolean> {
  const k = String(chatId);
  if (sweepMemory.resuming.has(k)) {
    sweepMemory.silenced.add(k);
    return true;
  }
  sweepMemory.landingPressAt.set(k, Date.now());
  return false;
}

/** Tests: the press/sweep memory of a fresh process. */
export function __resetIntakeSweep(): void {
  sweepMemory.resuming.clear();
  sweepMemory.landingPressAt.clear();
  sweepMemory.silenced.clear();
  sweepMemory.resumeFailures.clear();
}
