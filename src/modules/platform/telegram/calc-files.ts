import { eq, inArray } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { db } from '../db/client';
import { attachments } from '../db/schema';
import { isUuidShaped } from '../audit/fields';
import { PHOTO_READ_MS, readWithin } from '../files/read-within';
import { getStorage } from '../files/storage';
import { logger } from '../logger';
import {
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
  notedTotalsNote,
  packingFills,
  packingNote,
  packingOfHeld,
  packingTotals,
  rowKindsOf,
  sameFileAgain,
  sameFileNote,
  totalsClashNote,
  withFileTotals,
  type GoodsFileMeta,
} from './file-goods';
import type { ForwardPart } from './task-draft';
import { BRIEF_RETRY_MAX_S } from './retry';
import { botCall } from './send';

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
};

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
export function sheetTextLine(label: string, fit: { kept: number; total: number }, readerCut: boolean): string {
  const cut =
    fit.kept === 0
      ? '\n⚠️ Bu jadval AI ga sig‘madi (oldingi jadvallar bilan birga juda katta) — VED faylni kartadan o‘qiydi.'
      : readerCut
        ? `\n⚠️ Jadval katta: AI faqat boshini o‘qiydi (birinchi ${fit.kept} qator) — qolganini VED fayldan ko‘radi.`
        : fit.kept < fit.total
          ? `\n⚠️ Jadval katta: AI faqat birinchi ${fit.kept} / ${fit.total} qatorini o‘qiydi — qolganini VED fayldan ko‘radi.`
          : '';
  return `📄 ${label} — jadval sarlavhasini topa olmadim, AI o‘qiydi.${cut}`;
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
): FileAnswer {
  if (pdf.bytes > MAX_PDF_BYTES) {
    return { patch: {}, say: `📄 ${label} — PDF juda katta (10 MB dan ortiq), AI o‘qimaydi. Kartada saqlandi.` };
  }
  const bytes = state.pdfs.reduce((n, p) => n + p.bytes, 0);
  if (state.pdfs.length >= MAX_INTAKE_PDFS || bytes + pdf.bytes > MAX_INTAKE_PDF_BYTES) {
    return {
      patch: {},
      say: `📄 ${label} — bitta so‘rovga ${MAX_INTAKE_PDFS} tadan ortiq PDF o‘qilmaydi. Kartada saqlandi.`,
    };
  }
  return {
    patch: { pdfs: [...state.pdfs, pdf], ...beside(state) },
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
export function promptFileLines(state: Pick<IntakeState, 'pdfs' | 'sheetTexts' | 'invoiceTexts'>, fit: SheetFit): string[] {
  const all = [...state.sheetTexts, ...state.invoiceTexts];
  const fitted = all.length > 0 ? fit(all.map((s) => s.text.trim())) : { kept: [], total: [] };
  const pdfs = state.pdfs.map((p) => `📄 «${p.name}» — AI o‘qiydi.`);
  const sheets = state.sheetTexts.map((s, i) =>
    sheetTextLine(s.label ?? 'Jadval', { kept: fitted.kept[i] ?? 0, total: fitted.total[i] ?? 0 }, s.cut),
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
    say: sheetTextLine(label, { kept, total }, sheet.cut) + squeezed.join(''),
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
  },
): FileAnswer {
  const { goods, label, where } = sheet;
  const texts: SheetText[] = sheet.text
    ? [{ text: sheet.text, cut: sheet.textCut, cellsCut: sheet.cellsCut, label }]
    : [];
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

  if (held.length === 0) {
    if (topUp && packing) {
      // A top-up's packing list is a NOTED file (§1.2.3): its totals go on the
      // note for the VED and its rows change no row — kept as goods, every one
      // a stored row does not `sameLine` landed as a 🆕 line, the request's
      // own goods priced twice (review PF-SPEC-2, law-money-5). Its text rides
      // with the model's totals-only sheets; it is no goods list, so an
      // invoice after it is the goods list and takes nothing from it.
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
  if (sameFileAgain(held, goods, sheet.text, state.invoiceTexts)) {
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
  const first = files.length === 1 ? files[0]! : null;
  if (
    !packing &&
    !topUp &&
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
    [readLine, ...cutLines, ...fold.notes],
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
  const label = fileName ? `«${fileName}»` : 'Fayl';
  const kind = intakeFileKind(saved.body, saved.isPhoto, fileName, mime);
  if (kind === 'image' || kind === 'isomedia') {
    // Counted, never silent: the prompt says how many will not be read.
    if (state.images.length >= MAX_INTAKE_IMAGES) return { patch: { imagesSkipped: state.imagesSkipped + 1 }, say: null };
    const reduced = await reduceForModel(saved.body).catch(() => null);
    // The reduction this needs anyway is KEPT, beside the original, for the
    // reading to send (docs/SAKKIZ-R3.md §7.2.4): a dozen 3-5 MB photos read
    // back and run through sharp again inside the reading's wall clock was
    // seconds of it. Off the handler — a missing copy is re-reduced there.
    if (reduced) void storeModelCopy(saved.attachmentId, reduced);
    if (!reduced) {
      return {
        patch: { imagesSkipped: state.imagesSkipped + 1 },
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
    );
  }
  if (kind === 'docx') return { patch: {}, say: `📄 ${label} — Word fayl o‘qilmaydi. PDF yoki Excel qilib yuboring.` };
  if (kind === 'video') return { patch: {}, say: `🎬 ${label} — video o‘qilmaydi. Rasm yoki matn yuboring.` };
  if (kind === 'archive') {
    return { patch: {}, say: `🗜 ${label} — arxiv o‘qilmaydi. Ichidagi fayllarni alohida yuboring.` };
  }

  const { readGoodsFile, SHEET_TEXT_BUDGET } = await import('../../wms/deals/goods-file');
  const sheet = await readGoodsFile(saved.body, mime).catch((err: unknown) => {
    logger.warn({ err }, '[calc-intake] spreadsheet unreadable');
    return { kind: 'refused', reason: 'broken' } as const;
  });
  if (!sheet) {
    return { patch: {}, say: `📎 ${label} kartada saqlandi, lekin o‘qilmaydi: faqat rasm, PDF va Excel/CSV o‘qiladi.` };
  }
  if (sheet.kind === 'refused') return { patch: {}, say: SHEET_REFUSAL[sheet.reason](label) };
  // The reader's own two words travel with the text (round-2 review,
  // C1/C4/C5; round-3, R3-C2): `textCut` = rows are missing — the seller and
  // the model are told; `cellsCut` = every row is there, some cells shortened
  // — the model is told, the seller nothing.
  if (sheet.kind === 'text') {
    const { fitSheetRows } = await import('../../wms/calc/intake-ai');
    return receiveSheetText(state, label, { text: sheet.text, cut: sheet.textCut, cellsCut: sheet.cellsCut }, (texts) =>
      fitSheetRows(texts, SHEET_TEXT_BUDGET),
    );
  }
  // Everything the file states reaches the landing (2026-10-09, P1.6) —
  // through the one mapping the landing's own test reads.
  const { invoiceFacts } = await import('../../wms/calc/intake');
  const { MAX_GOODS_ROWS } = await import('../../wms/deals/goods-import');
  const where = sheet.sheets > 1 ? ` («${sheet.sheet}» varag‘idan; boshqa varaqlarni AI o‘qiydi)` : '';
  return receiveGoodsSheet(state, {
    goods: invoiceFacts(sheet.goods),
    label,
    text: sheet.text,
    textCut: sheet.textCut,
    cellsCut: sheet.cellsCut,
    where,
    // What the sheet IS, by its columns (§1.2.1) — and a packing list's own
    // rows, for the model's totals-only sheets.
    shape: {
      shape: sheet.shape,
      weightKind: sheet.weightKind,
      grossKg: sheet.grossKg,
      grossColumn: sheet.grossColumn,
      volumeM3: sheet.volumeM3,
    },
    ownText: sheet.ownText,
    // The reader stops at its ceiling and says nothing; reaching it is the
    // one sign the file may hold more (round-4 integration S-b).
    ...(sheet.goods.length >= MAX_GOODS_ROWS ? { capped: MAX_GOODS_ROWS } : {}),
  });
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
export type BotFile = { fileId: string; isPhoto: boolean; fileName?: string; mime?: string; messageId?: number };

type BotMessage = {
  message_id?: number;
  photo?: { file_id: string }[];
  document?: { file_id: string; file_name?: string; mime_type?: string };
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
    };
  }
  const message = src as BotMessage;
  const messageId = message.message_id;
  const photo = message.photo?.length ? message.photo[message.photo.length - 1] : undefined;
  if (photo) return { fileId: photo.file_id, isPhoto: true, messageId };
  if (message.document) {
    return {
      fileId: message.document.file_id,
      isPhoto: false,
      fileName: message.document.file_name,
      mime: message.document.mime_type,
      messageId,
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
async function filePathOf(fileId: string): Promise<string | null> {
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
  return null;
}

/** A stored bot file: its bytes (for the readers) and its attachment. */
export type SavedBotFile = { isPhoto: boolean; body: Buffer; attachmentId: string };

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
  },
  file: BotFile | null = fileOf(ctx.message ?? {}),
): Promise<SavedBotFile | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !file) return null;
  const path = await filePathOf(file.fileId);
  if (!path) return null;
  // A deadline, because there was none: a Telegram file endpoint that accepts
  // the connection and then stops sending held this handler — and grammy's
  // poller is SEQUENTIAL, so it held every customer's cabinet with it. Thirty
  // seconds is generous for a 20 MB document and finite, which is the point.
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${path}`, {
    signal: AbortSignal.timeout(FILE_DOWNLOAD_MS),
  });
  if (!res.ok) return null;
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length === 0) return null;

  const isPhoto = file.isPhoto;
  const { saveAttachment } = await import('../files/service');
  const { generateThumbnails } = await import('../jobs/thumbnails');
  const { id } = await saveAttachment(
    {
      entityType: target.entityType,
      entityId: target.entityId,
      fileName: isPhoto ? `${target.namePrefix}_${Date.now()}.jpg` : (file.fileName ?? `fayl_${Date.now()}`),
      contentType: isPhoto ? 'image/jpeg' : (file.mime ?? 'application/octet-stream'),
      body,
      uploadedBy: target.uploadedBy,
    },
    {
      thumbnails: 'skip',
      ...(target.id !== undefined ? { id: target.id } : {}),
      ...(target.keyName !== undefined ? { keyName: target.keyName } : {}),
    },
  );
  await generateThumbnails(id).catch(() => {});
  return { isPhoto, body, attachmentId: id };
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
): Promise<SavedBotFile | null> {
  if (!file) return null;
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
  pdfs: { data: Buffer; name: string }[];
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
  for (const pdf of state.pdfs) {
    const data = await bytesOf(pdf.attachmentId);
    if (data) out.pdfs.push({ data, name: pdf.name });
    else out.missing += 1;
  }
  return out;
}
