import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyDialog,
  classifyWithRules,
  scanVerdict,
  peerFromChat,
  type ChatRule,
  type ClientPhones,
  type DialogPeer,
} from '@/modules/wms/crm/telegram-import';

/**
 * The findings of an adversarial pass over phases 1-4, turned into tests.
 *
 * Each one is a defect that shipped, was confirmed against the real code or
 * the real library, and would not have been caught by anything already here.
 */

const ROOT = join(__dirname, '../..');

describe('the listener actually connects', () => {
  /**
   * `connectionRetries` is a LOOP BOUND in GramJS, not a sentinel:
   * `for (attempt = 0; attempt < this._retries; attempt++)`
   * (network/MTProtoSender.js:149, fed from telegramBaseClient.js:314).
   *
   * With `-1` the body never executes, so no socket is ever opened —
   * `connect()` returns FALSE rather than throwing, and the listener then
   * carries on registering handlers and writing heartbeats for a connection
   * that does not exist. The bridge would have read "connected" for ever
   * while receiving nothing at all.
   *
   * Asserted against the source, because the failure is entirely in a number
   * and there is nothing here that can hold a socket open to prove it.
   */
  it('never asks GramJS for a negative number of connection attempts', () => {
    const src = readFileSync(join(ROOT, 'scripts/tg-listen.ts'), 'utf8');
    const match = /connectionRetries:\s*([^,\n]+)/.exec(src);
    expect(match?.[1]?.trim()).toBe('Infinity');
  });

  it('does not ignore what connect() returned', () => {
    // It reports failure by returning false. Ignoring the result is how a
    // listener ends up cheerfully doing nothing.
    const src = readFileSync(join(ROOT, 'scripts/tg-listen.ts'), 'utf8');
    expect(src).toMatch(/const connected = await client\.connect\(\)/);
    expect(src).toMatch(/connected === false/);
  });

  it('puts the account back to active on start', () => {
    // A graceful stop writes 'stopped', and nothing else wrote 'active' again
    // except a fresh login — so one restart latched the bridge as stopped for
    // ever, which ALSO made every reply unsendable (queueing refuses when the
    // bridge is not live).
    const src = readFileSync(join(ROOT, 'scripts/tg-listen.ts'), 'utf8');
    expect(src).toMatch(/markAccountActive\(account\.id\)/);
  });

  it('only beats while the link is up', () => {
    // Otherwise the heartbeat proves the PROCESS is alive, which is not the
    // question: a listener with a dead socket would read as connected.
    const src = readFileSync(join(ROOT, 'scripts/tg-listen.ts'), 'utf8');
    expect(src).toMatch(/client\.connected === false/);
  });
});

const CLIENTS: ClientPhones[] = [
  { id: 'c-777', clientCode: 'GS777', phones: ['+998901234567'] },
];

const peer = (over: Partial<DialogPeer> = {}): DialogPeer => ({
  id: 42n,
  phone: '+998901234567',
  isPrivate: true,
  isBot: false,
  ...over,
});

describe('Saved Messages is never a client conversation', () => {
  /**
   * The manager's chat with THEMSELVES carries their own number. An owner's
   * number is usually somewhere in the client book, so their private notes —
   * prices, reminders, anything they jot down — would have been filed as that
   * client's conversation and shown to everyone who can read it.
   */
  it('is refused before the client book is even consulted', () => {
    expect(classifyDialog(peer({ isSelf: true }), CLIENTS)).toEqual({
      keep: false,
      reason: 'self',
    });
  });

  it('cannot be opted into by a written rule either', () => {
    const rules = new Map<bigint, ChatRule>([
      [42n, { peerId: 42n, decision: 'include', clientId: 'c-777', clientCode: 'GS777' }],
    ]);
    // The rule beats the automatic match in both directions (#311) — but not
    // this. Nobody should be able to store their own notes as a customer's
    // conversation by pressing a button on a list.
    expect(classifyWithRules(peer({ isSelf: true }), CLIENTS, rules)).toEqual({
      keep: false,
      reason: 'self',
    });
  });

  it('is never even offered as a question', () => {
    expect(scanVerdict(peer({ isSelf: true, phone: null }), CLIENTS, new Map())).toBe('skip');
  });

  it('reads `self` off the chat Telegram gives us', () => {
    expect(peerFromChat({ id: 7n, className: 'User', self: true }).isSelf).toBe(true);
    expect(peerFromChat({ id: 7n, className: 'User' }).isSelf).toBe(false);
  });
});

describe('one phone, several client codes', () => {
  /**
   * The owner's documented reality: one person holds 777, 555 and 444 on one
   * number. `classifyDialog` takes the FIRST match, so the order of the book
   * decides which code a conversation files under — and the query had no
   * ORDER BY, which means postgres decided, differently on different days.
   *
   * The fix is in the query (`clientBook` orders by client code). What this
   * test pins is the property that makes the fix meaningful: given a stable
   * order, the answer is stable.
   */
  const shared: ClientPhones[] = [
    { id: 'c-444', clientCode: 'GS444', phones: ['+998901234567'] },
    { id: 'c-555', clientCode: 'GS555', phones: ['+998901234567'] },
    { id: 'c-777', clientCode: 'GS777', phones: ['+998901234567'] },
  ];

  it('files under the same code every time, given the same order', () => {
    const first = classifyDialog(peer(), shared);
    expect(first).toEqual({ keep: true, clientId: 'c-444', clientCode: 'GS444' });
    expect(classifyDialog(peer(), shared)).toEqual(first);
  });

  it('and a person can override it, which is the point of the rules', () => {
    // A stable wrong answer is correctable; an unstable one is not.
    const rules = new Map<bigint, ChatRule>([
      [42n, { peerId: 42n, decision: 'include', clientId: 'c-777', clientCode: 'GS777' }],
    ]);
    expect(classifyWithRules(peer(), shared, rules)).toEqual({
      keep: true,
      clientId: 'c-777',
      clientCode: 'GS777',
    });
  });
});

describe('the client book is read in a defined order', () => {
  it('asks postgres for one', () => {
    // The property above is worthless if the input order is whatever the
    // planner felt like. Asserted on the query itself, since the ordering is
    // the whole fix and it lives in SQL.
    const src = readFileSync(join(ROOT, 'src/modules/wms/crm/telegram-accounts.ts'), 'utf8');
    const book = src.slice(src.indexOf('export async function clientBook'));
    expect(book.slice(0, 400)).toMatch(/orderBy\(asc\(clients\.clientCode\)\)/);
  });
});
