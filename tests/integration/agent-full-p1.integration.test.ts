import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/modules/platform/db/client';
import {
  agentAutoConfig,
  agentDrafts,
  agentLessons,
  agentSendCaps,
  auditLog,
  roles,
  telegramChatWaits,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { readAutoConfig, setAutoPerDay, __restoreAutoConfig, AutoConfigError, type AutoConfig } from '@/modules/wms/agent/auto-send';
import {
  __forgetAgentFullP1Ready,
  __pretendAgentFullP1Behind,
  __restoreAgentConfig,
  agentFullP1Ready,
  readAgentConfig,
  type AgentConfig,
} from '@/modules/wms/agent/config';
import {
  DEFAULT_SEND_CAPS,
  SEND_CAPS_AUDIT_ID,
  SendCapsError,
  __restoreSendCaps,
  readSendCaps,
  setSendCaps,
  type SendCaps,
} from '@/modules/wms/agent/send-caps';
import { sendsToday } from '@/modules/wms/agent/today';
import { agentToday } from '@/modules/wms/agent/web-page';

/**
 * Migration 0146 (spec SPEC-P1-v2 §5, §1.5, §3.2, §6) against a real database: the CHECKs it widens, the two
 * tables it adds, the stored state it leaves, the probe every 0146 reader and writer asks, and the caps' own door.
 *
 * agent_config, agent_auto_config and agent_send_caps are singleton CONFIGURATION rows on the one database every
 * file shares (#183): snapshotted in beforeAll and put back in afterAll. Fixture users are deactivated, never
 * deleted (the audit FK).
 */

const SUFFIX = String(Date.now()).slice(-6);
let ownerId = '';
let adminId = '';
let sellerId = '';
let agentSnapshot: AgentConfig | null = null;
let autoSnapshot: AutoConfig | null = null;
let capsSnapshot: SendCaps = DEFAULT_SEND_CAPS;
const madeLessons: string[] = [];
const madeDrafts: string[] = [];

async function makeUser(name: string, role: string, tail: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99891${SUFFIX}${tail}`, fullName: name, passwordHash: 'x' })
    .returning({ id: users.id });
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  return u!.id;
}

const refusedCode = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof SendCapsError || e instanceof AutoConfigError ? e.code : (e as { code?: string })?.code ?? String(e)),
  );

/** A statement postgres refuses, by its SQLSTATE (23514 = a CHECK, 23502 = NOT NULL). */
const pgCode = async (statement: Promise<unknown>) =>
  statement.then(
    () => 'ok',
    (e: unknown) => {
      const err = e as { code?: string; cause?: { code?: string } };
      return err.code ?? err.cause?.code ?? String(e);
    },
  );

beforeAll(async () => {
  __forgetAgentFullP1Ready();
  agentSnapshot = await readAgentConfig();
  autoSnapshot = await readAutoConfig();
  capsSnapshot = await readSendCaps();
  ownerId = await makeUser(`P1 egasi ${SUFFIX}`, 'sales_manager', '01');
  adminId = await makeUser(`P1 admin ${SUFFIX}`, 'super_admin', '02');
  sellerId = await makeUser(`P1 sotuvchi ${SUFFIX}`, 'sales_manager', '03');
  await db.update(agentAutoConfig).set({ perDay: 30 }).where(eq(agentAutoConfig.id, 1));
  // The holder: the configured account the agent speaks from (the caps' door asks `mayRunAgent`).
  await db.execute(sql`UPDATE agent_config SET owner_user_id = ${ownerId}::uuid WHERE id = 1`);
});

beforeEach(() => {
  __forgetAgentFullP1Ready();
});

afterAll(async () => {
  __forgetAgentFullP1Ready();
  if (madeLessons.length) await db.delete(agentLessons).where(inArray(agentLessons.id, madeLessons));
  if (madeDrafts.length) await db.delete(agentDrafts).where(inArray(agentDrafts.id, madeDrafts));
  await db.delete(telegramChatWaits).where(inArray(telegramChatWaits.chatId, [BigInt(`55${SUFFIX}`)]));
  await __restoreAgentConfig(agentSnapshot);
  await __restoreAutoConfig(autoSnapshot);
  await __restoreSendCaps(capsSnapshot);
  await db.update(users).set({ active: false }).where(inArray(users.id, [ownerId, adminId, sellerId]));
});

describe('0146 — what the migration leaves', () => {
  it('the probe finds it, and the side table holds its one row with nothing typed', async () => {
    expect(await agentFullP1Ready()).toBe(true);
    const rows = await db.select().from(agentSendCaps);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(1);
  });

  it('it wrote ONE audit row for the daily count it took away — actor none, via 0146', async () => {
    const rows = await db
      .select({ actor: auditLog.actorId, before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'agent_auto_config'), sql`${auditLog.after}->>'via' = '0146'`));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ actor: null, after: { perDay: null, via: '0146' } });
  });

  it('the kinds CHECK admits «price» and nothing else new; the daily count admits NULL and a typed 1-1000', async () => {
    const set = (patch: Partial<typeof agentAutoConfig.$inferInsert>) => pgCode(db.update(agentAutoConfig).set(patch).where(eq(agentAutoConfig.id, 1)));
    expect(await set({ categories: ['faq', 'price'] })).toBe('ok');
    expect(await set({ categories: ['complaint'] })).toBe('23514');
    expect(await set({ categories: ['other'] })).toBe('23514');
    expect(await set({ categories: [] })).toBe('23514');
    expect(await set({ perDay: null })).toBe('ok');
    expect(await set({ perDay: 1000 })).toBe('ok');
    expect(await set({ perDay: 0 })).toBe('23514');
    expect(await set({ perDay: 1001 })).toBe('23514');
    await db.update(agentAutoConfig).set({ categories: ['greeting', 'qualification', 'faq', 'status'], perDay: 30 }).where(eq(agentAutoConfig.id, 1));
  });

  it('the caps’ CHECKs are the human queue’s bounds: a day 1-200, an hour 1-100, NULL = the default', async () => {
    const set = (patch: Partial<typeof agentSendCaps.$inferInsert>) => pgCode(db.update(agentSendCaps).set(patch).where(eq(agentSendCaps.id, 1)));
    expect(await set({ dayCap: 200, hourCap: 100 })).toBe('ok');
    expect(await set({ dayCap: 201 })).toBe('23514');
    expect(await set({ dayCap: 0 })).toBe('23514');
    expect(await set({ hourCap: 101 })).toBe('23514');
    expect(await set({ dayCap: null, hourCap: null })).toBe('ok');
    expect(await pgCode(db.insert(agentSendCaps).values({ id: 2 }))).toBe('23514');
  });

  it('the waits CHECK takes the two new one-text waits, and every kind it had', async () => {
    const chat = BigInt(`55${SUFFIX}`);
    const now = new Date();
    for (const kind of ['agent_answer', 'agent_lesson', 'agent_edit', 'burst', 'task']) {
      expect(
        await pgCode(
          db.insert(telegramChatWaits).values({ chatId: chat, kind, payload: {}, armedAt: now, expiresAt: new Date(now.getTime() + 60_000) }),
        ),
        kind,
      ).toBe('ok');
    }
    expect(
      await pgCode(db.insert(telegramChatWaits).values({ chatId: chat, kind: 'agent_nope', payload: {}, armedAt: now, expiresAt: new Date(now.getTime() + 60_000) })),
    ).toBe('23514');
    await db.delete(telegramChatWaits).where(eq(telegramChatWaits.chatId, chat));
  });

  it('a lesson: non-empty, at most 500 characters, its token only while unconfirmed — and it survives the draft it was given on', async () => {
    const lesson = (patch: Partial<typeof agentLessons.$inferInsert>) =>
      pgCode(
        db
          .insert(agentLessons)
          .values({ text: 'Salomlashganda «aka» demang.', createdBy: ownerId, ...patch })
          .returning({ id: agentLessons.id })
          .then((r) => madeLessons.push(r[0]!.id)),
      );
    expect(await lesson({})).toBe('ok');
    expect(await lesson({ text: '   ' })).toBe('23514');
    expect(await lesson({ text: 'x'.repeat(501) })).toBe('23514');
    expect(await lesson({ text: 'x'.repeat(500) })).toBe('ok');
    expect(await lesson({ confirmToken: 'a1b2c3d4' })).toBe('ok');
    expect(await lesson({ confirmToken: 'a1b2c3d4', confirmedAt: new Date() })).toBe('23514');
    expect(await lesson({ confirmedAt: new Date() })).toBe('ok');
    // Given on a draft; the chat's purge deletes the draft — the lesson stays, its pointer NULL (the 0146 comment).
    const [d] = await db
      .insert(agentDrafts)
      .values({ managerUserId: ownerId, peerId: BigInt(`56${SUFFIX}`), anchorTgMessageId: 1n, proposedBody: 'x' })
      .returning({ id: agentDrafts.id });
    madeDrafts.push(d!.id);
    const [l] = await db.insert(agentLessons).values({ text: 'Narxni so‘ramasdan aytmang.', createdBy: ownerId, draftId: d!.id }).returning({ id: agentLessons.id });
    madeLessons.push(l!.id);
    await db.delete(agentDrafts).where(eq(agentDrafts.id, d!.id));
    const [after] = await db.select({ draftId: agentLessons.draftId }).from(agentLessons).where(eq(agentLessons.id, l!.id));
    expect(after).toEqual({ draftId: null });
  });
});

describe('the caps’ door (spec §5.2) — the holder or a super_admin, bounded, audited', () => {
  const ctxOf = (id: string) => ({ actorId: id });
  const actor = (id: string, roles: string[]) => ({ id, roles });

  it('the holder types two numbers; every reader takes them; the audit says before and after', async () => {
    const caps = await setSendCaps(actor(ownerId, ['sales_manager']), { dayCap: 150, hourCap: 30 }, ctxOf(ownerId));
    expect(caps).toMatchObject({ dayCap: 150, hourCap: 30, stored: { dayCap: 150, hourCap: 30 }, ready: true });
    const [audit] = await db
      .select({ before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'agent_send_caps'), eq(auditLog.entityId, SEND_CAPS_AUDIT_ID), eq(auditLog.actorId, ownerId)))
      .orderBy(sql`${auditLog.id} DESC`)
      .limit(1);
    expect(audit).toMatchObject({ after: { dayCap: 150, hourCap: 30 } });
    // The ✅'s door counts the day against his number, past the ramp.
    expect((await sendsToday(ownerId, new Date(Date.now() - 30 * 86_400_000), new Date(), caps.dayCap)).ceiling).toBe(150);
    // A super_admin may change them too (a cap is a brake); empty boxes are today's defaults.
    const back = await setSendCaps(actor(adminId, ['super_admin']), { dayCap: null, hourCap: null }, ctxOf(adminId));
    expect(back).toMatchObject({ dayCap: 80, hourCap: 20, stored: { dayCap: null, hourCap: null } });
  });

  it('anybody else is refused, and so is a number outside the human queue’s bounds', async () => {
    expect(await refusedCode(setSendCaps(actor(sellerId, ['sales_manager']), { dayCap: 10, hourCap: null }, ctxOf(sellerId)))).toBe('forbidden');
    for (const bad of [0, 201, 1.5, Number.NaN, -1]) {
      expect(await refusedCode(setSendCaps(actor(ownerId, []), { dayCap: bad, hourCap: null }, ctxOf(ownerId))), `day ${bad}`).toBe('bad_value');
    }
    for (const bad of [0, 101]) {
      expect(await refusedCode(setSendCaps(actor(ownerId, []), { dayCap: null, hourCap: bad }, ctxOf(ownerId))), `hour ${bad}`).toBe('bad_value');
    }
    expect((await readSendCaps()).stored).toEqual({ dayCap: null, hourCap: null });
  });
});

describe('one migration behind 0146 — every reader runs, every writer says so in words', () => {
  it('the caps read as today’s constants; the agent’s config, the layer’s and the page’s day still read', async () => {
    await db.update(agentSendCaps).set({ dayCap: 150, hourCap: 30 }).where(eq(agentSendCaps.id, 1));
    __pretendAgentFullP1Behind();
    try {
      expect(await readSendCaps()).toEqual(DEFAULT_SEND_CAPS);
      expect(await readAgentConfig()).not.toBeNull();
      expect(await readAutoConfig()).not.toBeNull();
      const config = (await readAgentConfig())!;
      const today = await agentToday({ ...config, ownerUserId: ownerId, startedAt: new Date(Date.now() - 30 * 86_400_000) });
      expect(today.sendCeiling).toBe(80);
      expect(await refusedCode(setSendCaps({ id: ownerId, roles: [] }, { dayCap: 10, hourCap: 10 }, { actorId: ownerId }))).toBe('not_ready');
      expect(await refusedCode(setAutoPerDay({ id: ownerId, roles: [] }, null, { actorId: ownerId }))).toBe('not_ready');
    } finally {
      __forgetAgentFullP1Ready();
      await db.update(agentSendCaps).set({ dayCap: null, hourCap: null }).where(eq(agentSendCaps.id, 1));
    }
  });
});
