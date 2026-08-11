import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { clients, tgMessages, tgOutbox, users } from '@/modules/platform/db/schema';
import {
  chatBadges,
  listConversations,
  markThreadRead,
  resolveChatStates,
} from '@/modules/wms/crm/conversations';
import { recordChatRead } from '@/modules/wms/crm/telegram-accounts';
import { unansweredChats } from '@/modules/wms/crm/unanswered';
import { salesFlowCounts } from '@/modules/wms/home/role-flows';

/**
 * «Javob kutmoqda» must be true when it says so — round 88, the owner's
 * item 6: «klient chatga nuqta qoygandur … ok yokida got it deb, shunda
 * sales manager javob bermaydi lekin warning turibti».
 *
 * The three states are decided in `crm/waiting.ts` and unit-tested there.
 * What this file proves is the wiring: that the two facts the pure rule
 * needs — how far the manager has READ and whether a reply is already on its
 * way out — actually reach it from the database, on every one of the four
 * screens that ask.
 */

const SUFFIX = String(Date.now()).slice(-7);
let peerSeq = 0;
const nextPeer = () => BigInt(Date.now()) * 1000n + BigInt((peerSeq += 1));

let actorId: string;
const madeClients: string[] = [];

/** A client whose whole conversation is one incoming message, unread. */
async function waitingClient(tag: string) {
  const [client] = await db
    .insert(clients)
    .values({
      // `clients_code_upper_check` — a client code is upper-case on every
      // label, act and payment, and the database says so.
      clientCode: `W${tag.toUpperCase()}${SUFFIX}`,
      name: `Kutmoqda ${tag} ${SUFFIX}`,
    })
    .returning();
  madeClients.push(client!.id);
  const peer = nextPeer();
  await db.insert(tgMessages).values({
    clientId: client!.id,
    managerUserId: actorId,
    peerId: peer,
    tgMessageId: 7n,
    direction: 'in',
    body: 'yuk qachon keladi?',
    sentAt: new Date('2026-06-02T09:00:00Z'),
  });
  return { id: client!.id, peer };
}

/** Does this client read as still waiting, through the list the screen uses? */
async function waitingOnList(clientId: string) {
  const rows = await listConversations({ id: actorId }, undefined, 10_000);
  return rows.find((r) => r.clientId === clientId)?.waitingOnUs;
}

beforeAll(async () => {
  const [staff] = await db.select().from(users).limit(1);
  actorId = staff!.id;
});

afterAll(async () => {
  // Leftover state in an integration file is worse than in Playwright: the
  // order is not even lexical (#380). A stray unread conversation is also a
  // number on somebody's home screen.
  if (madeClients.length > 0) {
    await db.delete(tgOutbox).where(inArray(tgOutbox.clientId, madeClients));
    await db.delete(tgMessages).where(inArray(tgMessages.clientId, madeClients));
    await db.execute(
      sql`DELETE FROM tg_chat_reads WHERE manager_user_id = ${actorId}::uuid AND peer_id > ${String(BigInt(Date.now()) * 1000n - 100_000_000n)}`,
    );
    await db.delete(clients).where(inArray(clients.id, madeClients));
  }
  await pgClient.end();
});

describe('a chat the manager has READ is no longer waiting', () => {
  it('drops the mark once Telegram says the manager opened it', async () => {
    const { id, peer } = await waitingClient('a');
    // Nobody has looked at it: this is what the alarm is for.
    expect(await waitingOnList(id)).toBe(true);

    // The manager opens the dialog on their phone. Telegram tells every
    // other device, including our listener.
    await recordChatRead({ managerUserId: actorId, peerId: peer, maxTgMessageId: 7n });

    expect(await waitingOnList(id)).toBe(false);
    // …and the funnel card badge, which asks the same question (#513).
    expect((await chatBadges({ id: actorId })).get(id)).toBe('yes');
  });

  it('keeps the mark when the read pointer is BEHIND the newest message', async () => {
    const { id, peer } = await waitingClient('b');
    // The manager read up to message 6 yesterday; 7 arrived after that.
    await recordChatRead({ managerUserId: actorId, peerId: peer, maxTgMessageId: 6n });
    expect(await waitingOnList(id)).toBe(true);
  });

  it('never moves the pointer backwards', async () => {
    const { id, peer } = await waitingClient('c');
    await recordChatRead({ managerUserId: actorId, peerId: peer, maxTgMessageId: 7n });
    // A stale update arriving late after a reconnect. Telegram delivers
    // these out of order, and honouring it would resurrect an alarm the
    // manager already dealt with.
    await recordChatRead({ managerUserId: actorId, peerId: peer, maxTgMessageId: 3n });
    expect(await waitingOnList(id)).toBe(false);
  });

  it('counts reading it on OUR screen too, and only for the chat’s own manager', async () => {
    const { id } = await waitingClient('d');
    const [stranger] = await db
      .insert(users)
      .values({
        phone: `+99893${SUFFIX}`,
        fullName: `Begona ${SUFFIX}`,
        passwordHash: 'x',
        active: false,
      })
      .returning();

    // A supervisor (round 33 seesAllTg) opens the same screen. Their glance
    // must not silence somebody else's alarm — and it does not, because the
    // rows counted are the ones whose manager IS the reader.
    await markThreadRead(id, stranger!.id);
    expect(await waitingOnList(id)).toBe(true);

    await markThreadRead(id, actorId);
    expect(await waitingOnList(id)).toBe(false);
    await db.delete(users).where(eq(users.id, stranger!.id));
  });
});

describe('a reply already on its way out is an answer', () => {
  it('clears the mark while the reply is still queued', async () => {
    const { id, peer } = await waitingClient('e');
    // The manager typed a reply in the CRM. The listener has not sent it
    // yet — and with `tg_sending_enabled` off it never will — but the
    // customer is not being ignored, which is what the alarm claims.
    await db.insert(tgOutbox).values({
      clientId: id,
      managerUserId: actorId,
      peerId: peer,
      body: 'ertaga yetib keladi',
      status: 'queued',
      queuedBy: actorId,
      queuedAt: new Date('2026-06-02T09:05:00Z'),
    });
    expect(await waitingOnList(id)).toBe(false);
  });

  it('does NOT clear it for a failed or cancelled reply', async () => {
    const { id, peer } = await waitingClient('f');
    await db.insert(tgOutbox).values({
      clientId: id,
      managerUserId: actorId,
      peerId: peer,
      body: 'ketmadi',
      status: 'failed',
      queuedBy: actorId,
      queuedAt: new Date('2026-06-02T09:05:00Z'),
    });
    // A reply that never left is exactly the case where the customer is
    // still waiting and nobody knows.
    expect(await waitingOnList(id)).toBe(true);
  });

  it('does NOT clear it for a reply queued BEFORE the client wrote', async () => {
    const { id, peer } = await waitingClient('g');
    await db.insert(tgOutbox).values({
      clientId: id,
      managerUserId: actorId,
      peerId: peer,
      body: 'salom',
      status: 'sent',
      queuedBy: actorId,
      queuedAt: new Date('2026-06-01T09:00:00Z'),
    });
    expect(await waitingOnList(id)).toBe(true);
  });
});

describe('every screen asks the same question', () => {
  it('the reminder does not ring for a chat the manager has read', async () => {
    const { id, peer } = await waitingClient('h');
    const now = new Date('2026-06-02T11:00:00Z');
    const named = async () =>
      (await unansweredChats(30, now)).some((chat) => chat.clientId === id);
    // Two hours of silence, unread: this is a real reminder.
    expect(await named()).toBe(true);

    await recordChatRead({ managerUserId: actorId, peerId: peer, maxTgMessageId: 7n });
    // The owner's «ok» case: read, deliberately not answered, and the phone
    // must stay quiet.
    expect(await named()).toBe(false);
  });

  it('the seller’s home counts the same chats the list marks', async () => {
    const before = (await salesFlowCounts(actorId, '2026-06-02')).waitingChats;
    const { id, peer } = await waitingClient('i');
    expect((await salesFlowCounts(actorId, '2026-06-02')).waitingChats).toBe(before + 1);

    await recordChatRead({ managerUserId: actorId, peerId: peer, maxTgMessageId: 7n });
    expect((await salesFlowCounts(actorId, '2026-06-02')).waitingChats).toBe(before);
    expect(await waitingOnList(id)).toBe(false);
  });

  it('answers for every row, and asks nothing about an empty screen', async () => {
    // The two facts are fetched with two GROUPED queries over the rows
    // already on screen, never one query per row (#432/#526) — so a page
    // with nothing on it must cost nothing at all.
    expect((await resolveChatStates([])).size).toBe(0);

    const seeds = Array.from({ length: 25 }, (_, n) => ({
      clientId: madeClients[0]!,
      managerUserId: actorId,
      peerId: nextPeer(),
      tgMessageId: BigInt(n + 1),
      direction: 'in',
      sentAt: new Date('2026-06-02T09:00:00Z'),
    }));
    const states = await resolveChatStates(seeds);
    expect(states.size).toBe(25);
    expect([...states.values()].every((state) => state === 'new')).toBe(true);
  });
});
