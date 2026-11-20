import 'dotenv/config';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/modules/platform/db/client';
import {
  agentAutoChats,
  agentAutoVerdicts,
  agentConfig,
  agentDesignations,
  agentDrafts,
  agentOutbox,
  agentSamples,
  clients,
  notifications,
  roles,
  tgMessages,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { __forgetAgentToliq1aReady, __pretendAgentToliq1aBehind, __restoreAgentConfig, readAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { drawSample, markSample, sampleView, sendSample } from '@/modules/wms/agent/sample';
import { dropDrainKicksSince } from './drain-kicks';

/**
 * «Kunlik tekshiruv» against a real database (stage 1a §4.5, his 9 a; §7's sample row): the draw — only replies the
 * machine pressed AND the customer got, money first, then the lowest confidence, at most ten, once per day — the
 * line to the people who may mark (J17: the arming rule; none of them → rank 1), the marks (👍 here, 👎 here AND the
 * card's own 👎 — the chat leaves the layer for 30 days), the page's view by the page's own sight, and a server one
 * migration behind.
 *
 * Clocks are LITERALS (#1790): Tuesday 2026-11-17, the job at 20:10 Tashkent (15:10 UTC). agent_config and
 * agent_designations are CONFIGURATION (#183) — put back in afterAll; fixture users are deactivated, never deleted.
 */

const SUFFIX = String(Date.now()).slice(-6);
const KICKS_FROM = new Date().toISOString();
const DAY = '2026-11-17';
const AT = new Date('2026-11-17T15:10:00Z');
const PRESSED_AT = new Date('2026-11-17T08:00:00Z');
const PEER = BigInt(`57${SUFFIX}00`);
let anchorSeq = 9_000n;
let randomSeq = BigInt(`57${SUFFIX}000`);

const ids = { holder: '', boss: '', plain: '', client: '' };
let superRoleId = '';
let configSnapshot: AgentConfig | null = null;
let designationSnapshot: (typeof agentDesignations.$inferSelect)[] = [];

async function minted(label: string, n: number): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99897${SUFFIX}${String(n).padStart(2, '0')}`, fullName: `Tekshir ${label} ${SUFFIX}`, passwordHash: 'x' })
    .returning({ id: users.id });
  return u!.id;
}

/**
 * One reply as the machine left it: its anchor (the customer's line), the draft, the verdict and the outbox row.
 * `money` puts a money line in the stored ledger; `state`/`outbox` say how it ended.
 */
async function reply(opts: { money?: boolean; confidence?: string | null; state?: 'pressed' | 'stopped'; outbox?: 'sent' | 'cancelled'; at?: Date; body?: string }): Promise<string> {
  anchorSeq += 1n;
  randomSeq += 1n;
  await db.insert(tgMessages).values({
    clientId: ids.client,
    managerUserId: ids.holder,
    peerId: PEER,
    tgMessageId: anchorSeq,
    direction: 'in',
    body: `savol ${anchorSeq}`,
    sentAt: new Date((opts.at ?? PRESSED_AT).getTime() - 60_000),
  });
  const [d] = await db
    .insert(agentDrafts)
    .values({
      managerUserId: ids.holder,
      peerId: PEER,
      clientId: ids.client,
      anchorTgMessageId: anchorSeq,
      proposedBody: opts.body ?? `javob ${anchorSeq}`,
      status: 'approved',
      confidence: opts.confidence === undefined ? '0.90' : opts.confidence,
      policy: { ledger: opts.money ? [{ raw: '800 $', kind: 'money', source: 'tool' }] : [] },
    })
    .returning({ id: agentDrafts.id });
  const at = opts.at ?? PRESSED_AT;
  const state = opts.state ?? 'pressed';
  await db.insert(agentAutoVerdicts).values({
    draftId: d!.id,
    managerUserId: ids.holder,
    peerId: PEER,
    eligible: true,
    state,
    dueAt: at,
    pressedAt: state === 'pressed' ? at : null,
    stoppedAt: state === 'stopped' ? at : null,
    outcome: state === 'stopped' ? 'pause' : null,
  });
  const sent = (opts.outbox ?? 'sent') === 'sent';
  await db.insert(agentOutbox).values({
    draftId: d!.id,
    managerUserId: ids.holder,
    peerId: PEER,
    clientId: ids.client,
    body: opts.body ?? `javob ${anchorSeq}`,
    randomId: randomSeq,
    answersTgMessageId: anchorSeq,
    status: sent ? 'sent' : 'cancelled',
    sentAt: sent ? at : null,
    queuedBy: ids.holder,
  });
  return d!.id;
}

const sampled = () => db.select().from(agentSamples).where(eq(agentSamples.managerUserId, ids.holder)).orderBy(asc(agentSamples.day), asc(agentSamples.pos));

const lines = (userId: string) =>
  db
    .select({ payload: notifications.payload })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, 'AgentSample')))
    .then((rows) => rows.map((r) => (r.payload as { text: string }).text));

async function clean(): Promise<void> {
  const drafts = await db.select({ id: agentDrafts.id }).from(agentDrafts).where(eq(agentDrafts.managerUserId, ids.holder));
  const draftIds = drafts.map((d) => d.id);
  if (draftIds.length > 0) {
    await db.delete(agentSamples).where(inArray(agentSamples.draftId, draftIds));
    await db.delete(agentOutbox).where(inArray(agentOutbox.draftId, draftIds));
    await db.delete(agentAutoVerdicts).where(inArray(agentAutoVerdicts.draftId, draftIds));
    await db.delete(agentDrafts).where(inArray(agentDrafts.id, draftIds));
  }
  await db.delete(agentAutoChats).where(eq(agentAutoChats.managerUserId, ids.holder));
  await db.delete(tgMessages).where(eq(tgMessages.managerUserId, ids.holder));
  await db.delete(notifications).where(inArray(notifications.userId, [ids.holder, ids.boss, ids.plain]));
}

beforeAll(async () => {
  __forgetAgentToliq1aReady();
  configSnapshot = await readAgentConfig();
  designationSnapshot = await db.select().from(agentDesignations).where(inArray(agentDesignations.topic, ['supervisor', 'big_cargo']));
  ids.holder = await minted('egasi', 1);
  ids.boss = await minted('rahbar', 2);
  ids.plain = await minted('oddiy', 3);
  const r = await db.query.roles.findFirst({ where: eq(roles.code, 'super_admin') });
  superRoleId = r!.id;
  await db.insert(userRoles).values({ userId: ids.boss, roleId: superRoleId });
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `TK${SUFFIX}`, name: `Tekshiruv mijoz ${SUFFIX}`, phones: [`+99895${SUFFIX}51`], salesManagerId: ids.holder })
    .returning({ id: clients.id });
  ids.client = c!.id;
  await db.update(agentConfig).set({ ownerUserId: ids.holder }).where(eq(agentConfig.id, 1));
});

beforeEach(async () => {
  __forgetAgentToliq1aReady();
  await clean();
  await db.delete(agentDesignations).where(inArray(agentDesignations.topic, ['supervisor', 'big_cargo']));
  await db.insert(agentDesignations).values([
    { topic: 'supervisor', userId: ids.holder, rank: 1 },
    { topic: 'supervisor', userId: ids.plain, rank: 2 },
  ]);
});

afterAll(async () => {
  __forgetAgentToliq1aReady();
  await clean();
  await dropDrainKicksSince(KICKS_FROM);
  await db.delete(agentDesignations).where(inArray(agentDesignations.topic, ['supervisor', 'big_cargo']));
  if (designationSnapshot.length > 0) await db.insert(agentDesignations).values(designationSnapshot);
  await __restoreAgentConfig(configSnapshot);
  const fixture = [ids.holder, ids.boss, ids.plain].filter(Boolean);
  await db.delete(userRoles).where(and(eq(userRoles.roleId, superRoleId), inArray(userRoles.userId, fixture)));
  await db.update(users).set({ active: false }).where(inArray(users.id, fixture));
});

describe('the draw — what the customer got from the machine, at most ten, once a day', () => {
  it('money first, then the lowest confidence (an unknown one first); never a reply that did not reach him or a person’s', async () => {
    const plain = [] as string[];
    for (let i = 0; i < 8; i += 1) plain.push(await reply({ confidence: (0.9 - i * 0.01).toFixed(2) }));
    const unknown = await reply({ confidence: null });
    const moneyA = await reply({ money: true, confidence: '0.95' });
    const moneyB = await reply({ money: true, confidence: '0.60' });
    const cancelled = await reply({ outbox: 'cancelled' });
    const stopped = await reply({ state: 'stopped' });
    const yesterday = await reply({ at: new Date('2026-11-16T08:00:00Z') });

    expect(await drawSample(DAY, 'daily')).toBe(10);
    const rows = await sampled();
    expect(rows.map((r) => r.pos)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rows.map((r) => r.draftId).slice(0, 3)).toEqual([moneyB, moneyA, unknown]);
    // The rest by confidence, lowest first: 0.83, 0.84, … — the two most confident of the eight are left out.
    expect(rows.slice(3).map((r) => r.draftId)).toEqual([plain[7], plain[6], plain[5], plain[4], plain[3], plain[2], plain[1]]);
    for (const out of [cancelled, stopped, yesterday, plain[0]]) expect(rows.map((r) => r.draftId)).not.toContain(out);
    expect(rows.every((r) => r.day === DAY && r.mark === null)).toBe(true);

    // A second run of the job the same day draws nothing — never a second ten.
    expect(await drawSample(DAY, 'daily')).toBe(0);
    expect(await sampled()).toHaveLength(10);
  });

  it('a weekly sample reaches back six days and never draws a reply sampled before', async () => {
    const monday = await reply({ at: new Date('2026-11-16T08:00:00Z') });
    const old = await reply({ at: new Date('2026-11-09T08:00:00Z') });
    expect(await drawSample('2026-11-16', 'daily')).toBe(1);
    const tuesday = await reply({});
    expect(await drawSample('2026-11-20', 'weekly')).toBe(1);
    const rows = await sampled();
    expect(rows.map((r) => [r.day, r.draftId])).toEqual([
      ['2026-11-16', monday],
      ['2026-11-20', tuesday],
    ]);
    expect(rows.map((r) => r.draftId)).not.toContain(old);
  });
});

describe('the line — to whom the arming rule lets mark (J17)', () => {
  it('the job draws and tells the pair’s holder alone (the deputy cannot mark), with the tab’s link', async () => {
    await reply({});
    process.env.APP_URL = process.env.APP_URL ?? 'https://gsrwms.uz';
    expect(await sendSample(AT)).toBe(1);
    const holderSaw = await lines(ids.holder);
    expect(holderSaw).toHaveLength(1);
    expect(holderSaw[0]).toMatch(/^🔎 Bugungi tekshiruv: 1 ta javob — 1 daqiqa\./u);
    expect(holderSaw[0]!.split('\n').at(-1)).toMatch(/\/suhbatlar\/ai\?bolim=tekshiruv$/u);
    expect(await lines(ids.plain)).toEqual([]);
  });

  it('nobody of the pair may mark: rank 1 is told all the same — the line is never lost', async () => {
    await db.delete(agentDesignations).where(eq(agentDesignations.topic, 'supervisor'));
    await db.insert(agentDesignations).values([
      { topic: 'supervisor', userId: ids.plain, rank: 1 },
      { topic: 'supervisor', userId: ids.boss, rank: 2 },
    ]);
    await reply({});
    expect(await sendSample(AT)).toBe(1);
    expect(await lines(ids.plain)).toHaveLength(1);
    // The deputy who cannot open the page reads no link.
    expect((await lines(ids.plain))[0]).not.toMatch(/https?:/u);
    expect(await lines(ids.boss)).toEqual([]);
  });
});

describe('the marks', () => {
  it('👍 by the holder is written once; a person the arming rule refuses writes nothing', async () => {
    const id = await reply({});
    await drawSample(DAY, 'daily');
    expect(await markSample({ id: ids.plain, roles: [] }, { day: DAY, draftId: id, mark: 'good' }, AT)).toEqual({ ok: false, code: 'forbidden' });
    expect(await markSample({ id: ids.holder, roles: [] }, { day: DAY, draftId: id, mark: 'good' }, AT)).toEqual({ ok: true, disarmed: false });
    expect(await markSample({ id: ids.holder, roles: [] }, { day: DAY, draftId: id, mark: 'bad' }, AT)).toEqual({ ok: false, code: 'already' });
    const [row] = await sampled();
    expect(row).toMatchObject({ mark: 'good', markedBy: ids.holder });
    expect(await markSample({ id: ids.holder, roles: [] }, { day: DAY, draftId: '00000000-0000-4000-8000-000000000000', mark: 'good' }, AT)).toEqual({
      ok: false,
      code: 'not_found',
    });
  });

  it('👎 is the card’s own 👎 too: the verdict carries it and the chat leaves the layer for 30 days', async () => {
    const id = await reply({});
    await drawSample(DAY, 'daily');
    expect(await markSample({ id: ids.holder, roles: [] }, { day: DAY, draftId: id, mark: 'bad' }, AT)).toEqual({ ok: true, disarmed: false });
    const [verdict] = await db.select({ feedback: agentAutoVerdicts.feedback }).from(agentAutoVerdicts).where(eq(agentAutoVerdicts.draftId, id));
    expect(verdict!.feedback).toBe('bad');
    const [off] = await db.select().from(agentAutoChats).where(and(eq(agentAutoChats.managerUserId, ids.holder), eq(agentAutoChats.peerId, PEER)));
    expect(off).toMatchObject({ reason: 'feedback' });
    const [row] = await sampled();
    expect(row!.mark).toBe('bad');
  });
});

describe('the page’s view', () => {
  it('the newest day’s rows with the customer’s line, the reply and who may mark — by the page’s own sight', async () => {
    const id = await reply({ body: 'Toshkentgacha taxminan 800 $' });
    await drawSample(DAY, 'daily');
    const view = await sampleView({ id: ids.holder, roles: [] });
    expect(view).toMatchObject({ ready: true, day: DAY, olderUnmarked: 0 });
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ draftId: id, reply: 'Toshkentgacha taxminan 800 $', mayMark: true, mark: null });
    expect(view.rows[0]!.customer).toMatch(/^savol /u);
    // Another account's reader with no supervision sight sees none of this holder's chats.
    expect((await sampleView({ id: ids.plain, roles: [] })).rows).toEqual([]);
  });
});

describe('one migration behind 0151', () => {
  it('no draw, no line, no mark, an empty view — nothing throws', async () => {
    const id = await reply({});
    __pretendAgentToliq1aBehind();
    try {
      expect(await drawSample(DAY, 'daily')).toBe(0);
      expect(await sendSample(AT)).toBe(0);
      expect(await markSample({ id: ids.holder, roles: [] }, { day: DAY, draftId: id, mark: 'good' }, AT)).toEqual({ ok: false, code: 'not_ready' });
      expect((await sampleView({ id: ids.holder, roles: [] })).ready).toBe(false);
    } finally {
      __forgetAgentToliq1aReady();
    }
    expect(await sampled()).toEqual([]);
    expect(await lines(ids.holder)).toEqual([]);
  });
});
