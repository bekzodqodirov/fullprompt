import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/modules/platform/db/client';
import { agentConfig, agentDesignations, agentDrafts, agentSamples, agentSignals, auditLog, notifications, roles, userRoles, users } from '@/modules/platform/db/schema';
import { usersWithRoles } from '@/modules/platform/notifications/service';
import {
  __forgetAgentToliq1aReady,
  __pretendAgentToliq1aBehind,
  __restoreAgentConfig,
  readAgentConfig,
  type AgentConfig,
} from '@/modules/wms/agent/config';
import {
  DESIGNATION_MAX,
  designated,
  designatedRows,
  designation,
  DesignationError,
  setDesignations,
  type AgentTopic,
} from '@/modules/wms/agent/designations';
import { PURGED_CARD_TEXT, purgeAgentChat } from '@/modules/wms/agent/purge';
import { dropDrainKicksSince } from './drain-kicks';

/**
 * WHO the machine tells (stage 1a §3.2, §7's designation row): the two readers through the real table.
 *
 *  - `designated()` never answers «nobody»: its own rows → the «rahbar va o‘rinbosar» pair's → the agent's alarm
 *    audience (its holder first, then every super_admin who can log in) — the very people `stepDown` alarms today.
 *  - `designatedRows()` NEVER falls back (a door that read the fallback would widen to the alarm audience), and read on
 *    a transaction's handle it sees that transaction's own uncommitted replace-all.
 *  - One migration behind 0151 (`__pretendAgentToliq1aBehind`): rows `[]`, the alarm audience, nothing throws.
 *  - The purge takes a chat's signals and samples, and blanks a signal's copy on a COLLEAGUE's row (J14, J15).
 *
 * agent_designations and agent_config are CONFIGURATION (#183): the stored rows are snapshotted and put back, the
 * config restored. Fixture users are deactivated, never deleted (the audit FK).
 */

const SUFFIX = String(Date.now()).slice(-6);
const KICKS_FROM = new Date().toISOString();
const TOPICS: AgentTopic[] = ['supervisor', 'big_cargo'];
const UNKNOWN_TOPIC = `zz_${SUFFIX}`;
const PEER = BigInt(`88${SUFFIX}`);

let configSnapshot: AgentConfig | null = null;
let storedSnapshot: (typeof agentDesignations.$inferSelect)[] = [];
const ids: Record<'holder' | 'boss' | 'deputy' | 'cargo' | 'leaver' | 'plain' | 'colleague', string> = {
  holder: '',
  boss: '',
  deputy: '',
  cargo: '',
  leaver: '',
  plain: '',
  colleague: '',
};
let superRoleId = '';

/** The super_admin role's door, as an actor; any other actor carries no role. */
const governor = () => ({ id: ids.boss, roles: ['super_admin'] as const });
const plainActor = () => ({ id: ids.plain, roles: ['sales_manager'] as const });
const ctx = () => ({ actorId: ids.boss });

async function minted(label: string, n: number): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99893${SUFFIX}${String(n).padStart(2, '0')}`, fullName: `Belgi ${label} ${SUFFIX}`, passwordHash: 'x' })
    .returning({ id: users.id });
  return u!.id;
}

/** The topic's stored rows — raw, leavers included. */
const stored = (topic: string) =>
  db
    .select({ userId: agentDesignations.userId, rank: agentDesignations.rank })
    .from(agentDesignations)
    .where(eq(agentDesignations.topic, topic))
    .orderBy(agentDesignations.rank);

/** Written straight into the table: the readers are under test here, not the writer. */
async function put(topic: string, userIds: string[]): Promise<void> {
  await db.delete(agentDesignations).where(eq(agentDesignations.topic, topic));
  if (userIds.length > 0) {
    await db.insert(agentDesignations).values(userIds.map((userId, i) => ({ topic, userId, rank: i + 1 })));
  }
}

async function refused(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof DesignationError) return err.code;
    throw err;
  }
  return 'not refused';
}

beforeAll(async () => {
  __forgetAgentToliq1aReady();
  configSnapshot = await readAgentConfig();
  storedSnapshot = await db.select().from(agentDesignations).where(inArray(agentDesignations.topic, TOPICS));
  ids.holder = await minted('egasi', 1);
  ids.boss = await minted('rahbar', 2);
  ids.deputy = await minted('orinbosar', 3);
  ids.cargo = await minted('yuk', 4);
  ids.leaver = await minted('ketgan', 5);
  ids.plain = await minted('oddiy', 6);
  ids.colleague = await minted('hamkasb', 7);
  const r = await db.query.roles.findFirst({ where: eq(roles.code, 'super_admin') });
  superRoleId = r!.id;
  await db.insert(userRoles).values({ userId: ids.boss, roleId: superRoleId });
  await db.update(agentConfig).set({ ownerUserId: ids.holder }).where(eq(agentConfig.id, 1));
});

beforeEach(async () => {
  __forgetAgentToliq1aReady();
  for (const topic of TOPICS) await put(topic, []);
  await db.update(users).set({ active: false }).where(eq(users.id, ids.leaver));
});

afterAll(async () => {
  __forgetAgentToliq1aReady();
  await dropDrainKicksSince(KICKS_FROM);
  await db.delete(agentDesignations).where(inArray(agentDesignations.topic, [...TOPICS, UNKNOWN_TOPIC]));
  if (storedSnapshot.length > 0) await db.insert(agentDesignations).values(storedSnapshot);
  await __restoreAgentConfig(configSnapshot);
  const fixture = Object.values(ids).filter(Boolean);
  await db.delete(notifications).where(inArray(notifications.userId, fixture));
  await db.delete(userRoles).where(and(eq(userRoles.roleId, superRoleId), inArray(userRoles.userId, fixture)));
  await db.update(users).set({ active: false }).where(inArray(users.id, fixture));
});

describe('designated() — for telling somebody: never «nobody»', () => {
  it('nobody designated anywhere → the agent’s alarm audience: its holder first, then every super_admin who can log in', async () => {
    const got = await designation('big_cargo');
    expect(got.source).toBe('alarm');
    expect(got.userIds[0]).toBe(ids.holder);
    expect(new Set(got.userIds)).toEqual(new Set([ids.holder, ...(await usersWithRoles(['super_admin']))]));
    expect(got.userIds).toContain(ids.boss);
    // The pair itself falls back the same way.
    expect((await designation('supervisor')).source).toBe('alarm');
  });

  it('the pair answers a topic nobody was named for; a topic’s own rows answer for themselves, by rank', async () => {
    await put('supervisor', [ids.boss, ids.deputy]);
    expect(await designation('big_cargo')).toEqual({ userIds: [ids.boss, ids.deputy], source: 'supervisor' });
    expect(await designation('supervisor')).toEqual({ userIds: [ids.boss, ids.deputy], source: 'own' });
    await put('big_cargo', [ids.cargo]);
    expect(await designated('big_cargo')).toEqual([ids.cargo]);
  });

  it('a leaver is skipped — and a topic of leavers only falls back rather than going quiet', async () => {
    await put('supervisor', [ids.deputy]);
    await put('big_cargo', [ids.leaver, ids.cargo]);
    expect(await designated('big_cargo')).toEqual([ids.cargo]);
    await put('big_cargo', [ids.leaver]);
    expect(await designation('big_cargo')).toEqual({ userIds: [ids.deputy], source: 'supervisor' });
  });

  it('the holder is in the alarm audience only while he can log in (every answer is somebody the bot can reach)', async () => {
    await db.update(users).set({ active: false }).where(eq(users.id, ids.holder));
    try {
      const got = await designation('big_cargo');
      expect(got.source).toBe('alarm');
      expect(got.userIds).not.toContain(ids.holder);
      expect(got.userIds).toContain(ids.boss);
    } finally {
      await db.update(users).set({ active: true }).where(eq(users.id, ids.holder));
    }
  });

  it('a stored topic the registry does not know is read by nobody', async () => {
    await db.insert(agentDesignations).values({ topic: UNKNOWN_TOPIC, userId: ids.plain, rank: 1 });
    try {
      expect(await designatedRows(UNKNOWN_TOPIC as AgentTopic, db)).toEqual([]);
      const got = await designation(UNKNOWN_TOPIC as AgentTopic);
      expect(got.source).toBe('alarm');
      expect(got.userIds).not.toContain(ids.plain);
    } finally {
      await db.delete(agentDesignations).where(eq(agentDesignations.topic, UNKNOWN_TOPIC));
    }
  });
});

describe('designatedRows() — for letting somebody in: its own rows, never the fallback', () => {
  it('an empty topic answers [] even while the pair and the alarm audience have people (a door must not widen)', async () => {
    await put('supervisor', [ids.boss, ids.deputy]);
    expect(await designatedRows('big_cargo', db)).toEqual([]);
    expect(await designatedRows('supervisor', db)).toEqual([
      { userId: ids.boss, rank: 1 },
      { userId: ids.deputy, rank: 2 },
    ]);
  });

  it('a leaver is skipped, the others keep their stored rank', async () => {
    await put('big_cargo', [ids.leaver, ids.cargo]);
    expect(await designatedRows('big_cargo', db)).toEqual([{ userId: ids.cargo, rank: 2 }]);
  });

  it('read on the transaction’s handle it sees the transaction’s own uncommitted replace-all; the pool does not', async () => {
    await put('big_cargo', [ids.cargo]);
    const seen = await db
      .transaction(async (tx) => {
        await tx.delete(agentDesignations).where(eq(agentDesignations.topic, 'big_cargo'));
        await tx.insert(agentDesignations).values({ topic: 'big_cargo', userId: ids.deputy, rank: 1 });
        const inside = await designatedRows('big_cargo', tx);
        const pool = await designatedRows('big_cargo', db);
        throw Object.assign(new Error('roll back'), { seen: { inside, pool } });
      })
      .catch((err: { seen?: unknown }) => err.seen);
    expect(seen).toEqual({ inside: [{ userId: ids.deputy, rank: 1 }], pool: [{ userId: ids.cargo, rank: 1 }] });
    // Rolled back: what was committed stands.
    expect(await designatedRows('big_cargo', db)).toEqual([{ userId: ids.cargo, rank: 1 }]);
  });
});

describe('one migration behind 0151', () => {
  it('rows answer [], designated() its last fallback, and nothing throws', async () => {
    await put('supervisor', [ids.boss]);
    await put('big_cargo', [ids.cargo]);
    __pretendAgentToliq1aBehind();
    try {
      expect(await designatedRows('big_cargo', db)).toEqual([]);
      expect(await db.transaction((tx) => designatedRows('supervisor', tx))).toEqual([]);
      const got = await designation('big_cargo');
      expect(got.source).toBe('alarm');
      expect(got.userIds[0]).toBe(ids.holder);
      expect(await refused(() => setDesignations(governor(), 'big_cargo', [ids.cargo], ctx()))).toBe('not_ready');
    } finally {
      __forgetAgentToliq1aReady();
    }
  });
});

describe('setDesignations — «Kim javob beradi» saved', () => {
  it('the door is setAgentSeat’s: a person without the super_admin role is refused before anything is read', async () => {
    expect(await refused(() => setDesignations(plainActor(), 'big_cargo', [ids.cargo], { actorId: ids.plain }))).toBe('forbidden');
    expect(await stored('big_cargo')).toEqual([]);
  });

  it('replace-all in the order given, a duplicate keeping its first place, audited; an empty list clears', async () => {
    await put('supervisor', [ids.cargo]);
    const after = await setDesignations(governor(), 'supervisor', [ids.boss, ids.deputy, ids.boss], ctx());
    expect(after).toEqual([
      { userId: ids.boss, rank: 1 },
      { userId: ids.deputy, rank: 2 },
    ]);
    expect(await stored('supervisor')).toEqual(after);
    const [audit] = await db
      .select({ before: auditLog.before, after: auditLog.after, actorId: auditLog.actorId })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'agent_designations'), eq(auditLog.actorId, ids.boss)))
      .orderBy(sql`${auditLog.createdAt} DESC`)
      .limit(1);
    expect(audit).toMatchObject({
      before: { topic: 'supervisor', userIds: [ids.cargo] },
      after: { topic: 'supervisor', userIds: [ids.boss, ids.deputy] },
    });
    expect(await setDesignations(governor(), 'supervisor', [], ctx())).toEqual([]);
    expect(await stored('supervisor')).toEqual([]);
  });

  it('refuses in words: an unknown topic, too many, a leaver, a value that is no id — and writes nothing', async () => {
    await put('big_cargo', [ids.cargo]);
    expect(await refused(() => setDesignations(governor(), 'nazoratchi', [ids.cargo], ctx()))).toBe('unknown_topic');
    const ten = Array.from({ length: DESIGNATION_MAX + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(await refused(() => setDesignations(governor(), 'big_cargo', ten, ctx()))).toBe('too_many');
    expect(await refused(() => setDesignations(governor(), 'big_cargo', [ids.deputy, ids.leaver], ctx()))).toBe('not_staff');
    expect(await refused(() => setDesignations(governor(), 'big_cargo', ['nobody'], ctx()))).toBe('not_staff');
    expect(await stored('big_cargo')).toEqual([{ userId: ids.cargo, rank: 1 }]);
  });
});

describe('the purge takes a chat’s signals and samples (J14, J15)', () => {
  async function chatRows(): Promise<{ draftId: string; notificationId: string }> {
    const [draft] = await db
      .insert(agentDrafts)
      .values({ managerUserId: ids.holder, peerId: PEER, anchorTgMessageId: BigInt(`9${SUFFIX}`), proposedBody: 'x', status: 'approved' })
      .returning({ id: agentDrafts.id });
    await db.insert(agentSignals).values({ topic: 'big_cargo', managerUserId: ids.holder, peerId: PEER, dedupeKey: `big_cargo:${PEER}:${SUFFIX}` });
    await db.insert(agentSamples).values({ day: '2026-11-20', draftId: draft!.id, managerUserId: ids.holder, peerId: PEER, pos: 1 });
    // The signal's copy on a COLLEAGUE's row — the purge must find it by the chat it names, not by its recipient.
    const [card] = await db
      .insert(notifications)
      .values({
        userId: ids.colleague,
        channel: 'telegram',
        type: 'AgentSignal',
        payload: { text: '🚛 Katta yuk: 24 kub', managerUserId: ids.holder, peerId: String(PEER) },
        status: 'sent',
      })
      .returning({ id: notifications.id });
    return { draftId: draft!.id, notificationId: card!.id };
  }

  const countOf = async () => ({
    signals: (await db.select().from(agentSignals).where(and(eq(agentSignals.managerUserId, ids.holder), eq(agentSignals.peerId, PEER)))).length,
    samples: (await db.select().from(agentSamples).where(and(eq(agentSamples.managerUserId, ids.holder), eq(agentSamples.peerId, PEER)))).length,
  });

  it('one migration behind it purges what it can and touches neither table — nothing throws', async () => {
    await chatRows();
    __pretendAgentToliq1aBehind();
    try {
      await purgeAgentChat(ids.holder, PEER);
    } finally {
      __forgetAgentToliq1aReady();
    }
    // The drafts went (and a sample follows its draft by CASCADE); the signal row, keyed by the chat alone, waits.
    expect(await countOf()).toEqual({ signals: 1, samples: 0 });
    await purgeAgentChat(ids.holder, PEER);
    expect(await countOf()).toEqual({ signals: 0, samples: 0 });
  });

  it('both tables are emptied for the chat, and the colleague’s copy of the signal is blanked', async () => {
    const { notificationId } = await chatRows();
    await purgeAgentChat(ids.holder, PEER);
    expect(await countOf()).toEqual({ signals: 0, samples: 0 });
    const [card] = await db.select({ payload: notifications.payload }).from(notifications).where(eq(notifications.id, notificationId));
    expect((card!.payload as { text: string }).text).toBe(PURGED_CARD_TEXT);
  });
});
