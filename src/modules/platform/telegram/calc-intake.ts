import { v4 as uuidv4 } from 'uuid';
import { logger } from '../logger';
import { staffForChat } from './staff-bot';

/**
 * The «Hisoblatish» collection, as the bot holds it.
 *
 * A collection is a few minutes of one person's attention: press the button,
 * forward the client's files and facts, press «Bo'ldi». It lives in memory
 * with a TTL, like the round-35 task-result pendings and the round-21
 * connect flow — the FILES are not in memory, they go straight to storage
 * pre-bound to the note id minted here, exactly as the receiving wizard
 * pre-binds lot photos before the receipt exists.
 *
 * What that costs, stated plainly: a bot restart mid-collection loses the
 * typed text and the person starts again. The alternative — a table, a
 * status column and a cleanup job for abandoned rows — is more machinery
 * than a five-minute conversation deserves, and the confirmed result is
 * persisted the moment it matters.
 */

export type IntakeStage = 'section' | 'client' | 'material' | 'review' | 'question';

/**
 * A spreadsheet's text, whether its reader stopped before the end (round-2
 * review, C1) and whether it only shortened some cells (round-3, R3-C2) — and
 * the file it came from, as the seller was told it («A.xlsx»), so a LATER file
 * that squeezes it out of the model's shared budget can name it (round-4
 * integration S-d). The model is never shown the label.
 */
export type SheetText = import('../../wms/calc/intake-ai').IntakeSheetText & { label?: string };

export interface IntakeState {
  section: import('../../wms/calc/intake').CalcSection;
  stage: IntakeStage;
  /** Minted up front so photos can be stored against it while they arrive. */
  noteId: string;
  /** What staff typed to name the customer — a code, a phone, or a name. */
  clientHintRaw: string;
  /** Everything typed or captioned, in the order it came. */
  material: string[];
  fileCount: number;
  facts: import('../../wms/calc/intake').CalcFacts;
  /** The model's own notes on what it did — the summary shows three. */
  steps: string[];
  /**
   * The BOT's own sentences about the reading — the lines left out because an
   * Excel answered for them (`sameAsInvoiceNote`, `typedLeftOutNote`). Kept
   * apart from `steps` (round-4 review, C-r1 nit): put first among the model's
   * notes, one of its three was pushed out of the summary, and the sentence
   * read as the AI's. The summary prints them on their own lines; the card's
   * lenta keeps them ahead of the model's notes, as before.
   */
  notes: string[];
  aiUsed: boolean;
  /**
   * Photographs the model is allowed to LOOK at, downscaled.
   *
   * The owner's report: «kub kilosi rasimni ichiga yozilgan bo'lsa analiz
   * qilmayabti» — and he is right, the analysis only ever saw text. His
   * office photographs the packing list; the numbers on it were stored on
   * the card and read by nobody.
   *
   * Held in memory beside the rest of the collection (the FILES themselves
   * are already in storage against the note id — these are the reduced
   * copies the call sends). Capped in both directions: a handful of images,
   * downscaled, or a forwarded album is a request body nobody budgeted for.
   */
  images: { data: Buffer; mediaType: 'image/jpeg' }[];
  /** How many photos arrived but were NOT reduced — counted, never silent. */
  imagesSkipped: number;
  /**
   * The one live «Bo'ldi» control. Every material message used to answer
   * with a fresh keyboard, so eight forwards left eight buttons and the
   * person could not tell which was current (his second report). The prompt
   * is EDITED in place instead, and its id is how.
   */
  promptMessageId: number | null;
  /**
   * The «🤖 AI rastamojka» door (sub-round C), as opposed to the plain
   * «🧮 Hisoblatish» one.
   *
   * It changes what the bot DOES after the confirm, never what it collects:
   * the same collector, the same landing, the same queue. What the flag buys
   * the seller is the follow-up questions and the promise of a figure in the
   * chat — so an ordinary collection is not made slower by questions nobody
   * asked for.
   */
  ai: boolean;
  /**
   * Has the customer a certificate of origin? TRUE by default, which is the
   * request column's own default since 0091 — the additional duty only bites
   * when there is none, and assuming the worse case would quote every job
   * high.
   */
  hasCertificate: boolean;
  /**
   * Where the road runs, when the AI podklyuch door asked (item 13): the
   * tariff zone the seller pressed, and the cities it stands for. The zone is
   * what prices the road; the cities fill the checklist's «qayerdan/qayerga»
   * only where neither the seller's words nor the model named them.
   */
  route: { zone: string; fromCity: string; toCity: string } | null;
  /**
   * Has the totals question been asked (`totalsQuestion`: every freight
   * section, every door, once)? Cleared by a re-read that still leaves the
   * asked figure missing, so new material asks again rather than skipping.
   */
  totalsAsked: boolean;
  /**
   * WHICH totals the pending question asks — what a bare number answering it
   * means (his 2.7 b): «3500» after the brutto question is kilograms, «12»
   * after the volume one is cubic metres, and after the question for BOTH it
   * is neither and is refused in words. Null = the pending question (if any)
   * is about a goods line. One field, not a flag beside it: «are we asking
   * the totals» is this being non-null.
   */
  askingTotalsFor: TotalsAsk | null;
  /**
   * What the seller ANSWERED to the totals question, as READ (judge
   * concurrency-4) — put back on top of every re-read, the way `lineAnswers`
   * is. A bare «3500» stored as raw material read null on the next «Bo‘ldi»
   * (the house number reader needs a unit word), the job landed with no kg,
   * and `totalsAsked` kept the question silent.
   */
  totalsAnswer: { weightKg: number | null; volumeM3: number | null };
  /** The line the bot is waiting for an answer about, by its index in
   * `facts.goods`. Null outside the question stage. */
  askingIndex: number | null;
  /** How many questions have been asked. Capped — a bot that keeps asking is
   * a bot people stop answering. */
  round: number;
  /** Was the LAST answer unreadable? One re-ask per line, then move on. */
  reasked: boolean;
  /**
   * The lines dealt with this collection — answered, or passed with «⏭» —
   * by index AND name. Kept across «➕ Yana ma'lumot»: an answered line is
   * never asked twice (P1.3).
   *
   * The name is what makes «kept» true (round-3 review, R3-C5): an index
   * alone survived a re-read onto a list rebuilt from scratch — the model
   * returned [Shim, Kurtka] where it had said [Kurtka], index 0 now named
   * Shim, so the skipped Kurtka was asked and Shim never. Resolved onto the
   * goods list the question is about (`resolveLineDone`) by the same rule as
   * `lineAnswers`.
   */
  lineDone: { index: number; name: string }[];
  /**
   * What the seller ANSWERED per line, kept so a re-analysis after «➕ Yana
   * ma'lumot» can put it back. The audit's finding: the re-read rebuilt the
   * goods from the material and threw every typed count and weight away,
   * while the seller believed those lines were answered. Matched back by
   * index AND name — a re-read that reorders the lines must not hand one
   * line's answer to another.
   */
  lineAnswers: {
    index: number;
    name: string;
    patch: Partial<import('../../wms/calc/intake').CalcGoodsFact>;
  }[];
  /**
   * The figures the pending question's buttons stand for («[50 dona] [50
   * kg]», judge UX4). A button carries only its position (`c:pick_N`); the
   * figure is read back from here, so a stale or forged press can only pick
   * among what THIS question offered.
   */
  offers: { unit: import('../../wms/calc/needs').NeedUnit; value: number }[];
  /** Totals the typed material states two ways — the summary asks them. */
  ambiguousTotals: import('../../wms/calc/intake').AmbiguousTotal[];
  /**
   * Goods read out of an invoice the seller attached (XLSX/CSV).
   *
   * Held beside the material rather than merged into it. Since 2026-10-09
   * (P1.6) a file that yields a line IS the goods list — it is exact about
   * its rows, codes and units, and the model's reading of a caption used to
   * replace it — while the seller's typed totals, route and per-line
   * answers still win over anything read.
   */
  invoiceGoods: import('../../wms/calc/intake').CalcFacts['goods'];
  /**
   * PDF invoices, small enough to show the model as document blocks.
   *
   * Capped like the images and for the same reason: a request body nobody
   * budgeted for is a request that fails slowly. It used to be ONE — «the
   * first wins» — so the second factory's invoice of a two-factory order was
   * stored on the card and read by nobody (his 1.13). Up to
   * `MAX_INTAKE_PDFS`, read TOGETHER; past the cap the seller is told.
   */
  pdfs: { data: Buffer; name: string }[];
  /**
   * Spreadsheets the reader could not map onto columns (no header it knows),
   * as text — the model reads them (his 1.2 b). A sheet the reader DID map is
   * `invoiceGoods`, exact, and never sent to the model twice. SEPARATE files
   * only: the other sheets of a mapped workbook are `invoiceTexts`, because
   * they belong to that workbook and leave with it (round-1 review, c7).
   * Each carries the reader's own «I stopped before the end» (`cut`), so the
   * seller is told when the file arrives and the model when it reads (round-2
   * review, C1).
   */
  sheetTexts: SheetText[];
  /**
   * The OTHER sheets of the workbooks `invoiceGoods` came from — the
   * «Packing list» beside the «Invoice», whose TOTAL G.W./CBM are the
   * shipment's totals. Shown to the model as context, never as a second
   * goods list (#1458) — under their OWN heading, «for the totals, do not
   * list these goods» (round-2 review, C2: joined into the goods block, a
   * «boshqa zavod» answer re-listed the workbook's own lines). Kept per
   * accepted workbook so «🔁 Oldingisining o'rniga» drops the replaced file's
   * totals WITH its goods: they used to stay in `sheetTexts`, and the job's
   * kg/m³ could come from the very file the seller had just been told was
   * replaced (round-1 review, c7).
   */
  invoiceTexts: SheetText[];
  /**
   * Further spreadsheets of goods, waiting for the seller's answer: add their
   * lines to the first's, or replace them (his 1.13 c — the bot asks). The
   * second used to REPLACE the first in silence. A THIRD file while the
   * question is open FOLDS into it — it used to overwrite the second, whose
   * lines then reached nobody (round-1 review, c1) — and its other sheets wait here
   * too, until the answer says whether they stay.
   */
  pendingInvoice: {
    goods: import('../../wms/calc/intake').CalcFacts['goods'];
    label: string;
    texts: SheetText[];
  } | null;
  /**
   * What the MODEL's goods are worth once an Excel list exists (round-1
   * review, c4; his 1.13: two invoices from two factories). A PDF or a header-less sheet
   * is read by the model, and its lines used to be thrown away whenever a
   * mapped sheet answered — after the bot had promised «AI o'qiydi». So a
   * separate model-read file beside an Excel list is ASKED about: `ask` =
   * the question is open (and «Bo'ldi» waits for it), `add` = another
   * factory's goods, appended to the Excel's, `context` = the same goods, the
   * file is read for its totals only. Null = no such pair has arisen.
   *
   * STATED, not built (round-2 review, C2): ONE answer covers every file the
   * model reads in this collection — the model reads them together and
   * returns one list, which carries no file per line. So factory A's own
   * invoice.pdf beside factory B's PDF has no right answer: «add» repeats A's
   * lines wherever their names differ from the Excel's, «context» drops B's.
   * The question says so to the seller («Javob AI o‘qiydigan hamma
   * fayllarga tegishli»); per-file answers would need the model to name a
   * line's source.
   */
  aiGoods: 'ask' | 'add' | 'context' | null;
  /**
   * The last text the customer question filed as MATERIAL. The same text sent
   * again is the seller insisting it IS the customer, and is taken as one —
   * otherwise a name the goods reader mistook for a line («Ali aka 2») looped
   * on the question for ever (round-1 review, t23).
   */
  clientAskedWith: string | null;
  /**
   * What every analysis of this collection cost — APPENDED, one entry per
   * reading the model answered, ok or not (his 2.9 c: failed reads count).
   * Carried to the landing, which bills each against the request. A re-read
   * after «➕ Yana ma'lumot» used to REPLACE the first reading's usage, so
   * the day's budget counted one call where the seller had caused two.
   */
  usages: { model: string; inputTokens: number; outputTokens: number }[];
  /** Why the model's reading is missing (his 1.6 a) — null when it read. */
  aiFailure: import('../../wms/calc/intake').AiReadFailure | null;
  /**
   * The analysis in flight, by a token minted at «Bo'ldi».
   *
   * The analysis runs on a SNAPSHOT for up to a few minutes, and its result
   * used to be written back over the live collection — so a message sent
   * while it ran (the bot had answered «Qabul qilindi») was erased, a second
   * «Bo'ldi» started a second paid call, and a cancel mid-analysis was undone
   * by the result arriving. The result now lands only on the collection that
   * still carries ITS token, and keeps whatever arrived meanwhile.
   */
  analysing: string | null;
  /**
   * The seller's typed answers to per-line questions, verbatim, for the card.
   * NOT material: material is re-read for the shipment's totals, and a line's
   * «150 kg» read as the whole truck's weight is what made a re-analysis
   * overrule the documents (the diagnosis' cause 5).
   */
  answers: string[];
  /** The album the open question was last re-asked for (one ask per album). */
  reaskedGroup: string | null;
  expires: number;
}

/** After this many questions the bot stops asking and offers the confirm. */
export const MAX_QUESTION_ROUNDS = 3;

/** Which shipment totals the bot asks for (docs/SAKKIZ-R2.md §8.2.5). */
export type TotalsAsk = 'kg' | 'm3' | 'both';

/**
 * Whether to ask the shipment's TOTALS, and which (his 2.7 b).
 *
 * Every section with a freight half — yolkira and podklyuch — on every bot
 * door, AI or not: the road is priced on the totals (the tariff's density
 * band × m³), and the gate used to be the AI podklyuch door alone, so a
 * plain yolkira collection landed with no kg and the tariff answer refused.
 * Rastamojka never: customs prices the lines — which is why its READING
 * keeps a netto-only total (`intake-ai.ts`, review P3-R3) rather than
 * leaving it for a question this section does not ask.
 *
 * The weight is BRUTTO and only ever ASKED — line kilos are netto, and a Σ
 * of them is a different, smaller number. The volume is asked only when it
 * is neither stated nor summable from the lines: `volumeM3` is the caller's
 * `factsVolumeM3(state.facts)` (wms's one rule; platform does not import wms
 * statically, so the figure is handed in). A seller who typed 3500 kg is
 * asked the cube alone (product-fit-7), never the kilos again. Pure.
 */
export function totalsQuestion(
  state: Pick<IntakeState, 'section' | 'totalsAsked' | 'facts'>,
  volumeM3: number | null,
): TotalsAsk | null {
  if (state.section !== 'yolkira' && state.section !== 'podklyuch') return null;
  if (state.totalsAsked) return null;
  const kgMissing = !(Number(state.facts.weightKg) > 0);
  const m3Missing = volumeM3 === null;
  if (kgMissing && m3Missing) return 'both';
  if (kgMissing) return 'kg';
  if (m3Missing) return 'm3';
  return null;
}

const figure = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * The totals question in the bot's Uzbek. Each names only what it asks, and
 * says what is already known — and where it came from, since a Σ of the
 * lines is a figure nobody typed. Pure.
 */
export function totalsQuestionText(
  ask: TotalsAsk,
  facts: Pick<IntakeState['facts'], 'weightKg'>,
  volume: { m3: number | null; fromLines: boolean },
): string {
  if (ask === 'kg') {
    const known =
      volume.m3 === null
        ? ''
        : volume.fromLines
          ? `\n(hajm: ${figure(volume.m3)} m³ — qatorlardan qo‘shildi)`
          : `\n(hajm bor: ${figure(volume.m3)} m³)`;
    return `Yo‘lkira uchun umumiy BRUTTO og‘irlik kerak (qadoq bilan), kg. Masalan: «3500» yoki «3500 kg»${known}`;
  }
  if (ask === 'm3') {
    const kg = Number(facts.weightKg);
    return (
      'Yo‘lkira uchun umumiy hajm (kub) kerak. Masalan: «12» yoki «12 kub»' +
      (kg > 0 ? `\n(brutto og‘irlik bor: ${figure(kg)} kg)` : '')
    );
  }
  return 'Yo‘lkira uchun umumiy hajm va brutto og‘irlik kerak. Masalan: «12 kub 3500 kg»';
}

/**
 * A totals answer that names no unit — the shape only the question it
 * answers can read («3500» after the brutto question). Digits with the
 * house's separators, nothing else. Pure.
 */
export function bareTotalsNumber(text: string): boolean {
  return /^\s*\d[\d\s.,]*\s*$/u.test(text);
}

/** One figure of a totals answer: «3 500» grouped by thousands, else «1,2» / «3500». */
const TOTALS_NUMBER = /\d{1,3}(?:\s\d{3})+(?![\d.,])|\d+(?:[.,]\d+)?/gu;
const TOTALS_UNIT = /^(?:kg|kgs|кг|kilo|kilogramm?|кило|килограмм?|kub|куб|kubometr|кубометр|m3|м3|m³|м³|cbm|brutto|брутто)$/u;

/**
 * What an answer to the totals question can look like, and nothing else: at
 * most TWO figures, and the kg / kub / m³ words — «3500», «3 500 kg», «12 kub
 * 3500 kg».
 *
 * Asked by the staff tail when NO collection is live (judge concurrency-5):
 * the collection lives in memory until round 3, so a restart or the TTL
 * between the question and the answer loses it, and the orphaned «3500»
 * would otherwise fall to the paid assistant, which can say nothing about it.
 * A goods line («Kurtka 300 kg») or a code («GS777») is not this shape.
 *
 * Nor is a PHONE NUMBER (review P3-R1): the assistant finds a client, a lead
 * or a partner by its last nine digits, and the first version of this read
 * «+998 90 123 45 67» as a lost totals answer. Nine digits or more in all
 * (no shipment is 100 000 000 kg), or three figures that are not one
 * thousands-grouped number («123 45 67») — and it is not a total. A «+» is
 * no longer stripped as punctuation, so it is a word no unit matches. Pure.
 */
export function looksLikeTotalsAnswer(text: string): boolean {
  const t = text.trim().toLowerCase();
  const digits = (t.match(/\d/gu) ?? []).length;
  if (digits === 0 || digits >= 9) return false;
  if ((t.match(TOTALS_NUMBER) ?? []).length > 2) return false;
  const words = t.replace(TOTALS_NUMBER, ' ').replace(/[.,;:]/gu, ' ').split(/\s+/u).filter(Boolean);
  return words.every((w) => TOTALS_UNIT.test(w));
}

/**
 * The totals the material states two ways that the seller has NOT since
 * answered (review P3-3) — an answer to the totals question retires its own
 * «1.2 mi yoki 1200 mi?». The material is re-parsed on every reading and the
 * answer is never material (`totalsAnswer`), so without this the summary
 * asked again about the figure printed beside it, under «to‘liq». Pure.
 */
export function unansweredAmbiguity(
  ambiguous: IntakeState['ambiguousTotals'],
  answer: IntakeState['totalsAnswer'],
): IntakeState['ambiguousTotals'] {
  return ambiguous.filter((a) => (a.field === 'weightKg' ? answer.weightKg : answer.volumeM3) === null);
}

/**
 * The totals answer, put back on top of a (re-)read's facts (judge
 * concurrency-4) — `mergeLineAnswers`' rule for the totals. What the seller
 * answered wins over what a re-read found: it was said in reply to the
 * bot's own question. Pure.
 */
export function mergeTotalsAnswer(
  answer: IntakeState['totalsAnswer'],
  facts: IntakeState['facts'],
): IntakeState['facts'] {
  // An answered cube is no longer the ambiguous one (review P3-R2), and an
  // answered weight is the BRUTTO the question asked — no longer a netto
  // standing in for it (review PF-3).
  const { volumeAmbiguous, weightNetto, ...rest } = facts;
  return {
    ...rest,
    weightKg: answer.weightKg ?? facts.weightKg ?? null,
    volumeM3: answer.volumeM3 ?? facts.volumeM3 ?? null,
    ...(volumeAmbiguous && answer.volumeM3 === null ? { volumeAmbiguous } : {}),
    ...(weightNetto && answer.weightKg === null ? { weightNetto } : {}),
  };
}

/**
 * Does the totals question stay asked over these (merged) facts? Cleared
 * when they still miss a figure the question would ask, so a re-read after
 * new material asks again rather than landing the job silent. `volumeM3` is
 * `factsVolumeM3` over the MERGED facts (handed in, as for
 * `totalsQuestion`). Pure.
 */
export function totalsStillAsked(
  state: Pick<IntakeState, 'section' | 'totalsAsked'>,
  facts: IntakeState['facts'],
  volumeM3: number | null,
): boolean {
  return state.totalsAsked && totalsQuestion({ section: state.section, totalsAsked: false, facts }, volumeM3) === null;
}

/** At most this many buttons answer one question — two readings × three units. */
export const MAX_OFFERS = 6;

/**
 * Put the seller's earlier per-line answers back onto a re-read goods list.
 *
 * By index when the line there still has the same name; else the first line
 * of that name; else the answer stays where it already is — in the material,
 * which the VED reads verbatim. Pure.
 */
export function mergeLineAnswers(
  goods: NonNullable<import('../../wms/calc/intake').CalcFacts['goods']>,
  answers: IntakeState['lineAnswers'],
): NonNullable<import('../../wms/calc/intake').CalcFacts['goods']> {
  const out = goods.map((g) => ({ ...g }));
  const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  for (const answer of answers) {
    const at =
      out[answer.index] && sameName(out[answer.index]!.name, answer.name)
        ? answer.index
        : out.findIndex((g) => sameName(g.name, answer.name));
    if (at < 0) continue;
    out[at] = { ...out[at]!, ...answer.patch };
  }
  return out;
}

/**
 * The goods line `index` names, as `lineDone` records it — null when the list
 * has no such line (a stale index records nothing). Pure.
 */
export function doneLine(
  goods: import('../../wms/calc/intake').CalcFacts['goods'],
  index: number,
): IntakeState['lineDone'][number] | null {
  const row = goods?.[index];
  return row ? { index, name: row.name } : null;
}

/**
 * Where each entry of `lineDone` stands on the goods list as it is now (round-3
 * review, R3-C5) — `mergeLineAnswers`' rule: the same index while the line
 * there still carries the name, else the first line of that name, else
 * nowhere (-1). One step stricter than that rule, because a skip has no figure
 * to show it landed: a line is claimed once, so two «Kurtka» lines are two
 * entries and never one line marked twice while the other is lost.
 */
function placeLineDone(
  goods: import('../../wms/calc/intake').CalcFacts['goods'],
  done: IntakeState['lineDone'],
): { entry: IntakeState['lineDone'][number]; at: number }[] {
  const list = goods ?? [];
  const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const taken = new Set<number>();
  return done.map((entry) => {
    const at =
      list[entry.index] && !taken.has(entry.index) && sameName(list[entry.index]!.name, entry.name)
        ? entry.index
        : list.findIndex((g, i) => !taken.has(i) && sameName(g.name, entry.name));
    if (at >= 0) taken.add(at);
    return { entry, at };
  });
}

/**
 * The lines dealt with, put onto the goods list as it stands now (R3-C5,
 * `placeLineDone`); an entry the list does not hold is left out — a line this
 * reading does not list is nothing to skip. What the next QUESTION is chosen
 * by. Pure.
 */
export function resolveLineDone(
  goods: import('../../wms/calc/intake').CalcFacts['goods'],
  done: IntakeState['lineDone'],
): IntakeState['lineDone'] {
  const list = goods ?? [];
  return placeLineDone(goods, done)
    .filter((p) => p.at >= 0)
    .map((p) => ({ index: p.at, name: list[p.at]!.name }));
}

/**
 * What a collection STORES of the lines dealt with: each entry put onto the
 * list as it stands now where it is found (`placeLineDone`), and kept as it was
 * where it is not (round-4 review, C-r2: the resolved list was written back,
 * so ONE reading without the goods — a model timeout after «➕ Yana ma'lumot»
 * — erased every ⏭ for good, and the next «🔄 AI qayta o'qisin» asked the
 * skipped line again). A line missing from one reading stays passed when a
 * later reading brings it back. Pure.
 */
export function carryLineDone(
  goods: import('../../wms/calc/intake').CalcFacts['goods'],
  done: IntakeState['lineDone'],
): IntakeState['lineDone'] {
  const list = goods ?? [];
  return placeLineDone(goods, done).map((p) => (p.at >= 0 ? { index: p.at, name: list[p.at]!.name } : p.entry));
}

/** The hint's non-empty lines, each with its spacing collapsed. */
function hintLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** A line that is only a label waiting for its value («Mijoz:»). */
const isBareLabel = (line: string) => /[:：]$/.test(line);

/**
 * The messengers a number is ON — «Sardor WhatsApp +998 …», «Jasur Viber …».
 * The keyboard capitalises their names whatever they mean, so their capital
 * says nothing of a shop (`nameOwnWord`, round-5 probe, collector). Lower case.
 */
const MESSENGERS = ['whatsapp', 'вотсап', 'ватсап', 'telegram', 'телеграм', 'tg', 'viber', 'wechat'];

/**
 * The words a contact line carries beside its value, in the spellings a
 * seller writes them — «Tel», «Telefon raqami», «Номер телефона», «Phone
 * number», «WhatsApp», «Kontakt», «Aloqa», «T:», «ID», «Mijoz kodi» — and the
 * joining words between two values («va», «и»). Judged WORD by word, never as
 * one listed label (round-4 review, C-r1/C-r2 ND1: a fixed list of opening
 * labels missed «Telefon raqami» — the very words the bot's own question asks
 * for — and the phone went back into the lead's name). Lower case.
 */
const CONTACT_WORDS = new Set([
  'tel', 'telefon', 'telefoni', 'telefonim', 'raqam', 'raqami', 'raqamim', 'nomer', 'nomeri', 'mob', 'mobil',
  'kontakt', 'kontakti', 'aloqa', 'mijoz', 'klient', 'kod', 'kodi', 'id', 't', 'va', 'yoki',
  'тел', 'телефон', 'телефона', 'номер', 'номера', 'моб', 'мобильный', 'контакт', 'контакты', 'клиент',
  'клиента', 'код', 'т', 'и', 'или',
  'phone', 'number', 'no', 'mobile', 'contact', 'client', 'code', 'and', 'or',
  ...MESSENGERS,
]);

/** Where a cut was made in a line: a character no seller types. */
const CUT = '\u0000';
/**
 * A run of digits as a phone is written: «+998 90 123-45-67», «(90) 123 45
 * 67». An opening bracket belongs to the run when it closes around the run's
 * first digits — cut without it, «Sardor (90) 123-45-67» named the lead
 * «Sardor (» (round-4 probe, collector).
 */
const DIGIT_RUN = /\+?(?:\(\d+\)|\d)(?:[\d\s\-–().]*\d)?/g;
/** A Telegram handle — contact, never a name («Telegram: @murod_uz»). */
const HANDLE = /@[\p{L}\p{N}_.]+/gu;
/** The code's number written after its label, the prefix left off: «Kod 777», «Mijoz kodi: 777», «Код клиента 777» for GS777. */
const CODE_LABEL = String.raw`(?:mijoz(?:\s+kodi)?|klient(?:\s+kodi)?|client(?:\s+code)?|клиент|kod(?:i)?|код(?:\s+клиента)?|code|id)[\s.:：#№\-–]*|№\s*`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The line with the hint's OWN phone and code cut out (each cut marked
 * `CUT`), and whether anything was (round-4 review, C-r1/C-r2 ND1). Judged
 * against what `parseClientHint` TOOK, never by the shape alone: «3-filial»
 * and «Ali aka 2» carry digits and are names, and a phone the hint did not
 * take stays where it is written (round-3, R3-C4). The phone is found by its
 * digits whatever the spacing, the code with or without its separator
 * («GS 777», «gs-777») or as its own number after its label («Kod 777»).
 * Once the hint was found here, a second phone and a handle on the same line
 * are contact too («Tel: 90 123 45 67, 91 234 56 78») and are cut with it.
 */
function cutHint(line: string, hint: { code?: string; phone?: string }): { text: string; took: boolean } {
  let text = line;
  let took = false;
  const phone = hint.phone ? hint.phone.replace(/\D/g, '') : '';
  if (phone.length >= 7) {
    text = text.replace(DIGIT_RUN, (run) => {
      const digits = run.replace(/\D/g, '');
      if (digits.length >= 7 && phone.endsWith(digits)) {
        took = true;
        return CUT;
      }
      if (!digits.endsWith(phone)) return run;
      // The phone is the run's TAIL — what stands before it («Mijoz 777 90 …»,
      // «GS 777 90 …») is somebody else's digits and stays.
      took = true;
      let seen = 0;
      const head = digits.length - phone.length;
      for (let i = 0; i < run.length; i += 1) {
        if (!/\d/.test(run[i]!)) continue;
        if (seen === head) return head === 0 ? CUT : `${run.slice(0, i)}${CUT}`;
        seen += 1;
      }
      return run;
    });
  }
  const code = hint.code?.replace(/[\s\-–]/g, '').toUpperCase() ?? '';
  const parts = /^(\p{L}*)(\d+)$/u.exec(code);
  if (code) {
    const whole = parts
      ? `${escapeRe(parts[1]!)}[\\s\\-–.]*${parts[2]}`
      : code.split('').map(escapeRe).join('[\\s\\-–.]*');
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${whole}(?!\\p{N})`, 'giu'), () => {
      took = true;
      return CUT;
    });
    if (parts?.[1]) {
      text = text.replace(new RegExp(`((?<![\\p{L}\\p{N}])(?:${CODE_LABEL}))${parts[2]}(?!\\p{N})`, 'giu'), (_m, label: string) => {
        took = true;
        return `${label}${CUT}`;
      });
    }
  }
  if (took) {
    text = text
      .replace(HANDLE, CUT)
      .replace(DIGIT_RUN, (run) => (run.replace(/\D/g, '').length >= 7 ? CUT : run));
  }
  return { text, took };
}

/**
 * The apostrophes a seller types inside an Uzbek Latin word («Ra'no», «Sa’id»,
 * «o‘g‘li»); ʻ and ʼ are letters already. Between two letters one is part of
 * the word, never a boundary — read as one, the tail of «Ra'no» was the
 * contact word «no» and the lead was named «Ra» (round-4 probe, collector).
 */
const APOS = "['’‘`]";
/** A word: letters and digits, an apostrophe between two of them included. */
const WORD = String.raw`[\p{L}\p{N}]+(?:${APOS}[\p{L}\p{N}]+)*`;

/** The words of a text — `WORD`s, everything else a separator. */
const wordsOf = (text: string) => text.match(new RegExp(WORD, 'gu')) ?? [];

/**
 * Is this line contact and nothing else (round-4 review, C-r1/C-r2 ND1) — the
 * hint's phone or code was cut out of it (`cutHint`), and every word left is
 * contact vocabulary (`CONTACT_WORDS`)? «Telefon raqami: 90 123 45 67», «GS777
 * / +998 …», «Kod GS777 tel 90 …», «ID: GS777», «+998 … (WhatsApp)» are; «Tel:
 * 90 123 45 67 Ali» is not — a name word is left, so the line stays as written
 * (both round-4 reviewers' «what is left» rule).
 */
function isContactLine(line: string, hint: { code?: string; phone?: string } | null): boolean {
  if (!hint) return false;
  const cut = cutHint(line, hint);
  return cut.took && wordsOf(cut.text).every((w) => CONTACT_WORDS.has(w.toLowerCase()));
}

/** A contact word standing beside a cut — «Ali aka, tel: ⟨cut⟩» is «Ali aka». */
const CONTACT_WORD_RE = [...CONTACT_WORDS].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
const HUG_SEP = String.raw`[\s.,:：;/|\\#№«»"'\-–—+]*`;
/** A contact word as a whole `WORD` — never the tail of «Ra'no» or the head of «No'mon». */
const HUG_WORD = String.raw`(?<![\p{L}\p{N}]${APOS}?)(?:${CONTACT_WORD_RE})(?![\p{L}\p{N}]|${APOS}[\p{L}\p{N}])`;
const HUG = new RegExp(`(?:${HUG_SEP}${HUG_WORD})*${HUG_SEP}${CUT}(?:${HUG_SEP}${HUG_WORD})*${HUG_SEP}`, 'giu');
/** The first word of a text with what stands before and after it — and `TAIL_WORD` the last. */
const LEAD_WORD = new RegExp(String.raw`^([^\p{L}\p{N}]*)(${WORD})([^\p{L}\p{N}]*)`, 'u');
const TAIL_WORD = new RegExp(String.raw`([^\p{L}\p{N}]*)(${WORD})([^\p{L}\p{N}]*)$`, 'u');

/**
 * A capitalised contact word of four letters or more, joined by a bare space
 * or hyphen to a capitalised word that is not one, is a word of a shop's or
 * firm's NAME — «Smart Mobile», «Uz-Mobile», «Магазин Телефон», «Phone
 * Market» — and never the phone's label (round-4 probe, collector: the name
 * lost its last word). A label is written as one: lower case («Ali aka tel»),
 * short («Ali Tel»), with its mark («Telefon:»), or apart from any name
 * («Mijoz GS777 …»). The capital counts only where the WRITER chose it — a
 * capital before lower case, never a messenger's name (`MESSENGERS`) nor a
 * word of an all-caps line, which every word passes («SARDOR TELEFON …»,
 * round-5 probe, collector) — bar a word HYPHENED to the name, which no label
 * ever is: «UZ-MOBILE» is a shop in capitals. The cost, an all-caps shop name
 * joined by a space: «SMART MOBILE 90 …» names the lead «SMART» (the summary
 * still prints the whole line, `intakeClientSummary`).
 */
function nameOwnWord(word: string, joint: string, neighbour: string | undefined, mark: string): boolean {
  const hyphened = /[-–]/u.test(joint);
  return (
    (/^\p{Lu}\p{Ll}/u.test(word) || (hyphened && /^\p{Lu}/u.test(word))) &&
    !MESSENGERS.includes(word.toLowerCase()) &&
    word.replace(/[^\p{L}]/gu, '').length >= 4 &&
    /^\s*[-–]?\s*$/u.test(joint) &&
    !/[:：.№#]/u.test(mark) &&
    neighbour !== undefined &&
    /^\p{Lu}/u.test(neighbour) &&
    !CONTACT_WORDS.has(neighbour.toLowerCase())
  );
}

/**
 * One `HUG` (the contact words on both sides of a cut, the cut, their
 * separators) as it leaves the line: a space, with the OUTERMOST word of each
 * side given back when it is the name's own (`nameOwnWord`).
 */
function unhug(hug: string, at: number, line: string): string {
  const cut = hug.indexOf(CUT);
  const left = hug.slice(0, cut);
  const right = hug.slice(cut + 1);
  let keep = ' ';
  const first = LEAD_WORD.exec(left);
  if (first) {
    const [, lead, word, mark] = first;
    const before = TAIL_WORD.exec(line.slice(0, at));
    if (nameOwnWord(word!, `${before?.[3] ?? ''}${lead}`, before?.[2], mark!)) keep = `${lead}${word} `;
  }
  const last = TAIL_WORD.exec(right);
  if (last) {
    const [, , word, trail] = last;
    const after = LEAD_WORD.exec(line.slice(at + hug.length));
    if (nameOwnWord(word!, `${trail}${after?.[1] ?? ''}`, after?.[2], '')) keep += `${word}${trail}`;
  }
  return keep;
}

/**
 * A ONE-line hint with the hint's phone and code cut OUT of it (round-4
 * review, C-r2 close-variant: «Ali aka +998 90 123 45 67», «Murod GS777»,
 * «Rustam (GS777)» — the commonest way a seller types a prospect — named the
 * lead with the phone, which the hint already puts in its own column). The
 * contact words beside a cut go with it — bar a shop’s own word
 * (`nameOwnWord`) — and a bracket left empty. Null =
 * nothing name-like is left («GS 777 90 123 45 67», «Kod 777»).
 */
function nameBesideHint(line: string, hint: { code?: string; phone?: string }): string | null {
  const cut = cutHint(line, hint);
  if (!cut.took) return line;
  const rest = cut.text
    .replace(HUG, unhug)
    // «Rustam (aka ⟨cut⟩)» keeps «(aka)», and «Rustam (⟨cut⟩)» loses the pair.
    .replace(/([(（\[])\s+/gu, '$1')
    .replace(/\s+([)）\]])/gu, '$1')
    .replace(/[(（\[][\s.,:：;/|\-–—]*[)）\]]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,:：;/|\\\-–—]+|[\s.,:：;/|\\\-–—]+$/gu, '');
  return /\p{L}/u.test(rest) ? rest : null;
}

/**
 * The customer's NAME, on one line: the lead's name (round-2 review, C8; the
 * summary prints the whole hint, `intakeClientSummary`). Since the typed round
 * a hint may be two or three lines («Ali aka» over «+998 90 123 45 67»), and
 * the raw text named the lead with a newline AND the phone, which the hint
 * already puts in its own column.
 *
 * Several lines: the lines dropped are the ones that are the hint's contact
 * and nothing else (`isContactLine`; round-3 review R3-C4 — no longer every
 * line with a digit, «Ali aka 2» keeps its «2»; round 4 — any label, a second
 * phone, a handle), and a line that is only a label waiting for its value
 * («Mijoz:»). Every other line is kept as written. When nothing is left: the
 * code, or nobody (the lead's call of 2026-10-22 over R3-C4's collapsed text,
 * which put the phone back into the name); with no hint at all, the text
 * collapsed onto one line.
 *
 * One line: the hint's phone and code are cut out of it (`nameBesideHint`,
 * round 4), and when nothing name-like is left the lead is named by the code,
 * or by nobody (round-4 integration S-c: «GS 777 90 123 45 67» named it with
 * the phone) — the same rule as several lines now.
 *
 * Null = nothing typed, or a one-line hint that is only a phone: the caller
 * has its own word for that. Pure.
 */
export function intakeClientLabel(raw: string, hint: { code?: string; phone?: string } | null): string | null {
  const lines = hintLines(raw);
  if (lines.length === 1 && hint) return nameBesideHint(lines[0]!, hint) ?? hint.code ?? null;
  const named = lines.filter((l) => !isBareLabel(l) && !isContactLine(l, hint));
  if (named.length > 0) return named.join(' ');
  // Nothing name-like left: the lead is named by the code, or by nobody —
  // never by the phone (lead 2026-10-22: S-c over R3-C4's collapsed text,
  // «GS777\n+998 90 …» named the lead with the number its own column holds).
  return hint ? (hint.code ?? null) : lines.join(' ') || null;
}

/**
 * The customer as the confirm's «Mijoz:» prints it — EVERYTHING typed, on one
 * line (round-3 review, R3-C3). The summary is the one screen the seller
 * checks before «Tasdiqlash», and the landing finds the customer by the code
 * or phone in the hint: printed as the lead's name («Ali aka» for «Ali aka /
 * GS777»), a mistyped GS771 could not be seen before it landed. Lines are
 * joined by « · »; a bare label («Mijoz:») takes its value with a space, so
 * «Mijoz:» over «GS777» reads «Mijoz: GS777». Null = nothing typed. Pure.
 */
export function intakeClientSummary(raw: string): string | null {
  const parts: string[] = [];
  let open = false;
  for (const line of hintLines(raw)) {
    if (open && parts.length > 0) parts[parts.length - 1] += ` ${line}`;
    else parts.push(line);
    open = isBareLabel(line);
  }
  return parts.join(' · ') || null;
}

type GoodsList = NonNullable<import('../../wms/calc/intake').CalcFacts['goods']>;

/**
 * A goods name as two lists compare it: case, spacing and punctuation are not
 * what makes two lines the same product. Exported for the test.
 */
export function goodsNameKey(name: string): string {
  return name.toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
}

/**
 * A name's OUTERMOST brackets (ASCII and full-width — a Chinese original often
 * comes in （）): what each holds, and the name outside them. «Куртка женская
 * (Ladies jacket (XL))» holds «Ladies jacket (XL)» — the innermost pair alone
 * read «XL» and left the original's half outside (round-3 review, collector
 * C2 note). Unbalanced brackets are no brackets: nothing is guessed open.
 */
function bracketParts(name: string): { inside: string[]; outside: string } {
  const inside: string[] = [];
  let outside = '';
  let depth = 0;
  let start = 0;
  for (let i = 0; i < name.length; i += 1) {
    const ch = name[i]!;
    if (ch === '(' || ch === '（') {
      if (depth === 0) {
        start = i + 1;
        outside += ' ';
      }
      depth += 1;
    } else if (ch === ')' || ch === '）') {
      if (depth === 0) return { inside: [], outside: name };
      depth -= 1;
      if (depth === 0) inside.push(name.slice(start, i));
    } else if (depth === 0) outside += ch;
  }
  return depth === 0 ? { inside, outside } : { inside: [], outside: name };
}

/**
 * The names one goods line answers to (round-2 review, C2/C6), each through
 * `goodsNameKey`:
 *  - `whole` — the name as written: the one name the line IS;
 *  - `outside` / `inside` — the name outside its outermost brackets, and what
 *    each holds;
 *  - `keys` — everything the line answers to: the whole, the outside, the
 *    insides. The model is TOLD to write «Куртка женская (Ladies jacket)»
 *    (its SYSTEM prompt: Russian, the original in brackets), so the whole
 *    name alone never equalled the Excel's «Ladies jacket» and an «add»
 *    landed the same line twice;
 *  - `halves` — for a Chinese factory's bilingual cell with no brackets
 *    («女士夹克 Ladies jacket», «女士夹克\nLadies jacket») its Chinese half and
 *    the rest, each beside the OTHER half (`rest`): the model reads such a
 *    cell as «Куртка женская (女士夹克)» and the Excel's whole name met neither
 *    half (round-3 review, collector C2 note). How a half may meet is
 *    `halfMeets` — not as a name the line IS: «Kurtka 黑色» is a black jacket
 *    and «LED灯泡» a bulb, and nothing says a half is the other's translation
 *    (round-4 probe, collector).
 * Halves only without brackets: in «Kurtka (黑色)» the colour is the bracket.
 * Empty keys are dropped.
 */
export function goodsNameKeys(name: string): {
  whole: string;
  outside: string;
  inside: string[];
  keys: string[];
  halves: { key: string; rest: string }[];
} {
  const whole = goodsNameKey(name);
  const parts = bracketParts(name);
  const outside = goodsNameKey(parts.outside);
  const inside = parts.inside.map(goodsNameKey).filter(Boolean);
  const han = goodsNameKey((name.match(/\p{Script=Han}+/gu) ?? []).join(' '));
  const rest = goodsNameKey(name.replace(/\p{Script=Han}+/gu, ' '));
  const split = parts.inside.length === 0 && han !== '' && /\p{L}/u.test(rest);
  return {
    whole,
    outside,
    inside,
    keys: [...new Set([whole, outside, ...inside])].filter(Boolean),
    halves: split ? [{ key: han, rest }, { key: rest, rest: han }] : [],
  };
}

/**
 * Do two names point at the same product the WIDE way — a name ONE of them
 * answers to is the name the OTHER is: «Куртка женская (Ladies jacket)» is
 * «Ladies jacket», «Kurtka» is «Kurtka (qora)» (round-2 review, C2/C6)? Never
 * bracket against bracket or outside against outside: a bracket is as often a
 * colour or a size, and «Kurtka (qora)» beside «Kurtka (oq)» are two lines of
 * one order. A bilingual cell's half meets by `halfMeets` alone.
 */
type NameKeys = ReturnType<typeof goodsNameKeys>;
function namesMeet(a: NameKeys, b: NameKeys): boolean {
  return a.keys.includes(b.whole) || b.keys.includes(a.whole) || halfMeets(a, b) || halfMeets(b, a);
}

const SCRIPTS = [
  ['han', /\p{Script=Han}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['latin', /\p{Script=Latin}/u],
] as const;

/**
 * A key's words for comparing two names: each word's LETTERS under the script
 * of its first one, and the NUMBERS the key states as their own bucket — every
 * run of digits, counted (a multiset), however they are written. A size is
 * «600*600mm» in the cell and «600×600 мм» in the model's reading of it, a
 * range «36~40» and «36–40»: compared as words they were two names and one
 * order landed twice (round-6 probe, collector, 28 common cases); left out,
 * «iPhone 14» met «iPhone 15» and a 800×800 tile met the 600*600 one (the
 * lead's undo, probed: 5 common). Read as numbers both hold. Not read: a unit
 * conversion («0.35L» / «350 мл»), which stays another name.
 */
function nameWords(key: string): Map<string, Set<string>> {
  const by = new Map<string, Set<string>>();
  const add = (bucket: string, word: string) => by.set(bucket, (by.get(bucket) ?? new Set<string>()).add(word));
  // NFKC writes full-width digits as digits and «№» as «No» — capitalised,
  // so the case is folded after it.
  const plain = key.normalize('NFKC').toLowerCase();
  for (const word of plain.split(' ').filter(Boolean)) {
    const letters = word.replace(/[^\p{L}]/gu, '');
    if (letters === '') continue;
    add(SCRIPTS.find(([, re]) => re.test(letters))?.[0] ?? 'other', letters);
  }
  const seen = new Map<string, number>();
  for (const run of plain.match(/[0-9]+/g) ?? []) {
    const n = run.replace(/^0+(?=\d)/, '');
    const nth = (seen.get(n) ?? 0) + 1;
    seen.set(n, nth);
    add('number', `${n}#${nth}`);
  }
  return by;
}

/**
 * The tier words of a model designation — «iPhone 15 Pro Max», «Galaxy S24
 * Ultra», «Redmi Note 13 Pro» — in either script, each counted only right
 * after a word with a digit or another tier word: before or apart from a model
 * number the same words describe («Pro hair dryer», «Plus size»), and a
 * translation drops them.
 */
const TIER_WORDS: Readonly<Record<string, string>> = {
  pro: 'pro', max: 'max', plus: 'plus', ultra: 'ultra', lite: 'lite', se: 'se', fe: 'fe',
  про: 'pro', макс: 'max', плюс: 'plus', ультра: 'ultra', лайт: 'lite',
};

function tierWords(key: string): Set<string> {
  const tiers = new Set<string>();
  let afterModel = false;
  for (const word of key.normalize('NFKC').toLowerCase().split(' ').filter(Boolean)) {
    const tier = TIER_WORDS[word.replace(/[^\p{L}]/gu, '')];
    if (tier !== undefined && afterModel) tiers.add(tier);
    else afterModel = /\d/u.test(word);
  }
  return tiers;
}

/**
 * Are two keys two DIFFERENT names: in some script both write — or in the
 * numbers both state — each has a word the other lacks: «Shirt» beside
 * «Jacket», «Куртка M» beside «XL», «iPhone 15» beside «iPhone 14», «600*600»
 * beside «800×800». One naming MORE of the same is not another name:
 * «Наушники Bluetooth» shares the Latin of «Bluetooth earphones», «Куртка
 * женская XL» the «XL» of «Ladies jacket XL», and «Мужские кроссовки» is
 * «Кроссовки мужские» (round-5 probe, collector: comparing SCRIPTS alone made
 * each of those a clash, and one order landed twice) — except a model's TIER
 * (`tierWords`): «Чехол iPhone 15» is not «Phone case iPhone 15 Pro», and two
 * stalls' phone cases had one line dropped as the other's (round-6 final
 * probe, collector, 10 common cases).
 */
function otherName(a: string, b: string): boolean {
  const tiersA = tierWords(a);
  const tiersB = tierWords(b);
  if ([...tiersA].some((t) => !tiersB.has(t)) || [...tiersB].some((t) => !tiersA.has(t))) return true;
  const wordsB = nameWords(b);
  for (const [bucket, ofA] of nameWords(a)) {
    const ofB = wordsB.get(bucket);
    if (ofB && [...ofA].some((w) => !ofB.has(w)) && [...ofB].some((w) => !ofA.has(w))) return true;
  }
  return false;
}

/**
 * A bilingual cell meets another line through a half only where a
 * translation stands: the other line's bracket — the model's «Куртка женская
 * (女士夹克)» — unless that line's outside and the cell's other half are two
 * names (`otherName`: «Shirt (黑色)» is not «Jacket 黑色»), or the other's
 * whole bare name («Ladies jacket»). Half against half, or against an
 * outside, met «夹克 XL» with «衬衫 XL» and «Kurtka 黑色» with «Kurtka (oq)»
 * (round-4 probe, collector).
 */
function halfMeets(cell: NameKeys, other: NameKeys): boolean {
  return cell.halves.some(({ key, rest }) => {
    if (other.inside.length === 0) return other.whole === key;
    if (!other.inside.includes(key)) return false;
    return other.outside === '' || !otherName(other.outside, rest);
  });
}

/**
 * The figures a goods line can state, and what «equal» means for each: a
 * count is exact (300 and 299 are two lines); a weight, volume or amount is
 * equal within rounding — under `unit` apart, or within 0.5 % (a PDF's
 * «1 234,5 kg» read as 1234).
 */
const LINE_FIGURES: { field: 'quantity' | 'weightKg' | 'volumeM3' | 'measureQty' | 'amount'; unit: number | null }[] = [
  { field: 'quantity', unit: null },
  { field: 'weightKg', unit: 1 },
  { field: 'volumeM3', unit: 0.01 },
  { field: 'measureQty', unit: null },
  { field: 'amount', unit: 0.01 },
];

function figureOf(g: GoodsList[number], field: (typeof LINE_FIGURES)[number]['field']): number | null {
  const v = g[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Is the model's line the Excel line READ AGAIN, by its figures (round-3
 * review, R3-C1)? A packing list re-read carries the Excel line's own count or
 * weight; another factory's same-named product does not. Only the figures
 * BOTH lines state are compared (round-4 review, C-r2 ND2 and integration
 * defect 3): a re-read that states the count beside an Excel line stating
 * only the weight — the Invoice sheet beside the Packing list, or a count the
 * reader took once from a merged cell — shares nothing to disagree on, and
 * counting «the Excel has no count» as a disagreement landed the order twice.
 * So: nothing shared (nothing says it is another line), or a shared figure
 * agrees.
 */
function figuresAgree(model: GoodsList[number], invoice: GoodsList[number]): boolean {
  const shared = LINE_FIGURES.filter((f) => figureOf(model, f.field) !== null && figureOf(invoice, f.field) !== null);
  if (shared.length === 0) return true;
  return shared.some((f) => {
    const ours = figureOf(model, f.field)!;
    const theirs = figureOf(invoice, f.field)!;
    if (f.unit === null) return ours === theirs;
    const gap = Math.abs(ours - theirs);
    return gap < f.unit || gap <= 0.005 * Math.max(Math.abs(ours), Math.abs(theirs));
  });
}

/** A line the Excel kept out of the job, and why — see `PickedGoods.sameAsInvoice`. */
export type LeftOutLine = GoodsList[number] & { why: 'same' | 'typed' };

/** What `pickGoods` lands, and the lines it left out because an Excel answered for them. */
export interface PickedGoods {
  goods: GoodsList;
  /**
   * The lines NOT landed because an Excel answers for them — named to the
   * seller, never dropped in silence: the job would land short by them with
   * no word anywhere. `why`:
   *  - `same` — a model line an Excel line is the same product as (round-3
   *    review, R3-C1);
   *  - `typed` — a line the seller TYPED, which the model read too, that the
   *    Excel does not carry, while nobody was asked whether another file is
   *    another factory's (round-4 integration S-a: an Excel and a typed «Shim
   *    200 dona», no PDF — the line was dropped and nobody was asked).
   */
  sameAsInvoice: LeftOutLine[];
}

/**
 * Which goods list a collection lands, in the order of how EXACT each source
 * is about the lines. Pure, so the order is a test and not a reading of
 * `analyzeCollected`.
 *
 *  1. An attached invoice (XLSX/CSV) answers whenever it yields a line
 *     (2026-10-09, P1.6): its rows carry the supplier's own codes, units,
 *     weights and volumes. When the seller said a separate model-read file is
 *     ANOTHER factory's (`aiGoods: 'add'`, round-1 review c4), the model's
 *     lines are appended — or, when the model did not read, the TYPED lines
 *     (round-4 integration S-a: «add» answered, the PDF unread, and the typed
 *     «Shim 200 dona» vanished) — except those the Excel already carries,
 *     because the model was shown the PDF and the text, and the text can
 *     repeat a line the Excel has. «Already carries» (round-3 review, R3-C1):
 *      - the same WHOLE name (`goodsNameKey`) — base's rule, kept;
 *      - a name the line answers to (`goodsNameKeys`: the model's «Russian
 *        (original)» meets its Excel original, round-2 review C2) — and then
 *        only when the figures agree too (`figuresAgree`). The wide match
 *        alone threw factory B's «Kurtka (qora)» 200 away against factory A's
 *        «Kurtka» 300, and two factories shipping one generic name is this
 *        business's ordinary day.
 *     The wide match is between a model line and the INVOICE only; among the
 *     lines ADDED, the same whole name is one line and nothing wider — the
 *     model's «Kurtka» and «Kurtka (qora)» are two products it read. A line
 *     whose same-named twin was the Excel's is judged on its own (round-4,
 *     C-r1 nit / C-r2 ND: «Куртка женская (Ladies jacket)» 300 beside the
 *     same name at 200 lost the 200 unnamed). What was left out is returned
 *     (`sameAsInvoice`), for the seller to see.
 *     When nobody was asked (`aiGoods` null: no PDF and no header-less sheet
 *     beside the Excel), the Excel alone answers — and a typed line the model
 *     read too and the Excel does not carry is NAMED (round-4 integration
 *     S-a). Only one the model read: a typed reading alone is the regex's
 *     guess, and t22 says a guess does not overrule a reading.
 *  2. The model's goods, when there is no file — and when it READ and found
 *     none, only the lines the seller LABELLED as goods («Tovar: …»): an
 *     unlabelled «Salom, 12 kub 3500 kg» is not a product the model missed,
 *     and a regex must not overrule a reading that said «no goods» (round-1
 *     review, t22).
 *  3. Every typed line, when there was no reading at all (no key, budget,
 *     an outage) — before 2026-10-21 that left «Tovarlar: —» over a typed
 *     name.
 */
export function pickGoods(input: {
  invoice: GoodsList;
  aiGoods: IntakeState['aiGoods'];
  /** The model's goods — null when the model did not read. */
  model: GoodsList | null;
  typed: GoodsList;
  typedLabelled: GoodsList;
}): PickedGoods {
  if (input.invoice.length > 0) {
    const invoice = input.invoice.map((row) => ({ row, names: goodsNameKeys(row.name) }));
    const carried = (g: GoodsList[number], names: NameKeys) =>
      invoice.some((inv) => inv.names.whole === names.whole || (namesMeet(names, inv.names) && figuresAgree(g, inv.row)));
    if (input.aiGoods !== 'add') {
      if (input.aiGoods !== null || !input.model?.length) return { goods: input.invoice, sameAsInvoice: [] };
      const read = input.model.map((g) => goodsNameKeys(g.name));
      const named = new Set<string>();
      const sameAsInvoice: LeftOutLine[] = [];
      for (const t of input.typed) {
        const names = goodsNameKeys(t.name);
        if (!names.whole || named.has(names.whole) || carried(t, names)) continue;
        if (!read.some((m) => m.whole === names.whole || namesMeet(m, names))) continue;
        named.add(names.whole);
        sameAsInvoice.push({ ...t, why: 'typed' });
      }
      return { goods: input.invoice, sameAsInvoice };
    }
    const extra = input.model ?? input.typed;
    const addedWholes = new Set<string>();
    const leftOut = new Set<string>();
    const added: GoodsList = [];
    const sameAsInvoice: LeftOutLine[] = [];
    for (const g of extra) {
      const names = goodsNameKeys(g.name);
      if (!names.whole) continue;
      if (carried(g, names)) {
        // One reading is named once; two readings of one name with different
        // figures are both said.
        const reading = `${names.whole}|${LINE_FIGURES.map((f) => figureOf(g, f.field)).join('|')}`;
        if (leftOut.has(reading)) continue;
        leftOut.add(reading);
        sameAsInvoice.push({ ...g, why: 'same' });
        continue;
      }
      if (addedWholes.has(names.whole)) continue;
      addedWholes.add(names.whole);
      added.push(g);
    }
    return { goods: [...input.invoice, ...added], sameAsInvoice };
  }
  if (input.model === null) return { goods: input.typed, sameAsInvoice: [] };
  return { goods: input.model.length > 0 ? input.model : input.typedLabelled, sameAsInvoice: [] };
}

/** Three names, each cut at 30, and a count of the rest — the whole sentence fits the summary's cut. */
function namedLines(lines: readonly { name: string }[]): string {
  const names = lines.slice(0, 3).map((g) => `«${g.name.length > 30 ? `${g.name.slice(0, 29)}…` : g.name}»`);
  const more = lines.length > 3 ? ` va yana ${lines.length - 3} ta` : '';
  return `${names.join(', ')}${more}`;
}

/**
 * The seller's word for the model's lines `pickGoods` left out as the Excel's
 * own (round-3 review, R3-C1): one line, printed on its own above the AI notes
 * (`IntakeState.notes`) and kept on the card's lenta. Null = none were left
 * out. A line `pickGoods` marked `typed` is not this sentence's
 * (`typedLeftOutNote`).
 */
export function sameAsInvoiceNote(lines: readonly (GoodsList[number] & { why?: LeftOutLine['why'] })[]): string | null {
  const same = lines.filter((g) => g.why !== 'typed');
  if (same.length === 0) return null;
  return `⚠️ ${same.length} ta qator Excel’dagi bilan bir xil deb qo‘shilmadi: ${namedLines(same)}.`;
}

/**
 * The seller's word for the typed lines left out because the Excel answers
 * for the goods (round-4 integration S-a) — they are NOT the Excel's, so
 * «bir xil» would be false of them. Null = none.
 */
export function typedLeftOutNote(lines: readonly LeftOutLine[]): string | null {
  const typed = lines.filter((g) => g.why === 'typed');
  if (typed.length === 0) return null;
  return `⚠️ ${typed.length} ta yozilgan qator Excel’da yo‘q, ro‘yxatga qo‘shilmadi (tovarlar Excel’dan olindi): ${namedLines(typed)}.`;
}

/** At most this many photographs reach the model (his 1.4 b: twelve). */
export const MAX_INTAKE_IMAGES = 12;

/** At most this many PDFs, and this many bytes of them, reach the model. */
export const MAX_INTAKE_PDFS = 3;
export const MAX_INTAKE_PDF_BYTES = 12 * 1024 * 1024;

/**
 * What a file the seller forwarded IS, by its bytes (#284's rule — never the
 * name alone), so each kind reaches the reader that can read it.
 *
 * `image` covers a photo sent AS A FILE — the sharpest copy a seller has
 * (WeChat originals, a scan from the office PC) — which used to be stored and
 * shown to nobody (the diagnosis' cause 2). An ISO-media file (`ftyp`) may be
 * HEIC, which this server's image library cannot decode: the caller tries it
 * and says so in words when it fails. `sheet` = let the spreadsheet reader
 * decide (XLSX, Excel 97, an HTML or XML table, a CSV).
 */
export type IntakeFileKind = 'image' | 'isomedia' | 'video' | 'archive' | 'pdf' | 'docx' | 'sheet';

/** The ISO-media brands of a still picture: HEIC (tried, often refused) and AVIF. */
const PICTURE_BRANDS = /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1|avif|avis)$/;

export function intakeFileKind(
  body: Buffer,
  isPhoto: boolean,
  fileName: string,
  mime: string | null,
): IntakeFileKind {
  if (isPhoto) return 'image';
  const ascii = (from: number, to: number) => body.subarray(from, to).toString('latin1');
  if (ascii(0, 5) === '%PDF-') return 'pdf';
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image';
  if (body[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image';
  if (ascii(0, 4) === 'GIF8') return 'image';
  if (ascii(0, 4) === 'II*\u0000' || ascii(0, 4) === 'MM\u0000*') return 'image';
  // ISO media is a HEIC photo OR a phone video (mp4, mov): the brand says.
  if (ascii(4, 8) === 'ftyp') return PICTURE_BRANDS.test(ascii(8, 12)) ? 'isomedia' : 'video';
  if (/\.docx?$/i.test(fileName) || /wordprocessingml|msword/i.test(mime ?? '')) return 'docx';
  // An archive is a zip like an xlsx — named, so it is not «a broken Excel».
  if (/\.(zip|rar|7z)$/i.test(fileName) || /zip|rar|7z-compressed/i.test(mime ?? '')) return 'archive';
  return 'sheet';
}

const TTL_MS = 30 * 60_000;
const collections = new Map<string, IntakeState>();

const key = (chatId: bigint) => String(chatId);

export function startIntake(
  chatId: bigint,
  section: import('../../wms/calc/intake').CalcSection,
  opts: { ai?: boolean } = {},
): IntakeState {
  const state: IntakeState = {
    section,
    stage: 'client',
    noteId: uuidv4(),
    clientHintRaw: '',
    material: [],
    fileCount: 0,
    facts: {},
    steps: [],
    notes: [],
    aiUsed: false,
    images: [],
    imagesSkipped: 0,
    promptMessageId: null,
    ai: opts.ai ?? false,
    hasCertificate: true,
    route: null,
    totalsAsked: false,
    askingTotalsFor: null,
    totalsAnswer: { weightKg: null, volumeM3: null },
    askingIndex: null,
    round: 0,
    reasked: false,
    lineDone: [],
    lineAnswers: [],
    offers: [],
    ambiguousTotals: [],
    invoiceGoods: [],
    pdfs: [],
    sheetTexts: [],
    invoiceTexts: [],
    pendingInvoice: null,
    aiGoods: null,
    clientAskedWith: null,
    usages: [],
    aiFailure: null,
    analysing: null,
    answers: [],
    reaskedGroup: null,
    expires: Date.now() + TTL_MS,
  };
  collections.set(key(chatId), state);
  return state;
}

/** The live collection for a chat, or nothing — expiry is checked on read. */
export function activeIntake(chatId: bigint): IntakeState | null {
  const state = collections.get(key(chatId));
  if (!state) return null;
  if (state.expires <= Date.now()) {
    collections.delete(key(chatId));
    return null;
  }
  return state;
}

export function updateIntake(chatId: bigint, patch: Partial<IntakeState>): IntakeState | null {
  const state = activeIntake(chatId);
  if (!state) return null;
  const next = { ...state, ...patch, expires: Date.now() + TTL_MS };
  collections.set(key(chatId), next);
  return next;
}

export function endIntake(chatId: bigint): void {
  collections.delete(key(chatId));
}

/**
 * Read the collected material with the model, then keep whatever the person
 * typed for anything it could not find.
 *
 * The manual layer is not a fallback for a broken key — it is the truth
 * beside the model's reading: a staff member who typed «5 kub» meant it,
 * and a model that missed it must not erase it.
 */
export async function analyzeCollected(state: IntakeState): Promise<IntakeState> {
  const { analyzeIntake } = await import('../../wms/calc/intake-ai');
  const { parseManualFacts, readGoodsLines, totalWeightFrom } = await import('../../wms/calc/intake-manual');
  const { factsVolumeM3 } = await import('../../wms/calc/intake');
  const text = state.material.join('\n');
  // The section decides whether a NETTO figure may stand for the total
  // (review PF-1): never where the bot asks the brutto.
  const manual = parseManualFacts(text, state.section);
  const invoice = state.invoiceGoods ?? [];

  // The day's budget gates the READING too — it is the most expensive call
  // on this path (Opus, with photographs). Over the cap the manual parser
  // answers, which is exactly what a keyless server has always had, and the
  // summary says so rather than looking like a model that found nothing.
  const { aiCalcBudgetLeft } = await import('../../wms/calc/ai-cost');
  const budgetLeft = await aiCalcBudgetLeft().catch(() => Number.POSITIVE_INFINITY);
  type Outcome = Awaited<ReturnType<typeof analyzeIntake>>;
  const outcome: Outcome =
    budgetLeft <= 0
      ? { ok: false, failure: 'budget' }
      : await analyzeIntake({
          section: state.section,
          text,
          fileCount: state.fileCount,
          images: state.images,
          pdf: state.pdfs[0] ?? null,
          morePdfs: state.pdfs.slice(1),
          // The separate files are goods material; a mapped workbook's other
          // sheets are TOTALS only, under their own heading — in one block
          // with the files, an «add» answer had the model re-list the
          // workbook's own packing list (round-2 review, C2/C6). One budget
          // over both, cut on a line and said per text — the reader's own
          // cut included (round-1 a17, round-2 C1).
          sheets: state.sheetTexts,
          contextSheets: state.invoiceTexts,
          // Every name: `analyzeIntake` shows what fits its character budget
          // and counts the rest.
          knownGoods: state.aiGoods === 'add' ? invoice.map((g) => g.name) : undefined,
        }).catch((err: unknown): Outcome => {
          logger.warn({ err }, 'intake analyze failed');
          return { ok: false, failure: 'network' };
        });
  const ai = outcome.ok ? outcome : null;

  // Typed facts win over read ones: the person is looking at the material.
  // A total the text writes TWO ways («1,200 kg») is asked, and the model —
  // which read the same ambiguous text — does not get to answer it either.
  const asked = (field: 'weightKg' | 'volumeM3') => manual.ambiguous.some((a) => a.field === field);
  // Three sources, in the order of how EXACT they are (`pickGoods`).
  const picked = pickGoods({
    invoice,
    aiGoods: state.aiGoods,
    model: ai ? (ai.facts.goods ?? []) : null,
    typed: manual.goods ?? [],
    typedLabelled: readGoodsLines(text, { labelledOnly: true }),
  });
  // The lines left out because the Excel answers are SAID, in the bot's own
  // notes, so the summary shows them beside the model's three and the card
  // keeps them (R3-C1; round 4, C-r1 nit and integration S-a).
  const notes = [sameAsInvoiceNote(picked.sameAsInvoice), typedLeftOutNote(picked.sameAsInvoice)].filter(
    (n): n is string => n !== null,
  );
  // The seller's answer to the totals question goes back on top as well
  // (judge concurrency-4): «3500» typed after the brutto question is no
  // material, and only this keeps it across a re-read.
  const facts = mergeTotalsAnswer(state.totalsAnswer, {
    fromCity: manual.fromCity ?? ai?.facts.fromCity ?? state.route?.fromCity ?? null,
    toCity: manual.toCity ?? ai?.facts.toCity ?? state.route?.toCity ?? null,
    ...totalWeightFrom(state.section, manual, ai?.facts ?? null, asked('weightKg')),
    volumeM3: manual.volumeM3 ?? (asked('volumeM3') ? null : (ai?.facts.volumeM3 ?? null)),
    // …nor the lines' Σ (review P3-R2): the seller stated a cube, only not
    // which one — the totals question asks it, and the INSERT sums nothing.
    ...(asked('volumeM3') ? { volumeAmbiguous: true } : {}),
    // The seller's per-line answers go back on top (P1.3): a re-read after
    // «➕ Yana ma'lumot» must not erase them.
    goods: mergeLineAnswers(picked.goods, state.lineAnswers),
  });
  return {
    ...state,
    facts,
    steps: ai?.steps ?? [],
    notes,
    aiUsed: Boolean(ai),
    aiFailure: outcome.ok ? null : outcome.failure,
    // Every reading the model answered is billed at the landing — a paid
    // read that failed (cut, refused, unreadable) included (r1-fix typed
    // #21), and a re-read ADDED to the first, never in its place (2.9 c).
    usages: [...state.usages, ...(outcome.answered ?? [])],
    totalsAsked: totalsStillAsked(state, facts, factsVolumeM3(facts)),
    // What the seller has since answered is not asked again (review P3-3).
    ambiguousTotals: unansweredAmbiguity(manual.ambiguous, state.totalsAnswer),
    stage: 'review',
  };
}

/** Is this chat a member of staff who may use «Hisoblatish»? Everyone is
 * (owner's answer 3) — the only question is whether they are staff at all. */
export async function mayCollect(chatId: bigint): Promise<boolean> {
  return (await staffForChat(chatId)) !== null;
}
