import { describe, expect, it } from 'vitest';
import {
  classifyDialog,
  classifyWithRules,
  peerTitle,
  scanVerdict,
  type ChatRule,
  type ClientPhones,
  type DialogPeer,
} from '@/modules/wms/crm/telegram-import';
import { decideIncoming } from '@/modules/wms/crm/telegram-live';

/**
 * Which chats go into the CRM once a person, not only a rule, gets to answer.
 *
 * The automatic phone match is right and incomplete in both directions, and
 * these tests are the statement of what "a person decided" is allowed to
 * override — including the cases where it must NOT.
 */

const CLIENTS: ClientPhones[] = [
  { id: 'c-777', clientCode: 'GS777', phones: ['+998901234567'] },
  { id: 'c-555', clientCode: 'GS555', phones: ['+998911111111'] },
];

const peer = (over: Partial<DialogPeer> = {}): DialogPeer => ({
  id: 42n,
  phone: null,
  isPrivate: true,
  isBot: false,
  ...over,
});

const rules = (...list: ChatRule[]) => new Map(list.map((r) => [r.peerId, r]));
const include = (peerId: bigint, clientId: string, clientCode: string): ChatRule => ({
  peerId,
  decision: 'include',
  clientId,
  clientCode,
  leadId: null,
});
const exclude = (peerId: bigint): ChatRule => ({
  peerId,
  decision: 'exclude',
  clientId: null,
  clientCode: null,
  leadId: null,
});

describe('a person overriding the automatic rule', () => {
  it('lets in a client Telegram will not show a number for', () => {
    // The 122 in the first real import: Telegram reveals a phone only to
    // CONTACTS, so a genuine client the manager never saved is invisible to
    // the automatic rule. Without this the only fix was "go save 122 contacts".
    const stranger = peer({ phone: null });
    expect(classifyDialog(stranger, CLIENTS)).toEqual({ keep: false, reason: 'no_phone' });
    expect(classifyWithRules(stranger, CLIENTS, rules(include(42n, 'c-777', 'GS777')))).toEqual({
      keep: true,
      clientId: 'c-777',
      clientCode: 'GS777',
    });
  });

  it('lets in a client writing from a second number', () => {
    const other = peer({ phone: '+998900000009' });
    expect(classifyDialog(other, CLIENTS)).toEqual({ keep: false, reason: 'not_a_client' });
    expect(classifyWithRules(other, CLIENTS, rules(include(42n, 'c-555', 'GS555'))).keep).toBe(true);
  });

  it('keeps out a chat the automatic rule WOULD have taken', () => {
    // The other direction, and the one that matters for trust: a number in the
    // client book is not a promise that its owner wants their chat in the CRM.
    const known = peer({ phone: '+998901234567' });
    expect(classifyDialog(known, CLIENTS).keep).toBe(true);
    expect(classifyWithRules(known, CLIENTS, rules(exclude(42n)))).toEqual({
      keep: false,
      reason: 'excluded',
    });
  });

  it('treats a question nobody answered as no answer at all', () => {
    // `pending` is a row a scan wrote. It must not quietly behave like a yes.
    const pending: ChatRule = {
      peerId: 42n,
      decision: 'pending',
      clientId: null,
      clientCode: null,
      leadId: null,
    };
    expect(classifyWithRules(peer({ phone: null }), CLIENTS, rules(pending))).toEqual({
      keep: false,
      reason: 'no_phone',
    });
  });

  it('applies only to the chat it was written for', () => {
    // Rules are keyed by peer. A decision about one person is not a decision
    // about the next one in the list.
    const decided = rules(exclude(42n));
    expect(classifyWithRules(peer({ id: 99n, phone: '+998901234567' }), CLIENTS, decided).keep).toBe(
      true,
    );
  });

  it('is honoured by the LIVE path and not only by the import', () => {
    // One rule, one place. A message arriving now must be judged exactly as
    // the same conversation would be when imported.
    const msg = { id: 7, message: 'Salom', date: 1784000000 };
    expect(decideIncoming(peer({ phone: null }), msg, CLIENTS).store).toBe(false);
    expect(
      decideIncoming(peer({ phone: null }), msg, CLIENTS, rules(include(42n, 'c-777', 'GS777')))
        .store,
    ).toBe(true);
  });

  it('an include with no client cannot decide anything', () => {
    // The table refuses such a row, and this is the belt to that braces: if
    // one ever existed, it must not send a message to a NULL client_id.
    const broken: ChatRule = {
      peerId: 42n,
      decision: 'include',
      clientId: null,
      clientCode: null,
      leadId: null,
    };
    expect(classifyWithRules(peer({ phone: null }), CLIENTS, rules(broken)).keep).toBe(false);
  });
});

describe('what a scan asks about', () => {
  const none = new Map<bigint, ChatRule>();

  it('does not ask about a chat that already comes in on its own', () => {
    expect(scanVerdict(peer({ phone: '+998901234567' }), CLIENTS, none)).toBe('auto');
  });

  it('asks about a private chat that is not matching', () => {
    expect(scanVerdict(peer({ phone: null }), CLIENTS, none)).toBe('ask');
    expect(scanVerdict(peer({ phone: '+998900000009' }), CLIENTS, none)).toBe('ask');
  });

  it('never asks about groups, channels or bots', () => {
    // A deliberate limit, not an oversight: a group holds people who never
    // agreed to anything, and one manager does not speak for them.
    expect(scanVerdict(peer({ isPrivate: false }), CLIENTS, none)).toBe('skip');
    expect(scanVerdict(peer({ isBot: true, phone: null }), CLIENTS, none)).toBe('skip');
  });

  it('does not ask twice about something already answered', () => {
    expect(scanVerdict(peer({ phone: null }), CLIENTS, rules(exclude(42n)))).toBe('answered');
    expect(scanVerdict(peer({ phone: null }), CLIENTS, rules(include(42n, 'c-777', 'GS777')))).toBe(
      'answered',
    );
  });

  it('asks again while the answer is still pending', () => {
    const pending: ChatRule = {
      peerId: 42n,
      decision: 'pending',
      clientId: null,
      clientCode: null,
      leadId: null,
    };
    // So a re-scan refreshes the label on a question still on the screen.
    expect(scanVerdict(peer({ phone: null }), CLIENTS, rules(pending))).toBe('ask');
  });
});

describe('the label a decision is made from', () => {
  it('prefers a real name', () => {
    expect(peerTitle(peer({ firstName: 'Sardor', lastName: 'Karimov' }))).toBe('Sardor Karimov');
    expect(peerTitle(peer({ firstName: 'Sardor' }))).toBe('Sardor');
  });

  it('falls back to a username, then to the id', () => {
    expect(peerTitle(peer({ username: 'sardor' }))).toBe('@sardor');
    // Ugly, but decidable — a blank row is a question nobody can answer.
    expect(peerTitle(peer({ id: 12345n }))).toBe('#12345');
  });
});
