import { describe, expect, it } from 'vitest';
import {
  bookIsStale,
  bridgeState,
  decideIncoming,
  isClientVerdict,
  newBook,
  secondsBehind,
  shouldRefreshOnMiss,
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

  it('refuses a peer whose number Telegram will not show us', () => {
    expect(decideIncoming(peer({ phone: null }), msg(), CLIENTS)).toEqual({
      store: false,
      reason: 'no_phone',
    });
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
