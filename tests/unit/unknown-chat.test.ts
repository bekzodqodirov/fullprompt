import { describe, expect, it } from 'vitest';
import { leadNameForChat, PHONELESS_LEAD_NAME, unknownChatAction } from '@/modules/wms/crm/unknown-chat';
import { phoneFingerprint } from '@/modules/wms/crm/peer-index';
import type { DialogVerdict } from '@/modules/wms/crm/telegram-import';

/**
 * Round 79 — the owner's report: «telegramdan yangi klientlar ochsa smslar
 * chatlar nega korinmayabti». They did not appear because a chat was kept
 * only when the peer's phone was already in the client book, so a customer
 * writing in for the FIRST time produced nothing at all.
 *
 * These are the two decisions the widening rests on, both pure: which
 * refusals may become a lead, and what a hashed number can and cannot say.
 */

const unknown: DialogVerdict = { keep: false, reason: 'not_a_client' };

describe('an unknown chat is a customer or a question, depending on the number', () => {
  it('opens a lead on a WORK account', () => {
    expect(unknownChatAction(unknown, true)).toEqual({ action: 'open_lead' });
  });

  it('asks first on a PERSONAL account', () => {
    // The default, and the whole privacy argument: a manager's own number
    // carries their life, so nothing is stored until somebody answers.
    expect(unknownChatAction(unknown, false)).toEqual({ action: 'ask' });
  });

  it('reconsiders ONLY the two acquaintance refusals — every other one keeps its answer', () => {
    // A work account must not turn a group, a bot, the manager's own Saved
    // Messages, Telegram's service chat or a chat somebody excluded into a
    // customer. (`no_phone` used to sit in this list; the owner moved it out
    // for work numbers on 2026-10-29 — next test.)
    for (const reason of ['not_private', 'is_bot', 'excluded', 'self', 'service'] as const) {
      const verdict: DialogVerdict = { keep: false, reason };
      expect(unknownChatAction(verdict, true), reason).toEqual({ action: 'skip', reason });
      expect(unknownChatAction(verdict, false), reason).toEqual({ action: 'skip', reason });
    }
  });

  it('a hidden number opens a lead on a WORK account and stays out on a PERSONAL one (his «1 a», 2026-10-29)', () => {
    // «Telegramda raqamini yashirgan odam yangi raqamingizga yozsa … tizim uni
    // avtomatik lid qilib ochadi va AI darhol javob tayyorlaydi — bu raqam
    // faqat mijozlar uchun». A personal number keeps the old answer: there is
    // no number to put on the tray, and the AI's «📵» card asks him instead.
    const hidden: DialogVerdict = { keep: false, reason: 'no_phone' };
    expect(unknownChatAction(hidden, true)).toEqual({ action: 'open_lead' });
    expect(unknownChatAction(hidden, false)).toEqual({ action: 'skip', reason: 'no_phone' });
  });

  it('leaves a chat we already know alone', () => {
    const known: DialogVerdict = { keep: true, clientId: 'c1', clientCode: 'GS777' };
    expect(unknownChatAction(known, true)).toEqual({ action: 'skip', reason: 'known' });
  });

  it('never mints a nameless lead', () => {
    expect(leadNameForChat('Dilshod', '+998901234567')).toBe('Dilshod');
    expect(leadNameForChat('   ', '+998901234567')).toBe('+998901234567');
    expect(leadNameForChat(null, '+998901234567')).toBe('+998901234567');
  });

  it('names a hidden number by its Telegram name, then its @username, then words — never its id', () => {
    expect(leadNameForChat('Dilshod', null)).toBe('Dilshod');
    // `peerTitle` hands the @username over when there is no name.
    expect(leadNameForChat('@dilshod_uz', null)).toBe('@dilshod_uz');
    // …and «#<id>» when there is neither: a row label, never a lead's name.
    expect(leadNameForChat('#5512345678', null)).toBe(PHONELESS_LEAD_NAME);
    expect(leadNameForChat('#5512345678', '+998901234567')).toBe('+998901234567');
    for (const title of [null, undefined, '', '   ', '#1']) {
      const name = leadNameForChat(title, null);
      expect(name, String(title)).toBe(PHONELESS_LEAD_NAME);
      expect(name).not.toBe('');
    }
    // Words only: no digit a reader could take for a phone or an id.
    expect(PHONELESS_LEAD_NAME).not.toMatch(/\d/);
  });
});

describe('the lookback index answers one question and cannot answer any other', () => {
  it('matches the same number written eight different ways', () => {
    // The rule every phone comparison here already uses (#111): the last nine
    // digits. Hashing the raw string would make these four people.
    const forms = ['+998 90 175-78-00', '901757800', '(90) 175 78 00', '998901757800'];
    const hashes = forms.map((form) => phoneFingerprint(form));
    expect(new Set(hashes).size, hashes.join(' ')).toBe(1);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives different numbers different fingerprints', () => {
    expect(phoneFingerprint('901757800')).not.toBe(phoneFingerprint('901757801'));
  });

  it('holds nothing that could be read back as a number', () => {
    // The point of the whole design (owner: «hash bilan qil»): what is stored
    // must not contain the digits, or the table is an address book again.
    const hash = phoneFingerprint('+998901757800')!;
    expect(hash).not.toContain('901757800');
    expect(hash).not.toContain('1757800');
  });

  it('refuses anything that is not a phone number', () => {
    for (const junk of ['', '  ', 'salom', '1234', '12345678']) {
      expect(phoneFingerprint(junk), junk).toBeNull();
    }
    expect(phoneFingerprint(null)).toBeNull();
    expect(phoneFingerprint(undefined)).toBeNull();
  });
});
