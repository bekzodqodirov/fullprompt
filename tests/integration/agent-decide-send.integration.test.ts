import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallModel } from '@/modules/platform/ai/model';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  agentConfig,
  agentConversations,
  agentDrafts,
  agentOutbox,
  agentRuns,
  attachments,
  clients,
  notifications,
  tgAccountGuard,
  tgAccounts,
  tgMessages,
  users,
} from '@/modules/platform/db/schema';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import { __restoreAgentConfig, readAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { decideDraft } from '@/modules/wms/agent/decide';
import { agentRowById, sendFactsFor } from '@/modules/wms/agent/outbox-store';
import { handleInbound } from '@/modules/wms/agent/run';
import { agentSendVerdict } from '@/modules/wms/agent/send-step';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';

/**
 * His ✅ against the send path's review findings (S2, S4, S11), on a real
 * database: what the press writes for a night-held reply, what the chat must
 * not have done since the draft, and which listener a reply may be handed to.
 * The run's own gate is asked through `handleInbound` with a scripted model.
 *
 * agent_config and the CRM's send switch are CONFIGURATION every later file
 * reads (#183): snapshotted in beforeAll, put back in afterAll. The fixture
 * person is deactivated, never deleted (the audit FK).
 */

const SUFFIX = String(Date.now()).slice(-6);
const PEER = BigInt(`78${SUFFIX}`);
let ownerId = '';
let accountId = '';
let clientId = '';
let snapshot: AgentConfig | null = null;
let sendingBefore = false;
let msgSeq = 5000n;
const madeFiles: string[] = [];

const actor = () => ({ id: ownerId, roles: ['super_admin'], permissions: new Set<string>(['crm.leads.view_all']) });
const ctx = () => ({ actorId: ownerId });

async function inbound(input: { body?: string | null; sentAt?: Date; hasMedia?: boolean } = {}): Promise<{ tgId: bigint; rowId: string }> {
  msgSeq += 1n;
  const [row] = await db
    .insert(tgMessages)
    .values({
      clientId,
      managerUserId: ownerId,
      peerId: PEER,
      tgMessageId: msgSeq,
      direction: 'in',
      body: input.body === undefined ? 'Yukim qayerda?' : input.body,
      hasMedia: input.hasMedia ?? false,
      sentAt: input.sentAt ?? new Date(Date.now() - 60_000),
    })
    .returning({ id: tgMessages.id });
  return { tgId: msgSeq, rowId: row!.id };
}

/** His own words on a pending draft — the owner subset of the policy, the smallest ✅ there is. */
async function pendingDraft(anchor: bigint): Promise<string> {
  const [d] = await db
    .insert(agentDrafts)
    .values({
      managerUserId: ownerId,
      peerId: PEER,
      anchorTgMessageId: anchor,
      clientId,
      status: 'pending',
      finalBody: 'Ertaga yetib keladi.',
    })
    .returning({ id: agentDrafts.id });
  return d!.id;
}

/** The reply «💵 Narx yozaman» drafts from the figure he typed — kind 'price', the machine's sentence of his number. */
async function priceDraft(anchor: bigint): Promise<string> {
  const [d] = await db
    .insert(agentDrafts)
    .values({
      managerUserId: ownerId,
      peerId: PEER,
      anchorTgMessageId: anchor,
      clientId,
      kind: 'price',
      status: 'pending',
      proposedBody: 'Hisob tayyor: yo‘lkira narxi — 1 200 $.',
    })
    .returning({ id: agentDrafts.id });
  return d!.id;
}

/** An approved reply waiting on the pump, written as the ✅ writes it — for a chat whose drafts a test shaped itself. */
async function approvedRowFor(anchor: bigint) {
  const [d] = await db
    .insert(agentDrafts)
    .values({ managerUserId: ownerId, peerId: PEER, anchorTgMessageId: anchor, clientId, status: 'approved' })
    .returning({ id: agentDrafts.id });
  const [o] = await db
    .insert(agentOutbox)
    .values({
      draftId: d!.id,
      managerUserId: ownerId,
      peerId: PEER,
      clientId,
      body: 'Ertaga yetib keladi.',
      randomId: BigInt(`9${SUFFIX}${msgSeq}`),
      answersTgMessageId: anchor,
      queuedBy: ownerId,
    })
    .returning({ id: agentOutbox.id });
  return (await agentRowById(o!.id))!;
}

async function outboxOf(draftId: string) {
  const [o] = await db.select().from(agentOutbox).where(eq(agentOutbox.draftId, draftId));
  return o ?? null;
}

async function clearChat() {
  await db.delete(agentConversations).where(eq(agentConversations.peerId, PEER));
  await db.delete(agentOutbox).where(eq(agentOutbox.peerId, PEER));
  await db.delete(agentDrafts).where(eq(agentDrafts.peerId, PEER));
  await db.delete(agentRuns).where(eq(agentRuns.peerId, PEER));
  if (madeFiles.length) await db.delete(attachments).where(inArray(attachments.id, madeFiles.splice(0)));
  await db.delete(tgMessages).where(eq(tgMessages.peerId, PEER));
}

beforeAll(async () => {
  snapshot = await readAgentConfig();
  sendingBefore = (await getSetting('tg_sending_enabled')) === true;
  const [u] = await db
    .insert(users)
    .values({ phone: `+99893${SUFFIX}07`, fullName: `AI ✅ egasi ${SUFFIX}`, passwordHash: 'x' })
    .returning({ id: users.id });
  ownerId = u!.id;
  const [acc] = await db
    .insert(tgAccounts)
    .values({ managerUserId: ownerId, tgPhone: `+99894${SUFFIX}07`, sessionEnc: 'v1.x.y.z', status: 'active', lastSeenAt: new Date() })
    .returning({ id: tgAccounts.id });
  accountId = acc!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `AD${SUFFIX}`, name: `Decide mijoz ${SUFFIX}`, salesManagerId: ownerId })
    .returning({ id: clients.id });
  clientId = c!.id;
  await db
    .update(agentConfig)
    .set({
      mode: 'shadow',
      ownerUserId: ownerId,
      sessionExclusiveAt: new Date(),
      sessionExclusiveBy: ownerId,
      startedAt: new Date(Date.now() - 30 * 86_400_000),
      dailyDraftCap: 150,
      dailyTokenCap: 3_000_000,
    })
    .where(eq(agentConfig.id, 1));
  await setSetting('tg_sending_enabled', true, ownerId);
});

beforeEach(async () => {
  await clearChat();
  await stampAgentPump(accountId, true);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await clearChat();
  await db.delete(notifications).where(eq(notifications.userId, ownerId));
  await db.delete(tgAccountGuard).where(eq(tgAccountGuard.accountId, accountId));
  await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await __restoreAgentConfig(snapshot);
  await setSetting('tg_sending_enabled', sendingBefore, ownerId);
  await db.update(users).set({ active: false }).where(eq(users.id, ownerId));
  await pgClient.end();
});

describe('which listener a ✅ may be handed to (S11)', () => {
  it('a fresh pump whose start-up catch-up has not finished is refused in words — and taken once it has', async () => {
    const { tgId } = await inbound();
    const draftId = await pendingDraft(tgId);
    // The listener's first stamp of a process: alive, the gap not walked.
    await stampAgentPump(accountId, false);
    expect(await decideDraft(actor(), draftId, 'send', {}, ctx())).toEqual({ ok: false, code: 'listener_behind' });
    expect(await outboxOf(draftId)).toBeNull();
    await stampAgentPump(accountId, true);
    expect(await decideDraft(actor(), draftId, 'send', {}, ctx())).toMatchObject({ ok: true, status: 'approved' });
  });

  it('the run does NOT ask the walk: a line written during a restart’s catch-up is drafted, and its ✅ waits (S11’s follow-up)', async () => {
    // Every restart NULLs the catch-up stamp until the walk is done, and the walk can take minutes. A run
    // refused then writes a refused ledger row, and the sweep's deploy-gap pass skips any anchor that has
    // one — the line would never be drafted unless the customer wrote again.
    const { tgId } = await inbound();
    await stampAgentPump(accountId, false);
    const compose = (async () => ({
      stopReason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'compose_reply',
          input: {
            reply_needed: true,
            reply_text: 'Tekshirib aytaman.',
            language: 'uz',
            gloss_uz: '',
            category: 'status',
            confidence: 0.8,
            needs_owner: false,
            owner_question: '',
            next_step: 'wait',
            actions: [],
            used_fact_ids: [],
            cited_message_refs: [],
          },
        },
      ],
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })) as unknown as CallModel;
    const out = await handleInbound(
      { managerUserId: ownerId, peerId: String(PEER), anchorTgMessageId: String(tgId), origin: 'live' },
      { callModel: compose },
    );
    expect(out).toMatchObject({ outcome: 'draft' });
    const runs = await db.select().from(agentRuns).where(eq(agentRuns.peerId, PEER));
    expect(runs.map((r) => r.outcome), 'never the refused row the deploy-gap pass skips for good').not.toContain('refused');
    // The card's ✅ is what waits for the walk — refused in words until it is done, taken once it is.
    const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.peerId, PEER));
    expect(await decideDraft(actor(), d!.id, 'send', {}, ctx())).toEqual({ ok: false, code: 'listener_behind' });
    await stampAgentPump(accountId, true);
    expect(await decideDraft(actor(), d!.id, 'send', {}, ctx())).toMatchObject({ ok: true, status: 'approved' });
  });
});

describe('the night (his Q14 ⭐, S2)', () => {
  it('a ✅ at 23:30 for a customer who wrote three hours ago is held to 08:30 — and says so on the row', async () => {
    // Only Date is faked: the database and the driver's timers keep the real clock.
    const night = new Date('2026-11-02T18:30:00Z'); // 23:30 Tashkent
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(night);
    // The listener's stamps on the same clock as the press.
    await db.update(tgAccountGuard).set({ agentPumpAt: night, caughtUpAt: night }).where(eq(tgAccountGuard.accountId, accountId));
    const { tgId } = await inbound({ sentAt: new Date(night.getTime() - 3 * 3_600_000) });
    const draftId = await pendingDraft(tgId);
    const r = await decideDraft(actor(), draftId, 'send', {}, ctx());
    const morning = new Date('2026-11-03T03:30:00Z'); // 08:30 Tashkent
    expect(r).toMatchObject({ ok: true, status: 'approved', sendAt: morning });
    const o = await outboxOf(draftId);
    expect(o!.queuedAt.getTime()).toBe(night.getTime());
    expect(o!.nextStepAt.getTime()).toBe(morning.getTime());
    expect(o!.releaseAt?.getTime(), 'the approval’s age counts from the morning').toBe(morning.getTime());
  });

  it('by day the press holds nothing and records no release', async () => {
    const { tgId } = await inbound();
    const draftId = await pendingDraft(tgId);
    expect(await decideDraft(actor(), draftId, 'send', {}, ctx())).toMatchObject({ ok: true });
    expect((await outboxOf(draftId))!.releaseAt).toBeNull();
  });
});

describe('what the chat did since the draft (S4)', () => {
  it('a photo the customer sent after the question turns ✅ into «superseded»; a sticker does not', async () => {
    const { tgId } = await inbound();
    const stickered = await pendingDraft(tgId);
    // A sticker: has_media, no text, no file kept — the «👍» it stands for.
    await inbound({ body: null, hasMedia: true, sentAt: new Date(Date.now() - 30_000) });
    expect(await decideDraft(actor(), stickered, 'send', {}, ctx())).toMatchObject({ ok: true, status: 'approved' });

    await clearChat();
    const asked = await inbound();
    const draftId = await pendingDraft(asked.tgId);
    const photo = await inbound({ body: null, hasMedia: true, sentAt: new Date(Date.now() - 30_000) });
    const [file] = await db
      .insert(attachments)
      .values({
        entityType: 'tg_message',
        entityId: photo.rowId,
        kind: 'photo',
        storageKey: `agent-decide-test/${SUFFIX}/${photo.rowId}`,
        fileName: 'invoice.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 10,
        uploadedBy: ownerId,
      })
      .returning({ id: attachments.id });
    madeFiles.push(file!.id);
    expect(await decideDraft(actor(), draftId, 'send', {}, ctx())).toEqual({ ok: false, code: 'superseded' });
    expect(await outboxOf(draftId)).toBeNull();
  });
});

describe('his 🙋 and a ✅ he gives after it (final review K2’s follow-up)', () => {
  const stepCtx = () => ({ accountId, caughtUp: () => true, random: () => 0 });

  it('the press withdraws the reply approved before it, and never the price he approves after it', async () => {
    // A reply approved and still waiting (here: nothing has stepped it yet).
    const asked = await inbound();
    const before = await pendingDraft(asked.tgId);
    expect(await decideDraft(actor(), before, 'send', {}, ctx())).toMatchObject({ ok: true, status: 'approved' });
    const waiting = (await agentRowById((await outboxOf(before))!.id))!;
    // The customer asks again, the agent drafts, and he takes the chat: 🙋 «24 soat menda».
    const again = await inbound({ body: 'Narxi qancha bo‘ladi?', sentAt: new Date(Date.now() - 30_000) });
    const taken = await pendingDraft(again.tgId);
    expect(await decideDraft(actor(), taken, 'human', {}, ctx())).toMatchObject({ ok: true, status: 'taken_over' });
    const [press] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, taken));
    // The VED answers while the chat is his; he types the price through «💵 Narx yozaman» and approves it.
    const price = await priceDraft(again.tgId);
    expect(await decideDraft(actor(), price, 'send', {}, ctx())).toMatchObject({ ok: true, status: 'approved' });
    const priced = (await agentRowById((await outboxOf(price))!.id))!;

    // Both rows read the same press — the one `decideDraft` itself wrote — and the chat still his.
    const now = new Date();
    const forBefore = await sendFactsFor(waiting, now, stepCtx());
    const forPrice = await sendFactsFor(priced, now, stepCtx());
    expect(forBefore.humanUntil!.getTime()).toBeGreaterThan(now.getTime());
    expect(forBefore.humanPressedAt?.getTime()).toBe(press!.decidedAt!.getTime());
    expect(forPrice.humanPressedAt?.getTime()).toBe(press!.decidedAt!.getTime());
    // Approved before the press: withdrawn, in the draft's own words.
    expect(agentSendVerdict(waiting, forBefore)).toEqual({ ok: false, final: true, reason: 'human_replied' });
    // Approved after it: his own word goes — not «o'zingiz javob berdingiz», not withdrawn.
    expect(agentSendVerdict(priced, forPrice)).toEqual({ ok: true });
  });

  it('the machine’s own «he answered himself» is no press: it withdraws nothing a later ✅ approved', async () => {
    const asked = await inbound();
    const d = await pendingDraft(asked.tgId);
    // He answers from his phone; the human-reply job retires the live draft — `taken_over`, decided by nobody.
    msgSeq += 1n;
    await db.insert(tgMessages).values({
      clientId,
      managerUserId: ownerId,
      peerId: PEER,
      tgMessageId: msgSeq,
      direction: 'out',
      body: 'Ertaga keladi, aka.',
      sentAt: new Date(),
    });
    const { retireOnHumanReply } = await import('@/modules/wms/agent/jobs');
    expect(await retireOnHumanReply(ownerId, PEER, msgSeq)).toBe(1);
    const [retired] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, d));
    expect(retired!.status).toBe('taken_over');
    // A 🙋 of his days ago left the chat his until now (the press itself is the first test's).
    await db.insert(agentConversations).values({ managerUserId: ownerId, peerId: PEER, humanUntil: new Date(Date.now() + 3_600_000) });
    const row = { ...(await approvedRowFor(asked.tgId)) };
    // The machine's retire is newer than every approval here, and still no press: none is on record.
    expect((await sendFactsFor(row, new Date(), stepCtx())).humanPressedAt).toBeNull();
  });
});
