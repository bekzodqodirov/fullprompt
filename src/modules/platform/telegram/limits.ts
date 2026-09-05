/**
 * What the Telegram BOT API will accept.
 *
 * These numbers exist a second time in `wms/crm/telegram-send.ts`, and that is
 * deliberate rather than #513 being broken: that file is the gramjs path — a
 * manager's PERSONAL account over MTProto — and this one is the bot. The
 * limits happen to agree today; the units do not. Telegram counts a caption in
 * UTF-16 code units, which is what `String.length` gives, while the CRM helper
 * counts CODE POINTS and is therefore permissive by up to half on a text full
 * of emoji. The bot's own ceiling is measured the way the API measures it.
 */

/** A caption on a photo or a document. */
export const MAX_CAPTION_CHARS = 1024;
/** A plain message. */
export const MAX_MESSAGE_CHARS = 4096;
/** sendMediaGroup takes 2..10 items and refuses either side of that. */
export const MEDIA_GROUP_MIN = 2;
export const MEDIA_GROUP_MAX = 10;
/**
 * `sendPhoto` accepts at most 10 MB. Our own storage accepts 15 (files
 * service, MAX_PHOTO_BYTES), so a legitimately stored photograph can be too
 * big to SEND as one — the gap is a real 5 MB window and the screen says so
 * rather than letting a customer discover it.
 */
export const MAX_TELEGRAM_PHOTO_BYTES = 10 * 1024 * 1024;
/** A bot may upload at most 50 MB, and may DOWNLOAD at most 20. */
export const MAX_TELEGRAM_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_TELEGRAM_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** Telegram's own unit, not ours: UTF-16 code units. */
export function captionTooLong(text: string): boolean {
  return text.length > MAX_CAPTION_CHARS;
}

/**
 * A body longer than one message is SPLIT, never refused. A note whose text
 * cannot be sent at all is the silence rounds 89 and 97 were spent removing.
 * Split on a newline when there is one within reach, so a paragraph is not cut
 * mid-word.
 */
export function splitMessage(text: string, limit = MAX_MESSAGE_CHARS): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const brk = window.lastIndexOf('\n');
    const cut = brk > limit * 0.5 ? brk : limit;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/**
 * An inline button's text must be non-empty and short enough to read on a
 * phone. The column it comes from is bounded by the service; this is the
 * second fence, because a button Telegram refuses kills the WHOLE message —
 * keyboard, list and all — for everybody the note is offered to.
 */
export const MAX_BUTTON_CHARS = 40;

export function buttonLabel(text: string, fallback: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean === '') return fallback;
  return clean.length > MAX_BUTTON_CHARS ? `${clean.slice(0, MAX_BUTTON_CHARS - 1)}…` : clean;
}
