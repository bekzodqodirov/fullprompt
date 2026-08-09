import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  clients,
  events,
  leads,
  roles,
  tgMessages,
  tgPeerIndex,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { leadForChat, rekeyLeadChats } from '@/modules/wms/crm/chat-lead';
import { indexPeers, managersWhoTalkedTo, phoneFingerprint } from '@/modules/wms/crm/peer-index';

/**
 * Round 79 — the owner's report that a NEW customer writing in produced
 * nothing («telegramdan yangi klientlar ochsa smslar chatlar nega
 * korinmayabti»), and his design for the way back: the chat opens a LEAD,
 * and creating a card looks BACK into the connected accounts for the number.
 */

const MARK = `R79-${String(Date.now()).slice(-7)}`;
const PHONE = `+99890${String(Date.now()).slice(-7)}`;

let actorId = '';
let otherId = '';
const madeLeads: string[] = [];
const madeClients: string[] = [];

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
      peerId: BigInt(Date.now()),
      tgMessageId: BigInt(Date.now()),
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
      { peerId: BigInt(Date.now()), phone: PHONE, lastMessageAt: new Date() },
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
    const peerId = BigInt(Date.now() + 5);
    await indexPeers(otherId, [{ peerId, phone: PHONE, lastMessageAt: new Date() }]);
    await indexPeers(otherId, [{ peerId, phone: PHONE, lastMessageAt: new Date() }]);
    const rows = await db
      .select()
      .from(tgPeerIndex)
      .where(and(eq(tgPeerIndex.managerUserId, otherId), eq(tgPeerIndex.peerId, peerId)));
    expect(rows).toHaveLength(1);
  });

  it('skips a peer whose number Telegram hides — nothing to match on', async () => {
    const before = await db
      .select()
      .from(tgPeerIndex)
      .where(eq(tgPeerIndex.managerUserId, otherId));
    const written = await indexPeers(otherId, [
      { peerId: BigInt(Date.now() + 9), phone: null, lastMessageAt: new Date() },
    ]);
    expect(written).toBe(0);
    const after = await db
      .select()
      .from(tgPeerIndex)
      .where(eq(tgPeerIndex.managerUserId, otherId));
    expect(after).toHaveLength(before.length);
  });
});
