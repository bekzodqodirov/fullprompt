import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  clients,
  events,
  leads,
  roles,
  tgChatRules,
  tgMessages,
  tgPeerIndex,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { leadForChat, rekeyLeadChats } from '@/modules/wms/crm/chat-lead';
import {
  indexPeers,
  managersWhoTalkedTo,
  offerableMatches,
  phoneFingerprint,
} from '@/modules/wms/crm/peer-index';
import {
  ChatRuleError,
  attachPeerToCard,
  decideChat,
  openLeadForChat,
} from '@/modules/wms/crm/chat-rules';

/**
 * Round 79 — the owner's report that a NEW customer writing in produced
 * nothing («telegramdan yangi klientlar ochsa smslar chatlar nega
 * korinmayabti»), and his design for the way back: the chat opens a LEAD,
 * and creating a card looks BACK into the connected accounts for the number.
 */

const MARK = `R79-${String(Date.now()).slice(-7)}`;
const PHONE = `+99890${String(Date.now()).slice(-7)}`;

/**
 * A peer id nobody else in this file can mint.
 *
 * The first version wrote `BigInt(Date.now() + 21)` and friends, and CI found
 * what this container never would: the whole file runs in ~120 ms, so
 * `Date.now() + 41` in one test IS `Date.now() + 21` twenty milliseconds
 * later. The collision made «Chatni qo'shish»'s include rule land on the
 * lookback test's peer, so `offerableMatches` correctly refused to offer it
 * and the assertion read as a bug in the code it was testing.
 *
 * A clock is not a unique id — it is a unique id *per millisecond*, and a
 * fast test file spends many tests inside one. The counter is the fix that
 * `login-lockout` had to reach for a round ago, for the same reason.
 */
const PEER_BASE = BigInt(Date.now()) * 1000n;
let peerSeq = 0;
const nextPeer = () => PEER_BASE + BigInt((peerSeq += 1));

let actorId = '';
let otherId = '';
const madeLeads: string[] = [];
const madeClients: string[] = [];
/** Peer ids this file wrote rules for — a rule is CONFIGURATION (#183). */
const madeRules: bigint[] = [];

const ctx = () => ({ actorId, ip: null, userAgent: null });

beforeAll(async () => {
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(roles.code, 'super_admin'))
    .limit(1);
  actorId = admins[0]!.id;
  const everyone = await db.select({ id: users.id }).from(users).limit(5);
  otherId = everyone.find((row) => row.id !== actorId)!.id;
});

afterAll(async () => {
  // Rules first: a leftover `include` rule changes what the LISTENER stores
  // and what the next spec's screens render (#183), and it points at a lead
  // this file is about to delete.
  if (madeRules.length > 0) {
    await db.delete(tgChatRules).where(inArray(tgChatRules.peerId, madeRules));
  }
  await db.delete(tgMessages).where(inArray(tgMessages.leadId, madeLeads));
  await db.delete(tgPeerIndex).where(inArray(tgPeerIndex.managerUserId, [actorId, otherId]));
  await db.delete(events).where(inArray(events.entityId, [...madeLeads, ...madeClients]));
  await db.delete(leads).where(inArray(leads.id, madeLeads));
  if (madeClients.length > 0) await db.delete(clients).where(inArray(clients.id, madeClients));
  await pgClient.end();
});

describe('a stranger writing in gets a lead, not silence', () => {
  it('mints one, owned by the manager whose Telegram it arrived on', async () => {
    const id = await leadForChat(actorId, { phone: PHONE, title: `${MARK} Dilshod` }, ctx());
    madeLeads.push(id);
    const [row] = await db.select().from(leads).where(eq(leads.id, id));
    expect(row!.name).toBe(`${MARK} Dilshod`);
    expect(row!.phone).toBe(PHONE);
    expect(row!.ownerId).toBe(actorId);
  });

  it('does NOT mint a second one when the same person writes again', async () => {
    // The rule that matters more than the minting: a funnel with three cards
    // for one person is worse than the silence it replaced. Written in a
    // different shape on purpose — the match is the last nine digits (#111).
    const again = await leadForChat(
      actorId,
      { phone: PHONE.replace('+998', ''), title: 'Dilshod (2)' },
      ctx(),
    );
    expect(again).toBe(madeLeads[0]);
    const all = await db.select({ id: leads.id }).from(leads).where(eq(leads.phone, PHONE));
    expect(all).toHaveLength(1);
  });

  it('names the lead after the number when Telegram gives no name', async () => {
    const phone = `+99891${String(Date.now()).slice(-7)}`;
    const id = await leadForChat(actorId, { phone, title: '  ' }, ctx());
    madeLeads.push(id);
    const [row] = await db.select().from(leads).where(eq(leads.id, id));
    // Never an empty card on the funnel.
    expect(row!.name).toBe(phone);
  });
});

describe('«Lid ochish» — the third answer the tray could not give', () => {
  const trayPhone = `+99893${String(Date.now()).slice(-7)}`;
  let ruleId = '';

  beforeAll(async () => {
    const peerId = nextPeer();
    madeRules.push(peerId);
    const [row] = await db
      .insert(tgChatRules)
      .values({
        managerUserId: otherId,
        peerId,
        decision: 'pending',
        peerTitle: `${MARK} Notanish`,
        peerPhone: trayPhone,
      })
      .returning({ id: tgChatRules.id });
    ruleId = row!.id;
  });

  it('mints the lead, points the rule at it, and owns it by the ACCOUNT', async () => {
    const { leadId } = await openLeadForChat(ruleId, ctx());
    madeLeads.push(leadId);
    const [rule] = await db.select().from(tgChatRules).where(eq(tgChatRules.id, ruleId));
    expect(rule!.decision).toBe('include');
    expect(rule!.leadId).toBe(leadId);
    expect(rule!.clientId).toBeNull();

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    // The manager whose Telegram it is, NOT the actor who pressed: the owner
    // reading his staff's tray must not collect their leads.
    expect(lead!.ownerId).toBe(otherId);
    expect(lead!.phone).toBe(trayPhone);
  });

  it('pressing again reuses the lead rather than minting a second', async () => {
    const { leadId } = await openLeadForChat(ruleId, ctx());
    expect(leadId).toBe(madeLeads.at(-1));
    const all = await db.select({ id: leads.id }).from(leads).where(eq(leads.phone, trayPhone));
    expect(all).toHaveLength(1);
  });

  it('answering «this is a client» afterwards retires the lead pointer', async () => {
    // Both pointers live must never happen: the listener would store onto a
    // lead the screen has stopped showing.
    const [client] = await db
      .insert(clients)
      .values({ clientCode: `Y${String(Date.now()).slice(-6)}`, name: `${MARK} kod` })
      .returning();
    madeClients.push(client!.id);

    await decideChat({ id: ruleId, decision: 'include', clientId: client!.id }, ctx());
    const [rule] = await db.select().from(tgChatRules).where(eq(tgChatRules.id, ruleId));
    expect(rule!.clientId).toBe(client!.id);
    expect(rule!.leadId).toBeNull();
  });

  it('refuses a chat Telegram gave us no number for', async () => {
    const peerId = nextPeer();
    madeRules.push(peerId);
    const [row] = await db
      .insert(tgChatRules)
      .values({ managerUserId: otherId, peerId, decision: 'pending', peerTitle: `${MARK} ?` })
      .returning({ id: tgChatRules.id });
    // A lead nobody can ring is a row with a name in it — the same refusal
    // `unknownChatAction` makes about `no_phone`.
    await expect(openLeadForChat(row!.id, ctx())).rejects.toThrow(ChatRuleError);
  });
});

describe('«Chatni qo’shish» from a card', () => {
  it('attaches the chat to the card, on the actor’s OWN account', async () => {
    const peerId = nextPeer();
    madeRules.push(peerId);
    const [client] = await db
      .insert(clients)
      .values({ clientCode: `X${String(Date.now()).slice(-6)}`, name: `${MARK} biriktir` })
      .returning();
    madeClients.push(client!.id);

    await attachPeerToCard({ peerId, managerUserId: actorId, clientId: client!.id }, ctx());
    const [rule] = await db
      .select()
      .from(tgChatRules)
      .where(and(eq(tgChatRules.managerUserId, actorId), eq(tgChatRules.peerId, peerId)));
    expect(rule!.decision).toBe('include');
    expect(rule!.clientId).toBe(client!.id);
  });

  it('refuses to attach a chat to nobody', async () => {
    await expect(
      attachPeerToCard({ peerId: nextPeer(), managerUserId: actorId }, ctx()),
    ).rejects.toThrow(ChatRuleError);
  });
});

describe('the conversation follows the person onto their client code', () => {
  it('moves lead-owned messages to the client, keeping the lead link', async () => {
    const leadId = madeLeads[0]!;
    const [client] = await db
      .insert(clients)
      .values({ clientCode: `Z${String(Date.now()).slice(-6)}`, name: `${MARK} mijoz` })
      .returning();
    madeClients.push(client!.id);

    await db.insert(tgMessages).values({
      leadId,
      managerUserId: actorId,
      peerId: nextPeer(),
      tgMessageId: nextPeer(),
      direction: 'in',
      body: `${MARK} salom`,
      sentAt: new Date(),
    });

    await rekeyLeadChats(leadId, client!.id);
    const [row] = await db.select().from(tgMessages).where(eq(tgMessages.leadId, leadId));
    expect(row!.clientId).toBe(client!.id);
    // The lead card keeps showing it — the twin of rekeyLeadCalls.
    expect(row!.leadId).toBe(leadId);
  });
});

describe('the lookback index names the manager and never the person', () => {
  it('finds the account that has this number, and says whose it is', async () => {
    await indexPeers(otherId, [
      { peerId: nextPeer(), phone: PHONE, lastMessageAt: new Date() },
    ]);
    const hits = await managersWhoTalkedTo(PHONE, actorId);
    expect(hits.map((hit) => hit.managerUserId)).toContain(otherId);
    const mine = hits.find((hit) => hit.managerUserId === otherId)!;
    // A colleague's chat is NAMED, not opened — round 20's line.
    expect(mine.own).toBe(false);
    expect(mine.managerName).toBeTruthy();
  });

  it('stores no readable number anywhere in the row', async () => {
    const rows = await db
      .select()
      .from(tgPeerIndex)
      .where(eq(tgPeerIndex.managerUserId, otherId));
    expect(rows.length).toBeGreaterThan(0);
    const digits = PHONE.replace(/\D/g, '').slice(-9);
    for (const row of rows) {
      // A bigint peer id will not serialise; the point of the check is the
      // rest of the row, so it is stringified explicitly.
      const printed = JSON.stringify(row, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      expect(printed).not.toContain(digits);
    }
    expect(rows[0]!.phoneHash).toBe(phoneFingerprint(PHONE));
  });

  it('answers nothing for a number nobody has a chat with', async () => {
    expect(await managersWhoTalkedTo('+998900000000', actorId)).toEqual([]);
    // …and refuses to even ask about a non-number.
    expect(await managersWhoTalkedTo('salom', actorId)).toEqual([]);
  });

  it('re-indexing the same peer updates rather than duplicating', async () => {
    const peerId = nextPeer();
    await indexPeers(otherId, [{ peerId, phone: PHONE, lastMessageAt: new Date() }]);
    await indexPeers(otherId, [{ peerId, phone: PHONE, lastMessageAt: new Date() }]);
    const rows = await db
      .select()
      .from(tgPeerIndex)
      .where(and(eq(tgPeerIndex.managerUserId, otherId), eq(tgPeerIndex.peerId, peerId)));
    expect(rows).toHaveLength(1);
  });

  it('stops offering a chat once somebody has answered about it', async () => {
    // The panel exists to ask a question. A chat already kept, or already
    // refused, is a question with an answer — re-offering it on every card
    // carrying the number turns a decision into nagging.
    const peerId = nextPeer();
    await indexPeers(actorId, [{ peerId, phone: PHONE, lastMessageAt: new Date() }]);
    const before = await offerableMatches(PHONE, actorId);
    expect(before.map((hit) => hit.peerId)).toContain(peerId);

    await db.insert(tgChatRules).values({
      managerUserId: actorId,
      peerId,
      decision: 'exclude',
      decidedBy: actorId,
      decidedAt: new Date(),
    });
    madeRules.push(peerId);
    const after = await offerableMatches(PHONE, actorId);
    expect(after.map((hit) => hit.peerId)).not.toContain(peerId);
    // The colleague's row for the SAME number is untouched: an answer is one
    // manager's about one chat, never the company's about a number.
    expect(after.some((hit) => hit.managerUserId === otherId)).toBe(true);
  });

  it('skips a peer whose number Telegram hides — nothing to match on', async () => {
    const before = await db
      .select()
      .from(tgPeerIndex)
      .where(eq(tgPeerIndex.managerUserId, otherId));
    const written = await indexPeers(otherId, [
      { peerId: nextPeer(), phone: null, lastMessageAt: new Date() },
    ]);
    expect(written).toBe(0);
    const after = await db
      .select()
      .from(tgPeerIndex)
      .where(eq(tgPeerIndex.managerUserId, otherId));
    expect(after).toHaveLength(before.length);
  });
});
