import { createHash, randomBytes } from 'node:crypto';
import { logger } from '../logger';
import { drawKeptLast, editGone, keepLastSoon, notModified } from './kept-last';
import { answerPress } from './press';
import { clientCodePrefix } from './staff-bot';
import {
  collectionDoor,
  factsWithAnswer,
  intakeClientSummary,
  MAX_INTAKE_IMAGES,
  MAX_OFFERS,
  unansweredAmbiguity,
  type InlineKeyboard,
  type IntakeEcho,
  type IntakeState,
} from './calc-intake';
import {
  activeIntake,
  addPointerWords,
  endIntake,
  holdingIntake,
  noteOwnMessage,
  nothingNewToRead,
  updateIntake,
} from './calc-store';
import { promptFileLines, type SheetFit } from './calc-files';
import {
  aiConfirmKeyboard,
  certificateButton,
  CLIENT_QUESTION,
  confirmKeyboard,
  doneKeyboard,
  notWholeKeyboard,
  pricedZonesNow,
  zoneKeyboard,
} from './calc-keyboards';
import { totalsAnswerShape } from './totals-shape';
import { aiReadingWhole, TO_VED_LABEL, type ReadingWholeness } from './reading-whole';
import { editMarkup } from './send';

/**
 * The «Hisoblatish» dialogue — what the bot asks, how an answer lands on its
 * row, and the words for every refusal — MOVED out of staff-handlers.ts
 * (docs/SAKKIZ-R3.md K6), which re-exports what a test imports.
 *
 * Since round 3 (his 1.10 c and 1.11 c, §8) the questions are ONE table: after
 * a reading the seller reads every line ✅ or ⚠️ with the reason under it, and
 * fills any of them in one message — by its number or its name. Each answer
 * message gets ONE echo saying what it wrote, what is still missing and how
 * to take it back («↩️ Shu javobni bekor qilish»), and the table is edited in
 * place. The loop that asked one line at a time, its three-round cap and «⏭»
 * are gone.
 *
 * Since the two doors (docs/IKKI-ESHIK.md, his 1a-4a) the plain «🧮» door
 * draws a SUMMARY that asks nothing and writes a typed answer quietly (§2.2);
 * the AI door keeps the TABLE, and an answer to it sends no message of its
 * own either (§3.4): the table is edited, its last block says what the answer
 * did, its keyboard carries the ↩️, and only what was refused or must still be
 * asked gets ONE short reply. The echo message lives on only for a request
 * from before the doors (§0.2). Both share the ONE prompt kept as the last
 * message, the customer and the zone asked once (§1.4-§1.6).
 */

type Intake = typeof import('../../wms/calc/intake');
type NeedLaw = import('../../wms/calc/needs').NeedLaw;
type NeedUnit = import('../../wms/calc/needs').NeedUnit;
type TableRef = import('../../wms/calc/line-address').TableRef;
type TableRow = import('../../wms/calc/line-address').TableRow;
type TableSegment = import('../../wms/calc/line-address').TableSegment;
type TableTarget = import('../../wms/calc/line-address').TableTarget;
type TableRefusal = import('../../wms/calc/line-address').TableRefusal;
type LineAnswer = import('../../wms/calc/intake-manual').LineAnswer;
type GoodsFact = NonNullable<IntakeState['facts']['goods']>[number];

/** A ctx that can speak in the chat: the sent message comes back. */
export type CollectorReply = {
  reply: (text: string, extra?: Record<string, unknown>) => Promise<{ message_id: number }>;
};

/** What editing a sent message needs of grammy's api. */
export type EditApi = {
  editMessageText: (chatId: string, messageId: number, text: string, extra?: Record<string, unknown>) => Promise<unknown>;
  /** The kept-last prompt's delete of its older copy (§1.4) — optional: a test's fake may have none. */
  deleteMessage?: (chatId: string, messageId: number) => Promise<unknown>;
  /** §2.2's 👍 under an answer written quietly — optional and best-effort. */
  setMessageReaction?: (chatId: string, messageId: number, reaction: { type: 'emoji'; emoji: '👍' }[]) => Promise<unknown>;
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

const STALE = 'Bu tugma eskirgan.';
/** §2.4: the addition is being written — the collection takes nothing more. */
const SAVING = '⏳ Qo‘shimcha yozilmoqda — natija kelgach yozing.';
/** A reading in flight — the save guard's own words. */
const ANALYSING = '⏳ Tahlil davom etmoqda — natijani kuting.';

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

/**
 * A table-shaped text with no collection to take it (docs/SAKKIZ-R3.md §2.8,
 * product-fit-19 e). After round 3 a restart does not lose a collection, so
 * the old «bot qayta ishga tushgan bo‘lishi mumkin» is retired; what is left
 * is a collection that ended — or a request already sent, which takes its
 * additions through «➕». No request is in hand here, so no door is KNOWN
 * (docs/IKKI-ESHIK.md §2.5): today's words, the legacy door's (§0.2, review
 * PC-SPEC-10): every request at deploy is NULL, an AI-door one is answered by
 * the AI too, and the pointer to reply to that answer is the one those
 * sellers need. Naming the plain words for a chat whose newest request is
 * 'plain' wants that request read — the orphan guard's.
 */
export const NO_OPEN_COLLECTION = `Ochiq hisoblatish yo‘q (24 soatdan oshgan yoki tugatilgan). ${addPointerWords(null)}`;

/** What every pause line opens with — the collection exists, it only stopped holding the chat. */
const PAUSE_HEAD = '⏸ Hisoblatish to‘xtab turibdi (30 daqiqa yozilmadi)';

/**
 * A table-shaped text (or a bare figure) while the collection is PARKED (§2.7,
 * regression-1): it exists, so «not found» would be false — and it is never
 * silently added either. Its buttons act on the parked collection (the
 * notice joins its own messages).
 *
 * «yoki jadvalga reply qilib yozing» only where there IS a table — the
 * 'review' stage — and no burst is waiting beside it (docs/IKKI-ESHIK.md
 * §4.2): a reply to the table resumes the collection WITHOUT the files the
 * burst's own line offers to take, so it would be the wrong way back.
 */
export function pauseLine(stage: IntakeState['stage'], burstWaiting: boolean): string {
  const reply = stage === 'review' && !burstWaiting ? ' yoki jadvalga reply qilib yozing' : '';
  return `${PAUSE_HEAD} — bu xabar unga qo‘shilmadi.\nDavom etish uchun «▶️ Davom etamiz» ni bosing${reply}.`;
}

/** The pause line of a parked table with nothing waiting beside it — the full sentence. */
export const PAUSE_LINE = pauseLine('review', false);

/**
 * A burst beside a PARKED collection (§4.2): its ONE message, kept last,
 * covering the forwards too — the files are not taken by themselves (1.8 c),
 * «▶️» is his consent.
 */
export function burstPauseLine(parts: number): string {
  return `${PAUSE_HEAD}. Hozirgi ${parts} ta xabar unga hali qo‘shilmagan — «▶️ Davom etamiz» ni bossangiz, qo‘shiladi.`;
}

/**
 * The pause line's buttons. Beside a burst, «▶️» is `c:resume_take` — it takes
 * the burst's parts, read by the pressed message (§4.2) — and «📌 Topshiriq
 * qilish» (Door B's own `fb:task`) appears when the burst holds a forward.
 * Every other «▶️» stays `c:resume`, which takes nothing.
 */
export function pauseKeyboard(burst: { forwards: boolean } | null = null): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: '▶️ Davom etamiz', callback_data: burst ? 'c:resume_take' : 'c:resume' }],
      ...(burst?.forwards ? [[{ text: '📌 Topshiriq qilish', callback_data: 'fb:task' }]] : []),
      [{ text: '✖️ Bekor qilish', callback_data: 'c:cancel' }],
    ],
  };
}

/** «🗑 Hammasi o‘chadi … O‘chiramizmi?» — the one question before a collection with something in it ends. */
function cancelKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: '🗑 Ha, o‘chirish', callback_data: 'c:cancel_y' }],
      [{ text: '▶️ Yo‘q, davom etaman', callback_data: 'c:resume' }],
    ],
  };
}

/**
 * The add collection's table keyboard (§2.4): «✅ Qo‘shish» — or, when the VED
 * has already started on the job, «📨 VED ga yuborish» (product-fit-18), the
 * same press — then «➕ Yana ma’lumot» and «✖️ Bekor qilish». No certificate:
 * an addition never changes it.
 */
export function amendKeyboard(started: boolean): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: started ? '📨 VED ga yuborish' : '✅ Qo‘shish', callback_data: 'c:save' }],
      [{ text: '➕ Yana ma’lumot', callback_data: 'c:more' }],
      [{ text: '✖️ Bekor qilish', callback_data: 'c:cancel' }],
    ],
  };
}

/** The sent message's id, when the transport handed one back. */
function messageIdOf(sent: unknown): number | null {
  const id = (sent as { message_id?: unknown } | null | undefined)?.message_id;
  return typeof id === 'number' ? id : null;
}

/** Is this one of the collection's own bot messages — a reply to it is the table's (regression-5)? */
function ownsMessage(state: IntakeState, id: number): boolean {
  return (
    state.ownMessageIds.includes(id) ||
    id === state.tableMessageId ||
    id === state.promptMessageId ||
    id === state.offersMessageId ||
    state.echoes.some((e) => e.messageId === id)
  );
}

// Which bot door this COLLECTION is lives beside `IntakeState` (calc-intake.ts),
// so the reading asks the very rule the table asks (as-built review DOORS-1).
export { collectionDoor };

/** The plain door «🧮 Hisoblatish» (§2): a summary, no asks — the job lands as it is and the VED asks. */
export const plainCollection = (state: Pick<IntakeState, 'ai' | 'amend' | 'seed' | 'seedDoor'>) =>
  collectionDoor(state) === 'plain';

/**
 * The last line of a summary or table material arrived BELOW (§1.4): its
 * buttons go — they would answer «avval Bo‘ldi» — and the new prompt under
 * the material is the control. Both doors.
 */
export const TABLE_SUPERSEDED = '⬇️ Yangi ma’lumot qo‘shildi — pastdagi «✅ Bo‘ldi» ni bosing, qayta o‘qiladi.';

/**
 * Is the drawn table superseded: collecting again, with something its ✅
 * would refuse to land unread — something SENT since the reading it shows
 * (`nothingNewToRead` reads the reading's own mark): «➕ Yana ma’lumot» and a
 * typed answer alone leave it standing, buttons and closing (review
 * PC-SPEC-5, PC-ADV-6).
 */
function tableSuperseded(state: IntakeState): boolean {
  return state.stage === 'material' && state.tableMessageId !== null && !nothingNewToRead(state);
}

/**
 * The book's law for the collection's codes (and any code an answer is about
 * to write), read on the pool (#714) — through a dynamic import, because
 * platform never imports wms statically. A failed read answers «no law
 * known»: the line is then asked for a count or a weight, which is the
 * one-measure rule it always had, never a refusal of the whole collection.
 */
export async function intakeLaws(state: IntakeState, extraCodes: readonly (string | null)[] = []) {
  try {
    const { bookLawsFor } = await import('../../wms/calc/book-laws');
    return await bookLawsFor([...(state.facts.goods ?? []).map((g) => g.tnvedCode), ...extraCodes]);
  } catch (err) {
    logger.warn({ err }, '[calc-intake] rates book unreadable — asking by the one-measure rule');
    return new Map<string, NeedLaw>();
  }
}

/** What a table needs beyond the state: the wms module, the laws, and an addition's stale totals. */
export interface TableContext {
  intake: Intake;
  laws: ReadonlyMap<string, NeedLaw>;
  stale: readonly ('weightKg' | 'volumeM3')[];
  /** The answer parser's own «which words name this row alone» (line-address.ts, review PF-4). */
  nameWord: import('../../wms/calc/intake').TableInput['nameWord'];
  /**
   * Will the landing pass have a model today (`aiCalcAvailable`) — read once
   * per draw, and only for the AI door's table, whose «kod yo‘q» row and
   * complete closing promise the AI's work only while it holds (§3.1).
   */
  aiAvailable: boolean;
  /**
   * The reader's own fit of the sheet texts (`fitSheetRows` at its budget) —
   * what names the sheet a not-whole table says the model was not shown whole
   * (docs/FAYL-OQISH.md §1.2). Optional: a table drawn without it says the
   * same thing without the name.
   */
  sheetFit?: SheetFit;
}

/**
 * `aiCalcAvailable()` — THE one predicate (review PF-SPEC-4) — through a
 * dynamic import, platform never importing wms statically. A read that fails
 * promises nothing: the uncoded rows are the VED's.
 */
async function aiAvailableNow(): Promise<boolean> {
  try {
    const { aiCalcAvailable } = await import('../../wms/calc/ai-cost');
    return await aiCalcAvailable();
  } catch (err) {
    logger.warn({ err }, '[calc-intake] AI availability unreadable — the uncoded rows are the VED’s');
    return false;
  }
}

/**
 * Which totals a collection's new lines leave stale — P4's one home
 * (`amendTotalsStale`) for an add collection, its rows' answered weights
 * included (a row whose weight was copied from the brutto, lmp-2). A SEEDED
 * collection carries the returned request's brutto as a plain fact (review
 * COMP-4): a line added beyond its rows leaves that brutto behind too, and
 * the table asks «yangilansinmi?» rather than landing it under a ✅.
 */
async function staleTotalsOf(state: IntakeState): Promise<('weightKg' | 'volumeM3')[]> {
  try {
    const goods = state.facts.goods ?? [];
    if (!state.amend) {
      if (!state.seed) return [];
      const { REQUIRED_FIELDS } = await import('../../wms/calc/intake');
      const added = goods.length > state.seed.length;
      return REQUIRED_FIELDS[state.section].includes('weightKg') &&
        added &&
        state.facts.weightKg != null &&
        state.totalsAnswer.weightKg === null
        ? ['weightKg']
        : [];
    }
    const { amendTotalsStale } = await import('../../wms/calc/amend');
    return amendTotalsStale({
      section: state.section,
      stored: { weightKg: state.amend.weightKg, volumeM3: state.amend.volumeM3, items: state.amend.items },
      linesAfter: goods.map((g) => ({ volumeM3: g.volumeM3 ?? null, weightKg: g.weightKg ?? null })),
      added: goods.filter((g) => !g.itemId).length,
      answered: { weightKg: state.totalsAnswer.weightKg !== null, volumeM3: state.totalsAnswer.volumeM3 !== null },
    }).stale;
  } catch (err) {
    logger.warn({ err }, '[calc-intake] stale totals unreadable — none named');
    return [];
  }
}

/**
 * The table's context over a state — also the reading job's (calc-read.ts), so
 * a table the job stores and sends is drawn from the same laws and the same
 * stale totals as every later edit of it.
 */
export async function tableContext(
  state: IntakeState,
  extraCodes: readonly (string | null)[] = [],
): Promise<TableContext> {
  const intake = await import('../../wms/calc/intake');
  const { nameWordFor } = await import('../../wms/calc/line-address');
  const { fitSheetRows } = await import('../../wms/calc/intake-ai');
  const { SHEET_TEXT_BUDGET } = await import('../../wms/deals/goods-file');
  const [laws, stale, aiAvailable] = await Promise.all([
    intakeLaws(state, extraCodes),
    staleTotalsOf(state),
    collectionDoor(state) === 'ai' ? aiAvailableNow() : Promise.resolve(false),
  ]);
  return {
    intake,
    laws,
    stale,
    nameWord: nameWordFor,
    aiAvailable,
    sheetFit: (texts: readonly string[]) => fitSheetRows(texts, SHEET_TEXT_BUDGET),
  };
}

/**
 * Why the model's reading is missing (his 1.6 a) — null when it read, or when
 * nothing was read yet on a collection that carries rows of its own: an
 * addition's stored rows, a seeded collection's returned rows (review PF-7 —
 * «AI ulanmagan (serverda kalit yo‘q)» stood under every seeded table that
 * had never been read at all).
 */
function readingFailure(state: IntakeState): import('../../wms/calc/intake').AiReadFailure | null {
  if (state.aiUsed) return null;
  // «Nothing for the model to read» beside an Excel whose rows WERE read is no
  // failure, on either door (docs/FAYL-OQISH.md §2.1, door-nothing-ai): «⚠️ AI
  // ga o‘qish uchun … yo‘q edi» stood under «📄 … 3 ta tovar o‘qildi».
  if (state.aiFailure === 'nothing_to_read' && (state.invoiceGoods ?? []).length > 0) return null;
  if (state.aiFailure) return state.aiFailure;
  return state.amend || state.seed ? null : 'not_configured';
}

/**
 * The table's fixed tail, unchanged from the summary (§2.1): the bot's own
 * notes, then why the model did not read (and what WAS read instead) or its
 * own notes, then — on the AI door — the certificate. Each on its own block.
 */
function tableTail(state: IntakeState, intake: Intake): string {
  const failure = readingFailure(state);
  const text =
    // The bot's own word on the lines an Excel kept out, each on its own
    // line and never one of the model's three notes (round-4 review, C-r1).
    state.notes.map((n) => `\n\n${n}`).join('') +
    // Why the model's reading is missing, in words (his 1.6 a) — and what WAS
    // read instead: with an Excel, its lines are the goods (round-4 S-a).
    // What WAS read, by what was actually read (docs/FAYL-OQISH.md §2.2): the
    // Excel and the typed text, either, or neither — «Faqat yozilganidan» was
    // said when nothing was typed at all.
    (failure
      ? `\n\n⚠️ ${failureWords(state, failure, intake)}\n${intake.readInsteadWords(state)}`
      : aiStepsText(state.steps)) +
    // A table that points down has no certificate button (§1.4): the line
    // states the answer and points at no press (review PC-SPEC-9).
    (state.ai && !state.amend
      ? `\n\n📄 Sertifikat: ${state.hasCertificate ? 'bor' : 'yo‘q'}${tableSuperseded(state) ? '' : ' (o‘zgartirish uchun tugmani bosing)'}`
      : '');
  return text.replace(/^\n/u, '');
}

/**
 * A failure's sentence on the table. A stored file that did not load (§2.5)
 * is said with its count and the press that heals it, once — the generic
 * words would leave the seller a second remedy to read beside it.
 */
function failureWords(state: IntakeState, failure: import('../../wms/calc/intake').AiReadFailure, intake: Intake): string {
  if (failure === 'files_missing' && (state.filesMissing ?? 0) > 0) {
    return `${state.filesMissing} ta fayl saqlangan joydan olinmadi — «🔄 AI qayta o‘qisin» ni bosing.`;
  }
  return intake.AI_READ_FAILURE[failure].text;
}

/**
 * The AI door's FIRST or seeded collection (docs/FAYL-OQISH.md §1.0) — where
 * «✅ Tasdiqlash» waits on the reading's wholeness. The door is
 * `collectionDoor`'s, never the raw `ai` flag: a returned NULL-door request
 * keeps today's keyboard, closing and landing (critic-door-predicate). An
 * addition is §1.6's, with its own keyboard.
 */
export function aiDoorFirst(state: Pick<IntakeState, 'ai' | 'amend' | 'seed' | 'seedDoor'>): boolean {
  return collectionDoor(state) === 'ai' && !state.amend;
}

/**
 * The reading's wholeness over the LIVE state — the table's rows are the
 * facts' goods, one to one (`tableRowsOf`).
 *
 * An ADDITION (§1.6) is judged by what its own collection read, never by the
 * request it adds to (door-break-5): a table with no goods row is a fact of
 * the STORED request — a pre-deploy «🤖» landing of zero goods, reachable
 * through ➕ for a week — and an addition of the missing brutto alone, read
 * whole, was told «Tovar o‘qilmadi» and saved with no re-pass, so the
 * podklyuch's road priced from exactly those totals was never re-priced.
 * ONE home, asked by the add table's closing and by its save.
 */
export function readingOf(state: IntakeState): ReadingWholeness {
  const whole = aiReadingWhole(state, (state.facts.goods ?? []).length);
  if (!state.amend) return whole;
  const blocking = whole.blocking.filter((r) => r !== 'no_goods');
  return { ...whole, blocking, whole: blocking.length === 0 };
}

/**
 * The first sheet the model was not shown whole (§1.1 f, g): a mapped Excel
 * past the reader's row ceiling, the reader's own stop, or the budget's fit —
 * the fit the seller's receipt line and the model's note already use.
 */
function inputCutOf(state: IntakeState, sheetFit: SheetFit | undefined): import('../../wms/calc/intake').InputCut | null {
  const capped = (state.goodsFiles ?? []).find((f) => f.capped === true);
  if (capped) return { label: capped.label, kept: capped.rows, total: null };
  if (!state.aiInputCut || !sheetFit) return null;
  const all = [...state.sheetTexts, ...state.invoiceTexts];
  if (all.length === 0) return null;
  const fitted = sheetFit(all.map((t) => t.text.trim()));
  for (let i = 0; i < all.length; i += 1) {
    const kept = fitted.kept[i] ?? 0;
    const total = fitted.total[i] ?? 0;
    const label = all[i]!.label ?? 'Jadval';
    if (all[i]!.cut) return { label, kept, total: null };
    if (kept < total) return { label, kept, total };
  }
  return null;
}

/**
 * `inputCutOf` with the reader's own fit loaded — for a caller with no table
 * context (the landing's VED words, §1.3 a). A fit that cannot be loaded names
 * no sheet; the words then say the same thing without the name.
 */
export async function inputCutOfState(state: IntakeState): Promise<import('../../wms/calc/intake').InputCut | null> {
  try {
    const { fitSheetRows } = await import('../../wms/calc/intake-ai');
    const { SHEET_TEXT_BUDGET } = await import('../../wms/deals/goods-file');
    return inputCutOf(state, (texts) => fitSheetRows(texts, SHEET_TEXT_BUDGET));
  } catch (err) {
    logger.warn({ err }, '[calc-intake] sheet fit not loaded — the cut is said without its sheet');
    return inputCutOf(state, undefined);
  }
}

/**
 * The press that lands this collection, as every word and button names it
 * (docs/FAYL-OQISH.md §1.2, door-closing-drawers): ONE function of the live
 * state's wholeness — the closing, the nudge, the echo's confirm, the
 * certificate's fallback, the failed landing's retry and the returned door's
 * opening line all ask it, so none of them names a «✅ Tasdiqlash» the
 * keyboard no longer draws.
 */
export interface LandingPress {
  step: 'save' | 'to_ved';
  label: string;
  /** «…» quoted, as a sentence names a button. */
  name: string;
}

export function landingPress(state: IntakeState): LandingPress {
  const press = (step: LandingPress['step'], label: string): LandingPress => ({ step, label, name: `«${label}»` });
  if (state.amend) return press('save', state.standingAtOpen === 'started' ? '📨 VED ga yuborish' : '✅ Qo‘shish');
  if (aiDoorFirst(state) && !readingOf(state).whole) return press('to_ved', TO_VED_LABEL);
  return press('save', '✅ Tasdiqlash');
}

/**
 * «Saqlab bo‘lmadi — … ni qayta bosing» after a landing that failed — at the
 * press and in the sweep's resume — naming the press that was made: a VED
 * landing (`landAs`) is pressed again as «👤», never as a «✅» it never had.
 */
export function landingRetryWords(state: IntakeState): string {
  const name = aiDoorFirst(state) && state.landAs === 'ved' ? `«${TO_VED_LABEL}»` : landingPress(state).name;
  return `Saqlab bo‘lmadi — ${name} ni qayta bosing.`;
}

/** The table's input — the state as `intakeTableText` reads it. */
function tableInputOf(state: IntakeState, tc: TableContext): import('../../wms/calc/intake').TableInput {
  return {
    section: state.section,
    facts: state.facts,
    laws: tc.laws,
    // Everything the seller typed for the customer, on one line (round-3
    // review, R3-C3): the code or phone the landing finds him by is on the
    // one screen checked before «Tasdiqlash».
    clientLabel: intakeClientSummary(state.clientHintRaw),
    fileCount: state.fileCount,
    ambiguous: state.ambiguousTotals,
    amend: state.amend
      ? {
          cardLabel: state.amend.cardLabel,
          storedCount: state.amend.items.length,
          totalsStale: tc.stale,
          conflicts: state.conflicts,
          askedSeqs: state.askedSeqs,
          started: state.standingAtOpen === 'started',
        }
      : null,
    tail: tableTail(state, tc.intake),
    // A seeded collection's stale brutto too (fix review FR-4): `amend` is
    // null there, and the stale list rode only inside it.
    totalsStale: tc.stale,
    nameWord: tc.nameWord,
    plain: plainCollection(state),
    clash: state.fileTotals?.clash ?? [],
    marker: tableSuperseded(state) ? TABLE_SUPERSEDED : null,
    ai:
      collectionDoor(state) === 'ai'
        ? {
            available: tc.aiAvailable,
            last: lastBlockOf(state, tc),
            // What the reading read (docs/FAYL-OQISH.md §1.1): judged on the
            // live state the table is drawn from, so the closing and the
            // keyboard below it say the same thing.
            reading: { state, whole: readingOf(state), inputCut: inputCutOf(state, tc.sheetFit) },
          }
        : null,
  };
}

/**
 * The parser's view of the table: its rows, every ⚠️ target, and what an
 * unaddressed answer may mean — the asked rows still ⚠️ when the collection
 * was opened from the 2.8 b block (product-fit-3), else everything open.
 */
function tableRefOf(state: IntakeState, tc: TableContext, stage: TableRef['stage']): TableRef {
  const input = tableInputOf(state, tc);
  const rows = tc.intake.tableRowsOf(input);
  const open = tc.intake.tableOpenOf(input);
  const asked = new Set(state.askedSeqs ?? []);
  const preferred = open.filter((t) => 'line' in t && asked.has(rows.find((r) => r.no === t.line)?.seq ?? Number.NaN));
  return { rows, open, preferred: preferred.length > 0 ? preferred : open, stage };
}

/**
 * The table and its keyboard over `state` — the one rendering, read by the
 * delivery and by every edit. A conflict is never a button on either door
 * (his 1a, docs/IKKI-ESHIK.md §1.1): the table names it «… — VED hal
 * qiladi», and the old `conf_N_*` presses answer «eskirgan». A table material
 * arrived below loses its buttons (§1.4) — an EMPTY keyboard, which the edit
 * sends, so Telegram takes them off.
 */
function tableWords(state: IntakeState, tc: TableContext): Pick<NextStep, 'text' | 'keyboard'> {
  const text = tc.intake.intakeTableText(tableInputOf(state, tc));
  // The AI door's ↩️ rides on the table (§3.4) — kept even on a table that
  // points down: the undo is no press the save guard refuses, and the echo
  // that used to carry it is gone.
  const undo = collectionDoor(state) === 'ai' ? undoRows(state) : [];
  if (tableSuperseded(state)) return { text, keyboard: { inline_keyboard: undo } };
  const base = landingKeyboard(state, tc.intake);
  return { text, keyboard: reviewKeyboard({ inline_keyboard: [...undo, ...base.rows] }, base.retry) };
}

/**
 * The table's buttons below its ↩️, and whether «🔄» rides on top — ONE home
 * for the table and the certificate's fallback reply (door-closing-drawers).
 * Not whole on the AI door (docs/FAYL-OQISH.md §1.2): no «✅ Tasdiqlash», and
 * «🔄» only where it can help (`notWholeRetry`); otherwise today's: the add
 * keyboard, the AI door's confirm with its certificate, the plain confirm,
 * each with «🔄» after a failure a retry heals.
 */
function landingKeyboard(state: IntakeState, intake: Intake): { rows: InlineKeyboard['inline_keyboard']; retry: boolean } {
  if (!state.amend && aiDoorFirst(state) && !readingOf(state).whole) {
    return { rows: notWholeKeyboard(state.hasCertificate).inline_keyboard, retry: intake.notWholeRetry(state) };
  }
  const failure = readingFailure(state);
  const base = state.amend
    ? amendKeyboard(state.standingAtOpen === 'started')
    : state.ai
      ? aiConfirmKeyboard(state.hasCertificate)
      : confirmKeyboard;
  return { rows: base.inline_keyboard, retry: failure !== null && intake.AI_READ_FAILURE[failure].retry };
}

/** The newest answer not yet taken back — what the table's ↩️ undoes and its last block names (§3.4). */
function newestEcho(state: IntakeState): IntakeEcho | null {
  return [...state.echoes].reverse().find((e) => !e.undone) ?? null;
}

/**
 * The AI door table's ONE undo (§3.4): «↩️ Oxirgi javobni bekor qilish»,
 * naming the newest answer not taken back. Re-rendered with every edit, so a
 * redelivered press names the tag it was drawn with — and `undone` keeps a
 * second press of it idempotent.
 */
function undoRows(state: IntakeState): InlineKeyboard['inline_keyboard'] {
  const echo = newestEcho(state);
  return echo ? [[{ text: '↩️ Oxirgi javobni bekor qilish', callback_data: `cu:${echo.tag}` }]] : [];
}

/**
 * What a drawn table is compared by — its text AND its keyboard (a certificate
 * press changes only the button). One home (#513): the reading job records
 * the hash of the table it delivered by this same rule.
 */
export function tableHashOf(words: Pick<NextStep, 'text' | 'keyboard'>): string {
  return createHash('sha1').update(words.text).update(JSON.stringify(words.keyboard)).digest('base64');
}

/**
 * After a reading: the TABLE, always (his 1.10 c, §8.2.2) — the decision,
 * pure; `deliverNextStep` writes its patch and sends its words. `intake` is
 * wms/calc/intake, handed in: platform never imports wms statically. `stale`:
 * an add collection's stale totals (P4's `amendTotalsStale`), absent on a new
 * request.
 */
export function intakeNextStep(
  state: IntakeState,
  laws: ReadonlyMap<string, NeedLaw>,
  intake: Intake,
  opts: {
    stale?: readonly ('weightKg' | 'volumeM3')[];
    nameWord: TableContext['nameWord'];
    aiAvailable?: boolean;
    sheetFit?: SheetFit;
  },
): NextStep {
  // A new reading is a new table: what an earlier «↩️» took back is no longer
  // the last thing that happened on it (§3.4).
  const patch: Partial<IntakeState> = { stage: 'review', offers: [], offersMessageId: null, promptMessageId: null, lastUndo: null };
  return {
    // The reading SETTLES the prompt (§1.4): the table is the control now,
    // and the first material after it sends a NEW prompt below it.
    patch,
    ...tableWords(
      { ...state, ...patch },
      {
        intake,
        laws,
        stale: opts.stale ?? [],
        nameWord: opts.nameWord,
        aiAvailable: opts.aiAvailable ?? false,
        sheetFit: opts.sheetFit,
      },
    ),
  };
}

/**
 * The laws on the pool, `intakeNextStep`, the write, the table — the one
 * in-handler path after a reading. The table is read off what was WRITTEN
 * (the store after the patch), not the state handed in: the laws were awaited
 * on the pool, and a reading runs off the poller, so a press can land in
 * between (K's review, U4). The sent table's id is kept, so every answer
 * edits it in place.
 */
export async function deliverNextStep(ctx: CollectorReply, chatId: bigint, state: IntakeState): Promise<void> {
  const tc = await tableContext(state);
  const step = intakeNextStep(state, tc.laws, tc.intake, {
    stale: tc.stale,
    nameWord: tc.nameWord,
    aiAvailable: tc.aiAvailable,
    sheetFit: tc.sheetFit,
  });
  const settled = updateIntake(chatId, step.patch);
  const words = settled ? tableWords(settled, tc) : step;
  const sent = await ctx.reply(words.text, words.keyboard ? { reply_markup: words.keyboard } : undefined);
  const id = messageIdOf(sent);
  if (settled && id !== null) {
    updateIntake(chatId, { tableMessageId: id, tableHash: tableHashOf(words) }, { quiet: true });
    noteOwnMessage(chatId, id);
  }
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


/**
 * The buttons a bare or ambiguous number is answered with (judge UX4): one
 * tap writes the line. Each button carries its POSITION (`c:pick_N`, a
 * closed CALC_STEPS word) and the figure — and the row it answers — lives in
 * `IntakeState.offers`, so the callback stays inside the parser's vocabulary
 * (#937) and a stale press picks nothing it was not offered. No «⏭» any more
 * (product-fit-9): a fresh offer would carry a button that always answers
 * «eskirgan». Pure, so the derived fence can parse every button it draws.
 */
export function lineOfferKeyboard(labels: readonly string[]) {
  const buttons = labels.slice(0, MAX_OFFERS).map((text, i) => ({ text, callback_data: `c:pick_${i}` }));
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
  return { inline_keyboard: rows };
}

/** Why an answer could not be read — in words. */
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

/** A unit the seller WROTE, as a figure's unit — a carton is no figure. */
function needUnitOfSeller(unit: import('../../wms/calc/units').SellerUnit): NeedUnit | null {
  return unit === 'karobka' ? null : unit;
}

/** A row's name as the echo prints it — the table's own 40-character cut. */
const rowLabel = (name: string) => {
  const chars = Array.from(name);
  return chars.length > 40 ? `${chars.slice(0, 39).join('')}…` : name;
};

/** «3-qator», «umumiy brutto», «umumiy hajm», «yo‘nalish» — a target in words: the table's own (`targetWord`, #513). */
const whereOf = (t: TableTarget, intake: Intake) => intake.targetWord(t);

/** The figure an answer stated, as the words show it back («50 dona», «20 kg»). */
function exampleOf(answer: LineAnswer | null, intake: Intake): string {
  if (answer?.kind === 'figures') {
    const f = answer.figures;
    const shown = [
      f.quantity !== null ? intake.figureLabel(f.quantity, 'dona') : null,
      f.weightKg !== null ? intake.figureLabel(f.weightKg, 'kg') : null,
      f.volumeM3 !== null ? intake.figureLabel(f.volumeM3, 'm3') : null,
      f.measureUnit !== null && f.measureQty !== null ? intake.figureLabel(f.measureQty, f.measureUnit) : null,
    ].filter(Boolean);
    if (shown.length > 0) return shown.join(' ');
  }
  if (answer?.kind === 'bare') return intake.numberText(answer.value);
  return '50 dona';
}

/**
 * The parser's refusals, in words (§2.2's table) — a `Record`, so a refusal
 * with no sentence does not compile. The row a figure was meant for is asked,
 * never guessed: a figure on the wrong row is a duty on goods nobody stated.
 */
const TABLE_REFUSAL: Record<TableRefusal, (seg: TableSegment, ref: TableRef, intake: Intake) => string> = {
  no_line: (seg, ref) => `${seg.refused!.detail}-qator yo‘q (jami ${ref.rows.length} ta qator)`,
  name_many: (seg, _ref, intake) => {
    const nos = seg.refused!.candidates ?? [];
    return `«${seg.refused!.detail}» — ${nos.join(', ')}-qatorda bor: raqam bilan yozing, masalan «${nos.at(-1)}: ${exampleOf(seg.answer, intake)}»`;
  },
  name_none: (seg) =>
    `«${seg.refused!.detail}» — jadvalda bunday qator yo‘q. Yangi tovar bo‘lsa «➕ Yana ma’lumot» ni bosing; qator bo‘lsa raqami bilan yozing: «3: 50 dona»`,
  name_mismatch: (seg, ref, intake) => {
    const n = seg.refused!.candidates?.[0] ?? 0;
    const row = ref.rows.find((r) => r.no === n);
    return `${n}-qator «${rowLabel(row?.name ?? '')}», siz «${seg.refused!.detail}» yozdingiz — yangi tovar bo‘lsa «➕ Yana ma’lumot» ni bosing; shu qator bo‘lsa faqat sonini yozing: «${n}: ${exampleOf(seg.answer, intake)}».`;
  },
  no_address: () => NO_ADDRESS,
  address_unclear: (seg) => {
    const n = seg.refused!.detail;
    const rest = seg.raw.trim().replace(/^\d{1,4}\s+/u, '');
    return `«${seg.raw.trim()}» — ${n}-qatorgami yoki ${n} tami? Ikki nuqta bilan yozing: «${n}: ${rest}».`;
  },
  totals_unit: () => 'Umumiy uchun birlik bilan yozing: «jami 3500 kg» yoki «jami 12 kub».',
};

/** «Qaysi qatorga?» — an answer the table cannot place, and a reply to a message that is not the table's. */
const NO_ADDRESS = 'Qaysi qatorga? Raqami bilan yozing: «3: 50 dona». Umumiy og‘irlik bo‘lsa: «jami 3500 kg».';

/** The columns a line's figure lands in, in the order the echo prints them. */
const FIGURE_FIELDS = ['quantity', 'weightKg', 'volumeM3', 'measureQty'] as const;

/** «50 dona · kod 6403990000», «300 → 350 dona» — a line's written figures, each in its own unit. */
function figuresText(before: Partial<GoodsFact>, patch: Partial<GoodsFact>, intake: Intake): string {
  const unitOf = (field: (typeof FIGURE_FIELDS)[number]): NeedUnit =>
    field === 'quantity' ? 'dona' : field === 'weightKg' ? 'kg' : field === 'volumeM3' ? 'm3' : ((patch.measureUnit ?? 'm2') as NeedUnit);
  const parts: string[] = [];
  for (const field of FIGURE_FIELDS) {
    const after = patch[field];
    if (typeof after !== 'number') continue;
    const was = before[field];
    const arrow = typeof was === 'number' && was > 0 && was !== after ? `${intake.numberText(was)} → ` : '';
    parts.push(`${arrow}${intake.figureLabel(after, unitOf(field))}`);
  }
  if (patch.tnvedCode) parts.push(`kod ${patch.tnvedCode}`);
  return parts.join(' · ');
}

/** «umumiy brutto: 3500 kg» / «umumiy hajm: 12 m³» — a total as the echo and the undo print it. */
function totalsItem(field: 'weightKg' | 'volumeM3', value: number, was: number | null | undefined, intake: Intake): string {
  const arrow = typeof was === 'number' && was > 0 && was !== value ? `${intake.numberText(was)} → ` : '';
  return field === 'weightKg'
    ? `umumiy brutto: ${arrow}${intake.figureLabel(value, 'kg')}`
    : `umumiy hajm: ${arrow}${intake.figureLabel(value, 'm3')}`;
}

/**
 * One change an answer makes — a segment the parser read. The conflict
 * button's write is gone with the button (his 1a, docs/IKKI-ESHIK.md §1.1);
 * a typed figure still resolves a conflict (`writeLine`).
 */
type Write = { kind: 'segment'; segment: TableSegment };

/**
 * How a plan treats a segment that would ASK — a bare figure's units, an
 * ambiguous «1,200», a carton count where a count is wanted: offered as
 * buttons (`ask`), or — on the plain door, which asks nothing (§2.2) — kept
 * in `answers` as the seller's words for the VED and never asked.
 */
interface PlanMode {
  ask: boolean;
}

/** What one answer message did, before it is written and said. */
interface Plan {
  state: IntakeState;
  /** Written, in the echo's words. */
  items: string[];
  refusals: string[];
  offers: IntakeState['offers'];
  questions: { target: TableTarget; text: string }[];
  lines: IntakeEcho['lines'];
  totals: IntakeEcho['totals'];
}

/**
 * Apply the answer's writes to a copy of the collection (§8.2.6) — pure but
 * for the laws already read. A line takes R1's arithmetic without its
 * re-ask; a total R2's CONC-2 mark; a route the K15 carrier every reading
 * re-applies. Every write records what it replaced, for the undo.
 */
function planWrites(
  state: IntakeState,
  writes: readonly Write[],
  ref: TableRef,
  tc: TableContext,
  mode: PlanMode = { ask: true },
): Plan {
  const { intake } = tc;
  const work: IntakeState = {
    ...state,
    facts: { ...state.facts, goods: (state.facts.goods ?? []).map((g) => ({ ...g })) },
    lineAnswers: [...state.lineAnswers],
    conflicts: state.conflicts.map((c) => ({ ...c })),
  };
  const plan: Plan = { state: work, items: [], refusals: [], offers: [], questions: [], lines: [], totals: null };
  const goods = () => work.facts.goods!;
  const mark = { material: work.material.length, files: work.fileCount };

  /**
   * `kept`: a code typed over a stored row's own (an add collection) — NOT
   * drawn on the row («yangi kod yozilmadi»), but carried in the answer, so
   * the addition can name it to the VED (`codesKept`, §9.5; review adv-11).
   */
  const writeLine = (row: TableRow, typed: Partial<GoodsFact>, opts: { item?: string; kept?: string } = {}) => {
    const g = goods()[row.index]!;
    // A code the seller typed is HIS (review PF-ADV-11): its source goes with
    // it, so the table never prints it as the model's proposal — and the undo
    // puts the source back with the code (`before`).
    const patch: Partial<GoodsFact> = typed.tnvedCode ? { ...typed, tnvedSource: 'row' } : typed;
    const before: Partial<GoodsFact> = {};
    for (const key of Object.keys(patch) as (keyof GoodsFact)[]) {
      (before as Record<string, unknown>)[key] = g[key] ?? null;
    }
    if (opts.kept) before.tnvedCode = g.tnvedCode ?? null;
    goods()[row.index] = { ...g, ...patch };
    // Keyed by the stored row's id when it has one, else by where the line
    // is placed NOW — an entry placed nowhere this reading (-1) is never
    // matched by index, so this answer cannot delete another line's kept
    // answer (regression-7).
    const itemId = g.itemId ?? null;
    const same = (e: IntakeState['lineAnswers'][number]) => (itemId ? e.itemId === itemId : e.index === row.index && e.index >= 0);
    const at = work.lineAnswers.findIndex(same);
    const answer = { ...(at >= 0 ? work.lineAnswers[at]!.patch : {}), ...patch, ...(opts.kept ? { tnvedCode: opts.kept } : {}) };
    const entry = { index: row.index, name: g.name, patch: answer, itemId };
    // The entry keeps its place in the list: appended after a correction, it
    // came after an orphan of the same name, which then claimed its line on
    // the next reading (review adv-6).
    const kept = work.lineAnswers.filter((e, i) => i === at || !same(e));
    work.lineAnswers = at >= 0 ? kept.map((e) => (same(e) ? entry : e)) : [...kept, entry];
    // An answer to the conflicted FIGURE resolves the conflict (§8.2.6), a
    // «📨 VED» choice included — he answered after all. A weight typed on a
    // row whose COUNT conflicts leaves that question open: marked «o‘rniga»,
    // the file's figure was neither written nor named to the VED (review
    // spec-1, adv-9).
    for (const c of work.conflicts) {
      const value = patch[c.field];
      if (c.itemId !== itemId || typeof value !== 'number' || c.choice === 'add' || c.choice === 'rep') continue;
      c.choice = c.stored !== null && value === c.stored + c.read ? 'add' : 'rep';
    }
    plan.lines.push({ index: row.index, no: row.no, itemId, name: g.name, before, patch: { ...patch, ...(opts.kept ? { tnvedCode: opts.kept } : {}) } });
    const shown = figuresText(before, patch, intake);
    if (opts.item || shown) plan.items.push(opts.item ?? `${row.no}-qator «${rowLabel(g.name)}»: ${shown}`);
  };

  const echoTotals = () =>
    (plan.totals ??= { before: {}, patch: {}, answerBefore: state.totalsAnswer, doubtsBefore: state.ambiguousTotals });

  const writeTotals = (values: { weightKg: number | null; volumeM3: number | null }) => {
    const prev = work.totalsAnswer;
    const shown = { weightKg: work.facts.weightKg ?? null, volumeM3: work.facts.volumeM3 ?? null };
    const totalsAnswer = {
      weightKg: values.weightKg ?? prev.weightKg,
      volumeM3: values.volumeM3 ?? prev.volumeM3,
      // R2's CONC-2 mark: the answer has seen everything sent so far, and
      // what arrives after it may doubt it (re-check p3-3).
      at: mark,
    };
    // Only the fields THIS answer gives retire their doubts: «jami 12 kub»
    // must not silence a standing «3500 or 4200 kg?» (the doubted field
    // stays emptied by `factsWithAnswer`).
    const doubts = unansweredAmbiguity(work.ambiguousTotals, values);
    work.facts = { ...factsWithAnswer(totalsAnswer, doubts, work.facts), goods: goods() };
    work.totalsAnswer = totalsAnswer;
    work.ambiguousTotals = doubts;
    const echo = echoTotals();
    for (const field of ['weightKg', 'volumeM3'] as const) {
      const value = values[field];
      if (value === null) continue;
      if (!(field in echo.before)) echo.before[field] = shown[field];
      echo.patch[field] = value;
      plan.items.push(totalsItem(field, value, shown[field] ?? prev[field], intake));
    }
  };

  const writeRoute = (route: { fromCity: string | null; toCity: string | null }) => {
    const present = {
      ...(route.fromCity ? { fromCity: route.fromCity } : {}),
      ...(route.toCity ? { toCity: route.toCity } : {}),
    };
    const echo = echoTotals();
    for (const key of Object.keys(present) as ('fromCity' | 'toCity')[]) {
      if (!(key in echo.before)) echo.before[key] = work.facts[key] ?? null;
      echo.patch[key] = present[key];
    }
    // Kept beside the facts (K15, durability-17): a re-read rebuilds the
    // facts from the material and would erase a route that lived only there.
    const was = work.routeAnswer;
    work.routeAnswer = {
      ...(was?.fromCity ? { fromCity: was.fromCity } : {}),
      ...(was?.toCity ? { toCity: was.toCity } : {}),
      ...present,
      at: mark,
    };
    work.facts = { ...work.facts, ...present };
    plan.items.push(`yo‘nalish: ${work.facts.fromCity?.trim() || '—'} → ${work.facts.toCity?.trim() || '—'}`);
  };

  const offer = (target: TableTarget, values: { unit: NeedUnit; value: number }[], question: string) => {
    // The plain door asks nothing (§2.2): the words are in `answers` already.
    if (!mode.ask) return;
    // A row is offered whole or asked in words: one whose buttons do not fit
    // under R2's cap used to vanish with no sentence at all (review adv-8).
    if (values.length > MAX_OFFERS - plan.offers.length) {
      const last = values.at(-1)!;
      const figure = intake.figureLabel(last.value, last.unit);
      const example = 'line' in target ? `${target.line}: ${figure}` : `jami ${figure}`;
      plan.refusals.push(`${whereOf(target, intake)}: ${question} Yozib javob bering, masalan «${example}».`);
      return;
    }
    plan.offers.push(...values.map((v) => ({ ...v, target })));
    plan.questions.push({ target, text: question });
  };

  /** The line's need with a code the answer brought — the code may be what pins the unit. */
  const needOf = (row: TableRow) =>
    intake.lineNeeds(work.section, work.facts, tc.laws).find((l) => l.index === row.index) ??
    intake.anyMeasureLine(row.index, goods()[row.index]!.name);

  /**
   * A code on a stored row (an add collection): an EMPTY code is written; a
   * different one is not, and goes to the VED as text (⭐ of Question 3).
   */
  const codeFor = (row: TableRow, code: string | null): string | null | 'kept' => {
    if (!code) return null;
    const g = goods()[row.index]!;
    if (state.amend && g.itemId && g.tnvedCode && g.tnvedCode !== code) return 'kept';
    return g.tnvedCode === code ? null : code;
  };

  const lineAnswer = (row: TableRow, answer: LineAnswer) => {
    const g = goods()[row.index]!;
    if (answer.kind === 'refused') {
      // Every line refusal asks the seller to write it again — «nechta
      // dona?», «Kodni 10 xonada yozing», «bittasini yozing» — and the plain
      // door asks nothing (§2.2, review PC-SPEC-3): the words stay in
      // `answers`, for the VED, and the message takes its 👍.
      if (!mode.ask) return;
      plan.refusals.push(`${row.no}-qator: ${LINE_REFUSAL[answer.reason](answer.detail)}`);
      return;
    }
    if (answer.kind === 'ambiguous') {
      // «1,200 kg» — both readings in the unit it was written in, or in every
      // unit the line could take when it was written bare.
      const need = needOf(row);
      const written = answer.unit ? needUnitOfSeller(answer.unit) : null;
      const units = answer.unit ? (written ? [written] : []) : intake.bareChoices(need, g.unit);
      if (units.length === 0) {
        if (mode.ask) plan.refusals.push(`${row.no}-qator: ${LINE_REFUSAL.cartons(String(answer.thousands))}`);
        return;
      }
      offer(
        { line: row.no },
        units.flatMap((unit) => [
          { unit, value: answer.decimal },
          { unit, value: answer.thousands },
        ]),
        `${intake.numberText(answer.decimal)} mi yoki ${intake.numberText(answer.thousands)} mi?`,
      );
      return;
    }
    const code = codeFor(row, answer.code);
    const kept = code === 'kept' && answer.code ? answer.code : undefined;
    // Said where the seller reads an answer back; the plain door's quiet
    // write carries the code to the VED in the answer and says nothing (§2.2).
    if (kept && mode.ask) {
      plan.refusals.push(`${row.no}-qatorda kod bor (${g.tnvedCode}) — yangi kod yozilmadi, VED ga aytiladi.`);
    }
    const coded = code && code !== 'kept' ? { tnvedCode: code } : {};
    if (answer.kind === 'bare') {
      // The code that came with it lands first: it may be what pins the unit.
      if (code && code !== 'kept') goods()[row.index] = { ...g, tnvedCode: code };
      const need = needOf(row);
      goods()[row.index] = g;
      const unit = intake.bareUnitFor(need);
      if (unit) {
        writeLine(row, { ...coded, ...intake.needFigure(unit, answer.value) }, { kept });
        return;
      }
      if ((code && code !== 'kept') || kept) writeLine(row, coded, { kept });
      offer(
        { line: row.no },
        intake.bareChoices(need, g.unit).map((u) => ({ unit: u, value: answer.value })),
        `${intake.numberText(answer.value)} — qaysi birlikda?`,
      );
      return;
    }
    const patch: Partial<GoodsFact> = { ...coded };
    for (const [key, value] of Object.entries(answer.figures)) {
      if (value !== null) Object.assign(patch, { [key]: value });
    }
    if (Object.keys(patch).length === 0 && !kept) {
      if (code !== 'kept' && mode.ask) plan.refusals.push(`${row.no}-qator: ${LINE_REFUSAL.nothing()}`);
      return;
    }
    writeLine(row, patch, { kept });
  };

  for (const write of writes) {
    const seg = write.segment;
    if (seg.refused) {
      plan.refusals.push(TABLE_REFUSAL[seg.refused.reason](seg, ref, intake));
      continue;
    }
    if (seg.totals) {
      const { weightKg, volumeM3, ambiguous } = seg.totals;
      if (weightKg !== null || volumeM3 !== null) writeTotals({ weightKg, volumeM3 });
      for (const a of ambiguous) {
        offer(
          { totals: a.field },
          [
            { unit: a.field === 'weightKg' ? 'kg' : 'm3', value: a.decimal },
            { unit: a.field === 'weightKg' ? 'kg' : 'm3', value: a.thousands },
          ],
          `${intake.numberText(a.decimal)} mi yoki ${intake.numberText(a.thousands)} mi?`,
        );
      }
      continue;
    }
    if (seg.route) {
      writeRoute(seg.route);
      continue;
    }
    if (seg.at && 'line' in seg.at && seg.answer) {
      const no = seg.at.line;
      const row = ref.rows.find((r) => r.no === no);
      if (row) lineAnswer(row, seg.answer);
    }
  }
  return plan;
}

/**
 * Where a typed answer went, for the card (law 11) — R2's own shape
 * (`{no}-qator: …`, `Umumiy: …`), the text verbatim otherwise. Kept in
 * `answers`, never in the material a re-read parses (the diagnosis' cause 5).
 */
function answersEntry(text: string, segments: readonly TableSegment[]): string {
  if (segments.length > 0 && segments.every((s) => !s.refused)) {
    const lines = new Set(segments.map((s) => (s.at && 'line' in s.at ? s.at.line : null)));
    if (lines.size === 1 && !lines.has(null)) return `${[...lines][0]}-qator: ${text}`;
    if (segments.every((s) => s.totals !== null)) return `Umumiy: ${text}`;
  }
  return text;
}

/** The confirm under an echo that wrote something — the table it confirms is just above (§2.2). */
function confirmRows(state: IntakeState): InlineKeyboard['inline_keyboard'] {
  const press = landingPress(state);
  const confirm = [{ text: press.label, callback_data: `c:${press.step}` }];
  if (state.amend) return [confirm];
  // On the AI door the certificate rides with the confirm (product-fit-20):
  // after a few answers the table that held its toggle is far up.
  if (state.ai) return [confirm, [certificateButton(state.hasCertificate)]];
  return [confirm];
}

/** The landing press in a sentence — `landingPress`'s, so no echo names a «✅» the table no longer draws. */
const confirmName = (state: IntakeState) => landingPress(state).name;

/**
 * What the table still owes after an answer (product-fit-2): «Hamma qator
 * to‘liq», or the ⚠️ targets by number. Said on every echo that wrote
 * something, so the seller never scrolls up to learn whether he is done.
 */
function missingLines(state: IntakeState, tc: TableContext): string[] {
  // Collecting again after «➕ Yana ma’lumot»: the confirm waits for «Bo‘ldi»
  // (the save guard's own words), so the echo never points at a press that
  // would be refused (review adv-18).
  // Nothing sent after it on rows of its own (fix review W-11): the confirm is
  // not refused, so the echo does not point at «Bo‘ldi».
  if (state.stage !== 'review' && !(state.stage === 'material' && nothingNewToRead(state))) {
    return ['Yangi ma’lumot hali o‘qilmagan — avval «Bo‘ldi» ni bosing.'];
  }
  const input = tableInputOf(state, tc);
  const rows = tc.intake.tableRowsOf(input);
  const open = tc.intake.tableOpenOf(input);
  const out: string[] = [];
  const asked = rows.filter((r) => r.seq !== null && (state.askedSeqs ?? []).includes(r.seq));
  if (asked.length > 0 && asked.every((r) => !open.some((t) => 'line' in t && t.line === r.no))) {
    out.push('✅ So‘ralgan sonlar yozildi.');
  }
  if (open.length === 0) {
    out.push(`✅ Hamma qator to‘liq — ${confirmName(state)} ni bosing.`);
    return out;
  }
  out.push(`⚠️ Yana ${open.length} ta: ${tc.intake.openTargetsText(open)}. Bilmasangiz — ${confirmName(state)}, qolganini VED to‘ldiradi.`);
  // Re-computed only when the addition's own reading is whole (§1.6): over a
  // file it did not read, the press adds and nothing re-runs.
  const addWhole = collectionDoor(state) !== 'ai' || readingOf(state).whole;
  if (state.amend && state.standingAtOpen !== 'started' && addWhole) out.push('Qayta hisoblash uchun «✅ Qo‘shish» ni bosing.');
  return out;
}

/** The echo (§2.2): what was written, what was refused, what is asked, and what is still missing. */
function echoWords(
  next: IntakeState,
  plan: Plan,
  echo: IntakeEcho | null,
  tc: TableContext,
): { text: string; keyboard: InlineKeyboard | null } {
  const started = Boolean(next.amend) && next.standingAtOpen === 'started';
  const head = started ? '📝 VED ga yuboriladi:' : '✅ Yozildi:';
  const heading: string[] = [];
  const lines: string[] = [];
  if (plan.items.length === 1) lines.push(started ? `${head} ${plan.items[0]}` : `✅ ${plan.items[0]} yozildi`);
  else if (plan.items.length > 1) {
    heading.push(head);
    lines.push(...plan.items.map((i) => `· ${i}`));
  }
  lines.push(...plan.refusals.map((r) => `⚠️ ${r}`));
  // A bare or ambiguous number keeps R1's words; when one message's offers
  // span several rows, each question and button names its row (§2.2).
  const targets = new Set(plan.offers.map((o) => JSON.stringify(o.target)));
  for (const q of plan.questions) lines.push(targets.size > 1 ? `${whereOf(q.target, tc.intake)}: ${q.text}` : q.text);
  const collecting = next.stage !== 'review';
  const fixed: string[] = [];
  if (echo) {
    fixed.push(...missingLines(next, tc));
    if (next.ai && !next.amend && !collecting) fixed.push(`📄 Sertifikat: ${next.hasCertificate ? 'bor' : 'yo‘q'}`);
  }
  const offerLabels = plan.offers.map((o) => {
    const label = tc.intake.figureLabel(o.value, o.unit);
    return targets.size > 1 ? `${whereOf(o.target, tc.intake)}: ${label}` : label;
  });
  const keyboard = [
    ...lineOfferKeyboard(offerLabels).inline_keyboard,
    ...(echo
      ? [[{ text: '↩️ Shu javobni bekor qilish', callback_data: `cu:${echo.tag}` }], ...(collecting ? [] : confirmRows(next))]
      : []),
  ];
  // Fitted like the table (review adv-3): seventy rows answered in one
  // message made a 4,850-character echo Telegram refuses — after every
  // answer was written, so nothing said what happened and nothing could
  // take it back. What is still missing (and the certificate) never goes.
  const text = tc.intake.fitTelegram(heading, lines, fixed, [], { maxLines: Number.POSITIVE_INFINITY });
  return { text, keyboard: keyboard.length > 0 ? { inline_keyboard: keyboard } : null };
}

/** How many echoes a collection keeps for the undo. */
const ECHOES_KEPT = 30;

/** The table the seller answered is no longer the one on screen — a reading landed while the answer was read. */
const TABLE_MOVED = '⚠️ Jadval yangilandi — javobni yangi jadvalga qarab qayta yozing.';

/**
 * Is the collection still the one an answer was read against? The parse and
 * the laws were awaited (a dynamic import, the pool), and a reading settles
 * off the poller: written over its result, the answer's pre-reading goods,
 * doubts and placements replaced the reading's in silence (review adv-12).
 * Compared by value — the durable store need not hand back one object.
 */
function sameTable(live: IntakeState, state: IntakeState): boolean {
  return live.noteId === state.noteId && JSON.stringify(live.facts) === JSON.stringify(state.facts);
}

/**
 * Write a plan, say its echo, edit the table. The state is written FIRST and
 * whole (one `updateIntake`), so a crash after it loses words, never figures;
 * the echo's own id is written back quietly, for the undo to edit it. The
 * table edit is dispatched BEFORE the echo is awaited, so an echo Telegram
 * refuses still leaves a truthful table (review adv-3).
 *
 * `offers`: what the live buttons become. A typed answer REPLACES them
 * (regression-23 — an older offer message is «eskirgan» from here on); a
 * press passes the live ones on (a pick marks only its own row's `taken`), so
 * one message's buttons for several rows each still write (review adv-7).
 *
 * Answers whether the plan was written: false when the collection is no
 * longer the one the answer was read against (said, nothing written).
 */
async function commitWrites(
  ctx: CollectorReply & { api?: EditApi },
  chatId: bigint,
  state: IntakeState,
  writes: readonly Write[],
  ref: TableRef,
  tc: TableContext,
  offers: { offers: IntakeState['offers']; messageId: number | null } | null = null,
  quiet: QuietCommit | null = null,
): Promise<boolean> {
  const live = activeIntake(chatId);
  if (!live || live.noteId !== state.noteId) {
    await ctx.reply(STALE);
    return false;
  }
  if (!sameTable(live, state)) {
    // Not written — but the words are kept for the card (law 11).
    if (state.answers.length > live.answers.length) {
      updateIntake(chatId, { answers: [...live.answers, ...state.answers.slice(live.answers.length)] });
    }
    await ctx.reply(TABLE_MOVED);
    return false;
  }
  // Planned over the live collection (its echoes and answers as they stand),
  // with the answer's own text — the table it was read against is the same.
  const plan = planWrites({ ...live, answers: state.answers }, writes, ref, tc, { ask: quiet ? quiet.ask : true });
  const wrote = plan.lines.length > 0 || plan.totals !== null;
  const echo: IntakeEcho | null = wrote
    ? { tag: randomBytes(4).toString('hex'), messageId: null, lines: plan.lines, totals: plan.totals, undone: false }
    : null;
  const w = plan.state;
  const next = updateIntake(chatId, {
    facts: w.facts,
    lineAnswers: w.lineAnswers,
    totalsAnswer: w.totalsAnswer,
    ambiguousTotals: w.ambiguousTotals,
    routeAnswer: w.routeAnswer,
    conflicts: w.conflicts,
    answers: w.answers,
    offers: offers ? offers.offers : plan.offers,
    offersMessageId: offers ? offers.messageId : null,
    // The newest answer is the last thing done (§3.4): an earlier «↩️» is no longer what the table's block says.
    ...(echo ? { echoes: [...w.echoes, echo].slice(-ECHOES_KEPT), lastUndo: null } : {}),
  });
  if (!next) return false;
  if (wrote) editTableSoon(ctx, chatId);
  if (quiet) {
    await saidQuietly(ctx, chatId, plan, quiet, tc);
    return true;
  }
  const words = echoWords(next, plan, echo, tc);
  if (!words.text) {
    // Nothing read and nothing written («;» alone): asked, never an empty
    // message Telegram refuses (review adv-17).
    await ctx.reply(`⚠️ ${NO_ADDRESS}`);
    return true;
  }
  const sent = await ctx.reply(words.text, words.keyboard ? { reply_markup: words.keyboard } : undefined);
  const id = messageIdOf(sent);
  if (id !== null) {
    const after = activeIntake(chatId);
    if (after && after.noteId === next.noteId) {
      updateIntake(
        chatId,
        {
          ...(echo ? { echoes: after.echoes.map((e) => (e.tag === echo.tag ? { ...e, messageId: id } : e)) } : {}),
          ...(!offers && plan.offers.length > 0 ? { offersMessageId: id } : {}),
        },
        { quiet: true },
      );
      noteOwnMessage(chatId, id);
    }
  }
  return true;
}

/**
 * The no-echo commit (docs/IKKI-ESHIK.md §2.2, and the AI door's §3.4): the
 * answer is written and the summary or table edited — and the message itself
 * sends nothing. `messageId`: the answer's own message, which takes the 👍.
 * `ask`: whether a segment that needs a question is offered as buttons (the
 * AI door) or kept as words for the VED (the plain door, which asks nothing).
 */
interface QuietCommit {
  messageId: number | null;
  ask: boolean;
}

/**
 * What a quiet commit says: a 👍 under the answer when every segment was
 * taken — best-effort, off the poller (#706), a refused reaction changing
 * nothing — or ONE short reply carrying only what was refused (an addressed
 * refusal's one line) and, where the door asks, the questions with their
 * buttons. Never «✅ Yozildi», never a confirm.
 */
async function saidQuietly(
  ctx: CollectorReply & { api?: EditApi },
  chatId: bigint,
  plan: Plan,
  quiet: QuietCommit,
  tc: TableContext,
): Promise<void> {
  if (plan.refusals.length === 0 && plan.questions.length === 0) {
    // Nothing read and nothing written («;» alone) where the door asks: asked
    // which row, never a 👍 for an answer that wrote nothing (review adv-17).
    // The plain door keeps such words for the VED, and the 👍 says so.
    if (quiet.ask && plan.lines.length === 0 && plan.totals === null) {
      noteOwnMessage(chatId, (await ctx.reply(`⚠️ ${NO_ADDRESS}`)).message_id);
      return;
    }
    if (quiet.messageId !== null && ctx.api?.setMessageReaction) {
      void ctx.api
        .setMessageReaction(String(chatId), quiet.messageId, [{ type: 'emoji', emoji: '👍' }])
        .catch((err: unknown) => logger.info({ err }, '[calc-intake] 👍 not set'));
    }
    return;
  }
  const targets = new Set(plan.offers.map((o) => JSON.stringify(o.target)));
  const lines = [
    ...plan.refusals.map((r) => `⚠️ ${r}`),
    ...plan.questions.map((q) => (targets.size > 1 ? `${whereOf(q.target, tc.intake)}: ${q.text}` : q.text)),
  ];
  const labels = plan.offers.map((o) => {
    const label = tc.intake.figureLabel(o.value, o.unit);
    return targets.size > 1 ? `${whereOf(o.target, tc.intake)}: ${label}` : label;
  });
  const keyboard = lineOfferKeyboard(labels);
  const text = tc.intake.fitTelegram([], lines, [], [], { maxLines: Number.POSITIVE_INFINITY });
  const sent = await ctx.reply(text, keyboard.inline_keyboard.length > 0 ? { reply_markup: keyboard } : undefined);
  const id = messageIdOf(sent);
  if (id === null) return;
  if (plan.offers.length > 0) updateIntake(chatId, { offersMessageId: id }, { quiet: true });
  noteOwnMessage(chatId, id);
}

/**
 * File a text as material — the stage goes back to collecting (§1.4): the
 * summary or table above it is edited to point down (its buttons go), and
 * the ONE prompt is drawn below the text.
 */
async function fileAsMaterial(
  ctx: CollectorReply & { api: EditApi },
  chatId: bigint,
  state: IntakeState,
  text: string,
): Promise<void> {
  updateIntake(chatId, { stage: 'material', material: [...state.material, text] });
  editTableSoon(ctx, chatId);
  drawPromptSoon(ctx, chatId);
}

/** The addressed refusals a plain answer still says in one line (§2.2 a): the seller named a row or a total. */
const ADDRESSED_REFUSALS: ReadonlySet<TableRefusal> = new Set<TableRefusal>([
  'no_line',
  'name_mismatch',
  'totals_unit',
  'name_many',
  'address_unclear',
]);

/**
 * §2.2 (b)'s «ok», «ha», «rahmat» — the words a seller answers a summary with
 * when he has nothing to add, as he types them (apostrophes dropped, both
 * alphabets). A closed list on purpose (review PC-SPEC-1, PC-ADV-4): «no
 * goods» used to be the goods reader's own guess, and a single product name
 * («Shapka», «Ayollar sumkasi») is no goods to it — the forgotten product was
 * nudged at «Tasdiqlash» and kept nowhere.
 */
const ACK_WORDS: ReadonlySet<string> = new Set([
  'ok', 'okay', 'okey', 'oke', 'ha', 'haa', 'xa', 'xaa', 'hop', 'xop', 'xo', 'mayli', 'maili', 'rahmat', 'raxmat',
  'rahmad', 'raxmad', 'rahmet', 'tashakkur', 'katta', 'yaxshi', 'zor', 'tushunarli', 'tushundim', 'boldi', 'bopti',
  'yoq', 'aka', 'opa', 'uka', 'brat', 'akajon', 'spasibo', 'xorosho', 'ponyal', 'thanks', 'thank', 'you', 'thx', 'yes',
  'good', 'fine', 'ок', 'окей', 'да', 'ага', 'нет', 'спасибо', 'спс', 'понял', 'поняла', 'понятно', 'хорошо', 'ладно',
  'норм', 'нормально', 'принял', 'принято', 'ха', 'хоп', 'майли', 'рахмат', 'яхши', 'тушунарли',
]);

/** Says nothing but «understood» (§2.2 b): no figure, and no word beyond `ACK_WORDS` — «ok, rahmat!», «👍». Pure. */
export function plainAck(text: string): boolean {
  if (/\d/u.test(text)) return false;
  const words = text.toLowerCase().replace(/[‘’ʼʻ'`]/gu, '').match(/\p{L}+/gu) ?? [];
  return words.every((w) => ACK_WORDS.has(w));
}

/**
 * What the plain door does with a typed text after its summary (§2.2, as
 * built after the review). Per segment, never for the text as one piece: a
 * row's «3: 150 kg» with «rahmat» — or with a second figure the table could
 * not place — under it used to be «not placed whole», filed as material, and
 * the next reading made that 150 kg the shipment's brutto over the packing
 * list's 3500 (review PC-ADV-1, R3 §0.1(3) — the defect §2.2 exists to keep
 * closed). So:
 *  - `write`: anything placed is written quietly (a figure, a total, a route —
 *    or a row's words that would ASK, kept for the VED); an addressed refusal
 *    keeps its one line; ONE figure placed nowhere beside them gets
 *    `NO_ADDRESS`; a courtesy word beside them is nothing. Goods the table
 *    has no row for (`goods` — a name no row has, or, collecting, a number
 *    naming OTHER goods: «1. Shapka 50 dona» after «➕», review PC-ADV-3) are
 *    filed as material on their own — never the row's figure with them.
 *  - `material`: nothing placed, and goods in it — the whole text, §2.2 (c).
 *  - `unplaced`: nothing placed, a figure placed nowhere («150 kg» the table
 *    cannot tell a row's from the brutto's): kept for the VED as words, never
 *    material, and told how to address it.
 *  - `nudge`: only courtesy words (`plainAck`), or words that name no goods.
 * Pure, exported for the test.
 */
export type PlainVerdict =
  | { kind: 'write'; segments: TableSegment[]; goods: string | null }
  | { kind: 'material' }
  | { kind: 'unplaced' }
  | { kind: 'nudge' };

export function plainVerdict(
  parsed: { segments: readonly TableSegment[]; material: boolean },
  stage: IntakeState['stage'],
): PlainVerdict {
  if (parsed.material) return { kind: 'material' };
  const writes: TableSegment[] = [];
  const goods: string[] = [];
  let unplaced: TableSegment | null = null;
  for (const s of parsed.segments) {
    if (plainAck(s.raw)) continue;
    const reason = s.refused?.reason ?? null;
    if (reason === 'name_none' || (reason === 'name_mismatch' && stage === 'material')) goods.push(s.raw);
    else if (reason !== null && ADDRESSED_REFUSALS.has(reason)) writes.push(s);
    else if (reason !== null || s.at === null) {
      if (/\d/u.test(s.raw)) unplaced ??= s;
    } else writes.push(s);
  }
  if (writes.length > 0) {
    return { kind: 'write', segments: unplaced ? [...writes, unplaced] : writes, goods: goods.length > 0 ? goods.join('\n') : null };
  }
  if (goods.length > 0) return { kind: 'material' };
  return unplaced ? { kind: 'unplaced' } : { kind: 'nudge' };
}

/**
 * §2.2 (b): a text with nothing to write («ok», «ha», «rahmat») is pointed at
 * the press it is waiting for — «Bo‘ldi» only while something new waits to
 * be read: after «➕ Yana ma’lumot» with nothing sent, the summary's own ✅
 * still stands (review PC-ADV-6).
 */
function plainNudge(state: IntakeState): string {
  if (state.stage !== 'review' && !nothingNewToRead(state)) return 'Yangi ma’lumot hali o‘qilmagan — avval «Bo‘ldi» ni bosing.';
  const press = landingPress(state);
  if (state.amend) return `${press.name} ni bosing. Yana ma’lumot bo‘lsa — yuboring.`;
  // Not whole on the AI door (docs/FAYL-OQISH.md §1.2): the press that is drawn.
  if (press.step === 'to_ved') return `VED ga yuborish uchun ${press.name} ni bosing. Yana ma’lumot bo‘lsa — yuboring.`;
  return 'Tasdiqlash uchun «✅ Tasdiqlash» ni bosing. Yana ma’lumot bo‘lsa — yuboring.';
}

/**
 * A typed text on the PLAIN door after its summary — in the summary stage
 * and collecting after a first reading alike (docs/IKKI-ESHIK.md §2.2, DR-1,
 * INT-3), so the same text sent twice is the same thing both times; what
 * each part of it becomes is `plainVerdict`'s. Never material merely because
 * it was typed: a row's «150 kg» filed as material became the shipment's
 * brutto on the next reading (R3 §0.1(3)).
 */
async function applyPlainText(
  ctx: CollectorReply & { api: EditApi },
  chatId: bigint,
  state: IntakeState,
  text: string,
  msg: { messageId: number },
): Promise<void> {
  const { parseTableAnswer } = await import('../../wms/calc/line-address');
  let tc = await tableContext(state);
  const parsed = parseTableAnswer(text, tableRefOf(state, tc, 'review'));
  const verdict = plainVerdict(parsed, state.stage);
  if (verdict.kind === 'material') {
    await fileAsMaterial(ctx, chatId, state, text);
    return;
  }
  if (verdict.kind === 'nudge') {
    // Joins the collection's own messages, so the prompt knows it is no longer last.
    noteOwnMessage(chatId, (await ctx.reply(plainNudge(state))).message_id);
    return;
  }
  if (verdict.kind === 'unplaced') {
    // The seller's words, for the VED (law 11) — never material, never a guess.
    updateIntake(chatId, { answers: [...state.answers, text] });
    noteOwnMessage(chatId, (await ctx.reply(`⚠️ ${NO_ADDRESS}`)).message_id);
    return;
  }
  const codes = verdict.segments.flatMap((s) =>
    s.answer && (s.answer.kind === 'figures' || s.answer.kind === 'bare') && s.answer.code ? [s.answer.code] : [],
  );
  if (codes.some((c) => !tc.laws.has(c))) tc = await tableContext(state, codes);
  // Labelled «N-qator: …» only when ALL of it went there — never a goods line
  // beside it. Goods filed as material on their own are recorded there, once:
  // the whole text here as well put «Shapka 20 dona» on the VED's verbatim
  // record twice (fix review FR-SELL-8).
  const entry = verdict.goods ? answersEntry(verdict.segments.map((s) => s.raw).join('\n'), verdict.segments) : answersEntry(text, parsed.segments);
  const answered = { ...state, answers: [...state.answers, entry] };
  const committed = await commitWrites(
    ctx,
    chatId,
    answered,
    verdict.segments.map((segment) => ({ kind: 'segment', segment }) as const),
    tableRefOf(answered, tc, 'review'),
    tc,
    null,
    { messageId: msg.messageId, ask: false },
  );
  // The goods beside the answer are the next reading's — on their own lines.
  const live = activeIntake(chatId);
  if (committed && verdict.goods && live && live.noteId === state.noteId) {
    await fileAsMaterial(ctx, chatId, live, verdict.goods);
  }
}

/**
 * A typed text the table stage (or a collecting stage after a first reading)
 * takes — the ONE function every answer goes through (§8.2.6). The parser
 * decides what each segment means; a typed goods list is filed as material
 * (rule 4's one way in the table stage), everything else is written,
 * refused in words, or offered as buttons — never a figure on a row the
 * seller did not name. `msg` is the message it came in.
 *
 * On the AI door the answer sends no message of its own (docs/IKKI-ESHIK.md
 * §3.4, his 4a): the table is edited and the message takes a 👍 — or ONE
 * short reply carries only what was refused or must be asked. A request from
 * before the doors (NULL, §0.2) keeps its echo.
 */
export async function applyTableAnswer(
  ctx: CollectorReply & { api: EditApi },
  chatId: bigint,
  state: IntakeState,
  text: string,
  msg: { date: number; messageId: number; forwarded: boolean; replyTo: number | null },
): Promise<void> {
  const stage: TableRef['stage'] = state.stage === 'review' ? 'review' : 'material';
  const ai = collectionDoor(state) === 'ai';
  // The AI door's courtesy words (as-built review CHAT-4): «rahmat», «ok» are
  // no goods name — answered «jadvalda bunday qator yo‘q» and invited to «➕»
  // goods called «rahmat», or, collecting, filed as material whose re-read
  // the ✅ then waited for. Nudged as the plain door nudges them (§2.2 b). A
  // text with no letter at all («;») keeps its NO_ADDRESS (§3.4 as built). A
  // NULL door keeps today's reading (§0.2).
  if (ai && /\p{L}/u.test(text) && plainAck(text)) {
    noteOwnMessage(chatId, (await ctx.reply(plainNudge(state))).message_id);
    return;
  }
  const { parseTableAnswer, materialSegments } = await import('../../wms/calc/line-address');
  let tc = await tableContext(state);
  // Collecting after a reading, the AI door judges per SEGMENT (as-built
  // review CHAT-2, PC-ADV-1's hole on this door): «3: 150 kg\nrahmat» filed
  // whole as material left row 3 unwritten under the ✅. The material stage's
  // own rule still says which segments answer (only «N:», «N-qator», a totals
  // word — R3 §0.1(3)); those are written, a courtesy word is nothing, and
  // the rest — goods — is filed as material on its own. Nothing placed: the
  // whole text is material, as before.
  let segments: TableSegment[];
  let writes: TableSegment[];
  let goods: string | null = null;
  if (ai && stage === 'material') {
    const read = materialSegments(text, tableRefOf(state, tc, 'material'));
    if (!read.some((r) => r.placed)) {
      await fileAsMaterial(ctx, chatId, state, text);
      return;
    }
    segments = read.map((r) => r.segment);
    writes = read.filter((r) => r.placed).map((r) => r.segment);
    const rest = read.filter((r) => !r.placed && !plainAck(r.segment.raw)).map((r) => r.segment.raw);
    goods = rest.length > 0 ? rest.join('\n') : null;
  } else {
    const parsed = parseTableAnswer(text, tableRefOf(state, tc, stage));
    if (parsed.material) {
      await fileAsMaterial(ctx, chatId, state, text);
      return;
    }
    segments = parsed.segments;
    // On the AI door a courtesy word beside an answer is nothing (CHAT-4):
    // the answer keeps its 👍, and nobody is told «rahmat» is no row.
    writes = ai ? segments.filter((s) => !plainAck(s.raw)) : segments;
  }
  // A code the answer brings may pin the unit of its own bare figure: its law
  // is read before anything is decided (R1's «the code lands first»).
  const codes = writes.flatMap((s) =>
    s.answer && (s.answer.kind === 'figures' || s.answer.kind === 'bare') && s.answer.code ? [s.answer.code] : [],
  );
  if (codes.some((c) => !tc.laws.has(c))) tc = await tableContext(state, codes);
  // Labelled «N-qator: …» only when ALL of it went there — never a goods line
  // beside it; goods filed on their own are recorded there, once (FR-SELL-8).
  const entry = goods ? answersEntry(writes.map((s) => s.raw).join('\n'), writes) : answersEntry(text, segments);
  const answered = { ...state, answers: [...state.answers, entry] };
  const committed = await commitWrites(
    ctx,
    chatId,
    answered,
    writes.map((segment) => ({ kind: 'segment', segment }) as const),
    tableRefOf(answered, tc, stage),
    tc,
    null,
    ai ? { messageId: msg.messageId, ask: true } : null,
  );
  // The goods beside the answer are the next reading's — on their own lines.
  const live = activeIntake(chatId);
  if (committed && goods && live && live.noteId === state.noteId) await fileAsMaterial(ctx, chatId, live, goods);
}

/** A table edit in flight per chat — latest wins, an identical one is never sent (performance-5). */
const tableEdits = new Map<string, { again: boolean; ctx: CollectorReply & { api?: EditApi }; running: Promise<void> }>();

// The refused-call predicates live in kept-last.ts — one reading of
// Telegram's refusals for every message this collector edits (§1.4).

/**
 * Redraw the table in place (§8.2.9), off the poller: dispatched `void`, per
 * chat, latest wins — only the newest render is sent, an edit a newer answer
 * superseded is dropped, and a render identical to the last one drawn
 * (`tableHash`) is not sent at all. Telegram's «message is not modified» is
 * success; only another refusal (too old, deleted) sends a fresh table, whose
 * id is kept. The echo stays the awaited reply, so a 429's retry never holds
 * the poller for a table nobody needs twice.
 */
export function editTableSoon(ctx: CollectorReply & { api?: EditApi }, chatId: bigint): void {
  const key = String(chatId);
  const job = tableEdits.get(key);
  if (job) {
    job.again = true;
    job.ctx = ctx;
    return;
  }
  const entry = { again: false, ctx, running: Promise.resolve() };
  tableEdits.set(key, entry);
  entry.running = (async () => {
    try {
      do {
        entry.again = false;
        await drawTable(entry.ctx, chatId).catch((err: unknown) =>
          logger.warn({ err }, '[calc-intake] table edit failed'),
        );
      } while (entry.again);
    } finally {
      tableEdits.delete(key);
    }
  })();
}

/** Every dispatched table edit, settled — the tests' and the stop's wait. */
export async function tableEditsSettled(): Promise<void> {
  while (tableEdits.size > 0) await Promise.all([...tableEdits.values()].map((j) => j.running));
}

async function drawTable(ctx: CollectorReply & { api?: EditApi }, chatId: bigint): Promise<void> {
  const state = activeIntake(chatId);
  // A reading in flight is about to send a NEW table; this one is history.
  if (!state || state.tableMessageId === null || state.analysing || !ctx.api) return;
  const tc = await tableContext(state);
  const live = activeIntake(chatId);
  if (!live || live.noteId !== state.noteId || live.tableMessageId === null) return;
  const words = tableWords(live, tc);
  const hash = tableHashOf(words);
  if (hash === live.tableHash) return;
  try {
    await ctx.api.editMessageText(String(chatId), live.tableMessageId, words.text, { reply_markup: words.keyboard });
  } catch (err) {
    if (editGone(err)) {
      const sent = await ctx.reply(words.text, words.keyboard ? { reply_markup: words.keyboard } : undefined);
      const id = messageIdOf(sent);
      if (id !== null) {
        updateIntake(chatId, { tableMessageId: id }, { quiet: true });
        noteOwnMessage(chatId, id);
      }
    } else if (!notModified(err)) {
      // Not drawn: the hash stays the old one, so the next answer tries again.
      logger.warn({ err }, '[calc-intake] table edit refused — the next answer redraws it');
      return;
    }
  }
  updateIntake(chatId, { tableHash: hash }, { quiet: true });
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
  | { kind: 'material'; patch: Partial<IntakeState>; say: string; lead: string }
  | { kind: 'customer'; patch: Partial<IntakeState> } {
  const text = raw.trim();
  const again = state.clientAskedWith !== null && state.clientAskedWith === text;
  if (read.material && !(again && read.couldBeCustomer)) {
    if (again) {
      // Worded by the reason that is true (R3-C6): a goods list, or a text no
      // hint reads — «Rustam / Andijon» has no goods in it. The question is
      // `CLIENT_QUESTION` below it, asked once (§1.5, review PC-SPEC-11): the
      // goods line's own «Mijozni bitta qatorda yozing: kod yoki telefon»
      // asked it a second time. The shape line keeps its HOW — one line.
      const lead =
        '✍️ Bu matn allaqachon olingan — ikkinchi marta qo‘shilmadi. ' +
        (read.why === 'shape'
          ? 'Bir necha qatorli (yoki uzun) matn mijoz bo‘la olmaydi.\nIsm, kod yoki telefonni bitta qatorda yozing.'
          : 'Tovar ro‘yxati mijoz bo‘la olmaydi.');
      return { kind: 'material', patch: {}, say: `${lead}\n\n${CLIENT_QUESTION}`, lead };
    }
    // The question once (docs/IKKI-ESHIK.md §1.5): the line says what became
    // of the text and why it is not the customer, and the question itself is
    // `CLIENT_QUESTION` — it used to ask «Mijozni bitta qatorda yozing» right
    // above the same question.
    const lead =
      (read.why === 'shape'
        ? '✍️ Ma’lumot sifatida olindi — bu matndan mijozni o‘qib bo‘lmadi.'
        : '✍️ Ma’lumot sifatida olindi — tovar ro‘yxatiga o‘xshaydi.') +
      (read.couldBeCustomer ? ' (Shu matnni yana yuborsangiz — mijoz deb olinadi.)' : '');
    return {
      kind: 'material',
      patch: { material: [...state.material, raw], clientAskedWith: text },
      say: `${lead}\n\n${CLIENT_QUESTION}`,
      lead,
    };
  }
  let material = state.material;
  if (again) {
    const at = material.map((m) => m.trim()).lastIndexOf(text);
    if (at >= 0) material = [...material.slice(0, at), ...material.slice(at + 1)];
  }
  return { kind: 'customer', patch: { clientHintRaw: text, stage: 'material', material, clientAskedWith: null } };
}

/** «📎 4 ta fayl · ✍️ 1 ta xabar» — what a waiting question counts (§1.5, §1.6), files first, or null. */
function receivedCounts(state: Pick<IntakeState, 'fileCount' | 'material'>): string | null {
  const parts = [
    state.fileCount ? `📎 ${state.fileCount} ta fayl` : '',
    state.material.length ? `✍️ ${state.material.length} ta xabar` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** The AI podklyuch door's opening question, before anything was sent. */
export const ZONE_OPENING = '🤖 AI podklyuch: rastamojka + yo‘lkira (tarif narxida).\n\nYuk qayerdan chiqadi?';

/**
 * The zone question (§1.6), asked ONCE per collection: the opening, or — once
 * something has arrived — «Qabul qilindi: 📎 4 ta fayl.» over it, the same
 * message edited to count and kept last, with the zone keyboard. Pure.
 */
export function zoneQuestionText(state: Pick<IntakeState, 'fileCount' | 'material'>, lead: string | null = null): string {
  const received = receivedCounts(state);
  // `lead`: what a take just added (§4.2, review PB-SPEC-1) — its line on top,
  // never a message of its own.
  const asked = received ? `Qabul qilindi: ${received}.\nAvval yuk qayerdan chiqishini tanlang:` : ZONE_OPENING;
  return lead ? `${lead}\n${asked}` : asked;
}

/**
 * The customer question (§1.5), asked ONCE per collection — one message,
 * edited to count and kept last: the door's or the road's opening line while
 * nothing has arrived, «Qabul qilindi: 📎 4 ta fayl · ✍️ 1 ta xabar.» once
 * something has. `lead`: the one line a typed goods list gets (it was filed,
 * and why it is not the customer) — said with the question, never as a
 * second ask. Markdown, as `CLIENT_QUESTION` is. Pure.
 */
export function clientQuestionText(
  state: Pick<IntakeState, 'fileCount' | 'material' | 'route' | 'ai' | 'section' | 'seed' | 'amend'>,
  lead: string | null = null,
): string {
  const received = receivedCounts(state);
  // The road pressed stays said (the zone question became this one); the AI
  // door's opening line only on its own opening, until something has arrived.
  const road = state.route ? `✅ ${state.route.fromCity} → ${state.route.toCity}\n\n` : '';
  const opening = state.seed === null && state.amend === null && state.ai && state.section === 'rastamojka';
  const door = !road && !received && opening ? '🤖 AI rastamojka — faqat bojxona to‘lovlari.\n\n' : '';
  return `${lead ? `${lead}\n\n` : ''}${road}${door}${received ? `Qabul qilindi: ${received}.\n\n` : ''}${CLIENT_QUESTION}`;
}

/** The prompt's last line: what the seller does next. */
const PROMPT_LAST = 'Yana yuboring yoki «Bo‘ldi» ni bosing.';

/**
 * The ONE «Qabul qilindi» prompt (docs/IKKI-ESHIK.md §1.4) — a PURE function
 * of durable state, so every redraw says the same thing: the customer once he
 * is named (§1.5 — never «Tovar ro‘yxatini yuboring» about goods it holds),
 * the counts, a line per model-read file with its CURRENT fit
 * (`promptFileLines`), and the receipt-time notes (`fileNotes`) — what used to
 * be a message per file. Cut to Telegram's 4096 by `fitTelegram`, the file
 * lines first. `tools`: `fitSheetRows` at the reader's cap and wms's
 * `fitTelegram`, handed in — platform never imports wms statically.
 */
export function intakePromptText(
  state: IntakeState,
  tools: { sheetFit: import('./calc-files').SheetFit; fitTelegram: Intake['fitTelegram'] },
  lead: string | null = null,
): string {
  const client = intakeClientSummary(state.clientHintRaw);
  // Files first, as the customer question counts them (§1.5): the prompt that
  // replaces that question kept the same counts in the other order
  // (as-built review CHAT-8).
  const parts = [
    state.fileCount ? `📎 ${state.fileCount} ta fayl` : '',
    state.material.length ? `✍️ ${state.material.length} ta xabar` : '',
    state.images.length ? `🖼 ${state.images.length} ta rasm o‘qiladi` : '',
    (state.invoiceGoods ?? []).length ? `📊 fayldan ${(state.invoiceGoods ?? []).length} ta tovar` : '',
    state.imagesSkipped
      ? `⚠️ ${state.imagesSkipped} ta rasm o‘qilmaydi${state.images.length >= MAX_INTAKE_IMAGES ? ` (${MAX_INTAKE_IMAGES} tadan ortig‘i)` : ''}`
      : '',
  ].filter(Boolean);
  // A door's one line (§4.2's «▶️ Davom etamiz — …») heads it INSIDE the
  // cut, so the 4096 counts it (review PC-ADV-8).
  const head = [
    ...(lead ? [lead] : []),
    ...(client ? [`Mijoz: ${client}`] : []),
    parts.length > 0 ? `Qabul qilindi: ${parts.join(' · ')}` : 'Qabul qilindi.',
  ];
  const lines = [...promptFileLines(state, tools.sheetFit), ...(state.fileNotes ?? [])];
  return tools.fitTelegram(head, lines, [PROMPT_LAST], [], { maxLines: Number.POSITIVE_INFINITY });
}

/** What the live stage shows as its ONE control, or null when the table is it ('review'). */
async function promptWords(
  state: IntakeState,
  lead: string | null,
): Promise<{ text: string; extra: Record<string, unknown> } | null> {
  if (state.stage === 'section') {
    return { text: zoneQuestionText(state, lead), extra: { reply_markup: zoneKeyboard(await pricedZonesNow()) } };
  }
  if (state.stage === 'client') return { text: clientQuestionText(state, lead), extra: { parse_mode: 'Markdown' } };
  if (state.stage !== 'material') return null;
  if (state.material.length === 0 && state.fileCount === 0) {
    // Nothing sent yet (the customer just named): what to send, per section.
    const { collectPromptText } = await import('../../wms/calc/intake');
    return { text: collectPromptText(state.section), extra: { reply_markup: doneKeyboard } };
  }
  const { fitSheetRows } = await import('../../wms/calc/intake-ai');
  const { SHEET_TEXT_BUDGET } = await import('../../wms/deals/goods-file');
  const { fitTelegram } = await import('../../wms/calc/intake');
  // A door's one line above the prompt (the «▶️ Davom etamiz — …» of a take, §4.2): this draw's only.
  const text = intakePromptText(state, { sheetFit: (texts) => fitSheetRows(texts, SHEET_TEXT_BUDGET), fitTelegram }, lead);
  return { text, extra: { reply_markup: doneKeyboard } };
}

/**
 * The largest message id the collection knows of in its chat — what it took
 * (`takenUpTo`) and what it drew (its own messages): the prompt is «still
 * last» while nothing it knows of is newer (`stillLast`).
 */
function newestKnown(state: IntakeState): number | null {
  const ids = [
    state.takenUpTo,
    ...state.ownMessageIds,
    state.tableMessageId ?? 0,
    state.offersMessageId ?? 0,
    ...state.echoes.map((e) => e.messageId ?? 0),
  ];
  const top = Math.max(0, ...ids);
  return top > 0 ? top : null;
}

/** A ctx a kept-last draw speaks through. */
type DrawCtx = CollectorReply & { api?: EditApi };

/**
 * The restart question's hold (docs/FAYL-OQISH.md §2.4, dialog-03,
 * door-restart-hold). «Sizda tugallanmagan yig‘ish bor — boshqatdan
 * boshlaymizmi?» used to stand while the OLD collection went on taking the
 * files sent under it: «🔄 Ha» then wiped them with the rest, and «Bo‘ldi» on
 * the redrawn old prompt read today's file under yesterday's customer. Holding
 * the parts and carrying them over would need a burst model the question is
 * no part of, so the material is refused in words and filed NOWHERE while the
 * question stands — and the seller sends it again after his answer.
 *
 * A forgotten question never jams the chat: past `RESTART_HOLD_MS` it is let
 * go at the next material, which is then taken as before.
 */
export const RESTART_HOLD_MS = 30 * 60_000;

/** §2.4's words, kept last, under every material the question refuses. */
export const RESTART_HOLD =
  '⏸ Avval yuqoridagi savolga javob bering — «🔄 Ha, boshqatdan» yoki «▶️ Yo‘q, davom etaman». Faylni javobdan keyin qayta yuboring.';

/** The hold's message per chat — memory only: a process that lost it sends a fresh copy below. */
const restartHolds = new Map<string, number>();

/** Does the restart question stand on this collection — asked, and inside its 30 minutes? */
export function restartHolding(state: Pick<IntakeState, 'restartAsked'>, now: number = Date.now()): boolean {
  const asked = state.restartAsked ?? null;
  return asked !== null && now - asked.at < RESTART_HOLD_MS;
}

/**
 * The question is over — answered («🔄 Ha», «▶️ Yo‘q»), or the collection was
 * read, saved or cancelled, or the question outlived its 30 minutes: cleared
 * on the collection it stood on (never a newer one), and its buttons stripped,
 * best-effort, so an old «🔄 Ha» cannot wipe a table it was never about.
 */
export function clearRestartAsked(chatId: bigint, state: IntakeState | null = activeIntake(chatId)): void {
  restartHolds.delete(String(chatId));
  const asked = state?.restartAsked ?? null;
  if (!state || !asked) return;
  const live = activeIntake(chatId);
  if (live && live.noteId === state.noteId && live.restartAsked) updateIntake(chatId, { restartAsked: null }, { quiet: true });
  if (asked.messageId !== null) void editMarkup({ chatId, messageId: asked.messageId }).catch(() => {});
}

/**
 * The guard the file door, the forward door and the text ladder ask FIRST,
 * for a message the collection would take (§2.4): true = refused in words,
 * kept last, and nothing filed. `incoming`: the message it came in, so the
 * hold is redrawn below it.
 */
export async function refuseWhileRestartAsked(
  ctx: DrawCtx,
  chatId: bigint,
  state: IntakeState,
  incoming: number | null,
): Promise<boolean> {
  if (!state.restartAsked) return false;
  if (!restartHolding(state)) {
    clearRestartAsked(chatId, state);
    return false;
  }
  const k = String(chatId);
  const drawn = await drawKeptLast(ctx, chatId, restartHolds.get(k) ?? null, incoming, RESTART_HOLD);
  restartHolds.set(k, drawn.messageId);
  noteOwnMessage(chatId, drawn.messageId);
  if (drawn.kept !== null) noteOwnMessage(chatId, drawn.kept);
  return true;
}

/** The lead a queued prompt draw owes, per chat — taken by the run that draws it. */
const pendingLeads = new Map<string, string>();

/**
 * The collection's ONE live question or prompt — the zone question, the
 * customer question, the «Qabul qilindi» prompt (§1.4-§1.6) — drawn AS THE
 * LAST MESSAGE through kept-last.ts: edited while still last, else sent below
 * and the old copy deleted (a copy that cannot be deleted stays among the
 * collection's own messages, so its buttons still work). Coalesced per chat
 * (`keepLastSoon`), so an album or a forward burst moves it once; dispatched
 * off the poller, and drawn from the collection as it stands when it runs.
 * `lead`: one line above it — what a typed goods list at the customer
 * question became (§1.5), or what a take added (§4.2) — said by the draw
 * that runs next, whichever call queued it: a later draw in the same burst (a
 * file of the album, the take's own) replaces the RUN, and it used to take
 * the lead with it (review PC-SPEC-13). A later lead replaces an earlier one.
 */
export function drawPromptSoon(ctx: DrawCtx, chatId: bigint, lead: string | null = null): void {
  const key = String(chatId);
  if (lead) pendingLeads.set(key, lead);
  keepLastSoon(`prompt:${chatId}`, () => {
    const said = pendingLeads.get(key) ?? null;
    pendingLeads.delete(key);
    return drawPrompt(ctx, chatId, said);
  });
}

async function drawPrompt(ctx: DrawCtx, chatId: bigint, lead: string | null): Promise<void> {
  const state = activeIntake(chatId);
  // A reading in flight answers for itself; an addition being saved takes nothing.
  if (!state || state.analysing || state.saving) return;
  const words = await promptWords(state, lead);
  const live = activeIntake(chatId);
  if (!words || !live || live.noteId !== state.noteId || live.stage !== state.stage) return;
  const drawn = await drawKeptLast(ctx, chatId, live.promptMessageId, newestKnown(live), words.text, words.extra);
  const after = activeIntake(chatId);
  if (!after || after.noteId !== state.noteId) return;
  // Bookkeeping, so quiet (docs/SAKKIZ-R3.md §6.2.6): the seller's own action
  // before it already touched the clocks.
  updateIntake(chatId, { promptMessageId: drawn.messageId }, { quiet: true });
  noteOwnMessage(chatId, drawn.messageId);
  if (drawn.kept !== null) noteOwnMessage(chatId, drawn.kept);
}

/**
 * The live stage's control, drawn kept last (§1.4) — the name every door has
 * always called; `state` is no longer read: the draw reads the collection as
 * it stands when it runs.
 */
export async function showIntakePrompt(
  ctx: CollectorReply & { api?: EditApi },
  chatId: bigint,
  _state: IntakeState,
): Promise<void> {
  drawPromptSoon(ctx, chatId);
}

/**
 * A text the live collection takes: the zone question, the customer
 * question, a table answer, or material — the ladder's collector branch,
 * moved here whole so the dispatcher stays a dispatcher (K6).
 *
 * In the table stage a typed text is an ANSWER or it is refused in words
 * (§0.1(3)): «3: 50 dona\n5: 20 kg» typed after the summary used to become
 * material, and the next «Bo‘ldi» read a 20 kg shipment out of it. Only a
 * forward, a file, «➕ Yana ma’lumot» or a typed goods list of several lines
 * whose names meet no row is material. A reply to a bot message that is not
 * this collection's own is never a table answer (regression-5).
 */
export async function routeCollectorText(
  ctx: CollectorReply & { api: EditApi },
  chatId: bigint,
  intake: IntakeState,
  text: string,
  msg: { date: number; messageId: number; forwarded: boolean; replyTo: number | null },
): Promise<void> {
  if (intake.stage === 'section') {
    // The podklyuch door is waiting for «qayerdan?» — a typed word here
    // is not the customer's name yet, and filing it as one would skip
    // the only question that prices the road. The question is asked ONCE
    // (§1.6): its one message is redrawn below this text, never repeated.
    // The text is TAKEN first (review PC-SPEC-2, PC-ADV-5): the prompt is
    // «still last» by what the collection knows of, and a text nothing took
    // was not known — the question was edited in place above it, and the
    // typed «Yiwu» was answered with silence.
    updateIntake(chatId, {});
    drawPromptSoon(ctx, chatId);
    return;
  }
  if (intake.stage === 'client') {
    // The goods list forwarded where the customer was asked for (his
    // 1.7 b): it is MATERIAL, and the question is asked again. It used to
    // become the lead's name and was never shown to the model. The
    // company's code prefix is read once, here, off any transaction.
    const read = await readCustomerText(text, await clientCodePrefix());
    const answer = clientAnswer(intake, text, read);
    // A SEEDED collection already carries the returned request's goods (review
    // PF-8): with its customer named and nothing new sent, the next step is
    // its table — «Tovar ro‘yxatini yuboring» about goods it holds sent the
    // seller looking for a list he had already given.
    const toTable =
      answer.kind === 'customer' &&
      intake.seed !== null &&
      (intake.facts.goods ?? []).length > 0 &&
      intake.material.length === 0 &&
      intake.fileCount === 0;
    const written = updateIntake(chatId, toTable ? { ...answer.patch, stage: 'review' } : answer.patch);
    if (answer.kind === 'material') {
      // Asked ONCE (§1.5): the one question, with this text's one line, is
      // redrawn below it — never a second message asking the same thing.
      drawPromptSoon(ctx, chatId, answer.lead);
      return;
    }
    if (toTable && written) {
      await deliverNextStep(ctx, chatId, written);
      return;
    }
    // Named: the collection's prompt, its first line «Mijoz: …» (§1.5) — or,
    // with nothing sent yet, what to send per section (judge UX14): a customs
    // job is asked for the LINES, «300 dona, 150 kg, 120 m², 40 juft».
    drawPromptSoon(ctx, chatId);
    return;
  }
  const foreign = msg.replyTo !== null && !ownsMessage(intake, msg.replyTo);
  // The plain door asks nothing after its summary (§2.2): a typed text is
  // written quietly, pointed at «Tasdiqlash», or material — one rule in the
  // summary stage AND collecting after a first reading.
  const plain = plainCollection(intake);
  if (intake.stage === 'review') {
    // A customer's words forwarded are material — his «brutto 4200 kg» is
    // his, never the seller's answer (R2 P3-R1).
    if (msg.forwarded) {
      await fileAsMaterial(ctx, chatId, intake, text);
      return;
    }
    if (foreign) {
      updateIntake(chatId, { answers: [...intake.answers, text] });
      await ctx.reply(`⚠️ ${NO_ADDRESS}`);
      return;
    }
    if (plain) await applyPlainText(ctx, chatId, intake, text, msg);
    else await applyTableAnswer(ctx, chatId, intake, text, msg);
    return;
  }
  // Collecting again after a first reading: on the AI door an EXPLICIT «N:»,
  // «N-qator» or totals address is still an answer (the stage stays) and
  // everything else is material; the plain door reads it as its summary does.
  if (!msg.forwarded && !foreign && (intake.facts.goods ?? []).length > 0) {
    if (plain) await applyPlainText(ctx, chatId, intake, text, msg);
    else await applyTableAnswer(ctx, chatId, intake, text, msg);
    return;
  }
  await fileAsMaterial(ctx, chatId, intake, text);
}

/** «⏭ Bilmayman, o‘tkazib yubor» — retired with the question loop; old messages still carry it. */
export async function pressSkip(ctx: CalcPressCtx, _chatId: bigint, _state: IntakeState): Promise<void> {
  await ctx.reply(STALE);
}

/** «3 ta xabar, 2 ta fayl» — what a cancel would throw away; null when nothing. */
function losesText(state: IntakeState): string | null {
  const messages = state.material.length + state.answers.length;
  const parts = [messages > 0 ? `${messages} ta xabar` : null, state.fileCount > 0 ? `${state.fileCount} ta fayl` : null];
  const said = parts.filter(Boolean).join(', ');
  return said || null;
}

/**
 * The reminder and the pause notice both open with ⏸ and ask «davom
 * etamizmi?» themselves — their «✖️ Bekor qilish» IS the answer, and asking
 * again would be one question too many (§2.7).
 */
function fromAskingMessage(ctx: CalcPressCtx): boolean {
  const said = (ctx.callbackQuery?.message as { text?: unknown } | undefined)?.text;
  return typeof said === 'string' && said.startsWith('⏸');
}

/**
 * «✖️ Bekor qilish» (`confirmed` = the `cancel_y` press). A collection now
 * holds up to a day of files and answers, so from the table, an echo or the
 * prompt it first says what goes, once (product-fit-12); from the reminder or
 * the pause notice, or with nothing to lose, it ends at once. While an
 * addition is being written it is refused. `state` null — nothing live —
 * still hears «Bekor qilindi.» and ends nothing (K-review spec-3).
 */
export async function pressCancel(
  ctx: CalcPressCtx,
  chatId: bigint,
  state: IntakeState | null,
  confirmed: boolean,
): Promise<void> {
  if (!state) {
    await ctx.reply('Bekor qilindi.');
    return;
  }
  if (state.saving) {
    await ctx.reply('⏳ Qo‘shimcha yozilmoqda — endi bekor qilib bo‘lmaydi.');
    return;
  }
  const loses = losesText(state);
  if (!confirmed && loses !== null && !fromAskingMessage(ctx)) {
    const sent = await ctx.reply(`🗑 Hammasi o‘chadi: ${loses}. O‘chiramizmi?`, { reply_markup: cancelKeyboard() });
    const id = messageIdOf(sent);
    if (id !== null) noteOwnMessage(chatId, id);
    return;
  }
  endIntake(chatId);
  await ctx.reply('Bekor qilindi.');
}

/** The pressed message's id — the one a press acts from. */
const pressedId = (ctx: CalcPressCtx) => ctx.callbackQuery?.message?.message_id ?? null;

/**
 * A button under a bare or ambiguous figure (judge UX4): `pick_N` — applied to
 * the offer's TARGET row through the same writes as a typed answer, so a press
 * gets the same echo, the same ↩️ and the same missing-line (product-fit-9).
 * Only from the message that drew the LIVE offers (regression-23): `ownsPress`
 * alone let collection A's old offer apply B's live `offers[1]` to B's row.
 */
export async function pressPick(ctx: CalcPressCtx, chatId: bigint, state: IntakeState, n: number): Promise<void> {
  // The plain door asks nothing (docs/IKKI-ESHIK.md §1.3, §2.2): a unit
  // button an older table drew on it writes nothing now.
  if (plainCollection(state)) {
    await ctx.reply(STALE);
    return;
  }
  const offer = state.offers[n];
  const pressed = pressedId(ctx);
  if (state.saving) {
    await ctx.reply(SAVING);
    return;
  }
  if (!offer || offer.taken || state.analysing || pressed === null || pressed !== state.offersMessageId) {
    await ctx.reply(STALE);
    return;
  }
  const tc = await tableContext(state);
  const ref = tableRefOf(state, tc, state.stage === 'review' ? 'review' : 'material');
  const segment: TableSegment = { raw: '', at: offer.target, refused: null, answer: null, totals: null, route: null };
  if ('totals' in offer.target) {
    segment.totals = {
      weightKg: offer.target.totals === 'weightKg' ? offer.value : null,
      volumeM3: offer.target.totals === 'volumeM3' ? offer.value : null,
      ambiguous: [],
    };
  } else if ('line' in offer.target) {
    const figure = tc.intake.needFigure(offer.unit, offer.value);
    segment.answer = {
      kind: 'figures',
      code: null,
      figures: {
        quantity: figure.quantity ?? null,
        weightKg: figure.weightKg ?? null,
        volumeM3: figure.volumeM3 ?? null,
        measureUnit: figure.measureUnit ?? null,
        measureQty: figure.measureQty ?? null,
      },
    };
  }
  // The message's buttons for OTHER rows stay live (§2.2 draws one message
  // for several rows); this row's are spent (review adv-7).
  const same = JSON.stringify(offer.target);
  await commitWrites(
    ctx as CalcPressCtx & { api?: EditApi },
    chatId,
    state,
    [{ kind: 'segment', segment }],
    ref,
    tc,
    {
      offers: state.offers.map((o) => (JSON.stringify(o.target) === same ? { ...o, taken: true } : o)),
      messageId: state.offersMessageId,
    },
    // The AI door's pick is an answer too (§3.4): the table says what it wrote, nothing else does.
    collectionDoor(state) === 'ai' ? { messageId: null, ask: true } : null,
  );
}

const sameValue = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

type EchoLine = IntakeEcho['lines'][number];
type AnswerEntry = IntakeState['lineAnswers'][number];

/**
 * The `lineAnswers` entry an echo line wrote: by its stored row's id, else by
 * name — one still holding what THIS answer wrote, at the place the last
 * reading wrote back, first. One rule for the undo and the table's last block
 * (§3.4), so «↩️» takes back the row the block names (product-fit-11).
 */
function echoEntryOf(lineAnswers: readonly AnswerEntry[], line: EchoLine): AnswerEntry | undefined {
  const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const ours = (e: AnswerEntry) => (line.itemId ? e.itemId === line.itemId : sameName(e.name, line.name));
  const holds = (e: AnswerEntry) =>
    Object.entries(line.patch).every(([k, v]) => sameValue((e.patch as Record<string, unknown>)[k], v));
  const candidates = lineAnswers.filter(ours);
  return (
    candidates.filter(holds).find((e) => e.index === line.index) ??
    candidates.find(holds) ??
    candidates.find((e) => e.index === line.index) ??
    candidates[0]
  );
}

/** How many writes of one action the table's last block names; the rest are counted (the block is never cut). */
const LAST_SHOWN = 3;

/** «head x» — or the head, up to `LAST_SHOWN` «· x» lines and a count: one action's items in the last block. */
function listed(head: string, items: readonly string[]): string[] {
  if (items.length === 0) return [];
  if (items.length === 1) return [`${head} ${items[0]}`];
  const more = items.length - LAST_SHOWN;
  return [head, ...items.slice(0, LAST_SHOWN).map((i) => `· ${i}`), ...(more > 0 ? [`· … va yana ${more} ta`] : [])];
}

/**
 * What one answer wrote, as the table's last block names it NOW (§3.4): each
 * row by where it stands in THIS table — a re-read after «➕ Yana ma’lumot»
 * may have moved it — with the figures it wrote; a total; the road. A code
 * typed over a stored row's own never reached the row: it is the VED's.
 */
function echoItems(state: IntakeState, echo: IntakeEcho, tc: TableContext): string[] {
  const goods = state.facts.goods ?? [];
  const rows = tc.intake.tableRowsOf({ section: state.section, facts: state.facts, laws: tc.laws });
  const items: string[] = [];
  for (const line of echo.lines) {
    const at = line.itemId
      ? goods.findIndex((g) => g.itemId === line.itemId)
      : (echoEntryOf(state.lineAnswers, line)?.index ?? line.index);
    const no = at >= 0 ? (rows.find((r) => r.index === at)?.no ?? null) : null;
    const where = no !== null ? `${no}-qator «${rowLabel(line.name)}»` : `«${rowLabel(line.name)}»`;
    const kept =
      line.itemId !== null && typeof line.before.tnvedCode === 'string' && line.before.tnvedCode !== line.patch.tnvedCode;
    const figures = figuresText(line.before, kept ? { ...line.patch, tnvedCode: undefined } : line.patch, tc.intake);
    // A «📨 VED» line a collection hydrated from before his 1a wrote no figure.
    if (Object.keys(line.patch).length === 0) items.push(`${where} — VED hal qiladi`);
    else if (figures) items.push(`${where} — ${figures}`);
    else if (kept) items.push(`${where} — kod ${line.patch.tnvedCode ?? ''} VED ga aytiladi`);
  }
  const t = echo.totals;
  if (t) {
    for (const field of ['weightKg', 'volumeM3'] as const) {
      const value = t.patch[field];
      if (typeof value !== 'number') continue;
      const was = t.before[field] ?? t.answerBefore[field];
      const arrow = typeof was === 'number' && was > 0 && was !== value ? `${tc.intake.numberText(was)} → ` : '';
      items.push(`${field === 'weightKg' ? 'umumiy brutto' : 'umumiy hajm'} — ${arrow}${lastBlockTotal(field, value, tc)}`);
    }
    if ('fromCity' in t.patch || 'toCity' in t.patch) {
      const from = t.patch.fromCity ?? state.facts.fromCity ?? '—';
      const to = t.patch.toCity ?? state.facts.toCity ?? '—';
      items.push(`yo‘nalish — ${from.trim() || '—'} → ${to.trim() || '—'}`);
    }
  }
  return items;
}

/**
 * A total as the table's LAST block prints it — in the table's own word: a
 * typed volume is «12 kub» on the table's «✅ Hajm: 12 kub» line above it,
 * never «12 m³» (as-built review CHAT-8). The weight as the table prints it.
 */
function lastBlockTotal(field: 'weightKg' | 'volumeM3', value: number, tc: TableContext): string {
  return field === 'weightKg' ? tc.intake.figureLabel(value, 'kg') : `${tc.intake.numberText(value)} kub`;
}

/**
 * The AI door table's LAST block (docs/IKKI-ESHIK.md §3.4, his 4a), right
 * above the buttons: what the last «↩️» took back, when that was the last
 * thing done; then the newest answer still standing — the one the table's
 * ↩️ names — «✍️ Oxirgi javob: 3-qator «Sumka» — 50 juft», or on an
 * addition the VED has started «📝 VED ga yuboriladi: …». The answer's own
 * message says nothing, so this is where the seller reads what it did. Pure
 * over the collection (echo records, not message text), so every redraw says
 * the same thing.
 */
function lastBlockOf(state: IntakeState, tc: TableContext): string[] {
  const undo = state.lastUndo ?? null;
  const echo = newestEcho(state);
  const started = Boolean(state.amend) && state.standingAtOpen === 'started';
  const notes = undo
    ? [...undo.notes.slice(0, LAST_SHOWN), ...(undo.notes.length > LAST_SHOWN ? [`… va yana ${undo.notes.length - LAST_SHOWN} ta`] : [])]
    : [];
  return [
    ...(undo ? [...listed('↩️ Bekor qilindi:', undo.done), ...notes] : []),
    ...(echo ? listed(started ? '📝 VED ga yuboriladi:' : '✍️ Oxirgi javob:', echoItems(state, echo, tc)) : []),
  ];
}

/**
 * Take ONE answer message back (§8.2.7) — pure. The row is found where the
 * answer is NOW (product-fit-11): by its item id, else by the `lineAnswers`
 * entry the echo wrote, at the index the last reading WROTE BACK
 * (`placeByName`) — never the echo's stored `index`, which a re-read after «➕
 * Yana ma’lumot» may have moved onto other goods. A row a LATER answer has
 * changed again is not reverted, and is named. A field an older answer still
 * stands for gets that answer's figure back, on the row and in the answers
 * alike — an answer the last reading placed nowhere included (review
 * spec-4: that branch deleted the older figure too).
 *
 * A totals answer is restored per field (review adv-4): its fields get the
 * previous answer back, and the doubts it retired; a LATER answer to the
 * other total stands. When nothing later stands, that is the previous answer
 * WHOLE, its mark included — nulling a figure alone would keep the newer mark
 * and silence a standing CONC-2 doubt (re-check p3-3).
 */
function undoEcho(
  state: IntakeState,
  echo: IntakeEcho,
  tc: TableContext,
): { patch: Partial<IntakeState>; done: string[]; notes: string[] } {
  const goods = (state.facts.goods ?? []).map((g) => ({ ...g }));
  let lineAnswers = state.lineAnswers.map((e) => ({ ...e, patch: { ...e.patch } }));
  const conflicts = state.conflicts.map((c) => ({ ...c }));
  const rows = tc.intake.tableRowsOf({ section: state.section, facts: state.facts, laws: tc.laws });
  const done: string[] = [];
  const notes: string[] = [];
  const older = state.echoes.slice(0, state.echoes.findIndex((e) => e.tag === echo.tag)).filter((e) => !e.undone);
  const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  type Line = IntakeEcho['lines'][number];
  type Entry = IntakeState['lineAnswers'][number];
  const sameRow = (a: Line, b: { itemId: string | null; name: string }) => (b.itemId ? a.itemId === b.itemId : sameName(a.name, b.name));
  /** A code typed over a stored row's own: carried in the answer for the VED, never drawn on the row (adv-11). */
  const keptCode = (line: Line, key: string, value: unknown) =>
    key === 'tnvedCode' && line.itemId !== null && typeof line.before.tnvedCode === 'string' && line.before.tnvedCode !== value;
  /**
   * The figure an older answer still stands for, on this field of this row:
   * what the row held before THIS answer (`before`) — or, for a kept code,
   * which never reached the row, the older answer's own. Null = no older
   * answer wrote it, and the field leaves the answers.
   */
  const olderValue = (line: Line, key: string): { value: unknown } | null => {
    for (const e of [...older].reverse()) {
      const l = e.lines.find((x) => sameRow(x, line) && key in x.patch);
      if (!l) continue;
      const kept = keptCode(l, key, (l.patch as Record<string, unknown>)[key]);
      const value = kept ? (l.patch as Record<string, unknown>)[key] : (line.before as Record<string, unknown>)[key];
      return value === null || value === undefined ? null : { value };
    }
    return null;
  };
  /** A «📨 VED» line (an echo a hydrated collection kept from the retired button): it wrote no figure — its `before` names the conflict's field. */
  const vedLine = (l: Line) => Object.keys(l.patch).length === 0;
  /**
   * The choice a conflict goes back to when the figure that resolved it is
   * taken back: the VED's (R3 interp 9's unanswered default, docs/IKKI-
   * ESHIK.md §1.1) — never null, which a table once drew as three buttons
   * that now only answer «eskirgan».
   */
  const priorChoice = (_c: (typeof conflicts)[number]) => 'ved' as const;
  /** Take this answer's `keys` out of the entry, an older answer's figure back where one stands. */
  const revert = (entry: Entry, line: Line, keys: readonly string[]) => {
    const patch = { ...entry.patch } as Record<string, unknown>;
    for (const k of keys) {
      const was = olderValue(line, k);
      if (was) patch[k] = was.value;
      else delete patch[k];
    }
    lineAnswers = lineAnswers
      .map((e) => (e === entry ? { ...e, patch: patch as typeof e.patch } : e))
      .filter((e) => Object.keys(e.patch).length > 0);
  };

  for (const line of echo.lines) {
    const fields = Object.keys(line.patch);
    const rowNo = () => rows.find((r) => (line.itemId ? goods[r.index]?.itemId === line.itemId : false))?.no ?? line.no;
    if (vedLine(line)) {
      // «📨 VED» wrote no figure, so its undo restores none (review spec-2,
      // adv-10): written back, its `before` landed over a figure the seller
      // typed AFTER it. Only the choice goes back — while it is still the VED's.
      const c = conflicts.find((x) => x.itemId === line.itemId && x.field in line.before);
      if (c && c.choice === 'ved') {
        // The VED's it stays (§1.1): the press is gone, and with it the
        // question an undone «VED» would open again.
        c.choice = 'ved';
        done.push(`${rowNo()}-qator «${rowLabel(line.name)}» — VED hal qiladi`);
      } else {
        notes.push(`⚠️ ${rowNo()}-qator keyin o‘zgartirilgan — u bekor qilinmadi.`);
      }
      continue;
    }
    const entry = echoEntryOf(lineAnswers, line);
    const at = line.itemId ? goods.findIndex((g) => g.itemId === line.itemId) : (entry?.index ?? -1);
    const figures = figuresText({}, line.patch, tc.intake);
    if (at < 0) {
      // Placed nowhere by the last reading: reverted in the answers alone, by
      // the same per-field rule as a placed row — and said with its ↩️ head.
      const held = entry ? fields.filter((k) => sameValue((entry.patch as Record<string, unknown>)[k], (line.patch as Record<string, unknown>)[k])) : [];
      if (entry && held.length === 0) {
        notes.push(`⚠️ «${rowLabel(line.name)}» keyin o‘zgartirilgan — u bekor qilinmadi.`);
        continue;
      }
      if (entry) {
        revert(entry, line, held);
        done.push(`«${rowLabel(line.name)}» — ${figures}`);
      }
      notes.push(`⚠️ «${rowLabel(line.name)}» oxirgi o‘qishda topilmadi — javobi o‘chirildi.`);
      continue;
    }
    const no = rows.find((r) => r.index === at)?.no ?? line.no;
    const row = goods[at]!;
    // Only while the row still holds what THIS answer wrote.
    if (!Object.entries(line.patch).every(([k, v]) => keptCode(line, k, v) || sameValue((row as Record<string, unknown>)[k], v))) {
      notes.push(`⚠️ ${no}-qator keyin o‘zgartirilgan — u bekor qilinmadi.`);
      continue;
    }
    const restore = { ...row } as Record<string, unknown>;
    for (const k of fields) {
      if (!keptCode(line, k, (line.patch as Record<string, unknown>)[k])) restore[k] = (line.before as Record<string, unknown>)[k];
    }
    goods[at] = restore as typeof row;
    if (entry) revert(entry, line, fields);
    for (const c of conflicts) {
      if (c.itemId === line.itemId && c.choice !== null && fields.includes(c.field)) c.choice = priorChoice(c);
    }
    done.push(`${no}-qator «${rowLabel(line.name)}» — ${figures}`);
  }

  let facts: IntakeState['facts'] = { ...state.facts, goods };
  let totalsAnswer = state.totalsAnswer;
  let ambiguousTotals = state.ambiguousTotals;
  let routeAnswer = state.routeAnswer;
  if (echo.totals) {
    const t = echo.totals;
    const stands = Object.entries(t.patch).every(([k, v]) => sameValue((facts as Record<string, unknown>)[k], v));
    if (!stands) {
      notes.push('⚠️ Umumiy keyin o‘zgartirilgan — u bekor qilinmadi.');
    } else {
      facts = { ...facts, ...t.before };
      const mine = (['weightKg', 'volumeM3'] as const).filter((f) => f in t.patch);
      if (mine.length > 0) {
        const restored = { ...state.totalsAnswer };
        for (const f of mine) restored[f] = t.answerBefore[f];
        // Nothing later stands: the previous answer whole, its mark included.
        const whole = restored.weightKg === t.answerBefore.weightKg && restored.volumeM3 === t.answerBefore.volumeM3;
        totalsAnswer = whole ? t.answerBefore : restored;
        ambiguousTotals = [
          ...state.ambiguousTotals.filter((d) => !mine.includes(d.field)),
          ...t.doubtsBefore.filter((d) => mine.includes(d.field)),
        ];
      }
      for (const field of mine) {
        const value = t.patch[field];
        if (typeof value === 'number') {
          // The AI door says it in the table's last block, in the table's
          // word; a NULL door's echo keeps today's «m³» (§0.2).
          const said = collectionDoor(state) === 'ai' ? lastBlockTotal(field, value, tc) : tc.intake.figureLabel(value, field === 'weightKg' ? 'kg' : 'm3');
          done.push(`${field === 'weightKg' ? 'umumiy brutto' : 'umumiy hajm'} — ${said}`);
        }
      }
      const cities = (['fromCity', 'toCity'] as const).filter((k) => k in t.patch);
      if (cities.length > 0) {
        if (routeAnswer) {
          const kept = { ...routeAnswer } as Record<string, unknown>;
          for (const k of cities) delete kept[k];
          routeAnswer = 'fromCity' in kept || 'toCity' in kept ? (kept as typeof routeAnswer) : null;
        }
        done.push(`yo‘nalish — ${t.patch.fromCity ?? '—'} → ${t.patch.toCity ?? '—'}`);
      }
    }
  }
  return {
    patch: {
      facts,
      lineAnswers,
      conflicts,
      totalsAnswer,
      ambiguousTotals,
      routeAnswer,
      echoes: state.echoes.map((e) => (e.tag === echo.tag ? { ...e, undone: true } : e)),
    },
    done,
    notes,
  };
}

/**
 * «↩️ Shu javobni bekor qilish» under an echo (`cu:<tag>`, §2.3): undoes what
 * ONE message wrote, while the collection is open. The echo is edited to say
 * what was taken back, and the table is redrawn. After «✅ Tasdiqlash» the
 * change is on the job — no live collection carries the tag, and the button
 * is «eskirgan»; a second press says it was already done.
 *
 * On the AI door the ↩️ is the TABLE's (docs/IKKI-ESHIK.md §3.4): the undo
 * redraws the table, whose last block says what was taken back
 * (`lastUndo`), and sends nothing. An echo a collection hydrated from before
 * the doors still carries its own ↩️, and is still edited.
 */
export async function pressUndo(ctx: PressCtx & { api?: EditApi }, chatId: bigint, tag: string): Promise<void> {
  const state = activeIntake(chatId);
  const echo = state?.echoes.find((e) => e.tag === tag);
  if (!state || !echo || state.saving) {
    await answerPress(ctx, STALE);
    await ctx.reply(STALE);
    return;
  }
  if (echo.undone) {
    await answerPress(ctx, 'Allaqachon bekor qilingan');
    return;
  }
  if (state.analysing) {
    // A reading in flight carries the answers it was started with: an undo
    // now was told «Bekor qilindi» and then put back by its result (review
    // adv-5). The other two presses refuse it the same way.
    await answerPress(ctx, ANALYSING);
    await ctx.reply(ANALYSING);
    return;
  }
  // A PARKED collection's undo beside a task draft, a zametka or a one-text
  // wait (fix review W-15): its write is a non-quiet patch, so the collection
  // held the chat again and filed the other's next line as its material —
  // the REG-2 predicate the dispatcher's own steps ask. Dynamic: the sweep
  // imports this file.
  if (!holdingIntake(chatId)) {
    const { otherCollectorLive } = await import('./calc-intake-sweep');
    const busy = otherCollectorLive(chatId);
    if (busy) {
      await answerPress(ctx, busy);
      await ctx.reply(busy);
      return;
    }
  }
  await answerPress(ctx);
  const tc = await tableContext(state);
  // Computed over the collection as it stands AFTER the awaits (review adv-12).
  const live = activeIntake(chatId);
  const liveEcho = live && live.noteId === state.noteId ? live.echoes.find((e) => e.tag === tag) : undefined;
  if (!live || !liveEcho || liveEcho.undone || live.saving) {
    await ctx.reply(STALE);
    return;
  }
  const undone = undoEcho(live, liveEcho, tc);
  // The table carries the result where it is drawn (§3.4); with none drawn,
  // the words below are the only place it can be said.
  const onTable = collectionDoor(live) === 'ai' && live.tableMessageId !== null;
  updateIntake(chatId, onTable ? { ...undone.patch, lastUndo: { tag, done: undone.done, notes: undone.notes } } : undone.patch);
  editTableSoon(ctx, chatId);
  // Fitted like the echo it edits (review adv-3).
  const text = tc.intake.fitTelegram(
    undone.done.length > 1 ? ['↩️ Bekor qilindi:'] : [],
    [...(undone.done.length === 1 ? [`↩️ Bekor qilindi: ${undone.done[0]}`] : undone.done.map((d) => `· ${d}`)), ...undone.notes],
    [],
    [],
    { maxLines: Number.POSITIVE_INFINITY },
  );
  let edited = false;
  if (liveEcho.messageId !== null && ctx.api) {
    try {
      await ctx.api.editMessageText(String(chatId), liveEcho.messageId, text, { reply_markup: { inline_keyboard: [] } });
      edited = true;
    } catch (err) {
      edited = notModified(err);
    }
  }
  if (!edited && !onTable) await ctx.reply(text);
}

/**
 * The certificate press (`cert_y` / `cert_n`, K11) SETS the answer and then
 * shows it where it was pressed (product-fit-20): on the table, the table is
 * redrawn; on an echo carrying the confirm, that echo's line and button are
 * edited and the table follows. A press from any other message — the
 * pre-round-3 reply, or no message at all — keeps K's own words.
 */
export async function pressCertificate(
  ctx: CalcPressCtx & { api?: EditApi },
  chatId: bigint,
  hasCertificate: boolean,
): Promise<void> {
  const next = updateIntake(chatId, { hasCertificate });
  const pressed = pressedId(ctx);
  const message = ctx.callbackQuery?.message as { text?: unknown; reply_markup?: InlineKeyboard } | undefined;
  const said = typeof message?.text === 'string' ? message.text : null;
  if (next && pressed !== null && ctx.api && (pressed === next.tableMessageId || said?.includes('📄 Sertifikat:'))) {
    if (pressed !== next.tableMessageId && said) {
      const word = hasCertificate ? 'bor' : 'yo‘q';
      const toggle = certificateButton(hasCertificate);
      const keyboard = (message?.reply_markup?.inline_keyboard ?? []).map((row) =>
        row.map((b) => (b.callback_data === 'c:cert_y' || b.callback_data === 'c:cert_n' ? toggle : b)),
      );
      try {
        await ctx.api.editMessageText(String(chatId), pressed, said.replace(/📄 Sertifikat: (?:bor|yo‘q)/u, `📄 Sertifikat: ${word}`), {
          reply_markup: { inline_keyboard: keyboard },
        });
      } catch (err) {
        if (!notModified(err)) logger.warn({ err }, '[calc-intake] certificate echo not edited');
      }
    }
    editTableSoon(ctx, chatId);
    return;
  }
  // The fallback reply carries the table's own buttons (door-closing-drawers):
  // on a reading that is not whole, «👤 VED hisoblasin» — never a «✅» the
  // table above no longer draws.
  const intake = await import('../../wms/calc/intake');
  const keys = next ? landingKeyboard(next, intake) : null;
  await ctx.reply(
    next?.hasCertificate
      ? '📄 Sertifikat BOR deb hisoblanadi — qo‘shimcha boj qo‘shilmaydi.'
      : '📄 Sertifikat YO‘Q deb hisoblanadi — qonun bo‘yicha qo‘shimcha boj qo‘shiladi.',
    {
      reply_markup: keys ? reviewKeyboard({ inline_keyboard: keys.rows }, keys.retry) : aiConfirmKeyboard(true),
    },
  );
  if (next) editTableSoon(ctx, chatId);
}

/**
 * The words (and buttons) for a text with no HOLDING collection, or null —
 * the one home for all three answers (§2.8). `parked` = the live collection
 * when it is parked: then a table-shaped text or a bare figure gets the pause
 * line (a collection exists, so «not found» would be false). With none: a
 * table-shaped text (`looksLikeTableAnswer` — the forms the table teaches,
 * product-fit-14) gets the no-collection sentence, never the paid assistant;
 * a BARE figure keeps R2's REG-3 answer — «777» is as often a code typed
 * without its letters. Async: the shape is wms's, reached by dynamic import.
 * `burst`: a burst's pause line stands beside the parked collection
 * (burst-wait.ts `waitingBurst`) — the line then invites no reply (§4.2), and
 * its «▶️» is the burst's (`c:resume_take`): a second ▶️ that took nothing
 * would be the wrong way back the clause was dropped for (review PB-SPEC-4).
 * The caller makes the line speak for the burst (`aliasBurst`).
 */
export async function orphanAnswerSentence(
  text: string,
  parked: IntakeState | null,
  burst: { forwards: boolean } | null = null,
): Promise<{ text: string; keyboard: InlineKeyboard | null } | null> {
  const { looksLikeTableAnswer } = await import('../../wms/calc/line-address');
  const tableShaped = looksLikeTableAnswer(text);
  const bare = totalsAnswerShape(text) === 'bare';
  if (parked) {
    return tableShaped || bare || (await answersParkedTable(text, parked))
      ? { text: pauseLine(parked.stage, burst !== null), keyboard: pauseKeyboard(burst) }
      : null;
  }
  if (tableShaped) return { text: NO_OPEN_COLLECTION, keyboard: null };
  return bare ? { text: BARE_FIGURE_NOT_FOUND, keyboard: null } : null;
}

/**
 * A text the PARKED table's own parser places — every segment on a row or a
 * total, no refusal (review PF-10): «Shapka 30 dona», «40 juft» to a table
 * whose one open row is a pair. §2.8's shape guard is address-first on
 * purpose (regression-21 narrowed it, and with no collection it stays so),
 * but where the bot knows the rows an answer to them is never the paid
 * assistant's question. A text with no figure is never an answer. A failed
 * read answers «no».
 */
async function answersParkedTable(text: string, parked: IntakeState): Promise<boolean> {
  if (!/\d/u.test(text) || (parked.facts.goods ?? []).length === 0) return false;
  try {
    const { parseTableAnswer } = await import('../../wms/calc/line-address');
    const tc = await tableContext(parked);
    const parsed = parseTableAnswer(text, tableRefOf(parked, tc, 'review'));
    return (
      !parsed.material &&
      parsed.segments.length > 0 &&
      parsed.segments.every((s) => s.at !== null && s.refused === null && (s.answer !== null || s.totals !== null || s.route !== null))
    );
  } catch (err) {
    logger.warn({ err }, '[calc-intake] parked table unreadable — the text goes on');
    return false;
  }
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

/** What a landing hands the ✅: the card's words, whether the queue took it, and whether the machine's answer was queued. */
export type LandedTarget = Parameters<typeof landedWords>[0] & {
  queued?: boolean;
  queueError?: string | null;
  replyQueued?: boolean;
  /**
   * The AI door's job landed for the VED alone (docs/FAYL-OQISH.md §1.3 b) —
   * set by the landing only when the ROW it wrote says the «🧮» door, which is
   * what the pass will do: silent toward the seller. `reason`: why the AI did
   * not compute, in the seller's words.
   */
  ved?: { reason: string } | null;
  /** The landed request's item count as its row reads (`landedWordsOf`) — null when unread. */
  items?: number | null;
};

/**
 * The plain door's ✅ when the job is queued (docs/IKKI-ESHIK.md §2.3, his
 * 2a/3a): the VED computes and answers — the landing pass is silent toward
 * the seller there, so nothing here may promise an AI figure.
 */
export const PLAIN_QUEUED = '🧮 VED navbatiga tushdi — VED xodimi hisoblab, javobni shu yerga yuboradi.';

/**
 * The AI door's ✅ when the machine's answer IS queued (§3.5, his 4a): the
 * figure comes to this chat. Promised only on `replyQueued === true`.
 */
export const AI_QUEUED =
  '🤖 AI hisoblayapti — taxminiy natija bir necha daqiqada shu yerga keladi. Rasmiy narxni VED xodimi beradi.';

/**
 * The ✅ after an AI-door job landed for the VED alone (docs/FAYL-OQISH.md
 * §1.3 b): never `AI_QUEUED` — the AI does not compute, and the seller is told
 * why in the same sentence.
 */
export function vedQueuedText(reason: string): string {
  return `🧮 VED navbatiga tushdi — AI hisoblamadi: ${reason}. VED xodimi fayllarni ko‘rib, javobni shu yerga yuboradi.`;
}

/** The ✅'s queue line before the doors (a NULL door keeps it, §0.2). */
const LEGACY_QUEUED = '🧮 Hisoblash navbatiga tushdi — VED xodimi javob beradi.';


/**
 * The ✅ after «Tasdiqlash» — the save branch's own string, MOVED here pure
 * (docs/SAKKIZ-R3.md K11) so P1's resumed landing says the same words. Uch
 * band's and R2's, not reworded. The link is the SENDER's (`landingLinkFor`:
 * a card they can open, the calculation's own screen for the VED, or no line
 * at all), and `tariffFollows` = a section with no customs half, answered from
 * the tariff on its own queue — a reply that can land ABOVE this message, so
 * the sentence says it comes separately, true in either order.
 */
export function landingReplyText(
  target: LandedTarget,
  opts: { link: string | null; tariffFollows: boolean; door: 'plain' | 'ai' | null; aiAvailable: boolean },
): string {
  return (
    `✅ Saqlandi — ${landedWords(target)}\n` +
    (opts.link ? `${opts.link}\n` : '') +
    '\n' +
    // Honest about which half landed: the material is on the card either
    // way, but only a queued request will be calculated by anybody.
    (target.queued ? queuedLine(target, opts) : `⚠️ Hisoblash navbatiga tushmadi: ${queueRefusal(target.queueError)}`)
  );
}

/**
 * Which queue line a queued landing says, by the landed REQUEST's door (§2.3,
 * §3.5 — what its row says, so both senders say what the pass will do): the
 * tariff's own answer is on its way whatever the door (his 2.5 b); the AI
 * door promises its figure only when that answer was queued AND the pass has
 * a model today (`aiAvailable` — the table's own closing said «… so‘rov VED
 * ga tushadi» without one, as-built review DOORS-2); the plain door promises
 * the VED; anything else says what a NULL door always said — a model-free
 * reply may still follow, as it does there.
 */
function queuedLine(target: LandedTarget, opts: { tariffFollows: boolean; door: 'plain' | 'ai' | null; aiAvailable: boolean }): string {
  if (opts.tariffFollows) return TARIFF_FOLLOWS;
  // The press chose the VED, and the row says the «🧮» door (§1.3 b).
  if (target.ved && opts.door === 'plain') return vedQueuedText(target.ved.reason);
  if (opts.door === 'plain') return PLAIN_QUEUED;
  // An «🤖» request with no goods on it: the pass has nothing to price, and
  // the seller is never promised a figure that cannot come (zero-03).
  if (opts.door === 'ai' && target.items === 0) return vedQueuedText('so‘rovda tovar yo‘q');
  if (opts.door === 'ai' && target.replyQueued === true && opts.aiAvailable) return AI_QUEUED;
  return LEGACY_QUEUED;
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
