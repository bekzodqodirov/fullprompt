import { describe, expect, it } from 'vitest';
import {
  MAX_TG_FILE_BYTES,
  fwdFromName,
  tgMediaPlan,
  toMessageRow,
} from '@/modules/wms/crm/telegram-import';

/**
 * Files both ways, and the two things a bubble has to say about a message it
 * did not originate — the owner's items 1, 2 and 5 (2026-08-11):
 * «faqat rasim emas fillar ham jonatish … klientlar ham bizga fillar
 * jonatishadi», «forvarded deb accountusername turadi», «reply qaysi
 * habarga bo'ldi».
 *
 * Structural, like the photo and audio plans it extends: no gramjs objects,
 * and every decision made from the message alone BEFORE any network I/O.
 */

const doc = (over: Record<string, unknown> = {}) => ({
  className: 'MessageMediaDocument',
  document: {
    mimeType: 'application/pdf',
    size: 240_000,
    attributes: [{ className: 'DocumentAttributeFilename', fileName: 'invoys.pdf' }],
    ...over,
  },
});

describe('a document is fetched, named and sized', () => {
  it('the ordinary case: a client sends an invoice', () => {
    expect(tgMediaPlan(doc(), 11)).toEqual({
      kind: 'file',
      download: true,
      approxBytes: 240_000,
      contentType: 'application/pdf',
      fileName: 'invoys.pdf',
      durationSec: null,
    });
  });

  it('trusts the EXTENSION when Telegram says octet-stream', () => {
    // Telegram labels plenty of documents generically, and an operator's own
    // upload is judged the same way — one rule for both, so a spreadsheet is
    // a spreadsheet whichever door it came through.
    const plan = tgMediaPlan(
      doc({
        mimeType: 'application/octet-stream',
        attributes: [{ className: 'DocumentAttributeFilename', fileName: 'ruyxat.xlsx' }],
      }),
      12,
    );
    expect(plan.kind).toBe('file');
    expect(plan.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('refuses a type STORAGE would refuse, rather than fetching it first', () => {
    // The planner asks the files service's own predicate. Two lists that must
    // agree is the shape this codebase keeps paying for, and the cost here
    // would be megabytes pulled onto a personal account and then dropped.
    expect(tgMediaPlan(doc({ mimeType: 'application/x-msdownload', attributes: [
      { className: 'DocumentAttributeFilename', fileName: 'tool.exe' },
    ] }), 13).kind).toBeNull();
  });

  it('refuses past the cap WITHOUT downloading, and keeps the paperclip', () => {
    const plan = tgMediaPlan(doc({ size: MAX_TG_FILE_BYTES + 1 }), 14);
    expect(plan.kind).toBe('file');
    expect(plan.download).toBe(false);
    expect(plan.approxBytes).toBe(MAX_TG_FILE_BYTES + 1);
  });

  it('refuses an unknown size — pulling blind is how a 2 GB file arrives', () => {
    expect(tgMediaPlan(doc({ size: undefined }), 15).kind).toBeNull();
  });

  it('names a document that arrived without one', () => {
    expect(tgMediaPlan(doc({ attributes: [] }), 16).fileName).toBe('file_16');
  });

  it('leaves a STICKER and a round video note alone', () => {
    // A wall of stickers is not a record of anything, and nothing here plays
    // a round video note. Both are documents, so both need naming.
    expect(
      tgMediaPlan(
        doc({
          mimeType: 'image/webp',
          attributes: [{ className: 'DocumentAttributeSticker' }],
        }),
        17,
      ).kind,
    ).toBeNull();
    expect(
      tgMediaPlan(
        doc({
          mimeType: 'video/mp4',
          attributes: [{ className: 'DocumentAttributeVideo', roundMessage: true }],
        }),
        18,
      ).kind,
    ).toBeNull();
  });

  it('still takes an ordinary video of the cargo', () => {
    const plan = tgMediaPlan(
      doc({
        mimeType: 'video/mp4',
        size: 4_000_000,
        attributes: [
          { className: 'DocumentAttributeVideo', roundMessage: false },
          { className: 'DocumentAttributeFilename', fileName: 'yuk.mp4' },
        ],
      }),
      19,
    );
    expect(plan.kind).toBe('file');
    expect(plan.download).toBe(true);
  });

  it('does not steal the voice note the audio branch already claims', () => {
    const plan = tgMediaPlan(
      {
        className: 'MessageMediaDocument',
        document: {
          mimeType: 'audio/ogg',
          size: 42_000,
          attributes: [{ className: 'DocumentAttributeAudio', voice: true, duration: 7 }],
        },
      },
      20,
    );
    expect(plan.kind).toBe('voice');
  });
});

describe('who a message was forwarded from', () => {
  it('is null when it was not forwarded at all', () => {
    expect(fwdFromName({})).toBeNull();
    expect(toMessageRow(1n, { id: 1, date: 1 }).fwdFrom).toBeNull();
  });

  it('prefers the sender gramjs has already resolved', () => {
    expect(
      fwdFromName({
        fwdFrom: { fromName: 'eski nom' },
        forward: { sender: { firstName: 'Aziz', lastName: 'Karimov' } },
      }),
    ).toBe('Aziz Karimov');
  });

  it('falls back to a channel title, then a username', () => {
    expect(fwdFromName({ fwdFrom: {}, forward: { chat: { title: 'GSR kanal' } } })).toBe(
      'GSR kanal',
    );
    expect(fwdFromName({ fwdFrom: {}, forward: { sender: { username: 'bekzod' } } })).toBe(
      '@bekzod',
    );
  });

  it('reads the header when Telegram sends a NAME instead of an id', () => {
    expect(fwdFromName({ fwdFrom: { fromName: 'Sardor' } })).toBe('Sardor');
    expect(fwdFromName({ fwdFrom: { postAuthor: 'Muallif' } })).toBe('Muallif');
  });

  it('answers EMPTY, not null, for a forward whose source is hidden', () => {
    // The distinction is the whole point: «forwarded, from somebody» changes
    // how a manager reads a message, and null would print nothing at all.
    expect(fwdFromName({ fwdFrom: {} })).toBe('');
  });
});

describe('which message a reply answers', () => {
  it('carries Telegram’s own id', () => {
    const row = toMessageRow(1n, { id: 9, date: 1, replyTo: { replyToMsgId: 4 } });
    expect(row.replyToTgMessageId).toBe(4n);
  });

  it('survives the big-integer object gramjs sometimes hands over', () => {
    // `Number()` on that object is NaN and BigInt(NaN) throws — the same trap
    // that would have refused every voice note (#574).
    const big = { toString: () => '123456789012' };
    expect(toMessageRow(1n, { id: 9, date: 1, replyTo: { replyToMsgId: big } }).replyToTgMessageId)
      .toBe(123456789012n);
  });

  it('is null for an ordinary message, and for a shape it cannot read', () => {
    expect(toMessageRow(1n, { id: 9, date: 1 }).replyToTgMessageId).toBeNull();
    expect(
      toMessageRow(1n, { id: 9, date: 1, replyTo: { replyToMsgId: 'top' } }).replyToTgMessageId,
    ).toBeNull();
  });
});
