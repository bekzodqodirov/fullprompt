import { armWait, dropWait, nowSec, readWait, waitVerdict, type WaitEntry } from './waits';

/**
 * «📎 Fayl qo‘shish» under a prixod's message — the collection's STATE and its
 * words (the owner, 2026-11-11: «agar file qoshishni bossa fillarni tashlasin
 * boldi va hisobga tashlagandek boldi deb bosganda prixodga fillar
 * biriktirilsin»; docs/PRIXOD-XABARI.md §C.5).
 *
 * A LEAF — it imports the waits and nothing else — because the three doors
 * that open another collector («Hisoblatish», a task draft, a zametka) close
 * this one, and they must be able to import it without a cycle.
 *
 * The files are attached AS THEY ARRIVE (receipt-files-door.ts), so there is
 * nothing here to lose: a restart, a quiet half-hour or a forgotten «Bo‘ldi»
 * leaves every file already on its prixod. What this state holds is which
 * prixod the chat is feeding, which files THIS collection put there (so
 * «↩️ Bekor qilish» can take exactly those back), and what to say.
 *
 * A collection never ends in silence. Thirty quiet minutes, or another
 * collector opening, CLOSE it — and the closed entry stays until the next
 * file meets it and is told, once, that it was not attached.
 *
 * One durable wait per chat (`waits.ts`: memory is the reader, the table
 * survives a deploy), re-armed by every file.
 */

export const RECEIPT_FILES_TTL_MS = 30 * 60_000;
/** One collection's ceiling — a forwarded archive of a hundred photos is a mistake, not a prixod's papers. */
export const MAX_RECEIPT_FILES = 30;

export const RECEIPT_FILES_BUTTON = '📎 Fayl qo‘shish';
export const RECEIPT_FILES_DONE_BUTTON = '✅ Bo‘ldi';
export const RECEIPT_FILES_CANCEL_BUTTON = '↩️ Bekor qilish';

export interface ReceiptFilesWait {
  receiptId: string;
  number: string;
  clientCode: string | null;
  /**
   * What this collection stored: the Telegram message and the attachment it
   * became. The count is this set's size — a redelivered file JOINS it and is
   * never counted twice — and the cancel removes exactly these.
   */
  files: { m: number; a: string }[];
  /** The collection's ONE message as it stands — the prompt first, then each acknowledgement that replaced it. */
  messageId: number | null;
  /** The newest incoming message the collection took — what «still the last message» is measured against. */
  lastSeen: number | null;
  /** Another collector opened: nothing more is taken, and the next file is told so. */
  closed?: 'other';
  /** When it was closed that way (unix seconds) — a quiet one closed at its own expiry. */
  closedAt?: number;
}

/** The state a message dated `atSec` meets. */
export type ReceiptFilesStanding =
  | { state: 'live'; wait: ReceiptFilesWait }
  | { state: 'closed'; wait: ReceiptFilesWait; why: 'quiet' | 'other' };

const KIND = 'receipt_files' as const;

/**
 * How long a CLOSED collection still answers (the «⌛» sentence under the
 * next file, a late «↩️ Bekor qilish»). «Told once» was the design; it did
 * not say «however much later» — and memory keeps an entry for as long as
 * the process lives: a forgotten «Bo‘ldi» on Monday met Tuesday's unrelated
 * photo with «bu fayl biriktirilmadi» and a button inviting it onto that
 * prixod, and Monday's «↩️ Bekor qilish» still deleted the papers the VED
 * had worked from. Past this, the entry goes in silence.
 */
export const RECEIPT_FILES_TOLD_S = 2 * 3600;

/**
 * Open the chat's collection. Armed at the PROMPT's own date — a wait exists
 * only once its prompt is on the screen. `keep` = the same prixod's
 * collection was already open: its files stay, and so does its first time.
 */
export function openReceiptFiles(
  chatId: bigint,
  receipt: { id: string; number: string; clientCode: string | null },
  prompt: { messageId: number; date: number },
  keep: ReceiptFilesWait | null = null,
): void {
  const payload: ReceiptFilesWait = {
    receiptId: receipt.id,
    number: receipt.number,
    clientCode: receipt.clientCode,
    files: keep ? [...keep.files] : [],
    messageId: prompt.messageId,
    lastSeen: keep?.lastSeen ?? null,
  };
  armWait(chatId, KIND, payload, RECEIPT_FILES_TTL_MS, prompt.date, keep ? () => true : undefined);
}

/**
 * What stands for this chat as a message dated `atSec` meets it. A backlog
 * file is judged by expiry alone, never «early»: updates are handled in
 * order, so a file handled after the press WAS sent after the press — and a
 * press made into an outage arms its wait only when the bot comes back.
 */
export function standingReceiptFiles(chatId: bigint, atSec: number = nowSec()): ReceiptFilesStanding | null {
  const entry = readWait<ReceiptFilesWait>(chatId, KIND);
  if (!entry) return null;
  const why = entry.payload.closed ?? (waitVerdict(entry, atSec, false) !== 'answers' ? ('quiet' as const) : null);
  if (why === null) return { state: 'live', wait: entry.payload };
  const closedAt = why === 'other' ? (entry.payload.closedAt ?? entry.expiresAt) : entry.expiresAt;
  if (atSec - closedAt > RECEIPT_FILES_TOLD_S) {
    dropWait(chatId, KIND);
    return null;
  }
  return { state: 'closed', wait: entry.payload, why };
}

/** A new object over the standing payload, the clocks untouched (a merge with a one-second life cannot move the expiry). */
function rewrite(chatId: bigint, entry: WaitEntry<ReceiptFilesWait>, next: ReceiptFilesWait): void {
  armWait(chatId, KIND, next, 1_000, entry.armedAt, () => true);
}

/**
 * A file was taken. `stored` = the attachment it is on the prixod (null for a
 * file refused in words): it joins the set, and the thirty minutes start
 * again from THIS file's own date — never the processing clock, so a file
 * handled late after an outage does not slide the window past what the
 * person saw. Always a new object: memory keeps the reference and the queued
 * write serialises it later (`armWait`'s trap).
 */
export function noteReceiptFile(
  chatId: bigint,
  at: { messageId: number; date: number },
  stored: string | null,
): ReceiptFilesWait | null {
  const entry = readWait<ReceiptFilesWait>(chatId, KIND);
  if (!entry) return null;
  const known = entry.payload.files.some((f) => f.m === at.messageId);
  const next: ReceiptFilesWait = {
    ...entry.payload,
    files: stored && !known ? [...entry.payload.files, { m: at.messageId, a: stored }] : [...entry.payload.files],
    lastSeen: Math.max(entry.payload.lastSeen ?? 0, at.messageId),
  };
  armWait(chatId, KIND, next, RECEIPT_FILES_TTL_MS, at.date, () => true);
  return next;
}

/** The collection's one message moved (a new acknowledgement was drawn) — neither clock moves. */
export function noteReceiptFilesMessage(chatId: bigint, receiptId: string, messageId: number): void {
  const entry = readWait<ReceiptFilesWait>(chatId, KIND);
  if (!entry || entry.payload.receiptId !== receiptId) return;
  rewrite(chatId, entry, { ...entry.payload, messageId });
}

/**
 * Another collector opened in this chat («Hisoblatish», a task draft, a
 * zametka): this collection takes nothing more. NOT dropped — the next file
 * that would have been its own is told, once, that it was not attached
 * (`standingReceiptFiles` → 'closed'); the files it already took are on the
 * prixod. A no-op when nothing stands.
 */
export function closeReceiptFiles(chatId: bigint): void {
  const entry = readWait<ReceiptFilesWait>(chatId, KIND);
  if (!entry || entry.payload.closed) return;
  rewrite(chatId, entry, { ...entry.payload, closed: 'other', closedAt: nowSec() });
}

/** End it for good («✅ Bo‘ldi», the cancel, the closed sentence said). Returns what stood. */
export function endReceiptFiles(chatId: bigint): ReceiptFilesWait | null {
  const entry = readWait<ReceiptFilesWait>(chatId, KIND);
  if (!entry) return null;
  dropWait(chatId, KIND);
  return entry.payload;
}

// ---- the words ------------------------------------------------------------

const named = (w: { number: string; clientCode: string | null }) => `${w.number}${w.clientCode ? ` (${w.clientCode})` : ''}`;

type Keyboard = { inline_keyboard: { text: string; callback_data: string }[][] };

/**
 * The collection's keyboard. Both buttons carry their prixod: a press under
 * an EARLIER prixod's message must never close the one that is open now.
 * «↩️ Bekor qilish» only once there is something to take back.
 */
export function receiptFilesKeyboard(w: { receiptId: string; files: readonly unknown[] }): Keyboard {
  const id = w.receiptId.toLowerCase();
  return {
    inline_keyboard: [
      [{ text: RECEIPT_FILES_DONE_BUTTON, callback_data: `pf:ok:${id}` }],
      ...(w.files.length > 0 ? [[{ text: RECEIPT_FILES_CANCEL_BUTTON, callback_data: `pf:no:${id}` }]] : []),
    ],
  };
}

/** The one button under a «closed» sentence: open that prixod's collection again. */
export function receiptFilesReopenKeyboard(w: { receiptId: string; number: string }): Keyboard {
  return { inline_keyboard: [[{ text: `📎 ${w.number} ga qo‘shish`.slice(0, 40), callback_data: `pf:${w.receiptId.toLowerCase()}` }]] };
}

export function receiptFilesPrompt(
  w: { number: string; clientCode: string | null; files: readonly unknown[] },
  closed?: { number: string; files: readonly unknown[] } | null,
): string {
  const before = closed ? `Oldingi yig‘ish yopildi: ${receiptFilesDone(closed)}\n\n` : '';
  const sofar = w.files.length > 0 ? `\nHozircha ${w.files.length} ta fayl biriktirilgan.` : '';
  return (
    `${before}📎 Prixod ${named(w)}.\n` +
    'Fayllarni shu yerga yuboring yoki forward qiling — rasm, PDF, Excel, Word. Har biri kelishi bilan prixodga biriktiriladi.' +
    `${sofar}\nTugagach «${RECEIPT_FILES_DONE_BUTTON}» ni bosing.`
  );
}

export function receiptFilesAck(w: { number: string; files: readonly unknown[] }): string {
  return (
    `📎 ${w.number}: ${w.files.length} ta fayl biriktirildi.\n` +
    `Yana yuboring yoki «${RECEIPT_FILES_DONE_BUTTON}» ni bosing. Xato fayl ketgan bo‘lsa — «${RECEIPT_FILES_CANCEL_BUTTON}».`
  );
}

export function receiptFilesDone(w: { number: string; files: readonly unknown[] }): string {
  return w.files.length > 0
    ? `✅ ${w.files.length} ta fayl prixod ${w.number} ga biriktirildi.`
    : `Prixod ${w.number} ga bu safar fayl qo‘shilmadi.`;
}

/** Said ONCE, under the first file that meets a closed collection — and that file is NOT attached. */
export function receiptFilesClosed(w: { number: string; files: readonly unknown[] }, why: 'quiet' | 'other'): string {
  const reason =
    why === 'quiet'
      ? `${RECEIPT_FILES_TTL_MS / 60_000} daqiqa fayl kelmagani uchun`
      : 'boshqa ish boshlangani uchun';
  const had = w.files.length > 0 ? ` (unda ${w.files.length} ta fayl biriktirilgan)` : '';
  return `⌛ Prixod ${w.number} uchun fayl yig‘ish ${reason} yopilgan${had} — bu fayl biriktirilmadi.\nYana qo‘shish uchun tugmani bosib, faylni qaytadan yuboring.`;
}

/**
 * A file that swipe-REPLIES to another of the bot's messages while a
 * collection is open, and that no other door took: it belongs to that
 * message, not to this prixod — never stored here, and said so.
 */
export function receiptFilesReplied(w: { number: string }): string {
  return (
    `↩️ Bu fayl boshqa xabarga javob qilib yuborilgan — prixod ${w.number} ga biriktirilmadi.\n` +
    `Shu prixodga qo‘shish uchun javob (reply) qilmasdan yuboring; boshqa prixodga — o‘sha xabar ostidagi «${RECEIPT_FILES_BUTTON}» ni bosing.`
  );
}

/** After «↩️ Bekor qilish»: what was taken back, and what could not be. */
export function receiptFilesCancelled(w: { number: string }, removed: number, kept: number): string {
  const head = removed > 0 ? `↩️ Prixod ${w.number}: ${removed} ta fayl olib tashlandi.` : `↩️ Prixod ${w.number}: fayl yig‘ish bekor qilindi.`;
  return kept > 0
    ? `${head}\n${kept} ta fayl qoldi — u tarkibda ishlatilgan yoki o‘chirib bo‘lmadi; prixod kartasidan ko‘ring.`
    : head;
}

export const RECEIPT_FILES_SAY = {
  notLinked: 'Ulanmagan',
  /** A press under a collection that is not the open one: nothing is closed, and nothing was lost. */
  over: 'Bu yig‘ish allaqachon yopilgan — yuborilgan fayllar prixodga biriktirilgan.',
  overCancel:
    'Bu yig‘ish allaqachon yopilgan. O‘zingiz qo‘shgan faylni prixod kartasidagi «Fayllar» bo‘limidan olib tashlashingiz mumkin.',
  full: `Bir yig‘ishda eng ko‘pi ${MAX_RECEIPT_FILES} ta fayl. «${RECEIPT_FILES_DONE_BUTTON}» ni bosing; yana kerak bo‘lsa — «${RECEIPT_FILES_BUTTON}» ni qayta bosing.`,
  busyIntake: `Avval «Hisoblatish»ni tugating yoki bekor qiling — keyin «${RECEIPT_FILES_BUTTON}» ni qayta bosing.`,
  busyDraft: `Avval topshiriq qoralamasini tugating yoki bekor qiling — keyin «${RECEIPT_FILES_BUTTON}» ni qayta bosing.`,
  busyCapture: `Avval zametkani saqlang yoki bekor qiling — keyin «${RECEIPT_FILES_BUTTON}» ni qayta bosing.`,
  /** A video, a voice note, a sticker: the collection's two kinds are a photo and a file. */
  notAFile: `Video, ovozli xabar va stiker prixodga biriktirilmaydi — rasm yoki fayl (📎) qilib yuboring. Tugagach «${RECEIPT_FILES_DONE_BUTTON}».`,
  /** A typed text: the collection keeps files only. */
  notText: `✍️ Matn prixodga yozilmaydi — izohni prixod kartasidagi yozishmaga yozing. Fayl yuboring yoki «${RECEIPT_FILES_DONE_BUTTON}» ni bosing.`,
  openCard: '↗️ Prixodni ochish',
} as const;

/** Why the prixod takes no file from this person — the door's three answers (wms/receipts/files-door.ts). */
export const RECEIPT_FILES_REFUSED: Record<'not_found' | 'voided' | 'forbidden', string> = {
  not_found: 'Bu prixod topilmadi.',
  voided: 'Bu prixod bekor qilingan — fayl qo‘shib bo‘lmaydi.',
  forbidden: 'Bu prixodni ochishga huquqingiz yo‘q.',
};

/** Why ONE file was not stored — said under that file, never «try again» about a file that will fail the same way. */
export const RECEIPT_FILE_NOT_STORED: Record<'too_big' | 'too_large' | 'unsupported' | 'download_failed', string> = {
  too_big: 'Fayl 20 MB dan katta — Telegram uni botga bermaydi. Kichikroq qilib yuboring.',
  too_large: 'Rasm 15 MB dan katta — saqlanmadi. Kichraytirib (yoki rasm qilib) yuboring.',
  unsupported: 'Faylning bu turi saqlanmaydi — rasm, PDF, Excel yoki Word yuboring.',
  download_failed: 'Faylni saqlab bo‘lmadi — qaytadan yuboring.',
};
