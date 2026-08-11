import { describe, expect, it } from 'vitest';
import { chatNeedsAnswer, chatState, type ChatFacts } from '@/modules/wms/crm/waiting';

/**
 * Round 88's three states. Every case here is one the owner can produce on a
 * normal working day, and the two that used to be indistinguishable —
 * «somebody asked a question nobody has seen» and «somebody wrote ok» — are
 * the reason this file exists.
 */

const facts = (over: Partial<ChatFacts> = {}): ChatFacts => ({
  lastDirection: 'in',
  lastInboundTgId: 100n,
  lastReadTgId: null,
  replyPending: false,
  ...over,
});

describe('chatState', () => {
  it('a client asked and nobody has seen it — the alarm', () => {
    expect(chatState(facts())).toBe('new');
    expect(chatNeedsAnswer('new')).toBe(true);
  });

  it('«ok» that the manager read on their phone is SEEN, and silent', () => {
    // The owner's own case: «klient chatga nuqta qoygandur, misol uchun ok».
    expect(chatState(facts({ lastReadTgId: 100n }))).toBe('seen');
    expect(chatNeedsAnswer('seen')).toBe(false);
  });

  it('read PAST the message counts as read — Telegram reports a high-water mark', () => {
    expect(chatState(facts({ lastReadTgId: 137n }))).toBe('seen');
  });

  it('read up to an EARLIER message is still new — the newest one is unseen', () => {
    expect(chatState(facts({ lastInboundTgId: 100n, lastReadTgId: 99n }))).toBe('new');
  });

  it('we spoke last, so there is nothing to answer', () => {
    expect(chatState(facts({ lastDirection: 'out' }))).toBe('answered');
    expect(chatState(facts({ lastDirection: null, lastInboundTgId: null }))).toBe('answered');
  });

  it('a reply typed in the CRM counts as answered BEFORE Telegram confirms it', () => {
    /**
     * The defect this fixes: the old mark only ever saw a delivered message,
     * so a queued reply left the alarm up — and for ever with company-wide
     * sending off, which is how it ships.
     */
    expect(chatState(facts({ replyPending: true }))).toBe('answered');
    // …and it wins even over an unread inbound, because somebody has acted.
    expect(chatState(facts({ replyPending: true, lastReadTgId: null }))).toBe('answered');
  });

  it('a read pointer with no inbound message cannot make anything seen', () => {
    // Guards the shape rather than a scenario: `>=` against a null id must
    // never be allowed to read as true.
    expect(chatState(facts({ lastInboundTgId: null, lastReadTgId: 500n }))).toBe('new');
  });

  it('only «new» rings — that is the whole of the owner’s complaint', () => {
    expect(chatNeedsAnswer('new')).toBe(true);
    expect(chatNeedsAnswer('seen')).toBe(false);
    expect(chatNeedsAnswer('answered')).toBe(false);
  });
});
