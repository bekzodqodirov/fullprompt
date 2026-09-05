import { describe, expect, it } from 'vitest';
import {
  cachedFileId,
  noteCaption,
  notePlan,
  planMessageCount,
  type NoteFile,
  type NoteHead,
} from '@/modules/platform/notes/plan';
import { MAX_CAPTION_CHARS } from '@/modules/platform/telegram/limits';

/**
 * What one tap sends.
 *
 * Nothing in this repository can exercise a grammy handler, so this is where
 * «one tap sends every part, in the right order, and nothing silently
 * missing» is actually proven. The shell is a `for` loop over what this
 * returns.
 */

const head = (over: Partial<NoteHead> = {}): NoteHead => ({
  id: 'n1',
  title: 'Xitoy sklad',
  body: null,
  ...over,
});

let seq = 0;
const file = (over: Partial<NoteFile> = {}): NoteFile => {
  seq += 1;
  return {
    partId: `p${seq}`,
    attachmentId: `a${seq}`,
    fileName: `f${seq}.jpg`,
    storageKey: `staff_note/n1/${seq}`,
    sizeBytes: 1000,
    sendAs: 'photo',
    telegramFileId: null,
    telegramSentAs: null,
    ...over,
  };
};

describe('the caption', () => {
  it('always carries the TITLE — without it the customer gets a sheet with no heading', () => {
    expect(noteCaption(head())).toBe('Xitoy sklad');
  });

  it('is the name and then the words saying what the thing is — and nothing else', () => {
    // His own correction the evening 0097 shipped: «zametkani nomi, tekst
    // (nima narsaligini yozish) va filelar bolishi kerak, kordinat boshqa
    // narsalar kerak emas».
    const caption = noteCaption(head({ body: 'Marking: GSR\nTelefon: +86 000' }));
    expect(caption).toBe('Xitoy sklad\n\nMarking: GSR\nTelefon: +86 000');
  });
});

describe('notePlan', () => {
  it('his own case is ONE message: the sheet with the words as its caption', () => {
    // A person FORWARDS what the bot sends, and one message forwards as one
    // message — that is the whole reason the caption rides the first file.
    const plan = notePlan(head({ body: 'Manzil…' }), [file()]);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ kind: 'media', as: 'photo' });
    expect((plan[0] as { caption: string }).caption).toContain('Xitoy sklad');
    expect(planMessageCount(plan)).toBe(1);
  });

  it('a note with no files still sends its words', () => {
    const plan = notePlan(head({ body: 'Karta: 8600…' }), []);
    expect(plan).toEqual([{ kind: 'text', text: 'Xitoy sklad\n\nKarta: 8600…' }]);
  });

  it('a note with no text still sends its files — the caption is the title alone', () => {
    const plan = notePlan(head(), [file(), file()]);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ kind: 'media', as: 'photo' });
    expect((plan[0] as { files: NoteFile[] }).files).toHaveLength(2);
  });

  it('a caption too long for Telegram becomes its own message and the files go bare', () => {
    const plan = notePlan(head({ body: 'x'.repeat(MAX_CAPTION_CHARS + 50) }), [file()]);
    expect(plan[0]!.kind).toBe('text');
    const media = plan.find((p) => p.kind === 'media') as { caption: string | null };
    expect(media.caption).toBeNull();
  });

  it('photos and documents are separate sends — a media group cannot mix them', () => {
    const plan = notePlan(head(), [
      file({ sendAs: 'photo' }),
      file({ sendAs: 'photo' }),
      file({ sendAs: 'document' }),
    ]);
    const media = plan.filter((p) => p.kind === 'media') as { as: string; files: NoteFile[] }[];
    expect(media.map((m) => m.as)).toEqual(['photo', 'document']);
    expect(media[0]!.files).toHaveLength(2);
    expect(media[1]!.files).toHaveLength(1);
  });

  it('more than ten photos are chunked, because sendMediaGroup takes 2..10', () => {
    const plan = notePlan(
      head(),
      Array.from({ length: 12 }, () => file()),
    );
    const media = plan.filter((p) => p.kind === 'media') as { files: NoteFile[] }[];
    expect(media.map((m) => m.files.length)).toEqual([10, 2]);
    expect(planMessageCount(plan)).toBe(12);
  });

  it('the note keeps ITS order — a document between two photos is three sends', () => {
    const plan = notePlan(head(), [
      file({ sendAs: 'photo' }),
      file({ sendAs: 'document' }),
      file({ sendAs: 'photo' }),
    ]);
    expect(plan.map((p) => (p.kind === 'media' ? p.as : p.kind))).toEqual([
      'photo',
      'document',
      'photo',
    ]);
  });

  it('sends nothing but words and files — a note has no other kind of part', () => {
    const plan = notePlan(head({ body: 'Manzil…' }), [file(), file({ sendAs: 'document' })]);
    expect(plan.map((p) => p.kind)).toEqual(['media', 'media']);
  });

  it('a note with nothing in it plans nothing rather than sending an empty message', () => {
    expect(notePlan({ ...head(), title: '' }, [])).toEqual([]);
  });
});

describe('the file-id cache', () => {
  it('is used only when the METHOD that minted it is the one about to be called', () => {
    // A file_id is typed by its method. Handing a document id to sendPhoto is
    // a refusal, a cleared cache and a second full upload — every tap, for
    // ever, on the note that is sent most.
    expect(cachedFileId(file({ telegramFileId: 'AAA', telegramSentAs: 'photo' }))).toBe('AAA');
    expect(cachedFileId(file({ telegramFileId: 'AAA', telegramSentAs: 'document' }))).toBeNull();
    expect(cachedFileId(file({ sendAs: 'document', telegramFileId: 'AAA', telegramSentAs: 'document' }))).toBe(
      'AAA',
    );
    expect(cachedFileId(file())).toBeNull();
  });
});
