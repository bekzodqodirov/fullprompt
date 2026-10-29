import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «💵 Narx yozaman» after a refusal, driven through the bot the server runs
 * (cards review): the figure he typed CONSUMED the price wait — the slot drops
 * it before the effect, the redelivery rule — so a refusal that says «write
 * it again» must say WHERE, or his next plain «1250» lands on whatever reads
 * plain text after the agent and no draft is made. The words name two ways,
 * and both are taken: a swipe-reply to the answer card, and 💵 pressed again.
 *
 * Everything is this file's own: one owner with a run-unique phone, chat ids
 * starting `95<stamp>`, one client, one request. agent_config is
 * CONFIGURATION (#183) — snapshotted and put back. The owner is DEACTIVATED in
 * cleanup, never deleted (audit FK).
 */
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => {}),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  agentCalcLinks,
  agentConfig,
  agentConversations,
  agentDrafts,
  calcRequests,
  clients,
  notifications,
  roles,
  telegramLinks,
  tgMessages,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { __resetLifecycle, markBoot } from '@/modules/platform/telegram/lifecycle';
import { __forgetWaitMemory, flushWaitWrites, readWait } from '@/modules/platform/telegram/waits';
import { __resetPresses } from '@/modules/platform/telegram/press';
import { __resetBacklog } from '@/modules/platform/telegram/backlog';
import { __resetDrafts } from '@/modules/platform/telegram/task-draft';
import { PRICE_DRAFTED, PRICE_RETYPE } from '@/modules/wms/agent/bot-door';
import { readAgentConfig, __restoreAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { priceReplyText } from '@/modules/wms/agent/price-reply';
import { botHarness, tg, type BotHarness } from '../fixtures/bot-harness';

const STAMP = String(Date.now()).slice(-7);
const PREFIX = `95${STAMP}`;
const CHAT = Number(`${PREFIX}01`);
const PEER = BigInt(`${PREFIX}9`);
let ownerId = '';
let clientId = '';
let requestId = '';
let card = 0;
let msgSeq = 700_000;
let snapshot: AgentConfig | null = null;
let h: BotHarness;

const priceDrafts = () =>
  db
    .select()
    .from(agentDrafts)
    .where(and(eq(agentDrafts.managerUserId, ownerId), eq(agentDrafts.kind, 'price'), eq(agentDrafts.status, 'pending')));

/** 💵 on the answer card, as the bot shows it. */
async function pressPrice(): Promise<void> {
  await h.handle(tg.callback(CHAT, card, `ag:p:${requestId}`));
  await flushWaitWrites();
  expect(readWait(BigInt(CHAT), 'agent_price'), 'the 💵 armed its wait').not.toBeNull();
}

/** What the bot said to one typed text. */
async function say(text: string, opts: { replyTo?: number } = {}): Promise<string> {
  const m = h.mark();
  await h.handle(tg.text(CHAT, text, opts));
  await h.settle();
  return h.textsTo(CHAT, m).join('\n');
}

beforeAll(async () => {
  snapshot = await readAgentConfig();
  const [u] = await db
    .insert(users)
    .values({ phone: `+99895${STAMP}01`, fullName: `Narx egasi ${STAMP}`, passwordHash: 'x' })
    .returning({ id: users.id });
  ownerId = u!.id;
  const r = await db.query.roles.findFirst({ where: eq(roles.code, 'super_admin') });
  await db.insert(userRoles).values({ userId: ownerId, roleId: r!.id });
  await db.insert(telegramLinks).values({ userId: ownerId, telegramChatId: BigInt(CHAT), status: 'linked', linkedAt: new Date() });
  await db
    .update(agentConfig)
    .set({ mode: 'shadow', ownerUserId: ownerId, sessionExclusiveAt: new Date(), sessionExclusiveBy: ownerId, startedAt: new Date() })
    .where(eq(agentConfig.id, 1));
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `NR${STAMP.slice(-5)}`, name: `Narx mijoz ${STAMP}`, phones: [`+99895${STAMP}77`], salesManagerId: ownerId })
    .returning({ id: clients.id });
  clientId = c!.id;
  const [req] = await db
    .insert(calcRequests)
    .values({
      entityType: 'deal',
      entityId: '00000000-0000-4000-8000-000000000137',
      requestedBy: ownerId,
      itemCount: 1,
      section: 'rastamojka',
      dueAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: calcRequests.id });
  requestId = req!.id;
  await db.insert(agentCalcLinks).values({ requestId, rootRequestId: requestId, managerUserId: ownerId, peerId: PEER });
  // The customer's question the price answers.
  await db.insert(tgMessages).values({
    clientId,
    managerUserId: ownerId,
    peerId: PEER,
    tgMessageId: BigInt(msgSeq),
    direction: 'in',
    body: 'Narxi qancha?',
    sentAt: new Date(),
  });
  // The «💵 Hisob javobi keldi» card, its copy already in his chat.
  card = (msgSeq += 1);
  await db.insert(notifications).values({
    userId: ownerId,
    channel: 'telegram',
    type: 'AgentCalcAnswered',
    status: 'sent',
    sentAt: new Date(),
    payload: { text: '💵 Hisob javobi keldi', requestId, priceable: true, event: 'done', tg: { chatId: CHAT, messageId: card } },
  });
  h = botHarness();
});

beforeEach(async () => {
  __resetLifecycle();
  __forgetWaitMemory();
  __resetPresses();
  __resetBacklog();
  __resetDrafts();
  markBoot(new Date(0));
  await db.delete(agentDrafts).where(eq(agentDrafts.managerUserId, ownerId));
  await db.delete(notifications).where(and(eq(notifications.userId, ownerId), eq(notifications.type, 'AgentDraft')));
});

afterAll(async () => {
  await flushWaitWrites();
  h.restore();
  await __restoreAgentConfig(snapshot);
  await db.delete(agentDrafts).where(eq(agentDrafts.managerUserId, ownerId));
  await db.delete(notifications).where(eq(notifications.userId, ownerId));
  await db.delete(agentCalcLinks).where(eq(agentCalcLinks.managerUserId, ownerId));
  await db.delete(agentConversations).where(eq(agentConversations.managerUserId, ownerId));
  await db.delete(tgMessages).where(and(eq(tgMessages.managerUserId, ownerId), eq(tgMessages.peerId, PEER)));
  await db.delete(calcRequests).where(eq(calcRequests.id, requestId));
  await db.execute(sql`DELETE FROM telegram_once WHERE key LIKE ${`m:${PREFIX}%`} OR key LIKE ${`q:${PREFIX}%`}`);
  await db.execute(sql`DELETE FROM telegram_chat_waits WHERE chat_id::text LIKE ${`${PREFIX}%`}`);
  await db.delete(clients).where(inArray(clients.id, [clientId]));
  await db.delete(telegramLinks).where(eq(telegramLinks.userId, ownerId));
  await db.update(users).set({ active: false }).where(eq(users.id, ownerId));
  await pgClient.end();
});

describe('a refused 💵 says how to type the figure again — and both ways it names are taken (cards review)', () => {
  it('a figure that reads two ways: asked back with the way to answer; a reply to the card is the answer', async () => {
    await pressPrice();
    const asked = await say('1.250');
    expect(asked).toContain('1250 dollarmi yoki 1,25 dollarmi');
    expect(asked).toContain(PRICE_RETYPE);
    // The refused text consumed the wait — which is why the words cannot say «just type it»:
    expect(readWait(BigInt(CHAT), 'agent_price')).toBeNull();
    await say('1250');
    expect(await priceDrafts()).toHaveLength(0);
    // …a swipe-reply to the card names its own target.
    expect(await say('1250', { replyTo: card })).toContain(PRICE_DRAFTED);
    const [d] = await priceDrafts();
    expect(d!.proposedBody).toBe(priceReplyText('uz', 'rastamojka', 1250));
  });

  it('a text that is no price: told so with the way to answer; 💵 pressed again takes a plain figure', async () => {
    await pressPrice();
    const told = await say("ko'p");
    expect(told).toContain('Narxni dollarda son bilan yozing');
    expect(told).toContain(PRICE_RETYPE);
    expect(await priceDrafts()).toHaveLength(0);
    await pressPrice();
    expect(await say('1300')).toContain(PRICE_DRAFTED);
    const [d] = await priceDrafts();
    expect(d!.proposedBody).toBe(priceReplyText('uz', 'rastamojka', 1300));
  });
});
