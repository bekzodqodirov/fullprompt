import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetDrafts,
  activeDraft,
  ALBUM_SETTLE_MS,
  albumSettled,
  draftNote,
  draftTitle,
  dueFromButton,
  endDraft,
  forwardAlbumOf,
  lateAckDue,
  lingerFor,
  MAX_DRAFT_FILE_BYTES,
  MAX_DRAFT_SOURCES,
  noteForwardPart,
  noteLinger,
  parseTypedDue,
  postponeDue,
  startDraft,
  withPart,
} from '@/modules/platform/telegram/task-draft';
import { parseDue } from '@/modules/platform/tasks/service';

/**
 * The staff bot's task draft (docs/TELEGRAM-TOPSHIRIQ.md §3), where it is
 * pure: what a part does to the draft, the title, the typed date on the
 * Tashkent clock, the album settle, the linger, Door B's album memory. The
 * grammy shell is source-shape in topshiriq-wire.test.ts.
 */

const CHAT = 4242n;
afterEach(() => __resetDrafts());

describe('what a part does to the draft', () => {
  it('an own typed line is the NOTE and not a source; a forward is a source and never the note', () => {
    let draft = startDraft(CHAT);
    draft = withPart(draft, { messageId: 1, text: 'Siroj, GS777 ni tekshir', forwarded: false }, 4242);
    expect(draft.texts).toEqual(['Siroj, GS777 ni tekshir']);
    expect(draft.sources).toEqual([]);
    // A customer's forwarded words are somebody else's: the POINTER travels,
    // the text is stored nowhere (access-money-12's premise).
    draft = withPart(draft, { messageId: 2, text: 'mijozning gapi', forwarded: true }, 4242);
    expect(draft.texts).toEqual(['Siroj, GS777 ni tekshir']);
    expect(draft.sources).toEqual([{ chatId: 4242, messageId: 2 }]);
  });

  it('a voice note is a source AND a file for the web; an own caption is typed text', () => {
    const draft = withPart(
      startDraft(CHAT),
      {
        messageId: 3,
        kind: 'voice',
        text: 'shuni eshit',
        forwarded: false,
        file: { fileId: 'AwAD', name: null, mime: 'audio/ogg', size: 9_000 },
      },
      4242,
    );
    expect(draft.sources).toEqual([{ chatId: 4242, messageId: 3 }]);
    expect(draft.files).toEqual([{ fileId: 'AwAD', name: null, mime: 'audio/ogg', size: 9_000, kind: 'voice' }]);
    expect(draft.texts).toEqual(['shuni eshit']);
  });

  it('a file past Telegram’s 20 MB is forwarded but NOT downloaded, and its name is kept to be told', () => {
    const draft = withPart(
      startDraft(CHAT),
      {
        messageId: 4,
        kind: 'video',
        forwarded: false,
        file: { fileId: 'BAAD', name: 'sklad.mp4', mime: 'video/mp4', size: MAX_DRAFT_FILE_BYTES + 1 },
      },
      4242,
    );
    expect(draft.sources).toHaveLength(1);
    expect(draft.files).toEqual([]);
    expect(draft.tooBig).toEqual(['sklad.mp4']);
  });

  it('a contact and a place reach the web as a line of the note', () => {
    let draft = withPart(startDraft(CHAT), { messageId: 5, kind: 'contact', forwarded: false, fact: '👤 Kontakt: Ali +998901112233' }, 4242);
    draft = withPart(draft, { messageId: 6, kind: 'location', forwarded: false, fact: '📍 Joylashuv: 41.3, 69.2' }, 4242);
    expect(draftNote(draft)).toBe('👤 Kontakt: Ali +998901112233\n📍 Joylashuv: 41.3, 69.2');
    expect(draft.sources).toHaveLength(2);
  });

  it('never more than ten sources — what one forwardMessages call carries', () => {
    let draft = startDraft(CHAT);
    for (let i = 0; i < MAX_DRAFT_SOURCES + 3; i++) {
      draft = withPart(draft, { messageId: i + 1, forwarded: true }, 4242);
    }
    expect(draft.sources).toHaveLength(MAX_DRAFT_SOURCES);
    // …and the three that went nowhere are COUNTED, so the author can be told once (review bot-11).
    expect(draft.dropped).toBe(3);
  });

  it('the draft lives per chat and ends', () => {
    startDraft(CHAT);
    expect(activeDraft(CHAT)).not.toBeNull();
    expect(activeDraft(CHAT + 1n)).toBeNull();
    endDraft(CHAT);
    expect(activeDraft(CHAT)).toBeNull();
  });
});

describe('the title', () => {
  it('is the first typed line, cut at 120 characters ON A WORD', () => {
    const long = `${'tekshirish '.repeat(20)}oxiri`;
    const title = draftTitle({ texts: [long], firstKind: null, firstForwarded: false });
    expect(Array.from(title).length).toBeLessThanOrEqual(120);
    expect(title.endsWith('tekshirish')).toBe(true);
    expect(draftTitle({ texts: ['\n  Birinchi qator\nikkinchi'], firstKind: null, firstForwarded: false })).toBe(
      'Birinchi qator',
    );
  });

  it('never cuts through an emoji (code points, not UTF-16 units)', () => {
    const title = draftTitle({ texts: ['🚚'.repeat(130)], firstKind: null, firstForwarded: false });
    expect(Array.from(title)).toHaveLength(120);
    expect(/[\uD800-\uDBFF]$/.test(title)).toBe(false);
  });

  it('with nothing typed, says what the draft IS', () => {
    expect(draftTitle({ texts: [], firstKind: 'voice', firstForwarded: false })).toBe('🎤 Ovozli topshiriq');
    expect(draftTitle({ texts: [], firstKind: 'document', firstForwarded: false })).toBe('📎 Fayl');
    expect(draftTitle({ texts: [], firstKind: 'photo', firstForwarded: false })).toBe('🖼 Rasm');
    expect(draftTitle({ texts: [], firstKind: 'photo', firstForwarded: true })).toBe('↪️ Yo‘naltirilgan xabar');
  });
});

describe('the due, on the Tashkent calendar', () => {
  // 2026-10-06 21:00 UTC is 2026-10-07 02:00 in Tashkent — the trap a UTC
  // «today» falls into.
  const lateNight = new Date('2026-10-06T21:00:00Z');

  it('Bugun / Ertaga / Indinga are Tashkent days, Muddatsiz is none', () => {
    expect(dueFromButton('due_b', lateNight).dueAt).toBe('2026-10-07');
    expect(dueFromButton('due_e', lateNight).dueAt).toBe('2026-10-08');
    expect(dueFromButton('due_i', lateNight).dueAt).toBe('2026-10-09');
    expect(dueFromButton('due_n', lateNight)).toEqual({ dueAt: '', tzOffsetMin: null, label: 'muddatsiz' });
    // A bare date is an all-day deadline to parseDue — what «ertaga» means.
    expect(parseDue(dueFromButton('due_e', lateNight).dueAt).allDay).toBe(true);
  });

  it('⏰ moves by a day, two, or a week', () => {
    const now = new Date('2026-10-06T06:00:00Z');
    expect(postponeDue('e', now).dueAt).toBe('2026-10-07');
    expect(postponeDue('i', now).dueAt).toBe('2026-10-08');
    expect(postponeDue('w', now).dueAt).toBe('2026-10-13');
  });

  it('«12.10» and «12.10 15:00» read on the Tashkent clock', () => {
    const now = new Date('2026-10-06T06:00:00Z');
    expect(parseTypedDue('12.10', now)).toEqual({ dueAt: '2026-10-12', tzOffsetMin: null, label: '12.10' });
    const timed = parseTypedDue('12.10 15:00', now)!;
    expect(timed).toMatchObject({ dueAt: '2026-10-12T15:00', tzOffsetMin: -300 });
    // 15:00 in Tashkent is 10:00 UTC — parseDue's own arithmetic.
    expect(parseDue(timed.dueAt, timed.tzOffsetMin).dueAt!.toISOString()).toBe('2026-10-12T10:00:00.000Z');
  });

  it('a bare time already past today means TOMORROW, and the label says so', () => {
    // 11:00 UTC = 16:00 Tashkent: «15:00» is gone for today.
    const now = new Date('2026-10-06T11:00:00Z');
    expect(parseTypedDue('15:00', now)).toEqual({ dueAt: '2026-10-07T15:00', tzOffsetMin: -300, label: 'ertaga 15:00' });
    expect(parseTypedDue('17:30', now)).toEqual({ dueAt: '2026-10-06T17:30', tzOffsetMin: -300, label: 'bugun 17:30' });
  });

  it('a date without a year already behind us is NEXT year’s — nobody gives a task due in the past', () => {
    const now = new Date('2026-10-06T06:00:00Z');
    expect(parseTypedDue('01.03', now)!.dueAt).toBe('2027-03-01');
    expect(parseTypedDue('06.10', now)!.dueAt).toBe('2026-10-06');
  });

  it('refuses what is not a real moment instead of rolling it into another day', () => {
    const now = new Date('2026-10-06T06:00:00Z');
    for (const bad of ['31.11', '30.02', '12.13', '25:00', '12:60', '12.10 24:00', 'ertaga', '', '1210']) {
      expect(parseTypedDue(bad, now), bad).toBeNull();
    }
  });
});

describe('an album settles before the due is honoured (telegram-mechanics-17)', () => {
  it('a part younger than the settle window holds the press; then it lets go', () => {
    const t0 = 1_000_000;
    const draft = withPart(
      startDraft(CHAT),
      { messageId: 7, kind: 'photo', forwarded: false, mediaGroupId: 'G1', file: { fileId: 'p', name: null, mime: 'image/jpeg', size: 1 } },
      4242,
      t0,
    );
    expect(albumSettled(draft, t0 + ALBUM_SETTLE_MS - 1)).toBe(false);
    expect(albumSettled(draft, t0 + ALBUM_SETTLE_MS)).toBe(true);
    // A draft with no album is always settled.
    expect(albumSettled(startDraft(CHAT + 1n), t0)).toBe(true);
  });

  it('a late part lingers onto the made task for its own album only, acknowledged once', () => {
    noteLinger(CHAT, 'task-1', ['G1']);
    const linger = lingerFor(CHAT, 'G1')!;
    expect(linger.taskId).toBe('task-1');
    expect(lingerFor(CHAT, 'G2')).toBeNull();
    expect(lingerFor(CHAT, null)).toBeNull();
    expect(lateAckDue(linger, 'G1')).toBe(true);
    expect(lateAckDue(linger, 'G1')).toBe(false);
  });
});

describe('Door B remembers an album (telegram-mechanics-18)', () => {
  it('offers once per album and hands every part back on the press, in order', () => {
    expect(noteForwardPart(CHAT, 'A1', 12).offer).toBe(true);
    expect(noteForwardPart(CHAT, 'A1', 11).offer).toBe(false);
    expect(noteForwardPart(CHAT, 'A1', 13).offer).toBe(false);
    expect(forwardAlbumOf(CHAT, 'A1')).toEqual([11, 12, 13]);
  });

  it('after a deploy the map is empty — null, so the caller SAYS only one part came', () => {
    expect(forwardAlbumOf(CHAT, 'never-seen')).toBeNull();
    expect(forwardAlbumOf(CHAT, null)).toBeNull();
  });
});
