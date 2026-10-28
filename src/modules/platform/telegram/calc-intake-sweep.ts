import type PgBoss from 'pg-boss';
import { activeIntake } from './calc-store';
import { totalsQuestionText, type IntakeState } from './calc-intake';
import {
  deliverNextStep,
  intakeLaws,
  showIntakePrompt,
  skipKeyboard,
  type CalcPressCtx,
  type CollectorReply,
  type EditApi,
} from './calc-dialog';
import { CLIENT_QUESTION, pricedZonesNow, zoneKeyboard } from './calc-keyboards';

/**
 * The collection's clock (docs/SAKKIZ-R3.md K9): the reminder, the end, and a
 * landing cut off halfway resumed — one pg-boss sweep P1 fills behind these
 * signatures. K registers the queue and nothing runs on it; «▶️ Davom etamiz»
 * already works, because the restart question's «Yo‘q» needs it in K.
 */

export const JOB_CALC_INTAKE_SWEEP = 'calc.intake-sweep';

/** K: the queue only — no schedule, no worker (P1 adds both). */
export async function registerCalcIntakeSweep(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_CALC_INTAKE_SWEEP);
}

/** What a press with no live collection hears — Uch band's conc-13 sentence, verbatim. */
const NO_COLLECTION =
  'Bu so‘rov yopilgan — saqlangan bo‘lsa, kartada turibdi. Yangisini «🧮 Hisoblatish» tugmasidan boshlang.';

/**
 * «▶️ Davom etamiz» and the restart question's «Yo‘q, davom etaman»: the live
 * stage is asked again, exactly where it stands — the zone keyboard, the
 * customer question, the «Bo‘ldi» prompt, or the next step after a reading.
 *
 * An open question is RE-SENT and nothing is written: routing a resume through
 * the next-step decision bumps `round` (capped at MAX_QUESTION_ROUNDS), so a
 * resume would skip lines (re-check kernel-23). P1 adds the un-park and the
 * draft refusal.
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
 * True = the sweep is resuming THIS chat's landing right now (P1's
 * `resuming`), so the press says nothing and the sweep's ✅ answers it. A
 * re-press after the job landed needs nothing here: `landIntake` converges by
 * itself (`cardOfNote`, `rootRequestOfNote`) and answers with Uch band's
 * 'retried' words. K: false.
 */
export async function landedAlreadyReply(
  _ctx: CollectorReply,
  _chatId: bigint,
  _state: IntakeState,
): Promise<boolean> {
  return false;
}
