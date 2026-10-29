import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The AI draft card from the owner's side, through the bot the server runs
 * (the 2026-10-29 incident): ✏️'s words and the text to copy (C4), ✅ on a
 * draft he pressed ✏️ on and then wrote nothing for (C7), the confirmation
 * after his own text and ITS ✅ (C9), the card that cannot be shown or
 * checked (C10), and his own Telegram reply told apart from 🙋 (C6). The
 * sends are real ✅ presses against a fresh pump and the CRM's send switch —
 * an approval is an `agent_outbox` row, never only a status.
 *
 * Everything is this file's own: users with run-unique phones, chat ids
 * starting `94<stamp>`, one client, a peer per case. agent_config and the
 * send switch are CONFIGURATION (#183) — snapshotted and put back. Users are
 * DEACTIVATED in cleanup, never deleted (audit FK).
 */
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => {}),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  agentConfig,
  agentConversations,
  agentDrafts,
  agentOutbox,
  clients,
  notifications,
  roles,
  telegramLinks,
  tgAccountGuard,
  tgAccounts,
  tgMessages,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import { buttonsFor } from '@/modules/platform/telegram/staff-bot';
import { __resetLifecycle, markBoot } from '@/modules/platform/telegram/lifecycle';
import { __forgetWaitMemory, flushWaitWrites, readWait } from '@/modules/platform/telegram/waits';
import { __resetPresses } from '@/modules/platform/telegram/press';
import { __resetBacklog } from '@/modules/platform/telegram/backlog';
import { __resetDrafts } from '@/modules/platform/telegram/task-draft';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';
import { POLICY_WORDS } from '@/modules/wms/agent/card';
import { readAgentConfig, __restoreAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { decideDraft } from '@/modules/wms/agent/decide';
import { createDraft } from '@/modules/wms/agent/drafts';
import { EDIT_PROMPT, OWN_TEXT_PLACED, agentPress } from '@/modules/wms/agent/bot-door';
import { retireOnHumanReply } from '@/modules/wms/agent/jobs';
import type { PolicyMemory } from '@/modules/wms/agent/policy-input';
import { botHarness, tg, type BotHarness } from '../fixtures/bot-harness';

const STAMP = String(Date.now()).slice(-7);
const PREFIX = `94${STAMP}`;
let chatSeq = 0;
let phoneSeq = 0;
let peerSeq = 0;
let msgSeq = 700_000;
const nextMsg = () => (msgSeq += 1);

const madeUsers: string[] = [];
const madeAccounts: string[] = [];
let clientId = '';
let snapshot: AgentConfig | null = null;
let sendingBefore = false;
let h: BotHarness;

const MACHINE = 'Assalomu alaykum! Qanday yordam bera olaman?';

/** What the run stores for an Uzbek Latin chat — the smallest memory the whole policy re-runs on at ✅. */
const memory: PolicyMemory = {
  language: 'uz',
  customerScript: 'latin',
  sources: [],
  allowedPhones: [],
  allowedUrls: [],
  mapUrls: [],
  askedLocation: false,
  hasEstimate: false,
  ownCodes: [],
  managerName: null,
  canary: 'gsr-cardflow',
};

interface Owner {
  id: string;
  chat: number;
  peer: bigint;
  anchor: bigint;
}

/** The agent's owner, linked to the bot, with a fresh pump, and one customer line to answer. */
async function owner(): Promise<Owner> {
  phoneSeq += 1;
  const [u] = await db
    .insert(users)
    .values({ phone: `+99894${STAMP}${String(phoneSeq).padStart(2, '0')}`, fullName: `Karta egasi ${STAMP}-${phoneSeq}`, passwordHash: 'x' })
    .returning({ id: users.id });
  madeUsers.push(u!.id);
  const r = await db.query.roles.findFirst({ where: eq(roles.code, 'super_admin') });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  const chat = Number(`${PREFIX}${String((chatSeq += 1)).padStart(2, '0')}`);
  await db.insert(telegramLinks).values({ userId: u!.id, telegramChatId: BigInt(chat), status: 'linked', linkedAt: new Date() });
  const [acc] = await db
    .insert(tgAccounts)
    .values({ managerUserId: u!.id, tgPhone: `+99895${STAMP}${String(phoneSeq).padStart(2, '0')}`, sessionEnc: 'v1.x.y.z', status: 'active', lastSeenAt: new Date() })
    .returning({ id: tgAccounts.id });
  madeAccounts.push(acc!.id);
  await stampAgentPump(acc!.id, true);
  await db
    .update(agentConfig)
    .set({
      mode: 'shadow',
      ownerUserId: u!.id,
      sessionExclusiveAt: new Date(),
      sessionExclusiveBy: u!.id,
      startedAt: new Date(Date.now() - 30 * 86_400_000),
      dailyDraftCap: 150,
      dailyTokenCap: 3_000_000,
    })
    .where(eq(agentConfig.id, 1));
  const peer = BigInt(`${PREFIX}9${(peerSeq += 1)}`);
  const anchor = BigInt(nextMsg());
  await db.insert(tgMessages).values({
    clientId,
    managerUserId: u!.id,
    peerId: peer,
    tgMessageId: anchor,
    direction: 'in',
    body: 'Assalomu alaykum',
    sentAt: new Date(Date.now() - 60_000),
  });
  return { id: u!.id, chat, peer, anchor };
}

/** A draft and its card as the run writes them (`createDraft`), the card's copy then SENT to him. */
async function draftFor(me: Owner, over: { body?: string; withMemory?: boolean } = {}): Promise<{ draftId: string; card: number }> {
  const written = await createDraft({
    runId: null,
    managerUserId: me.id,
    peerId: me.peer,
    clientId,
    leadId: null,
    identityStrength: null,
    anchorTgMessageId: me.anchor,
    anchorEditedAt: null,
    kind: 'reply',
    body: over.body ?? MACHINE,
    glossUz: null,
    language: 'uz',
    category: 'greeting',
    confidence: 0.9,
    nextStep: null,
    policy: {
      blocks: [],
      warnings: [],
      ledger: [],
      ...(over.withMemory === false ? {} : { memory }),
      card: { customerLabel: `KF${STAMP.slice(-5)} · Karta mijoz`, lastOut: null, customerLines: ['17:46 Assalomu alaykum'] },
      notes: [],
    } as never,
    blocked: false,
    needsOwner: false,
    ownerQuestion: null,
    actions: [],
    citedMessageIds: [],
    offerId: null,
  });
  if (written.kind !== 'written') throw new Error('no draft written');
  const card = nextMsg();
  // The drain sent it: the copy in Telegram is what a swipe-reply names and an edit reaches.
  await db
    .update(notifications)
    .set({ status: 'sent', sentAt: new Date(), payload: sql`${notifications.payload} || ${JSON.stringify({ tg: { chatId: me.chat, messageId: card } })}::jsonb` })
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${written.draftId}`));
  return { draftId: written.draftId, card };
}

async function draftOf(id: string) {
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, id));
  return d!;
}

async function cardPayloadOf(draftId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ payload: notifications.payload })
    .from(notifications)
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`));
  return row!.payload as Record<string, unknown>;
}

async function outboxOf(draftId: string) {
  const [o] = await db.select().from(agentOutbox).where(eq(agentOutbox.draftId, draftId));
  return o ?? null;
}

/** The ✅ the CARD carries now — its digest is the card's, as the bot draws it. */
async function cardSend(draftId: string): Promise<string | null> {
  const rows = buttonsFor('AgentDraft', await cardPayloadOf(draftId)) ?? [];
  const send = rows.flat().find((b) => 'callback_data' in b && b.callback_data.startsWith('ag:s:'));
  return send && 'callback_data' in send ? send.callback_data : null;
}

const actor = (id: string) => ({ id, roles: ['super_admin'], permissions: new Set<string>() });

beforeAll(async () => {
  snapshot = await readAgentConfig();
  sendingBefore = (await getSetting('tg_sending_enabled')) === true;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `KF${STAMP.slice(-5)}`, name: `Karta mijoz ${STAMP}`, phones: [] })
    .returning({ id: clients.id });
  clientId = c!.id;
  h = botHarness();
  await setSetting('tg_sending_enabled', true, null);
});

beforeEach(() => {
  __resetLifecycle();
  __forgetWaitMemory();
  __resetPresses();
  __resetBacklog();
  __resetDrafts();
  markBoot(new Date(0));
});

afterAll(async () => {
  await flushWaitWrites();
  h.restore();
  await __restoreAgentConfig(snapshot);
  await setSetting('tg_sending_enabled', sendingBefore, null);
  await db.delete(agentOutbox).where(inArray(agentOutbox.managerUserId, madeUsers));
  await db.delete(agentDrafts).where(inArray(agentDrafts.managerUserId, madeUsers));
  await db.delete(tgMessages).where(inArray(tgMessages.managerUserId, madeUsers));
  await db.delete(notifications).where(inArray(notifications.userId, madeUsers));
  await db.delete(agentConversations).where(inArray(agentConversations.managerUserId, madeUsers));
  if (madeAccounts.length) {
    await db.delete(tgAccountGuard).where(inArray(tgAccountGuard.accountId, madeAccounts));
    await db.delete(tgAccounts).where(inArray(tgAccounts.id, madeAccounts));
  }
  await db.execute(sql`DELETE FROM telegram_once WHERE key LIKE ${`m:${PREFIX}%`} OR key LIKE ${`q:${PREFIX}%`}`);
  await db.execute(sql`DELETE FROM telegram_chat_waits WHERE chat_id::text LIKE ${`${PREFIX}%`}`);
  await db.delete(clients).where(eq(clients.id, clientId));
  await db.delete(telegramLinks).where(inArray(telegramLinks.userId, madeUsers));
  await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
  await pgClient.end();
});

describe('✏️ says WHERE, and hands him the text to change (C4)', () => {
  it('the prompt names this bot, then the draft’s own words come as a message of their own', async () => {
    const me = await owner();
    const { draftId } = await draftFor(me);
    const m = h.mark();
    await h.handle(tg.callback(me.chat, nextMsg(), `ag:e:${draftId}`));
    const texts = h.textsTo(me.chat, m);
    expect(texts).toEqual([EDIT_PROMPT, MACHINE]);
    expect(EDIT_PROMPT).toContain('SHU BOTGA yozing — mijozning chatiga emas');
    expect(EDIT_PROMPT).toContain('30 daqiqa ichida');
    expect((await draftOf(draftId)).status).toBe('editing');
  });

  it('a swipe-reply to that copied text is the draft’s text — it is one of the prompts the wait names', async () => {
    const me = await owner();
    const { draftId } = await draftFor(me);
    const m = h.mark();
    await h.handle(tg.callback(me.chat, nextMsg(), `ag:e:${draftId}`));
    const copy = h.since(m).api.find((c) => c.method === 'sendMessage' && c.payload.text === MACHINE);
    await h.handle(tg.text(me.chat, `Assalomu alaykum! Yukingiz qayerdan? ${STAMP}`, { replyTo: copy!.messageId! }));
    expect((await draftOf(draftId)).finalBody).toBe(`Assalomu alaykum! Yukingiz qayerdan? ${STAMP}`);
  });

  it('an empty draft sends the prompt alone — no blank second message', async () => {
    const me = await owner();
    const [d] = await db
      .insert(agentDrafts)
      .values({ managerUserId: me.id, peerId: me.peer, clientId, anchorTgMessageId: me.anchor, proposedBody: '', status: 'pending' })
      .returning({ id: agentDrafts.id });
    const press = await agentPress(me.id, 'e', d!.id, undefined);
    expect(press.reply).toBe(EDIT_PROMPT);
    expect(press.followUp).toBeUndefined();
  });
});

describe('✅ after a ✏️ he did not use sends the AI’s words (C7)', () => {
  it('the card’s ✅ on an editing draft is approved and queued with the machine text — and the ✏️ wait is gone', async () => {
    const me = await owner();
    const { draftId } = await draftFor(me);
    await h.handle(tg.callback(me.chat, nextMsg(), `ag:e:${draftId}`));
    expect(readWait(BigInt(me.chat), 'agent_edit')?.payload).toMatchObject({ draftId });
    const send = await cardSend(draftId);
    expect(send, 'an editing card that is not blocked still draws ✅').not.toBeNull();
    await h.handle(tg.callback(me.chat, nextMsg(), send!));
    expect((await draftOf(draftId)).status).toBe('approved');
    expect((await outboxOf(draftId))?.body).toBe(MACHINE);
    expect(readWait(BigInt(me.chat), 'agent_edit')).toBeNull();
  });

  it('an editing draft that carries HIS words waits for the new ones — today’s refusal', async () => {
    const me = await owner();
    const { draftId } = await draftFor(me);
    await db.update(agentDrafts).set({ status: 'editing', finalBody: 'Ertaga aytaman.' }).where(eq(agentDrafts.id, draftId));
    expect(await decideDraft(actor(me.id), draftId, 'send', {}, { actorId: me.id })).toEqual({ ok: false, code: 'editing' });
    expect(await outboxOf(draftId)).toBeNull();
  });

  it('a ✅ elsewhere does not drop a ✏️ wait armed for ANOTHER draft', async () => {
    const me = await owner();
    const first = await draftFor(me);
    // A second chat of the same owner, its own live draft.
    const other = { ...me, peer: BigInt(`${PREFIX}8${(peerSeq += 1)}`), anchor: BigInt(nextMsg()) };
    await db.insert(tgMessages).values({ clientId, managerUserId: me.id, peerId: other.peer, tgMessageId: other.anchor, direction: 'in', body: 'Salom', sentAt: new Date(Date.now() - 60_000) });
    const second = await draftFor(other);
    await h.handle(tg.callback(me.chat, nextMsg(), `ag:e:${second.draftId}`));
    await h.handle(tg.callback(me.chat, nextMsg(), (await cardSend(first.draftId))!));
    expect((await draftOf(first.draftId)).status).toBe('approved');
    expect(readWait(BigInt(me.chat), 'agent_edit')?.payload).toMatchObject({ draftId: second.draftId });
  });
});

describe('after his own text: an honest answer, with the button (C9)', () => {
  it('his words placed → the sentence and a ✅ whose press SENDS them', async () => {
    const me = await owner();
    const { draftId } = await draftFor(me);
    await h.handle(tg.callback(me.chat, nextMsg(), `ag:e:${draftId}`));
    const m = h.mark();
    const mine = `Assalomu alaykum! Yukingiz qayerdan jo‘natiladi? ${STAMP}`;
    await h.handle(tg.text(me.chat, mine));
    const answer = h.since(m).api.find((c) => c.method === 'sendMessage' && c.payload.text === OWN_TEXT_PLACED);
    expect(answer, 'the confirmation').toBeDefined();
    const keyboard = (answer!.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
    expect(keyboard).toHaveLength(1);
    expect(keyboard[0]![0]!.text).toBe('✅ Yuborish');
    // The same press the card's own ✅ is now.
    expect(keyboard[0]![0]!.callback_data).toBe(await cardSend(draftId));
    await h.handle(tg.callback(me.chat, answer!.messageId!, keyboard[0]![0]!.callback_data));
    expect((await draftOf(draftId)).status).toBe('approved');
    expect((await outboxOf(draftId))?.body).toBe(mine);
  });

  it('words the owner subset blocks are said with the reason and NO button', async () => {
    const me = await owner();
    const { draftId } = await draftFor(me);
    await h.handle(tg.callback(me.chat, nextMsg(), `ag:e:${draftId}`));
    const m = h.mark();
    await h.handle(tg.text(me.chat, 'a'.repeat(4050)));
    const answer = h.since(m).api.find((c) => c.method === 'sendMessage' && String(c.payload.text).startsWith('⛔ Matningiz kartaga qo‘yildi'));
    expect(answer, 'the refusal').toBeDefined();
    expect(String(answer!.payload.text)).toContain('juda uzun: 4050 belgi');
    expect(answer!.payload.reply_markup).toBeUndefined();
    expect(await cardSend(draftId)).toBeNull();
  });

  it('words too long for the CARD (the policy passed) are refused the same way — no ✅ here, none on the card (C10 a)', async () => {
    const me = await owner();
    const { draftId } = await draftFor(me);
    await h.handle(tg.callback(me.chat, nextMsg(), `ag:e:${draftId}`));
    const m = h.mark();
    await h.handle(tg.text(me.chat, 'b'.repeat(3800)));
    const answer = h.since(m).api.find((c) => c.method === 'sendMessage' && String(c.payload.text).startsWith('⛔ Matningiz kartaga qo‘yildi'));
    expect(answer, 'the refusal').toBeDefined();
    expect(String(answer!.payload.text)).toContain('kartaga sig‘maydi');
    expect(answer!.payload.reply_markup).toBeUndefined();
    expect((await draftOf(draftId)).blocked).toBe(false);
    const payload = await cardPayloadOf(draftId);
    expect(payload.blocked).toBe(true);
    expect(String(payload.text)).toContain('✅ yo‘q');
    expect(await cardSend(draftId)).toBeNull();
  });
});

describe('a card that cannot be checked or shown has no ✅ (C10)', () => {
  it('the run’s first queue of a reply too long for its card carries the block (createDraft)', async () => {
    const me = await owner();
    const { draftId } = await draftFor(me, { body: 'Ш'.repeat(3800) });
    const payload = await cardPayloadOf(draftId);
    expect(payload.blocked).toBe(true);
    expect(await cardSend(draftId)).toBeNull();
  });

  it('✅ on a machine draft with no stored memory: written as a block, the card loses ✅ and says why', async () => {
    const me = await owner();
    const { draftId } = await draftFor(me, { withMemory: false });
    const send = await cardSend(draftId);
    expect(send).not.toBeNull();
    const m = h.mark();
    await h.handle(tg.callback(me.chat, nextMsg(), send!));
    // The press's own toast names the door, not «✏️ bilan o'zingiz yozing».
    const toast = h.since(m).api.find((c) => c.method === 'answerCallbackQuery');
    expect(String(toast?.payload.text)).toBe('Bu matn shunday yuborilmaydi — «✏️ O‘zgartirish»ni bosing va to‘g‘ri matnni shu botga yozing.');
    const d = await draftOf(draftId);
    expect(d.status).toBe('pending');
    expect(d.blocked).toBe(true);
    expect((d.policy as { blocks: { code: string }[] }).blocks.map((b) => b.code)).toEqual(['memory_missing']);
    expect(await outboxOf(draftId)).toBeNull();
    expect(await cardSend(draftId)).toBeNull();
    expect(String((await cardPayloadOf(draftId)).text)).toContain(`• ${POLICY_WORDS.memory_missing}`);
  });
});

describe('his own Telegram reply is told apart from 🙋 (C6)', () => {
  it('retired by his reply: «Siz … o‘zingiz yozdingiz», cancelled, and the config’s pause', async () => {
    const me = await owner();
    const { draftId } = await draftFor(me);
    expect(await retireOnHumanReply(me.id, me.peer, me.anchor + 1n)).toBe(1);
    const text = String((await cardPayloadOf(draftId)).text);
    const pause = (await readAgentConfig())!.humanPauseMin;
    expect(text).toMatch(/✋ Siz mijozga Telegramda o‘zingiz yozdingiz \(\d\d:\d\d\) — AI javobi bekor qilindi\./u);
    expect(text).toContain(`Xabaringizdan keyin AI bu chatga ${pause} daqiqa yozmaydi.`);
    expect(text).not.toContain('🙋');
  });

  it('🙋 pressed: he took the chat, for the hours the press writes', async () => {
    const me = await owner();
    const { draftId } = await draftFor(me);
    await h.handle(tg.callback(me.chat, nextMsg(), `ag:h:${draftId}`));
    const d = await draftOf(draftId);
    expect(d.status).toBe('taken_over');
    expect(d.decidedBy).toBe(me.id);
    const text = String((await cardPayloadOf(draftId)).text);
    expect(text).toContain('🙋 Suhbatni o‘zingizga oldingiz — AI bu chatga 24 soat yozmaydi.');
    const [conv] = await db
      .select({ until: agentConversations.humanUntil })
      .from(agentConversations)
      .where(and(eq(agentConversations.managerUserId, me.id), eq(agentConversations.peerId, me.peer)));
    const hours = (conv!.until!.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
  });
});
