import { afterEach, describe, expect, it } from 'vitest';
import {
  BURST_FULL,
  BURST_GONE,
  BURST_IN_REQUEST,
  BURST_IN_TASK,
  BURST_MAX_PARTS,
  BURST_TASK_CAP,
  BURST_WINDOW_MS,
  burstAnswering,
  burstFull,
  burstJoins,
  burstLastSeen,
  burstOfferText,
  burstOneText,
  burstWaiting,
  endBurst,
  endsBurst,
  freshBurst,
  goneBurst,
  markBurstTaken,
  nextOfferIds,
  noteBurstPart,
  noteOverflow,
  offeredCount,
  readBurst,
  rewriteBurst,
  takenWords,
  type BurstPart,
} from '@/modules/platform/telegram/burst-wait';
import { burstPartOf } from '@/modules/platform/telegram/burst';
import { burstPauseLine, PAUSE_LINE, pauseKeyboard, pauseLine } from '@/modules/platform/telegram/calc-dialog';
import { CALC_STEP_REPEAT, forwardKeyboard, parseCallback } from '@/modules/platform/telegram/staff-bot';
import { refusalOf } from '@/modules/platform/telegram/calc-files';
import { __forgetWaitMemory } from '@/modules/platform/telegram/waits';

/**
 * The burst (docs/IKKI-ESHIK.md §4.1, §4.2, his 6a «ketma-ket yuborilgan
 * fayllarga BITTA savol»): the wait's pure rules and its words. The door and
 * the presses are pinned through the bot's own chain in
 * tests/integration/burst.integration.test.ts.
 */

const CHAT = 7_700_000_001n;
const W = BURST_WINDOW_MS / 1000;

const file = (id: number, over: Partial<BurstPart> = {}): BurstPart => ({
  messageId: id,
  forwarded: false,
  kind: 'photo',
  fileId: `f${id}`,
  name: null,
  mime: 'image/jpeg',
  size: 10,
  text: null,
  ...over,
});
const forward = (id: number, text = `mijoz ${id}`): BurstPart => ({ ...file(id), forwarded: true, kind: null, fileId: null, mime: null, size: null, text });

afterEach(() => __forgetWaitMemory());

describe('a burst is parts within two minutes of the previous one (§4.1)', () => {
  it('a part before the row’s expiry joins; at it, a new burst opens', () => {
    const entry = { payload: freshBurst(file(1)), expiresAt: 1_000 + W };
    expect(burstJoins(entry, 1_000 + W - 1)).toBe(true);
    expect(burstJoins(entry, 1_000 + W)).toBe(false);
  });

  it('closed, taken or full: no part joins', () => {
    const at = 1_000;
    const base = { payload: freshBurst(file(1)), expiresAt: at + W };
    expect(burstJoins({ ...base, payload: { ...base.payload, open: false } }, at)).toBe(false);
    expect(burstJoins({ ...base, payload: { ...base.payload, taken: true } }, at)).toBe(false);
    const full = Array.from({ length: BURST_MAX_PARTS }, (_, i) => file(i + 1));
    expect(burstJoins({ ...base, payload: { ...base.payload, parts: full } }, at)).toBe(false);
    expect(burstJoins(null, at)).toBe(false);
  });

  it('the wait: ten parts in a row are ONE burst; one 2 minutes after the last opens the next', () => {
    const t0 = Math.floor(Date.now() / 1000);
    for (let i = 1; i <= 10; i += 1) noteBurstPart(CHAT, file(i), t0 + i);
    const one = readBurst(CHAT)!;
    expect(one.payload.id).toBe(1);
    expect(one.payload.parts.map((p) => p.messageId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // The expiry slid with each part: the last part plus the window.
    expect(one.expiresAt).toBe(t0 + 10 + W);
    noteBurstPart(CHAT, file(11), t0 + 10 + W);
    expect(readBurst(CHAT)!.payload.id).toBe(11);
  });

  it('a redelivered part is counted once; a FULL burst stands — the 21st part is its overflow, counted once, never a new burst over it (review PB-ADV-1)', () => {
    // Re-anchored: this pinned «the 21st part opens the next burst», which
    // REPLACED the twenty in the one row a chat has — never drawn when it
    // came inside the album's debounce, and answered «gone» when it did.
    const t0 = Math.floor(Date.now() / 1000);
    noteBurstPart(CHAT, file(1), t0);
    noteBurstPart(CHAT, file(1), t0 + 1);
    expect(readBurst(CHAT)!.payload.parts).toHaveLength(1);
    for (let i = 2; i <= BURST_MAX_PARTS; i += 1) noteBurstPart(CHAT, file(i), t0 + 1);
    const full = readBurst(CHAT)!;
    expect(full.payload.parts).toHaveLength(BURST_MAX_PARTS);
    expect(burstJoins(full, t0 + 2)).toBe(false);
    expect(burstFull(full, t0 + 2)).toBe(true);
    noteOverflow(CHAT, file(BURST_MAX_PARTS + 1), t0 + 2);
    noteOverflow(CHAT, file(BURST_MAX_PARTS + 2), t0 + 3);
    // A redelivered overflow part is no newer than what was seen.
    noteOverflow(CHAT, file(BURST_MAX_PARTS + 1), t0 + 3);
    const after = readBurst(CHAT)!;
    expect(after.payload).toMatchObject({ id: 1, overflow: 2, lastSeen: BURST_MAX_PARTS + 2 });
    expect(after.payload.parts).toHaveLength(BURST_MAX_PARTS);
    expect(burstLastSeen(after.payload)).toBe(BURST_MAX_PARTS + 2);
    // The expiry slid with the overflow: it was sent in a row with the burst.
    expect(after.expiresAt).toBe(t0 + 3 + W);
    expect(BURST_FULL(5)).toBe(
      '⚠ Bir martada ko‘pi bilan 20 ta xabar olinadi — qolgan 5 tasini tugmani bosgandan keyin qaytadan yuboring.',
    );
  });

  it('a replaced burst leaves what its message spoke for: the count, and where its parts went (review PB-SPEC-3, PB-ADV-3)', () => {
    const t0 = Math.floor(Date.now() / 1000);
    noteBurstPart(CHAT, file(1), t0);
    noteBurstPart(CHAT, file(2), t0);
    noteBurstPart(CHAT, file(3), t0);
    rewriteBurst(CHAT, 1, (p) => ({ ...p, offerIds: [700], aliasIds: [710] }));
    markBurstTaken(CHAT, 1, { note: 'note-x' });
    noteBurstPart(CHAT, file(4), t0 + 1);
    expect(readBurst(CHAT)!.payload.id).toBe(4);
    for (const id of [700, 710]) {
      expect(goneBurst(CHAT, id), String(id)).toEqual({ ids: [700, 710], parts: 3, intoNote: 'note-x', intoTask: false, parkedNote: null });
    }
    expect(goneBurst(CHAT, 999)).toBeNull();
    // One generation: the next replacement forgets it.
    rewriteBurst(CHAT, 4, (p) => ({ ...p, offerIds: [720] }));
    endBurst(CHAT);
    noteBurstPart(CHAT, file(5), t0 + 2);
    expect(goneBurst(CHAT, 700)).toBeNull();
    expect(goneBurst(CHAT, 720)).toMatchObject({ parts: 1, intoNote: null });
    // A burst that never drew nor was asked about leaves nothing to answer.
    expect(freshBurst(file(9), freshBurst(file(8))).previous).toBeNull();
  });

  it('ended: the next part opens a new burst, and the ended one’s message still answers a press', () => {
    const t0 = Math.floor(Date.now() / 1000);
    noteBurstPart(CHAT, file(1), t0);
    rewriteBurst(CHAT, 1, (p) => ({ ...p, offerIds: [500] }));
    endBurst(CHAT);
    expect(readBurst(CHAT)!.payload.open).toBe(false);
    expect(burstAnswering(CHAT, 500)?.parts.map((p) => p.messageId)).toEqual([1]);
    noteBurstPart(CHAT, file(2), t0 + 1);
    expect(readBurst(CHAT)!.payload.id).toBe(2);
    // …and the older message is now older than the row.
    expect(burstAnswering(CHAT, 500)).toBeNull();
  });
});

describe('the press reads the burst by the PRESSED message (§4.1)', () => {
  it('the current copy, an older copy kept, a question asked about it — nothing else', () => {
    const t0 = Math.floor(Date.now() / 1000);
    noteBurstPart(CHAT, file(1), t0);
    rewriteBurst(CHAT, 1, (p) => ({ ...p, offerIds: [600, 610], aliasIds: [620] }));
    for (const id of [600, 610, 620]) expect(burstAnswering(CHAT, id)?.id, String(id)).toBe(1);
    expect(burstAnswering(CHAT, 1)).toBeNull();
    expect(burstAnswering(CHAT, 999)).toBeNull();
  });

  it('nextOfferIds: a moved copy replaces the old one, an undeletable old copy stays answerable', () => {
    expect(nextOfferIds([], null, { messageId: 10, moved: true, kept: null })).toEqual([10]);
    expect(nextOfferIds([10], 10, { messageId: 20, moved: true, kept: null })).toEqual([20]);
    expect(nextOfferIds([10], 10, { messageId: 20, moved: true, kept: 10 })).toEqual([10, 20]);
    expect(nextOfferIds([10], 10, { messageId: 10, moved: false, kept: null })).toEqual([10]);
  });

  it('a taken burst waits for nothing; a burst waits beside the parked collection it was drawn by', () => {
    const t0 = Math.floor(Date.now() / 1000);
    noteBurstPart(CHAT, file(1), t0);
    expect(burstWaiting(CHAT, 'note-a')).toBe(false);
    rewriteBurst(CHAT, 1, (p) => ({ ...p, parkedNote: 'note-a' }));
    expect(burstWaiting(CHAT, 'note-a')).toBe(true);
    expect(burstWaiting(CHAT, 'note-b')).toBe(false);
    markBurstTaken(CHAT, 1, { note: 'note-a' });
    expect(burstWaiting(CHAT, 'note-a')).toBe(false);
  });

  it('a take records where the parts went — a collection or a task, each its own (review PB-ADV-3)', () => {
    const t0 = Math.floor(Date.now() / 1000);
    noteBurstPart(CHAT, file(1), t0);
    markBurstTaken(CHAT, 1, { note: 'note-a' });
    expect(readBurst(CHAT)!.payload).toMatchObject({ taken: true, open: false, intoNote: 'note-a' });
    expect(readBurst(CHAT)!.payload.intoTask).toBeUndefined();
    markBurstTaken(CHAT, 1, { task: true });
    expect(readBurst(CHAT)!.payload).toMatchObject({ intoNote: 'note-a', intoTask: true });
    expect(BURST_IN_REQUEST).toBe('Bu xabarlar allaqachon so‘rovga qo‘shilgan.');
    expect(BURST_IN_TASK).toBe('Bu xabarlar allaqachon topshiriqqa olingan.');
  });
});

describe('the ONE message’s words (§4.1)', () => {
  it('plain files', () => {
    expect(burstOfferText([file(1)], true)).toBe('➕ Bu faylni so‘rovga qo‘shamizmi?');
    expect(burstOfferText([file(1), file(2), file(3)], true)).toBe('➕ 3 ta faylni so‘rovga qo‘shamizmi?');
  });

  it('any forward: Door B’s question with the counts, «yoki so‘rovga…» only beside a request', () => {
    const five = [file(1), file(2), file(3), forward(4), forward(5)];
    expect(burstOfferText(five, true)).toBe('📌 5 ta xabar (3 tasi fayl) — topshiriq qilamizmi yoki so‘rovga qo‘shamizmi?');
    expect(burstOfferText(five, false)).toBe('📌 5 ta xabar (3 tasi fayl) — topshiriq qilamizmi?');
    expect(burstOfferText([forward(1), forward(2)], true)).toBe('📌 2 ta xabar — topshiriq qilamizmi yoki so‘rovga qo‘shamizmi?');
    // One forward alone keeps Door B's own question.
    expect(burstOfferText([forward(1)], false)).toBe('📌 Topshiriq qilamizmi?');
    expect(burstOfferText([forward(1)], true)).toBe('📌 Topshiriq qilamizmi yoki so‘rovga qo‘shamizmi?');
  });

  it('«🔍 Qidirish» only when the burst holds exactly one text', () => {
    expect(burstOneText([forward(1, 'GS777 qayerda')])).toBe('GS777 qayerda');
    expect(burstOneText([forward(1), forward(2)])).toBeNull();
    expect(burstOneText([file(1), forward(2, 'bitta')])).toBe('bitta');
    expect(forwardKeyboard({ search: false }).flat().map((b) => b.callback_data)).toEqual(['fb:task']);
    expect(forwardKeyboard().flat().map((b) => b.callback_data)).toEqual(['fb:task', 'fb:search']);
  });

  it('what a press whose wait is gone counts off the pressed message', () => {
    expect(offeredCount('➕ 3 ta faylni so‘rovga qo‘shamizmi?')).toBe(3);
    expect(offeredCount('📌 5 ta xabar (3 tasi fayl) — topshiriq qilamizmi?')).toBe(5);
    expect(offeredCount(burstPauseLine(4))).toBe(4);
    expect(offeredCount('➕ Bu faylni so‘rovga qo‘shamizmi?')).toBe(1);
    expect(offeredCount('📌 Topshiriq qilamizmi?')).toBe(1);
    expect(offeredCount(null)).toBe(1);
  });

  it('the take counts PARTS taken, never goods added; the two refusals verbatim', () => {
    expect(takenWords(3, 2)).toBe('3 ta fayl va 2 ta xabar');
    expect(takenWords(3, 0)).toBe('3 ta fayl');
    expect(takenWords(0, 2)).toBe('2 ta xabar');
    expect(takenWords(0, 0)).toBeNull();
    expect(BURST_GONE).toBe('⚠ Faqat 1 ta xabar qo‘shildi — qolganlarini qaytadan yo‘naltiring.');
    expect(BURST_TASK_CAP(10)).toBe('⚠ Topshiriqqa birinchi 10 tasi qo‘shiladi.');
  });
});

describe('what ends a burst — its one point (§4.1)', () => {
  it('a typed text, a press, a contact, a place end it; a file, a voice note or a forward does not', () => {
    expect(endsBurst({ message: { text: 'shu' } })).toBe(true);
    expect(endsBurst({ callbackQuery: { data: 'c:cancel' } })).toBe(true);
    expect(endsBurst({ message: { contact: { phone_number: '1' } } })).toBe(true);
    expect(endsBurst({ message: { location: { latitude: 1, longitude: 2 } } })).toBe(true);
    for (const m of [{ photo: [{}] }, { document: {} }, { voice: {} }, { text: 'x', forward_origin: { type: 'hidden_user' } }]) {
      expect(endsBurst({ message: m }), JSON.stringify(m)).toBe(false);
    }
    // An edit or a service update is no new action.
    expect(endsBurst({})).toBe(false);
  });

  it('a message as a part: files and forwards; a plain text or a plain voice note is none', () => {
    const base = { message_id: 5, date: 0, chat: { id: 1, type: 'private' } };
    expect(burstPartOf({ ...base, photo: [{ file_id: 'a', file_unique_id: 'a', width: 1, height: 1 }], caption: 'GS777' } as never)).toMatchObject({
      kind: 'photo',
      fileId: 'a',
      text: 'GS777',
      forwarded: false,
    });
    expect(burstPartOf({ ...base, text: 'salom' } as never)).toBeNull();
    expect(burstPartOf({ ...base, voice: { file_id: 'v', file_unique_id: 'v', duration: 1 } } as never)).toBeNull();
    expect(
      burstPartOf({ ...base, text: 'yuk keldi', forward_origin: { type: 'hidden_user', sender_user_name: 'M', date: 0 } } as never),
    ).toMatchObject({ kind: null, forwarded: true, text: 'yuk keldi' });
  });
});

describe('beside a PARKED collection, the pause line is the burst’s ONE message (§4.2)', () => {
  it('its words, verbatim', () => {
    expect(burstPauseLine(3)).toBe(
      '⏸ Hisoblatish to‘xtab turibdi (30 daqiqa yozilmadi). Hozirgi 3 ta xabar unga hali qo‘shilmagan — «▶️ Davom etamiz» ni bossangiz, qo‘shiladi.',
    );
  });

  it('▶️ is c:resume_take beside a burst — parsed, own; 📌 only with a forward; every other ▶️ stays c:resume', () => {
    const data = (k: ReturnType<typeof pauseKeyboard>) => k.inline_keyboard.flat().map((b) => b.callback_data);
    expect(data(pauseKeyboard({ forwards: false }))).toEqual(['c:resume_take', 'c:cancel']);
    expect(data(pauseKeyboard({ forwards: true }))).toEqual(['c:resume_take', 'fb:task', 'c:cancel']);
    expect(data(pauseKeyboard())).toEqual(['c:resume', 'c:cancel']);
    for (const d of data(pauseKeyboard({ forwards: true }))) expect(parseCallback(d), d).not.toBeNull();
    expect(parseCallback('c:resume_take')).toEqual({ kind: 'calc', step: 'resume_take' });
    expect(CALC_STEP_REPEAT.resume_take).toBe('own');
  });

  it('«yoki jadvalga reply qilib yozing» only on a table with no burst waiting', () => {
    expect(pauseLine('review', false)).toContain('yoki jadvalga reply qilib yozing');
    expect(pauseLine('review', true)).not.toContain('jadvalga reply');
    expect(pauseLine('material', false)).not.toContain('jadvalga reply');
    expect(pauseLine('material', false)).toBe(
      '⏸ Hisoblatish to‘xtab turibdi (30 daqiqa yozilmadi) — bu xabar unga qo‘shilmadi.\nDavom etish uchun «▶️ Davom etamiz» ni bosing.',
    );
    expect(PAUSE_LINE).toBe(pauseLine('review', false));
  });
});

describe('a file’s say: a line of the ONE prompt, or a refusal of its own (§1.4)', () => {
  const state = { fileNotes: ['📄 «a.xlsx» — 3 ta tovar o‘qildi.'], pdfs: [], sheetTexts: [] };
  it('a receipt-time note, a PDF, a header-less sheet: informational', () => {
    expect(refusalOf({ patch: { fileNotes: [...state.fileNotes, '📄 «b.xlsx» — 2 ta tovar o‘qildi.'] }, say: '📄 «b.xlsx» — 2 ta tovar o‘qildi.' })).toBeNull();
    expect(refusalOf({ patch: { pdfs: [{ attachmentId: 'x', name: 'b.pdf', bytes: 1 }] }, say: '📄 «b.pdf» — AI o‘qiydi.' })).toBeNull();
    expect(refusalOf({ patch: { sheetTexts: [{ text: 'x', label: 'c.xlsx' }] as never }, say: '📄 «c.xlsx» — jadval sarlavhasini topa olmadim, AI o‘qiydi.' })).toBeNull();
  });
  it('a HEIC, a Word file, a 4th PDF: its own message; no say: nothing', () => {
    expect(refusalOf({ patch: { imagesSkipped: 1 }, say: '📷 «a.heic» — HEIC rasm, o‘qib bo‘lmaydi.' })).not.toBeNull();
    expect(refusalOf({ patch: {}, say: '📄 «a.docx» — Word fayl o‘qilmaydi.' })).not.toBeNull();
    expect(refusalOf({ patch: {}, say: null })).toBeNull();
  });
});
