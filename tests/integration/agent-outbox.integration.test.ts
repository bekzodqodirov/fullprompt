import 'dotenv/config';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';

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
  calcRequests,
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
  tgOutbox,
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
import { agentSendVerdict, verdictOutcome, type AgentOutboxRow, type StepOutcome } from '@/modules/wms/agent/send-step';
import { agentTelegramNotice, type AlarmAccount } from '@/modules/wms/crm/account-alarm';
import { sendsToday } from '@/modules/wms/agent/today';
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
const madeRequests: string[] = [];
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

/** A person's reply from the CRM on this account — the human queue's row, as the listener leaves it. */
async function crmReply(manager: string, peer: bigint, status: 'sent' | 'queued' | 'failed', sentAt: Date | null): Promise<void> {
  await db.insert(tgOutbox).values({
    clientId,
    managerUserId: manager,
    peerId: peer,
    body: 'Odam javobi',
    status,
    queuedBy: manager,
    queuedAt: sentAt ?? new Date(),
    sentAt,
  });
}

/** The verdict as it would be with the agent on here and the CRM's switch on — the facts' own reading otherwise. */
const speaking = (f: Awaited<ReturnType<typeof sendFactsFor>>, owner: string) => ({
  ...f,
  agentOn: true,
  ownerUserId: owner,
  sendingEnabled: true,
});

/** «25.10 08:30» — a time as the card prints it (Tashkent, UTC+5), computed here, not by the card. */
function tashkentStamp(d: Date): string {
  const t = new Date(d.getTime() + 5 * 3_600_000);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(t.getUTCDate())}.${two(t.getUTCMonth() + 1)} ${two(t.getUTCHours())}:${two(t.getUTCMinutes())}`;
}

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
    await db.delete(tgOutbox).where(inArray(tgOutbox.managerUserId, madeUsers));
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
  // Newest first: a correction names the request it replaces.
  if (madeRequests.length) await db.delete(calcRequests).where(inArray(calcRequests.id, [...madeRequests].reverse()));
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

  it('a chat bound to another code BEFORE it wrote again: the new customer\'s reply leaves, the old one\'s does not (final review, identity package)', async () => {
    // The tray's «Qo'shish» on another code names the chat's owner from the
    // moment it is written; the stored rows still name the old client until the
    // customer writes again. The one «same person» rule reads both.
    const forOld = await approved({});
    const forNew = await approved({ peer: forOld.peer, anchor: forOld.anchor, storeAnchor: false, client: otherClientId });
    await db.insert(tgChatRules).values({ managerUserId: managerId, peerId: forOld.peer, decision: 'include', clientId: otherClientId });
    onTestFinished(async () => {
      await db.delete(tgChatRules).where(and(eq(tgChatRules.managerUserId, managerId), eq(tgChatRules.peerId, forOld.peer)));
    });
    expect((await sendFactsFor(forNew.row, new Date(), ctx(account.id))).identityChanged).toBe(false);
    expect((await sendFactsFor(forOld.row, new Date(), ctx(account.id))).identityChanged).toBe(true);
  });

  it('a lead chat whose lead was won keeps its identity', async () => {
    const { row, peer, anchor } = await approved({ lead: leadId });
    // WON = the lead carries its client — `storeIncoming` fills the client
    // beside such a lead from exactly that column, and «same person» is now
    // read through `chatIdentity`, which keeps the lead only beside the client
    // it became (K25). A row naming a client the lead never became is a move.
    await db.update(leads).set({ clientId }).where(eq(leads.id, leadId));
    onTestFinished(async () => {
      await db.update(leads).set({ clientId: null }).where(eq(leads.id, leadId));
    });
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

  it('the account’s hour and gap count its sent CRM replies too — the machine yields to the people (K5)', async () => {
    const own = await makeManager('crm-caps');
    const now = new Date('2025-05-10T10:00:00Z'); // 15:00 Tashkent; the day began 2025-05-09T19:00Z
    const peer = next();
    const { row } = await approved({ manager: own.userId, peer });
    // The machine's own send, two hours ago.
    await approved({ manager: own.userId, storeAnchor: false, status: 'sent', sentAt: new Date(now.getTime() - 2 * 3_600_000) });
    // People: to this chat 20 minutes ago, to another three seconds ago, one yesterday, and two that never left.
    await crmReply(own.userId, peer, 'sent', new Date(now.getTime() - 20 * 60_000));
    await crmReply(own.userId, next(), 'sent', new Date(now.getTime() - 3_000));
    await crmReply(own.userId, next(), 'sent', new Date('2025-05-09T18:00:00Z'));
    await crmReply(own.userId, next(), 'queued', null);
    await crmReply(own.userId, next(), 'failed', null);
    const f = await sendFactsFor(row, now, ctx(own.account.id));
    expect(f.sentLastHour).toBe(2);
    // The day is the machine's own (his Q11, and the ✅ door's number): its one send, not the people's two.
    expect(f.sentToday).toBe(1);
    expect(f.lastAccountSendAt?.getTime(), 'the colleague’s reply three seconds ago').toBe(now.getTime() - 3_000);
    // The chat's own numbers stay the machine's voice: a person's reply here after the anchor cancels instead.
    expect(f.sentToChatToday).toBe(0);
    expect(f.lastChatSendAt).toBeNull();
    // And the verdict obeys: the jittered gap runs from the person's send, not from the machine's last.
    expect(agentSendVerdict(row, speaking(f, own.userId))).toEqual({
      ok: false,
      final: false,
      reason: 'account_gap',
      until: new Date(now.getTime() - 3_000 + f.accountGapMs),
    });
  });

  it('the day the step caps on is the day the ✅ door and the page count — his CRM replies move neither (K5’s follow-up)', async () => {
    const own = await makeManager('crm-day');
    const started = new Date(Date.now() - 3 * 86_400_000); // inside the ramp: the ceiling is his own average
    // His own average: 60 replies in the 30 days before the start → two a day.
    for (let i = 0; i < 60; i += 1) {
      await message({ manager: own.userId, peer: next(), id: next(), direction: 'out', sentAt: new Date(started.getTime() - (i + 1) * 3_600_000) });
    }
    __forgetOwnAverage();
    await agentOn(own.userId, started);
    try {
      const now = new Date();
      // One AI reply went a second ago; the reply about to be decided is the second of his two.
      await approved({ manager: own.userId, storeAnchor: false, status: 'sent', sentAt: new Date(now.getTime() - 1_000) });
      const { row } = await approved({ manager: own.userId });
      const door = async () => sendsToday(own.userId, started, now);
      const step = async () => sendFactsFor(row, now, ctx(own.account.id));
      const before = { door: await door(), step: await step() };
      // The door: the reply that went and this one, reserved by its ✅ — the day's two, no third ✅ today.
      expect(before.door).toEqual({ used: 2, ceiling: 2 });
      // The step: one handed to Telegram, so this one goes on the day.
      expect(before.step.dailyCeiling).toBe(2);
      expect(before.step.sentToday).toBe(1);
      // A busy afternoon of people answering from the CRM on the same account, seconds ago.
      for (let i = 0; i < 5; i += 1) await crmReply(own.userId, next(), 'sent', new Date(now.getTime() - (i + 2) * 1_000));
      const after = { door: await door(), step: await step() };
      expect(after.door, 'the ✅ door and the page').toEqual(before.door);
      expect(after.step.sentToday, 'the step’s day').toBe(before.step.sentToday);
      // So what the door accepted, the step does not hold to the morning where the approval's age would
      // cancel it. (The hour and the gap DO count the people — the test above — so they are left out here.)
      const day = { ...speaking(after.step, own.userId), lastAccountSendAt: null, sentLastHour: 0 };
      expect(agentSendVerdict(row, day)).toEqual({ ok: true });
    } finally {
      await agentOff();
      __forgetOwnAverage();
    }
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

describe('his 🙋 on the chat (final review K2)', () => {
  it('refuses for good a reply approved before the press and still waiting, whichever draft he pressed it on', async () => {
    const { row, peer } = await approved({});
    expect((await sendFactsFor(row, new Date(), ctx(account.id))).humanUntil).toBeNull();
    // The press on a NEWER draft of the same chat: the takeover lives on the conversation, not on a draft.
    await db
      .insert(agentConversations)
      .values({ managerUserId: managerId, peerId: peer, humanUntil: new Date(Date.now() + 24 * 3_600_000) });
    const f = await sendFactsFor(row, new Date(), ctx(account.id));
    expect(f.humanUntil!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    // No press on record (the takeover written here by hand): it withdraws everything, as it always did.
    expect(f.humanPressedAt).toBeNull();
    const verdict = agentSendVerdict(row, speaking(f, managerId));
    expect(verdict).toEqual({ ok: false, final: true, reason: 'human_replied' });
    await applyAgentOutcome(row, verdictOutcome(row, verdict)!, account);
    const [after] = await db.select().from(agentOutbox).where(eq(agentOutbox.id, row.id));
    expect(after!.status).toBe('cancelled');
    // The card's word for it is the draft's own `taken_over` line: «o'zingiz javob berdingiz».
    expect(after!.lastError).toBe('human_replied');
    // Another chat of the same account is not his for being this one's.
    const elsewhere = await approved({});
    expect((await sendFactsFor(elsewhere.row, new Date(), ctx(account.id))).humanUntil).toBeNull();
  });
});

describe('Telegram’s own notice switches the agent off at once (his ⭐2, final review K33)', () => {
  it('on the account it speaks from: off, the approved replies cancelled, ONE alarm in its own words', async () => {
    const own = await makeManager('notice');
    await agentOn(own.userId);
    try {
      const waiting = await approved({ manager: own.userId });
      expect(await agentTelegramNotice(own.account, 'notice')).toEqual({ agentOff: true });
      expect((await readAgentConfig())?.mode).toBe('off');
      const [cancelled] = await db.select().from(agentOutbox).where(eq(agentOutbox.id, waiting.row.id));
      expect(cancelled!.status).toBe('cancelled');
      expect(cancelled!.lastError).toBe('agent_off: telegram_notice');
      const alarms = async () =>
        db
          .select()
          .from(notifications)
          .where(and(eq(notifications.userId, own.userId), eq(notifications.type, 'AgentForcedOff')));
      const first = await alarms();
      expect(first).toHaveLength(1);
      const text = String((first[0]!.payload as { text?: unknown }).text);
      expect(text).toContain(own.account.managerName);
      expect(text).toContain('777000');
      // A second notice finds the agent already off: nothing switched, nothing said twice.
      expect(await agentTelegramNotice(own.account, 'notice')).toEqual({ agentOff: false });
      expect(await alarms()).toHaveLength(1);
    } finally {
      await agentOff();
    }
  });

  it('his own login — the code, the «new login» alert — switches nothing off and cancels nothing he approved (K33’s follow-up)', async () => {
    const own = await makeManager('notice-login');
    await agentOn(own.userId);
    try {
      // The evening's ✅, night-held to the morning, and a draft he is still editing.
      const waiting = await approved({ manager: own.userId });
      const [editing] = await db
        .insert(agentDrafts)
        .values({ managerUserId: own.userId, peerId: next(), anchorTgMessageId: next(), clientId, status: 'editing' })
        .returning({ id: agentDrafts.id });
      // 08:10 at the office: he signs in on Telegram Desktop.
      expect(await agentTelegramNotice(own.account, 'login')).toEqual({ agentOff: false });
      expect((await readAgentConfig())?.mode).toBe('shadow');
      expect((await agentRowById(waiting.row.id))?.status).toBe('agent');
      const [still] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, editing!.id));
      expect(still!.status).toBe('editing');
      const alarms = await db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, own.userId), eq(notifications.type, 'AgentForcedOff')));
      expect(alarms, 'Telegram itself shows him his login — no alarm about it').toHaveLength(0);
      // A notice after it still switches off at once.
      expect(await agentTelegramNotice(own.account, 'notice')).toEqual({ agentOff: true });
    } finally {
      await agentOff();
    }
  });

  it('on any other account — a colleague’s, or his with the agent off — it does nothing at all', async () => {
    const own = await makeManager('notice-owner');
    const other = await makeManager('notice-other');
    await agentOn(own.userId);
    try {
      const waiting = await approved({ manager: own.userId });
      expect(await agentTelegramNotice(other.account, 'notice')).toEqual({ agentOff: false });
      expect((await readAgentConfig())?.mode).toBe('shadow');
      expect((await agentRowById(waiting.row.id))?.status).toBe('agent');
      const alarms = await db
        .select()
        .from(notifications)
        .where(and(inArray(notifications.userId, [own.userId, other.userId]), eq(notifications.type, 'AgentForcedOff')));
      expect(alarms).toHaveLength(0);
    } finally {
      await agentOff();
    }
    expect(await agentTelegramNotice(own.account, 'notice'), 'the agent off: nothing to switch').toEqual({ agentOff: false });
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
    // The card no longer says «yuborilmoqda…» all night — it says the morning it is held to, by its time.
    const [card] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, own.userId), eq(notifications.type, 'AgentDraft')));
    expect(String((card!.payload as { text?: unknown }).text)).toContain(`✅ Tasdiqlandi · ${tashkentStamp(morning)} da ketadi.`);
    // Not the row in flight: another approved reply — a customer who wrote minutes ago — may go tonight.
    const fresh = await approved({ manager: own.userId, step: 'verify' });
    expect((await dueAgentRow(own.userId, new Date()))?.id).toBe(fresh.row.id);
  });

  it('a reply approved for one morning and held again by the night rule says the NEW time, not the old one (send review)', async () => {
    const own = await makeManager('night-again');
    const first = new Date(Date.now() + 2 * 3_600_000);
    const { row, draftId } = await approved({ manager: own.userId, nextStepAt: first });
    await db.insert(notifications).values({
      userId: own.userId,
      channel: 'telegram',
      type: 'AgentDraft',
      payload: { draftId, text: `✅ Tasdiqlandi · ${tashkentStamp(first)} da ketadi.` },
      status: 'sent',
    });
    const morning = new Date(Date.now() + 20 * 3_600_000);
    await applyAgentOutcome(row, { kind: 'wait', reason: 'night', nextStepAt: morning }, own.account);
    const [card] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, own.userId), eq(notifications.type, 'AgentDraft')));
    const text = String((card!.payload as { text?: unknown }).text);
    expect(text).toContain(`${tashkentStamp(morning)} da ketadi`);
    expect(text).not.toContain(tashkentStamp(first));
  });



  it('a day cap or a flood wait that holds the reply past the minute says when it goes — never «yuborilmoqda…» all night (cards review)', async () => {
    for (const [reason, kind] of [
      ['day_cap', 'wait'],
      ['chat_day_cap', 'wait'],
      ['flood_wait', 'wait'],
      ['flooded', 'flooded'],
    ] as const) {
      const own = await makeManager(`hold-${reason}`);
      const { row, draftId } = await approved({ manager: own.userId });
      await db.insert(notifications).values({
        userId: own.userId,
        channel: 'telegram',
        type: 'AgentDraft',
        payload: { draftId, text: '✅ Tasdiqlandi · yuborilmoqda…' },
        status: 'sent',
      });
      const until = new Date(Date.now() + 16 * 3_600_000);
      await applyAgentOutcome(
        row,
        kind === 'flooded'
          ? { kind: 'flooded', seconds: 16 * 3_600, method: 'messages.SendMessage' }
          : { kind: 'wait', reason, nextStepAt: until },
        own.account,
      );
      const [card] = await db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, own.userId), eq(notifications.type, 'AgentDraft')));
      const text = String((card!.payload as { text?: unknown }).text);
      const held = (await agentRowById(row.id))!.nextStepAt;
      expect(text, reason).toContain(`${tashkentStamp(held)} da ketadi`);
      expect(text, reason).not.toContain('yuborilmoqda');
    }
    // A short wait stays «yuborilmoqda…»: the slot's retry is seconds, and no card is touched for it.
    const own = await makeManager('hold-slot');
    const { row, draftId } = await approved({ manager: own.userId });
    await db.insert(notifications).values({
      userId: own.userId,
      channel: 'telegram',
      type: 'AgentDraft',
      payload: { draftId, text: `✅ Tasdiqlandi · yuborilmoqda… ${draftId}` },
      status: 'sent',
    });
    await applyAgentOutcome(row, { kind: 'wait', reason: 'slot_held', nextStepAt: new Date(Date.now() + 5_000) }, own.account);
    const [card] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, own.userId), eq(notifications.type, 'AgentDraft')));
    expect(String((card!.payload as { text?: unknown }).text)).toBe(`✅ Tasdiqlandi · yuborilmoqda… ${draftId}`);
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

describe('an approved 💵 whose request a VED recalculation replaced never goes (answers review)', () => {
  async function priceRequest(supersedes: string | null = null): Promise<string> {
    const [r] = await db
      .insert(calcRequests)
      .values({
        entityType: 'deal',
        entityId: '00000000-0000-4000-8000-000000000136',
        requestedBy: managerId,
        itemCount: 1,
        section: 'podklyuch',
        dueAt: new Date(Date.now() + 3_600_000),
        supersedesRequestId: supersedes,
      })
      .returning({ id: calcRequests.id });
    madeRequests.push(r!.id);
    return r!.id;
  }

  it('its figure stands until a correction supersedes the request, then the step cancels it as offer_gone and the card says why', async () => {
    const own = await makeManager('price-recalc');
    const { row, draftId } = await approved({ manager: own.userId });
    const priced = await priceRequest();
    // What `priceDraftFromText` writes (his 6 b): no offer row, the request on the policy.
    await db.update(agentDrafts).set({ kind: 'price', policy: { priceRequestId: priced } }).where(eq(agentDrafts.id, draftId));
    await db.insert(notifications).values({
      userId: own.userId,
      channel: 'telegram',
      type: 'AgentDraft',
      payload: { draftId, text: '✅ Tasdiqlandi · 08:30 da ketadi.' },
      status: 'sent',
    });
    const standing = await sendFactsFor(row, new Date(), ctx(own.account.id));
    expect(standing.offerStands).toBe(true);
    const on = { agentOn: true, ownerUserId: own.userId, sendingEnabled: true } as const;
    // Nothing makes it WRONG — at most a wait (this file's agent has no start day, so the ramp holds it).
    expect(agentSendVerdict(row, { ...standing, ...on })).not.toMatchObject({ final: true });

    // The VED presses «Qayta hisoblash»: a correction is a NEW request naming this one.
    await priceRequest(priced);
    const facts = await sendFactsFor(row, new Date(), ctx(own.account.id));
    expect(facts.offerStands).toBe(false);
    const verdict = agentSendVerdict(row, { ...facts, ...on });
    expect(verdict).toEqual({ ok: false, final: true, reason: 'offer_gone' });
    await applyAgentOutcome(row, verdictOutcome(row, verdict)!, own.account);
    expect(await agentRowById(row.id)).toMatchObject({ status: 'cancelled' });
    const [card] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, own.userId), eq(notifications.type, 'AgentDraft')));
    expect(String((card!.payload as { text?: unknown }).text)).toContain('VED qayta hisobladi');
  });

  it('a reply with no price behind it is not asked about a request at all', async () => {
    const { row, draftId } = await approved({});
    const unrelated = await priceRequest();
    await priceRequest(unrelated);
    // A plain reply carrying a stray key is still no price draft.
    await db.update(agentDrafts).set({ policy: { priceRequestId: unrelated } }).where(eq(agentDrafts.id, draftId));
    expect((await sendFactsFor(row, new Date(), ctx(account.id))).offerStands).toBeNull();
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
