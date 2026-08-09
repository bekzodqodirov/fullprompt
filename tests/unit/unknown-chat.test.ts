import { describe, expect, it } from 'vitest';
import { leadNameForChat, unknownChatAction } from '@/modules/wms/crm/unknown-chat';
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

  it('reconsiders ONLY «not a client» — every other refusal keeps its answer', () => {
    // A work account must not turn a group, a bot or the manager's own Saved
    // Messages into a customer. `no_phone` stays refused too: a lead nobody
    // can ring is a row with a name in it.
    for (const reason of ['not_private', 'is_bot', 'no_phone', 'excluded', 'self'] as const) {
      const verdict: DialogVerdict = { keep: false, reason };
      expect(unknownChatAction(verdict, true), reason).toEqual({ action: 'skip', reason });
      expect(unknownChatAction(verdict, false), reason).toEqual({ action: 'skip', reason });
    }
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
