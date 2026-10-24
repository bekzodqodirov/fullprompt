import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** An alarm's drain kick would start pg-boss in the test process; the ROW is what is asserted. */
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => {}),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  agentConversations,
  clients,
  notifications,
  roles,
  tgChatRules,
  tgMessageFlags,
  tgMessages,
  tgPeerPulls,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { Api, helpers } from 'telegram';
import { isNewestInbound, noteStranger, stampPeerTyping, strangerUserOf } from '@/modules/wms/agent/listener-hooks';
import {
  claimPeerPull,
  finishPeerPull,
  newestInboundSince,
  releaseStalePulls,
} from '@/modules/wms/agent/peer-pulls';
import { announceSessionDeadToOthers } from '@/modules/wms/crm/account-alarm';
import { markAutoSent, markDeleted } from '@/modules/wms/crm/message-flags';

/**
 * What the listener's event handlers write for the agent and for every
 * account (spec §17.3.1, §17.11, review leak-8, ban-4, ban-10, regression-14):
 * each against a real database, on this file's own people and chats.
 */

const STAMP = Date.now();
const BASE = BigInt(STAMP) * 1000n;
let seq = 0n;
const next = () => BASE + ++seq;

const madeUsers: string[] = [];
let managerId: string;
let colleagueId: string;
let superId: string;
let clientId: string;

async function person(tag: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      phone: `+99896${String(STAMP + madeUsers.length).slice(-7)}`,
      fullName: `Agent hooks ${tag} ${STAMP}`,
      passwordHash: 'x',
    })
    .returning({ id: users.id });
  madeUsers.push(u!.id);
  return u!.id;
}

async function message(input: {
  manager?: string;
  peer: bigint;
  id: bigint;
  direction?: 'in' | 'out';
  sentAt?: Date;
}): Promise<string> {
  const [row] = await db
    .insert(tgMessages)
    .values({
      clientId,
      managerUserId: input.manager ?? managerId,
      peerId: input.peer,
      tgMessageId: input.id,
      direction: input.direction ?? 'in',
      body: 'Salom',
      sentAt: input.sentAt ?? new Date(),
    })
    .returning({ id: tgMessages.id });
  return row!.id;
}

beforeAll(async () => {
  managerId = await person('manager');
  colleagueId = await person('colleague');
  superId = await person('super');
  const superRole = await db.query.roles.findFirst({ where: eq(roles.code, 'super_admin') });
  await db.insert(userRoles).values({ userId: superId, roleId: superRole!.id });
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `AH${String(STAMP).slice(-8)}`, name: `Agent hooks ${STAMP}` })
    .returning({ id: clients.id });
  clientId = c!.id;
});

/** The names the session alarm carries — how this file finds the copies the REAL super_admins got. */
const SELLER = `Sotuvchi ${STAMP}`;
const OWNER = `Egasi ${STAMP}`;

afterAll(async () => {
  await db.delete(notifications).where(inArray(notifications.userId, madeUsers));
  await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.type, 'TelegramSessionEnded'),
        sql`(${notifications.payload}->>'text' LIKE ${`%${SELLER}%`} OR ${notifications.payload}->>'text' LIKE ${`%${OWNER}%`})`,
      ),
    );
  await db.delete(tgPeerPulls).where(inArray(tgPeerPulls.managerUserId, madeUsers));
  await db.delete(agentConversations).where(inArray(agentConversations.managerUserId, madeUsers));
  await db.delete(tgChatRules).where(inArray(tgChatRules.managerUserId, madeUsers));
  await db.delete(tgMessages).where(inArray(tgMessages.managerUserId, madeUsers));
  await db.delete(clients).where(eq(clients.id, clientId));
  for (const id of madeUsers) {
    await db
      .delete(users)
      .where(eq(users.id, id))
      .catch(() => db.update(users).set({ active: false }).where(eq(users.id, id)));
  }
  await pgClient.end();
});

describe('deleted for both sides (leak-8)', () => {
  it('marks this account’s rows by Telegram id, never a colleague’s with the same number', async () => {
    const id = next();
    const mine = await message({ peer: next(), id });
    // The same Telegram message id in a COLLEAGUE's box is a different message.
    const theirs = await message({ manager: colleagueId, peer: next(), id });
    expect(await markDeleted(managerId, [id, next()])).toBe(1);
    const flags = await db.select().from(tgMessageFlags).where(inArray(tgMessageFlags.messageId, [mine, theirs]));
    expect(flags.map((f) => f.messageId)).toEqual([mine]);
    expect(flags[0]!.deletedAt).not.toBeNull();
  });

  it('the first delete time stands when Telegram says it again', async () => {
    const id = next();
    const row = await message({ peer: next(), id });
    await markDeleted(managerId, [id]);
    const [first] = await db.select().from(tgMessageFlags).where(eq(tgMessageFlags.messageId, row));
    await new Promise((r) => setTimeout(r, 15));
    await markDeleted(managerId, [id]);
    const [again] = await db.select().from(tgMessageFlags).where(eq(tgMessageFlags.messageId, row));
    expect(again!.deletedAt!.getTime()).toBe(first!.deletedAt!.getTime());
  });

  it('a delete in a chat never kept marks nothing', async () => {
    expect(await markDeleted(managerId, [next()])).toBe(0);
    expect(await markDeleted(managerId, [])).toBe(0);
  });
});

describe('the customer’s own robot (ban-4)', () => {
  it('flags a row, and a later delete keeps the flag', async () => {
    const id = next();
    const row = await message({ peer: next(), id });
    await markAutoSent(row);
    await markDeleted(managerId, [id]);
    const [flag] = await db.select().from(tgMessageFlags).where(eq(tgMessageFlags.messageId, row));
    expect(flag!.autoSent).toBe(true);
    expect(flag!.deletedAt).not.toBeNull();
  });
});

describe('the customer is typing (fit-9)', () => {
  it('only for a chat this system keeps', async () => {
    const stranger = next();
    expect(await stampPeerTyping(managerId, stranger)).toBe(false);
    const rows = await db
      .select()
      .from(agentConversations)
      .where(and(eq(agentConversations.managerUserId, managerId), eq(agentConversations.peerId, stranger)));
    expect(rows, 'a friend’s typing names nobody').toHaveLength(0);

    const kept = next();
    await message({ peer: kept, id: next() });
    expect(await stampPeerTyping(managerId, kept)).toBe(true);
    expect(await stampPeerTyping(managerId, kept), 'again, in place').toBe(true);
    const [conv] = await db
      .select()
      .from(agentConversations)
      .where(and(eq(agentConversations.managerUserId, managerId), eq(agentConversations.peerId, kept)));
    expect(conv!.peerTypingAt).not.toBeNull();
  });
});

describe('an edit of the newest line (regression-10)', () => {
  it('is the newest live inbound; an older line, a reply of ours and a deleted line are not', async () => {
    const peer = next();
    const older = next();
    const newest = next();
    await message({ peer, id: older });
    await message({ peer, id: newest });
    const ours = next();
    await message({ peer, id: ours, direction: 'out' });
    expect(await isNewestInbound(managerId, peer, newest)).toBe(true);
    expect(await isNewestInbound(managerId, peer, older)).toBe(false);
    expect(await isNewestInbound(managerId, peer, ours)).toBe(false);
    await markDeleted(managerId, [newest]);
    // The customer took the newest back: the older line is the question again.
    expect(await isNewestInbound(managerId, peer, older)).toBe(true);
  });
});

describe('a stranger on the agent owner’s account (his Q18 ⭐, review fit-7)', () => {
  const conv = async (peer: bigint) =>
    (
      await db
        .select()
        .from(agentConversations)
        .where(and(eq(agentConversations.managerUserId, managerId), eq(agentConversations.peerId, peer)))
    )[0];
  const rule = async (peer: bigint) =>
    (await db.select().from(tgChatRules).where(and(eq(tgChatRules.managerUserId, managerId), eq(tgChatRules.peerId, peer))))[0];

  it('reads the two flags off the user gramjs hands over — and nothing off a group', () => {
    const id = helpers.returnBigInt('42');
    expect(strangerUserOf(new Api.User({ id, contact: true }))).toEqual({ contact: true, deleted: false });
    expect(strangerUserOf(new Api.User({ id, mutualContact: true }))).toEqual({ contact: true, deleted: false });
    expect(strangerUserOf(new Api.User({ id, deleted: true }))).toEqual({ contact: false, deleted: true });
    expect(strangerUserOf(new Api.User({ id }))).toEqual({ contact: false, deleted: false });
    expect(strangerUserOf(new Api.Chat({ id, title: 'g', photo: new Api.ChatPhotoEmpty(), participantsCount: 2, date: 1, version: 1 }))).toBeNull();
    expect(strangerUserOf(undefined)).toBeNull();
  });

  it('a hidden number from a real non-contact gets a pending rule with no phone and no text — once', async () => {
    const peer = next();
    const user = { contact: false, deleted: false };
    expect(await noteStranger({ managerUserId: managerId, peerId: peer, title: 'Anvar', verdict: 'no_phone', user })).toEqual({
      contactStamped: true,
      ruleAdded: true,
    });
    const r = await rule(peer);
    expect(r).toMatchObject({ decision: 'pending', peerTitle: 'Anvar', peerPhone: null, clientId: null, leadId: null });
    expect((await conv(peer))!.peerContact).toBe(false);
    // Not a word of what he wrote.
    expect(await db.select().from(tgMessages).where(eq(tgMessages.peerId, peer))).toHaveLength(0);
    // The second line: nothing new, the rule as it was.
    expect(await noteStranger({ managerUserId: managerId, peerId: peer, title: 'Anvar 2', verdict: 'no_phone', user })).toEqual({
      contactStamped: false,
      ruleAdded: false,
    });
    expect((await rule(peer))!.peerTitle).toBe('Anvar');
  });

  it('a rule somebody already decided is never touched', async () => {
    const peer = next();
    await db.insert(tgChatRules).values({ managerUserId: managerId, peerId: peer, decision: 'exclude', peerTitle: 'Do‘stim' });
    const out = await noteStranger({
      managerUserId: managerId,
      peerId: peer,
      title: 'Boshqa ism',
      verdict: 'no_phone',
      user: { contact: false, deleted: false },
    });
    expect(out.ruleAdded).toBe(false);
    expect(await rule(peer)).toMatchObject({ decision: 'exclude', peerTitle: 'Do‘stim' });
  });

  it('a contact is stamped as one and gets no rule; a visible-phone stranger is stamped and left to the tray', async () => {
    const friend = next();
    expect(
      await noteStranger({ managerUserId: managerId, peerId: friend, title: 'Do‘st', verdict: 'no_phone', user: { contact: true, deleted: false } }),
    ).toEqual({ contactStamped: true, ruleAdded: false });
    expect((await conv(friend))!.peerContact).toBe(true);
    expect(await rule(friend)).toBeUndefined();

    const asked = next();
    expect(
      await noteStranger({ managerUserId: managerId, peerId: asked, title: 'Yangi', verdict: 'ask', user: { contact: false, deleted: false } }),
    ).toEqual({ contactStamped: true, ruleAdded: false });
    expect((await conv(asked))!.peerContact).toBe(false);
    // He saves the number later: the next line says so.
    await noteStranger({ managerUserId: managerId, peerId: asked, title: 'Yangi', verdict: 'ask', user: { contact: true, deleted: false } });
    expect((await conv(asked))!.peerContact).toBe(true);
  });

  it('a deleted account gets nothing at all', async () => {
    const gone = next();
    expect(
      await noteStranger({ managerUserId: managerId, peerId: gone, title: 'Deleted Account', verdict: 'no_phone', user: { contact: false, deleted: true } }),
    ).toEqual({ contactStamped: false, ruleAdded: false });
    expect(await conv(gone)).toBeUndefined();
    expect(await rule(gone)).toBeUndefined();
  });
});

describe('one-peer pulls (§17.11, regression-14)', () => {
  it('claims one at a time, oldest first, and a stale claim is owed again', async () => {
    const a = next();
    const b = next();
    await db.insert(tgPeerPulls).values([
      { managerUserId: managerId, peerId: a, requestedBy: managerId, requestedAt: new Date(Date.now() - 60_000) },
      { managerUserId: managerId, peerId: b, requestedBy: managerId },
    ]);
    const first = await claimPeerPull(managerId);
    expect(first?.peerId).toBe(a);
    const second = await claimPeerPull(managerId);
    expect(second?.peerId).toBe(b);
    expect(await claimPeerPull(managerId)).toBeNull();

    // The listener died mid-walk: the claim is released, the pull owed again.
    expect(await releaseStalePulls(managerId)).toBe(2);
    expect((await claimPeerPull(managerId))?.peerId).toBe(a);
    await finishPeerPull(first!.id, { storedCount: 3, error: null });
    const [done] = await db.select().from(tgPeerPulls).where(eq(tgPeerPulls.id, first!.id));
    expect(done!.doneAt).not.toBeNull();
    expect(done!.storedCount).toBe(3);
    // A finished pull is never released or claimed again.
    expect(await releaseStalePulls(managerId)).toBe(0);
  });

  it('the run goes to the newest inbound of the last day, not a deleted one', async () => {
    const peer = next();
    const since = new Date(Date.now() - 24 * 3_600_000);
    await message({ peer, id: next(), sentAt: new Date(Date.now() - 30 * 3_600_000) });
    expect(await newestInboundSince(managerId, peer, since), 'a day and more is history').toBeNull();
    const fresh = next();
    await message({ peer, id: fresh, sentAt: new Date(Date.now() - 3 * 3_600_000) });
    const later = next();
    await message({ peer, id: later, sentAt: new Date(Date.now() - 2 * 3_600_000) });
    await message({ peer, id: next(), direction: 'out' });
    expect(await newestInboundSince(managerId, peer, since)).toBe(later);
    await markDeleted(managerId, [later]);
    expect(await newestInboundSince(managerId, peer, since)).toBe(fresh);
  });
});

describe('a dead session reaches the other super_admins too (ban-10)', () => {
  it('names the manager to every super_admin, and never sends the manager a second copy', async () => {
    await announceSessionDeadToOthers(
      { id: '00000000-0000-0000-0000-000000000000', managerUserId: managerId, managerName: SELLER },
      'SESSION_REVOKED',
    );
    const rows = await db
      .select()
      .from(notifications)
      .where(and(inArray(notifications.userId, [managerId, superId]), eq(notifications.type, 'TelegramSessionEnded')));
    expect(rows.map((r) => r.userId)).toEqual([superId]);
    expect(String((rows[0]!.payload as { text?: unknown }).text)).toContain(SELLER);

    // The manager IS a super_admin (the owner's own account): still no second copy.
    await announceSessionDeadToOthers(
      { id: '00000000-0000-0000-0000-000000000000', managerUserId: superId, managerName: OWNER },
      'SESSION_REVOKED',
    );
    const own = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, superId), eq(notifications.type, 'TelegramSessionEnded')));
    expect(own).toHaveLength(1);
  });
});
