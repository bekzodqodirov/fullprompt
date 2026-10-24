import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallModel } from '@/modules/platform/ai/model';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  agentConfig,
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
import { handleInbound } from '@/modules/wms/agent/run';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';

/**
 * His ✅ against the send path's review findings (S2, S4, S11), on a real
 * database: what the press writes for a night-held reply, what the chat must
 * not have done since the draft, and which listener a reply may be handed to.
 * The run's own gate (S11) is asked through `handleInbound` with a model that
 * must never be called — the refusal comes before it.
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

async function outboxOf(draftId: string) {
  const [o] = await db.select().from(agentOutbox).where(eq(agentOutbox.draftId, draftId));
  return o ?? null;
}

async function clearChat() {
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

  it('the run asks the same: no draft is written for a listener still walking its gap', async () => {
    const { tgId } = await inbound();
    await stampAgentPump(accountId, false);
    const never = (async () => {
      throw new Error('the model must not be called');
    }) as unknown as CallModel;
    const out = await handleInbound(
      { managerUserId: ownerId, peerId: String(PEER), anchorTgMessageId: String(tgId), origin: 'live' },
      { callModel: never },
    );
    expect(out).toEqual({ outcome: 'refused', reason: 'listener_behind' });
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
