import { logger } from '../logger';
import { answerPress } from './press';
import { clientCodePrefix } from './staff-bot';
import {
  carryLineDone,
  doneLine,
  intakeClientSummary,
  MAX_INTAKE_IMAGES,
  MAX_OFFERS,
  MAX_QUESTION_ROUNDS,
  mergeTotalsAnswer,
  resolveLineDone,
  totalsQuestion,
  totalsQuestionText,
  unansweredAmbiguity,
  type InlineKeyboard,
  type IntakeState,
} from './calc-intake';
import { endIntake, updateIntake } from './calc-store';
import {
  aiConfirmKeyboard,
  CLIENT_QUESTION,
  confirmKeyboard,
  doneKeyboard,
  pricedZonesNow,
  zoneKeyboard,
} from './calc-keyboards';
import { bareTotalsNumber, totalsAnswerShape, totalsFigureCount } from './totals-shape';

/**
 * The «Hisoblatish» dialogue — what the bot asks, how an answer lands on its
 * row, and the words for every refusal — MOVED out of staff-handlers.ts
 * (docs/SAKKIZ-R3.md K6), which re-exports what a test imports. The same
 * functions, the same words; `askNextOrConfirm` is split into the pure
 * `intakeNextStep` and its one delivery, `deliverNextStep`, so the table (P3)
 * and the reading job (P2) can ask the decision without a chat.
 */

/** A ctx that can speak in the chat: the sent message comes back. */
export type CollectorReply = {
  reply: (text: string, extra?: Record<string, unknown>) => Promise<{ message_id: number }>;
};

/** What editing a sent message needs of grammy's api. */
export type EditApi = {
  editMessageText: (chatId: string, messageId: number, text: string, extra?: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Every `calc` step's ctx. The dispatcher has already answered the press
 * through `answerPress`, so these speak only through `ctx.reply` («Bu tugma
 * eskirgan.» in the chat). `callbackQuery` is optional, so a test's `{ reply }`
 * fake compiles.
 */
export type CalcPressCtx = CollectorReply & { callbackQuery?: { message?: { message_id: number } } };

/**
 * Only the NEW press kinds' handlers (`pressAdd`, `pressUndo`): not
 * pre-answered, they answer only through `answerPress(ctx, toast)`.
 */
export type PressCtx = CollectorReply & {
  answerCallbackQuery: (other?: { text?: string }) => Promise<unknown>;
  callbackQuery?: { message?: { message_id: number; reply_to_message?: import('grammy/types').Message } };
};

/** What to write and what to send after a reading or an answer. */
export interface NextStep {
  patch: Partial<IntakeState>;
  text: string;
  keyboard: InlineKeyboard | null;
}

/** The orphaned totals answer's one sentence (judge concurrency-5). */
export const LOST_TOTALS_ANSWER =
  'Hisoblatish to‘plami topilmadi (bot qayta ishga tushgan bo‘lishi mumkin) — 🧮 ni qayta bosing.';

/** «Nothing by that» — what a lookup the free search could not answer is told. */
export const NOT_FOUND_HINT =
  'Topilmadi. Mijoz kodi (GS777), karobka kodi (YW26-000123), yashik (CR-…) yoki partiya kodini yozing.';

/**
 * A bare figure with no collection to answer (review REG-3): «777» is as
 * often a code typed without its letters as a lost «3500», so it is told what
 * a lookup that found nothing is told — plus the one clause for the case it
 * was a totals answer — and is never handed to the paid assistant.
 */
export const BARE_FIGURE_NOT_FOUND = `${NOT_FOUND_HINT}\n(Hisoblatish savoliga javob bo‘lsa — 🧮 ni qayta bosing.)`;

/** «I could not read that» after the totals question — with ITS example. */
const TOTALS_NOT_READ: Record<import('./calc-intake').TotalsAsk, string> = {
  kg: 'Tushunmadim. Brutto og‘irlikni yozing: «3500» yoki «3500 kg».',
  m3: 'Tushunmadim. Umumiy hajmni yozing: «12» yoki «12 kub».',
  both: 'Tushunmadim. «12 kub 3500 kg» ko‘rinishida yozing.',
};

/**
 * After the analysis: ask about the next unpriceable line, or offer the
 * confirm (sub-round C) — the DECISION, pure; `deliverNextStep` writes its
 * patch and sends its words.
 *
 * The loop exists because a rastamojka figure needs a measure PER ROW —
 * `unitsForRow` prices per dona on a count and per kg on a weight and can
 * price a row stating neither only by guessing — and, since 2026-10-09, the
 * figure the row's LAW pins: a 6110 sweater stated in kg still owes its count
 * under «kamida $X/dona» (`lineNeeds`, read with the book's law). Asking the
 * seller now costs one message; not asking costs the VED a request they must
 * hand back.
 *
 * Three questions at most (`MAX_QUESTION_ROUNDS`). A bot that keeps asking is
 * a bot the office stops answering, and the confirm always names what is
 * still missing, so nothing is hidden by stopping.
 *
 * `intake` is wms/calc/intake, handed in: platform never imports wms
 * statically, so the delivery imports it dynamically and the decision reads
 * it from the caller.
 */
export function intakeNextStep(
  state: IntakeState,
  laws: ReadonlyMap<string, import('../../wms/calc/needs').NeedLaw>,
  intake: typeof import('../../wms/calc/intake'),
): NextStep {
  const {
    ambiguousTotalText,
    factsVolumeM3,
    nextLineToAsk,
    lineQuestionText,
    intakeSummaryText,
    volumeFromLines,
    AI_READ_FAILURE,
  } = intake;
  const lineDoneNow = state.lineDone ?? [];
  // The lines dealt with, put onto the goods list as it stands NOW (round-3
  // review, R3-C5): a re-read after «➕ Yana ma'lumot» rebuilds the list, and
  // an index carried over from the old one marked some other line done while
  // the skipped one was asked again. By name, like the per-line answers.
  const skip = resolveLineDone(state.facts.goods, lineDoneNow).map((d) => d.index);
  // BOTH doors ask now (P1.3): the plain «🧮 Hisoblatish» used to land a
  // ten-line rastamojka job with seven lines nobody had a figure for, and a
  // summary that named none of them. The same cap holds.
  const round = state.round ?? 0;
  const line = round < MAX_QUESTION_ROUNDS ? nextLineToAsk(state.section, state.facts, laws, { skip }) : null;

  // The lines dealt with are WRITTEN BACK on every way out (round-2 review,
  // C10): every caller hands this function a `lineDone` with the line it just
  // answered or skipped, and it used to be read for the choice below and then
  // dropped — the stored collection kept the old list, so the next answer or
  // ⏭ rebuilt it from that, and a line skipped with ⏭ was asked again. What
  // is written is every entry, placed where this reading has it and kept as
  // it was where it has not (`carryLineDone`, round-4 review C-r2): writing
  // back only the placed ones let one empty reading erase every ⏭.
  const lineDone = carryLineDone(state.facts.goods, lineDoneNow);
  if (line) {
    return {
      patch: {
        stage: 'question',
        askingIndex: line.index,
        askingTotalsFor: null,
        round: round + 1,
        reasked: false,
        offers: [],
        lineDone,
      },
      text: lineQuestionText(line),
      keyboard: skipKeyboard(),
    };
  }

  // The road is priced on the shipment's TOTALS (the tariff's density band ×
  // m³), so every freight section is asked them ONCE, after the lines, on
  // every door (his 2.7 b — it was the AI podklyuch door alone, and a plain
  // yolkira landed with no kg). The kilos are BRUTTO and only ever asked;
  // the cube is asked only when the lines cannot give it (`factsVolumeM3`),
  // and the question names exactly what it asks (`totalsQuestion`).
  const volume = factsVolumeM3(state.facts);
  const ask = totalsQuestion(state, volume);
  if (ask) {
    // A total the seller typed two ways is WHY it is asked — said beside the
    // question, or «I typed it» is the seller's first thought (review P3-R2).
    const why = state.ambiguousTotals.map((a) => `\n⚠️ ${ambiguousTotalText(a)}`).join('');
    return {
      patch: {
        stage: 'question',
        askingIndex: null,
        askingTotalsFor: ask,
        totalsAsked: true,
        reasked: false,
        offers: [],
        lineDone,
      },
      text: totalsQuestionText(ask, state.facts, { m3: volume, fromLines: volumeFromLines(state.facts) }) + why,
      keyboard: skipKeyboard(),
    };
  }

  // The summary reads nothing the patch changes, so it is the same text over
  // the state before the write as after it.
  const failure = state.aiUsed ? null : (state.aiFailure ?? 'not_configured');
  return {
    patch: { stage: 'review', askingIndex: null, askingTotalsFor: null, offers: [], lineDone },
    text:
      intakeSummaryText({
        section: state.section,
        facts: state.facts,
        laws,
        // Everything the seller typed for the customer, on one line (round-3
        // review, R3-C3): the code or phone the landing finds the customer by
        // is on the one screen checked before «Tasdiqlash» — printed as the
        // lead's name alone, «Ali aka / GS771» could not be caught here.
        clientLabel: intakeClientSummary(state.clientHintRaw),
        fileCount: state.fileCount,
        ambiguous: state.ambiguousTotals,
      }) +
      // The bot's own word on the lines an Excel kept out, each on its own
      // line and never one of the model's three notes (round-4 review, C-r1
      // nit: put first among them, it pushed the third out).
      state.notes.map((n) => `\n\n${n}`).join('') +
      // Why the model's reading is missing, in words (his 1.6 a) — never one
      // sentence for a dead key, a cut answer and a five-second outage. And
      // what WAS read instead: with an Excel, its lines are the goods, so
      // «faqat yozilganidan» was false (round-4 integration S-a).
      (failure
        ? `\n\n⚠️ ${AI_READ_FAILURE[failure].text}\n` +
          ((state.invoiceGoods ?? []).length > 0 ? 'Faqat Excel va yozilganidan o‘qildi.' : 'Faqat yozilganidan o‘qildi.')
        : aiStepsText(state.steps)) +
      (state.ai ? `\n\n📄 Sertifikat: ${state.hasCertificate ? 'bor' : 'yo‘q'} (o‘zgartirish uchun tugmani bosing)` : ''),
    keyboard: reviewKeyboard(
      state.ai ? aiConfirmKeyboard(state.hasCertificate) : confirmKeyboard,
      failure !== null && AI_READ_FAILURE[failure].retry,
    ),
  };
}

/**
 * The laws on the pool, `intakeNextStep`, the write, the words — the one
 * in-handler path after a reading or an answer.
 */
export async function deliverNextStep(ctx: CollectorReply, chatId: bigint, state: IntakeState): Promise<void> {
  const intake = await import('../../wms/calc/intake');
  const laws = await intakeLaws(state);
  const step = intakeNextStep(state, laws, intake);
  updateIntake(chatId, step.patch);
  await ctx.reply(step.text, step.keyboard ? { reply_markup: step.keyboard } : undefined);
}

/**
 * Two or three of the model's own notes on what it did (his 1.6 a: «AI ning
 * 2-3 izohi»). They used to reach only the card's lenta, so the seller saw a
 * list with no word on where it came from.
 */
export function aiStepsText(steps: readonly string[]): string {
  const shown = steps
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((s) => `· ${s.length > 200 ? `${s.slice(0, 199)}…` : s}`);
  return shown.length ? `\n\n🤖 AI:\n${shown.join('\n')}` : '';
}

/** The confirm keyboard, with «🔄 Qayta o‘qish» on top when a retry can help. */
export function reviewKeyboard(
  base: { inline_keyboard: { text: string; callback_data: string }[][] },
  retry: boolean,
): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return retry
    ? { inline_keyboard: [[{ text: '🔄 AI qayta o‘qisin', callback_data: 'c:reread' }], ...base.inline_keyboard] }
    : base;
}

/** «⏭ Bilmayman, o‘tkazib yubor» — under every question, the way out. */
export function skipKeyboard() {
  return { inline_keyboard: [[{ text: '⏭ Bilmayman, o‘tkazib yubor', callback_data: 'c:skip' }]] };
}

/**
 * The buttons a bare or ambiguous number is answered with (judge UX4): one
 * tap writes the line. Each button carries its POSITION (`c:pick_N`, a
 * closed CALC_STEPS word) and the figure lives in `IntakeState.offers`, so
 * the callback stays inside the parser's vocabulary (#937) and a stale press
 * picks nothing it was not offered. Pure, so the derived fence can parse
 * every button it draws.
 */
export function lineOfferKeyboard(labels: readonly string[]) {
  const buttons = labels.slice(0, MAX_OFFERS).map((text, i) => ({ text, callback_data: `c:pick_${i}` }));
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
  return { inline_keyboard: [...rows, ...skipKeyboard().inline_keyboard] };
}

/**
 * The book's law for the collection's codes, read on the pool (#714) —
 * through a dynamic import, because platform never imports wms statically.
 * A failed read answers «no law known»: the line is then asked for a count
 * or a weight, which is the one-measure rule it always had, never a
 * refusal of the whole collection.
 */
export async function intakeLaws(state: IntakeState) {
  try {
    const { bookLawsFor } = await import('../../wms/calc/book-laws');
    return await bookLawsFor((state.facts.goods ?? []).map((g) => g.tnvedCode));
  } catch (err) {
    logger.warn({ err }, '[calc-intake] rates book unreadable — asking by the one-measure rule');
    return new Map();
  }
}

/** Why an answer could not be read — in words, for the one re-ask. */
type LineAnswerRefusal = import('../../wms/calc/intake-manual').LineAnswerRefusal;

const LINE_REFUSAL: Record<LineAnswerRefusal, (detail?: string) => string> = {
  nothing: () => 'Tushunmadim. Masalan: «50 dona», «300 kg», «120 m²» yoki «40 juft».',
  too_large: () => 'Bu son juda katta — miqdorni qayta yozing. TNVED kodi bo‘lsa: «kod 6403990000».',
  code_short: (d) => `«${d ?? ''}» — 9 xonali: boshida 0 tushib qolganmi? Kodni 10 xonada yozing.`,
  cartons: (d) => `${d ?? ''} karobka — karobka soni tovar soni emas. Nechta dona? Masalan: «300 dona».`,
  unknown_unit: (d) => `«${d ?? ''}» — bu birlikni bilmayman. dona, kg, m², juft yoki litrda yozing.`,
  two_pairs: () => 'Bitta qatorda ikki xil o‘lchov — bittasini yozing.',
  unlabelled: () => 'Raqamlarni birlik bilan yozing: «300 dona 150 kg».',
  repeated: () => 'Bitta birlikda ikki xil son — bittasini yozing.',
};

/**
 * The seller's answer to a line question, written onto the row that was
 * asked about.
 *
 * Addressed by INDEX and never by name: two lines of a packing list are
 * routinely called the same thing. An unreadable answer is re-asked ONCE and
 * then kept as material — the VED reads everything the seller sent, so
 * nothing is lost by moving on, and a wrong reading would be a figure nobody
 * stated with a duty computed on it. A BARE number is never a default unit:
 * it is the law's one pinned unit, or buttons (P1.3, judge UX4) — and after
 * the TOTALS question, the unit that question asked (§8.2.5). Exported for
 * the test of that reading alone.
 */
export async function applyLineAnswer(
  ctx: CollectorReply,
  chatId: bigint,
  state: IntakeState,
  text: string,
): Promise<void> {
  const { parseLineAnswer, parseManualFacts } = await import('../../wms/calc/intake-manual');
  const {
    ambiguousTotalText,
    anyMeasureLine,
    bareChoices,
    bareUnitFor,
    figureLabel,
    lineNeeds,
    needFigure,
    numberText,
  } = await import('../../wms/calc/intake');

  const ask = state.askingTotalsFor ?? null;
  if (ask !== null) {
    // A number that names no unit is what the QUESTION asked (his 2.7 b):
    // «3500» after the brutto question is kilograms, «12» after the volume
    // one is cubic metres — read by the house number reader with the unit
    // word put after it, so its «1,200» rule decides and there is no second
    // reader. After the question for BOTH it is neither, and is refused —
    // and so is a bare answer holding TWO figures to a one-unit question
    // (review P3-R7): «12 3500» after the brutto question was read as
    // 3500 kg and the 12, the cube as often as not, dropped in silence.
    const bare = bareTotalsNumber(text);
    const unitless = bare && (ask === 'both' || totalsFigureCount(text) > 1);
    if (unitless && !state.reasked) {
      // Refused, and still kept for the card (law 11): the VED reads it as typed.
      updateIntake(chatId, { reasked: true, answers: [...state.answers, `Umumiy: ${text}`] });
      await ctx.reply('Kub va kg ni birlik bilan yozing: «12 kub 3500 kg»');
      return;
    }
    const read = parseManualFacts(bare && !unitless ? `${text.trim()} ${ask === 'kg' ? 'kg' : 'kub'}` : text);
    // Whatever of the two the answer states; the other keeps what it had.
    // What was READ is kept apart (`totalsAnswer`) and put back on top of
    // every re-read (judge concurrency-4) — the text goes to the card with
    // the per-line answers, never into the material a re-read parses.
    // `at` is now (review CONC-2): an answer is only ever typed to a question
    // asked after a reading of everything, so the answer has seen it all —
    // and material sent after it may state the figure otherwise.
    const totalsAnswer = {
      weightKg: read.weightKg ?? state.totalsAnswer.weightKg,
      volumeM3: read.volumeM3 ?? state.totalsAnswer.volumeM3,
      at: { material: state.material.length, files: state.fileCount },
    };
    const kept =
      updateIntake(chatId, {
        facts: mergeTotalsAnswer(totalsAnswer, state.facts),
        totalsAnswer,
        // …and its «1.2 mi yoki 1200 mi?» goes with it (review P3-3): the
        // summary asked again about the figure just given, beside «to‘liq».
        ambiguousTotals: unansweredAmbiguity(state.ambiguousTotals, totalsAnswer),
        answers: [...state.answers, `Umumiy: ${text}`],
      }) ?? state;
    if (read.ambiguous.length > 0 && !kept.reasked) {
      updateIntake(chatId, { reasked: true });
      await ctx.reply(read.ambiguous.map((a) => ambiguousTotalText(a)).join('\n'));
      return;
    }
    if (read.weightKg == null && read.volumeM3 == null && !kept.reasked) {
      updateIntake(chatId, { reasked: true });
      await ctx.reply(TOTALS_NOT_READ[ask]);
      return;
    }
    await deliverNextStep(ctx, chatId, { ...kept, askingTotalsFor: null, reasked: false });
    return;
  }

  const index = state.askingIndex ?? 0;
  const goods = state.facts.goods ?? [];
  const row = goods[index];
  const answer = row ? parseLineAnswer(text) : parseLineAnswer('');
  // Kept for the card, NOT as material: a re-read takes the shipment's totals
  // from the material, and one line's «150 kg» became the whole truck's
  // weight there (the diagnosis' cause 5).
  const withText = updateIntake(chatId, { answers: [...state.answers, `${index + 1}-qator: ${text}`] }) ?? state;

  if (answer.kind === 'figures') {
    const patch: Partial<NonNullable<IntakeState['facts']['goods']>[number]> = {};
    for (const [key, value] of Object.entries(answer.figures)) {
      if (value !== null) Object.assign(patch, { [key]: value });
    }
    if (answer.code) patch.tnvedCode = answer.code;
    await applyLinePatch(ctx, chatId, withText, index, patch);
    return;
  }

  if (answer.kind === 'bare' || answer.kind === 'ambiguous') {
    // The code that came with it lands first: it may be what pins the unit.
    const coded =
      answer.kind === 'bare' && answer.code
        ? (updateIntake(chatId, {
            facts: {
              ...withText.facts,
              goods: goods.map((g, i) => (i === index ? { ...g, tnvedCode: answer.code } : g)),
            },
          }) ?? withText)
        : withText;
    const laws = await intakeLaws(coded);
    const line =
      lineNeeds(coded.section, coded.facts, laws).find((l) => l.index === index) ??
      // The line owes nothing the law pins and states something already: a
      // bare figure is still offered as a count or a weight.
      anyMeasureLine(index, row!.name);
    if (answer.kind === 'bare') {
      const unit = bareUnitFor(line);
      if (unit) {
        await applyLinePatch(ctx, chatId, coded, index, needFigure(unit, answer.value));
        return;
      }
      const offers = bareChoices(line, row!.unit).map((u) => ({ unit: u, value: answer.value }));
      updateIntake(chatId, { offers });
      await ctx.reply(`${numberText(answer.value)} — qaysi birlikda?`, {
        reply_markup: lineOfferKeyboard(offers.map((o) => figureLabel(o.value, o.unit))),
      });
      return;
    }
    // «1,200 kg» — both readings in the unit it was written in, or in every
    // unit the line could take when it was written bare.
    const written = answer.unit ? needUnitOfSeller(answer.unit) : null;
    const units = answer.unit ? (written ? [written] : []) : bareChoices(line, row!.unit);
    const offers = units.flatMap((u) => [
      { unit: u, value: answer.decimal },
      { unit: u, value: answer.thousands },
    ]);
    if (offers.length === 0) {
      await refuseLine(ctx, chatId, coded, 'cartons');
      return;
    }
    updateIntake(chatId, { offers: offers.slice(0, MAX_OFFERS) });
    await ctx.reply(`${numberText(answer.decimal)} mi yoki ${numberText(answer.thousands)} mi?`, {
      reply_markup: lineOfferKeyboard(offers.slice(0, MAX_OFFERS).map((o) => figureLabel(o.value, o.unit))),
    });
    return;
  }

  await refuseLine(ctx, chatId, withText, answer.reason, answer.detail);
}

/** A unit the seller WROTE, as a figure's unit — a carton is no figure. */
function needUnitOfSeller(
  unit: import('../../wms/calc/units').SellerUnit,
): import('../../wms/calc/needs').NeedUnit | null {
  return unit === 'karobka' ? null : unit;
}

/** One re-ask in words, then the line is passed and the next one asked. */
async function refuseLine(
  ctx: CollectorReply,
  chatId: bigint,
  state: IntakeState,
  reason: LineAnswerRefusal,
  detail?: string,
): Promise<void> {
  if (!state.reasked) {
    updateIntake(chatId, { reasked: true });
    await ctx.reply(LINE_REFUSAL[reason](detail), { reply_markup: skipKeyboard() });
    return;
  }
  const askingIndex = state.askingIndex ?? null;
  const asked = askingIndex === null ? null : doneLine(state.facts.goods, askingIndex);
  const done = asked ? [...(state.lineDone ?? []), asked] : (state.lineDone ?? []);
  await deliverNextStep(ctx, chatId, { ...state, lineDone: done, reasked: false, offers: [] });
}

/**
 * Write a figure onto the asked line, remember it for a re-analysis, and
 * either ask the SAME line for what it still owes (a clothing line answered
 * «150 kg» still owes its count — same round, judge UX4) or move on.
 */
async function applyLinePatch(
  ctx: CollectorReply,
  chatId: bigint,
  state: IntakeState,
  index: number,
  patch: Partial<NonNullable<IntakeState['facts']['goods']>[number]>,
): Promise<void> {
  const { lineNeeds, lineQuestionText } = await import('../../wms/calc/intake');
  const goods = state.facts.goods ?? [];
  const row = goods[index];
  if (!row) {
    await deliverNextStep(ctx, chatId, { ...state, reasked: false, offers: [] });
    return;
  }
  const patched = goods.map((g, i) => (i === index ? { ...g, ...patch } : g));
  const earlier = state.lineAnswers.find((a) => a.index === index);
  const lineAnswers = [
    ...state.lineAnswers.filter((a) => a.index !== index),
    { index, name: row.name, patch: { ...(earlier?.patch ?? {}), ...patch } },
  ];
  const next =
    updateIntake(chatId, {
      facts: { ...state.facts, goods: patched },
      lineAnswers,
      reasked: false,
      offers: [],
    }) ?? state;
  const laws = await intakeLaws(next);
  // Asked again in the SAME round, never as a new one: the seller is still
  // answering the question they were asked. Each re-ask follows an answer
  // they typed or tapped, and «⏭» always leaves.
  const still = lineNeeds(next.section, next.facts, laws).find((l) => l.index === index);
  if (still) {
    updateIntake(chatId, { stage: 'question', askingIndex: index });
    await ctx.reply(`Yozildi. ${lineQuestionText(still)}`, { reply_markup: skipKeyboard() });
    return;
  }
  await deliverNextStep(ctx, chatId, { ...next, lineDone: [...(next.lineDone ?? []), { index, name: row.name }] });
}

/**
 * What an answer to the customer question looks like, by wms's own readers
 * (a dynamic import: platform never imports wms statically) and the company's
 * code prefix. Two facts, kept apart because they answer different things:
 *  - `material` — `looksLikeMaterial`: is it goods rather than a customer?
 *  - `couldBeCustomer` — could it NAME one at all: no goods evidence
 *    (`goodsEvidence` — the material reader's own first test, round-4
 *    integration defect 1) and either a hint `parseClientHint` finds or one
 *    short line that is not a row of bare figures (`figureRow`). Only such a
 *    text may be insisted on as the customer (round-2 review, C3/C7).
 *  - `why` — when it cannot, which of the two it fails (round-3 review,
 *    R3-C6): `goods` = it states goods; `shape` = no goods in it, but several
 *    lines (or one long one) that no hint reads. The refusal of a repeat says
 *    the one that is TRUE: «Rustam / Andijon» sent twice was told it was a
 *    goods list. Null when it could.
 */
export interface CustomerTextRead {
  material: boolean;
  couldBeCustomer: boolean;
  why: 'goods' | 'shape' | null;
}

export async function readCustomerText(raw: string, prefix: string): Promise<CustomerTextRead> {
  const { figureRow, goodsEvidence, looksLikeMaterial } = await import('../../wms/calc/intake-manual');
  const { parseClientHint } = await import('../../wms/calc/intake');
  const text = raw.trim();
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // ONE goods test with the material reader's own first test (round-4
  // integration, defect 1): this side kept the old two-part check, so «Tovar:
  // tayyor» was material on the first send AND a believable customer on the
  // repeat — the lead was named «Tovar: tayyor».
  const goods = goodsEvidence(text, { prefix });
  // A word and a row of bare figures («Kurtka 1200 50 3000») is a packing-list
  // row, never a name — asked AFTER the hint, which reads a phone in the same
  // shape («Ali 90 123 45 67»). Which rows refuse the repeat is `figureRow`'s
  // alone: a count of three kept here as well would believe a pair the reader
  // calls a row («Kafel 2400 36,5», «Kurtka 300 1200» — round-5 probe,
  // collector).
  const hint = parseClientHint(text, { prefix });
  const row = hint === null && figureRow(text);
  const couldBeCustomer = text !== '' && !goods && (hint !== null || (!row && lines.length === 1 && text.length <= 60));
  return {
    material: looksLikeMaterial(raw, { prefix }),
    couldBeCustomer,
    why: couldBeCustomer ? null : goods || row ? 'goods' : 'shape',
  };
}

/**
 * The answer to the customer question — pure, so the rule is a test.
 *
 * Text that looks like goods is MATERIAL and the question is asked again (his
 * 1.7 b). But the goods reader is a guess, and a customer it mistook for a
 * line («Ali aka 2», «OOO Asia Trade 2020») used to loop on the question with
 * no way forward (round-1 review, t23). So the re-ask says WHY, and the SAME
 * text sent again is the seller insisting: it is the customer, and it leaves
 * the material it was filed into — a name read as a goods line is an
 * invented product on the card.
 *
 * Insisting is believed only of a text that COULD be a customer (round-2
 * review, C3/C7): a goods list sent twice — a double forward, or re-sent after
 * the re-ask — became the customer, the lead was named with the goods and the
 * only copy of them left what the model reads. Such a repeat is kept ONCE as
 * material, and the question is asked again without the promise it cannot
 * keep.
 */
export function clientAnswer(
  state: IntakeState,
  raw: string,
  read: CustomerTextRead,
):
  | { kind: 'material'; patch: Partial<IntakeState>; say: string }
  | { kind: 'customer'; patch: Partial<IntakeState> } {
  const text = raw.trim();
  const again = state.clientAskedWith !== null && state.clientAskedWith === text;
  if (read.material && !(again && read.couldBeCustomer)) {
    if (again) {
      // Worded by the reason that is true (R3-C6): a goods list, or a text no
      // hint reads — «Rustam / Andijon» has no goods in it.
      return {
        kind: 'material',
        patch: {},
        say:
          '✍️ Bu matn allaqachon olingan — ikkinchi marta qo‘shilmadi. ' +
          (read.why === 'shape'
            ? 'Bir necha qatorli (yoki uzun) matn mijoz bo‘la olmaydi.\nIsm, kod yoki telefonni bitta qatorda yozing.\n\n'
            : 'Tovar ro‘yxati mijoz bo‘la olmaydi.\nMijozni bitta qatorda yozing: kod yoki telefon.\n\n') +
          CLIENT_QUESTION,
      };
    }
    return {
      kind: 'material',
      patch: { material: [...state.material, raw], clientAskedWith: text },
      say:
        (read.why === 'shape'
          ? '✍️ Ma’lumot sifatida olindi — bu matndan mijozni o‘qib bo‘lmadi.\n'
          : '✍️ Ma’lumot sifatida olindi — tovar ro‘yxatiga o‘xshaydi.\n') +
        'Mijozni bitta qatorda yozing: kod yoki telefon.' +
        (read.couldBeCustomer ? ' (Shu matnni yana yuborsangiz — mijoz deb olinadi.)' : '') +
        '\n\n' +
        CLIENT_QUESTION,
    };
  }
  let material = state.material;
  if (again) {
    const at = material.map((m) => m.trim()).lastIndexOf(text);
    if (at >= 0) material = [...material.slice(0, at), ...material.slice(at + 1)];
  }
  return { kind: 'customer', patch: { clientHintRaw: text, stage: 'material', material, clientAskedWith: null } };
}

/**
 * ONE live «Bo'ldi» control, edited in place.
 *
 * His second report: «har bir sms uchun "bo'ldi tahlil qil" degan sms
 * chiqvotti» — eight forwards left eight identical keyboards and no way to
 * tell which one was current. The prompt now says what has been collected
 * so far and is EDITED rather than re-sent; only when the edit is refused
 * (the message is too old, or was deleted) does a fresh one appear.
 */
export async function showIntakePrompt(
  ctx: CollectorReply & { api: EditApi },
  chatId: bigint,
  state: IntakeState,
): Promise<void> {
  const parts = [
    state.material.length ? `✍️ ${state.material.length} ta xabar` : '',
    state.fileCount ? `📎 ${state.fileCount} ta fayl` : '',
    state.images.length ? `🖼 ${state.images.length} ta rasm o‘qiladi` : '',
    state.pdfs.length ? `📄 ${state.pdfs.length} ta PDF o‘qiladi` : '',
    (state.invoiceGoods ?? []).length ? `📊 fayldan ${(state.invoiceGoods ?? []).length} ta tovar` : '',
    state.imagesSkipped
      ? `⚠️ ${state.imagesSkipped} ta rasm o‘qilmaydi${state.images.length >= MAX_INTAKE_IMAGES ? ` (${MAX_INTAKE_IMAGES} tadan ortig‘i)` : ''}`
      : '',
  ].filter(Boolean);
  const text = `Qabul qilindi: ${parts.join(' · ')}\nYana yuboring yoki «Bo‘ldi» ni bosing.`;

  if (state.promptMessageId !== null) {
    try {
      await ctx.api.editMessageText(String(chatId), state.promptMessageId, text, {
        reply_markup: doneKeyboard,
      });
      return;
    } catch {
      // Too old, deleted, or identical — fall through and send a fresh one.
    }
  }
  const sent = await ctx.reply(text, { reply_markup: doneKeyboard });
  updateIntake(chatId, { promptMessageId: sent.message_id });
}

/**
 * A text the live collection takes: the zone question, the line or totals
 * question, the customer question, or material — the ladder's collector branch,
 * moved here whole so the dispatcher stays a dispatcher (K6).
 *
 * `msg.replyTo` is the bot message this text replies to, or null
 * (regression-5); K reads nothing of `msg`.
 */
export async function routeCollectorText(
  ctx: CollectorReply & { api: EditApi },
  chatId: bigint,
  intake: IntakeState,
  text: string,
  _msg: { date: number; messageId: number; forwarded: boolean; replyTo: number | null },
): Promise<void> {
  if (intake.stage === 'section') {
    // The podklyuch door is waiting for «qayerdan?» — a typed word here
    // is not the customer's name yet, and filing it as one would skip
    // the only question that prices the road.
    await ctx.reply('Avval yuk qayerdan chiqishini tanlang:', {
      reply_markup: zoneKeyboard(await pricedZonesNow()),
    });
    return;
  }
  if (intake.stage === 'question') {
    await applyLineAnswer(ctx, chatId, intake, text);
    return;
  }
  if (intake.stage === 'client') {
    // The goods list forwarded where the customer was asked for (his
    // 1.7 b): it is MATERIAL, and the question is asked again. It used to
    // become the lead's name and was never shown to the model. The
    // company's code prefix is read once, here, off any transaction.
    const read = await readCustomerText(text, await clientCodePrefix());
    const answer = clientAnswer(intake, text, read);
    updateIntake(chatId, answer.patch);
    if (answer.kind === 'material') {
      await ctx.reply(answer.say, { parse_mode: 'Markdown' });
      return;
    }
    // Per section (judge UX14): a customs job is asked for the LINES —
    // «300 dona, 150 kg, 120 m², 40 juft» and the code if known — which
    // the old «kub/kg» prompt never said could be sent.
    const { collectPromptText } = await import('../../wms/calc/intake');
    await ctx.reply(collectPromptText(intake.section), { reply_markup: doneKeyboard });
    return;
  }
  const updated = updateIntake(chatId, {
    stage: 'material',
    material: [...intake.material, text],
  });
  await showIntakePrompt(ctx, chatId, updated ?? intake);
}

/** «⏭ Bilmayman, o‘tkazib yubor». */
export async function pressSkip(ctx: CalcPressCtx, chatId: bigint, state: IntakeState): Promise<void> {
  // Only the question that is OPEN, like `pick_N` (round-1 review, c5): a ⏭
  // under an old question used to run the next-or-confirm step from the
  // facts as they stood — so material sent since, or a collection not yet
  // read at all, reached 'review' with no analysis, and the confirm guard
  // below («only what the seller was SHOWN») trusted that stage.
  if (state.stage !== 'question' || state.analysing) {
    await ctx.reply('Bu tugma eskirgan.');
    return;
  }
  // The skipped line is DONE for this collection — never asked again, not
  // even after «➕ Yana ma'lumot» re-reads the material (P1.3).
  const askingIndex = state.askingIndex ?? null;
  const skipped =
    state.stage === 'question' && askingIndex !== null && (state.askingTotalsFor ?? null) === null
      ? doneLine(state.facts.goods, askingIndex)
      : null;
  const lineDone = skipped ? [...(state.lineDone ?? []), skipped] : (state.lineDone ?? []);
  await deliverNextStep(ctx, chatId, { ...state, lineDone, reasked: false, offers: [] });
}

/**
 * «✖️ Bekor qilish» (`confirmed` = the `cancel_y` press). K: today's body for
 * both — the collection ends at once, and a press with no live collection
 * still hears «Bekor qilindi.» (hence `state` may be null). P3 adds the one
 * confirmation (product-fit-12).
 */
export async function pressCancel(
  ctx: CalcPressCtx,
  chatId: bigint,
  _state: IntakeState | null,
  _confirmed: boolean,
): Promise<void> {
  endIntake(chatId);
  await ctx.reply('Bekor qilindi.');
}

/** A conflict button (`conf_N_add|rep|ved`, P4). K: no conflict exists — «Bu tugma eskirgan.». */
export async function pressConflict(
  ctx: CalcPressCtx,
  _chatId: bigint,
  _state: IntakeState,
  _n: number,
  _choice: 'add' | 'rep' | 'ved',
): Promise<void> {
  await ctx.reply('Bu tugma eskirgan.');
}

/** A button under a bare or ambiguous figure (judge UX4): `pick_N`. */
export async function pressPick(ctx: CalcPressCtx, chatId: bigint, state: IntakeState, n: number): Promise<void> {
  // Only the pending question's own offers can be picked: a press from an
  // older message, or after the line moved on, finds nothing and says so.
  const offer = state.offers[n];
  const askingIndex = state.askingIndex ?? null;
  if (state.stage !== 'question' || askingIndex === null || (state.askingTotalsFor ?? null) !== null || !offer) {
    await ctx.reply('Bu tugma eskirgan.');
    return;
  }
  const { needFigure } = await import('../../wms/calc/intake');
  await applyLinePatch(ctx, chatId, state, askingIndex, needFigure(offer.unit, offer.value));
}

/** «↩️ Bekor qilish» under an echo (`cu:<tag>`, P3). K: no echo has a tag yet. */
export async function pressUndo(ctx: PressCtx, _chatId: bigint, _tag: string): Promise<void> {
  await answerPress(ctx, 'Bu tugma eskirgan.');
}

/**
 * The words (and buttons) for a table-shaped text with no HOLDING collection,
 * or null. `parked` = the live collection when it is parked (P1). Async: P3
 * reaches the wms `line-address.ts` by dynamic import.
 *
 * K: R2's REG-3 split, kept — only a WORDED figure («3500 kg») says a
 * collection was lost; a bare «777» has the lookup's own answer and the clause.
 * `parked` is always null in K, where `holdingIntake` is `activeIntake`.
 */
export async function orphanAnswerSentence(
  text: string,
  _parked: IntakeState | null,
): Promise<{ text: string; keyboard: InlineKeyboard | null } | null> {
  const shape = totalsAnswerShape(text);
  return shape === 'worded'
    ? { text: LOST_TOTALS_ANSWER, keyboard: null }
    : shape === 'bare'
      ? { text: BARE_FIGURE_NOT_FOUND, keyboard: null }
      : null;
}

/** The ✅'s queue line when the tariff reply is on its way (judge concurrency-8). */
export const TARIFF_FOLLOWS =
  '🧮 Hisoblash navbatiga tushdi — tarif bo‘yicha javob alohida xabarda keladi, rasmiy narxni VED beradi.';

/**
 * WHY the job did not reach the VED's queue (audit A38).
 *
 * One constant sentence used to answer every cause, and it sent the person to
 * a door that refuses for the same reason: with twenty open requests the card
 * form says «Ochiq so'rovlar juda ko'p» too. A `Record<string, string>` and
 * not a runtime key: these are the BOT's words, Uzbek, in this file with the
 * rest of them, and an unknown code prints the honest fallback.
 */
export const QUEUE_REFUSAL: Record<string, string> = {
  too_many_open: 'sizda 20 ta ochiq so‘rov bor — VED javob bergach qayta yuboring.',
  too_many_items: 'tovarlar juda ko‘p (1000 dan ortiq).',
  not_found: 'karta topilmadi.',
  note_taken: 'bu material allaqachon yozilgan.',
  note_foreign: 'material boshqa kartaga tegishli.',
  lead_closed: 'lid yopilgan — unga yangi hisob-kitob qo‘shilmaydi; yutilgan bo‘lsa, uning bitimidan yuboring.',
  unauthenticated: 'siz tizimda emassiz.',
  server_behind: 'server yangilanmoqda — biroz keyinroq urinib ko‘ring.',
};

export function queueRefusal(code: string | null | undefined): string {
  return (code && QUEUE_REFUSAL[code]) ?? 'kartadan qo‘lda yuboring.';
}

/** What a landing hands the ✅: the card's words and whether the queue took it. */
export type LandedTarget = Parameters<typeof landedWords>[0] & { queued?: boolean; queueError?: string | null };

/**
 * The ✅ after «Tasdiqlash» — the save branch's own string, MOVED here pure
 * (docs/SAKKIZ-R3.md K11) so P1's resumed landing says the same words. Uch
 * band's and R2's, not reworded. The link is the SENDER's (`landingLinkFor`:
 * a card they can open, the calculation's own screen for the VED, or no line
 * at all), and `tariffFollows` = a section with no customs half, answered from
 * the tariff on its own queue — a reply that can land ABOVE this message, so
 * the sentence says it comes separately, true in either order.
 */
export function landingReplyText(target: LandedTarget, opts: { link: string | null; tariffFollows: boolean }): string {
  return (
    `✅ Saqlandi — ${landedWords(target)}\n` +
    (opts.link ? `${opts.link}\n` : '') +
    '\n' +
    // Honest about which half landed: the material is on the card either
    // way, but only a queued request will be calculated by anybody.
    (target.queued
      ? opts.tariffFollows
        ? TARIFF_FOLLOWS
        : '🧮 Hisoblash navbatiga tushdi — VED xodimi javob beradi.'
      : `⚠️ Hisoblash navbatiga tushmadi: ${queueRefusal(target.queueError)}`)
  );
}

/**
 * What the landing DID, in words (judge product-16): «yangi» only for a card
 * that was minted — a joined lead, the client's empty deal taken over and a
 * retried press's earlier card each say so. Exported for the unit test.
 */
export function landedWords(target: {
  kind: 'deal' | 'lead';
  label: string;
  outcome?: string;
  about?: { clientCode: string; sellerName: string | null } | null;
}): string {
  const card = target.kind === 'deal' ? 'bitim' : 'lid';
  switch (target.outcome) {
    case 'deal':
      return `yangi bitim: ${target.label}`;
    case 'adopted':
      return `bitim: ${target.label} (mijozning bo‘sh bitimiga yozildi)`;
    case 'about':
      return `yangi lid: ${target.label} (${target.about?.clientCode ?? '—'} — ${target.about?.sellerName ? `${target.about.sellerName}ning mijozi` : 'sotuvchisi yo‘q'})`;
    case 'about_joined':
      return `lid: ${target.label} (shu mijoz haqidagi lidingizga qo‘shildi)`;
    case 'lead':
      return `yangi lid: ${target.label}`;
    case 'lead_joined':
      return `lid: ${target.label} (shu raqamdagi lidga qo‘shildi)`;
    case 'retried':
      return `oldingi urinishda ochilgan ${card}: ${target.label}`;
    default:
      return `${card}: ${target.label}`;
  }
}
