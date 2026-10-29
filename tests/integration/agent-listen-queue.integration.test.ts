import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/modules/platform/db/client';
import {
  agentConfig,
  agentConversations,
  agentRuns,
  clients,
  leads,
  notifications,
  roles,
  tgChatRules,
  tgMessages,
  tgPeerPulls,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { getBoss } from '@/modules/platform/jobs/boss';
import { queuePull } from '@/modules/wms/agent/bot-door';
import { readAgentConfig, __restoreAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { agentSweep } from '@/modules/wms/agent/jobs';
import { JOB_AGENT_INBOUND } from '@/modules/wms/agent/queues';
import { decideChat, openLeadForChat } from '@/modules/wms/crm/chat-rules';

/**
 * Why a card could come 23 minutes late (2026-10-29), against a real
 * database and pg-boss's real table:
 *
 *  - the WEB tray's answer to a stranger asks for the same one-chat pull the
 *    bot's stranger card does — on the account the AI speaks from, and only
 *    there — so the opening burst is drafted, not only the next message;
 *  - the sweep asks for a line ONCE while its job is still waiting, so a
 *    busy worker is not handed the same line again every minute.
 *
 * agent_config is CONFIGURATION (#183) — snapshotted and restored. The jobs
 * this file puts on `agent.inbound` are deleted by peer in afterAll, so the
 * e2e server that shares the database never works them. Fixture people are
 * deactivated, never deleted (the audit FK).
 */

const SUFFIX = String(Date.now()).slice(-6);
const PEER = BigInt(`81${SUFFIX}`);
const OTHER_PEER = BigInt(`82${SUFFIX}`);
const PEERS = [PEER, OTHER_PEER];
let ownerId = '';
let otherId = '';
let clientId = '';
let snapshot: AgentConfig | null = null;
let keyBefore: string | undefined;
const madeLeads: string[] = [];
let msgSeq = 7000n;

async function makeUser(name: string, role: string, tail: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99895${SUFFIX}${tail}`, fullName: name, passwordHash: 'x' })
    .returning({ id: users.id });
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  return u!.id;
}

/** A stranger's tray question on `manager`'s account — what the listener writes for an «ask». */
async function strangerRule(manager: string, peer: bigint, tail: string): Promise<string> {
  const [r] = await db
    .insert(tgChatRules)
    .values({ managerUserId: manager, peerId: peer, peerTitle: `Notanish ${tail}`, peerPhone: `+99898${SUFFIX}${tail}` })
    .returning({ id: tgChatRules.id });
  return r!.id;
}

async function pulls(manager: string, peer: bigint) {
  return db
    .select()
    .from(tgPeerPulls)
    .where(and(eq(tgPeerPulls.managerUserId, manager), eq(tgPeerPulls.peerId, peer)));
}

async function openLead(ruleId: string, actor: string): Promise<string> {
  const { leadId } = await openLeadForChat(ruleId, { actorId: actor });
  madeLeads.push(leadId);
  return leadId;
}

/** The agent.inbound jobs this file left on pg-boss's table, by state. */
async function inboundJobs(peer: bigint) {
  return db.execute<{ id: string; state: string; origin: string; attempt: string | null }>(sql`
    SELECT id::text, state::text, data->>'origin' AS origin, data->>'attempt' AS attempt
      FROM pgboss.job
     WHERE name = ${JOB_AGENT_INBOUND} AND data->>'peerId' = ${peer.toString()}`);
}

async function clearJobs() {
  const present = await db.execute<{ job: boolean }>(sql`SELECT to_regclass('pgboss.job') IS NOT NULL AS job`);
  if (!present[0]?.job) return;
  await db.execute(sql`
    DELETE FROM pgboss.job
     WHERE name = ${JOB_AGENT_INBOUND}
       AND data->>'peerId' IN (${sql.join(PEERS.map((p) => sql`${p.toString()}`), sql`, `)})`);
}

async function clearChats() {
  await clearJobs();
  await db.delete(tgPeerPulls).where(inArray(tgPeerPulls.peerId, PEERS));
  await db.delete(agentRuns).where(inArray(agentRuns.peerId, PEERS));
  await db.delete(agentConversations).where(inArray(agentConversations.peerId, PEERS));
  await db.delete(tgChatRules).where(inArray(tgChatRules.peerId, PEERS));
  await db.delete(tgMessages).where(inArray(tgMessages.peerId, PEERS));
  await db.delete(notifications).where(and(inArray(notifications.userId, [ownerId, otherId]), sql`${notifications.type} LIKE 'Agent%'`));
}

async function inbound(agoMs: number): Promise<bigint> {
  msgSeq += 1n;
  await db.insert(tgMessages).values({
    clientId,
    managerUserId: ownerId,
    peerId: PEER,
    tgMessageId: msgSeq,
    direction: 'in',
    body: 'Assalomu alaykum',
    sentAt: new Date(Date.now() - agoMs),
  });
  return msgSeq;
}

async function agentOn(on: boolean) {
  await db
    .update(agentConfig)
    .set(
      on
        ? { mode: 'shadow', ownerUserId: ownerId, sessionExclusiveAt: new Date(), sessionExclusiveBy: ownerId, startedAt: new Date() }
        : { mode: 'off' },
    )
    .where(eq(agentConfig.id, 1));
}

beforeAll(async () => {
  snapshot = await readAgentConfig();
  if (!snapshot) throw new Error('0138 is not applied on this database');
  keyBefore = process.env.ANTHROPIC_API_KEY;
  ownerId = await makeUser(`AI navbat egasi ${SUFFIX}`, 'super_admin', '01');
  otherId = await makeUser(`Boshqa menejer ${SUFFIX}`, 'sales_manager', '02');
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `AQ${SUFFIX}`, name: `Navbat Mijoz ${SUFFIX}`, phones: [`+99897${SUFFIX}44`], salesManagerId: ownerId })
    .returning({ id: clients.id });
  clientId = c!.id;
});

beforeEach(async () => {
  await clearChats();
  await agentOn(true);
});

afterAll(async () => {
  await clearChats();
  if (madeLeads.length) await db.delete(leads).where(inArray(leads.id, madeLeads));
  await db.delete(clients).where(eq(clients.id, clientId));
  await __restoreAgentConfig(snapshot);
  if (keyBefore === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = keyBefore;
  await db.update(users).set({ active: false }).where(inArray(users.id, [ownerId, otherId]));
  await getBoss()
    .stop({ graceful: false, wait: true })
    .catch(() => undefined);
});

describe('the web tray’s answer pulls the opening burst on the AI’s account (L2)', () => {
  it('«Yangi lid» on the account the AI speaks from leaves ONE open pull, asked by whoever pressed', async () => {
    const ruleId = await strangerRule(ownerId, PEER, '11');
    await openLead(ruleId, otherId);
    const [pull, ...more] = await pulls(ownerId, PEER);
    expect(more).toHaveLength(0);
    expect(pull).toMatchObject({ requestedBy: otherId, doneAt: null, claimedAt: null });
  });

  it('«Bu mijoz» there pulls too — and on another manager’s account neither door does', async () => {
    const own = await strangerRule(ownerId, PEER, '12');
    await decideChat({ id: own, decision: 'include', clientId }, { actorId: ownerId });
    expect(await pulls(ownerId, PEER)).toHaveLength(1);

    const theirs = await strangerRule(otherId, OTHER_PEER, '13');
    await openLead(theirs, otherId);
    expect(await pulls(otherId, OTHER_PEER)).toHaveLength(0);
    await db.delete(tgChatRules).where(eq(tgChatRules.id, theirs));
    const again = await strangerRule(otherId, OTHER_PEER, '14');
    await decideChat({ id: again, decision: 'include', clientId }, { actorId: otherId });
    expect(await pulls(otherId, OTHER_PEER)).toHaveLength(0);
  });

  it('twice is one pull — the press again, and the bot’s own door beside it', async () => {
    const ruleId = await strangerRule(ownerId, PEER, '15');
    await openLead(ruleId, ownerId);
    // A stale tab's second press finds the chat decided: nothing more is asked.
    await openLead(ruleId, ownerId);
    // The stranger card's door asks the same row, and the open-pull index keeps it one.
    await queuePull(ownerId, PEER);
    await queuePull(ownerId, PEER);
    expect(await pulls(ownerId, PEER)).toHaveLength(1);
  });

  it('only a chat still in question, only while the AI runs there — «never» re-decided and an AI switched off keep «future only»', async () => {
    const excluded = await strangerRule(ownerId, PEER, '16');
    await decideChat({ id: excluded, decision: 'exclude' }, { actorId: ownerId });
    await decideChat({ id: excluded, decision: 'include', clientId }, { actorId: ownerId });
    expect(await pulls(ownerId, PEER)).toHaveLength(0);

    await db.delete(tgChatRules).where(eq(tgChatRules.id, excluded));
    await agentOn(false);
    const off = await strangerRule(ownerId, PEER, '17');
    await openLead(off, ownerId);
    expect(await pulls(ownerId, PEER)).toHaveLength(0);
  });
});

describe('the sweep asks for a line once while its job waits (L4)', () => {
  beforeAll(() => {
    // The gap pass runs only where a model is configured; no job is worked here, so no call is made.
    process.env.ANTHROPIC_API_KEY = 'agent-listen-queue-test';
  });

  it('two sweeps with the first job still waiting put ONE job on the queue', async () => {
    const anchor = await inbound(3 * 60_000);
    await agentSweep(new Date());
    await agentSweep(new Date());
    const jobs = await inboundJobs(PEER);
    expect(jobs.map((j) => [j.state, j.origin])).toEqual([['created', 'sweep']]);
    expect(anchor).toBeGreaterThan(0n);
  });

  it('a job a killed process left «active» does not stand in for the line — the next sweep asks again (K24)', async () => {
    await inbound(3 * 60_000);
    await agentSweep(new Date());
    const [first] = await inboundJobs(PEER);
    await db.execute(sql`UPDATE pgboss.job SET state = 'active', started_on = now() WHERE id = ${first!.id}::uuid`);
    await agentSweep(new Date());
    const states = (await inboundJobs(PEER)).map((j) => j.state).sort();
    expect(states).toEqual(['active', 'created']);
  });

  it('an errored run’s one retry is asked once too', async () => {
    const anchor = await inbound(10 * 60_000);
    await db.insert(agentRuns).values({
      managerUserId: ownerId,
      peerId: PEER,
      trigger: 'inbound',
      anchorTgMessageId: anchor,
      attempt: 0,
      outcome: 'error',
      error: 'interrupted',
      createdAt: new Date(Date.now() - 5 * 60_000),
    });
    await agentSweep(new Date());
    await agentSweep(new Date());
    const jobs = await inboundJobs(PEER);
    expect(jobs.map((j) => [j.state, j.attempt])).toEqual([['created', '1']]);
  });
});
