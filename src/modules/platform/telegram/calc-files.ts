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
import type { ForwardPart } from './task-draft';
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

/** The two answers to «a second invoice arrived» (his 1.13 c). */
export function invoiceChoiceKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Qatorlari qo‘shilsin', callback_data: 'c:inv_add' }],
      [{ text: '🔁 Oldingisining o‘rniga', callback_data: 'c:inv_replace' }],
    ],
  };
}

/** The two answers to «a PDF or a sheet the AI reads, beside an Excel list» (round-1 review, c4). */
export function otherFilesKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Ha, boshqa zavod — tovarlari qo‘shilsin', callback_data: 'c:other_add' }],
      [{ text: '📄 Yo‘q, o‘sha tovarlar — faqat jami o‘qilsin', callback_data: 'c:other_same' }],
    ],
  };
}

/** What a file is worth to the collection, and what the seller is told — pure. */
export interface FileAnswer {
  patch: Partial<IntakeState>;
  say: string | null;
  keyboard?: { inline_keyboard: { text: string; callback_data: string }[][] };
}

/**
 * «Boshqa zavodning tovarlarimi?» — asked when a file the MODEL reads (a PDF,
 * a header-less sheet) meets an Excel list the reader mapped, in either order
 * (round-1 review, c4). The Excel list answers for the goods, so the model's
 * lines were thrown away whatever the file was — after the bot had said «AI
 * o'qiydi». A second factory's invoice is the commonest reason to send two
 * documents (his 1.13), and the same invoice twice is the second commonest:
 * only the seller knows which, and merging blind would double the order.
 * Asked again for each new such file, because one answer about the first PDF
 * says nothing about the next — and the LAST answer then stands for all of
 * them: the model reads the files together and its list names no file per
 * line, so «A's own PDF beside B's» has no right answer (round-2 review, C2;
 * stated, not built — see `IntakeState.aiGoods`). The question says so.
 */
function otherFilesQuestion(invoiceLines: number): string {
  return (
    `\nExcel ro‘yxatida ${invoiceLines} ta tovar bor. AI o‘qiydigan fayl — boshqa zavodning tovarlarimi?` +
    '\n(Javob AI o‘qiydigan hamma fayllarga tegishli; javobgacha tahlil boshlanmaydi.)'
  );
}

/**
 * How spreadsheet texts fit what the model reads, in ROWS — `fitSheetRows` at
 * the reader's cap (round-3 review, R3-C2: counted in lines, a sheet's
 * «[name]» heading was a row, and a 20-row file read «birinchi 21 qator»).
 */
export type SheetFit = (texts: readonly string[]) => { kept: number[]; total: number[] };

/**
 * A PDF: shown to the model, within the count and byte caps — and asked about
 * when an Excel list already answers for the goods. By attachment id (K4); the
 * caps count `bytes`.
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
  const invoice = (state.invoiceGoods ?? []).length;
  return {
    patch: { pdfs: [...state.pdfs, pdf], ...(invoice > 0 ? { aiGoods: 'ask' as const } : {}) },
    say: `📄 ${label} — AI o‘qiydi.` + (invoice > 0 ? otherFilesQuestion(invoice) : ''),
    ...(invoice > 0 ? { keyboard: otherFilesKeyboard() } : {}),
  };
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
  const cut =
    kept === 0
      ? '\n⚠️ Bu jadval AI ga sig‘madi (oldingi jadvallar bilan birga juda katta) — VED faylni kartadan o‘qiydi.'
      : sheet.cut
        ? `\n⚠️ Jadval katta: AI faqat boshini o‘qiydi (birinchi ${kept} qator) — qolganini VED fayldan ko‘radi.`
        : kept < total
          ? `\n⚠️ Jadval katta: AI faqat birinchi ${kept} / ${total} qatorini o‘qiydi — qolganini VED fayldan ko‘radi.`
          : '';
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
    const whose = t.label ? `${t.label} ning` : 'oldingi Excel faylning';
    return [
      now === 0
        ? `\n⚠️ Shu jadval tufayli ${whose} boshqa varaqlari AI ga sig‘madi — u yerdagi jami (kub/kg) o‘qilmaydi.`
        : `\n⚠️ Shu jadval tufayli AI ${whose} boshqa varaqlaridan endi faqat ${now} / ${of} qatorini o‘qiydi.`,
    ];
  });
  const invoice = (state.invoiceGoods ?? []).length;
  return {
    patch: { sheetTexts, ...(invoice > 0 ? { aiGoods: 'ask' as const } : {}) },
    say:
      `📄 ${label} — jadval sarlavhasini topa olmadim, AI o‘qiydi.` +
      cut +
      squeezed.join('') +
      (invoice > 0 ? otherFilesQuestion(invoice) : ''),
    ...(invoice > 0 ? { keyboard: otherFilesKeyboard() } : {}),
  };
}

/**
 * A spreadsheet the reader MAPPED: its lines are exact (P1.6).
 *
 *  - the first one IS the goods list, and its other sheets ride with it as
 *    `invoiceTexts`; when the model already holds a separate PDF or sheet,
 *    the «boshqa zavod?» question is asked here — the same pair in the
 *    other order (round-1 review, c4);
 *  - a further one is ASKED about (his 1.13 c), and while that question is
 *    open every further file FOLDS into it — a third used to overwrite the
 *    second, whose lines then reached nobody (round-1 review, c1). Its other
 *    sheets wait with it, so a replace can drop them (c7).
 *
 * The goods rows are exact whatever the size; the OTHER sheets' text is what
 * the reader cuts (`textCut`), and that is said too — those sheets are where
 * the shipment's totals are read from (round-2 review, C1). Only when ROWS are
 * missing: shortened cells (`cellsCut`) travel to the model and say nothing
 * here (round-3 review, R3-C2).
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
  },
): FileAnswer {
  const { goods, label, where } = sheet;
  const texts: SheetText[] = sheet.text
    ? [{ text: sheet.text, cut: sheet.textCut, cellsCut: sheet.cellsCut, label }]
    : [];
  const cut =
    (sheet.capped
      ? `\n⚠️ Bitta fayldan ko‘pi bilan ${sheet.capped} ta tovar qatori o‘qiladi — fayl uzunroq bo‘lsa, qolganini VED fayldan ko‘radi.`
      : '') +
    (sheet.text && sheet.textCut
      ? '\n⚠️ Jadval katta: AI boshqa varaqlarning faqat boshini o‘qiydi' +
        // «the goods list was read in full» is false of a capped one.
        (sheet.capped ? '.' : ' (tovarlar ro‘yxati to‘liq olindi).')
      : '');
  const invoice = state.invoiceGoods ?? [];
  if (invoice.length > 0) {
    const waiting = state.pendingInvoice;
    const pending = waiting
      ? {
          goods: [...(waiting.goods ?? []), ...goods],
          label: `${waiting.label}, ${label}`,
          texts: [...waiting.texts, ...texts],
        }
      : { goods, label, texts };
    return {
      patch: { pendingInvoice: pending },
      say:
        `📄 ${label} — ${goods.length} ta tovar${where}.${cut}\n` +
        (waiting ? `Javob kutayotgan fayllar: ${pending.label} — jami ${pending.goods.length} ta tovar.\n` : '') +
        `Oldingi faylda ${invoice.length} ta tovar bor. Nima qilamiz?`,
      keyboard: invoiceChoiceKeyboard(),
    };
  }
  const ask = state.aiGoods === null && (state.pdfs.length > 0 || state.sheetTexts.length > 0);
  return {
    patch: { invoiceGoods: goods, invoiceTexts: texts, ...(ask ? { aiGoods: 'ask' as const } : {}) },
    say: `📄 ${label} — ${goods.length} ta tovar o‘qildi${where}.` + cut + (ask ? otherFilesQuestion(goods.length) : ''),
    ...(ask ? { keyboard: otherFilesKeyboard() } : {}),
  };
}

/**
 * The answer to «a second invoice arrived» (his 1.13 c), as a patch — pure.
 *
 * A collection still waiting for the customer (or the podklyuch door's
 * «qayerdan?») KEEPS waiting: the answer used to move it to 'material', so the
 * open question was never asked again, a code typed next was filed as
 * material, and the job landed as a nameless lead with no road (round-1
 * review, c0). `reask` names the question to ask again. Null = nothing waits:
 * the button is stale.
 */
export function invoiceChoice(
  state: IntakeState,
  step: 'inv_add' | 'inv_replace',
): { patch: Partial<IntakeState>; said: string; reask: 'client' | 'section' | null } | null {
  const pending = state.pendingInvoice;
  if (!pending) return null;
  const add = step === 'inv_add';
  const goods = add ? [...(state.invoiceGoods ?? []), ...(pending.goods ?? [])] : (pending.goods ?? []);
  const reask = state.stage === 'client' || state.stage === 'section' ? state.stage : null;
  return {
    patch: {
      invoiceGoods: goods,
      // The replaced workbook's other sheets leave with its goods (c7).
      invoiceTexts: add ? [...state.invoiceTexts, ...pending.texts] : pending.texts,
      pendingInvoice: null,
      stage: reask ?? 'material',
    },
    said: add
      ? `➕ ${pending.label} qo‘shildi: endi fayllarda ${goods.length} ta tovar.`
      : `🔁 ${pending.label} oldingisining o‘rniga olindi: ${goods.length} ta tovar.`,
    reask,
  };
}

/** The answer to «boshqa zavodning tovarlarimi?» (round-1 review, c4) — pure, like `invoiceChoice`. */
export function otherFilesChoice(
  state: IntakeState,
  step: 'other_add' | 'other_same',
): { patch: Partial<IntakeState>; said: string; reask: 'client' | 'section' | null } | null {
  if (state.aiGoods !== 'ask') return null;
  const reask = state.stage === 'client' || state.stage === 'section' ? state.stage : null;
  return {
    patch: { aiGoods: step === 'other_add' ? 'add' : 'context', stage: reask ?? 'material' },
    said:
      step === 'other_add'
        ? '➕ Boshqa zavod: AI o‘qigan tovarlar Excel ro‘yxatiga qo‘shiladi.'
        : '📄 O‘sha tovarlar: ro‘yxat Excel fayldan olinadi, qolgan fayllardan faqat jami (kub/kg) o‘qiladi.',
    reask,
  };
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
 *    is ASKED about (his 1.13 c);
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
    if (!reduced) {
      return {
        patch: { imagesSkipped: state.imagesSkipped + 1 },
        say:
          kind === 'isomedia'
            ? `📷 ${label} — HEIC rasm, o‘qib bo‘lmaydi. JPG yoki skrinshot qilib yuboring.`
            : `📷 ${label} — rasmni o‘qib bo‘lmadi (buzilgan yoki juda katta).`,
      };
    }
    return {
      patch: { images: [...state.images, { attachmentId: saved.attachmentId, mediaType: 'image/jpeg' }] },
      say: saved.isPhoto ? null : `🖼 ${label} — rasm sifatida o‘qiladi.`,
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
    // The reader stops at its ceiling and says nothing; reaching it is the
    // one sign the file may hold more (round-4 integration S-b).
    ...(sheet.goods.length >= MAX_GOODS_ROWS ? { capped: MAX_GOODS_ROWS } : {}),
  });
}

/**
 * The file a Telegram message (or a forwarded album's part) carries — what
 * `saveBotFile` downloads by id, so the download needs only the file and never
 * the update's own ctx (an offer press, K5, saves the message it replies to).
 */
export type BotFile = { fileId: string; isPhoto: boolean; fileName?: string; mime?: string };

type BotMessage = {
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
    };
  }
  const message = src as BotMessage;
  const photo = message.photo?.length ? message.photo[message.photo.length - 1] : undefined;
  if (photo) return { fileId: photo.file_id, isPhoto: true };
  if (message.document) {
    return {
      fileId: message.document.file_id,
      isPhoto: false,
      fileName: message.document.file_name,
      mime: message.document.mime_type,
    };
  }
  return null;
}

/** What `saveBotFile` reads from grammy's ctx: the message, for the default file. */
type BotFileCtx = { message?: BotMessage & { message_id?: number } };

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
  const meta = await botCall('getFile', { file_id: file.fileId }, FILE_DOWNLOAD_MS);
  const path = (meta.result as { file_path?: string } | null)?.file_path;
  if (!meta.ok || !path) return null;
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
 * message its offer replies to (K5, P4), with that message's id.
 */
export async function saveIntakeFile(
  ctx: BotFileCtx,
  noteId: string,
  uploadedBy: string,
  file: BotFile | null = fileOf(ctx.message ?? {}),
  messageId: number | null = ctx.message?.message_id ?? null,
): Promise<SavedBotFile | null> {
  if (!file) return null;
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

/** The bytes a reading sends the model, loaded from storage (K5). */
export interface IntakeFiles {
  images: { data: Buffer; mediaType: 'image/jpeg' }[];
  pdfs: { data: Buffer; name: string }[];
  missing: number;
}

/**
 * The bytes the model reads, from storage. Every get goes through `readWithin`
 * (no read may outlive `deadline`); a photo prefers its model-sized copy (P2).
 * An object storage no longer has, or does not hand over in time, is counted,
 * never thrown.
 *
 * K: no deadline enforcement beyond `readWithin(PHOTO_READ_MS)` and no derived
 * copy — so every image read runs `reduceForModel` again (the stored
 * attachment is the ORIGINAL 3-5 MB photo, and the model refuses past ~5 MB)
 * and a null is `missing`. A collection with no image and no PDF reads nothing.
 */
export async function loadIntakeFiles(state: IntakeState, _opts: { deadline: number }): Promise<IntakeFiles> {
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
  const bytesOf = async (attachmentId: string): Promise<Buffer | null> => {
    const key = keyOf.get(attachmentId);
    if (!key) return null;
    try {
      return await readWithin(getStorage().get(key), PHOTO_READ_MS);
    } catch (err) {
      logger.warn({ err, attachmentId }, '[calc-intake] stored file unreadable — counted, not read');
      return null;
    }
  };
  for (const image of state.images) {
    const original = await bytesOf(image.attachmentId);
    const reduced = original ? await reduceForModel(original).catch(() => null) : null;
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
