import { describe, expect, it } from 'vitest';
import { Api, helpers } from 'telegram';
import { peerFromChat, classifyDialog, type ClientPhones } from '@/modules/wms/crm/telegram-import';

/**
 * Which end of a message is the CLIENT — pinned against the real library.
 *
 * This is the one test in the suite that imports `telegram` itself, and it
 * earns it: the bug it exists for lives entirely in GramJS's own semantics,
 * and no hand-written fake could have shown it.
 *
 * The live listener first derived the peer from `message.getSender()`. That is
 * correct for an INCOMING private message and silently wrong for an outgoing
 * one — `Message.init` (tl/custom/message.js) sets `senderId` only when
 * `post || (!out && peerId instanceof PeerUser)`, so a message the manager
 * SENDS, in a private chat, with no `fromId`, has no sender at all. The
 * listener therefore saw `null`, decided "not a private chat", and dropped it.
 *
 * The visible symptom would have been the worst kind: messages ARE arriving,
 * the bridge says "connected", and only the manager's own half of every
 * conversation is quietly missing — noticed weeks later by somebody reading a
 * thread and wondering what we answered.
 *
 * `peerId` is the right end for both directions: for a private chat it is the
 * OTHER party on an incoming message and the RECIPIENT on an outgoing one,
 * which is the same person either way — the dialog.
 */

const CLIENT_TG_ID = 770001;
// Through the library's own helper rather than `big-integer` directly: that
// package is a transitive dependency of `telegram` and this repo does not
// declare it, so importing it works until somebody prunes the store.
const big = (n: number) => helpers.returnBigInt(n);

const message = (over: { out?: boolean; fromId?: Api.TypePeer }) =>
  new Api.Message({
    id: 1,
    peerId: new Api.PeerUser({ userId: big(CLIENT_TG_ID) }),
    date: 1784000000,
    message: 'Salom',
    ...over,
  });

describe('GramJS, on which end of a private message the sender is', () => {
  it('gives a sender for an INCOMING message', () => {
    const incoming = message({ out: false });
    expect(incoming.senderId?.toString()).toBe(String(CLIENT_TG_ID));
  });

  it('gives NO sender for an OUTGOING one — the bug this test exists for', () => {
    const outgoing = message({ out: true });
    // Nothing to resolve. A listener reading the sender here gets null and,
    // with no better information, concludes the chat is not private.
    expect(outgoing.senderId).toBeUndefined();
  });

  it('but always gives the chat, and the chat is the client in both directions', () => {
    expect(message({ out: false }).chatId?.toString()).toBe(String(CLIENT_TG_ID));
    expect(message({ out: true }).chatId?.toString()).toBe(String(CLIENT_TG_ID));
    expect(message({ out: true }).isPrivate).toBe(true);
  });
});

const CLIENTS: ClientPhones[] = [
  { id: 'c-777', clientCode: 'GS777', phones: ['+998901234567'] },
];

const chat = () =>
  new Api.User({
    id: big(CLIENT_TG_ID),
    phone: '998901234567',
    firstName: 'Sardor',
    bot: false,
    accessHash: big(1),
  });

describe('reducing a chat to the four facts that decide', () => {
  it('reads a private chat as the client it is', () => {
    const peer = peerFromChat(chat());
    expect(peer.id).toBe(BigInt(CLIENT_TG_ID));
    expect(peer.phone).toBe('998901234567');
    expect(peer.isPrivate).toBe(true);
    expect(peer.isBot).toBe(false);
    // And so the message is kept — whichever direction it went.
    expect(classifyDialog(peer, CLIENTS)).toEqual({
      keep: true,
      clientId: 'c-777',
      clientCode: 'GS777',
    });
  });

  it('reads a group or channel as not private', () => {
    const group = new Api.Chat({
      id: big(500),
      title: 'Yiwu agents',
      participantsCount: 12,
      date: 0,
      version: 1,
      photo: new Api.ChatPhotoEmpty(),
    });
    expect(peerFromChat(group).isPrivate).toBe(false);
    expect(classifyDialog(peerFromChat(group), CLIENTS)).toEqual({
      keep: false,
      reason: 'not_private',
    });
  });

  it('reads a bot as a bot', () => {
    const bot = new Api.User({ id: big(9), bot: true, accessHash: big(1) });
    expect(peerFromChat(bot).isBot).toBe(true);
  });

  it('survives a chat Telegram would not resolve', () => {
    // getChat() can return undefined. It must not throw inside the handler —
    // one unresolvable message would otherwise be a thrown error per event.
    const peer = peerFromChat(undefined);
    expect(peer.isPrivate).toBe(false);
    expect(classifyDialog(peer, CLIENTS).keep).toBe(false);
  });
});
