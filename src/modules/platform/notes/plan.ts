import {
  MAX_CAPTION_CHARS,
  MEDIA_GROUP_MAX,
  captionTooLong,
  splitMessage,
} from '../telegram/limits';

/**
 * What one tap on a zametka actually sends, decided in one PURE place.
 *
 * Nothing in this repository can test a grammy handler — there is no fake
 * context and no bot harness — so the only shape in which «one tap sends every
 * part, in the right order, and nothing silently missing» can be PROVEN is a
 * function that turns a stored note into an ordered list of sends, with the
 * shell reduced to a `for` loop over it.
 *
 * The order is a rule, not an accident: the caption (title, text, address and
 * a map link that survives a forward) rides the FIRST file, because his own
 * case is one address sheet plus its text and a person FORWARDS what the bot
 * sends — one message forwards as one message. Then the rest of the files in
 * the order the note puts them in, then the pin LAST, because a pin is what
 * closes the set and Telegram draws it as its own card.
 */

export interface NoteFile {
  partId: string;
  attachmentId: string;
  fileName: string;
  storageKey: string;
  sizeBytes: number;
  sendAs: 'photo' | 'document';
  telegramFileId: string | null;
  telegramSentAs: 'photo' | 'document' | null;
}

export interface NoteHead {
  id: string;
  title: string;
  body: string | null;
  lat: string | number | null;
  lon: string | number | null;
  placeTitle: string | null;
  placeAddress: string | null;
}

export type NoteSend =
  | { kind: 'text'; text: string }
  | { kind: 'media'; as: 'photo' | 'document'; files: NoteFile[]; caption: string | null }
  | { kind: 'location'; lat: number; lon: number }
  | { kind: 'venue'; lat: number; lon: number; title: string; address: string };

/** A stored numeric arrives from drizzle as a string; empty must stay empty. */
function num(value: string | number | null): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The words that go with the note. The TITLE is first and always present —
 * without it the customer receives an address sheet with no heading, and the
 * seller scrolling a chat that also carries task assignments cannot tell which
 * note they just sent.
 */
export function noteCaption(note: NoteHead): string {
  const lines = [note.title.trim()];
  const body = note.body?.trim();
  if (body) lines.push('', body);
  const address = note.placeAddress?.trim();
  if (address) lines.push('', `📍 ${address}`);
  const lat = num(note.lat);
  const lon = num(note.lon);
  // A map LINK as well as the pin: a location card is fine in Telegram, and a
  // link is what still works when the address is pasted anywhere else.
  if (lat !== null && lon !== null) lines.push(`https://yandex.uz/maps/?pt=${lon},${lat}&z=17`);
  return lines.join('\n').trim();
}

/** Consecutive files of the same shape travel together; the note's order wins. */
function runs(files: NoteFile[]): { as: 'photo' | 'document'; files: NoteFile[] }[] {
  const out: { as: 'photo' | 'document'; files: NoteFile[] }[] = [];
  for (const file of files) {
    const last = out[out.length - 1];
    if (last && last.as === file.sendAs && last.files.length < MEDIA_GROUP_MAX) {
      last.files.push(file);
    } else {
      out.push({ as: file.sendAs, files: [file] });
    }
  }
  return out;
}

/**
 * The sends, in order. `files` must already be sorted the way the note orders
 * them — the caller reads them through the parts table, which is what carries
 * that order (`attachments` is shared by nine entity types and has none).
 */
export function notePlan(note: NoteHead, files: NoteFile[]): NoteSend[] {
  const caption = noteCaption(note);
  const sends: NoteSend[] = [];
  const groups = runs(files);

  // The caption rides the first file when it fits; otherwise it is its own
  // message (split, never truncated) and every file goes bare.
  const captionRides = groups.length > 0 && !captionTooLong(caption);
  if (!captionRides && caption !== '') {
    for (const chunk of splitMessage(caption)) sends.push({ kind: 'text', text: chunk });
  }

  groups.forEach((group, index) => {
    sends.push({
      kind: 'media',
      as: group.as,
      files: group.files,
      caption: captionRides && index === 0 ? caption : null,
    });
  });

  const lat = num(note.lat);
  const lon = num(note.lon);
  if (lat !== null && lon !== null) {
    // sendVenue takes a title AND an address, both required; the column pair
    // is CHECKed for exactly this, so one being present means both are.
    const title = note.placeTitle?.trim();
    const address = note.placeAddress?.trim();
    if (title && address) sends.push({ kind: 'venue', lat, lon, title, address });
    else sends.push({ kind: 'location', lat, lon });
  }

  return sends;
}

/** How many Telegram messages a plan becomes — a media group is its members. */
export function planMessageCount(plan: NoteSend[]): number {
  return plan.reduce((sum, send) => sum + (send.kind === 'media' ? send.files.length : 1), 0);
}

/** The cached id is only usable when the method that minted it is the one we are about to call. */
export function cachedFileId(file: NoteFile): string | null {
  return file.telegramFileId && file.telegramSentAs === file.sendAs ? file.telegramFileId : null;
}

export { MAX_CAPTION_CHARS };
