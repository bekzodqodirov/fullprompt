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
  'whatsapp', 'вотсап', 'ватсап', 'telegram', 'телеграм', 'tg', 'viber', 'wechat',
]);

/** Where a cut was made in a line: a character no seller types. */
const CUT = '\u0000';
/** A run of digits as a phone is written: «+998 90 123-45-67», «(90) 123 45 67». */
const DIGIT_RUN = /\+?\d(?:[\d\s\-–().]*\d)?/g;
/** A Telegram handle — contact, never a name («Telegram: @murod_uz»). */
const HANDLE = /@[\p{L}\p{N}_.]+/gu;
/** The code's number written after its label, the prefix left off: «Kod 777», «Mijoz kodi: 777» for GS777. */
const CODE_LABEL = String.raw`(?:mijoz(?:\s+kodi)?|klient(?:\s+kodi)?|client(?:\s+code)?|клиент|kod(?:i)?|код|code|id)[\s.:：#№\-–]*|№\s*`;
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

/** The words of a text — letters and digits, everything else a separator. */
const wordsOf = (text: string) => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

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
const HUG = new RegExp(
  `(?:${HUG_SEP}(?<![\\p{L}\\p{N}])(?:${CONTACT_WORD_RE})(?![\\p{L}\\p{N}]))*${HUG_SEP}${CUT}` +
    `(?:${HUG_SEP}(?<![\\p{L}\\p{N}])(?:${CONTACT_WORD_RE})(?![\\p{L}\\p{N}]))*${HUG_SEP}`,
  'giu',
);

/**
 * A ONE-line hint with the hint's phone and code cut OUT of it (round-4
 * review, C-r2 close-variant: «Ali aka +998 90 123 45 67», «Murod GS777»,
 * «Rustam (GS777)» — the commonest way a seller types a prospect — named the
 * lead with the phone, which the hint already puts in its own column). The
 * contact words beside a cut go with it, and a bracket left empty. Null =
 * nothing name-like is left («GS 777 90 123 45 67», «Kod 777»).
 */
function nameBesideHint(line: string, hint: { code?: string; phone?: string }): string | null {
  const cut = cutHint(line, hint);
  if (!cut.took) return line;
  const rest = cut.text
    .replace(HUG, ' ')
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
 *  - `whole` — the name as written;
 *  - `forms` — the names the line IS: the whole, and for a Chinese factory's
 *    bilingual cell with no brackets («女士夹克 Ladies jacket», «女士夹克\nLadies
 *    jacket») its Chinese half and the rest — the model reads such a cell as
 *    «Куртка женская (女士夹克)» and the Excel's whole name met neither half
 *    (round-3 review, collector C2 note);
 *  - `keys` — everything the line answers to: its forms, the name outside its
 *    outermost brackets, and what each holds. The model is TOLD to write
 *    «Куртка женская (Ladies jacket)» (its SYSTEM prompt: Russian, the
 *    original in brackets), so the whole name alone never equalled the
 *    Excel's «Ladies jacket» and an «add» landed the same line twice.
 * Halves only without brackets: «Kurtka (黑色)» split by script would make
 * «Kurtka» a form and meet «Kurtka (qora)» outside against outside — the
 * colour is the bracket. Empty keys are dropped.
 */
export function goodsNameKeys(name: string): { whole: string; forms: string[]; keys: string[] } {
  const whole = goodsNameKey(name);
  const { inside, outside } = bracketParts(name);
  const han = (name.match(/\p{Script=Han}+/gu) ?? []).join(' ');
  const rest = name.replace(/\p{Script=Han}+/gu, ' ');
  const halves = inside.length === 0 && han && /\p{L}/u.test(rest) ? [goodsNameKey(han), goodsNameKey(rest)] : [];
  const forms = [...new Set([whole, ...halves])].filter(Boolean);
  return {
    whole,
    forms,
    keys: [...new Set([...forms, goodsNameKey(outside), ...inside.map(goodsNameKey)])].filter(Boolean),
  };
}

/**
 * Do two names point at the same product the WIDE way — a name ONE of them
 * answers to is a name the OTHER is: «Куртка женская (Ladies jacket)» is
 * «Ladies jacket», «Kurtka» is «Kurtka (qora)» (round-2 review, C2/C6)? Never
 * bracket against bracket or outside against outside: a bracket is as often a
 * colour or a size, and «Kurtka (qora)» beside «Kurtka (oq)» are two lines of
 * one order.
 */
type NameKeys = ReturnType<typeof goodsNameKeys>;
function namesMeet(a: NameKeys, b: NameKeys): boolean {
  return a.keys.some((k) => b.forms.includes(k)) || b.keys.some((k) => a.forms.includes(k));
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
  // The lines left out because the Excel answers are SAID, in the bot's own
  // notes, so the summary shows them beside the model's three and the card
  // keeps them (R3-C1; round 4, C-r1 nit and integration S-a).
  const notes = [sameAsInvoiceNote(picked.sameAsInvoice), typedLeftOutNote(picked.sameAsInvoice)].filter(
    (n): n is string => n !== null,
  );
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
    steps: ai?.steps ?? [],
    notes,
    aiUsed: Boolean(ai),
    aiFailure: outcome.ok ? null : outcome.failure,
    // A paid read that failed (cut, refused, unreadable) still cost what it
    // cost: the day's budget is written from this at the landing (r1-fix
    // typed #21; the typed package's `usage` on a failed outcome).
    usage: ai?.usage ?? (outcome.ok ? null : (outcome.usage ?? null)),
    ambiguousTotals: manual.ambiguous,
    stage: 'review',
  };
}

/** Is this chat a member of staff who may use «Hisoblatish»? Everyone is
 * (owner's answer 3) — the only question is whether they are staff at all. */
export async function mayCollect(chatId: bigint): Promise<boolean> {
  return (await staffForChat(chatId)) !== null;
}
