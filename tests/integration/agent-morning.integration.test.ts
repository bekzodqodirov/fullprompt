import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/modules/platform/db/client';
import {
  agentAutoVerdicts,
  agentConfig,
  agentDesignations,
  agentDrafts,
  agentOutbox,
  agentRuns,
  agentSamples,
  clients,
  notifications,
  roles,
  tgMessages,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { __forgetAgentToliq1aReady, __restoreAgentConfig, readAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { morningFacts, sendMorningLine } from '@/modules/wms/agent/morning';
import { dropDrainKicksSince } from './drain-kicks';

/**
 * The morning line against a real database (stage 1a §4.5; §7's morning row): yesterday's replies of the agent's
 * account by their ONE reason, the lines it wrote nothing to, the caps by name, the customers waiting with nothing
 * coming («Javobsiz», night lines included), the samples left unmarked past 48 h — and who receives it (the pair;
 * the page's link only for whom the page admits, J17), never at night.
 *
 * Clocks are LITERALS (#1790): yesterday = Monday 2026-11-16 (Tashkent), the line at 08:40 on the 17th (03:40 UTC).
 * agent_config and agent_designations are CONFIGURATION (#183) — put back in afterAll; fixture users deactivated.
 */

const SUFFIX = String(Date.now()).slice(-6);
const KICKS_FROM = new Date().toISOString();
const DAY = '2026-11-16';
const MORNING = new Date('2026-11-17T03:40:00Z');
const NOON = new Date('2026-11-16T07:00:00Z');
let peerSeq = BigInt(`58${SUFFIX}00`);
let msgSeq = 11_000n;
let randomSeq = BigInt(`58${SUFFIX}000`);
/** What a customer wrote and what the AI answered — words the line must never carry to a colleague. */
const CUSTOMER_WORDS = `mijoz-matni-${SUFFIX}`;
const REPLY_WORDS = `ai-matni-${SUFFIX}`;

const ids = { holder: '', boss: '', deputy: '', client: '' };
let superRoleId = '';
let configSnapshot: AgentConfig | null = null;
let designationSnapshot: (typeof agentDesignations.$inferSelect)[] = [];

async function minted(label: string, n: number): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99898${SUFFIX}${String(n).padStart(2, '0')}`, fullName: `Tong ${label} ${SUFFIX}`, passwordHash: 'x' })
    .returning({ id: users.id });
  return u!.id;
}

async function line(peer: bigint, at: Date): Promise<bigint> {
  msgSeq += 1n;
  await db.insert(tgMessages).values({ clientId: ids.client, managerUserId: ids.holder, peerId: peer, tgMessageId: msgSeq, direction: 'in', body: CUSTOMER_WORDS, sentAt: at });
  return msgSeq;
}

/** A reply draft of the day — its run, as a real one has — with how the auto layer judged it. */
async function draft(verdict: Partial<typeof agentAutoVerdicts.$inferInsert> | null, outbox: 'sent' | null = null, at: Date = NOON): Promise<void> {
  peerSeq += 1n;
  const anchor = await line(peerSeq, new Date(at.getTime() - 60_000));
  await db.insert(agentRuns).values({ managerUserId: ids.holder, peerId: peerSeq, trigger: 'inbound', anchorTgMessageId: anchor, outcome: 'draft', createdAt: at });
  const [d] = await db
    .insert(agentDrafts)
    .values({ managerUserId: ids.holder, peerId: peerSeq, clientId: ids.client, anchorTgMessageId: anchor, proposedBody: REPLY_WORDS, status: 'pending', createdAt: at })
    .returning({ id: agentDrafts.id });
  if (verdict) {
    await db.insert(agentAutoVerdicts).values({ draftId: d!.id, managerUserId: ids.holder, peerId: peerSeq, eligible: false, ...verdict });
  }
  if (outbox) {
    randomSeq += 1n;
    await db.insert(agentOutbox).values({
      draftId: d!.id,
      managerUserId: ids.holder,
      peerId: peerSeq,
      clientId: ids.client,
      body: REPLY_WORDS,
      randomId: randomSeq,
      answersTgMessageId: anchor,
      status: 'sent',
      sentAt: at,
      queuedBy: ids.holder,
    });
  }
}

async function noDraftRun(outcome: 'refused' | 'capped', error: string, at: Date = NOON): Promise<void> {
  peerSeq += 1n;
  const anchor = await line(peerSeq, new Date(at.getTime() - 60_000));
  await db.insert(agentRuns).values({ managerUserId: ids.holder, peerId: peerSeq, trigger: 'inbound', anchorTgMessageId: anchor, outcome, error, createdAt: at });
  // A second attempt on the same anchor is the same customer's line, counted once.
  await db.insert(agentRuns).values({ managerUserId: ids.holder, peerId: peerSeq, trigger: 'inbound', anchorTgMessageId: anchor, attempt: 1, outcome, error, createdAt: at });
}

const morningOf = (userId: string) =>
  db
    .select({ payload: notifications.payload })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, 'AgentMorning')))
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
  await db.delete(agentRuns).where(eq(agentRuns.managerUserId, ids.holder));
  await db.delete(tgMessages).where(eq(tgMessages.managerUserId, ids.holder));
  await db.delete(notifications).where(inArray(notifications.userId, [ids.holder, ids.boss, ids.deputy]));
}

beforeAll(async () => {
  __forgetAgentToliq1aReady();
  process.env.APP_URL = process.env.APP_URL ?? 'https://gsrwms.uz';
  configSnapshot = await readAgentConfig();
  designationSnapshot = await db.select().from(agentDesignations).where(inArray(agentDesignations.topic, ['supervisor', 'big_cargo']));
  ids.holder = await minted('egasi', 1);
  ids.boss = await minted('rahbar', 2);
  ids.deputy = await minted('orinbosar', 3);
  const r = await db.query.roles.findFirst({ where: eq(roles.code, 'super_admin') });
  superRoleId = r!.id;
  await db.insert(userRoles).values({ userId: ids.boss, roleId: superRoleId });
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `TO${SUFFIX}`, name: `Tong mijoz ${SUFFIX}`, phones: [`+99895${SUFFIX}61`], salesManagerId: ids.holder })
    .returning({ id: clients.id });
  ids.client = c!.id;
  await db.update(agentConfig).set({ ownerUserId: ids.holder }).where(eq(agentConfig.id, 1));
});

beforeEach(async () => {
  __forgetAgentToliq1aReady();
  await clean();
  await db.delete(agentDesignations).where(inArray(agentDesignations.topic, ['supervisor', 'big_cargo']));
  await db.insert(agentDesignations).values([
    { topic: 'supervisor', userId: ids.boss, rank: 1 },
    { topic: 'supervisor', userId: ids.deputy, rank: 2 },
  ]);
});

afterAll(async () => {
  __forgetAgentToliq1aReady();
  await clean();
  await dropDrainKicksSince(KICKS_FROM);
  await db.delete(agentDesignations).where(inArray(agentDesignations.topic, ['supervisor', 'big_cargo']));
  if (designationSnapshot.length > 0) await db.insert(agentDesignations).values(designationSnapshot);
  await __restoreAgentConfig(configSnapshot);
  const fixture = [ids.holder, ids.boss, ids.deputy].filter(Boolean);
  await db.delete(userRoles).where(and(eq(userRoles.roleId, superRoleId), inArray(userRoles.userId, fixture)));
  await db.update(users).set({ active: false }).where(inArray(users.id, fixture));
});

async function theDay(): Promise<void> {
  // Two went by themselves; one pressed and cancelled; three held, each under its FIRST reason; one with no verdict.
  await draft({ eligible: true, state: 'pressed', dueAt: NOON, pressedAt: NOON }, 'sent');
  await draft({ eligible: true, state: 'pressed', dueAt: NOON, pressedAt: NOON }, 'sent');
  await draft({ eligible: true, state: 'stopped', dueAt: NOON, outcome: 'pause' });
  await draft({ reasons: ['night', 'media'] });
  await draft({ reasons: ['too_long', 'media'] });
  await draft({ reasons: ['needs_owner', 'night'] });
  await draft(null);
  // Another day's draft is not yesterday's.
  await draft({ eligible: true, state: 'pressed', dueAt: NOON, pressedAt: NOON }, 'sent', new Date('2026-11-15T07:00:00Z'));
  // Lines it wrote nothing to, and a cap — each customer's line once.
  await noDraftRun('refused', 'human_active');
  await noDraftRun('refused', 'human_active');
  await noDraftRun('refused', 'media_only');
  await noDraftRun('capped', 'chat_runs');
  await noDraftRun('capped', 'daily_token_cap');
}

describe('morningFacts — yesterday, as the database says it', () => {
  it('the replies by their one reason, the no-draft lines, the caps, the waiting customers', async () => {
    await theDay();
    // A customer who wrote at 23:30 Tashkent and got nothing: «Javobsiz» counts the night too.
    peerSeq += 1n;
    await line(peerSeq, new Date('2026-11-16T18:30:00Z'));
    const f = await morningFacts(DAY, ids.holder, MORNING);
    expect(f.drafts).toBe(7);
    expect(f.went).toBe(2);
    expect(f.waited).toEqual([
      { code: 'media', n: 2 },
      { code: 'needs_owner', n: 1 },
      { code: 'no_verdict', n: 1 },
      { code: 'stopped_pause', n: 1 },
    ]);
    expect(f.went + f.waited.reduce((s, g) => s + g.n, 0)).toBe(f.drafts);
    expect(f.notDrafted).toEqual([
      { code: 'human_active', n: 2 },
      { code: 'media_only', n: 1 },
    ]);
    expect(f.caps).toEqual([
      { code: 'chat_runs', n: 1 },
      { code: 'daily_token_cap', n: 1 },
    ]);
    // The night line, and the capped lines (nothing answered them and nothing will) — never the refusals by design.
    expect(f.unanswered).toBe(3);
  });

  it('samples left unmarked past 48 hours are counted; a fresher one is not', async () => {
    await draft({ eligible: true, state: 'pressed', dueAt: NOON, pressedAt: NOON }, 'sent');
    const [d1] = await db.select({ id: agentDrafts.id, peerId: agentDrafts.peerId }).from(agentDrafts).where(eq(agentDrafts.managerUserId, ids.holder));
    await db.insert(agentSamples).values([
      { day: '2026-11-14', draftId: d1!.id, managerUserId: ids.holder, peerId: d1!.peerId, pos: 1 },
      { day: '2026-11-15', draftId: d1!.id, managerUserId: ids.holder, peerId: d1!.peerId, pos: 1 },
    ]);
    expect((await morningFacts(DAY, ids.holder, MORNING)).unmarkedSamples).toBe(1);
  });
});

describe('sendMorningLine — the pair, at 08:40, never at night', () => {
  it('each rank of the pair gets one line; the page’s link only for whom the page admits (J17)', async () => {
    await theDay();
    expect(await sendMorningLine(MORNING)).toBe(2);
    const [boss] = await morningOf(ids.boss);
    const [deputy] = await morningOf(ids.deputy);
    expect(boss!.split('\n')[0]).toBe(
      '🌅 AI sotuvchi, kecha (16.11): 7 javobdan 2 tasi o‘zi ketdi. 5 tasi tasdiq kutdi: 2 — rasm, ovoz yoki fayl, 1 — AI savol berdi, 1 — o‘zi yuborish ko‘rmagan, 1 — ⏸ bilan to‘xtatildi.',
    );
    expect(boss).toContain('⛔ Chegara tugadi: bitta mijoz uchun kunlik chegara — 1 ta xabar, bugungi tokenlar chegarasi (xato halqasidan himoya, pul chegarasi emas) — 1 ta xabar.');
    expect(boss!.split('\n').at(-1)).toMatch(/\/suhbatlar\/ai$/u);
    expect(deputy).not.toMatch(/https?:/u);
    expect(deputy!.split('\n')[0]).toBe(boss!.split('\n')[0]);
    // Counts only — the customers' lines never reach a colleague.
    for (const text of [boss!, deputy!]) {
      expect(text).not.toContain(CUSTOMER_WORDS);
      expect(text).not.toContain(REPLY_WORDS);
    }
    expect(await morningOf(ids.holder)).toEqual([]);
  });

  it('at night it sends nothing; an empty day sends nothing', async () => {
    await theDay();
    expect(await sendMorningLine(new Date('2026-11-17T18:00:00Z'))).toBe(0);
    await clean();
    expect(await sendMorningLine(MORNING)).toBe(0);
    expect(await morningOf(ids.boss)).toEqual([]);
  });
});
