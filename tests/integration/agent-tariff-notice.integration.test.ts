import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { dropDrainKicksSince } from './drain-kicks';

/**
 * The website table's 14-day notice THROUGH THE SWEEP, on a day inside its window (spec SPEC-P1-v2 §1.6; the review
 * of 0148 as built, tests lens).
 *
 * Two things nothing proved:
 *  - the sweep's own step: `tariffExpiryNotice` was tested by calling it, never through `agentSweep` — the call
 *    could be deleted from jobs.ts with the suite green, and no notice would ever go;
 *  - the calendar: the notice is ONE claim per table on the one database every file shares, taken by any sweep on
 *    or after `validThrough − 14 days`. Seven agent files run `agentSweep` on the real clock, so from 2026-12-17
 *    each run would have left the claim spent on a deactivated fixture holder and a card queued to him —
 *    configuration left behind (#183), by the date. The suites run with the notice OFF (`AGENT_TARIFF_NOTICE`,
 *    vitest.config and the Playwright server's env); this file is where it is switched on.
 *
 * «The clock moved past the first notice day» without moving a clock: the table here runs out a week from TODAY, so
 * today stands inside its window exactly as every day from 2026-12-17 stands inside the real table's. Only the
 * table's date is stood in for; the sweep, the claim and the card are the real ones.
 *
 * agent_config and agent_send_caps are singleton CONFIGURATION rows (#183): snapshotted and put back. The fixture
 * user is deactivated, never deleted (audit FK).
 */
const table = vi.hoisted(() => {
  // Today in Tashkent, plus seven days.
  const d = new Date(Date.now() + 5 * 3_600_000 + 7 * 86_400_000);
  return { validThrough: d.toISOString().slice(0, 10) };
});
vi.mock('@/modules/wms/agent/site-estimate', async (original) => {
  const real = await original<typeof import('@/modules/wms/agent/site-estimate')>();
  return { ...real, SITE_TARIFF: { ...real.SITE_TARIFF, validThrough: table.validThrough } };
});

import { db } from '@/modules/platform/db/client';
import { agentConfig, agentSendCaps, notifications, roles, userRoles, users } from '@/modules/platform/db/schema';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { readAgentConfig, __forgetAgentFullP1Ready, __restoreAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { agentSweep } from '@/modules/wms/agent/jobs';
import { SITE_TARIFF } from '@/modules/wms/agent/site-estimate';
import { currentTariffFingerprint, tariffNoticeFrom, tariffNoticeOn } from '@/modules/wms/agent/tariff-watch';

const SUFFIX = String(Date.now()).slice(-6);
let holderId = '';
let snapshot: AgentConfig | null = null;
let noticeForBefore: string | null = null;
let hadCapsRow = false;

/** A daytime Tashkent instant at least twenty minutes before now (agent-auto's clock): the notice never goes at night. */
function machineClock(): Date {
  const now = new Date(Date.now() - 20 * 60_000);
  const hour = (now.getUTCHours() + 5) % 24;
  if (hour >= 9 && hour < 20) return now;
  const t = new Date(now);
  t.setUTCHours(9, 0, 0, 0); // 14:00 Tashkent
  if (t.getTime() > now.getTime()) t.setUTCDate(t.getUTCDate() - 1);
  return t;
}
const T0 = machineClock();

const cards = () =>
  db
    .select({ payload: notifications.payload })
    .from(notifications)
    .where(and(eq(notifications.type, 'AgentTariffNotice'), eq(notifications.userId, holderId)));

async function noticeFor(): Promise<string | null> {
  const [row] = await db.select({ noticeFor: agentSendCaps.tariffNoticeFor }).from(agentSendCaps).where(eq(agentSendCaps.id, 1));
  return row?.noticeFor ?? null;
}

beforeAll(async () => {
  __forgetAgentFullP1Ready();
  snapshot = await readAgentConfig();
  const [row] = await db.select({ noticeFor: agentSendCaps.tariffNoticeFor }).from(agentSendCaps).where(eq(agentSendCaps.id, 1));
  hadCapsRow = row !== undefined;
  noticeForBefore = row?.noticeFor ?? null;
  const [u] = await db
    .insert(users)
    .values({ phone: `+99891${SUFFIX}01`, fullName: `Tarif egasi ${SUFFIX}`, passwordHash: 'x' })
    .returning({ id: users.id });
  holderId = u!.id;
  const r = await db.query.roles.findFirst({ where: eq(roles.code, 'super_admin') });
  await db.insert(userRoles).values({ userId: holderId, roleId: r!.id });
  // The agent has a holder and stays OFF: the notice asks only who the holder is, and an agent that is off sends
  // nothing and drafts nothing while the sweep runs.
  await db.update(agentConfig).set({ mode: 'off', ownerUserId: holderId }).where(eq(agentConfig.id, 1));
});

beforeEach(async () => {
  await db.delete(notifications).where(and(eq(notifications.type, 'AgentTariffNotice'), eq(notifications.userId, holderId)));
  await db.update(agentSendCaps).set({ tariffNoticeFor: null }).where(eq(agentSendCaps.id, 1));
});

// The drain's kicks this file's notifications queued, from its own start (fix pass 5 — `drain-kicks.ts`).
const KICKS_FROM = new Date().toISOString();
afterAll(async () => {
  await dropDrainKicksSince(KICKS_FROM);
  await db.delete(notifications).where(and(eq(notifications.type, 'AgentTariffNotice'), eq(notifications.userId, holderId)));
  if (hadCapsRow) await db.update(agentSendCaps).set({ tariffNoticeFor: noticeForBefore }).where(eq(agentSendCaps.id, 1));
  await __restoreAgentConfig(snapshot);
  await db.update(users).set({ active: false }).where(eq(users.id, holderId));
});

describe('the tariff notice through the sweep, on a day inside its window', () => {
  it('the fixture stands where every day from 2026-12-17 stands: today is inside the table’s notice window, by day', () => {
    expect(SITE_TARIFF.validThrough).toBe(table.validThrough);
    expect(tashkentDay(T0) >= tariffNoticeFrom(SITE_TARIFF.validThrough)).toBe(true);
    expect(tashkentDay(T0) <= SITE_TARIFF.validThrough).toBe(true);
  });

  it('the suites’ default: the switch is OFF — a sweep inside the window claims nothing and queues nothing', async () => {
    // What vitest.config sets for every file: nothing in this process switched it.
    expect(process.env.AGENT_TARIFF_NOTICE).toBe('off');
    expect(tariffNoticeOn()).toBe(false);
    await agentSweep(T0);
    await agentSweep(new Date());
    expect(await noticeFor()).toBeNull();
    expect(await cards()).toHaveLength(0);
  });

  it('switched on, the SWEEP sends it (its step 8 — the function is no orphan): once, to the holder, with the stamp its button vouches for', async () => {
    process.env.AGENT_TARIFF_NOTICE = 'on';
    onTestFinished(() => {
      process.env.AGENT_TARIFF_NOTICE = 'off';
    });
    await agentSweep(T0);
    // The next minute's sweep, and one more: the claim is the table's, taken once.
    await agentSweep(T0);
    await agentSweep(new Date(T0.getTime() + 60_000));
    const sent = await cards();
    expect(sent).toHaveLength(1);
    const payload = sent[0]!.payload as { holderId: string; fingerprint: string; text: string };
    expect(payload.holderId).toBe(holderId);
    expect(payload.fingerprint).toBe(await currentTariffFingerprint(T0));
    expect(payload.text).toContain('Saytdagi narx jadvali');
    expect(await noticeFor()).toBe(table.validThrough);
  });

  it('both suites set the switch — vitest for every test file, Playwright for its own server’s minute sweep', () => {
    expect(readFileSync('vitest.config.ts', 'utf8')).toMatch(/env: \{[^}]*AGENT_TARIFF_NOTICE: 'off'/u);
    expect(readFileSync('playwright.config.ts', 'utf8')).toMatch(/AGENT_TARIFF_NOTICE: 'off'/u);
  });
});
