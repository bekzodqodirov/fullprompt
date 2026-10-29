import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** The stranger card's drain kick would start pg-boss in the test process; the ROW is what is asserted. */
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => {}),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  agentConversations,
  attachments,
  clients,
  leads,
  notifications,
  tgChatRules,
  tgMessages,
  users,
} from '@/modules/platform/db/schema';
import {
  attachPeerToCard,
  decideChat,
  listCandidates,
  openLeadForChat,
  pendingCount,
} from '@/modules/wms/crm/chat-rules';
import { cleanUpServiceChat, serviceChatInventory } from '@/modules/wms/crm/service-chat-cleanup';
import { TELEGRAM_SERVICE_PEER } from '@/modules/wms/crm/telegram-import';
import { strangerCards } from '@/modules/wms/agent/jobs';

/**
 * Telegram's own service chat (777000) after the classifiers refused it: a
 * rule written BEFORE that is still a row, and every tray door that would
 * make it a card's must refuse it in words, every list must leave it out, and
 * the one-off cleanup must leave «never» and nothing stored behind it.
 *
 * On this file's own managers — 777000 is ONE peer id for everybody, so a
 * shared seeded account would meet whatever another file left on it.
 */

const STAMP = Date.now();
const ORDINARY_PEER = BigInt(STAMP) * 1000n + 7n;
const madeUsers: string[] = [];
let managerId = '';
let actorId = '';
let clientId = '';

async function person(tag: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      phone: `+99895${String(STAMP + madeUsers.length).slice(-7)}`,
      fullName: `Service chat ${tag} ${STAMP}`,
      passwordHash: 'x',
    })
    .returning({ id: users.id });
  madeUsers.push(u!.id);
  return u!.id;
}

/** The 777000 rule an old scan wrote, put back to `pending` with Telegram's own title and short number. */
async function serviceRule(manager = managerId): Promise<string> {
  const [row] = await db
    .insert(tgChatRules)
    .values({ managerUserId: manager, peerId: TELEGRAM_SERVICE_PEER, decision: 'pending', peerTitle: 'Telegram', peerPhone: '42777' })
    .onConflictDoUpdate({
      target: [tgChatRules.managerUserId, tgChatRules.peerId],
      set: { decision: 'pending', clientId: null, leadId: null, decidedBy: null, decidedAt: null },
    })
    .returning({ id: tgChatRules.id });
  return row!.id;
}

async function ruleOf(manager: string, peer: bigint) {
  const [row] = await db
    .select()
    .from(tgChatRules)
    .where(and(eq(tgChatRules.managerUserId, manager), eq(tgChatRules.peerId, peer)));
  return row;
}

async function serviceMessage(manager: string, tgId: bigint): Promise<string> {
  const [row] = await db
    .insert(tgMessages)
    .values({
      clientId,
      managerUserId: manager,
      peerId: TELEGRAM_SERVICE_PEER,
      tgMessageId: tgId,
      direction: 'in',
      body: 'Login code: 12345',
      hasMedia: tgId === 1n,
      sentAt: new Date(),
    })
    .returning({ id: tgMessages.id });
  return row!.id;
}

const ctx = () => ({ actorId, ip: null, userAgent: null });

beforeAll(async () => {
  const [seeded] = await db.select({ id: users.id }).from(users).limit(1);
  actorId = seeded!.id;
  managerId = await person('manager');
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `SC${String(STAMP).slice(-8)}`, name: `Service chat ${STAMP}` })
    .returning({ id: clients.id });
  clientId = c!.id;
  // An ordinary question on the same account, so every «left out» below is
  // measured against a list that is not empty for some other reason. No
  // phone: the stranger sweep's colleague-phone clause cannot then decide it.
  await db.insert(tgChatRules).values({
    managerUserId: managerId,
    peerId: ORDINARY_PEER,
    decision: 'pending',
    peerTitle: `Mijoz ${STAMP}`,
    peerPhone: null,
  });
});

afterAll(async () => {
  await db.delete(notifications).where(inArray(notifications.userId, madeUsers));
  await db.delete(agentConversations).where(inArray(agentConversations.managerUserId, madeUsers));
  const messageIds = (
    await db.select({ id: tgMessages.id }).from(tgMessages).where(inArray(tgMessages.managerUserId, madeUsers))
  ).map((m) => m.id);
  if (messageIds.length > 0) {
    await db.delete(attachments).where(and(eq(attachments.entityType, 'tg_message'), inArray(attachments.entityId, messageIds)));
    await db.delete(tgMessages).where(inArray(tgMessages.id, messageIds));
  }
  await db.delete(tgChatRules).where(inArray(tgChatRules.managerUserId, madeUsers));
  // Only a red proof mints one (a «Yangi lid» the guard did not stop).
  await db.delete(leads).where(inArray(leads.ownerId, madeUsers));
  await db.delete(clients).where(eq(clients.id, clientId));
  for (const id of madeUsers) {
    await db
      .delete(users)
      .where(eq(users.id, id))
      .catch(() => db.update(users).set({ active: false }).where(eq(users.id, id)));
  }
  await pgClient.end();
});

describe('the tray doors refuse 777000 in words', () => {
  it('«Qo\'shish» refuses it, and the rule stays as it was', async () => {
    const id = await serviceRule();
    await expect(decideChat({ id, decision: 'include', clientId }, ctx())).rejects.toThrow('service_chat');
    expect(await ruleOf(managerId, TELEGRAM_SERVICE_PEER)).toMatchObject({ decision: 'pending', clientId: null });
  });

  it('«Hech qachon» is still the answer it may be given', async () => {
    const id = await serviceRule();
    await decideChat({ id, decision: 'exclude' }, ctx());
    expect((await ruleOf(managerId, TELEGRAM_SERVICE_PEER))?.decision).toBe('exclude');
  });

  it('«Yangi lid» refuses it — ahead of the phone it shows', async () => {
    const id = await serviceRule();
    await expect(openLeadForChat(id, ctx())).rejects.toThrow('service_chat');
    expect(await ruleOf(managerId, TELEGRAM_SERVICE_PEER)).toMatchObject({ decision: 'pending', leadId: null });
    expect(await db.select({ id: leads.id }).from(leads).where(eq(leads.ownerId, managerId))).toHaveLength(0);
  });

  it('«Chatni qo\'shish» from a card refuses it, and a «never» is not overwritten', async () => {
    const id = await serviceRule();
    await decideChat({ id, decision: 'exclude' }, ctx());
    await expect(
      attachPeerToCard({ peerId: TELEGRAM_SERVICE_PEER, managerUserId: managerId, clientId }, ctx()),
    ).rejects.toThrow('service_chat');
    expect(await ruleOf(managerId, TELEGRAM_SERVICE_PEER)).toMatchObject({ decision: 'exclude', clientId: null });
  });
});

describe('…and so do they for Telegram’s OTHER accounts (2026-10-29 review)', () => {
  it('«Verification Codes» (489000) and «Replies» are no card’s, by any door', async () => {
    for (const peer of [489000n, 1271266957n]) {
      const [row] = await db
        .insert(tgChatRules)
        .values({ managerUserId: managerId, peerId: peer, decision: 'pending', peerTitle: 'Verification Codes', peerPhone: null })
        .returning({ id: tgChatRules.id });
      await expect(decideChat({ id: row!.id, decision: 'include', clientId }, ctx()), String(peer)).rejects.toThrow('service_chat');
      await expect(openLeadForChat(row!.id, ctx(), { phoneless: 'agent_stranger' }), String(peer)).rejects.toThrow('service_chat');
      await expect(attachPeerToCard({ peerId: peer, managerUserId: managerId, clientId }, ctx()), String(peer)).rejects.toThrow('service_chat');
      expect(await ruleOf(managerId, peer)).toMatchObject({ decision: 'pending', clientId: null, leadId: null });
      // Gone again before the lists below count this account's questions.
      await db.delete(tgChatRules).where(eq(tgChatRules.id, row!.id));
    }
    expect(await db.select({ id: leads.id }).from(leads).where(eq(leads.ownerId, managerId))).toHaveLength(0);
  });
});

describe('the lists leave 777000 out', () => {
  it('the badge counts the ordinary question and not the service chat', async () => {
    await serviceRule();
    expect(await pendingCount(managerId)).toBe(1);
  });

  it('the tray lists the ordinary question and not the service chat', async () => {
    await serviceRule();
    const mine = await listCandidates({ managerUserId: managerId });
    expect(mine.map((r) => r.peerId)).toEqual([ORDINARY_PEER.toString()]);
    // …and on the owner's all-accounts view too.
    const everybody = await listCandidates({ decision: 'pending' });
    expect(everybody.some((r) => r.peerId === TELEGRAM_SERVICE_PEER.toString())).toBe(false);
    expect(everybody.some((r) => r.peerId === ORDINARY_PEER.toString())).toBe(true);
  });

  it('the AI sotuvchi asks about the stranger, never about 777000', async () => {
    const serviceId = await serviceRule();
    const [ordinary] = await db
      .select({ id: tgChatRules.id })
      .from(tgChatRules)
      .where(and(eq(tgChatRules.managerUserId, managerId), eq(tgChatRules.peerId, ORDINARY_PEER)));
    await strangerCards(managerId, new Date());
    const cards = await db
      .select({ ruleId: sql<string>`${notifications.payload}->>'ruleId'` })
      .from(notifications)
      .where(and(eq(notifications.userId, managerId), eq(notifications.type, 'AgentStranger')));
    // The sweep ran: the ordinary rule got its card…
    expect(cards.map((c) => c.ruleId)).toContain(ordinary!.id);
    // …and the service chat got neither a card nor the claim that stands for one.
    expect(cards.map((c) => c.ruleId)).not.toContain(serviceId);
    const claimed = await db
      .select({ peerId: agentConversations.peerId })
      .from(agentConversations)
      .where(and(eq(agentConversations.managerUserId, managerId), eq(agentConversations.peerId, TELEGRAM_SERVICE_PEER)));
    expect(claimed).toHaveLength(0);
  });
});

describe('the one-off cleanup', () => {
  it('excludes the rule and deletes what was stored behind it, counting only', async () => {
    await serviceRule();
    const withPhoto = await serviceMessage(managerId, 1n);
    await serviceMessage(managerId, 2n);
    await db.insert(attachments).values({
      entityType: 'tg_message',
      entityId: withPhoto,
      kind: 'photo',
      storageKey: `servicechat/${withPhoto}`,
      fileName: 'photo_1.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1,
      uploadedBy: actorId,
    });

    const [before] = await serviceChatInventory({ managerUserId: managerId });
    expect(before).toMatchObject({ decision: 'pending', messages: 2, attachments: 1 });
    // Numbers and ids only — a body may be a login code.
    expect(JSON.stringify(before)).not.toContain('12345');

    const done = await cleanUpServiceChat({ actorId: null }, { managerUserId: managerId });
    expect(done).toEqual([
      expect.objectContaining({ managerUserId: managerId, before: 'pending', messages: 2, photos: 1 }),
    ]);
    expect((await ruleOf(managerId, TELEGRAM_SERVICE_PEER))?.decision).toBe('exclude');
    expect(
      await db
        .select()
        .from(tgMessages)
        .where(and(eq(tgMessages.managerUserId, managerId), eq(tgMessages.peerId, TELEGRAM_SERVICE_PEER))),
    ).toHaveLength(0);
    expect(await db.select().from(attachments).where(eq(attachments.entityId, withPhoto))).toHaveLength(0);
    // The ordinary chat on the same account is nobody's business here.
    expect((await ruleOf(managerId, ORDINARY_PEER))?.decision).toBe('pending');

    // Re-runnable: a second pass finds the «never» and nothing behind it.
    const again = await cleanUpServiceChat({ actorId: null }, { managerUserId: managerId });
    expect(again).toEqual([expect.objectContaining({ before: 'exclude', messages: 0, photos: 0 })]);
  });

  it('gives a chat stored with no rule at all the «never» the purge needs', async () => {
    const other = await person('norule');
    await serviceMessage(other, 3n);
    expect(await ruleOf(other, TELEGRAM_SERVICE_PEER)).toBeUndefined();
    expect(await serviceChatInventory({ managerUserId: other })).toEqual([
      expect.objectContaining({ ruleId: null, decision: null, messages: 1 }),
    ]);

    const done = await cleanUpServiceChat({ actorId: null }, { managerUserId: other });
    expect(done).toEqual([expect.objectContaining({ before: null, messages: 1, photos: 0 })]);
    expect((await ruleOf(other, TELEGRAM_SERVICE_PEER))?.decision).toBe('exclude');
    expect(
      await db
        .select()
        .from(tgMessages)
        .where(and(eq(tgMessages.managerUserId, other), eq(tgMessages.peerId, TELEGRAM_SERVICE_PEER))),
    ).toHaveLength(0);
  });
});
