import { createHash, randomBytes } from 'node:crypto';
import { logger } from '../logger';
import { editGone, notModified } from './kept-last';
import { answerPress } from './press';
import { clientCodePrefix } from './staff-bot';
import {
  factsWithAnswer,
  intakeClientSummary,
  MAX_INTAKE_IMAGES,
  MAX_OFFERS,
  unansweredAmbiguity,
  type InlineKeyboard,
  type IntakeEcho,
  type IntakeState,
} from './calc-intake';
import { activeIntake, endIntake, holdingIntake, noteOwnMessage, nothingNewToRead, updateIntake } from './calc-store';
import {
  aiConfirmKeyboard,
  CLIENT_QUESTION,
  confirmKeyboard,
  doneKeyboard,
  pricedZonesNow,
  zoneKeyboard,
} from './calc-keyboards';
import { totalsAnswerShape } from './totals-shape';

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
 * additions through «➕».
 */
export const NO_OPEN_COLLECTION =
  'Ochiq hisoblatish yo‘q (24 soatdan oshgan yoki tugatilgan). Qo‘shimcha bo‘lsa — ✅ yoki AI javobi ostidagi «➕ Shu so‘rovga qo‘shish» ni bosing, yoki AI javobiga reply qilib yozing. Yangi hisob — «🧮 Hisoblatish».';

/**
 * A table-shaped text (or a bare figure) while the collection is PARKED (§2.7,
 * regression-1): it exists, so «not found» would be false — and it is never
 * silently added either. Its buttons act on the parked collection (the
 * notice joins its own messages).
 */
export const PAUSE_LINE =
  '⏸ Hisoblatish to‘xtab turibdi (30 daqiqa yozilmadi) — bu xabar unga qo‘shilmadi.\n' +
  'Davom etish uchun «▶️ Davom etamiz» ni bosing yoki jadvalga reply qilib yozing.';

export function pauseKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: '▶️ Davom etamiz', callback_data: 'c:resume' }],
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
  const [laws, stale] = await Promise.all([intakeLaws(state, extraCodes), staleTotalsOf(state)]);
  return { intake, laws, stale, nameWord: nameWordFor };
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
    (failure
      ? `\n\n⚠️ ${intake.AI_READ_FAILURE[failure].text}\n` +
        ((state.invoiceGoods ?? []).length > 0 ? 'Faqat Excel va yozilganidan o‘qildi.' : 'Faqat yozilganidan o‘qildi.')
      : aiStepsText(state.steps)) +
    (state.ai && !state.amend
      ? `\n\n📄 Sertifikat: ${state.hasCertificate ? 'bor' : 'yo‘q'} (o‘zgartirish uchun tugmani bosing)`
      : '');
  return text.replace(/^\n/u, '');
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
 * A conflict's buttons on the add table (§2.1): at most three at a time, each
 * one row — the first three still OPEN, so once those are answered the next
 * ones get theirs (review spec-9); `N` stays the index in `state.conflicts`.
 */
function conflictRows(state: IntakeState, intake: Intake): InlineKeyboard['inline_keyboard'] {
  const shown = state.conflicts.flatMap((c, n) => (c.choice === null ? [n] : [])).slice(0, 3);
  return state.conflicts.flatMap((c, n) => {
    if (!shown.includes(n)) return [];
    const at = `${c.seq}-qator`;
    const unit = c.unit as NeedUnit;
    const ved = { text: `📨 ${at}: VED`, callback_data: `c:conf_${n}_ved` };
    if (c.stored === null) {
      return [[{ text: `✅ ${at}: ${intake.figureLabel(c.read, unit)} yozilsin`, callback_data: `c:conf_${n}_rep` }, ved]];
    }
    return [
      [
        { text: `➕ ${at}: ${intake.figureLabel(c.stored + c.read, unit)}`, callback_data: `c:conf_${n}_add` },
        { text: `🔁 ${at}: ${intake.figureLabel(c.read, unit)}`, callback_data: `c:conf_${n}_rep` },
        ved,
      ],
    ];
  });
}

/** The table and its keyboard over `state` — the one rendering, read by the delivery and by every edit. */
function tableWords(state: IntakeState, tc: TableContext): Pick<NextStep, 'text' | 'keyboard'> {
  const failure = readingFailure(state);
  const base = state.amend
    ? amendKeyboard(state.standingAtOpen === 'started')
    : state.ai
      ? aiConfirmKeyboard(state.hasCertificate)
      : confirmKeyboard;
  return {
    text: tc.intake.intakeTableText(tableInputOf(state, tc)),
    keyboard: reviewKeyboard(
      { inline_keyboard: [...conflictRows(state, tc.intake), ...base.inline_keyboard] },
      failure !== null && tc.intake.AI_READ_FAILURE[failure].retry,
    ),
  };
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
  opts: { stale?: readonly ('weightKg' | 'volumeM3')[]; nameWord: TableContext['nameWord'] },
): NextStep {
  return {
    patch: { stage: 'review', offers: [], offersMessageId: null },
    ...tableWords(state, { intake, laws, stale: opts.stale ?? [], nameWord: opts.nameWord }),
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
  const step = intakeNextStep(state, tc.laws, tc.intake, { stale: tc.stale, nameWord: tc.nameWord });
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

/** «3-qator», «umumiy brutto», «umumiy hajm», «yo‘nalish» — a target as the echo names it. */
const whereOf = (t: TableTarget) =>
  'line' in t ? `${t.line}-qator` : 'totals' in t ? (t.totals === 'weightKg' ? 'umumiy brutto' : 'umumiy hajm') : 'yo‘nalish';

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

/** One change an answer makes — a segment the parser read, or a conflict button (§2.1). */
type Write = { kind: 'segment'; segment: TableSegment } | { kind: 'conflict'; n: number; choice: 'add' | 'rep' | 'ved' };

/** What one answer message did, before it is written and said. */
interface Plan {
  state: IntakeState;
  /** Written, in the echo's words. */
  items: string[];
  /** Conflicts sent to the VED, each its own line («📨 3-qator …: VED hal qiladi»). */
  ved: string[];
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
function planWrites(state: IntakeState, writes: readonly Write[], ref: TableRef, tc: TableContext): Plan {
  const { intake } = tc;
  const work: IntakeState = {
    ...state,
    facts: { ...state.facts, goods: (state.facts.goods ?? []).map((g) => ({ ...g })) },
    lineAnswers: [...state.lineAnswers],
    conflicts: state.conflicts.map((c) => ({ ...c })),
  };
  const plan: Plan = { state: work, items: [], ved: [], refusals: [], offers: [], questions: [], lines: [], totals: null };
  const goods = () => work.facts.goods!;
  const mark = { material: work.material.length, files: work.fileCount };

  /**
   * `kept`: a code typed over a stored row's own (an add collection) — NOT
   * drawn on the row («yangi kod yozilmadi»), but carried in the answer, so
   * the addition can name it to the VED (`codesKept`, §9.5; review adv-11).
   */
  const writeLine = (row: TableRow, patch: Partial<GoodsFact>, opts: { item?: string; kept?: string } = {}) => {
    const g = goods()[row.index]!;
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
    // A row is offered whole or asked in words: one whose buttons do not fit
    // under R2's cap used to vanish with no sentence at all (review adv-8).
    if (values.length > MAX_OFFERS - plan.offers.length) {
      const last = values.at(-1)!;
      const figure = intake.figureLabel(last.value, last.unit);
      const example = 'line' in target ? `${target.line}: ${figure}` : `jami ${figure}`;
      plan.refusals.push(`${whereOf(target)}: ${question} Yozib javob bering, masalan «${example}».`);
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
        plan.refusals.push(`${row.no}-qator: ${LINE_REFUSAL.cartons(String(answer.thousands))}`);
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
    if (kept) {
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
      if (code !== 'kept') plan.refusals.push(`${row.no}-qator: ${LINE_REFUSAL.nothing()}`);
      return;
    }
    writeLine(row, patch, { kept });
  };

  for (const write of writes) {
    if (write.kind === 'conflict') {
      const c = work.conflicts[write.n]!;
      const row = ref.rows.find((r) => goods()[r.index]?.itemId === c.itemId);
      if (!row) continue;
      const name = goods()[row.index]!.name;
      if (write.choice === 'ved') {
        c.choice = 'ved';
        plan.lines.push({ index: row.index, no: row.no, itemId: c.itemId, name, before: { [c.field]: c.stored }, patch: {} });
        plan.ved.push(`📨 ${row.no}-qator «${rowLabel(name)}»: VED hal qiladi`);
        continue;
      }
      const value = write.choice === 'add' ? (c.stored ?? 0) + c.read : c.read;
      const patch: Partial<GoodsFact> =
        c.field === 'measureQty' ? { measureUnit: c.unit as GoodsFact['measureUnit'], measureQty: value } : { [c.field]: value };
      const label = intake.figureLabel(value, c.unit as NeedUnit);
      writeLine(row, patch, {
        item:
          write.choice === 'add' && c.stored !== null
            ? `${row.no}-qator «${rowLabel(name)}»: ${intake.numberText(c.stored)} + ${intake.numberText(c.read)} = ${label}`
            : undefined,
      });
      c.choice = write.choice;
      continue;
    }
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
  if (state.amend) {
    return [[{ text: state.standingAtOpen === 'started' ? '📨 VED ga yuborish' : '✅ Qo‘shish', callback_data: 'c:save' }]];
  }
  // On the AI door the certificate rides with the confirm (product-fit-20):
  // after a few answers the table that held its toggle is far up.
  if (state.ai) return aiConfirmKeyboard(state.hasCertificate).inline_keyboard.slice(0, 2);
  return [[{ text: '✅ Tasdiqlash', callback_data: 'c:save' }]];
}

const confirmName = (state: IntakeState) =>
  state.amend ? (state.standingAtOpen === 'started' ? '«📨 VED ga yuborish»' : '«✅ Qo‘shish»') : '«✅ Tasdiqlash»';

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
  const names = open.map(whereOf);
  const list = names.slice(0, 6).join(', ') + (names.length > 6 ? ` va yana ${names.length - 6} ta` : '');
  out.push(`⚠️ Yana ${open.length} ta: ${list}. Bilmasangiz — ${confirmName(state)}, qolganini VED to‘ldiradi.`);
  if (state.amend && state.standingAtOpen !== 'started') out.push('Qayta hisoblash uchun «✅ Qo‘shish» ni bosing.');
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
  lines.push(...plan.ved);
  lines.push(...plan.refusals.map((r) => `⚠️ ${r}`));
  // A bare or ambiguous number keeps R1's words; when one message's offers
  // span several rows, each question and button names its row (§2.2).
  const targets = new Set(plan.offers.map((o) => JSON.stringify(o.target)));
  for (const q of plan.questions) lines.push(targets.size > 1 ? `${whereOf(q.target)}: ${q.text}` : q.text);
  const collecting = next.stage !== 'review';
  const fixed: string[] = [];
  if (echo) {
    fixed.push(...missingLines(next, tc));
    if (next.ai && !next.amend && !collecting) fixed.push(`📄 Sertifikat: ${next.hasCertificate ? 'bor' : 'yo‘q'}`);
  }
  const offerLabels = plan.offers.map((o) => {
    const label = tc.intake.figureLabel(o.value, o.unit);
    return targets.size > 1 ? `${whereOf(o.target)}: ${label}` : label;
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
 */
async function commitWrites(
  ctx: CollectorReply & { api?: EditApi },
  chatId: bigint,
  state: IntakeState,
  writes: readonly Write[],
  ref: TableRef,
  tc: TableContext,
  offers: { offers: IntakeState['offers']; messageId: number | null } | null = null,
): Promise<void> {
  const live = activeIntake(chatId);
  if (!live || live.noteId !== state.noteId) {
    await ctx.reply(STALE);
    return;
  }
  if (!sameTable(live, state)) {
    // Not written — but the words are kept for the card (law 11).
    if (state.answers.length > live.answers.length) {
      updateIntake(chatId, { answers: [...live.answers, ...state.answers.slice(live.answers.length)] });
    }
    await ctx.reply(TABLE_MOVED);
    return;
  }
  // Planned over the live collection (its echoes and answers as they stand),
  // with the answer's own text — the table it was read against is the same.
  const plan = planWrites({ ...live, answers: state.answers }, writes, ref, tc);
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
    ...(echo ? { echoes: [...w.echoes, echo].slice(-ECHOES_KEPT) } : {}),
  });
  if (!next) return;
  if (wrote) editTableSoon(ctx, chatId);
  const words = echoWords(next, plan, echo, tc);
  if (!words.text) {
    // Nothing read and nothing written («;» alone): asked, never an empty
    // message Telegram refuses (review adv-17).
    await ctx.reply(`⚠️ ${NO_ADDRESS}`);
    return;
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
}

/** File a text as material — the stage goes back to collecting, and the «Bo‘ldi» prompt says so. */
async function fileAsMaterial(
  ctx: CollectorReply & { api: EditApi },
  chatId: bigint,
  state: IntakeState,
  text: string,
): Promise<void> {
  const updated = updateIntake(chatId, { stage: 'material', material: [...state.material, text] });
  await showIntakePrompt(ctx, chatId, updated ?? state);
}

/**
 * A typed text the table stage (or a collecting stage after a first reading)
 * takes — the ONE function every answer goes through (§8.2.6). The parser
 * decides what each segment means; a typed goods list is filed as material
 * (rule 4's one way in the table stage), everything else is written,
 * refused in words, or offered as buttons — never a figure on a row the
 * seller did not name. `msg` is the message it came in.
 */
export async function applyTableAnswer(
  ctx: CollectorReply & { api: EditApi },
  chatId: bigint,
  state: IntakeState,
  text: string,
  _msg: { date: number; messageId: number; forwarded: boolean; replyTo: number | null },
): Promise<void> {
  const stage: TableRef['stage'] = state.stage === 'review' ? 'review' : 'material';
  const { parseTableAnswer } = await import('../../wms/calc/line-address');
  let tc = await tableContext(state);
  const parsed = parseTableAnswer(text, tableRefOf(state, tc, stage));
  if (parsed.material) {
    await fileAsMaterial(ctx, chatId, state, text);
    return;
  }
  // A code the answer brings may pin the unit of its own bare figure: its law
  // is read before anything is decided (R1's «the code lands first»).
  const codes = parsed.segments.flatMap((s) =>
    s.answer && (s.answer.kind === 'figures' || s.answer.kind === 'bare') && s.answer.code ? [s.answer.code] : [],
  );
  if (codes.some((c) => !tc.laws.has(c))) tc = await tableContext(state, codes);
  const answered = { ...state, answers: [...state.answers, answersEntry(text, parsed.segments)] };
  await commitWrites(
    ctx,
    chatId,
    answered,
    parsed.segments.map((segment) => ({ kind: 'segment', segment }) as const),
    tableRefOf(answered, tc, stage),
    tc,
  );
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
  // Bookkeeping, so quiet (docs/SAKKIZ-R3.md §6.2.6): the seller's own action
  // before it already touched the clocks.
  updateIntake(chatId, { promptMessageId: sent.message_id }, { quiet: true });
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
    // the only question that prices the road.
    await ctx.reply('Avval yuk qayerdan chiqishini tanlang:', {
      reply_markup: zoneKeyboard(await pricedZonesNow()),
    });
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
      await ctx.reply(answer.say, { parse_mode: 'Markdown' });
      return;
    }
    if (toTable && written) {
      await deliverNextStep(ctx, chatId, written);
      return;
    }
    // Per section (judge UX14): a customs job is asked for the LINES —
    // «300 dona, 150 kg, 120 m², 40 juft» and the code if known — which
    // the old «kub/kg» prompt never said could be sent.
    const { collectPromptText } = await import('../../wms/calc/intake');
    await ctx.reply(collectPromptText(intake.section), { reply_markup: doneKeyboard });
    return;
  }
  const foreign = msg.replyTo !== null && !ownsMessage(intake, msg.replyTo);
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
    await applyTableAnswer(ctx, chatId, intake, text, msg);
    return;
  }
  // Collecting again after a first reading: an EXPLICIT «N:», «N-qator» or
  // totals address is still an answer (the stage stays); everything else is
  // material, as it always was.
  if (!msg.forwarded && !foreign && (intake.facts.goods ?? []).length > 0) {
    await applyTableAnswer(ctx, chatId, intake, text, msg);
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
 * A conflict button (`conf_N_add|rep|ved`, §2.1): «qo‘shilsin» writes stored +
 * read, «o‘rniga» the file's figure, «VED» names it and writes nothing — each
 * through the same writes as a typed answer, so it gets an echo and its ↩️.
 * Judged against the LIVE conflicts and the table's own message; one already
 * answered is «eskirgan».
 */
export async function pressConflict(
  ctx: CalcPressCtx,
  chatId: bigint,
  state: IntakeState,
  n: number,
  choice: 'add' | 'rep' | 'ved',
): Promise<void> {
  const c = state.conflicts[n];
  const pressed = pressedId(ctx);
  if (state.saving) {
    // The collection is frozen for the save job (§2.4): an echo here would
    // promise a write the job may never read (review adv-13).
    await ctx.reply(SAVING);
    return;
  }
  if (!c || c.choice !== null || state.analysing || pressed === null || pressed !== state.tableMessageId) {
    await ctx.reply(STALE);
    return;
  }
  const tc = await tableContext(state);
  const ref = tableRefOf(state, tc, state.stage === 'review' ? 'review' : 'material');
  await commitWrites(ctx as CalcPressCtx & { api?: EditApi }, chatId, state, [{ kind: 'conflict', n, choice }], ref, tc, {
    offers: state.offers,
    messageId: state.offersMessageId,
  });
}

/**
 * A button under a bare or ambiguous figure (judge UX4): `pick_N` — applied to
 * the offer's TARGET row through the same writes as a typed answer, so a press
 * gets the same echo, the same ↩️ and the same missing-line (product-fit-9).
 * Only from the message that drew the LIVE offers (regression-23): `ownsPress`
 * alone let collection A's old offer apply B's live `offers[1]` to B's row.
 */
export async function pressPick(ctx: CalcPressCtx, chatId: bigint, state: IntakeState, n: number): Promise<void> {
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
  await commitWrites(ctx as CalcPressCtx & { api?: EditApi }, chatId, state, [{ kind: 'segment', segment }], ref, tc, {
    offers: state.offers.map((o) => (JSON.stringify(o.target) === same ? { ...o, taken: true } : o)),
    messageId: state.offersMessageId,
  });
}

const sameValue = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

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
  /** A «📨 VED» line: it wrote no figure — its `before` names the conflict's field. */
  const vedLine = (l: Line) => Object.keys(l.patch).length === 0;
  /** The choice a conflict goes back to: «📨 VED», when an older answer still says so. */
  const priorChoice = (c: (typeof conflicts)[number]) =>
    older.some((e) => e.lines.some((l) => vedLine(l) && l.itemId === c.itemId && c.field in l.before)) ? ('ved' as const) : null;
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
        c.choice = null;
        done.push(`${rowNo()}-qator «${rowLabel(line.name)}» — VED hal qiladi`);
      } else {
        notes.push(`⚠️ ${rowNo()}-qator keyin o‘zgartirilgan — u bekor qilinmadi.`);
      }
      continue;
    }
    const ours = (e: Entry) => (line.itemId ? e.itemId === line.itemId : sameName(e.name, line.name));
    const holds = (e: Entry) => Object.entries(line.patch).every(([k, v]) => sameValue((e.patch as Record<string, unknown>)[k], v));
    const candidates = lineAnswers.filter(ours);
    const entry =
      candidates.filter(holds).find((e) => e.index === line.index) ??
      candidates.find(holds) ??
      candidates.find((e) => e.index === line.index) ??
      candidates[0];
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
          done.push(field === 'weightKg' ? `umumiy brutto — ${tc.intake.figureLabel(value, 'kg')}` : `umumiy hajm — ${tc.intake.figureLabel(value, 'm3')}`);
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
  updateIntake(chatId, undone.patch);
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
  if (!edited) await ctx.reply(text);
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
      const toggle = aiConfirmKeyboard(hasCertificate).inline_keyboard[1]![0]!;
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
  await ctx.reply(
    next?.hasCertificate
      ? '📄 Sertifikat BOR deb hisoblanadi — qo‘shimcha boj qo‘shilmaydi.'
      : '📄 Sertifikat YO‘Q deb hisoblanadi — qonun bo‘yicha qo‘shimcha boj qo‘shiladi.',
    { reply_markup: aiConfirmKeyboard(next?.hasCertificate ?? true) },
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
 */
export async function orphanAnswerSentence(
  text: string,
  parked: IntakeState | null,
): Promise<{ text: string; keyboard: InlineKeyboard | null } | null> {
  const { looksLikeTableAnswer } = await import('../../wms/calc/line-address');
  const tableShaped = looksLikeTableAnswer(text);
  const bare = totalsAnswerShape(text) === 'bare';
  if (parked) {
    return tableShaped || bare || (await answersParkedTable(text, parked))
      ? { text: PAUSE_LINE, keyboard: pauseKeyboard() }
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
