import type PgBoss from 'pg-boss';
import { logger } from '../logger';
import { tashkentDay, tashkentMinute } from '../time/tashkent';
import {
  activeIntake,
  durableIntakes,
  endIntake,
  expireIntake,
  INTAKE_TTL_MS,
  intakeIsEmpty,
  liveIntakes,
  noteOwnMessage,
  peekIntake,
  REMIND_AFTER_MS,
  updateIntake,
} from './calc-store';
import { totalsQuestionText, type IntakeState } from './calc-intake';
import {
  deliverNextStep,
  intakeLaws,
  landingReplyText,
  showIntakePrompt,
  skipKeyboard,
  type CalcPressCtx,
  type CollectorReply,
  type EditApi,
} from './calc-dialog';
import { CLIENT_QUESTION, pricedZonesNow, zoneKeyboard } from './calc-keyboards';
import { deliverStoredReply, pendingDeliveryAlive, readingAlive, releaseDeadReading } from './calc-read';
import { landedReplyMarkup, releaseDeadSave, savingAlive } from './calc-amend';
import { activeCapture } from './note-capture';
import { activeDraft } from './task-draft';
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
 * is judged (durability-12 c).
 */
export const BOOT_GRACE_MS = 2 * 60_000;
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
 *  - a dead reading's token is released; a stored reply nobody delivered is
 *    sent; a dead save is released;
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
  if (state.analysing !== null && !facts.readingAlive) return 'release_reading';
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

/**
 * The press and the sweep share two facts about a landing, in this process
 * (on `globalThis`, like the store): which chat the sweep is landing right
 * now, and when a press last started one.
 */
const globalForSweep = globalThis as unknown as {
  calcIntakeSweep?: { resuming: Set<string>; landingPressAt: Map<string, number>; resumeWarned: Set<string> };
};
const sweepMemory = (globalForSweep.calcIntakeSweep ??= {
  resuming: new Set(),
  landingPressAt: new Map(),
  resumeWarned: new Set(),
});

/** Has the collection reached a reading the seller was shown — the only stage a landing starts from. */
function reviewed(state: IntakeState): boolean {
  return state.stage !== 'section' && state.stage !== 'client' && state.stage !== 'material';
}

async function factsFor(chatId: bigint, state: IntakeState, now: number, sinceBootMs: number): Promise<SweepFacts> {
  const pressedAt = sweepMemory.landingPressAt.get(String(chatId));
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
    pressLandingMs: pressedAt === undefined ? null : now - pressedAt,
    sinceBootMs,
  };
}

/**
 * One tick. Every collection in memory is decided on what it is NOW (re-read
 * after the facts' awaits — the seller may have written meanwhile) and acted
 * on in its own try, so one chat's failure never stops the rest. Then the
 * additions that waited for a machine pass are handed back (P4).
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
  const boot = bootedAtSec();
  const sinceBootMs = boot > 0 ? now - boot * 1000 : Number.POSITIVE_INFINITY;
  for (const [chatId, seen] of liveIntakes()) {
    try {
      const facts = await factsFor(chatId, seen, now, sinceBootMs);
      const state = peekIntake(chatId);
      if (!state || state.noteId !== seen.noteId) continue;
      const action = sweepAction(state, now, facts);
      done[action] += 1;
      await act(chatId, state, action, now);
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

async function act(chatId: bigint, state: IntakeState, action: SweepAction, now: number): Promise<void> {
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
      await resumeLanding(chatId, state);
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
 * silent (`landedAlreadyReply`): this ✅ answers it.
 */
async function resumeLanding(chatId: bigint, state: IntakeState): Promise<void> {
  const k = String(chatId);
  if (sweepMemory.resuming.has(k)) return;
  sweepMemory.resuming.add(k);
  try {
    // A note already on a card is finished, never expired: the landing reads
    // the live collection, and a kept one may be past its 24 hours after a
    // long outage. Quiet — the sweep is not the seller's action.
    updateIntake(chatId, { touchedAt: Date.now() }, { quiet: true });
    const staff = await staffForChat(chatId);
    const target = await landCollectedIntake(chatId, state.staffId, staff?.fullName ?? '');
    if (!target) return;
    const link = await landingLinkFor(state.staffId, target);
    const { sectionParts } = await import('../../wms/calc/pricing');
    const tariffFollows = target.replyQueued === true && !sectionParts(state.section).customs;
    const { replyKeyboardFor } = await import('./keyboards');
    const markup = landedReplyMarkup(target) ?? (await replyKeyboardFor(chatId));
    endIntake(chatId);
    const sent = await sendText({
      chatId,
      text: landingReplyText(target, { link, tariffFollows }),
      replyMarkup: markup,
      silent: quietHour(),
    });
    if (!sent.ok) logger.warn({ chatId: k, status: sent.status }, '[calc-intake] resumed landing ✅ not sent');
  } catch (err) {
    // Kept: the next tick, or the seller's own «Tasdiqlash», tries again.
    if (!sweepMemory.resumeWarned.has(state.noteId)) {
      sweepMemory.resumeWarned.add(state.noteId);
      logger.warn({ err, chatId: k }, '[calc-intake] a cut-off landing could not be finished — kept');
    }
  } finally {
    sweepMemory.resuming.delete(k);
  }
}

/** What a press with no live collection hears — Uch band's conc-13 sentence, verbatim. */
const NO_COLLECTION =
  'Bu so‘rov yopilgan — saqlangan bo‘lsa, kartada turibdi. Yangisini «🧮 Hisoblatish» tugmasidan boshlang.';

/**
 * «▶️ Davom etamiz» and the restart question's «Yo‘q, davom etaman»: the live
 * stage is asked again, exactly where it stands — the zone keyboard, the
 * customer question, the «Bo‘ldi» prompt, or the next step after a reading.
 *
 * A press is the seller's action, so it un-parks the collection (a touch).
 * Not while a task draft or a zametka capture is live: those work while the
 * collection is parked, and the person finishes one thing first.
 *
 * An open question is RE-SENT and nothing is written: routing a resume through
 * the next-step decision bumps `round` (capped at MAX_QUESTION_ROUNDS), so a
 * resume would skip lines (re-check kernel-23).
 */
export async function pressResume(ctx: CalcPressCtx, chatId: bigint): Promise<void> {
  const state = activeIntake(chatId);
  if (!state) {
    await ctx.reply(NO_COLLECTION);
    return;
  }
  // A reading is running (the restart question can be reached during the
  // «AI o‘qiyapti» minutes): the live stage's honest prompt is the reading's
  // own — a stale summary's «✅ Tasdiqlash» would only answer this same line.
  if (state.analysing) {
    await ctx.reply('⏳ Tahlil davom etmoqda — natijani kuting.');
    return;
  }
  if (activeDraft(chatId) || activeCapture(chatId)) {
    await ctx.reply('Avval topshiriqni (zametkani) tugating yoki bekor qiling — keyin «▶️ Davom etamiz».');
    return;
  }
  // The touch: the seller pressed, so the collection holds the chat again.
  updateIntake(chatId, {});
  if (state.stage === 'section') {
    await ctx.reply('Avval yuk qayerdan chiqishini tanlang:', { reply_markup: zoneKeyboard(await pricedZonesNow()) });
    return;
  }
  if (state.stage === 'client') {
    await ctx.reply(CLIENT_QUESTION, { parse_mode: 'Markdown' });
    return;
  }
  if (state.stage === 'material') {
    // The press ctx carries the api in production (grammy's own); a prompt
    // that cannot be edited is sent fresh, which is all a test's fake does.
    await showIntakePrompt(ctx as CalcPressCtx & { api: EditApi }, chatId, state);
    return;
  }
  if (state.stage === 'question') {
    const text = await pendingQuestionText(state);
    if (text !== null) {
      await ctx.reply(text, { reply_markup: skipKeyboard() });
      return;
    }
  }
  await deliverNextStep(ctx, chatId, state);
}

/**
 * The open question's own words, as they were asked — null when the state
 * names none (then the next step is asked instead).
 */
async function pendingQuestionText(state: IntakeState): Promise<string | null> {
  const intake = await import('../../wms/calc/intake');
  const ask = state.askingTotalsFor ?? null;
  if (ask !== null) {
    const why = state.ambiguousTotals.map((a) => `\n⚠️ ${intake.ambiguousTotalText(a)}`).join('');
    return (
      totalsQuestionText(ask, state.facts, {
        m3: intake.factsVolumeM3(state.facts),
        fromLines: intake.volumeFromLines(state.facts),
      }) + why
    );
  }
  const index = state.askingIndex ?? null;
  const row = index === null ? undefined : state.facts.goods?.[index];
  if (index === null || !row) return null;
  const laws = await intakeLaws(state);
  const need =
    intake.lineNeeds(state.section, state.facts, laws).find((l) => l.index === index) ??
    intake.anyMeasureLine(index, row.name);
  return intake.lineQuestionText(need);
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
  if (sweepMemory.resuming.has(k)) return true;
  sweepMemory.landingPressAt.set(k, Date.now());
  return false;
}

/** Tests: the press/sweep memory of a fresh process. */
export function __resetIntakeSweep(): void {
  sweepMemory.resuming.clear();
  sweepMemory.landingPressAt.clear();
  sweepMemory.resumeWarned.clear();
}
