import { describe, expect, it } from 'vitest';
import {
  bookIsStale,
  bridgeState,
  decideIncoming,
  isClientVerdict,
  newBook,
  secondsBehind,
  shouldRefreshOnMiss,
  switchDecides,
  BOOK_MISS_COOLDOWN_MS,
  BOOK_STALE_MS,
  LIVE_WINDOW_S,
} from '@/modules/wms/crm/telegram-live';
import type { ChatRule, ClientPhones, DialogPeer } from '@/modules/wms/crm/telegram-import';

const CLIENTS: ClientPhones[] = [
  { id: 'c-777', clientCode: 'GS777', phones: ['+998901234567'] },
  { id: 'c-555', clientCode: 'GS555', phones: ['998 90 765 43 21'] },
];

const peer = (over: Partial<DialogPeer> = {}): DialogPeer => ({
  id: 42n,
  phone: '+998901234567',
  isPrivate: true,
  isBot: false,
  ...over,
});

const msg = (over: Partial<{ id: number; message: string | null; date: number; media: unknown }> = {}) => ({
  id: 1001,
  message: 'Yuk keldimi?',
  // 20.07.2026 — SECONDS, which is what Telegram sends.
  date: 1784000000,
  ...over,
});

describe('deciding one live message', () => {
  it('stores a client message and says which client', () => {
    const v = decideIncoming(peer(), msg(), CLIENTS);
    expect(v.store).toBe(true);
    // `store: true` is a union of three since round 82 — a known client, a
    // stranger a work account turns into a lead, and a chat attached to a
    // lead by hand — so «it stored something» does not say WHICH. One guard
    // answers that, and it lives beside the type so the next variant cannot
    // quietly break these lines (#591).
    if (!isClientVerdict(v)) throw new Error('unreachable');
    expect(v.clientId).toBe('c-777');
    expect(v.row.direction).toBe('in');
    expect(v.row.body).toBe('Yuk keldimi?');
    // Seconds, not milliseconds — the whole thread files under 1970 otherwise.
    expect(v.row.sentAt.getUTCFullYear()).toBe(2026);
  });

  it('asks about a stranger on a PERSONAL account, and stores not one word', () => {
    // Round 79 sharpened this promise rather than dropping it. A stranger on
    // a personal number is now a QUESTION — so the verdict has to carry who
    // to ask ABOUT, because a tray cannot offer an anonymous row. What it
    // must never carry is the MESSAGE: until somebody answers, nothing of
    // the conversation exists anywhere.
    const stranger = peer({ phone: '+998900000000', firstName: 'Dilshod' });
    const v = decideIncoming(stranger, msg({ message: 'Salom, yuk bormi?' }), CLIENTS);
    expect(v).toEqual({
      store: false,
      ask: true,
      peerId: 42n,
      phone: '+998900000000',
      title: 'Dilshod',
    });
    expect(
      JSON.stringify(v, (_k, value) => (typeof value === 'bigint' ? value.toString() : value)),
    ).not.toContain('Salom');
    expect(v).not.toHaveProperty('row');
  });

  it('opens a lead for the same stranger on a WORK account', () => {
    const v = decideIncoming(
      peer({ phone: '+998900000000', firstName: 'Dilshod' }),
      msg({ message: 'Salom, yuk bormi?' }),
      CLIENTS,
      new Map(),
      true,
    );
    expect(v.store).toBe(true);
    expect(v).toMatchObject({ openLead: true, peer: { phone: '+998900000000' } });
  });

  it('stores onto the lead somebody attached, on a PERSONAL account', () => {
    // Round 82. Without the rule this peer is a stranger on a personal
    // number, so the previous line of this file is the control: the same
    // call, one map entry apart, is a question instead of a message.
    const stranger = peer({ phone: '+998900000000', firstName: 'Dilshod' });
    const attached = new Map<bigint, ChatRule>([
      [
        stranger.id,
        {
          peerId: stranger.id,
          decision: 'include',
          clientId: null,
          clientCode: null,
          leadId: 'lead-1',
        },
      ],
    ]);
    const v = decideIncoming(stranger, msg({ message: 'Yuk bormi?' }), CLIENTS, attached);
    expect(v).toMatchObject({ store: true, leadId: 'lead-1' });
    // …and it is NOT the client verdict, so nothing downstream can read a
    // clientId off it.
    expect(isClientVerdict(v)).toBe(false);
  });

  it('will not let a rule turn Saved Messages into a lead', () => {
    // `isSelf` outranks every decision anybody could write down — the same
    // ordering `classifyWithRules` keeps, restated where the lead branch now
    // sits ahead of it.
    const self = peer({ isSelf: true });
    const attached = new Map<bigint, ChatRule>([
      [self.id, { peerId: self.id, decision: 'include', clientId: null, clientCode: null, leadId: 'lead-1' }],
    ]);
    expect(decideIncoming(self, msg(), CLIENTS, attached)).toEqual({
      store: false,
      reason: 'self',
    });
  });

  it("never keeps Telegram's own service chat (777000) — not by number, not by any rule, not on a work account", () => {
    // Its lines are login codes and account notices. A kept chat is one the AI
    // sotuvchi reads, so a login code would reach a model's context and a card.
    // The number is the client's ON PURPOSE: the book is matched on numbers.
    const service = peer({ id: 777000n, phone: '+998901234567' });
    expect(decideIncoming(service, msg({ message: 'Login code: 12345' }), CLIENTS)).toEqual({ store: false, reason: 'service' });
    expect(decideIncoming(service, msg(), CLIENTS, new Map(), true)).toEqual({ store: false, reason: 'service' });
    const asClient = new Map<bigint, ChatRule>([
      [service.id, { peerId: service.id, decision: 'include', clientId: 'c-777', clientCode: 'GS777', leadId: null }],
    ]);
    expect(decideIncoming(service, msg(), CLIENTS, asClient)).toEqual({ store: false, reason: 'service' });
    const asLead = new Map<bigint, ChatRule>([
      [service.id, { peerId: service.id, decision: 'include', clientId: null, clientCode: null, leadId: 'lead-1' }],
    ]);
    expect(decideIncoming(service, msg(), CLIENTS, asLead)).toEqual({ store: false, reason: 'service' });
    // A GROUP whose number reads the same is a group, judged as one.
    expect(decideIncoming(peer({ id: 777000n, isPrivate: false }), msg(), CLIENTS)).toMatchObject({ store: false, reason: 'not_private' });
  });

  it('refuses a peer whose number Telegram will not show us', () => {
    expect(decideIncoming(peer({ phone: null }), msg(), CLIENTS)).toEqual({
      store: false,
      reason: 'no_phone',
    });
  });

  it('opens a lead for a hidden number on a WORK account — by the chat, with no phone (his «1 a», 2026-10-29)', () => {
    const hidden = peer({ id: 5512345678n, phone: null, firstName: 'Dilshod' });
    const v = decideIncoming(hidden, msg({ message: 'Salom, yuk bormi?' }), CLIENTS, new Map(), true);
    expect(v).toMatchObject({ store: true, openLead: true, peer: { peerId: 5512345678n, phone: null, title: 'Dilshod' } });
    if (!v.store) throw new Error('unreachable');
    expect(v.row.body).toBe('Salom, yuk bormi?');
    expect(isClientVerdict(v)).toBe(false);
    // The same line on a PERSONAL account stays passed over — the control.
    expect(decideIncoming(hidden, msg(), CLIENTS, new Map(), false)).toEqual({ store: false, reason: 'no_phone' });
    // An empty line opens nothing: a service entry is not a first contact.
    expect(decideIncoming(hidden, msg({ message: '', media: undefined }), CLIENTS, new Map(), true)).toEqual({ store: false, reason: 'empty' });
  });

  it('a hidden number on a work account is only ever a PERSON — never 777000, Saved Messages, a bot or a group', () => {
    // `classifyDialog` asks these before it looks at the phone, so the
    // widening cannot reach them however the peer looks.
    const work = (over: Partial<DialogPeer>) => decideIncoming(peer({ phone: null, ...over }), msg(), CLIENTS, new Map(), true);
    expect(work({ id: 777000n })).toEqual({ store: false, reason: 'service' });
    expect(work({ isSelf: true })).toEqual({ store: false, reason: 'self' });
    expect(work({ isBot: true })).toEqual({ store: false, reason: 'is_bot' });
    expect(work({ isPrivate: false })).toEqual({ store: false, reason: 'not_private' });
    // …and a «never» somebody wrote down outranks the switch.
    const excluded = new Map<bigint, ChatRule>([[42n, { peerId: 42n, decision: 'exclude', clientId: null, clientCode: null, leadId: null }]]);
    expect(decideIncoming(peer({ phone: null }), msg(), CLIENTS, excluded, true)).toEqual({ store: false, reason: 'excluded' });
  });

  it('the switch decides a hidden number too, so its line asks the switch’s clock (`switchDecides`)', () => {
    const row = { peerId: 1n } as never;
    expect(switchDecides({ store: false, reason: 'no_phone' })).toBe(true);
    expect(switchDecides({ store: false, ask: true, peerId: 1n, phone: '1', title: 'A' })).toBe(true);
    expect(switchDecides({ store: true, openLead: true, peer: { peerId: 1n, phone: null, title: 'A' }, row })).toBe(true);
    // Nothing the switch could change: a client, a lead a chat is already bound to — a person's,
    // a door's or the listener's own, which the switch no longer decides (the switch governs NEW
    // strangers only, 2026-10-29 review) — a refusal that is not about acquaintance.
    expect(switchDecides({ store: true, clientId: 'c', clientCode: 'GS1', row })).toBe(false);
    expect(switchDecides({ store: true, leadId: 'l', row })).toBe(false);
    for (const reason of ['excluded', 'is_bot', 'self', 'service', 'not_private', 'empty'] as const) {
      expect(switchDecides({ store: false, reason }), reason).toBe(false);
    }
  });

  it('none of Telegram’s own accounts becomes a lead on a work number — 489000, «Replies», a `support` flag, a round-thousand id (2026-10-29 review)', () => {
    // Before his «1 a» a phoneless chat was refused everywhere, so 777000 was
    // the only official account a work number could ever have kept. Now a
    // hidden number is a lead — and «Verification Codes» carries a bank's
    // login code.
    const work = (over: Partial<DialogPeer>) =>
      decideIncoming(peer({ phone: null, firstName: 'Verification Codes', ...over }), msg({ message: 'Your code for ExampleBank: 482913' }), CLIENTS, new Map(), true);
    for (const id of [777000n, 489000n, 1271266957n, 333000n]) expect(work({ id }), String(id)).toEqual({ store: false, reason: 'service' });
    expect(work({ id: 5512345678n, isOfficial: true })).toEqual({ store: false, reason: 'service' });
    // …nor by a rule a person wrote down about it.
    const rule = new Map<bigint, ChatRule>([[489000n, { peerId: 489000n, decision: 'include', clientId: null, clientCode: null, leadId: 'l-1' }]]);
    expect(decideIncoming(peer({ id: 489000n, phone: null }), msg(), CLIENTS, rule, true)).toEqual({ store: false, reason: 'service' });
    // The bound is the convention's, not every id that ends in 000: an ordinary account stays a person.
    expect(work({ id: 5512345000n })).toMatchObject({ store: true, openLead: true });
    // A visible number of an official account is no client either, whatever the book holds.
    expect(decideIncoming(peer({ id: 489000n }), msg(), CLIENTS, new Map(), true)).toEqual({ store: false, reason: 'service' });
  });

  it('the listener’s own lead binding stands while its lead is open, until the book claims the chat — whatever the switch says (2026-10-29 reviews)', () => {
    const bound = (over: Partial<ChatRule> = {}) =>
      new Map<bigint, ChatRule>([[42n, { peerId: 42n, decision: 'include', clientId: null, clientCode: null, leadId: 'l-1', machine: true, leadOpen: true, ...over }]]);
    const hidden = peer({ phone: null, firstName: 'Dilshod' });
    // Work number, open lead, hidden number: the binding files it.
    expect(decideIncoming(hidden, msg(), CLIENTS, bound(), true)).toEqual({ store: true, leadId: 'l-1', row: expect.anything() });
    // The switch turned back to «Shaxsiy raqam» governs NEW strangers only: the chat it already
    // keeps stays on its lead — the first cut passed it over, and nobody was ever asked about it.
    expect(decideIncoming(hidden, msg(), CLIENTS, bound(), false)).toEqual({ store: true, leadId: 'l-1', row: expect.anything() });
    expect(decideIncoming(peer({ phone: '+998935550000' }), msg(), CLIENTS, bound(), false)).toMatchObject({ store: true, leadId: 'l-1' });
    // …and on either number a closed lead is no binding: decided as a stranger, by the switch.
    expect(decideIncoming(hidden, msg(), CLIENTS, bound({ leadOpen: false }), false)).toEqual({ store: false, reason: 'no_phone' });
    // A closed lead is decided again: a lost lead writing again is a new enquiry.
    expect(decideIncoming(hidden, msg(), CLIENTS, bound({ leadOpen: false }), true)).toMatchObject({ store: true, openLead: true, peer: { phone: null } });
    // The number now shows and it is a client's: the client, and the binding retired with it.
    const v = decideIncoming(peer(), msg(), CLIENTS, bound(), true);
    expect(v).toMatchObject({ store: true, clientId: 'c-777', retiresMachineRule: true });
    expect(isClientVerdict(v)).toBe(true);
    // …on a personal number too: a client is kept on any account.
    expect(decideIncoming(peer(), msg(), CLIENTS, bound(), false)).toMatchObject({ clientId: 'c-777', retiresMachineRule: true });
    // A visible number nobody's book has: still the lead it was bound to — no second card.
    expect(decideIncoming(peer({ phone: '+998935550000' }), msg(), CLIENTS, bound(), true)).toMatchObject({ store: true, leadId: 'l-1' });
    // A PERSON's lead binding is an answer and outranks all three, as it always has.
    const person = bound({ machine: false });
    expect(decideIncoming(hidden, msg(), CLIENTS, person, false)).toEqual({ store: true, leadId: 'l-1', row: expect.anything() });
    expect(decideIncoming(peer(), msg(), CLIENTS, person, true)).toMatchObject({ store: true, leadId: 'l-1' });
    expect(decideIncoming(peer(), msg(), CLIENTS, person, true)).not.toHaveProperty('retiresMachineRule');
  });

  it('refuses groups and bots', () => {
    expect(decideIncoming(peer({ isPrivate: false }), msg(), CLIENTS).store).toBe(false);
    expect(decideIncoming(peer({ isBot: true }), msg(), CLIENTS)).toEqual({
      store: false,
      reason: 'is_bot',
    });
  });

  it('tells a service entry apart from a refusal', () => {
    // A client, but nothing in the message: "call ended", a pin marker. Not
    // stored, and NOT counted as a privacy refusal — different problems.
    const v = decideIncoming(peer(), msg({ message: '', media: undefined }), CLIENTS);
    expect(v).toEqual({ store: false, reason: 'empty' });
  });

  it('keeps a photo with no caption', () => {
    const v = decideIncoming(peer(), msg({ message: '', media: { photo: true } }), CLIENTS);
    expect(v.store).toBe(true);
    if (!v.store) throw new Error('unreachable');
    expect(v.row.hasMedia).toBe(true);
    expect(v.row.body).toBeNull();
  });

  it('matches a number written the way the client book happens to hold it', () => {
    // GS555 is stored as '998 90 765 43 21'; Telegram sends '998907654321'.
    const v = decideIncoming(peer({ phone: '998907654321' }), msg(), CLIENTS);
    expect(v.store).toBe(true);
    if (!isClientVerdict(v)) throw new Error('unreachable');
    expect(v.clientCode).toBe('GS555');
  });
});

describe('the client book under a long-lived connection', () => {
  const T0 = 1_800_000_000_000;

  it('goes stale on the clock', () => {
    const book = newBook(CLIENTS, T0);
    expect(bookIsStale(book, T0 + BOOK_STALE_MS - 1)).toBe(false);
    expect(bookIsStale(book, T0 + BOOK_STALE_MS)).toBe(true);
  });

  it('reloads when a stranger writes, so a client added this morning lands', () => {
    const book = newBook(CLIENTS, T0);
    expect(shouldRefreshOnMiss(book, T0 + BOOK_MISS_COOLDOWN_MS)).toBe(true);
  });

  it('does not reload for a book that was just read', () => {
    // The common case is an evening of messages from people who are not
    // clients; that must not become a query per message.
    const book = newBook(CLIENTS, T0);
    expect(shouldRefreshOnMiss(book, T0 + 1_000)).toBe(false);
  });

  it('rate-limits the miss reload', () => {
    const book = { ...newBook(CLIENTS, T0), missRefreshedAt: T0 + BOOK_MISS_COOLDOWN_MS };
    const justAfter = T0 + BOOK_MISS_COOLDOWN_MS + 1;
    expect(shouldRefreshOnMiss(book, justAfter)).toBe(false);
    expect(shouldRefreshOnMiss(book, T0 + 2 * BOOK_MISS_COOLDOWN_MS + 1)).toBe(true);
  });
});

describe('what the screen says about the bridge', () => {
  const NOW = new Date('2026-07-28T10:00:00Z');
  const ago = (s: number) => new Date(NOW.getTime() - s * 1000);

  it('measures how far behind it is', () => {
    expect(secondsBehind(ago(45), NOW)).toBe(45);
    expect(secondsBehind(null, NOW)).toBeNull();
  });

  it('is live inside the window and stale outside it', () => {
    expect(bridgeState({ status: 'active', lastSeenAt: ago(LIVE_WINDOW_S) }, NOW)).toBe('live');
    expect(bridgeState({ status: 'active', lastSeenAt: ago(LIVE_WINDOW_S + 1) }, NOW)).toBe('stale');
  });

  it('tells a configured account that never ran from a dead one', () => {
    // Different sentences on the screen: one needs starting, the other needs
    // looking at.
    expect(bridgeState({ status: 'active', lastSeenAt: null }, NOW)).toBe('never');
  });

  it('lets the status outrank the clock', () => {
    // Otherwise a session Telegram itself ended reads as "stale", and somebody
    // spends the afternoon restarting a process that cannot start.
    expect(bridgeState({ status: 'signed_out', lastSeenAt: ago(5) }, NOW)).toBe('signed_out');
    expect(bridgeState({ status: 'stopped', lastSeenAt: ago(5) }, NOW)).toBe('stopped');
  });
});
