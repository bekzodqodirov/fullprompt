import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/modules/platform/db/client';
import { clearSignal, signalStanding } from '@/modules/platform/diagnostics/signals';
import {
  agentConfig,
  agentDesignations,
  agentRuns,
  clients,
  notifications,
  roles,
  settings,
  tgMessages,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { setSetting } from '@/modules/platform/settings/service';
import { __restoreAgentConfig, readAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { agentSweep } from '@/modules/wms/agent/jobs';
import { LIVENESS_CLEARED_TEXT, LIVENESS_SIGNAL_KEY, livenessStanding, sweepUnanswered } from '@/modules/wms/agent/liveness';
import { dropDrainKicksSince } from './drain-kicks';

/**
 * «AI sotuvchi javob bermayapti» against a real database (stage 1a §4.5, R9; §7's liveness row). Every clock is a
 * LITERAL handed to the sweep as `now` — never the real one (#1790): Tuesday 2026-11-17, 12:00 Tashkent (07:00 UTC).
 *
 *  - a card-bound line 15 minutes old with no run: ONE alarm to EACH rank of the pair and one state row; the next
 *    sweep sends nothing; a draft for that anchor takes the row away with ONE «qolmadi» line;
 *  - nobody designated: the fallback (the account holder first) is told;
 *  - no alarm for a line at 23:30 Tashkent, a line three hours old, a chat whose newest line is ours, a refusal by
 *    design (`human_active`), the setting at 0, the agent switched off — and yesterday's draft of the same chat
 *    does not hide today's silence (by anchor, never by chat).
 *
 * The suites run the step OFF (vitest.config `AGENT_LIVENESS`): this file is the one it is on for. The state row,
 * agent_designations, agent_config and the setting are CONFIGURATION (#183) — put back in afterAll; fixture users
 * are deactivated, never deleted (the audit FK).
 */

const SUFFIX = String(Date.now()).slice(-6);
const KICKS_FROM = new Date().toISOString();
const NOW = new Date('2026-11-17T07:00:00Z');
const MIN = 60_000;
let peerSeq = BigInt(`55${SUFFIX}00`);
let msgSeq = 7_000n;

const ids = { holder: '', boss: '', deputy: '', client: '' };
let superRoleId = '';
let configSnapshot: AgentConfig | null = null;
let designationSnapshot: (typeof agentDesignations.$inferSelect)[] = [];
let minutesSnapshot: (typeof settings.$inferSelect)[] = [];
const liveSnapshot = process.env.AGENT_LIVENESS;

async function minted(label: string, n: number): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99894${SUFFIX}${String(n).padStart(2, '0')}`, fullName: `Jonli ${label} ${SUFFIX}`, passwordHash: 'x' })
    .returning({ id: users.id });
  return u!.id;
}

function nextPeer(): bigint {
  peerSeq += 1n;
  return peerSeq;
}

/** A line in a chat bound to the client, at `at` (a stored line is always a card's — `tg_messages_owner_check`). */
async function line(peer: bigint, direction: 'in' | 'out', at: Date): Promise<bigint> {
  msgSeq += 1n;
  await db.insert(tgMessages).values({
    clientId: ids.client,
    managerUserId: ids.holder,
    peerId: peer,
    tgMessageId: msgSeq,
    direction,
    body: direction === 'in' ? 'narxi qancha?' : 'javob',
    sentAt: at,
  });
  return msgSeq;
}

async function runFor(peer: bigint, anchor: bigint, outcome: string, error: string | null, at: Date): Promise<void> {
  await db.insert(agentRuns).values({ managerUserId: ids.holder, peerId: peer, trigger: 'inbound', anchorTgMessageId: anchor, outcome, error, createdAt: at });
}

async function put(topic: string, userIds: string[]): Promise<void> {
  await db.delete(agentDesignations).where(eq(agentDesignations.topic, topic));
  if (userIds.length > 0) await db.insert(agentDesignations).values(userIds.map((userId, i) => ({ topic, userId, rank: i + 1 })));
}

const alarms = (userId: string) =>
  db
    .select({ text: notifications.payload })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, 'AgentLiveness')))
    .then((rows) => rows.map((r) => (r.text as { text: string }).text));

const config = () => ({ ownerUserId: ids.holder });

beforeAll(async () => {
  process.env.AGENT_LIVENESS = 'on';
  process.env.APP_URL = process.env.APP_URL ?? 'https://gsrwms.uz';
  configSnapshot = await readAgentConfig();
  designationSnapshot = await db.select().from(agentDesignations).where(inArray(agentDesignations.topic, ['supervisor', 'big_cargo']));
  minutesSnapshot = await db.select().from(settings).where(eq(settings.key, 'agent_liveness_minutes'));
  ids.holder = await minted('egasi', 1);
  ids.boss = await minted('rahbar', 2);
  ids.deputy = await minted('orinbosar', 3);
  const r = await db.query.roles.findFirst({ where: eq(roles.code, 'super_admin') });
  superRoleId = r!.id;
  await db.insert(userRoles).values({ userId: ids.boss, roleId: superRoleId });
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `JL${SUFFIX}`, name: `Jonli mijoz ${SUFFIX}`, phones: [`+99895${SUFFIX}31`], salesManagerId: ids.holder })
    .returning({ id: clients.id });
  ids.client = c!.id;
});

beforeEach(async () => {
  await clearSignal(LIVENESS_SIGNAL_KEY);
  await put('supervisor', [ids.boss, ids.deputy]);
  await put('big_cargo', []);
  await setSetting('agent_liveness_minutes', 10, null);
  await db.delete(notifications).where(inArray(notifications.userId, [ids.holder, ids.boss, ids.deputy]));
  // Every chat of the holder starts empty: each test writes its own lines.
  await db.delete(agentRuns).where(eq(agentRuns.managerUserId, ids.holder));
  await db.delete(tgMessages).where(eq(tgMessages.managerUserId, ids.holder));
});

afterAll(async () => {
  process.env.AGENT_LIVENESS = liveSnapshot;
  await clearSignal(LIVENESS_SIGNAL_KEY);
  await dropDrainKicksSince(KICKS_FROM);
  await db.delete(agentDesignations).where(inArray(agentDesignations.topic, ['supervisor', 'big_cargo']));
  if (designationSnapshot.length > 0) await db.insert(agentDesignations).values(designationSnapshot);
  await db.delete(settings).where(eq(settings.key, 'agent_liveness_minutes'));
  if (minutesSnapshot.length > 0) await db.insert(settings).values(minutesSnapshot);
  await __restoreAgentConfig(configSnapshot);
  const fixture = [ids.holder, ids.boss, ids.deputy].filter(Boolean);
  await db.delete(agentRuns).where(eq(agentRuns.managerUserId, ids.holder));
  await db.delete(tgMessages).where(eq(tgMessages.managerUserId, ids.holder));
  await db.delete(notifications).where(inArray(notifications.userId, fixture));
  await db.delete(userRoles).where(and(eq(userRoles.roleId, superRoleId), inArray(userRoles.userId, fixture)));
  await db.update(users).set({ active: false }).where(inArray(users.id, fixture));
});

describe('a customer left unanswered in working hours', () => {
  it('a line 15 minutes old with no run: ONE alarm to each rank of the pair and one state row; the next sweep says nothing more', async () => {
    const peer = nextPeer();
    await line(peer, 'in', new Date(NOW.getTime() - 15 * MIN));
    expect(await sweepUnanswered(config(), NOW)).toBe(1);
    const row = await signalStanding(LIVENESS_SIGNAL_KEY);
    expect(row).not.toBeNull();
    const bossSaw = await alarms(ids.boss);
    const deputySaw = await alarms(ids.deputy);
    expect(bossSaw).toHaveLength(1);
    expect(deputySaw).toHaveLength(1);
    expect(bossSaw[0]).toMatch(/^⚠️ AI sotuvchi javob bermayapti: 1 ta mijoz 15 daqiqadan beri kutyapti\./u);
    // J17: the page's door admits the super_admin and not the deputy — the link and «oching» only for the first.
    expect(bossSaw[0]).toContain('AI sahifasini oching.');
    expect(deputySaw[0]).toBe('⚠️ AI sotuvchi javob bermayapti: 1 ta mijoz 15 daqiqadan beri kutyapti.');
    expect(await livenessStanding(NOW)).toEqual({ n: 1, minutes: 15 });

    expect(await sweepUnanswered(config(), new Date(NOW.getTime() + MIN))).toBe(1);
    expect(await alarms(ids.boss)).toHaveLength(1);
    expect(await alarms(ids.deputy)).toHaveLength(1);
  });

  it('a draft for that anchor takes the row away and ONE «qolmadi» line goes to the same people', async () => {
    const peer = nextPeer();
    const anchor = await line(peer, 'in', new Date(NOW.getTime() - 15 * MIN));
    await sweepUnanswered(config(), NOW);
    await runFor(peer, anchor, 'draft', null, new Date(NOW.getTime() + MIN));
    expect(await sweepUnanswered(config(), new Date(NOW.getTime() + 2 * MIN))).toBe(0);
    expect(await signalStanding(LIVENESS_SIGNAL_KEY)).toBeNull();
    expect(await alarms(ids.boss)).toEqual([expect.stringMatching(/^⚠️/u), LIVENESS_CLEARED_TEXT]);
    expect(await alarms(ids.deputy)).toEqual([expect.stringMatching(/^⚠️/u), LIVENESS_CLEARED_TEXT]);
    // …once: a further quiet sweep says nothing.
    await sweepUnanswered(config(), new Date(NOW.getTime() + 3 * MIN));
    expect(await alarms(ids.boss)).toHaveLength(2);
  });

  it('a fault refusal (the listener behind) is unanswered; an error is; a stale reservation is', async () => {
    const a = nextPeer();
    const b = nextPeer();
    const c = nextPeer();
    await runFor(a, await line(a, 'in', new Date(NOW.getTime() - 20 * MIN)), 'refused', 'listener_behind', new Date(NOW.getTime() - 19 * MIN));
    await runFor(b, await line(b, 'in', new Date(NOW.getTime() - 20 * MIN)), 'error', 'boom', new Date(NOW.getTime() - 19 * MIN));
    await runFor(c, await line(c, 'in', new Date(NOW.getTime() - 20 * MIN)), 'reserved', null, new Date(NOW.getTime() - 19 * MIN));
    expect(await sweepUnanswered(config(), NOW)).toBe(3);
  });

  it('yesterday’s draft of the same chat does not hide today’s silence — the run is the ANCHOR’s', async () => {
    const peer = nextPeer();
    const old = await line(peer, 'in', new Date(NOW.getTime() - 26 * 60 * MIN));
    await runFor(peer, old, 'draft', null, new Date(NOW.getTime() - 26 * 60 * MIN + MIN));
    await line(peer, 'out', new Date(NOW.getTime() - 25 * 60 * MIN));
    await line(peer, 'in', new Date(NOW.getTime() - 15 * MIN));
    expect(await sweepUnanswered(config(), NOW)).toBe(1);
  });

  it('nobody designated: the fallback is told — the account holder first', async () => {
    await put('supervisor', []);
    const peer = nextPeer();
    await line(peer, 'in', new Date(NOW.getTime() - 15 * MIN));
    // `designated()` falls back to the agent's alarm audience, read off the CONFIG's holder.
    await db.update(agentConfig).set({ ownerUserId: ids.holder }).where(eq(agentConfig.id, 1));
    try {
      await sweepUnanswered(config(), NOW);
      expect(await alarms(ids.holder)).toHaveLength(1);
      expect(await alarms(ids.deputy)).toHaveLength(0);
    } finally {
      await __restoreAgentConfig(configSnapshot);
    }
  });
});

describe('no alarm', () => {
  it('for a line written at 23:30 Tashkent — nobody is awake to act; the morning line counts it', async () => {
    const peer = nextPeer();
    const late = new Date('2026-11-17T18:30:00Z');
    await line(peer, 'in', late);
    expect(await sweepUnanswered(config(), new Date(late.getTime() + 20 * MIN))).toBe(0);
    expect(await signalStanding(LIVENESS_SIGNAL_KEY)).toBeNull();
  });

  it('for a line three hours old, and a chat whose newest line is ours', async () => {
    const old = nextPeer();
    await line(old, 'in', new Date(NOW.getTime() - 3 * 60 * MIN));
    const ours = nextPeer();
    await line(ours, 'in', new Date(NOW.getTime() - 30 * MIN));
    await line(ours, 'out', new Date(NOW.getTime() - 20 * MIN));
    expect(await sweepUnanswered(config(), NOW)).toBe(0);
    expect(await alarms(ids.boss)).toHaveLength(0);
  });

  it('for a refusal by design (`human_active`), and for a line younger than the setting', async () => {
    const mine = nextPeer();
    await runFor(mine, await line(mine, 'in', new Date(NOW.getTime() - 15 * MIN)), 'refused', 'human_active', new Date(NOW.getTime() - 14 * MIN));
    const young = nextPeer();
    await line(young, 'in', new Date(NOW.getTime() - 5 * MIN));
    expect(await sweepUnanswered(config(), NOW)).toBe(0);
  });

  it('with the setting at 0 — and a standing row is taken down without a word', async () => {
    const peer = nextPeer();
    await line(peer, 'in', new Date(NOW.getTime() - 15 * MIN));
    await sweepUnanswered(config(), NOW);
    expect(await signalStanding(LIVENESS_SIGNAL_KEY)).not.toBeNull();
    await setSetting('agent_liveness_minutes', 0, null);
    expect(await sweepUnanswered(config(), NOW)).toBe(0);
    expect(await signalStanding(LIVENESS_SIGNAL_KEY)).toBeNull();
    expect(await alarms(ids.boss)).toHaveLength(1);
  });

  it('with the agent switched off: the sweep does not reach the step', async () => {
    const peer = nextPeer();
    await line(peer, 'in', new Date(NOW.getTime() - 15 * MIN));
    await db.update(agentConfig).set({ ownerUserId: ids.holder, mode: 'off' }).where(eq(agentConfig.id, 1));
    try {
      const out = await agentSweep(NOW);
      expect(out.waiting).toBe(0);
      expect(await signalStanding(LIVENESS_SIGNAL_KEY)).toBeNull();
      expect(await alarms(ids.boss)).toHaveLength(0);
    } finally {
      await __restoreAgentConfig(configSnapshot);
    }
  });

  it('with the suites’ switch off: the step leaves everything as it is', async () => {
    const peer = nextPeer();
    await line(peer, 'in', new Date(NOW.getTime() - 15 * MIN));
    process.env.AGENT_LIVENESS = 'off';
    try {
      expect(await sweepUnanswered(config(), NOW)).toBe(0);
      expect(await signalStanding(LIVENESS_SIGNAL_KEY)).toBeNull();
    } finally {
      process.env.AGENT_LIVENESS = 'on';
    }
  });
});
