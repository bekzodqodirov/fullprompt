import { armWait, dropWait, nowSec, readWait, waitVerdict, type WaitEntry } from './waits';

/**
 * «📎 Fayl qo‘shish» under a prixod's message — the collection's STATE and its
 * words (the owner, 2026-11-11: «agar file qoshishni bossa fillarni tashlasin
 * boldi va hisobga tashlagandek boldi deb bosganda prixodga fillar
 * biriktirilsin»; docs/PRIXOD-XABARI.md §C.5).
 *
 * A LEAF — it imports the waits and nothing else — because the three doors
 * that open another collector («Hisoblatish», a task draft, a zametka) end
 * this one, and they must be able to import it without a cycle.
 *
 * The files are attached AS THEY ARRIVE (receipt-files-door.ts), so there is
 * nothing here to lose: a restart, a quiet half-hour or a forgotten «Bo‘ldi»
 * leaves every file already on its prixod. What this state holds is only
 * which prixod the chat is feeding, and what to say about it.
 *
 * One durable wait per chat (`waits.ts`: memory is the reader, the table
 * survives a deploy), thirty minutes, re-armed by every file.
 */

export const RECEIPT_FILES_TTL_MS = 30 * 60_000;
/** One collection's ceiling — a forwarded archive of a hundred photos is a mistake, not a prixod's papers. */
export const MAX_RECEIPT_FILES = 30;

export const RECEIPT_FILES_BUTTON = '📎 Fayl qo‘shish';
export const RECEIPT_FILES_DONE_BUTTON = '✅ Bo‘ldi';

export interface ReceiptFilesWait {
  receiptId: string;
  number: string;
  clientCode: string | null;
  /** Files this collection has put on the prixod. */
  count: number;
  /** The collection's ONE message as it stands — the prompt first, then each acknowledgement that replaced it. */
  messageId: number | null;
  /** The newest incoming message the collection took — what «still the last message» is measured against. */
  lastSeen: number | null;
}

/** Open (or re-open) the chat's collection. Armed at the PROMPT's own date — a wait exists only once its prompt is on the screen. */
export function openReceiptFiles(
  chatId: bigint,
  receipt: { id: string; number: string; clientCode: string | null },
  prompt: { messageId: number; date: number },
  count = 0,
): void {
  const payload: ReceiptFilesWait = {
    receiptId: receipt.id,
    number: receipt.number,
    clientCode: receipt.clientCode,
    count,
    messageId: prompt.messageId,
    lastSeen: null,
  };
  armWait(chatId, 'receipt_files', payload, RECEIPT_FILES_TTL_MS, prompt.date);
}

/** What stands for this chat, expired or not — the caller's verdict decides. */
export function readReceiptFiles(chatId: bigint): WaitEntry<ReceiptFilesWait> | null {
  return readWait<ReceiptFilesWait>(chatId, 'receipt_files');
}

/**
 * The collection a message dated `atSec` belongs to — null once thirty quiet
 * minutes have passed (and the spent wait is dropped: a day-old collection
 * must never read as live).
 */
export function liveReceiptFiles(chatId: bigint, atSec: number = nowSec()): ReceiptFilesWait | null {
  const entry = readReceiptFiles(chatId);
  if (!entry) return null;
  if (waitVerdict(entry, atSec, false) !== 'answers') {
    dropWait(chatId, 'receipt_files');
    return null;
  }
  return entry.payload;
}

/**
 * A file was taken: the count and the newest message move, and the thirty
 * minutes start again from THIS file. Always a new object — memory keeps the
 * reference and the queued write serialises it later (`armWait`'s trap).
 */
export function noteReceiptFile(chatId: bigint, at: { messageId: number; date: number }, stored: boolean): ReceiptFilesWait | null {
  const entry = readReceiptFiles(chatId);
  if (!entry) return null;
  const next: ReceiptFilesWait = {
    ...entry.payload,
    count: entry.payload.count + (stored ? 1 : 0),
    lastSeen: Math.max(entry.payload.lastSeen ?? 0, at.messageId),
  };
  armWait(chatId, 'receipt_files', next, RECEIPT_FILES_TTL_MS, at.date, () => true);
  return next;
}

/** The collection's one message moved (a new acknowledgement was drawn) — neither clock moves. */
export function noteReceiptFilesMessage(chatId: bigint, receiptId: string, messageId: number): void {
  const entry = readReceiptFiles(chatId);
  if (!entry || entry.payload.receiptId !== receiptId) return;
  // A merge with a one-second life cannot move the expiry (the burst's idiom).
  armWait(chatId, 'receipt_files', { ...entry.payload, messageId }, 1_000, entry.armedAt, () => true);
}

/** End it. Returns what stood, so the caller can say the count. A no-op when nothing stands. */
export function endReceiptFiles(chatId: bigint): ReceiptFilesWait | null {
  const entry = readReceiptFiles(chatId);
  if (!entry) return null;
  dropWait(chatId, 'receipt_files');
  return entry.payload;
}

// ---- the words ------------------------------------------------------------

const named = (w: { number: string; clientCode: string | null }) => `${w.number}${w.clientCode ? ` (${w.clientCode})` : ''}`;

export const receiptFilesKeyboard = (): { inline_keyboard: { text: string; callback_data: string }[][] } => ({
  inline_keyboard: [[{ text: RECEIPT_FILES_DONE_BUTTON, callback_data: 'pf:ok' }]],
});

export function receiptFilesPrompt(w: { number: string; clientCode: string | null; count: number }, closed?: ReceiptFilesWait | null): string {
  const before = closed ? `Oldingi yig‘ish yopildi: ${receiptFilesDone(closed)}\n\n` : '';
  const sofar = w.count > 0 ? `\nHozircha ${w.count} ta fayl biriktirilgan.` : '';
  return (
    `${before}📎 Prixod ${named(w)}.\n` +
    'Fayllarni shu yerga yuboring yoki forward qiling — rasm, PDF, Excel. Har biri kelishi bilan prixodga biriktiriladi.' +
    `${sofar}\nTugagach «${RECEIPT_FILES_DONE_BUTTON}» ni bosing.`
  );
}

export function receiptFilesAck(w: { number: string; count: number }): string {
  return `📎 ${w.number}: ${w.count} ta fayl biriktirildi.\nYana yuboring yoki «${RECEIPT_FILES_DONE_BUTTON}» ni bosing.`;
}

export function receiptFilesDone(w: { number: string; count: number }): string {
  return w.count > 0 ? `✅ ${w.count} ta fayl prixod ${w.number} ga biriktirildi.` : `Prixod ${w.number} ga fayl qo‘shilmadi.`;
}

export const RECEIPT_FILES_SAY = {
  notLinked: 'Ulanmagan',
  /** «✅ Bo‘ldi» with nothing open: the files went on as they came, so nothing is lost. */
  over: 'Yig‘ish tugagan — yuborilgan fayllar prixodga biriktirilgan.',
  full: `Bir yig‘ishda eng ko‘pi ${MAX_RECEIPT_FILES} ta fayl. «${RECEIPT_FILES_DONE_BUTTON}» ni bosing; yana kerak bo‘lsa — «${RECEIPT_FILES_BUTTON}» ni qayta bosing.`,
  busyIntake: `Avval «Hisoblatish»ni tugating yoki bekor qiling — keyin «${RECEIPT_FILES_BUTTON}» ni qayta bosing.`,
  busyDraft: `Avval topshiriq qoralamasini tugating yoki bekor qiling — keyin «${RECEIPT_FILES_BUTTON}» ni qayta bosing.`,
  busyCapture: `Avval zametkani saqlang yoki bekor qiling — keyin «${RECEIPT_FILES_BUTTON}» ni qayta bosing.`,
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
