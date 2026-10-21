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
   * by index. Kept across «➕ Yana ma'lumot»: an answered line is never asked
   * twice (P1.3).
   */
  lineDone: number[];
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
   * `invoiceGoods`, exact, and never sent to the model twice.
   */
  sheetTexts: string[];
  /**
   * A second spreadsheet of goods, waiting for the seller's answer: add its
   * lines to the first's, or replace them (his 1.13 c — the bot asks). The
   * second used to REPLACE the first in silence.
   */
  pendingInvoice: { goods: import('../../wms/calc/intake').CalcFacts['goods']; label: string } | null;
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
export type IntakeFileKind = 'image' | 'isomedia' | 'pdf' | 'docx' | 'sheet';

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
  if (ascii(4, 8) === 'ftyp') return 'isomedia';
  if (/\.docx?$/i.test(fileName) || /wordprocessingml|msword/i.test(mime ?? '')) return 'docx';
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
    pendingInvoice: null,
    usage: null,
    aiFailure: null,
    analysing: null,
    answers: [],
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
  const { parseManualFacts } = await import('../../wms/calc/intake-manual');
  const text = state.material.join('\n');
  const manual = parseManualFacts(text);

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
          sheetText: state.sheetTexts.join('\n\n') || null,
        }).catch((err: unknown): Outcome => {
          logger.warn({ err }, 'intake analyze failed');
          return { ok: false, failure: 'network' };
        });
  const ai = outcome.ok ? outcome : null;

  // Typed facts win over read ones: the person is looking at the material.
  // A total the text writes TWO ways («1,200 kg») is asked, and the model —
  // which read the same ambiguous text — does not get to answer it either.
  const asked = (field: 'weightKg' | 'volumeM3') => manual.ambiguous.some((a) => a.field === field);
  const facts = {
    fromCity: manual.fromCity ?? ai?.facts.fromCity ?? state.route?.fromCity ?? null,
    toCity: manual.toCity ?? ai?.facts.toCity ?? state.route?.toCity ?? null,
    weightKg: manual.weightKg ?? (asked('weightKg') ? null : (ai?.facts.weightKg ?? null)),
    volumeM3: manual.volumeM3 ?? (asked('volumeM3') ? null : (ai?.facts.volumeM3 ?? null)),
    /**
     * Three sources, in the order of how EXACT they are about the lines.
     *
     * An attached invoice (XLSX/CSV) answers whenever it yields a line
     * (2026-10-09, P1.6): its rows carry the supplier's own codes, units,
     * weights and volumes, and a model's reading of a caption or a photo
     * used to REPLACE them whenever it found one line — the audit's «used
     * only when the AI found no lines at all». The model's goods answer when
     * there is no file. `manual.goods` — lines the person TYPED as goods
     * («Tovar: …», «Kurtka 300 dona 150 kg») — answer last, when neither of
     * the others found anything: before 2026-10-21 they were always empty,
     * so a model that failed left «Tovarlar: —» over a typed name.
     *
     * …and the seller's per-line answers go back on top (P1.3): a re-read
     * after «➕ Yana ma'lumot» must not erase them.
     */
    goods: mergeLineAnswers(
      state.invoiceGoods?.length
        ? state.invoiceGoods
        : ai?.facts.goods?.length
          ? ai.facts.goods
          : (manual.goods ?? []),
      state.lineAnswers,
    ),
  };
  return {
    ...state,
    facts,
    steps: ai?.steps ?? [],
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
