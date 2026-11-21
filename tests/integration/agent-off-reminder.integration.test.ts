import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/modules/platform/db/client';
import { agentDesignations, agentRuns, agentSignals, clients, notifications, roles, tgMessages, userRoles, users } from '@/modules/platform/db/schema';
import { AGENT_CONFIG_AUDIT_ID } from '@/modules/wms/agent/config';
import { agentForcedOff, OFF_REMINDER_TOPIC, sweepOffReminder, type ForcedOff } from '@/modules/wms/agent/off-reminder';
import { dropDrainKicksSince } from './drain-kicks';

/**
 * His 18 a against a real database: «AI o'zi o'chib qolsa va siz qayta yoqmasangiz: har kuni 08:40 da va ish vaqtida
 * har 2 soatda sizga bitta eslatma keladi». Every clock is a LITERAL handed as `now` — never the real one (#1790):
 * the machine switched the agent off on Tuesday 2026-11-17 at 10:00 Tashkent (05:00 UTC).
 *
 *  - the slot that began before the off says nothing (the alarm just did); the next slot (10:40) says it ONCE to each
 *    of the pair — the page and «Qayta yoqish» only to the one the page admits; the same slot again, or two sweeps
 *    at once, say nothing more; 12:40 says it again; the night says nothing; 08:40 the next morning says it;
 *  - nothing once it is switched on, nothing when HE switched it off;
 *  - «Javobsiz mijozlar» counts the card-bound chats whose newest line, written since the off, is the customer's.
 *
 * The suites run the step OFF (vitest.config `AGENT_OFF_REMINDER`): this file is the one it is on for. The claims,
 * agent_designations and the switch are CONFIGURATION (#183) — put back in afterAll; fixture users are deactivated,
 * never deleted (the audit FK).
 */

const SUFFIX = String(Date.now()).slice(-6);
const KICKS_FROM = new Date().toISOString();
/** Tashkent is UTC+5 all year: `T(day, '10:40')` is that wall-clock minute. */
const T = (day: string, hm: string) => new Date(`${day}T${hm}:00+05:00`);
const D1 = '2026-11-17';
const D2 = '2026-11-18';
const OFF: ForcedOff = { reason: 'telegram_notice', at: T(D1, '10:00') };

let peerSeq = BigInt(`66${SUFFIX}00`);
let msgSeq = 9_000n;
const ids = { holder: '', boss: '', deputy: '', client: '' };
let superRoleId = '';
let designationSnapshot: (typeof agentDesignations.$inferSelect)[] = [];
const switchSnapshot = process.env.AGENT_OFF_REMINDER;

const offConfig = () => ({ mode: 'off' as const, ownerUserId: ids.holder });

async function minted(label: string, n: number): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99893${SUFFIX}${String(n).padStart(2, '0')}`, fullName: `Eslatma ${label} ${SUFFIX}`, passwordHash: 'x' })
    .returning({ id: users.id });
  return u!.id;
}

async function line(peer: bigint, direction: 'in' | 'out', at: Date): Promise<void> {
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
}

const nextPeer = () => (peerSeq += 1n);

const copies = (userId: string) =>
  db
    .select({ payload: notifications.payload })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, 'AgentForcedOff')))
    .then((rows) => rows.map((r) => (r.payload as { text: string }).text));

beforeAll(async () => {
  process.env.AGENT_OFF_REMINDER = 'on';
  process.env.APP_URL = process.env.APP_URL ?? 'https://gsrwms.uz';
  designationSnapshot = await db.select().from(agentDesignations).where(eq(agentDesignations.topic, 'supervisor'));
  ids.holder = await minted('egasi', 1);
  ids.boss = await minted('rahbar', 2);
  ids.deputy = await minted('orinbosar', 3);
  const r = await db.query.roles.findFirst({ where: eq(roles.code, 'super_admin') });
  superRoleId = r!.id;
  await db.insert(userRoles).values({ userId: ids.boss, roleId: superRoleId });
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `ES${SUFFIX}`, name: `Eslatma mijoz ${SUFFIX}`, phones: [`+99897${SUFFIX}31`], salesManagerId: ids.holder })
    .returning({ id: clients.id });
  ids.client = c!.id;
});

beforeEach(async () => {
  await db.delete(agentSignals).where(eq(agentSignals.topic, OFF_REMINDER_TOPIC));
  await db.delete(agentDesignations).where(eq(agentDesignations.topic, 'supervisor'));
  await db.insert(agentDesignations).values([
    { topic: 'supervisor', userId: ids.boss, rank: 1 },
    { topic: 'supervisor', userId: ids.deputy, rank: 2 },
  ]);
  await db.delete(notifications).where(inArray(notifications.userId, [ids.holder, ids.boss, ids.deputy]));
  await db.delete(agentRuns).where(eq(agentRuns.managerUserId, ids.holder));
  await db.delete(tgMessages).where(eq(tgMessages.managerUserId, ids.holder));
});

afterAll(async () => {
  process.env.AGENT_OFF_REMINDER = switchSnapshot;
  await db.delete(agentSignals).where(eq(agentSignals.topic, OFF_REMINDER_TOPIC));
  await dropDrainKicksSince(KICKS_FROM);
  await db.delete(agentDesignations).where(eq(agentDesignations.topic, 'supervisor'));
  if (designationSnapshot.length > 0) await db.insert(agentDesignations).values(designationSnapshot);
  const fixture = [ids.holder, ids.boss, ids.deputy].filter(Boolean);
  await db.delete(agentRuns).where(eq(agentRuns.managerUserId, ids.holder));
  await db.delete(tgMessages).where(eq(tgMessages.managerUserId, ids.holder));
  await db.delete(notifications).where(inArray(notifications.userId, fixture));
  await db.delete(userRoles).where(and(eq(userRoles.roleId, superRoleId), inArray(userRoles.userId, fixture)));
  await db.update(clients).set({ active: false }).where(inArray(clients.salesManagerId, fixture));
  await db.update(users).set({ active: false }).where(inArray(users.id, fixture));
});

describe('the agent the machine switched off, reminded until somebody switches it on', () => {
  it('the slot that began before the off says nothing; the next one says it once to each of the pair', async () => {
    expect(await sweepOffReminder(offConfig(), T(D1, '10:20'), OFF)).toBe('not_due');
    expect(await copies(ids.boss)).toEqual([]);

    expect(await sweepOffReminder(offConfig(), T(D1, '10:40'), OFF)).toBe('said');
    const boss = await copies(ids.boss);
    const deputy = await copies(ids.deputy);
    expect(boss).toHaveLength(1);
    expect(deputy).toHaveLength(1);
    expect(boss[0]).toMatch(
      /^⚠️ AI sotuvchi o‘chiq turibdi — sabab: Telegramning o‘z xizmat akkaunti \(777000\) bu akkauntga xabar yubordi — uni Telegram ilovasida o‘qing, 17\.11 10:00 dan beri\.\nJavobsiz mijozlar: 0\.\nQayta yoqish: «Suhbatlar → AI sotuvchi»\.\nhttps?:\/\/\S+\/suhbatlar\/ai$/u,
    );
    // The deputy reads the counts and is never sent to a door that bounces (J17).
    expect(deputy[0]).toBe(
      '⚠️ AI sotuvchi o‘chiq turibdi — sabab: Telegramning o‘z xizmat akkaunti (777000) bu akkauntga xabar yubordi — uni Telegram ilovasida o‘qing, 17.11 10:00 dan beri.\nJavobsiz mijozlar: 0.',
    );
  });

  it('the slot is claimed: the same slot again, and two sweeps at once, say nothing more', async () => {
    const both = await Promise.all([
      sweepOffReminder(offConfig(), T(D1, '10:40'), OFF),
      sweepOffReminder(offConfig(), T(D1, '10:40'), OFF),
    ]);
    expect([...both].sort()).toEqual(['already', 'said']);
    expect(await sweepOffReminder(offConfig(), T(D1, '10:41'), OFF)).toBe('already');
    expect(await sweepOffReminder(offConfig(), T(D1, '12:39'), OFF)).toBe('already');
    expect(await copies(ids.boss)).toHaveLength(1);
    const [claim] = await db.select().from(agentSignals).where(eq(agentSignals.topic, OFF_REMINDER_TOPIC));
    expect(claim!.dedupeKey).toBe('agent:forced_off:2026-11-17:1040');
    expect(claim!.peerId).toBe(0n);
  });

  it('every two hours of the office day, nothing at night, and 08:40 the next morning', async () => {
    const said: string[] = [];
    for (const [day, hm] of [
      [D1, '10:40'],
      [D1, '12:40'],
      [D1, '14:40'],
      [D1, '16:40'],
      [D1, '18:40'],
      [D1, '20:40'],
      [D1, '22:30'],
      [D2, '02:00'],
      [D2, '07:59'],
      [D2, '08:39'],
      [D2, '08:40'],
      [D2, '09:30'],
    ] as const) {
      if ((await sweepOffReminder(offConfig(), T(day, hm), OFF)) === 'said') said.push(`${day} ${hm}`);
    }
    expect(said).toEqual([
      '2026-11-17 10:40',
      '2026-11-17 12:40',
      '2026-11-17 14:40',
      '2026-11-17 16:40',
      '2026-11-17 18:40',
      '2026-11-17 20:40',
      '2026-11-18 08:40',
    ]);
    expect(await copies(ids.deputy)).toHaveLength(7);
  });

  it('nothing once it is switched on, and nothing when he switched it off himself', async () => {
    expect(await sweepOffReminder({ mode: 'shadow', ownerUserId: ids.holder }, T(D1, '10:40'), OFF)).toBe('not_due');
    expect(await sweepOffReminder(offConfig(), T(D1, '10:40'), null)).toBe('not_due');
    expect(await sweepOffReminder({ mode: 'off', ownerUserId: null }, T(D1, '10:40'), OFF)).toBe('not_due');
    expect(await copies(ids.boss)).toEqual([]);
    expect(await db.select().from(agentSignals).where(eq(agentSignals.topic, OFF_REMINDER_TOPIC))).toEqual([]);
  });

  it('«Javobsiz mijozlar» counts the chats whose newest line since the off is the customer’s', async () => {
    const waitingA = nextPeer();
    await line(waitingA, 'out', T(D1, '09:00'));
    await line(waitingA, 'in', T(D1, '10:05'));
    const waitingB = nextPeer();
    await line(waitingB, 'in', T(D1, '10:30'));
    await line(waitingB, 'in', T(D1, '10:31'));
    // Answered by a person after the off: the newest line is ours.
    const answered = nextPeer();
    await line(answered, 'in', T(D1, '10:10'));
    await line(answered, 'out', T(D1, '10:15'));
    // Before the off: its run (if any) was the AI's to answer; the reminder counts what the off left unanswered.
    const before = nextPeer();
    await line(before, 'in', T(D1, '09:50'));
    expect(await sweepOffReminder(offConfig(), T(D1, '10:40'), OFF)).toBe('said');
    expect((await copies(ids.boss))[0]).toContain('\nJavobsiz mijozlar: 2.\n');
    const [claim] = await db.select().from(agentSignals).where(eq(agentSignals.topic, OFF_REMINDER_TOPIC));
    expect(claim!.facts).toMatchObject({ reason: 'telegram_notice', waiting: 2, offAt: OFF.at.toISOString() });
  });

  it('each forced reason in its own words', async () => {
    expect(await sweepOffReminder(offConfig(), T(D1, '10:40'), { reason: 'blocks', at: OFF.at })).toBe('said');
    expect((await copies(ids.deputy))[0]).toMatch(/^⚠️ AI sotuvchi o‘chiq turibdi — sabab: 7 kun ichida AI javob yubormoqchi bo‘lgan ikki mijoz akkauntni bloklagan bo‘lib chiqdi, 17\.11 10:00 dan beri\./u);
  });
});

describe('agentForcedOff — the newest MODE row of the agent’s audit (rolled back: the audit takes no DELETE)', () => {
  class RolledBack extends Error {}
  const audit = (after: Record<string, unknown>, iso: string, actorId: string | null = null) =>
    sql`INSERT INTO audit_log (actor_id, entity_type, entity_id, action, before, after, created_at)
        VALUES (${actorId}::uuid, 'agent_config', ${AGENT_CONFIG_AUDIT_ID}::uuid, 'update',
                ${JSON.stringify({ mode: 'shadow' })}::jsonb, ${JSON.stringify(after)}::jsonb, ${iso}::timestamptz)`;
  async function readAfter(rows: ReturnType<typeof audit>[]): Promise<ForcedOff | null> {
    let seen: ForcedOff | null = null;
    await expect(
      db.transaction(async (tx) => {
        for (const row of rows) await tx.execute(row);
        seen = await agentForcedOff(tx);
        throw new RolledBack();
      }),
    ).rejects.toBeInstanceOf(RolledBack);
    return seen;
  }

  it('the machine’s off with its reason, written with no actor', async () => {
    expect(await readAfter([audit({ mode: 'off', reason: 'telegram_notice', expired: 2, cancelled: 1 }, '2999-01-01T05:00:00Z')])).toEqual({
      reason: 'telegram_notice',
      at: new Date('2999-01-01T05:00:00Z'),
    });
  });

  it('a row that wrote no mode (the owner, the seat, a setting) leaves the off standing', async () => {
    expect(
      await readAfter([
        audit({ mode: 'off', reason: 'flood_repeat' }, '2999-01-01T05:00:00Z'),
        audit({ ownerUserId: null }, '2999-01-01T06:00:00Z', ids.boss),
      ]),
    ).toEqual({ reason: 'flood_repeat', at: new Date('2999-01-01T05:00:00Z') });
  });

  it('a person’s «off» after it, a switch on, an off with an actor or with no reason of the list: not the machine’s', async () => {
    const forced = audit({ mode: 'off', reason: 'blocks' }, '2999-01-01T05:00:00Z');
    expect(await readAfter([forced, audit({ mode: 'off', expired: 0, cancelled: 0 }, '2999-01-01T06:00:00Z', ids.boss)])).toBeNull();
    expect(await readAfter([forced, audit({ mode: 'shadow', expired: 0, cancelled: 0 }, '2999-01-01T06:00:00Z', ids.holder)])).toBeNull();
    expect(await readAfter([audit({ mode: 'off', reason: 'blocks' }, '2999-01-01T05:00:00Z', ids.boss)])).toBeNull();
    expect(await readAfter([audit({ mode: 'off', reason: 'tired' }, '2999-01-01T05:00:00Z')])).toBeNull();
  });
});

describe('the wiring', () => {
  it('the sweep asks it only while the agent does not run, with the off read fresh, in its own catch', () => {
    const src = readFileSync('src/modules/wms/agent/jobs.ts', 'utf8');
    const offBranch = src.slice(src.indexOf('} else if (!agentRunning(config)) {'), src.indexOf('// 5. Strangers on the agent owner'));
    expect(offBranch.length, 're-anchor: the not-running branch').toBeGreaterThan(200);
    expect(offBranch).toMatch(
      /try \{\s*const \{ agentForcedOff, sweepOffReminder \} = await import\('\.\/off-reminder'\);\s*if \(config\?\.mode === 'off'\) await sweepOffReminder\(config, now, await agentForcedOff\(\)\);\s*\} catch \(err\) \{/u,
    );
  });

  it('the suites run it OFF — the switch is in both configs', () => {
    expect(readFileSync('vitest.config.ts', 'utf8')).toMatch(/env: \{[^}]*AGENT_OFF_REMINDER: 'off'/u);
    expect(readFileSync('playwright.config.ts', 'utf8')).toMatch(/AGENT_OFF_REMINDER: 'off'/u);
  });
});
