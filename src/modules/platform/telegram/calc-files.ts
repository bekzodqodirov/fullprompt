import { eq, inArray } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { db } from '../db/client';
import { attachments } from '../db/schema';
import { isUuidShaped } from '../audit/fields';
import { PHOTO_READ_MS, readWithin } from '../files/read-within';
import { getStorage } from '../files/storage';
import { logger } from '../logger';
import {
  collectionDoor,
  intakeFileKind,
  MAX_INTAKE_IMAGES,
  MAX_INTAKE_PDF_BYTES,
  MAX_INTAKE_PDFS,
  type IntakeState,
  type SheetText,
} from './calc-intake';
import {
  fillsWords,
  foldInvoice,
  goodsNameKey,
  notedTotalsNote,
  packingFills,
  packingNote,
  packingCoversHeld,
  packingOfHeld,
  packingTotals,
  positionalFills,
  provenOther,
  rowKindsOf,
  sameFileAgain,
  sameFileNote,
  samePositions,
  sameWorkbookAgain,
  totalsClashNote,
  withFileTotals,
  type GoodsFileMeta,
} from './file-goods';
import type { ForwardPart } from './task-draft';
import { MAX_TELEGRAM_DOWNLOAD_BYTES } from './limits';
import { BRIEF_RETRY_MAX_S } from './retry';
import { botCall } from './send';
import { clipUnits } from '../text/clip';

/**
 * What a file the seller forwards becomes in a «Hisoblatish» collection, and
 * the one home of storing a file the bot was sent — MOVED out of
 * staff-handlers.ts (docs/SAKKIZ-R3.md K5), which re-exports what a test
 * imports. Since K the collection keeps ATTACHMENT IDS and never the bytes
 * (K4): the files are in storage the moment they arrive, and the reading loads
 * them back (`loadIntakeFiles`).
 */

/** How long the bot waits for Telegram to hand over one file. */
const FILE_DOWNLOAD_MS = 30_000;

/** A PDF past this is not shown to the model — Anthropic refuses it anyway. */
const MAX_PDF_BYTES = 10 * 1024 * 1024;

/**
 * A file refused AT ARRIVAL, kept by name for the table (docs/FAYL-OQISH.md
 * §1.1, judge critic-refused-unread): the seller was told then, and the table
 * names it again — «X o‘qilmadi (sabab) — undagi tovarlar hisobga kirmaydi» —
 * because its goods are not in the figure. Named, never blocking: there is no
 * door to take a file back out of a collection. `why` is the reason the
 * seller was told, as a NOUN phrase: it is read inside «X o‘qilmadi (…)» and
 * «X — …», and a «Word fayl o‘qilmaydi» there said «not read» twice (review
 * model-spec-refused-why-doubles-verb).
 */
export function refusedFilePatch(
  state: Pick<IntakeState, 'refusedFiles'>,
  name: string,
  why: string,
): Pick<IntakeState, 'refusedFiles'> {
  return { refusedFiles: [...(state.refusedFiles ?? []), { name, why }] };
}

/**
 * The photographs past the twelve, as ONE entry counted in place (review
 * model-break-photo-cap-names): a Telegram photo has no name, so thirty
 * photos wrote eighteen identical «rasm» entries, and the table named each.
 * The first keeps its own name; from the second on, «N ta rasm».
 */
function photoCapPatch(state: Pick<IntakeState, 'refusedFiles'>, fileName: string): Pick<IntakeState, 'refusedFiles'> {
  const why = `${MAX_INTAKE_IMAGES} tadan ortiq rasm`;
  const list = state.refusedFiles ?? [];
  const at = list.findIndex((f) => f.why === why);
  if (at < 0) return refusedFilePatch(state, fileName || 'rasm', why);
  const counted = /^(\d+) ta rasm$/u.exec(list[at]!.name);
  const n = (counted ? Number(counted[1]) : 1) + 1;
  return { refusedFiles: list.map((f, i) => (i === at ? { name: `${n} ta rasm`, why } : f)) };
}

/** Telegram hands a bot no file past 20 MB (docs/FAYL-OQISH.md §3.4, pdfimg-5): said, never «saqlab bo‘lmadi». */
export const TOO_BIG_SAY = 'Fayl 20 MB dan katta — Telegram uni botga bermaydi. Kichikroq qilib (yoki Excel) yuboring.';
export const TOO_BIG_WHY = '20 MB dan katta';
/** A type storage keeps no attachment of — `readIntakeFile`'s «not read» refusal's reason too. */
export const UNKNOWN_TYPE_WHY = 'noma’lum fayl turi';
/**
 * A picture DOCUMENT past storage's photo ceiling (as-built review MODEL-3):
 * between storage's 15 MB and Telegram's 20 MB a JPEG sent as a file
 * downloads and is then refused, and read as a failed download it dropped the
 * caption and named nothing — every re-send failing the same way. Never
 * `TOO_BIG_SAY`, whose «Telegram uni botga bermaydi» is false here.
 */
export const TOO_LARGE_PHOTO_WHY = '15 MB dan katta rasm';
/**
 * A table saved as HTML or XML, or a macro or binary workbook — what an ERP
 * exports — is a type storage keeps no attachment of (as-built review
 * OWNER-10, REGRESSION-5): «Excel/CSV yuboring» told a seller who sent a table
 * to send a table, and «noma’lum fayl turi» called it unknown. Its own words,
 * with the one cure that works: save it as .xlsx. By the name, else the mime.
 */
const TABLE_EXPORT_WHY: [RegExp, RegExp, string][] = [
  [/\.x?html?$/iu, /^(text\/html|application\/xhtml\+xml)$/iu, 'HTML jadval'],
  [/\.xml$/iu, /^(text|application)\/xml$/iu, 'XML jadval'],
  // A noun phrase with no brackets of its own (review of the fixes RF-FILES-5):
  // read inside «X o‘qilmadi (…)» it nested two, said the extension twice and
  // put an English word in an Uzbek sentence.
  [/\.xlsb$/iu, /^application\/vnd\.ms-excel\.sheet\.binary\.macroenabled\.12$/iu, '.xlsb Excel fayli'],
];
function tableExportWhy(file: { name: string; mime?: string | null }): string | null {
  for (const [ext, mime, why] of TABLE_EXPORT_WHY) {
    if (ext.test(file.name) || (file.mime ? mime.test(file.mime) : false)) return why;
  }
  return null;
}

/**
 * What a collection's door does with a file it could not STORE (docs/
 * FAYL-OQISH.md §3.4) — one rule for the file door and the add door's two
 * media doors. A refusal no re-send can heal — past Telegram's 20 MB, a type
 * storage will not keep — is said in its own words and named on the table
 * (`refusedFiles`), and the door reads the caption: no later copy of the
 * message brings the file, so its typed goods would be lost with it. Null for
 * a `download_failed`: then the door TAKES NOTHING — the same message sent
 * again brings the file and its caption together, and a caption read now was
 * read twice when the seller did what he was told, two rows of one good,
 * priced twice (review model-break-caption-kept-then-retyped). The burst
 * take has always left such a part whole for the re-press.
 */
export function permanentRefusal(
  state: Pick<IntakeState, 'refusedFiles'>,
  refused: BotFileRefusal['refused'],
  file: { name: string; isPhoto: boolean; mime?: string | null },
): { patch: Pick<IntakeState, 'refusedFiles'>; say: string } | null {
  const name = file.name || (file.isPhoto ? 'rasm' : 'fayl');
  const label = file.name ? `«${file.name}»` : 'Fayl';
  if (refused === 'too_big') return { patch: refusedFilePatch(state, name, TOO_BIG_WHY), say: TOO_BIG_SAY };
  if (refused === 'too_large') {
    return {
      patch: refusedFilePatch(state, name, TOO_LARGE_PHOTO_WHY),
      // «(yoki PDF)» offered a route the PDF rule closes (review of the fixes
      // RF-FILES-4): a picture wrapped in a PDF keeps its bytes, and past
      // 10 MB a PDF is refused again. The cure that always works is a PHOTO —
      // Telegram shrinks it, and the model reads 1568 px anyway.
      say: `🖼 ${label} — rasm 15 MB dan katta, saqlanmadi. Fayl emas, rasm qilib (yoki kichraytirib) yuboring.`,
    };
  }
  const table = refused === 'unsupported' ? tableExportWhy(file) : null;
  if (table) {
    return {
      patch: refusedFilePatch(state, name, table),
      say: `📎 ${label} kartada saqlanmadi: ${table} o‘qilmaydi — Excel’da .xlsx qilib saqlab yuboring.`,
    };
  }
  if (refused === 'unsupported') {
    return {
      patch: refusedFilePatch(state, name, UNKNOWN_TYPE_WHY),
      say: `📎 ${label} kartada saqlanmadi: faylning bu turi o‘qilmaydi — rasm, PDF va Excel/CSV yuboring.`,
    };
  }
  return null;
}

/**
 * Does the PDF say it is ENCRYPTED (docs/FAYL-OQISH.md §3.4, judge
 * model-encrypt-sniff)? Its trailer's `/Encrypt n g R` — looked for in the
 * trailer region only: the last 4 KB, and the first 2 KB where a linearized
 * file keeps its first-page trailer. Never the whole file, where a page's own
 * text may say «/Encrypt» (measured: an uncompressed page about the
 * dictionary greps true and is no encrypted file). A WARNING, never a
 * refusal: an owner-password-only PDF (no-print, no-edit — how many supplier
 * ERPs export) carries the same entry and opens with no password; whether the
 * API reads it is learned at the reading, where a refusal is named
 * (`unreadPdfs`).
 */
export function pdfMayBeEncrypted(body: Buffer): boolean {
  const entry = /\/Encrypt\s+\d+\s+\d+\s+R\b/;
  return (
    entry.test(body.subarray(Math.max(0, body.length - 4096)).toString('latin1')) ||
    entry.test(body.subarray(0, 2048).toString('latin1'))
  );
}

/**
 * The namespace of an intake file's attachment id: `uuidv5(noteId:messageId)`
 * (durability-1), so the same Telegram message stored twice is one row.
 */
const INTAKE_FILE_NS = '3c6e0b9a-5d2f-4b7e-9a41-8f2d6c0e1b57';

/**
 * A spreadsheet that cannot be read, said per reason (his 1.6 a). Keyed by the
 * reader's OWN union, so a reason it learns tomorrow is a compile error here
 * rather than a seller reading «undefined».
 */
type SheetRefusalReason = Extract<import('../../wms/deals/goods-file').GoodsFileRead, { kind: 'refused' }>['reason'];
export const SHEET_REFUSAL: Record<SheetRefusalReason, (label: string) => string> = {
  old_format: (label) => `📄 ${label} — Excel 95 yoki undan eski format, o‘qilmaydi. .xlsx qilib saqlab yuboring.`,
  encrypted: (label) => `📄 ${label} — parol bilan himoyalangan, o‘qilmaydi. Parolsiz yuboring.`,
  broken: (label) => `📄 ${label} — Excel fayl buzilgan yoki o‘qib bo‘lmadi. Qayta saqlab yuboring.`,
  empty: (label) => `📄 ${label} — jadval bo‘sh.`,
  pictures: (label) => `📄 ${label} — jadval bo‘sh. ${PICTURES_LINE}`,
};

/** The same refusals as a table's reason (`refusedFiles`); null = nothing of it was lost. A NOUN phrase each (`refusedFilePatch`). */
export const SHEET_REFUSAL_WHY: Record<SheetRefusalReason, string | null> = {
  old_format: 'Excel 95 yoki undan eski format',
  encrypted: 'parol bilan himoyalangan',
  broken: 'Excel fayl buzilgan',
  empty: null,
  // A workbook whose only content is pictures (§4.4): the goods it shows were
  // never read, so the table names it as a file the AI did not see.
  // A noun phrase (as-built review OWNER-11, MODEL-7): «X o‘qilmadi (Excel
  // ichidagi rasm o‘qilmaydi)» said «not read» twice.
  pictures: 'ichida faqat rasm, jadval yo‘q',
};

/**
 * A workbook whose goods are in a picture (docs/FAYL-OQISH.md §4.4,
 * unmapped-embedded-picture-dropped): nothing reads a picture inside an
 * Excel, and «jadval bo‘sh» or «AI o‘qiydi» alone sent nobody to the cure.
 */
export const PICTURES_LINE = 'Excel ichidagi rasm o‘qilmaydi — rasmni alohida (rasm yoki PDF qilib) yuboring.';

/**
 * What a file is worth to the collection, and what the seller is told — pure.
 * No file asks anything (his 1a, docs/IKKI-ESHIK.md §1.1): there is no
 * keyboard. `say` is a refusal or the receipt's lines; the informational ones
 * also ride in `patch.fileNotes` (§1.2.5), for the card.
 */
export interface FileAnswer {
  patch: Partial<IntakeState>;
  say: string | null;
}

/**
 * The words a file gets as a message of its OWN — only a refusal (docs/IKKI-
 * ESHIK.md §1.4): HEIC, Word, video, archive, too big, the 4th PDF, a broken
 * sheet. Everything else the answer says is a line of the ONE «Qabul
 * qilindi» prompt, which draws it from durable state: an answer appending to
 * `fileNotes` (the Excel decisions, «🖼 … rasm sifatida o‘qiladi»), a PDF the
 * model reads (`pdfs`), a header-less sheet (`sheetTexts`, with its current
 * fit). Null = nothing to send. Every door that reads a file asks this, so a
 * file is never announced twice.
 */
export function refusalOf(answer: FileAnswer): string | null {
  if (!answer.say) return null;
  const p = answer.patch;
  return p.fileNotes !== undefined || p.pdfs !== undefined || p.sheetTexts !== undefined ? null : answer.say;
}

/**
 * A header-less sheet's line, and what the model will not read of it — `kept`
 * of `total` rows by the CURRENT fit (`fitSheetRows`), `readerCut` = the
 * reader stopped before its end. One home for the receipt's words and the
 * prompt's (§1.4), which redraws them as later files squeeze the budget.
 */
export function sheetTextLine(
  label: string,
  fit: { kept: number; total: number },
  readerCut: boolean,
  saw: Pick<SheetText, 'why' | 'pictures'> = {},
): string {
  const cut =
    fit.kept === 0
      ? '\n⚠️ Bu jadval AI ga sig‘madi (oldingi jadvallar bilan birga juda katta) — VED faylni kartadan o‘qiydi.'
      : readerCut
        ? `\n⚠️ Jadval katta: AI faqat boshini o‘qiydi (birinchi ${fit.kept} qator) — qolganini VED fayldan ko‘radi.`
        : fit.kept < fit.total
          ? `\n⚠️ Jadval katta: AI faqat birinchi ${fit.kept} / ${fit.total} qatorini o‘qiydi — qolganini VED fayldan ko‘radi.`
          : '';
  // What the reader saw says the first words (docs/FAYL-OQISH.md §4.4): a
  // header it FOUND, with no goods row under it, is not «sarlavhasini topa
  // olmadim»; a text with no row pairing a name with a figure promises no
  // goods the model could find.
  const head =
    saw.why === 'header'
      ? 'jadvaldan tovar qatorlarini o‘zim ajrata olmadim, AI o‘qiydi.'
      : saw.why === 'no_rows'
        ? 'jadvalda tovar qatori ko‘rinmadi.'
        : 'jadval sarlavhasini topa olmadim, AI o‘qiydi.';
  return `📄 ${label} — ${head}${saw.pictures ? ` ${PICTURES_LINE}` : ''}${cut}`;
}

/**
 * A workbook's other sheets the shared budget squeezed (round-4 integration
 * S-d) — `now` of `of` rows still read. `cause`: said at the receipt of the
 * sheet that squeezed them («Shu jadval tufayli …»); the prompt redraws the
 * standing fit without it.
 */
export function squeezedLine(label: string | undefined, now: number, of: number, cause = true): string {
  const whose = label ? `${label} ning` : 'oldingi Excel faylning';
  const lead = cause ? 'Shu jadval tufayli ' : '';
  return now === 0
    ? `⚠️ ${lead}${whose} boshqa varaqlari AI ga sig‘madi — u yerdagi jami (kub/kg) o‘qilmaydi.`
    : `⚠️ ${lead}AI ${whose} boshqa varaqlaridan ${cause ? 'endi ' : ''}faqat ${now} / ${of} qatorini o‘qiydi.`;
}

/**
 * How spreadsheet texts fit what the model reads, in ROWS — `fitSheetRows` at
 * the reader's cap (round-3 review, R3-C2: counted in lines, a sheet's
 * «[name]» heading was a row, and a 20-row file read «birinchi 21 qator»).
 */
export type SheetFit = (texts: readonly string[]) => { kept: number[]; total: number[] };

/**
 * A PDF: shown to the model, within the count and byte caps. Beside an Excel
 * list it is no longer asked about (his 1a, docs/IKKI-ESHIK.md §1.2.2, M3):
 * the model is shown the Excel's goods and lists only the new ones
 * (`aiGoods: 'add'`), and the reading says what it added. By attachment id
 * (K4); the caps count `bytes`.
 */
export function receivePdf(
  state: IntakeState,
  pdf: { attachmentId: string; name: string; bytes: number },
  label: string,
  /** Its trailer names an `/Encrypt` dictionary (`pdfMayBeEncrypted`) — warned, still read. */
  opts: { encrypted?: boolean } = {},
): FileAnswer {
  // Every refusal here is named on the table too (`refusedFiles`), with the
  // reason the seller is told now.
  if (pdf.bytes > MAX_PDF_BYTES) {
    return {
      patch: refusedFilePatch(state, pdf.name, 'PDF 10 MB dan katta'),
      say: `📄 ${label} — PDF juda katta (10 MB dan ortiq), AI o‘qimaydi. Kartada saqlandi.`,
    };
  }
  // Only the PDFs a reading will SEND count against the caps: one the API
  // refused is never sent again (`unreadPdfs`, `loadIntakeFiles`), and
  // counted it refused the very password-free copy its warning asked for
  // (review model-break-pdf-caps-count-refused).
  const refused = new Set(state.unreadPdfs ?? []);
  const live = state.pdfs.filter((p) => !refused.has(p.attachmentId));
  // Two caps, two sentences (pdfimg-8): the third of three 5 MB PDFs was
  // told «3 tadan ortiq PDF» — it was the third, and the bytes stopped it.
  if (live.length >= MAX_INTAKE_PDFS) {
    return {
      patch: refusedFilePatch(state, pdf.name, `${MAX_INTAKE_PDFS} tadan ortiq PDF`),
      say: `📄 ${label} — bitta so‘rovga ${MAX_INTAKE_PDFS} tadan ortiq PDF o‘qilmaydi. Kartada saqlandi.`,
    };
  }
  const bytes = live.reduce((n, p) => n + p.bytes, 0);
  if (bytes + pdf.bytes > MAX_INTAKE_PDF_BYTES) {
    const mb = Math.round(MAX_INTAKE_PDF_BYTES / (1024 * 1024));
    return {
      patch: refusedFilePatch(state, pdf.name, `PDFlar jami ${mb} MB dan oshdi`),
      say: `📄 ${label} — PDFlar jami ${mb} MB dan oshdi, bu PDF AI ga o‘qilmaydi. Kichikroq qilib yuboring. Kartada saqlandi.`,
    };
  }
  // A PDF that may be password-protected is READ and warned about (§3.4):
  // the warning is a receipt-time note, which the ONE prompt draws.
  const warned = opts.encrypted
    ? { fileNotes: [...(state.fileNotes ?? []), `⚠️ ${label} parol bilan himoyalangan bo‘lishi mumkin — AI o‘qiy olmasa, parolsiz saqlab yuboring.`] }
    : {};
  return {
    patch: { pdfs: [...state.pdfs, pdf], ...beside(state), ...warned },
    say: `📄 ${label} — AI o‘qiydi.`,
  };
}

/**
 * The prompt's line per model-read file (docs/IKKI-ESHIK.md §1.4) — drawn
 * from durable state at DRAW time, so a header-less sheet's cut is the fit
 * as it stands now, after every later file: each PDF the model reads, each
 * header-less sheet with what of it the model will read, and each
 * workbook's other sheets the shared budget squeezed. Pure; `fit` is
 * `fitSheetRows` at the reader's cap (what `receiveSheetText` asks).
 */
export function promptFileLines(
  state: Pick<IntakeState, 'pdfs' | 'sheetTexts' | 'invoiceTexts' | 'unreadPdfs'>,
  fit: SheetFit,
): string[] {
  const all = [...state.sheetTexts, ...state.invoiceTexts];
  const fitted = all.length > 0 ? fit(all.map((s) => s.text.trim())) : { kept: [], total: [] };
  // A PDF the API refused stays in `pdfs` until the NEXT reading moves it to
  // the named refusals, and the reading sends it no more (`loadIntakeFiles`):
  // «AI o‘qiydi» under the seller's next file promised what the table above
  // had just said did not happen (as-built review WORDS-5). The table's words.
  const refused = new Set(state.unreadPdfs ?? []);
  const pdfs = state.pdfs.map((p) =>
    refused.has(p.attachmentId) ? `📄 «${p.name}» — AI bu faylni qabul qilmadi.` : `📄 «${p.name}» — AI o‘qiydi.`,
  );
  const sheets = state.sheetTexts.map((s, i) =>
    sheetTextLine(s.label ?? 'Jadval', { kept: fitted.kept[i] ?? 0, total: fitted.total[i] ?? 0 }, s.cut, s),
  );
  // A workbook's other sheets, by its file: squeezed only when the fit took
  // rows the reader itself kept — its own cut is a receipt note already.
  const byLabel = new Map<string, { now: number; of: number }>();
  state.invoiceTexts.forEach((t, j) => {
    if (t.cut) return;
    const at = state.sheetTexts.length + j;
    const now = fitted.kept[at] ?? 0;
    const of = fitted.total[at] ?? 0;
    const key = t.label ?? '';
    const was = byLabel.get(key) ?? { now: 0, of: 0 };
    byLabel.set(key, { now: was.now + now, of: was.of + of });
  });
  const squeezed = [...byLabel].flatMap(([label, f]) => (f.now < f.of ? [squeezedLine(label || undefined, f.now, f.of, false)] : []));
  return [...pdfs, ...sheets, ...squeezed];
}

/**
 * A model-read file beside an Excel list — or an Excel list beside one —
 * takes the add path (§1.2.2): `add`, written only where nobody has answered
 * (a hydrated «context» was the seller's own word and stands).
 */
function beside(state: IntakeState): Partial<IntakeState> {
  return (state.invoiceGoods ?? []).length > 0 && state.aiGoods === null ? { aiGoods: 'add' } : {};
}

/**
 * A spreadsheet with no header the reader knows: its text goes to the model
 * (his 1.2 b) — and the seller is told NOW when the model will not read all
 * of it (round-1 review, a17), rather than the job landing short.
 *
 * Two cuts, both said: the READER's (`sheet.cut` — it stops every file at its
 * own budget, so one oversized file reached this fit already short and passed
 * it whole: «AI o‘qiydi» and nothing more, round-2 review C1/C4/C5), and this
 * fit's, when the files together outgrow what the model reads. Both are ROWS
 * missing. A file whose rows are all there and only some long cells were
 * shortened (`sheet.cellsCut`) is told nothing: «faqat boshini o‘qiydi» about
 * a table the model reads in full was false, and the seller cannot act on it
 * (round-3 review, R3-C2 — the model is told, `sheetsPromptText`).
 */
export function receiveSheetText(state: IntakeState, label: string, sheet: SheetText, fit: SheetFit): FileAnswer {
  const sheetTexts = [...state.sheetTexts, { ...sheet, label }];
  // The new file's place in what the model is shown (`analyzeCollected`):
  // after the separate files before it, ahead of any workbook's other sheets.
  const at = sheetTexts.length - 1;
  const texts = (list: readonly SheetText[]) => list.map((s) => s.text.trim());
  const fitted = fit(texts([...sheetTexts, ...state.invoiceTexts]));
  const kept = fitted.kept[at] ?? 0;
  const total = fitted.total[at] ?? 0;
  // The budget is SHARED and this file stands ahead of the workbooks' other
  // sheets, so it can push THEIR rows out — the packing list the shipment's
  // totals are read from. The model is told under the sheet; the seller was
  // told nothing (round-4 integration S-d: 192 rows of «A.xlsx» fell to 49).
  const before = fit(texts([...state.sheetTexts, ...state.invoiceTexts]));
  const squeezed = state.invoiceTexts.flatMap((t, j) => {
    const was = before.kept[state.sheetTexts.length + j] ?? 0;
    const now = fitted.kept[sheetTexts.length + j] ?? 0;
    const of = fitted.total[sheetTexts.length + j] ?? 0;
    if (now >= was) return [];
    return [`\n${squeezedLine(t.label, now, of)}`];
  });
  return {
    patch: { sheetTexts, ...beside(state) },
    say: sheetTextLine(label, { kept, total }, sheet.cut, sheet) + squeezed.join(''),
  };
}

/**
 * A spreadsheet the reader MAPPED: its lines are exact (P1.6). Several of them
 * are no longer ASKED about (his 1a, docs/IKKI-ESHIK.md §1.2.2) — the bot
 * decides by the sheets' COLUMNS, never their line names, and names what it
 * did:
 *  - the FIRST is the goods list, whatever its shape, and its other sheets
 *    ride with it as `invoiceTexts`;
 *  - a PACKING-shaped further one (a carton or gross column, no money) adds
 *    no row and sets no count: it gives the shipment's totals (`fileTotals`,
 *    brutto only from a gross column, a net Σ as a netto, the cube) and the
 *    NET weight of a held row that has none, and its whole text joins the
 *    model's totals-only sheets;
 *  - an INVOICE-shaped one after a packing list that came first takes the
 *    goods role — file order never decides which counts land — and the
 *    packing list becomes totals and gap fills;
 *  - an INVOICE-shaped further one is compared row by row (`foldInvoice`):
 *    the same row again is taken once, anything else is added and named.
 * A TOP-UP (an add or seeded collection, §1.2.3) writes no totals from its
 * material (R3 interp 2): a packing list's figures go on the note instead.
 *
 * The goods rows are exact whatever the size; the OTHER sheets' text is what
 * the reader cuts (`textCut`), and that is said too — those sheets are where
 * the shipment's totals are read from (round-2 review, C1). Only when ROWS are
 * missing: shortened cells (`cellsCut`) travel to the model and say nothing
 * here (round-3 review, R3-C2). Every line said is also a receipt-time note
 * (`fileNotes`, §1.2.5), written in the same patch as the file.
 */
export function receiveGoodsSheet(
  state: IntakeState,
  sheet: {
    goods: NonNullable<IntakeState['invoiceGoods']>;
    label: string;
    text: string;
    textCut: boolean;
    cellsCut: boolean;
    where: string;
    /**
     * The reader's ceiling on goods rows, when this file reached it
     * (`MAX_GOODS_ROWS`): a 6,000-line list answered «500 ta tovar o‘qildi»
     * and nothing about the rest (round-4 integration S-b).
     */
    capped?: number;
    /** The sheet's shape by its columns (`SheetShape`); absent = an invoice, nothing summed. */
    shape?: Partial<Pick<GoodsFileMeta, 'shape' | 'weightKind' | 'grossKg' | 'grossColumn' | 'volumeM3'>>;
    /** A packing list's own rows as text, with the reader's cuts (`GoodsFileRead.ownText`). */
    ownText?: { text: string; cut: boolean; cellsCut: boolean } | null;
    /**
     * `text` is the workbook's sheets with NO header mapped (docs/FAYL-OQISH.md
     * §4.1) — model-read material that may hold goods of its own, which the
     * reading names rather than drops (§4.6). Absent = a caller that hands
     * the other sheets over as one text, as before.
     */
    unmapped?: boolean;
    /**
     * The workbook was judged «not sent before» as a WHOLE (`sameWorkbookAgain`,
     * §4.1): its goods sheet is not asked alone, or a workbook whose goods
     * sheet came before and whose «Zavod B» is new would read «bu fayl avval
     * yuborilgan».
     */
    wholeJudged?: boolean;
    /**
     * A FURTHER mapped sheet of the workbook whose goods sheet came first
     * (docs/FAYL-OQISH.md §4.2): judged by its shape against everything held,
     * never as a second file — `sheet` its name, and the goods sheet's name,
     * rows as read and shape.
     */
    further?: {
      sheet: string;
      goodsSheet: string;
      goodsRows: NonNullable<IntakeState['invoiceGoods']>;
      goodsShape: 'invoice' | 'packing';
      /**
       * The most goods one request holds (`MAX_CALC_ITEMS`, the queue's own
       * limit): a fold past it is not made (as-built review REGRESSION-1).
       * Absent = no bound (a caller from before).
       */
      itemCap?: number;
    };
    /**
     * The rows the reader did NOT take as goods (docs/FAYL-OQISH.md §5.5):
     * the receipt's words for them (`droppedRowsLine`, null = nothing worth
     * saying) and the text of each row it names.
     */
    dropped?: { line: string | null; rows: readonly string[] };
  },
): FileAnswer {
  const { goods, label, where } = sheet;
  // A further sheet's own words name the SHEET (as-built review SHEETS-1): its
  // dropped rows are that sheet's, never the goods sheet's.
  const ownLabel = sheet.further ? `${label}, ${sheetName(sheet.further.sheet)} varag‘i` : label;
  const texts: SheetText[] = sheet.text
    ? [{ text: sheet.text, cut: sheet.textCut, cellsCut: sheet.cellsCut, label, ...(sheet.unmapped ? { unmapped: true as const } : {}) }]
    : [];
  // A row not taken as goods is SAID and SHOWN, never lost in silence
  // (§5.5, review reader-b-break-dropped-has-no-reader): a figure-less last
  // line under the list may be a real good — «Шапка», «Шарф» after the rows
  // that carry figures — and the reader cannot tell it from «Made in China».
  // The seller reads it on the receipt (a receipt-time note: the prompt and
  // the card's note carry it, so the VED does too) and types it back if it
  // is a good; on the AI door the model reads the same rows beside the list,
  // under the totals-only heading. The plain door asks no model of a lone
  // Excel, and a footer must not start one there; a label-only «TOTAL» is no
  // news to the seller or the model (`droppedRowsLine`) and starts none.
  const droppedRows = sheet.dropped?.rows ?? [];
  if (droppedRows.length > 0 && collectionDoor(state) === 'ai') {
    texts.push({
      text: [`[Под таблицей ${sheet.further ? `${label}, лист ${sheetName(sheet.further.sheet)}` : label}: строки, не взятые как товары]`, ...droppedRows].join('\n'),
      cut: false,
      cellsCut: false,
      label,
      // Context for a reading, never the reason for one (as-built review MODEL-8).
      dropped: true,
    });
  }
  // Where the material stood: a totals answer given before this file is
  // older than what it gave (`totalsDoubts`, §1.2.5) — kept ON the file, so a
  // packing list that came first hands its own mark over (PF-ADV-9).
  const at = { material: state.material.length, files: state.fileCount + 1 };
  const packing = sheet.shape?.shape === 'packing';
  const meta: GoodsFileMeta = {
    label,
    shape: sheet.shape?.shape ?? 'invoice',
    weightKind: sheet.shape?.weightKind ?? null,
    grossKg: sheet.shape?.grossKg ?? null,
    grossColumn: sheet.shape?.grossColumn ?? false,
    volumeM3: sheet.shape?.volumeM3 ?? null,
    rows: goods.length,
    text: packing ? (sheet.ownText?.text ?? null) : null,
    ...(packing && sheet.ownText ? { textCut: sheet.ownText.cut, textCellsCut: sheet.ownText.cellsCut } : {}),
    at,
    ...(sheet.capped ? { capped: true } : {}),
  };
  const ownText = (m: GoodsFileMeta): SheetText[] =>
    m.text ? [{ text: m.text, cut: m.textCut ?? false, cellsCut: m.textCellsCut ?? false, label: m.label }] : [];
  const cutLines = [
    ...(sheet.dropped?.line ? [`📄 ${ownLabel} — ${sheet.dropped.line}.`] : []),
    ...(sheet.capped
      ? [`⚠️ Bitta fayldan ko‘pi bilan ${sheet.capped} ta tovar qatori o‘qiladi — fayl uzunroq bo‘lsa, qolganini VED fayldan ko‘radi.`]
      : []),
    ...(sheet.text && sheet.textCut
      ? [
          '⚠️ Jadval katta: AI boshqa varaqlarning faqat boshini o‘qiydi' +
            // «the goods list was read in full» is false of a capped one.
            (sheet.capped ? '.' : ' (tovarlar ro‘yxati to‘liq olindi).'),
        ]
      : []),
  ];
  const readLine = `📄 ${label} — ${goods.length} ta tovar o‘qildi${where}.`;
  const topUp = state.amend !== null || state.seed !== null;
  const held = state.invoiceGoods ?? [];
  const files = state.goodsFiles ?? [];
  const answer = (patch: Partial<IntakeState>, lines: string[]): FileAnswer => ({
    patch: { ...patch, fileNotes: [...(state.fileNotes ?? []), ...lines] },
    say: lines.join('\n'),
  });
  // A packing list's totals: the collection's, or — in a top-up — the note's.
  const totalsOf = (m: GoodsFileMeta, rows: NonNullable<IntakeState['invoiceGoods']>, rowsFrom: string, filled: number) => {
    const totals = packingTotals(m, rows);
    if (topUp) {
      return {
        patch: {},
        lines: [notedTotalsNote(m.label, totals), ...(filled > 0 ? [`📄 ${m.label} — ${fillsWords(filled)}`] : [])],
      };
    }
    const kept = withFileTotals(state.fileTotals ?? null, { ...totals, label: m.label, at: m.at ?? at });
    return {
      patch: { fileTotals: kept.fileTotals },
      lines: [
        packingNote(m.label, rowsFrom, totals, m.grossColumn, filled),
        ...(kept.clash && state.fileTotals ? [totalsClashNote(m.label, state.fileTotals.label)] : []),
      ],
    };
  };

  if (sheet.further && held.length > 0) return receiveFurtherSheet(state, sheet, sheet.further, meta, cutLines, texts, { answer, totalsOf, ownText });
  // The rows the request already stores (an add or seeded collection).
  const kept = state.amend?.items ?? state.seed ?? [];
  if (held.length === 0) {
    if (topUp && packing && kept.length > 0) {
      // A top-up's packing list is a NOTED file (§1.2.3): its totals go on the
      // note for the VED and its rows change no row — kept as goods, every one
      // a stored row does not `sameLine` landed as a 🆕 line, the request's
      // own goods priced twice (review PF-SPEC-2, law-money-5). Its text rides
      // with the model's totals-only sheets; it is no goods list, so an
      // invoice after it is the goods list and takes nothing from it. Only
      // while the request HAS rows for it to be the totals of
      // (docs/FAYL-OQISH.md §4.5, known-2): a returned request with none, or a
      // ➕ on an empty one, priced nothing twice by taking it — and noting it
      // withheld the only goods list there was, under a heading telling the
      // model its goods were «already taken».
      return answer(
        { invoiceTexts: [...state.invoiceTexts, ...ownText(meta), ...texts] },
        [notedTotalsNote(label, packingTotals(meta, goods)), ...cutLines],
      );
    }
    // The goods list. A model-read file already here takes the add path (M3).
    return answer(
      {
        invoiceGoods: goods,
        invoiceTexts: [...state.invoiceTexts, ...texts],
        goodsFiles: [meta],
        ...(state.aiGoods === null && (state.pdfs.length > 0 || state.sheetTexts.length > 0) ? { aiGoods: 'add' as const } : {}),
      },
      [readLine, ...cutLines],
    );
  }
  // The same file again: nothing of it is new, and it is said (PF-ADV-6).
  if (!sheet.wholeJudged && sameFileAgain(held, goods, sheet.text, state.invoiceTexts)) {
    return answer({}, [sameFileNote(label)]);
  }
  const kinds = rowKindsOf(files, held.length);
  if (packing && packingOfHeld(held, kinds, goods, meta.weightKind)) {
    // The same goods again: totals and the netto gaps, never a row.
    const fill = packingFills(held, kinds, goods, meta.weightKind);
    const totals = totalsOf(meta, goods, 'oldingi fayldan', fill.filled);
    return answer(
      {
        invoiceGoods: fill.goods,
        invoiceTexts: [...state.invoiceTexts, ...ownText(meta), ...texts],
        ...totals.patch,
      },
      [...totals.lines, ...cutLines],
    );
  }
  if (topUp && packing) {
    // A top-up's packing list is a NOTED file whether or not rows are held
    // (§1.2.3): the commonest one is the WHOLE shipment's — the stored rows
    // and the new ones — so it is exactly the list that is not «of the held
    // goods», and folded as another factory's invoice its rows landed as 🆕
    // lines beside the request's own, priced twice (as-built review FILES-2,
    // law-money-5). Its totals go on the note; its rows change nothing.
    return answer(
      { invoiceTexts: [...state.invoiceTexts, ...ownText(meta), ...texts] },
      [notedTotalsNote(label, packingTotals(meta, goods)), ...cutLines],
    );
  }
  const first = files.length === 1 ? files[0]! : null;
  if (
    !packing &&
    // …and on a top-up whose packing list WAS the goods list (§4.5: nothing
    // stored for it to be the totals of) — barred there too, the invoice after
    // it was folded in as new goods and the order read twice (review
    // sheets-break-empty-topup-swap). `totalsOf` keeps a top-up's totals on
    // the note.
    !(topUp && kept.length > 0) &&
    first &&
    first.shape === 'packing' &&
    first.rows === held.length &&
    packingOfHeld(goods, Array.from({ length: goods.length }, () => meta.weightKind), held, first.weightKind)
  ) {
    // The packing list came first: this invoice takes the goods role, and the
    // packing list's rows become its totals and its netto gap fills — under
    // the packing list's own receipt mark (PF-ADV-9).
    const fill = packingFills(goods, Array.from({ length: goods.length }, () => meta.weightKind), held, first.weightKind);
    const totals = totalsOf(first, held, `${label} dan`, fill.filled);
    return answer(
      {
        invoiceGoods: fill.goods,
        invoiceTexts: [...state.invoiceTexts, ...ownText(first), ...texts],
        goodsFiles: [meta],
        ...totals.patch,
      },
      [readLine, ...cutLines, ...totals.lines],
    );
  }
  // Anything else is compared row by row — an invoice, and a packing-shaped
  // list whose rows are not the held goods: another factory's own list, whose
  // goods are new goods and whose totals are not the shipment's (PF-ADV-5).
  const fold = foldInvoice(held, kinds, goods, meta.weightKind, label);
  return answer(
    {
      invoiceGoods: fold.goods,
      invoiceTexts: [...state.invoiceTexts, ...texts],
      goodsFiles: [...files, { ...meta, rows: fold.added, text: null }],
    },
    // The fold's own head names the file's rows («3 ta yangi tovar
    // qo‘shildi», «2 tasi ro‘yxatda bor edi, …»): «N ta tovar o‘qildi» above
    // it said the same twice, and spent the ONE prompt's 4096 twice per file
    // (§1.2.4; as-built review CHAT-6).
    fold.notes.length > 0 ? [fold.notes[0]!, ...cutLines, ...fold.notes.slice(1)] : [readLine, ...cutLines],
  );
}

/**
 * A packing list of SOME of the held goods, beside another factory's folded in
 * (as-built review SHEETS-3): its netto gaps are filled, its totals are not the
 * shipment's and are not taken.
 */
function partOfHeldNote(label: string, filled: number): string {
  const fills = filled > 0 ? ` ${fillsWords(filled)}` : '';
  return `📄 ${label} — ro‘yxatdagi tovarlarning bir qismi: boshqa tovarlar unda yo‘q, shuning uchun umumiy brutto va kub butun yuk uchun olinmadi.${fills}`;
}

/**
 * Did the standing totals TAKE a figure (the independent check's IC-NEW-3)?
 * Two packing lists that disagreed leave a clash with both figures null —
 * the seller was already told «ikkalasi ham olinmadi», so «undan olingan …
 * endi butun yukniki emas» would name figures that were never taken.
 */
const tookFigures = (t: NonNullable<IntakeState['fileTotals']>): boolean => t.weightKg !== null || t.volumeM3 !== null;

/** Totals a packing list gave before another factory's goods were folded in — no longer the shipment's (SHEETS-3). */
function staleTotalsNote(label: string): string {
  return `📄 ${label} — undan olingan umumiy brutto va kub endi butun yukniki emas: ro‘yxatga boshqa tovarlar qo‘shildi, shuning uchun olinmadi.`;
}

/**
 * Were the standing `fileTotals` written BEFORE goods of another file were
 * folded into the list (review of the fixes RF-TOTALS-1)? Then they are the
 * list's as it stood, never with those goods in it. Judged by the receipt
 * marks: a folded goods file that added rows and arrived after the totals.
 * The sheets of ONE workbook share a mark, and a fold among them already
 * drops what stood before it (SHEETS-3), so totals that share a fold's mark
 * were written after it — a whole packing list later in the same workbook.
 */
function totalsBeforeFold(state: Pick<IntakeState, 'fileTotals' | 'goodsFiles'>): boolean {
  const totals = state.fileTotals;
  if (!totals) return false;
  return (state.goodsFiles ?? []).slice(1).some((f) => f.rows > 0 && (f.at === undefined || f.at.files > totals.at.files));
}

/** A sheet's name as the seller's words carry it — capped, it is anybody's text. */
const sheetName = (name: string) => `«${name.length > 60 ? `${clipUnits(name, 59)}…` : name}»`;

/**
 * A FURTHER mapped sheet of a workbook, by its SHAPE (docs/FAYL-OQISH.md §4.2,
 * his 2a ⭐: «boshqa varaqdagi tovarlar BOSHQA ekani aniq ko‘rinsa, ular
 * qo‘shiladi; packing list varag‘i bo‘lsa, undan og‘irlik va kub olinadi;
 * aniqlab bo‘lmasa, hozirgidek qoladi va bot buni aytadi»). Before, every
 * other sheet became text the model was told not to list — another factory's
 * goods on «Zavod B» vanished with no word, and the same goods' packing list
 * gave its totals only if the model read them. Against EVERYTHING held (the
 * sheets before it, and the files before the workbook):
 *  - a PACKING-shaped sheet of the held goods — `packingOfHeld`, as a second
 *    file is judged; or, inside this one workbook, a packing list line for
 *    line with an invoice goods sheet in another script (`samePositions`,
 *    R1) — gives the totals and the netto gaps (by position for R1), as a
 *    second file does; in a top-up its totals go on the note, never the
 *    request (R3 interp 2);
 *  - a sheet PROVEN to hold other goods (`provenOther`; in a top-up the
 *    stored rows fence its names) is folded in as new goods and named; its text goes
 *    nowhere — left under the model's «for totals» heading, its Σ came back
 *    as the shipment's (sheets-07);
 *  - anything else keeps TODAY's reading: its text goes to the model for the
 *    totals (the «НЕ перечисляй» heading stands — the round-2 C2/C6 doubling
 *    is what lifting it brings back), and the seller is told so, once, with
 *    the cure. The role swap of an invoice after a packing goods sheet is NOT
 *    done here (§8): a one-line «AS PER PACKING LIST» invoice would take the
 *    goods role from twelve mapped rows.
 * Never a second file's rules unjudged: `foldInvoice` alone doubled an
 * invoice and its own translation sheet (unmapped-other-sheets R1). Pure.
 */
function receiveFurtherSheet(
  state: IntakeState,
  sheet: Parameters<typeof receiveGoodsSheet>[1],
  further: NonNullable<Parameters<typeof receiveGoodsSheet>[1]['further']>,
  meta: GoodsFileMeta,
  /** The sheet's receipt words (its dropped rows, its cap) — said on EVERY branch (SHEETS-1). */
  cutLines: string[],
  /** …and its dropped rows as the AI door's context (`receiveGoodsSheet`'s `texts`). */
  texts: SheetText[],
  tools: {
    answer: (patch: Partial<IntakeState>, lines: string[]) => FileAnswer;
    totalsOf: (
      m: GoodsFileMeta,
      rows: NonNullable<IntakeState['invoiceGoods']>,
      rowsFrom: string,
      filled: number,
    ) => { patch: Partial<IntakeState>; lines: string[] };
    ownText: (m: GoodsFileMeta) => SheetText[];
  },
): FileAnswer {
  const { goods, label } = sheet;
  const held = state.invoiceGoods ?? [];
  const files = state.goodsFiles ?? [];
  const kinds = rowKindsOf(files, held.length);
  const sheetLabel = `${label}, ${sheetName(further.sheet)} varag‘i`;
  const m: GoodsFileMeta = { ...meta, label: sheetLabel };
  const topUp = state.amend !== null || state.seed !== null;
  if (m.shape === 'packing') {
    const ofHeld = packingOfHeld(held, kinds, goods, m.weightKind);
    // Its totals are the shipment's only while it answers for the WHOLE held
    // list (as-built review SHEETS-3): with another factory's goods already
    // folded in (two goods files held), factory A's packing list still passes
    // `packingOfHeld`, and its Σ was written — and announced — as the
    // shipment's brutto and cube with factory B's cargo out of both. One goods
    // file held keeps the loose rule a second file has always had. A top-up
    // writes no totals anyway (its note carries the list's own).
    const covers = ofHeld && (topUp || files.length <= 1 || packingCoversHeld(held, kinds, goods, m.weightKind));
    if (ofHeld && !covers) {
      const fill = packingFills(held, kinds, goods, m.weightKind);
      // Totals a packing list gave BEFORE the fold that made this list a part
      // (review of the fixes RF-TOTALS-1, «[CI A, PL A] then [CI B, PL B]»):
      // factory B's invoice folds on the main path, which drops nothing, so
      // PL B was the first to meet PL A's standing Σ — and, taking none
      // itself, left factory A's brutto and cube as the shipment's under a ✅.
      // By this branch's own proof they are a part's. Dropped and said, as
      // the fold below drops them.
      const stale = totalsBeforeFold(state) ? state.fileTotals : null;
      // Its text goes nowhere: under the model's totals heading its Σ came
      // back as the shipment's (seam 1's shape); its dropped rows still reach
      // the model on the AI door (SHEETS-1).
      return tools.answer(
        {
          invoiceGoods: fill.goods,
          ...(texts.length > 0 ? { invoiceTexts: [...state.invoiceTexts, ...texts] } : {}),
          ...(stale ? { fileTotals: null } : {}),
        },
        [partOfHeldNote(m.label, fill.filled), ...cutLines, ...(stale && tookFigures(stale) ? [staleTotalsNote(stale.label)] : [])],
      );
    }
    // R1 only while the held list IS the goods sheet's rows, place for place:
    // with other goods held (a file before the workbook, a sheet folded in
    // before this one) the packing list's Σ is not the list's, and the same
    // goods held in another order would take each other's netto.
    const inLine =
      !ofHeld &&
      further.goodsShape === 'invoice' &&
      held.length === further.goodsRows.length &&
      held.every((h, i) => goodsNameKey(h.name) === goodsNameKey(further.goodsRows[i]!.name)) &&
      samePositions(further.goodsRows, goods);
    if (covers || inLine) {
      const fill = covers ? packingFills(held, kinds, goods, m.weightKind) : positionalFills(held, goods, m.weightKind);
      const totals = tools.totalsOf(m, goods, `${sheetName(further.goodsSheet)} varag‘idan`, fill.filled);
      // The text keeps the FILE's label: a later file that squeezes it names
      // «{file} ning boshqa varaqlari» (`squeezedLine`), and the sheet's own
      // name is the text's first line for the model.
      return tools.answer(
        // Its own text (the model's) holds its every row; the receipt says
        // what was not taken as a row of the held goods (SHEETS-1).
        { invoiceGoods: fill.goods, invoiceTexts: [...state.invoiceTexts, ...tools.ownText({ ...m, label })], ...totals.patch },
        [...totals.lines, ...cutLines],
      );
    }
  }
  // The stored rows of a top-up fence the names only (`provenOther`'s `stored`).
  const kept = topUp ? (state.amend?.items ?? state.seed ?? []) : [];
  // Past the queue's limit the JUDGEMENT is not made either (as-built review
  // REGRESSION-2): `provenOther` asks every row against every held row, and
  // the held list grows with each fold — ten sheets of 500 cost 4 s and twenty
  // two minutes of synchronous CPU on the one process the bot's poller awaits.
  // A fold can only keep or add rows, so a list that would pass the limit
  // whatever the answer is not asked; the sheet keeps today's reading.
  const pastCap = further.itemCap !== undefined && held.length + goods.length > further.itemCap;
  const fold =
    !pastCap && provenOther(held, goods, kept)
      ? foldInvoice(held, kinds, goods, m.weightKind, `${label}, ${sheetName(further.sheet)} varag‘idan`, ' ')
      : null;
  // Another factory's goods past the queue's limit are not folded (as-built
  // review REGRESSION-1): one file was bounded at 500 rows and the queue
  // refuses a job over a thousand, and three sheets of 400 folded into a table
  // that invited «✅ Tasdiqlash» — whose press then ENDED the collection, every
  // file lost. The sheet keeps today's reading, and the seller is told.
  const overCap = pastCap || (fold !== null && further.itemCap !== undefined && fold.goods.length > further.itemCap);
  if (fold && !overCap) {
    // Totals a packing list gave BEFORE this fold were the list's then, never
    // with these new goods in it (as-built review SHEETS-3, the order «CI A,
    // PL A, CI B»): kept, factory A's brutto and cube stood as the shipment's.
    // Dropped and said — the brutto is asked, as beside any fold (§4.3). A
    // packing list that happened to list B's goods too is lost with it; the
    // seller answers one figure, and nothing is priced on half a truck.
    const stale = !topUp && state.fileTotals ? state.fileTotals : null;
    return tools.answer(
      {
        invoiceGoods: fold.goods,
        goodsFiles: [...files, { ...m, rows: fold.added, text: null }],
        // A folded sheet's text goes nowhere (§4.2), so its dropped rows go to
        // the model here, on the AI door (SHEETS-1).
        ...(texts.length > 0 ? { invoiceTexts: [...state.invoiceTexts, ...texts] } : {}),
        ...(stale ? { fileTotals: null } : {}),
      },
      [
        ...(fold.notes.length > 0 ? [fold.notes[0]!, ...cutLines, ...fold.notes.slice(1)] : cutLines),
        ...(stale && tookFigures(stale) ? [staleTotalsNote(stale.label)] : []),
      ],
    );
  }
  // Today's reading, said (§4.2): the sheet's text for the totals — and when
  // the reader cut it (the further sheets share one budget), that is said too.
  const own = sheet.ownText;
  const cut = own?.cut ? ['⚠️ Jadval katta: AI boshqa varaqlarning faqat boshini o‘qiydi (tovarlar ro‘yxati to‘liq olindi).'] : [];
  if (overCap) {
    // NOTHING of it goes to the model (review of the fixes RF-TOTALS-3): its
    // goods are not in the list and it was never judged, so it cannot be the
    // list's totals — under the totals heading, beside the fold that filled
    // the list, a 150-row sheet's TOTAL was the only figure the model was
    // told to take. Nor the «⚠️ Jadval katta … (tovarlar ro‘yxati to‘liq
    // olindi)» line (RF-WORDS-5, RF-REGRESSION-2): one line after «qo‘shilmadi»
    // it claimed the opposite, about a text no model is shown.
    // Unjudged, it may be the same goods again (a translation, a packing
    // list): the cure is conditional.
    return tools.answer({}, [
      `📄 ${sheetLabel} qo‘shilmadi — bitta so‘rovda ${further.itemCap} tadan ortiq tovar bo‘lmaydi; boshqa tovarlar bo‘lsa, bu varaqni alohida so‘rov qilib yuboring.`,
    ]);
  }
  return tools.answer(
    {
      invoiceTexts: [
        ...state.invoiceTexts,
        ...(own?.text ? [{ text: own.text, cut: own.cut, cellsCut: own.cellsCut, label }] : []),
      ],
    },
    // No row of this sheet is taken as a good here, and its whole text goes to
    // the model: there is no «not taken» to name.
    [`📄 ${sheetLabel} — o‘sha tovarlar deb olindi (faqat jami uchun o‘qildi); boshqa tovar bo‘lsa, alohida fayl qilib yuboring.`, ...cut],
  );
}

/**
 * What a forwarded file is worth to the calculation, and the one sentence the
 * seller is told about it — every file is ANSWERED (the diagnosis' cause 3:
 * an .xls, a second PDF, a seventh photo, a photo sent as a file were all
 * dropped in silence).
 *
 *  - a PHOTO, or a picture sent as a FILE, is shown to the model — up to
 *    `MAX_INTAKE_IMAGES` (his 1.4 b: twelve); it is downscaled ONCE here only
 *    to say «o‘qib bo‘lmadi» at once (a HEIC this server cannot decode is
 *    refused in words), and the collection keeps its attachment id (K4);
 *  - a PDF is shown to the model as a document — up to `MAX_INTAKE_PDFS`,
 *    read together;
 *  - a SPREADSHEET is read by `readGoodsFile`: the reader's rows when it finds
 *    the header, the model when it does not (his 1.2 b); a second goods file
 *    is compared with the first by the bot, never asked about (his 1a,
 *    `receiveGoodsSheet`);
 *  - a DOCX is refused in words — it is a zip like an xlsx and would read as
 *    «no goods».
 *
 * Exported for the test: the reader's `textCut` reaching the collection is a
 * wire through THIS function, and a test of the two pure halves beside it
 * cannot see a wire that drops it (round-2 review, C1 — #531's shape).
 */
export async function readIntakeFile(
  saved: { isPhoto: boolean; body: Buffer; attachmentId: string },
  fileName: string,
  mime: string | null,
  state: IntakeState,
): Promise<FileAnswer> {
  const answer = await answerIntakeFile(saved, fileName, mime, state);
  return { ...answer, patch: { ...answer.patch, ...resentAccepted(state, answer.patch, fileName) } };
}

/**
 * A file ACCEPTED under the name of one refused before (as-built review
 * MODEL-5): the bot's own refusal asks for a re-send — «kichikroq qilib
 * yuboring», «parolsiz saqlab yuboring» — and the ✅ table went on saying
 * «CI-2611.pdf o‘qilmadi» beside the goods that very file gave. The entry
 * STAYS and is marked `resent` (review of the fixes RF-FILES-1): a name is no
 * identity — factory A's picture-only «装箱单.xlsx» and factory B's real one,
 * two suppliers' «CI.pdf», share it in the very collections this round is
 * about — and deleted on a name match the refusal that was still true went
 * silent. Marked, it reads «(avvalgi nusxa) … keyin shu nomli fayl olindi»,
 * which is true either way. Never under a name the bot made up («rasm»,
 * «fayl», «N ta rasm»), which is any unnamed photo's. Nothing = no change.
 */
function resentAccepted(state: IntakeState, patch: Partial<IntakeState>, fileName: string): Pick<IntakeState, 'refusedFiles'> | Record<string, never> {
  const name = fileName.trim();
  const list = patch.refusedFiles ?? state.refusedFiles ?? [];
  if (!name || name === 'rasm' || name === 'fayl' || /^\d+ ta rasm$/u.test(name)) return {};
  if (!list.some((f) => f.name === name && !f.resent)) return {};
  const grew = (now: readonly unknown[] | undefined, was: readonly unknown[]) => now !== undefined && now.length > was.length;
  const taken =
    grew(patch.pdfs, state.pdfs) ||
    grew(patch.images, state.images) ||
    grew(patch.sheetTexts, state.sheetTexts) ||
    grew(patch.invoiceTexts, state.invoiceTexts) ||
    patch.invoiceGoods !== undefined;
  // …and taken in THIS answer: a refusal it wrote of the same name stands.
  const fresh = (patch.refusedFiles ?? []).slice((state.refusedFiles ?? []).length).some((f) => f.name === name);
  if (!taken || fresh) return {};
  return { refusedFiles: list.map((f) => (f.name === name && !f.resent ? { ...f, resent: true as const } : f)) };
}

/** `readIntakeFile`'s answer before the re-send rule (`resentAccepted`). */
async function answerIntakeFile(
  saved: { isPhoto: boolean; body: Buffer; attachmentId: string },
  fileName: string,
  mime: string | null,
  state: IntakeState,
): Promise<FileAnswer> {
  const label = fileName ? `«${fileName}»` : 'Fayl';
  const kind = intakeFileKind(saved.body, saved.isPhoto, fileName, mime);
  if (kind === 'image' || kind === 'isomedia') {
    // Counted, never silent: the prompt says how many will not be read — and
    // the table names them after the reading (pdfimg-12, `refusedFiles`).
    if (state.images.length >= MAX_INTAKE_IMAGES) {
      return { patch: { imagesSkipped: state.imagesSkipped + 1, ...photoCapPatch(state, fileName) }, say: null };
    }
    const reduced = await reduceForModel(saved.body).catch(() => null);
    // The reduction this needs anyway is KEPT, beside the original, for the
    // reading to send (docs/SAKKIZ-R3.md §7.2.4): a dozen 3-5 MB photos read
    // back and run through sharp again inside the reading's wall clock was
    // seconds of it. Off the handler — a missing copy is re-reduced there.
    if (reduced) void storeModelCopy(saved.attachmentId, reduced);
    if (!reduced) {
      return {
        patch: {
          imagesSkipped: state.imagesSkipped + 1,
          ...refusedFilePatch(state, fileName || 'rasm', kind === 'isomedia' ? 'HEIC rasm' : 'rasm ochilmadi'),
        },
        say:
          kind === 'isomedia'
            ? `📷 ${label} — HEIC rasm, o‘qib bo‘lmaydi. JPG yoki skrinshot qilib yuboring.`
            : `📷 ${label} — rasmni o‘qib bo‘lmadi (buzilgan yoki juda katta).`,
      };
    }
    // A picture sent as a FILE is said, and the line is a receipt-time note (§1.2.5).
    const asPicture = saved.isPhoto ? null : `🖼 ${label} — rasm sifatida o‘qiladi.`;
    return {
      patch: {
        images: [...state.images, { attachmentId: saved.attachmentId, mediaType: 'image/jpeg' }],
        ...(asPicture ? { fileNotes: [...(state.fileNotes ?? []), asPicture] } : {}),
      },
      say: asPicture,
    };
  }
  if (kind === 'pdf') {
    return receivePdf(
      state,
      { attachmentId: saved.attachmentId, name: fileName || 'invoice.pdf', bytes: saved.body.length },
      label,
      { encrypted: pdfMayBeEncrypted(saved.body) },
    );
  }
  // Refused at arrival, and named on the table after the reading too
  // (`refusedFiles`, docs/FAYL-OQISH.md §1.1).
  const named = fileName || 'fayl';
  if (kind === 'docx') {
    return {
      patch: refusedFilePatch(state, named, 'Word fayl'),
      say: `📄 ${label} — Word fayl o‘qilmaydi. PDF yoki Excel qilib yuboring.`,
    };
  }
  if (kind === 'video') {
    return { patch: refusedFilePatch(state, named, 'video'), say: `🎬 ${label} — video o‘qilmaydi. Rasm yoki matn yuboring.` };
  }
  if (kind === 'archive') {
    return {
      patch: refusedFilePatch(state, named, 'arxiv'),
      say: `🗜 ${label} — arxiv o‘qilmaydi. Ichidagi fayllarni alohida yuboring.`,
    };
  }

  const { droppedRowsLine, readGoodsFile, SHEET_TEXT_BUDGET } = await import('../../wms/deals/goods-file');
  const sheet = await readGoodsFile(saved.body, mime).catch((err: unknown) => {
    logger.warn({ err }, '[calc-intake] spreadsheet unreadable');
    return { kind: 'refused', reason: 'broken' } as const;
  });
  if (!sheet) {
    return {
      patch: refusedFilePatch(state, named, UNKNOWN_TYPE_WHY),
      say: `📎 ${label} kartada saqlandi, lekin o‘qilmaydi: faqat rasm, PDF va Excel/CSV o‘qiladi.`,
    };
  }
  if (sheet.kind === 'refused') {
    // An EMPTY sheet held no goods to lose; every other refusal did.
    const why = SHEET_REFUSAL_WHY[sheet.reason];
    return { patch: why ? refusedFilePatch(state, named, why) : {}, say: SHEET_REFUSAL[sheet.reason](label) };
  }
  // The reader's own two words travel with the text (round-2 review,
  // C1/C4/C5; round-3, R3-C2): `textCut` = rows are missing — the seller and
  // the model are told; `cellsCut` = every row is there, some cells shortened
  // — the model is told, the seller nothing.
  if (sheet.kind === 'text') {
    const { fitSheetRows } = await import('../../wms/calc/intake-ai');
    // …and what the reader saw, for the words (docs/FAYL-OQISH.md §4.4).
    const saw = { ...(sheet.why ? { why: sheet.why } : {}), ...(sheet.pictures > 0 ? { pictures: true as const } : {}) };
    return receiveSheetText(state, label, { text: sheet.text, cut: sheet.textCut, cellsCut: sheet.cellsCut, ...saw }, (texts) =>
      fitSheetRows(texts, SHEET_TEXT_BUDGET),
    );
  }
  // Everything the file states reaches the landing (2026-10-09, P1.6) —
  // through the one mapping the landing's own test reads.
  const { invoiceFacts } = await import('../../wms/calc/intake');
  const { MAX_GOODS_ROWS } = await import('../../wms/deals/goods-import');
  const { MAX_CALC_ITEMS } = await import('../../wms/calc/service');
  // The reader stops at its ceiling and says so (`stoppedShort`, as-built
  // review REGRESSION-6): a list of exactly 500 read whole is no cut — counted
  // by its length, it lost «✅» on the AI door, where a cap blocks (§1.1 g).
  const capOf = (stoppedShort: boolean) => (stoppedShort ? { capped: MAX_GOODS_ROWS } : {});
  // What a sheet IS, by its columns (§1.2.1).
  const shapeOf = (m: Pick<typeof sheet, 'shape' | 'weightKind' | 'grossKg' | 'grossColumn' | 'volumeM3'>) => ({
    shape: m.shape,
    weightKind: m.weightKind,
    grossKg: m.grossKg,
    grossColumn: m.grossColumn,
    volumeM3: m.volumeM3,
  });
  const goods = invoiceFacts(sheet.goods);
  // The arrival line names the goods sheet, and claims for the OTHER sheets
  // only what is done with them (docs/FAYL-OQISH.md §4.4): the unmapped ones
  // are read for the totals; a mapped one says its own line below — and where
  // there is one, «the other sheets» would be false of a sheet folded in as
  // goods two lines down (the P-sheets review's arrival-fold finding), so the
  // clause names the sheets it is true of: those no goods row was taken from.
  const others = sheet.moreSheets.length > 0 ? 'tovar qatori olinmagan varaqlar' : 'boshqa varaqlar';
  const where = sheet.sheets > 1 ? ` («${sheet.sheet}» varag‘idan${sheet.text ? `; ${others} faqat jami uchun o‘qiladi` : ''})` : '';
  const first = {
    goods,
    label,
    text: sheet.text,
    textCut: sheet.textCut,
    cellsCut: sheet.cellsCut,
    where,
    shape: shapeOf(sheet),
    // …and a packing list's own rows, for the model's totals-only sheets.
    ownText: sheet.ownText,
    ...(sheet.text ? { unmapped: true } : {}),
    // …and what it did not take as goods, said and shown (§5.5).
    dropped: {
      line: droppedRowsLine(sheet.dropped),
      rows: sheet.dropped.filter((row) => row.why !== 'total').map((row) => row.text),
    },
    ...capOf(sheet.stoppedShort),
  };
  if (sheet.moreSheets.length === 0) return receiveGoodsSheet(state, first);
  // Every mapped sheet is judged, one after another, each against the state
  // the one before left (docs/FAYL-OQISH.md §4.1, sheets-06): here and not
  // in a door, so the fresh collection, the burst take and both ➕ media
  // doors share one rule. One file: one receipt mark, one patch, one say.
  const more = sheet.moreSheets.map((m) => ({ ...m, facts: invoiceFacts(m.goods) }));
  const held = state.invoiceGoods ?? [];
  if (
    held.length > 0 &&
    sameWorkbookAgain(held, goods, more.map((m) => ({ goods: m.facts, text: m.ownText.text })), sheet.text, state.invoiceTexts)
  ) {
    const again = sameFileNote(label);
    return { patch: { fileNotes: [...(state.fileNotes ?? []), again] }, say: again };
  }
  const steps: Parameters<typeof receiveGoodsSheet>[1][] = [
    { ...first, wholeJudged: true },
    ...more.map((m) => ({
      goods: m.facts,
      label,
      text: '',
      textCut: false,
      cellsCut: false,
      where: '',
      shape: shapeOf(m),
      ownText: m.ownText,
      dropped: {
        line: droppedRowsLine(m.dropped),
        rows: m.dropped.filter((row) => row.why !== 'total').map((row) => row.text),
      },
      ...capOf(m.stoppedShort),
      further: { sheet: m.sheet, goodsSheet: sheet.sheet, goodsRows: goods, goodsShape: sheet.shape, itemCap: MAX_CALC_ITEMS },
    })),
  ];
  let live = state;
  let patch: Partial<IntakeState> = {};
  for (const step of steps) {
    const answer = receiveGoodsSheet(live, step);
    patch = { ...patch, ...answer.patch };
    live = { ...live, ...answer.patch };
  }
  // The lines this file said, each once (two sheets read short say one cut).
  const before = state.fileNotes ?? [];
  const lines = [...new Set((live.fileNotes ?? []).slice(before.length))];
  return { patch: { ...patch, fileNotes: [...before, ...lines] }, say: lines.join('\n') || null };
}

/**
 * The file a Telegram message (or a forwarded album's part) carries — what
 * `saveBotFile` downloads by id, so the download needs only the file and never
 * the update's own ctx (an offer press, K5, saves the message it replies to).
 *
 * `messageId` is the message the file CAME in, carried on the file and not
 * read off the update: on a press the update is a callback (no message of its
 * own), and an album part is not the update's message either — so the
 * collection's attachment id, `uuidv5(noteId:messageId)`, would have been
 * minted at random on exactly the paths that re-run (durability-1).
 */
export type BotFile = {
  fileId: string;
  isPhoto: boolean;
  fileName?: string;
  mime?: string;
  messageId?: number;
  /**
   * What Telegram says the file weighs (`file_size`) — checked BEFORE the
   * download, because a bot is handed nothing past 20 MB (docs/FAYL-OQISH.md
   * §3.4): absent when Telegram did not say.
   */
  size?: number;
};

type BotMessage = {
  message_id?: number;
  photo?: { file_id: string; file_size?: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
};

/**
 * A message's largest photo, else its document; an album part's file. Null for
 * a part with no file or any kind but photo/document (voice, audio, video,
 * contact — his 1.12 a: the collector answers those in words).
 */
export function fileOf(src: BotMessage | ForwardPart): BotFile | null {
  if ('messageId' in src && 'kind' in src) {
    if (!src.file || (src.kind !== 'photo' && src.kind !== 'document')) return null;
    return {
      fileId: src.file.fileId,
      isPhoto: src.kind === 'photo',
      fileName: src.file.name ?? undefined,
      mime: src.file.mime ?? undefined,
      messageId: src.messageId,
      ...(typeof src.file.size === 'number' ? { size: src.file.size } : {}),
    };
  }
  const message = src as BotMessage;
  const messageId = message.message_id;
  const photo = message.photo?.length ? message.photo[message.photo.length - 1] : undefined;
  if (photo) {
    return { fileId: photo.file_id, isPhoto: true, messageId, ...(typeof photo.file_size === 'number' ? { size: photo.file_size } : {}) };
  }
  if (message.document) {
    return {
      fileId: message.document.file_id,
      isPhoto: false,
      fileName: message.document.file_name,
      mime: message.document.mime_type,
      messageId,
      ...(typeof message.document.file_size === 'number' ? { size: message.document.file_size } : {}),
    };
  }
  return null;
}

/** What `saveBotFile` reads from grammy's ctx: the message, for the default file. */
type BotFileCtx = { message?: BotMessage };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The file's path from Telegram, by id. grammy's `ctx.getFile()` went through
 * bot.api's `briefRetry`, which waited out a short 429 twice, and a refusal
 * THREW into the caller's logged catch; the one sender does neither by itself,
 * so both are kept here — the burst after a deploy meets Telegram's rate, and
 * a 400 «file is too big» (a document past 20 MB, an ordinary case) must say
 * why in the log, not only «Faylni saqlab bo‘lmadi» in the chat.
 */
async function filePathOf(fileId: string): Promise<string | BotFileRefusal> {
  let meta = await botCall('getFile', { file_id: fileId }, FILE_DOWNLOAD_MS);
  for (let i = 0; i < 2; i += 1) {
    if (meta.ok || meta.status !== 429 || meta.retryAfter === null || meta.retryAfter > BRIEF_RETRY_MAX_S) break;
    await sleep(meta.retryAfter * 1000);
    meta = await botCall('getFile', { file_id: fileId }, FILE_DOWNLOAD_MS);
  }
  const path = (meta.result as { file_path?: string } | null)?.file_path;
  if (meta.ok && path) return path;
  logger.warn(
    { status: meta.status, description: meta.description, retryAfter: meta.retryAfter },
    '[bot-file] getFile refused',
  );
  // Telegram's own word for a file past the bot's 20 MB — when the message
  // did not say its size, this is where it is learned (note-send.ts reads the
  // same description).
  return { refused: /file is too big/i.test(meta.description ?? '') ? 'too_big' : 'download_failed' };
}

/** A stored bot file: its bytes (for the readers) and its attachment. */
export type SavedBotFile = {
  isPhoto: boolean;
  body: Buffer;
  attachmentId: string;
  /** The name the file is STORED under — what its tile on a card reads (set by `saveBotFile`). */
  fileName?: string;
};

/**
 * Why a file the bot was sent is not stored (docs/FAYL-OQISH.md §3.4) — a
 * typed refusal, never a bare null: `too_big` is past what Telegram hands a
 * bot (20 MB) and is SAID so, never «Faylni saqlab bo‘lmadi», which invites
 * the same file again; `unsupported` is a type storage keeps no attachment of
 * (a drawing, a macro workbook — review model-break-unknown-type-unnamed: it
 * threw, read as a failed download, and was asked for again); `download_failed`
 * is everything else, which a re-send may heal.
 */
export type BotFileRefusal = { refused: 'too_big' | 'too_large' | 'unsupported' | 'download_failed' };

/** Is this a refusal rather than a stored file? */
export const isFileRefusal = (saved: SavedBotFile | BotFileRefusal): saved is BotFileRefusal => 'refused' in saved;

/**
 * A file the bot was sent, stored.
 *
 * One home for the whole crossing (#513): the deadline, the empty-body
 * refusal, the photo-vs-document naming and the inline thumbnail. Two callers
 * — a «Hisoblatish» collection and a zametka being written from the phone —
 * and they differ only in which entity the bytes are pre-bound to (and, for
 * the collection, the id the row is given: `target.id` / `keyName`).
 *
 * Thumbnails are made INLINE — `enqueue()` inside the bot process would start
 * the whole worker fleet, which is the two-backup-systems mistake (#253-261)
 * in a new place. The file is asked of Telegram by its id (`getFile` through
 * the one sender, the idiom tasks/files-job.ts uses), so no ctx.api is needed.
 */
export async function saveBotFile(
  ctx: BotFileCtx,
  target: {
    entityType: string;
    entityId: string;
    uploadedBy: string;
    namePrefix: string;
    id?: string;
    keyName?: string;
    /** A paper, never a carton photo — `saveAttachment`'s own option (0145). */
    asPaper?: boolean;
  },
  file: BotFile | null = fileOf(ctx.message ?? {}),
): Promise<SavedBotFile | BotFileRefusal> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !file) return { refused: 'download_failed' };
  // Past Telegram's bot limit nothing is asked of it at all: it would refuse
  // (docs/FAYL-OQISH.md §3.4). Here, the one home of the crossing, so the
  // collection's doors and the zametka door all meet it.
  if (typeof file.size === 'number' && file.size > MAX_TELEGRAM_DOWNLOAD_BYTES) return { refused: 'too_big' };
  const path = await filePathOf(file.fileId);
  if (typeof path !== 'string') return path;
  // A deadline, because there was none: a Telegram file endpoint that accepts
  // the connection and then stops sending held this handler — and grammy's
  // poller is SEQUENTIAL, so it held every customer's cabinet with it. Thirty
  // seconds is generous for a 20 MB document and finite, which is the point.
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${path}`, {
    signal: AbortSignal.timeout(FILE_DOWNLOAD_MS),
  });
  if (!res.ok) return { refused: 'download_failed' };
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length === 0) return { refused: 'download_failed' };

  const isPhoto = file.isPhoto;
  const storedName = isPhoto ? `${target.namePrefix}_${Date.now()}.jpg` : (file.fileName ?? `fayl_${Date.now()}`);
  const { saveAttachment, FileValidationError } = await import('../files/service');
  const { generateThumbnails } = await import('../jobs/thumbnails');
  let id: string;
  try {
    ({ id } = await saveAttachment(
      {
        entityType: target.entityType,
        entityId: target.entityId,
        fileName: storedName,
        contentType: isPhoto ? 'image/jpeg' : (file.mime ?? 'application/octet-stream'),
        body,
        uploadedBy: target.uploadedBy,
      },
      {
        thumbnails: 'skip',
        ...(target.id !== undefined ? { id: target.id } : {}),
        ...(target.keyName !== undefined ? { keyName: target.keyName } : {}),
        ...(target.asPaper ? { asPaper: true } : {}),
      },
    ));
  } catch (err) {
    // A type storage will not keep — no re-send stores it, so it is a refusal
    // with its own words, never the «saqlab bo‘lmadi» a blip gets.
    if (err instanceof FileValidationError && err.code === 'unsupported_type') return { refused: 'unsupported' };
    // …and a picture past storage's photo ceiling (MODEL-3): no re-send of
    // the same bytes stores it either.
    if (err instanceof FileValidationError && err.code === 'too_large') return { refused: 'too_large' };
    throw err;
  }
  await generateThumbnails(id).catch(() => {});
  return { isPhoto, body, attachmentId: id, fileName: storedName };
}

/**
 * A collection's file, stored against its note. The attachment id is the
 * MESSAGE's (`uuidv5(noteId:messageId)`, durability-1): a message applied again
 * after its state write was lost finds the row it already made, reads those
 * bytes back from storage and downloads nothing — so a re-run never mints a
 * second attachment. The object key is the message's too.
 *
 * `file` defaults to the update's own message; an offer press passes the
 * message its offer replies to, or an album part (K5, P4) — the message id
 * rides on the file (`fileOf`), so every path keys the same way.
 */
export async function saveIntakeFile(
  ctx: BotFileCtx,
  noteId: string,
  uploadedBy: string,
  file: BotFile | null = fileOf(ctx.message ?? {}),
): Promise<SavedBotFile | BotFileRefusal> {
  if (!file) return { refused: 'download_failed' };
  const messageId = file.messageId ?? ctx.message?.message_id ?? null;
  const id = messageId !== null ? uuidv5(`${noteId}:${messageId}`, INTAKE_FILE_NS) : undefined;
  if (id !== undefined) {
    const [row] = await db
      .select({ storageKey: attachments.storageKey })
      .from(attachments)
      .where(eq(attachments.id, id))
      .limit(1);
    if (row) {
      const body = await readWithin(getStorage().get(row.storageKey), PHOTO_READ_MS);
      return { isPhoto: file.isPhoto, body, attachmentId: id };
    }
  }
  return saveBotFile(
    ctx,
    {
      entityType: 'crm_activity',
      entityId: noteId,
      uploadedBy,
      namePrefix: 'hisoblatish',
      ...(id !== undefined ? { id, keyName: `m${messageId}` } : {}),
    },
    file,
  );
}

/**
 * The copy the model looks at: rotated by EXIF, at most 1568 px on the long
 * side (past that the vision API downsamples anyway), JPEG.
 *
 * A packing list photographed by a phone is 3-5 MB; six of those base64'd is
 * a request body of thirty megabytes for numbers that survive a resize
 * perfectly well. `sharp` is lazily imported for the same reason the
 * thumbnail job does it — a native module must never be traced into the
 * standalone bundle.
 */
const MODEL_IMAGE_PX = 1568;
export async function reduceForModel(original: Buffer): Promise<Buffer | null> {
  const sharp = (await import('sharp')).default;
  const out = await sharp(original)
    .rotate()
    .resize(MODEL_IMAGE_PX, MODEL_IMAGE_PX, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  // Anthropic refuses an image past ~5 MB; one that still does not fit is
  // counted as skipped rather than sent to be rejected.
  return out.length > 4_500_000 ? null : out;
}

/**
 * Where a photo's model-sized copy lives: beside its original, keyed off the
 * original's storage key (one home for the writer and the reader). A derived
 * storage object, not an `attachments` row — it needs no authz and no backup
 * change; purging the attachment leaves it behind, like the orphan files of
 * an abandoned collection (docs/SAKKIZ-R3.md §7.2.8).
 */
export function modelCopyKey(storageKey: string): string {
  return `${storageKey}.model.jpg`;
}

/**
 * Store the model-sized copy of a collection's photo. Never throws: a copy
 * that did not make it is re-reduced by the reading, which is all it costs.
 */
export async function storeModelCopy(attachmentId: string, reduced: Buffer): Promise<void> {
  try {
    if (!isUuidShaped(attachmentId)) return;
    const [row] = await db
      .select({ storageKey: attachments.storageKey })
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    if (row) await getStorage().put(modelCopyKey(row.storageKey), reduced, 'image/jpeg');
  } catch (err) {
    logger.warn({ err, attachmentId }, '[calc-intake] model-sized copy not stored — the reading reduces it');
  }
}

/** The bytes a reading sends the model, loaded from storage (K5). */
export interface IntakeFiles {
  images: { data: Buffer; mediaType: 'image/jpeg' }[];
  /** Each PDF with its attachment, so a PDF the API refuses is named by it (docs/FAYL-OQISH.md §3.4). */
  pdfs: { data: Buffer; name: string; attachmentId?: string }[];
  missing: number;
}

/**
 * The bytes the model reads, from storage. Every get goes through `readWithin`
 * (no read may outlive `deadline`); a photo prefers its model-sized copy,
 * written at arrival (`storeModelCopy`), and only without one is its ORIGINAL
 * read and reduced again (the stored attachment is the 3-5 MB photo, and the
 * model refuses past ~5 MB). An object storage no longer has, or does not
 * hand over in time, is counted, never thrown — and the count is SAID: the
 * reading puts it in its notes (`filesMissingNote`), or a storage blip would
 * have the model read text only under a prompt that promised it the photos.
 *
 * The deadline is the WHOLE load's: each read gets what is left of it (at
 * most PHOTO_READ_MS), and a file whose turn comes after it is counted, not
 * read — fifteen slow reads in a row must not hold the model call for
 * minutes (#915: a dead stream is a hang). A collection with no image and no
 * PDF reads nothing.
 */
export async function loadIntakeFiles(state: IntakeState, opts: { deadline: number }): Promise<IntakeFiles> {
  const out: IntakeFiles = { images: [], pdfs: [], missing: 0 };
  // Only an id that can BE a row is asked about: anything else is missing,
  // never a statement postgres refuses for the whole reading.
  const ids = [...state.images.map((i) => i.attachmentId), ...state.pdfs.map((p) => p.attachmentId)].filter(
    isUuidShaped,
  );
  if (state.images.length === 0 && state.pdfs.length === 0) return out;
  const rows =
    ids.length === 0
      ? []
      : await db
          .select({ id: attachments.id, storageKey: attachments.storageKey })
          .from(attachments)
          .where(inArray(attachments.id, ids));
  const keyOf = new Map(rows.map((r) => [r.id, r.storageKey]));
  const read = async (key: string, attachmentId: string, quiet: boolean): Promise<Buffer | null> => {
    const left = Math.min(PHOTO_READ_MS, opts.deadline - Date.now());
    if (left <= 0) return null;
    try {
      return await readWithin(getStorage().get(key), left);
    } catch (err) {
      if (!quiet) logger.warn({ err, attachmentId }, '[calc-intake] stored file unreadable — counted, not read');
      return null;
    }
  };
  const bytesOf = async (attachmentId: string): Promise<Buffer | null> => {
    const key = keyOf.get(attachmentId);
    return key ? read(key, attachmentId, false) : null;
  };
  for (const image of state.images) {
    const key = keyOf.get(image.attachmentId);
    // The copy is already the model's size: no sharp, no 5 MB read. Its
    // absence is ordinary (an arrival that could not store it) and quiet.
    const copy = key ? await read(modelCopyKey(key), image.attachmentId, true) : null;
    const original = copy ? null : await bytesOf(image.attachmentId);
    const reduced = copy ?? (original ? await reduceForModel(original).catch(() => null) : null);
    if (reduced) out.images.push({ data: reduced, mediaType: image.mediaType });
    else out.missing += 1;
  }
  // A PDF the API refused is not sent again (docs/FAYL-OQISH.md §3.4,
  // pdfimg-9 S9a): it sank every re-read after it, the photos' goods with it.
  // Neither read nor missing — the table names it by `unreadPdfs`.
  const refused = new Set(state.unreadPdfs ?? []);
  for (const pdf of state.pdfs) {
    if (refused.has(pdf.attachmentId)) continue;
    const data = await bytesOf(pdf.attachmentId);
    if (data) out.pdfs.push({ data, name: pdf.name, attachmentId: pdf.attachmentId });
    else out.missing += 1;
  }
  return out;
}
