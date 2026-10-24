import 'dotenv/config';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The drain kick of an alarm would start pg-boss inside the test process;
 * the alarm's ROW is what this file asserts, so the kick is caught here.
 */
const queuedJobs = vi.hoisted(() => [] as { name: string; data: unknown }[]);
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async (name: string, data: unknown) => {
    queuedJobs.push({ name, data });
  }),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  agentConfig,
  agentConversations,
  agentDrafts,
  agentOutbox,
  attachments,
  clients,
  leads,
  leadStages,
  notifications,
  tgAccountFloods,
  tgAccountGuard,
  tgAccounts,
  tgChatRules,
  tgMessageFlags,
  tgMessages,
  users,
} from '@/modules/platform/db/schema';
import { __restoreAgentConfig, readAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import {
  __forgetOwnAverage,
  agentRowById,
  applyAgentOutcome,
  badgeRestored,
  badgesToRestore,
  claimAgentSend,
  dueAgentRow,
  recoverAgentInFlight,
  sendFactsFor,
} from '@/modules/wms/agent/outbox-store';
import type { AgentOutboxRow, StepOutcome } from '@/modules/wms/agent/send-step';
import type { AlarmAccount } from '@/modules/wms/crm/account-alarm';
import { readGuard, recordFlood } from '@/modules/wms/crm/account-guard';
import { clientHasWritten, recordSent } from '@/modules/wms/crm/outbox';
import { tgErrorKind } from '@/modules/wms/crm/telegram-guard';
import { Api } from 'telegram';
import { RPCMessageToError } from 'telegram/errors';

/**
 * The agent pump's database half against a real database (spec §17.8-§17.9):
 * every fact the send verdict decides from, read at the tick, and what each
 * step's outcome writes — the pause, the forced «off», the ledger, the echo.
 *
 * agent_config is a SINGLETON every later file reads (#183): it is
 * snapshotted in beforeAll and put back in afterAll.
 */

const STAMP = Date.now();
const BASE = BigInt(STAMP) * 1000n;
let seq = 0n;
/** A peer id, a Telegram message id, a random_id — each fresh, never colliding with another file's. */
const next = () => BASE + ++seq;

let configBefore: AgentConfig | null = null;
const startedAt = new Date();

const madeUsers: string[] = [];
const madeAccounts: string[] = [];
const madeFiles: string[] = [];
let managerId: string;
let account: AlarmAccount;
let clientId: string;
let otherClientId: string;
let leadId: string;

function tgError(name: string, code = 400): Error {
  return RPCMessageToError(
    new Api.RpcError({ errorCode: code, errorMessage: name }),
    new Api.messages.SendMessage({ peer: 'me', message: 'x' }),
  );
}

async function makeManager(tag: string): Promise<{ userId: string; account: AlarmAccount }> {
  const [user] = await db
    .insert(users)
    .values({
      phone: `+99894${String(STAMP + madeUsers.length).slice(-7)}`,
      fullName: `Agent outbox ${tag} ${STAMP}`,
      passwordHash: 'x',
    })
    .returning({ id: users.id, name: users.fullName });
  madeUsers.push(user!.id);
  const [acc] = await db
    .insert(tgAccounts)
    .values({
      managerUserId: user!.id,
      tgPhone: `+99895${String(STAMP + madeAccounts.length).slice(-7)}`,
      sessionEnc: 'v1.x.y.z',
      status: 'active',
      lastSeenAt: new Date(),
    })
    .returning({ id: tgAccounts.id });
  madeAccounts.push(acc!.id);
  return { userId: user!.id, account: { id: acc!.id, managerUserId: user!.id, managerName: user!.name } };
}

async function message(input: {
  manager?: string;
  peer: bigint;
  id: bigint;
  direction: 'in' | 'out';
  body?: string | null;
  client?: string | null;
  lead?: string | null;
  sentAt?: Date;
  hasMedia?: boolean;
}): Promise<string> {
  const [row] = await db
    .insert(tgMessages)
    .values({
      clientId: input.lead ? null : (input.client ?? clientId),
      leadId: input.lead ?? null,
      managerUserId: input.manager ?? managerId,
      peerId: input.peer,
      tgMessageId: input.id,
      direction: input.direction,
      body: input.body === undefined ? 'Salom, yukim qayerda?' : input.body,
      hasMedia: input.hasMedia ?? false,
      sentAt: input.sentAt ?? new Date(),
    })
    .returning({ id: tgMessages.id });
  return row!.id;
}

/** The file the listener keeps from a photo, a voice note, a document — pinned to its message row. */
async function keptFile(messageRowId: string): Promise<void> {
  const [file] = await db
    .insert(attachments)
    .values({
      entityType: 'tg_message',
      entityId: messageRowId,
      kind: 'photo',
      storageKey: `agent-outbox-test/${STAMP}/${messageRowId}`,
      fileName: 'photo.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 10,
      uploadedBy: managerId,
    })
    .returning({ id: attachments.id });
  madeFiles.push(file!.id);
}

/** A chat with its anchor stored, a draft, and an approved reply waiting on the pump. */
async function approved(input: {
  manager?: string;
  peer?: bigint;
  anchor?: bigint;
  client?: string | null;
  lead?: string | null;
  storeAnchor?: boolean;
  status?: 'agent' | 'sending' | 'sent' | 'unknown';
  step?: 'verify' | 'read' | 'typing' | 'send';
  nextStepAt?: Date;
  sentAt?: Date;
  stepClaimedAt?: Date;
  readDone?: boolean;
}): Promise<{ row: AgentOutboxRow; peer: bigint; anchor: bigint; anchorRowId: string | null; draftId: string }> {
  const manager = input.manager ?? managerId;
  const peer = input.peer ?? next();
  const anchor = input.anchor ?? next();
  const owner = input.lead ? { clientId: null, leadId: input.lead } : { clientId: input.client ?? clientId, leadId: null };
  const anchorRowId =
    input.storeAnchor === false
      ? null
      : await message({ manager, peer, id: anchor, direction: 'in', client: owner.clientId, lead: owner.leadId });
  const [draft] = await db
    .insert(agentDrafts)
    .values({ managerUserId: manager, peerId: peer, anchorTgMessageId: anchor, ...owner, status: 'approved' })
    .returning({ id: agentDrafts.id });
  const status = input.status ?? 'agent';
  const [out] = await db
    .insert(agentOutbox)
    .values({
      draftId: draft!.id,
      managerUserId: manager,
      peerId: peer,
      ...owner,
      body: 'Assalomu alaykum! Yukingiz Toshkentda.',
      randomId: next(),
      answersTgMessageId: anchor,
      status,
      step: input.step ?? 'verify',
      nextStepAt: input.nextStepAt ?? new Date(Date.now() - 1000),
      readDone: input.readDone ?? false,
      queuedBy: manager,
      sentAt: status === 'sent' ? (input.sentAt ?? new Date()) : null,
      stepClaimedAt: input.stepClaimedAt ?? null,
    })
    .returning({ id: agentOutbox.id });
  return { row: (await agentRowById(out!.id))!, peer, anchor, anchorRowId, draftId: draft!.id };
}

const ctx = (accountId: string) => ({ accountId, caughtUp: () => true, random: () => 0 });

async function agentOn(owner: string, started: Date = new Date(Date.now() - 30 * 86_400_000)): Promise<void> {
  await db
    .update(agentConfig)
    .set({ mode: 'shadow', ownerUserId: owner, sessionExclusiveAt: new Date(), sessionExclusiveBy: owner, startedAt: started })
    .where(eq(agentConfig.id, 1));
}

async function agentOff(): Promise<void> {
  await db
    .update(agentConfig)
    .set({ mode: 'off', ownerUserId: null, sessionExclusiveAt: null, sessionExclusiveBy: null, startedAt: null })
    .where(eq(agentConfig.id, 1));
}

beforeAll(async () => {
  configBefore = await readAgentConfig();
  const made = await makeManager('main');
  managerId = made.userId;
  account = made.account;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `AO${String(STAMP).slice(-8)}`, name: `Agent outbox ${STAMP}`, phones: ['+998901112233'] })
    .returning({ id: clients.id });
  clientId = c!.id;
  const [o] = await db
    .insert(clients)
    .values({ clientCode: `AP${String(STAMP).slice(-8)}`, name: `Agent outbox other ${STAMP}` })
    .returning({ id: clients.id });
  otherClientId = o!.id;
  const stage = await db.query.leadStages.findFirst({ where: eq(leadStages.kind, 'open') });
  const [l] = await db
    .insert(leads)
    .values({ name: `Agent outbox lead ${STAMP}`, stageId: stage!.id, ownerId: managerId })
    .returning({ id: leads.id });
  leadId = l!.id;
  await agentOff();
});

afterAll(async () => {
  await __restoreAgentConfig(configBefore);
  // Alarms go to the manager AND every super_admin: this file's own rows only.
  await db
    .delete(notifications)
    .where(
      and(
        inArray(notifications.type, ['TgAccountPaused', 'AgentForcedOff']),
        gte(notifications.createdAt, startedAt),
      ),
    );
  if (madeFiles.length) await db.delete(attachments).where(inArray(attachments.id, madeFiles));
  if (madeUsers.length) {
    await db.delete(notifications).where(inArray(notifications.userId, madeUsers));
    await db.delete(agentOutbox).where(inArray(agentOutbox.managerUserId, madeUsers));
    await db.delete(agentDrafts).where(inArray(agentDrafts.managerUserId, madeUsers));
    await db.delete(agentConversations).where(inArray(agentConversations.managerUserId, madeUsers));
    await db.delete(tgChatRules).where(inArray(tgChatRules.managerUserId, madeUsers));
    await db.delete(tgMessages).where(inArray(tgMessages.managerUserId, madeUsers));
  }
  if (madeAccounts.length) {
    await db.delete(tgAccountFloods).where(inArray(tgAccountFloods.accountId, madeAccounts));
    await db.delete(tgAccountGuard).where(inArray(tgAccountGuard.accountId, madeAccounts));
    await db.delete(tgAccounts).where(inArray(tgAccounts.id, madeAccounts));
  }
  await db.delete(leads).where(eq(leads.id, leadId));
  await db.delete(clients).where(inArray(clients.id, [clientId, otherClientId]));
  for (const id of madeUsers) {
    // A fixture person somebody else's row may point at stays, deactivated.
    await db
      .delete(users)
      .where(eq(users.id, id))
      .catch(() => db.update(users).set({ active: false }).where(eq(users.id, id)));
  }
  await pgClient.end();
});

describe('the facts a send is decided from', () => {
  it('reads the anchor and finds nothing against the reply', async () => {
    const { row } = await approved({});
    const f = await sendFactsFor(row, new Date(), ctx(account.id));
    expect(f.anchorSentAt).toBeInstanceOf(Date);
    expect(f.anchorDeleted).toBe(false);
    expect(f.anchorEditedSinceDraft).toBe(false);
    expect(f.humanReplied).toBe(false);
    expect(f.newerSubstantiveInbound).toBe(false);
    expect(f.peerHasWritten).toBe(true);
    expect(f.conversationMuted).toBe(false);
    expect(f.ruleExcluded).toBe(false);
    expect(f.identityChanged).toBe(false);
    expect(f.offerStands).toBeNull();
    expect(f.caughtUp).toBe(true);
    expect(f.accountPaused).toBe(false);
    // The agent is off for this file until a test switches it on.
    expect(f.agentOn).toBe(false);
  });

  it('his own line after the anchor is a human reply; an AI send of ours is not', async () => {
    const { row, peer, anchor } = await approved({});
    // An earlier AI reply that went out after the anchor (its echo is a stored out row).
    const aiId = anchor + 1n;
    await message({ peer, id: aiId, direction: 'out', body: 'AI javobi' });
    const earlier = await approved({ peer, anchor: next(), storeAnchor: false, status: 'sent' });
    await db.update(agentOutbox).set({ tgMessageId: aiId }).where(eq(agentOutbox.id, earlier.row.id));
    expect((await sendFactsFor(row, new Date(), ctx(account.id))).humanReplied).toBe(false);
    // His phone, or the CRM: an out row no agent_outbox row wrote.
    await message({ peer, id: anchor + 2n, direction: 'out', body: 'Men o‘zim javob beraman' });
    expect((await sendFactsFor(row, new Date(), ctx(account.id))).humanReplied).toBe(true);
  });

  it('a nudge after the anchor keeps the reply, a new question supersedes it, a deleted one does not', async () => {
    const { row, peer, anchor } = await approved({});
    await message({ peer, id: anchor + 1n, direction: 'in', body: '??' });
    expect((await sendFactsFor(row, new Date(), ctx(account.id))).newerSubstantiveInbound).toBe(false);
    const question = await message({ peer, id: anchor + 2n, direction: 'in', body: 'Narxi qancha bo‘ladi?' });
    expect((await sendFactsFor(row, new Date(), ctx(account.id))).newerSubstantiveInbound).toBe(true);
    await db.insert(tgMessageFlags).values({ messageId: question, deletedAt: new Date() });
    expect((await sendFactsFor(row, new Date(), ctx(account.id))).newerSubstantiveInbound).toBe(false);
  });

  it('a deleted anchor is gone, and so is one never stored', async () => {
    const { row, anchorRowId } = await approved({});
    await db.insert(tgMessageFlags).values({ messageId: anchorRowId!, deletedAt: new Date() });
    expect((await sendFactsFor(row, new Date(), ctx(account.id))).anchorDeleted).toBe(true);
    const missing = await approved({ storeAnchor: false });
    expect((await sendFactsFor(missing.row, new Date(), ctx(account.id))).anchorSentAt).toBeNull();
  });

  it('an anchor edited after the draft read it is a different question (regression-10)', async () => {
    const { row, anchorRowId, draftId } = await approved({});
    const edited = new Date();
    await db.update(tgMessages).set({ editedAt: edited }).where(eq(tgMessages.id, anchorRowId!));
    expect((await sendFactsFor(row, new Date(), ctx(account.id))).anchorEditedSinceDraft).toBe(true);
    // The draft that already read the edited text is not stale.
    await db.update(agentDrafts).set({ anchorEditedAt: edited }).where(eq(agentDrafts.id, draftId));
    expect((await sendFactsFor(row, new Date(), ctx(account.id))).anchorEditedSinceDraft).toBe(false);
  });

  it('G7 is per PEER: the client wrote from one Telegram, this one never did (ban-8)', async () => {
    const wrote = next();
    await message({ peer: wrote, id: next(), direction: 'in' });
    expect(await clientHasWritten(clientId, managerId), 'the old per-client rule says yes').toBe(true);
    const silent = next();
    // The anchor of a reply to a peer that never wrote is a stored OUT row of
    // ours — the shape a stale or forged draft would have.
    const anchor = next();
    await message({ peer: silent, id: anchor, direction: 'out', body: 'Assalomu alaykum' });
    const { row } = await approved({ peer: silent, anchor, storeAnchor: false });
    expect((await sendFactsFor(row, new Date(), ctx(account.id))).peerHasWritten).toBe(false);
  });

  it('the chat now names another client (leak-4)', async () => {
    const { row, peer, anchor } = await approved({});
    await message({ peer, id: anchor + 1n, direction: 'in', client: otherClientId, body: 'ok' });
    expect((await sendFactsFor(row, new Date(), ctx(account.id))).identityChanged).toBe(true);
  });

  it('a lead chat whose lead was won keeps its identity', async () => {
    const { row, peer, anchor } = await approved({ lead: leadId });
    // storeIncoming fills the client beside a won lead; the lead is still the chat's.
    await db.insert(tgMessages).values({
      clientId,
      leadId,
      managerUserId: managerId,
      peerId: peer,
      tgMessageId: anchor + 1n,
      direction: 'in',
      body: 'rahmat',
      sentAt: new Date(),
    });
    expect((await sendFactsFor(row, new Date(), ctx(account.id))).identityChanged).toBe(false);
  });

  it('a muted conversation and an excluded chat', async () => {
    const { row, peer } = await approved({});
    await db.insert(agentConversations).values({ managerUserId: managerId, peerId: peer, mutedAt: new Date(), muteReason: 'test' });
    await db.insert(tgChatRules).values({ managerUserId: managerId, peerId: peer, decision: 'exclude' });
    const f = await sendFactsFor(row, new Date(), ctx(account.id));
    expect(f.conversationMuted).toBe(true);
    expect(f.ruleExcluded).toBe(true);
  });

  it('caps count AI sends on this account by the Tashkent day and the last hour', async () => {
    // Its own person: no other test's sends may land in its windows.
    const own = await makeManager('caps');
    const now = new Date('2025-03-10T10:00:00Z'); // 15:00 Tashkent; the day began 2025-03-09T19:00Z
    const peer = next();
    const { row } = await approved({ manager: own.userId, peer });
    await approved({ manager: own.userId, peer, storeAnchor: false, status: 'sent', sentAt: new Date(now.getTime() - 10 * 60_000) });
    await approved({ manager: own.userId, storeAnchor: false, status: 'sent', sentAt: new Date(now.getTime() - 2 * 3_600_000) });
    // Yesterday in Tashkent (18:00Z is 23:00 local on the 9th): in no window.
    await approved({ manager: own.userId, peer, storeAnchor: false, status: 'sent', sentAt: new Date('2025-03-09T18:00:00Z') });
    const f = await sendFactsFor(row, now, ctx(own.account.id));
    expect(f.sentToChatToday).toBe(1);
    expect(f.sentLastHour).toBe(1);
    expect(f.sentToday).toBe(2);
    expect(f.lastChatSendAt?.getTime()).toBe(now.getTime() - 10 * 60_000);
    expect(f.lastAccountSendAt?.getTime()).toBe(now.getTime() - 10 * 60_000);
  });

  it('just after Tashkent midnight the last hour is not today (#1063’s trap)', async () => {
    const own = await makeManager('midnight');
    const now = new Date('2025-03-10T19:30:00Z'); // 00:30 Tashkent on the 11th; the day began at 19:00Z
    const peer = next();
    const { row } = await approved({ manager: own.userId, peer });
    // 23:45 yesterday in Tashkent: inside the last hour, outside the day.
    await approved({ manager: own.userId, peer, storeAnchor: false, status: 'sent', sentAt: new Date('2025-03-10T18:45:00Z') });
    await approved({ manager: own.userId, storeAnchor: false, status: 'sent', sentAt: new Date('2025-03-10T19:10:00Z') });
    const f = await sendFactsFor(row, now, ctx(own.account.id));
    expect(f.sentLastHour).toBe(2);
    expect(f.sentToday).toBe(1);
    expect(f.sentToChatToday, 'the chat’s only send was yesterday').toBe(0);
    expect(f.lastChatSendAt?.toISOString(), 'but the per-chat gap still sees it').toBe('2025-03-10T18:45:00.000Z');
  });

  it('the ramp is his own average from the 30 days before the start (his Q11 ⭐)', async () => {
    const own = await makeManager('ramp');
    const started = new Date('2025-06-01T06:00:00Z');
    const peer = next();
    for (let i = 0; i < 90; i += 1) {
      await message({
        manager: own.userId,
        peer,
        id: next(),
        direction: 'out',
        body: `javob ${i}`,
        sentAt: new Date(started.getTime() - (i + 1) * 6 * 3_600_000),
      });
    }
    await agentOn(own.userId, started);
    __forgetOwnAverage();
    try {
      const { row } = await approved({ manager: own.userId, peer, storeAnchor: false });
      const f = await sendFactsFor(row, new Date(started.getTime() + 86_400_000), ctx(own.account.id));
      // 90 of his replies in the 30 days before → 3 a day.
      expect(f.dailyCeiling).toBe(3);
      expect(f.agentOn).toBe(true);
      expect(f.ownerUserId).toBe(own.userId);
    } finally {
      await agentOff();
    }
  });
});

describe('what each outcome writes', () => {
  it('sent: the row, then the thread’s copy of it', async () => {
    const { row, peer } = await approved({ status: 'agent', step: 'send' });
    expect(await claimAgentSend(row.id)).toBe(true);
    expect(await claimAgentSend(row.id), 'the CAS is taken once').toBe(false);
    const tgId = next();
    const report = await applyAgentOutcome(row, { kind: 'sent', tgMessageId: tgId }, account);
    expect(report).toEqual({ final: true, markUnread: false, sessionDead: null });
    const after = await agentRowById(row.id);
    expect(after?.status).toBe('sent');
    const [echo] = await db
      .select()
      .from(tgMessages)
      .where(and(eq(tgMessages.managerUserId, managerId), eq(tgMessages.peerId, peer), eq(tgMessages.tgMessageId, tgId)));
    expect(echo?.direction).toBe('out');
    expect(echo?.clientId).toBe(clientId);
    // Applying the same outcome again (the held-outcome retry) changes nothing.
    await applyAgentOutcome(row, { kind: 'sent', tgMessageId: tgId }, account);
    expect((await agentRowById(row.id))?.status).toBe('sent');
  });

  it('sent to a LEAD: the echo carries the lead (regression-2)', async () => {
    const { row, peer } = await approved({ lead: leadId, step: 'send' });
    await claimAgentSend(row.id);
    const tgId = next();
    await applyAgentOutcome(row, { kind: 'sent', tgMessageId: tgId }, account);
    const [echo] = await db
      .select()
      .from(tgMessages)
      .where(and(eq(tgMessages.managerUserId, managerId), eq(tgMessages.peerId, peer), eq(tgMessages.tgMessageId, tgId)));
    expect(echo?.leadId).toBe(leadId);
  });

  it('cancel after the read gives the badge back (regression-12)', async () => {
    const { row } = await approved({ step: 'typing', readDone: true });
    const report = await applyAgentOutcome(row, { kind: 'cancel', reason: 'human_replied', markUnread: true }, account);
    expect(report.markUnread).toBe(true);
    const after = await db.select().from(agentOutbox).where(eq(agentOutbox.id, row.id));
    expect(after[0]?.status).toBe('cancelled');
    expect(after[0]?.lastError).toBe('human_replied');
  });

  it('unknown is final and is never picked again (ban-5)', async () => {
    const own = await makeManager('unknown');
    const { row } = await approved({ manager: own.userId, step: 'send' });
    await claimAgentSend(row.id);
    await applyAgentOutcome(row, { kind: 'unknown', reason: 'Timeout' }, own.account);
    expect((await agentRowById(row.id))?.status).toBe('unknown');
    expect(await dueAgentRow(own.userId, new Date(Date.now() + 86_400_000))).toBeNull();
  });

  it('flooded: back to waiting until Telegram’s end, the wait persisted uncapped; a second send flood switches the agent off', async () => {
    const own = await makeManager('flood');
    await agentOn(own.userId);
    try {
      const { row } = await approved({ manager: own.userId, step: 'send' });
      await claimAgentSend(row.id);
      const before = Date.now();
      // Two hours — far past the human clock's old one-hour cap.
      await applyAgentOutcome(row, { kind: 'flooded', seconds: 7200, method: 'messages.SendMessage' }, own.account);
      const after = await agentRowById(row.id);
      expect(after?.status).toBe('agent');
      expect(after!.nextStepAt.getTime()).toBeGreaterThanOrEqual(before + 7200_000);
      const guard = await readGuard(own.account.id);
      expect(guard.floodUntil!.getTime()).toBeGreaterThanOrEqual(before + 7200_000);
      expect((await readAgentConfig())?.mode, 'one flood is not two').toBe('shadow');

      await applyAgentOutcome(row, { kind: 'flooded', seconds: 30, method: 'messages.SendMessage' }, own.account);
      expect((await readAgentConfig())?.mode).toBe('off');
      // The flooded row was waiting again, so the forced «off» swept it with the rest.
      expect((await agentRowById(row.id))?.status).toBe('cancelled');
      const alarms = await db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, own.userId), eq(notifications.type, 'AgentForcedOff')));
      expect(alarms).toHaveLength(1);
      const floods = await db.select().from(tgAccountFloods).where(eq(tgAccountFloods.accountId, own.account.id));
      expect(floods.map((f) => f.source).sort()).toEqual(['raise', 'raise']);
      // The alarm's drain kick was caught here, never sent.
      expect(queuedJobs.length).toBeGreaterThan(0);
    } finally {
      await agentOff();
    }
  });

  it('restricted: the account paused, the agent off, the approved replies cancelled, ONE alarm (ban-1, ban-10)', async () => {
    const own = await makeManager('restricted');
    await agentOn(own.userId);
    try {
      const { row } = await approved({ manager: own.userId, step: 'send' });
      const waiting = await approved({ manager: own.userId });
      await claimAgentSend(row.id);
      const kind = tgErrorKind(tgError('PEER_FLOOD'));
      expect(kind.kind).toBe('restricted');
      const outcome: StepOutcome = { kind: 'failed', reason: 'PEER_FLOOD', error: kind, markUnread: true };
      const report = await applyAgentOutcome(row, outcome, own.account);
      expect(report.markUnread).toBe(true);
      expect((await agentRowById(row.id))?.status).toBe('failed');
      const guard = await readGuard(own.account.id);
      expect(guard.pausedAt).not.toBeNull();
      expect(guard.pausedKind).toBe('peer_flood');
      expect((await readAgentConfig())?.mode).toBe('off');
      expect((await agentRowById(waiting.row.id))?.status).toBe('cancelled');
      const alarm = await db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, own.userId), eq(notifications.type, 'TgAccountPaused')));
      expect(alarm).toHaveLength(1);
      const text = String((alarm[0]!.payload as { text?: unknown }).text);
      expect(text).toContain(own.account.managerName);
      expect(text).toContain('Tekshirdim');

      // A second refusal on the same account: the first pause stands, no second alarm.
      const again = await approved({ manager: own.userId, step: 'send' });
      await applyAgentOutcome(again.row, outcome, own.account);
      const alarms = await db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, own.userId), eq(notifications.type, 'TgAccountPaused')));
      expect(alarms).toHaveLength(1);
    } finally {
      await agentOff();
    }
  });

  it('recipient_final mutes the chat; two blocks in a week switch the agent off', async () => {
    const own = await makeManager('blocks');
    await agentOn(own.userId);
    try {
      const blocked = tgErrorKind(tgError('USER_IS_BLOCKED'));
      expect(blocked.kind).toBe('recipient_final');
      const first = await approved({ manager: own.userId, step: 'send' });
      await claimAgentSend(first.row.id);
      await applyAgentOutcome(first.row, { kind: 'failed', reason: 'USER_IS_BLOCKED', error: blocked, markUnread: true }, own.account);
      const [conv] = await db
        .select()
        .from(agentConversations)
        .where(and(eq(agentConversations.managerUserId, own.userId), eq(agentConversations.peerId, first.peer)));
      expect(conv?.mutedAt).not.toBeNull();
      expect(conv?.muteReason).toBe('USER_IS_BLOCKED');
      expect((await readAgentConfig())?.mode, 'one block is not two').toBe('shadow');

      const second = await approved({ manager: own.userId, step: 'send' });
      await claimAgentSend(second.row.id);
      await applyAgentOutcome(second.row, { kind: 'failed', reason: 'USER_IS_BLOCKED', error: blocked, markUnread: true }, own.account);
      expect((await readAgentConfig())?.mode).toBe('off');
    } finally {
      await agentOff();
    }
  });

  it('a dead session is the listener’s to end — nothing is marked on it', async () => {
    const { row } = await approved({ step: 'send', readDone: true });
    await claimAgentSend(row.id);
    const dead = tgErrorKind(tgError('SESSION_REVOKED', 401));
    expect(dead.kind).toBe('session');
    const report = await applyAgentOutcome(row, { kind: 'failed', reason: dead.code, error: dead, markUnread: true }, account);
    expect(report.sessionDead).toBe(dead.code);
    expect(report.markUnread).toBe(false);
  });
});

describe('which row the pump steps', () => {
  it('one reply in flight per account: a row past its read blocks the rest until its clock comes', async () => {
    const own = await makeManager('due');
    const now = new Date();
    const typing = await approved({ manager: own.userId, step: 'typing', nextStepAt: new Date(now.getTime() + 60_000) });
    await approved({ manager: own.userId, step: 'verify', nextStepAt: new Date(now.getTime() - 60_000) });
    expect(await dueAgentRow(own.userId, now)).toBeNull();
    expect((await dueAgentRow(own.userId, new Date(now.getTime() + 61_000)))?.id).toBe(typing.row.id);
  });

  it('otherwise the row whose clock came due first, never one in the future', async () => {
    const own = await makeManager('order');
    const now = new Date();
    await approved({ manager: own.userId, nextStepAt: new Date(now.getTime() + 60_000) });
    const early = await approved({ manager: own.userId, nextStepAt: new Date(now.getTime() - 120_000) });
    await approved({ manager: own.userId, nextStepAt: new Date(now.getTime() - 60_000) });
    expect((await dueAgentRow(own.userId, now))?.id).toBe(early.row.id);
  });

  it('a reply somebody else ended after its read gets its badge back once (regression-12)', async () => {
    const own = await makeManager('badge');
    const now = new Date();
    // «off» on the screen cancels mid-typing: read on his phone, nothing sent.
    const offed = await approved({ manager: own.userId, step: 'typing', readDone: true });
    await db.update(agentOutbox).set({ status: 'cancelled', lastError: 'agent_off' }).where(eq(agentOutbox.id, offed.row.id));
    // Never read, still waiting, or perhaps delivered: none of these is owed a badge.
    const unread = await approved({ manager: own.userId, step: 'verify' });
    await db.update(agentOutbox).set({ status: 'cancelled' }).where(eq(agentOutbox.id, unread.row.id));
    await approved({ manager: own.userId, step: 'typing', readDone: true });
    const maybeSent = await approved({ manager: own.userId, step: 'send', readDone: true });
    await db.update(agentOutbox).set({ status: 'unknown' }).where(eq(agentOutbox.id, maybeSent.row.id));
    // Yesterday's abort: a badge given back now would be noise.
    const old = await approved({ manager: own.userId, step: 'typing', readDone: true });
    await db
      .update(agentOutbox)
      .set({ status: 'cancelled', queuedAt: new Date(now.getTime() - 2 * 86_400_000) })
      .where(eq(agentOutbox.id, old.row.id));

    const owed = await badgesToRestore(own.userId, now);
    expect(owed.map((b) => b.id)).toEqual([offed.row.id]);
    expect(owed[0]!.peerId).toBe(offed.peer);
    await badgeRestored(offed.row.id);
    expect(await badgesToRestore(own.userId, now)).toEqual([]);
  });

  it('a reply being sent when the listener died is unknown, never re-sent', async () => {
    const own = await makeManager('recover');
    const { row } = await approved({ manager: own.userId, step: 'send' });
    await claimAgentSend(row.id);
    expect(await recoverAgentInFlight(own.userId)).toEqual([row.id]);
    expect((await agentRowById(row.id))?.status).toBe('unknown');
  });
});

describe('the send path’s review fixes', () => {
  it('a kept photo after the question supersedes the reply; a sticker (no file kept) does not (S4)', async () => {
    const { row, peer, anchor } = await approved({});
    // A sticker: has_media, no text, and the listener keeps no file of it.
    await message({ peer, id: anchor + 1n, direction: 'in', body: null, hasMedia: true });
    expect((await sendFactsFor(row, new Date(), ctx(account.id))).newerSubstantiveInbound).toBe(false);
    // A photo with no caption: its file is kept — it wants its own answer.
    const photo = await message({ peer, id: anchor + 2n, direction: 'in', body: null, hasMedia: true });
    await keptFile(photo);
    expect((await sendFactsFor(row, new Date(), ctx(account.id))).newerSubstantiveInbound).toBe(true);
  });

  it('the caps and the gaps see a reply that may have been delivered — «unknown» on its claim (S5)', async () => {
    const own = await makeManager('unknown-caps');
    const now = new Date('2025-04-10T10:00:00Z'); // 15:00 Tashkent
    const peer = next();
    const { row } = await approved({ manager: own.userId, peer });
    const claimed = new Date(now.getTime() - 8 * 60_000);
    await approved({ manager: own.userId, peer, storeAnchor: false, status: 'unknown', stepClaimedAt: claimed });
    const f = await sendFactsFor(row, now, ctx(own.account.id));
    expect(f.sentToChatToday).toBe(1);
    expect(f.sentLastHour).toBe(1);
    expect(f.sentToday).toBe(1);
    expect(f.lastChatSendAt?.getTime()).toBe(claimed.getTime());
    expect(f.lastAccountSendAt?.getTime()).toBe(claimed.getTime());
  });

  it('the night rule reads when the customer last wrote (S3)', async () => {
    const { row, peer, anchor } = await approved({});
    // The anchor was stored a moment ago; the customer's «??» after it is the newest line, our reply is not his.
    const later = new Date(Date.now() + 2_000);
    await message({ peer, id: anchor + 1n, direction: 'in', body: '??', sentAt: later });
    await message({ peer, id: anchor + 2n, direction: 'out', body: 'javob', sentAt: new Date(Date.now() + 4_000) });
    expect((await sendFactsFor(row, new Date(), ctx(account.id))).lastInboundAt?.getTime()).toBe(later.getTime());
  });

  it('a night wait carries the approval’s clock to the morning; any other wait leaves it (S2, S3)', async () => {
    const { row } = await approved({});
    const morning = new Date(Date.now() + 9 * 3_600_000);
    await applyAgentOutcome(row, { kind: 'wait', reason: 'chat_gap', nextStepAt: new Date(Date.now() + 20_000) }, account);
    expect((await agentRowById(row.id))?.releaseAt).toBeNull();
    await applyAgentOutcome(row, { kind: 'wait', reason: 'night', nextStepAt: morning }, account);
    const after = await agentRowById(row.id);
    expect(after?.releaseAt?.getTime()).toBe(morning.getTime());
    expect(after?.nextStepAt.getTime()).toBe(morning.getTime());
  });

  it('a night hold starts the choreography afresh in the morning, says so on the card, and holds no other reply behind it', async () => {
    const own = await makeManager('night-hold');
    // Read and typing on his phone when a wait carried it into the night.
    const { row, draftId } = await approved({ manager: own.userId, step: 'typing', readDone: true });
    await db.update(agentOutbox).set({ typingCount: 2 }).where(eq(agentOutbox.id, row.id));
    await db.insert(notifications).values({
      userId: own.userId,
      channel: 'telegram',
      type: 'AgentDraft',
      payload: { draftId, text: '✅ Tasdiqlandi · yuborilmoqda…' },
      status: 'sent',
    });
    const morning = new Date(Date.now() + 9 * 3_600_000);
    await applyAgentOutcome({ ...row, typingCount: 2 }, { kind: 'wait', reason: 'night', nextStepAt: morning }, own.account);
    // verify → read → typing → send again at 08:30; the read on his phone still stands.
    expect(await agentRowById(row.id)).toMatchObject({ status: 'agent', step: 'verify', typingCount: 0, readDone: true });
    // The card no longer says «yuborilmoqda…» all night.
    const [card] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, own.userId), eq(notifications.type, 'AgentDraft')));
    expect(String((card!.payload as { text?: unknown }).text)).toContain('da ketadi');
    // Not the row in flight: another approved reply — a customer who wrote minutes ago — may go tonight.
    const fresh = await approved({ manager: own.userId, step: 'verify' });
    expect((await dueAgentRow(own.userId, new Date()))?.id).toBe(fresh.row.id);
  });

  it('every step stamps when it was taken — what the night asks of a reply past its read (S3’s follow-up)', async () => {
    const { row } = await approved({ step: 'read' });
    expect(row.lastStepAt).toBeNull();
    const at = new Date(Date.now() - 5_000);
    await applyAgentOutcome(row, { kind: 'advance', step: 'typing', nextStepAt: new Date(), readDone: true }, account, at);
    expect((await agentRowById(row.id))?.lastStepAt?.getTime()).toBe(at.getTime());
    // A wait moves the row's clock, never the stamp of its last step.
    await applyAgentOutcome(row, { kind: 'wait', reason: 'chat_gap', nextStepAt: new Date(Date.now() + 20_000) }, account);
    expect((await agentRowById(row.id))?.lastStepAt?.getTime()).toBe(at.getTime());
    // The send's claim is a step too.
    await db.update(agentOutbox).set({ step: 'send' }).where(eq(agentOutbox.id, row.id));
    expect(await claimAgentSend(row.id)).toBe(true);
    expect((await agentRowById(row.id))!.lastStepAt!.getTime()).toBeGreaterThan(at.getTime());
  });

  it('a badge owed while the account was paused comes back after «Tekshirdim», however long the pause (S8’s follow-up)', async () => {
    const own = await makeManager('badge-pause');
    const now = new Date();
    const read = await approved({ manager: own.userId, step: 'typing', readDone: true });
    // Read on his phone, then cancelled by the pause 30 hours ago — while it stood, nothing could call Telegram.
    await db
      .update(agentOutbox)
      .set({ status: 'cancelled', lastError: 'account_paused', queuedAt: new Date(now.getTime() - 30 * 3_600_000) })
      .where(eq(agentOutbox.id, read.row.id));
    expect(await badgesToRestore(own.userId, now), 'a day from the approval has run out').toEqual([]);
    // He presses «Tekshirdim» a minute ago: the day counts from there.
    await db.insert(tgAccountGuard).values({ accountId: own.account.id, clearedAt: new Date(now.getTime() - 60_000) });
    expect((await badgesToRestore(own.userId, now)).map((b) => b.id)).toEqual([read.row.id]);
    // Another account's clear says nothing about this one's rows.
    const other = await makeManager('badge-pause-other');
    const theirs = await approved({ manager: other.userId, step: 'typing', readDone: true });
    await db
      .update(agentOutbox)
      .set({ status: 'cancelled', queuedAt: new Date(now.getTime() - 30 * 3_600_000) })
      .where(eq(agentOutbox.id, theirs.row.id));
    expect(await badgesToRestore(other.userId, now)).toEqual([]);
  });

  it('a flood replayed after a database blip is one wait, never the two that switch the agent off (S7)', async () => {
    const own = await makeManager('flood-replay');
    await agentOn(own.userId);
    try {
      const { row } = await approved({ manager: own.userId, step: 'send' });
      await claimAgentSend(row.id);
      const at = new Date();
      const outcome: StepOutcome = { kind: 'flooded', seconds: 40, method: 'messages.SendMessage' };
      await applyAgentOutcome(row, outcome, own.account, at);
      // The listener held the outcome (the db blinked after Telegram answered) and applies it again, same instant.
      await applyAgentOutcome(row, outcome, own.account, at);
      const floods = await db.select().from(tgAccountFloods).where(eq(tgAccountFloods.accountId, own.account.id));
      expect(floods).toHaveLength(1);
      expect((await readAgentConfig())?.mode, 'one wait is not two').toBe('shadow');
    } finally {
      await agentOff();
    }
  });

  it('a wait on a READ holds the agent’s row, never a person’s reply: flood_until moves for a send method only (S9)', async () => {
    const own = await makeManager('read-flood');
    const { row } = await approved({ manager: own.userId, step: 'verify' });
    const before = Date.now();
    await applyAgentOutcome(row, { kind: 'flooded', seconds: 3600, method: 'messages.GetHistory' }, own.account);
    // The row waits Telegram's full wait…
    expect((await agentRowById(row.id))!.nextStepAt.getTime()).toBeGreaterThanOrEqual(before + 3600_000);
    // …the ledger has it, and the account's clock — the one that stops CRM replies — does not move.
    const floods = await db.select().from(tgAccountFloods).where(eq(tgAccountFloods.accountId, own.account.id));
    expect(floods.map((f) => f.method)).toEqual(['messages.GetHistory']);
    expect((await readGuard(own.account.id)).floodUntil).toBeNull();
    await recordFlood({ accountId: own.account.id, method: 'messages.SetTyping', seconds: 600, source: 'raise' });
    expect((await readGuard(own.account.id)).floodUntil).toBeNull();
    await recordFlood({ accountId: own.account.id, method: 'messages.SendMessage', seconds: 600, source: 'raise' });
    expect((await readGuard(own.account.id)).floodUntil!.getTime()).toBeGreaterThan(Date.now() + 590_000);
  });
});

describe('recordSent learns leads (regression-2)', () => {
  it('stores a lead’s echo with the lead set, and a client’s exactly as before', async () => {
    const peer = next();
    const id = next();
    await recordSent({ clientId: null, leadId, managerUserId: managerId, peerId: peer, tgMessageId: id, body: 'Salom', sentAt: new Date() });
    const [lead] = await db.select().from(tgMessages).where(and(eq(tgMessages.managerUserId, managerId), eq(tgMessages.tgMessageId, id)));
    expect(lead?.leadId).toBe(leadId);
    expect(lead?.clientId, 'an open lead names no client').toBeNull();

    const cid = next();
    await recordSent({ clientId, managerUserId: managerId, peerId: peer, tgMessageId: cid, body: 'Salom', sentAt: new Date() });
    const [client] = await db.select().from(tgMessages).where(and(eq(tgMessages.managerUserId, managerId), eq(tgMessages.tgMessageId, cid)));
    expect(client?.clientId).toBe(clientId);
    expect(client?.leadId).toBeNull();
  });
});
