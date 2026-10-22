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
 * review, C1) and whether it only shortened some cells (round-3, R3-C2).
 */
export type SheetText = import('../../wms/calc/intake-ai').IntakeSheetText;

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
  steps: string[];
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
  /** Has the «umumiy kub va kg?» question been asked (podklyuch, once)? */
  totalsAsked: boolean;
  /** Is the pending question about the TOTALS rather than a goods line? */
  askingTotals: boolean;
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
  /** What the analysis cost, carried to the landing — see `AiIntakeResult`. */
  usage: { model: string; inputTokens: number; outputTokens: number } | null;
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
 * The lines dealt with, put onto the goods list as it stands now (round-3
 * review, R3-C5) — `mergeLineAnswers`' rule: the same index while the line
 * there still carries the name, else the first line of that name, else the
 * entry is dropped (a line the re-read no longer lists is nothing to skip).
 * One step stricter than that rule, because a skip has no figure to show it
 * landed: a line is claimed once, so two «Kurtka» lines are two entries and
 * never one line marked twice while the other is lost. Pure.
 */
export function resolveLineDone(
  goods: import('../../wms/calc/intake').CalcFacts['goods'],
  done: IntakeState['lineDone'],
): IntakeState['lineDone'] {
  const list = goods ?? [];
  const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const taken = new Set<number>();
  const out: IntakeState['lineDone'] = [];
  for (const entry of done) {
    const at =
      list[entry.index] && !taken.has(entry.index) && sameName(list[entry.index]!.name, entry.name)
        ? entry.index
        : list.findIndex((g, i) => !taken.has(i) && sameName(g.name, entry.name));
    if (at < 0) continue;
    taken.add(at);
    out.push({ index: at, name: list[at]!.name });
  }
  return out;
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
 * The words a contact line opens with before its value — «Tel: 90 …»,
 * «Mijoz kodi GS777», «Код клиента: …». A lookahead and not `\b`: JS's `\b`
 * is ASCII-only, so «Тел» would never end a word.
 */
const CONTACT_LABEL =
  /^(?:tel(?:efon)?|тел(?:ефон)?|phone|mob(?:il)?|моб(?:ильный)?|mijoz(?:\s+kodi)?|klient(?:\s+kodi)?|client(?:\s+code)?|клиент|kod(?:i)?|код(?:\s+клиента)?|code|raqam(?:i)?|номер|nomer)(?![\p{L}\p{N}])[.\s]*[:：\-–—]?\s*/iu;

/**
 * Is this line the hint's phone or code and nothing else (round-3 review,
 * R3-C4)? Its contact label off, its spacing and «+ - ( ) .» off, what is left
 * is the code (or the code's own number — «Kod 777» for GS777), the phone's
 * digits, or both side by side. Judged against what `parseClientHint` TOOK,
 * never by the shape alone: «3-filial» and «Ali aka 2» carry digits and are
 * names, and a phone the hint did not take stays in the name — the one place
 * it is still written down.
 */
function isContactLine(line: string, hint: { code?: string; phone?: string } | null): boolean {
  if (!hint) return false;
  const compact = line
    .replace(CONTACT_LABEL, '')
    .replace(/[\s+\-–—().]/g, '')
    .toUpperCase();
  if (!compact) return false;
  const code = hint.code ? hint.code.replace(/[\s-]/g, '').toUpperCase() : null;
  const phone = hint.phone ? hint.phone.replace(/\D/g, '') : null;
  let rest = compact;
  if (code && rest.startsWith(code)) rest = rest.slice(code.length);
  else if (code && rest.endsWith(code)) rest = rest.slice(0, -code.length);
  if (!rest) return true;
  if (phone && phone.length >= 7 && /^\d{7,}$/.test(rest) && (phone.endsWith(rest) || rest.endsWith(phone))) return true;
  // The code's number alone, its prefix left off — only while nothing else was taken from the line.
  return (
    rest === compact &&
    code !== null &&
    /^\d+$/.test(rest) &&
    code.endsWith(rest) &&
    /^\p{L}+$/u.test(code.slice(0, -rest.length))
  );
}

/**
 * The customer's NAME, on one line: the lead's name (round-2 review, C8; the
 * summary prints the whole hint, `intakeClientSummary`). Since the typed round
 * a hint may be two or three lines («Ali aka» over «+998 90 123 45 67»), and
 * the raw text named the lead with a newline AND the phone, which the hint
 * already puts in its own column.
 *
 * The lines dropped are the ones that ARE the hint's phone or code
 * (`isContactLine`, round-3 review R3-C4) — no longer every line with a digit:
 * «Ali aka 2» over the phone fell back to the whole text and put the phone in
 * the name, and so did «OOO "Asia Trade" 3-filial» over «Tel: …». A line that
 * is only a label waiting for its value («Mijoz:») is not a name either. When
 * nothing is left, the whole text collapsed onto one line. Null = nothing
 * typed: the caller has its own word for that. Pure.
 */
export function intakeClientLabel(raw: string, hint: { code?: string; phone?: string } | null): string | null {
  const lines = hintLines(raw);
  const named = lines.filter((l) => !isBareLabel(l) && !isContactLine(l, hint));
  return (named.length > 0 ? named : lines).join(' ') || null;
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
 * The names one goods line answers to (round-2 review, C2/C6): the whole name,
 * the name outside its brackets, and what each bracket holds — every one
 * through `goodsNameKey`. The model is TOLD to write «Куртка женская (Ladies
 * jacket)» (its SYSTEM prompt: Russian, the original in brackets), so the
 * whole name alone never equalled the Excel's «Ladies jacket» and an «add»
 * landed the same line twice. Empty keys are dropped.
 */
export function goodsNameKeys(name: string): { whole: string; keys: string[] } {
  const whole = goodsNameKey(name);
  // ASCII and full-width brackets: a Chinese original often comes in （）.
  const inside = [...name.matchAll(/[(（]([^()（）]*)[)）]/gu)].map((m) => goodsNameKey(m[1] ?? ''));
  const outside = goodsNameKey(name.replace(/[(（][^()（）]*[)）]/gu, ' '));
  return { whole, keys: [...new Set([whole, outside, ...inside])].filter(Boolean) };
}

/**
 * Do two names point at the same product the WIDE way — a name ONE of them
 * answers to is the OTHER's whole name: «Куртка женская (Ladies jacket)» is
 * «Ladies jacket», «Kurtka» is «Kurtka (qora)» (round-2 review, C2/C6)? Never
 * bracket against bracket or outside against outside: a bracket is as often a
 * colour or a size, and «Kurtka (qora)» beside «Kurtka (oq)» are two lines of
 * one order.
 */
function namesMeet(a: { whole: string; keys: string[] }, b: { whole: string; keys: string[] }): boolean {
  return a.keys.includes(b.whole) || b.keys.includes(a.whole);
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
 * weight; another factory's same-named product does not. So: the model line
 * states no figure at all (nothing says it is another line), or a figure both
 * lines state agrees.
 */
function figuresAgree(model: GoodsList[number], invoice: GoodsList[number]): boolean {
  const stated = LINE_FIGURES.filter((f) => figureOf(model, f.field) !== null);
  if (stated.length === 0) return true;
  return stated.some((f) => {
    const ours = figureOf(model, f.field)!;
    const theirs = figureOf(invoice, f.field);
    if (theirs === null) return false;
    if (f.unit === null) return ours === theirs;
    const gap = Math.abs(ours - theirs);
    return gap < f.unit || gap <= 0.005 * Math.max(Math.abs(ours), Math.abs(theirs));
  });
}

/** What `pickGoods` lands, and the model's lines it left out as the Excel's own. */
export interface PickedGoods {
  goods: GoodsList;
  /**
   * The model's lines NOT added because an Excel line is the same product
   * (round-3 review, R3-C1) — named to the seller, never dropped in silence:
   * the job would land short by them with no word anywhere.
   */
  sameAsInvoice: GoodsList;
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
 *     lines are appended — except those the Excel already carries, because
 *     the model was shown the PDF and the text, and the text can repeat a
 *     line the Excel has. «Already carries» (round-3 review, R3-C1):
 *      - the same WHOLE name (`goodsNameKey`) — base's rule, kept;
 *      - a name the line answers to (`goodsNameKeys`: the model's «Russian
 *        (original)» meets its Excel original, round-2 review C2) — and then
 *        only when the figures agree too (`figuresAgree`). The wide match
 *        alone threw factory B's «Kurtka (qora)» 200 away against factory A's
 *        «Kurtka» 300, and two factories shipping one generic name is this
 *        business's ordinary day.
 *     The wide match is between a model line and the INVOICE only; among the
 *     model's own lines, the same whole name is one line and nothing wider —
 *     its «Kurtka» and «Kurtka (qora)» are two products it read. What was
 *     left out is returned (`sameAsInvoice`), for the seller to see.
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
    if (input.aiGoods !== 'add' || !input.model?.length) return { goods: input.invoice, sameAsInvoice: [] };
    const invoice = input.invoice.map((row) => ({ row, names: goodsNameKeys(row.name) }));
    const modelWholes = new Set<string>();
    const added: GoodsList = [];
    const sameAsInvoice: GoodsList = [];
    for (const g of input.model) {
      const names = goodsNameKeys(g.name);
      if (!names.whole || modelWholes.has(names.whole)) continue;
      modelWholes.add(names.whole);
      const theExcels = invoice.some(
        (inv) => inv.names.whole === names.whole || (namesMeet(names, inv.names) && figuresAgree(g, inv.row)),
      );
      (theExcels ? sameAsInvoice : added).push(g);
    }
    return { goods: [...input.invoice, ...added], sameAsInvoice };
  }
  if (input.model === null) return { goods: input.typed, sameAsInvoice: [] };
  return { goods: input.model.length > 0 ? input.model : input.typedLabelled, sameAsInvoice: [] };
}

/**
 * The seller's word for the model's lines `pickGoods` left out as the Excel's
 * own (round-3 review, R3-C1): one line, put FIRST in the AI notes — the
 * summary prints the first three notes, each cut at 200 characters
 * (`aiStepsText`), and the card's lenta keeps them. So three names, each cut
 * at 30, and a count of the rest: the whole sentence fits the cut. Null =
 * none were left out.
 */
export function sameAsInvoiceNote(lines: GoodsList): string | null {
  if (lines.length === 0) return null;
  const names = lines.slice(0, 3).map((g) => `«${g.name.length > 30 ? `${g.name.slice(0, 29)}…` : g.name}»`);
  const more = lines.length > 3 ? ` va yana ${lines.length - 3} ta` : '';
  return `⚠️ ${lines.length} ta qator Excel’dagi bilan bir xil deb qo‘shilmadi: ${names.join(', ')}${more}.`;
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
    aiUsed: false,
    images: [],
    imagesSkipped: 0,
    promptMessageId: null,
    ai: opts.ai ?? false,
    hasCertificate: true,
    route: null,
    totalsAsked: false,
    askingTotals: false,
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
    usage: null,
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
  const { parseManualFacts, readGoodsLines } = await import('../../wms/calc/intake-manual');
  const text = state.material.join('\n');
  const manual = parseManualFacts(text);
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
  // The model's lines left out as the Excel's own are SAID, first among the
  // notes, so the summary shows them and the card keeps them (R3-C1).
  const sameNote = sameAsInvoiceNote(picked.sameAsInvoice);
  const facts = {
    fromCity: manual.fromCity ?? ai?.facts.fromCity ?? state.route?.fromCity ?? null,
    toCity: manual.toCity ?? ai?.facts.toCity ?? state.route?.toCity ?? null,
    weightKg: manual.weightKg ?? (asked('weightKg') ? null : (ai?.facts.weightKg ?? null)),
    volumeM3: manual.volumeM3 ?? (asked('volumeM3') ? null : (ai?.facts.volumeM3 ?? null)),
    // The seller's per-line answers go back on top (P1.3): a re-read after
    // «➕ Yana ma'lumot» must not erase them.
    goods: mergeLineAnswers(picked.goods, state.lineAnswers),
  };
  return {
    ...state,
    facts,
    steps: [...(sameNote ? [sameNote] : []), ...(ai?.steps ?? [])],
    aiUsed: Boolean(ai),
    aiFailure: outcome.ok ? null : outcome.failure,
    usage: ai?.usage ?? null,
    ambiguousTotals: manual.ambiguous,
    stage: 'review',
  };
}

/** Is this chat a member of staff who may use «Hisoblatish»? Everyone is
 * (owner's answer 3) — the only question is whether they are staff at all. */
export async function mayCollect(chatId: bigint): Promise<boolean> {
  return (await staffForChat(chatId)) !== null;
}
