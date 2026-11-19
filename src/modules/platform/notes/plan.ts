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
 * The order is a rule, not an accident: the caption — the note's NAME and the
 * text saying what it is — rides the FIRST file, because his own case is one
 * address sheet plus its words and a person FORWARDS what the bot sends: one
 * message forwards as one message. Then the rest of the files, in the order
 * the note puts them in.
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
}

export type NoteSend =
  | { kind: 'text'; text: string }
  | { kind: 'media'; as: 'photo' | 'document'; files: NoteFile[]; caption: string | null };

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
  return stepsFor(noteCaption(note), files);
}

/**
 * The words and the files, as sends — the ONE caption rule both plans follow
 * (a 📌 tap and the new-client card), so the card can never grow a second
 * idea of «when does the text ride the photo».
 */
function stepsFor(caption: string, files: NoteFile[]): NoteSend[] {
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

  return sends;
}

/**
 * The new-client card's forwardable part (the owner, 2026-11-19: «code
 * berganda shu adreslar va botga ssilka qoshilib berilsin … sotuvchilar shuni
 * ozini pereslat qilishsin»): EVERY ticked company note merged into ONE note
 * and planned by the 📌 rule above.
 *
 * Merged, not one plan per note: a seller forwards by multi-selecting
 * messages on a phone, and three notes planned apart are three captions, a
 * footer and a staff line to pick out by hand — miss one and the customer has
 * two addresses of three, silently. Merged, the commonest card (his three
 * addresses and one picture) is ONE photo with every word under it.
 *
 *   - the text: each note's caption — TITLE kept, exactly what 📌 sends for
 *     that note — in the notes' own order, a blank line between, then the
 *     footer the caller built (the marking line, his reminder, the bot line);
 *   - the files: every part, in note order and then part order;
 *   - text ≤ 1024 with any file → the caption rides the first file; otherwise
 *     the text goes first (split, never cut) and the files after it, bare —
 *     always contiguous, so nothing else lands between them in the chat.
 *
 * `notes` arrive read through the visibility rule and in their order, `files`
 * in note order then part order. `messages` is counted from the SAME steps
 * that are sent, so the staff line's «N ta xabar» cannot disagree with what
 * arrives.
 */
export function newClientPlan(
  notes: NoteHead[],
  files: NoteFile[],
  footer: string,
): { steps: NoteSend[]; messages: number } {
  const text = [...notes.map(noteCaption), footer.trim()].filter((part) => part !== '').join('\n\n');
  const steps = stepsFor(text, files);
  return { steps, messages: planMessageCount(steps) };
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
