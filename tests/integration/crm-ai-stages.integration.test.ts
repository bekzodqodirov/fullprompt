import 'dotenv/config';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The funnel's stage settings are written through ONE server action (SPEC-P2-v2 §3.1): its gate and its request
 * context are stood in for, so what is asserted is the door itself — the closed (board, which) map, the stage rules,
 * the order of the AI's two stages, and the audit row.
 */
const actorId = vi.hoisted(() => ({ current: '00000000-0000-0000-0000-000000000000' }));
vi.mock('@/modules/platform/rbac/authorize', async (original) => ({
  ...(await original<typeof import('@/modules/platform/rbac/authorize')>()),
  authorize: vi.fn(async () => ({ id: actorId.current, roles: ['sales_head'], permissions: new Set(['crm.manage']) })),
}));
vi.mock('@/modules/platform/auth/session', async (original) => ({
  ...(await original<typeof import('@/modules/platform/auth/session')>()),
  requestMeta: vi.fn(async () => ({ ip: null, userAgent: null })),
}));
vi.mock('next/cache', async (original) => ({ ...(await original<typeof import('next/cache')>()), revalidatePath: vi.fn() }));
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => null),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import { auditLog, dealStages, leadStages, settings, users } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { SETTINGS_AUDIT_ID } from '@/modules/platform/settings/service';
import { setAiStageAction } from '@/app/(protected)/crm/actions';

/**
 * CONFIGURATION is the next file's input on the one shared database (#183): the four stage settings are snapshotted
 * and put back in `finally`, the stages minted here removed, the fixture person deactivated (never deleted — the
 * audit FK).
 */

const SUFFIX = String(Date.now()).slice(-6);
const KEYS = ['crm_calc_stage', 'deal_calc_stage', 'crm_ai_contacted_stage', 'crm_ai_quoted_stage'];
const before = new Map<string, unknown>();
const lead: Record<'one' | 'two' | 'three' | 'won' | 'off', string> = { one: '', two: '', three: '', won: '', off: '' };
let dealOpen = '';
let personId = '';

async function rawSetting(key: string): Promise<unknown> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  return row ? row.value : null;
}

async function putSetting(key: string, value: unknown): Promise<void> {
  if (value === null) await db.delete(settings).where(eq(settings.key, key));
  else await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

const press = (board: string, which: string, stageId: string) => {
  const form = new FormData();
  form.set('board', board);
  form.set('which', which);
  form.set('stageId', stageId);
  return setAiStageAction({}, form);
};

async function audits(key: string) {
  return db
    .select({ before: auditLog.before, after: auditLog.after, actorId: auditLog.actorId })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'settings'), eq(auditLog.entityId, SETTINGS_AUDIT_ID), sql`${auditLog.after} ? ${key}`, eq(auditLog.actorId, personId)))
    .orderBy(desc(auditLog.createdAt));
}

beforeAll(async () => {
  for (const key of KEYS) before.set(key, await rawSetting(key));
  const [u] = await db
    .insert(users)
    .values({ phone: `+99890${SUFFIX}77`, fullName: `Bosqich sozlovchi ${SUFFIX}`, passwordHash: 'x' })
    .returning({ id: users.id });
  personId = u!.id;
  actorId.current = personId;
  const rows = [
    ['one', 'open', 9_501, true],
    ['two', 'open', 9_502, true],
    ['three', 'open', 9_503, true],
    ['won', 'won', 9_504, true],
    ['off', 'open', 9_505, false],
  ] as const;
  for (const [key, kind, sortOrder, active] of rows) {
    const [s] = await db.insert(leadStages).values({ name: `P4 sozlama ${key} ${SUFFIX}`, kind, sortOrder, active }).returning({ id: leadStages.id });
    lead[key] = s!.id;
  }
  const [d] = await db.insert(dealStages).values({ name: `P4 bitim ${SUFFIX}`, kind: 'open', sortOrder: 9_506 }).returning({ id: dealStages.id });
  dealOpen = d!.id;
});

beforeEach(async () => {
  for (const key of KEYS) await putSetting(key, '');
});

afterAll(async () => {
  try {
    await db.delete(leadStages).where(inArray(leadStages.id, Object.values(lead).filter(Boolean)));
    if (dealOpen) await db.delete(dealStages).where(eq(dealStages.id, dealOpen));
  } finally {
    for (const [key, value] of before) await putSetting(key, value);
    await db.update(users).set({ active: false }).where(eq(users.id, personId));
    await pgClient.end();
  }
});

describe('setAiStageAction — one door for the funnel’s stage settings (§3.1)', () => {
  it('a forged key is refused: only the closed (board, which) map names a key, and nothing is written', async () => {
    for (const [board, which] of [
      ['lead', 'crm_ai_quoted_stage'],
      ['lead', 'agent_calc_markup_value'],
      ['deal', 'ai_quoted'],
      ['admin', 'calc'],
      ['lead', '__proto__'],
    ]) {
      expect(await press(board!, which!, lead.two), `${board}/${which}`).toEqual({ error: 'bad_setting' });
    }
    for (const key of KEYS) expect(await rawSetting(key)).toBe('');
    expect(await rawSetting('agent_calc_markup_value')).not.toBe(lead.two);
  });

  it('a stage must be active and OPEN, of that board — a won stage, an inactive one, a deal stage, a garbage id', async () => {
    for (const stageId of [lead.won, lead.off, dealOpen, 'not-a-uuid', '00000000-0000-4000-8000-000000000000']) {
      expect(await press('lead', 'ai_contacted', stageId), stageId).toEqual({ error: 'stage_not_open' });
    }
    expect(await press('deal', 'calc', lead.one)).toEqual({ error: 'stage_not_open' });
    expect(await rawSetting('crm_ai_contacted_stage')).toBe('');
  });

  it('«AI narx aytdi» strictly after «AI birinchi javob berdi» — refused at or before it, from either side', async () => {
    expect(await press('lead', 'ai_contacted', lead.two)).toEqual({ ok: true });
    expect(await press('lead', 'ai_quoted', lead.one)).toEqual({ error: 'quoted_not_after_contacted' });
    expect(await press('lead', 'ai_quoted', lead.two)).toEqual({ error: 'quoted_not_after_contacted' });
    expect(await press('lead', 'ai_quoted', lead.three)).toEqual({ ok: true });
    expect(await press('lead', 'ai_contacted', lead.three)).toEqual({ error: 'quoted_not_after_contacted' });
    expect([await rawSetting('crm_ai_contacted_stage'), await rawSetting('crm_ai_quoted_stage')]).toEqual([lead.two, lead.three]);
    // The calc stage is no part of the AI's pair: any open stage.
    expect(await press('lead', 'calc', lead.one)).toEqual({ ok: true });
  });

  it('every write is audited under the settings’ id with the key in before/after; an unchanged one writes nothing', async () => {
    expect(await press('lead', 'ai_quoted', lead.three)).toEqual({ ok: true });
    const [row] = await audits('crm_ai_quoted_stage');
    expect(row).toMatchObject({ before: { crm_ai_quoted_stage: '' }, after: { crm_ai_quoted_stage: lead.three }, actorId: personId });
    const count = (await audits('crm_ai_quoted_stage')).length;
    expect(await press('lead', 'ai_quoted', lead.three)).toEqual({ ok: true });
    expect(await audits('crm_ai_quoted_stage')).toHaveLength(count);
    // Empty is a real answer — «leave the card where it is» — and is audited too.
    expect(await press('lead', 'ai_quoted', '')).toEqual({ ok: true });
    expect(await rawSetting('crm_ai_quoted_stage')).toBe('');
    expect((await audits('crm_ai_quoted_stage'))[0]).toMatchObject({ before: { crm_ai_quoted_stage: lead.three }, after: { crm_ai_quoted_stage: '' } });
  });

  it('the deal board’s «Hisoblatish» stage — the old calc-stage action’s job — goes through the same door, audited', async () => {
    expect(await press('deal', 'calc', dealOpen)).toEqual({ ok: true });
    expect(await rawSetting('deal_calc_stage')).toBe(dealOpen);
    expect((await audits('deal_calc_stage'))[0]).toMatchObject({ after: { deal_calc_stage: dealOpen } });
  });

  it('the gate is crm.manage — a person without it is refused before anything is read', async () => {
    vi.mocked(authorize).mockRejectedValueOnce(new AuthError('no', 'forbidden'));
    expect(await press('lead', 'ai_contacted', lead.one)).toEqual({ error: 'forbidden' });
    expect(vi.mocked(authorize)).toHaveBeenLastCalledWith('crm.manage');
    expect(await rawSetting('crm_ai_contacted_stage')).toBe('');
  });
});
