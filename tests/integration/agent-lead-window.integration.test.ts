import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  agentConfig,
  agentConversations,
  agentDrafts,
  agentOutbox,
  leadSources,
  leadStages,
  leads,
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
import { agentSendVerdict } from '@/modules/wms/agent/send-step';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';

/**
 * The merge review's defect, on a real database: an AI-sotuvchi reply to a
 * lead the client-finding agent brought obeys that agent's playbook window —
 * Monday-Saturday 10:00-17:00 Tashkent, never Sunday — at the ✅ AND at every
 * send step, while a lead from any other door keeps the night rule exactly as
 * before (the control in every case). Nothing here reaches a customer without
 * the owner's ✅: the drafts are his own words, decided by `decideDraft`.
 *
 * Every clock is a literal Tashkent moment with Date alone faked (the database
 * keeps its own), the listener's stamps moved onto it as the night test does.
 * agent_config and the send switch are CONFIGURATION (#183): snapshotted and
 * put back. The fixture person is deactivated, never deleted (the audit FK).
 */

const SUFFIX = String(Date.now()).slice(-6);
const AGENT_PEER = BigInt(`79${SUFFIX}`);
const ADVERT_PEER = BigInt(`77${SUFFIX}`);
const T = (iso: string) => new Date(`${iso}+05:00`);

let ownerId = '';
let accountId = '';
let agentLeadId = '';
let advertLeadId = '';
let snapshot: AgentConfig | null = null;
let sendingBefore = false;
let msgSeq = 7000n;

const actor = () => ({ id: ownerId, roles: ['super_admin'], permissions: new Set<string>(['crm.leads.view_all']) });
const ctx = () => ({ actorId: ownerId });
const stepCtx = () => ({ accountId, caughtUp: () => true, random: () => 0 });

/** Freeze the app's clock at `at`, with the listener's two stamps on the same clock (S11). */
async function clockAt(at: Date) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
  await db.update(tgAccountGuard).set({ agentPumpAt: at, caughtUpAt: at }).where(eq(tgAccountGuard.accountId, accountId));
}

/** The customer's question on a lead chat, and a pending draft of HIS words answering it. */
async function askedAndDrafted(peer: bigint, leadId: string, sentAt: Date): Promise<string> {
  msgSeq += 1n;
  await db.insert(tgMessages).values({
    leadId,
    managerUserId: ownerId,
    peerId: peer,
    tgMessageId: msgSeq,
    direction: 'in',
    body: 'Xitoydan yuk olib kelasizlarmi?',
    sentAt,
  });
  const [d] = await db
    .insert(agentDrafts)
    .values({ managerUserId: ownerId, peerId: peer, anchorTgMessageId: msgSeq, leadId, status: 'pending', finalBody: 'Ha, olib kelamiz.' })
    .returning({ id: agentDrafts.id });
  return d!.id;
}

async function outboxOf(draftId: string) {
  const [o] = await db.select().from(agentOutbox).where(eq(agentOutbox.draftId, draftId));
  return o ?? null;
}

async function clearChats() {
  const peers = [AGENT_PEER, ADVERT_PEER];
  await db.delete(agentConversations).where(inArray(agentConversations.peerId, peers));
  await db.delete(agentOutbox).where(inArray(agentOutbox.peerId, peers));
  await db.delete(agentDrafts).where(inArray(agentDrafts.peerId, peers));
  await db.delete(tgMessages).where(inArray(tgMessages.peerId, peers));
}

async function leadFrom(sourceKey: string, tag: string): Promise<string> {
  const [source] = await db.select({ id: leadSources.id }).from(leadSources).where(eq(leadSources.key, sourceKey));
  expect(source, `the seed ships the «${sourceKey}» source`).toBeTruthy();
  const [stage] = await db.select({ id: leadStages.id }).from(leadStages).where(eq(leadStages.kind, 'open')).orderBy(leadStages.sortOrder).limit(1);
  const [row] = await db
    .insert(leads)
    .values({ name: `Oyna ${tag} ${SUFFIX}`, phone: `+99890${SUFFIX}${tag === 'agent' ? '1' : '2'}`, stageId: stage!.id, sourceId: source!.id, ownerId })
    .returning({ id: leads.id });
  return row!.id;
}

beforeAll(async () => {
  snapshot = await readAgentConfig();
  sendingBefore = (await getSetting('tg_sending_enabled')) === true;
  const [u] = await db
    .insert(users)
    .values({ phone: `+99893${SUFFIX}08`, fullName: `AI oyna egasi ${SUFFIX}`, passwordHash: 'x' })
    .returning({ id: users.id });
  ownerId = u!.id;
  const [acc] = await db
    .insert(tgAccounts)
    .values({ managerUserId: ownerId, tgPhone: `+99894${SUFFIX}08`, sessionEnc: 'v1.x.y.z', status: 'active', lastSeenAt: new Date() })
    .returning({ id: tgAccounts.id });
  accountId = acc!.id;
  agentLeadId = await leadFrom('agent', 'agent');
  advertLeadId = await leadFrom('instagram', 'advert');
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
  await clearChats();
  await stampAgentPump(accountId, true);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  vi.useRealTimers();
  await clearChats();
  await db.delete(notifications).where(eq(notifications.userId, ownerId));
  await db.delete(leads).where(inArray(leads.id, [agentLeadId, advertLeadId].filter(Boolean)));
  await db.delete(tgAccountGuard).where(eq(tgAccountGuard.accountId, accountId));
  await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
  await __restoreAgentConfig(snapshot);
  await setSetting('tg_sending_enabled', sendingBefore, ownerId);
  await db.update(users).set({ active: false }).where(eq(users.id, ownerId));
  await pgClient.end();
});

describe('a ✅ on an agent lead’s chat waits for the playbook window', () => {
  it('Thursday 19:56, the customer wrote half an hour ago: held to Friday 10:00 — where an advert lead goes at once', async () => {
    const evening = T('2026-10-29T19:56:00'); // the review's probe moment
    await clockAt(evening);
    const agentDraft = await askedAndDrafted(AGENT_PEER, agentLeadId, new Date(evening.getTime() - 30 * 60_000));
    const advertDraft = await askedAndDrafted(ADVERT_PEER, advertLeadId, new Date(evening.getTime() - 30 * 60_000));

    const morning = T('2026-10-30T10:00:00');
    expect(await decideDraft(actor(), agentDraft, 'send', {}, ctx())).toMatchObject({ ok: true, status: 'approved', sendAt: morning });
    const held = await outboxOf(agentDraft);
    expect(held!.nextStepAt.getTime()).toBe(morning.getTime());
    expect(held!.releaseAt?.getTime(), 'the approval’s age counts from the morning it was promised for').toBe(morning.getTime());

    // The control: not night, so every other chat's reply is queued for now.
    expect(await decideDraft(actor(), advertDraft, 'send', {}, ctx())).toMatchObject({ ok: true, status: 'approved', sendAt: evening });
    expect((await outboxOf(advertDraft))!.releaseAt).toBeNull();
  });

  it('Saturday 18:00: Monday 10:00 is past the question’s day, so the press is refused in words and nothing is queued', async () => {
    const saturday = T('2026-10-31T18:00:00');
    await clockAt(saturday);
    const agentDraft = await askedAndDrafted(AGENT_PEER, agentLeadId, new Date(saturday.getTime() - 30 * 60_000));
    expect(await decideDraft(actor(), agentDraft, 'send', {}, ctx())).toEqual({ ok: false, code: 'window_closed' });
    expect(await outboxOf(agentDraft)).toBeNull();
    const [d] = await db.select({ status: agentDrafts.status }).from(agentDrafts).where(eq(agentDrafts.id, agentDraft));
    expect(d!.status, 'the draft stands; nothing was decided for him').toBe('pending');

    // The control: Saturday 18:00 is no night — the advert lead's reply goes.
    const advertDraft = await askedAndDrafted(ADVERT_PEER, advertLeadId, new Date(saturday.getTime() - 30 * 60_000));
    expect(await decideDraft(actor(), advertDraft, 'send', {}, ctx())).toMatchObject({ ok: true, sendAt: saturday });
  });

  it('Sunday noon, asked at 11:30: held to Monday 10:00 (inside the question’s day)', async () => {
    const sunday = T('2026-11-01T12:00:00');
    await clockAt(sunday);
    const agentDraft = await askedAndDrafted(AGENT_PEER, agentLeadId, T('2026-11-01T11:30:00'));
    expect(await decideDraft(actor(), agentDraft, 'send', {}, ctx())).toMatchObject({ ok: true, sendAt: T('2026-11-02T10:00:00') });
  });

  it('inside the window the press holds nothing', async () => {
    const tuesday = T('2026-11-03T11:00:00');
    await clockAt(tuesday);
    const agentDraft = await askedAndDrafted(AGENT_PEER, agentLeadId, T('2026-11-03T10:40:00'));
    expect(await decideDraft(actor(), agentDraft, 'send', {}, ctx())).toMatchObject({ ok: true, sendAt: tuesday });
    expect((await outboxOf(agentDraft))!.releaseAt).toBeNull();
  });
});

describe('the send step asks the same window', () => {
  it('a reply approved at 16:58 and carried past 17:00 waits for the next morning — an advert lead’s does not', async () => {
    const approvedAt = T('2026-11-03T16:58:00');
    await clockAt(approvedAt);
    const agentDraft = await askedAndDrafted(AGENT_PEER, agentLeadId, T('2026-11-03T16:50:00'));
    const advertDraft = await askedAndDrafted(ADVERT_PEER, advertLeadId, T('2026-11-03T16:50:00'));
    expect(await decideDraft(actor(), agentDraft, 'send', {}, ctx())).toMatchObject({ ok: true, sendAt: approvedAt });
    expect(await decideDraft(actor(), advertDraft, 'send', {}, ctx())).toMatchObject({ ok: true, sendAt: approvedAt });

    // A gap or a flood carried both past 17:00.
    const late = T('2026-11-03T17:05:00');
    await clockAt(late);
    const agentRow = (await agentRowById((await outboxOf(agentDraft))!.id))!;
    const advertRow = (await agentRowById((await outboxOf(advertDraft))!.id))!;
    const agentFacts = await sendFactsFor(agentRow, late, stepCtx());
    expect(agentFacts.sendWindow).toBe('agent_lead');
    expect(agentSendVerdict(agentRow, agentFacts)).toEqual({
      ok: false,
      final: false,
      reason: 'agent_window',
      until: T('2026-11-04T10:00:00'),
    });
    const advertFacts = await sendFactsFor(advertRow, late, stepCtx());
    expect(advertFacts.sendWindow).toBe('default');
    expect(agentSendVerdict(advertRow, advertFacts)).toEqual({ ok: true });
  });

  it('a chat bound to a client is never the agent’s prospect, whatever lead it once was', async () => {
    const [d] = await db
      .select({ id: agentDrafts.id })
      .from(agentDrafts)
      .where(and(eq(agentDrafts.peerId, AGENT_PEER), eq(agentDrafts.leadId, agentLeadId)));
    expect(d, 'beforeEach cleared the chat').toBeUndefined();
    const { sendWindowFor } = await import('@/modules/wms/agent/send-window');
    expect(await sendWindowFor({ clientId: null, leadId: agentLeadId })).toBe('agent_lead');
    expect(await sendWindowFor({ clientId: '00000000-0000-4000-8000-000000000000', leadId: agentLeadId })).toBe('default');
    expect(await sendWindowFor({ clientId: null, leadId: advertLeadId })).toBe('default');
    expect(await sendWindowFor({ clientId: null, leadId: null })).toBe('default');
  });
});
