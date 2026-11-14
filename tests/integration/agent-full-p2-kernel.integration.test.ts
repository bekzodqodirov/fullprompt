import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The generic settings door is a server action: its gate and its redirect are stood in for, so the refusal itself
 * — that nothing is written and the words are on their way — is what this file asserts.
 */
vi.mock('@/modules/platform/rbac/authorize', async (original) => ({
  ...(await original<typeof import('@/modules/platform/rbac/authorize')>()),
  authorize: vi.fn(async () => ({ id: '00000000-0000-0000-0000-000000000000', roles: ['admin'], permissions: new Set(['admin.settings.manage']) })),
}));
vi.mock('next/navigation', async (original) => ({
  ...(await original<typeof import('next/navigation')>()),
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));
vi.mock('next/cache', async (original) => ({ ...(await original<typeof import('next/cache')>()), revalidatePath: vi.fn() }));
/** A job a press or a rule would queue is caught here: pg-boss is never started inside this test process. */
const queued = vi.hoisted(() => [] as { name: string; data: unknown }[]);
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async (name: string, data: unknown) => {
    queued.push({ name, data });
  }),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  agentAutoConfig,
  agentConfig,
  agentDrafts,
  agentOutbox,
  agentRuns,
  auditLog,
  automationRules,
  calcRequests,
  clients,
  events,
  leadSources,
  leadStages,
  leads,
  notifications,
  settings,
  tasks,
  tgAccountGuard,
  tgAccounts,
  tgMessages,
  users,
} from '@/modules/platform/db/schema';
import { auditByAi } from '@/modules/platform/audit/fields';
import { holderIsSeat, AGENT_SEAT_KEY } from '@/modules/platform/settings/agent-seat';
import { openCalcCapFor, OPEN_CALC_CAP_PEOPLE, OPEN_CALC_LIMIT_KEY } from '@/modules/platform/settings/calc-cap';
import { getSetting, setSetting, SETTINGS_AUDIT_ID } from '@/modules/platform/settings/service';
import { runAutomationRules } from '@/modules/platform/automation/service';
import { anchorMaxAgeMsFor, anchorMaxAgeMsSqlText } from '@/modules/wms/agent/anchor-clock';
import { AutoConfigError, __restoreAutoConfig, readAutoConfig, setAutoCategories, type AutoConfig } from '@/modules/wms/agent/auto-send';
import {
  AgentConfigError,
  __forgetAgentFullP2Ready,
  __pretendAgentFullP2Behind,
  __restoreAgentConfig,
  agentFullP2Ready,
  readAgentConfig,
  setAgentSeat,
  setCalcOpenLimit,
  type AgentConfig,
} from '@/modules/wms/agent/config';
import { decideDraft } from '@/modules/wms/agent/decide';
import { expireStaleDrafts } from '@/modules/wms/agent/jobs';
import { agentRowById, sendFactsFor } from '@/modules/wms/agent/outbox-store';
import { runOwnerTriggered } from '@/modules/wms/agent/run';
import { readSendCaps } from '@/modules/wms/agent/send-caps';
import { agentSendVerdict, runAgentStep, type AgentOutboxRow, type AgentTelegram, type HeadMessage } from '@/modules/wms/agent/send-step';
import { autoPanel, openCalcsFor, seatPanel } from '@/modules/wms/agent/web-page';
import { isNudge } from '@/modules/wms/agent/worthy';
import { calcOpenRefusal } from '@/modules/wms/calc/service';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';
import { moveLeadByMachine } from '@/modules/wms/crm/service';
import { tgErrorKind } from '@/modules/wms/crm/telegram-guard';
import { updateSettingAction } from '@/app/(protected)/admin/settings/actions';

/**
 * The full AI seller, part 2, package P1 — the kernel against a real database (SPEC-P2-v2 §0a, §1.3, §3.2-§3.3,
 * §4.1-§4.2): what 0149 leaves, every reader one migration behind it, the AI seat and the one open-calc cap, the
 * own-door settings refused by the generic form, the live head forgiving our own «yubordim» for an owner-started
 * reply (through the real send step), the one anchor clock at the run, his ✅, the send step and the sweep, and the
 * machine's own stage move on a locked lead.
 *
 * CONFIGURATION is the next file's input on the one shared database (#183): agent_config, agent_auto_config, the
 * send switch, the seat, the open-calc limit and the two AI stage settings are snapshotted and put back; the lead
 * stages this file mints are removed; fixture people are deactivated, never deleted (the audit FK).
 */

const SUFFIX = String(Date.now()).slice(-6);
const BASE = BigInt(Date.now()) * 1000n;
let seq = 0n;
const next = () => BASE + ++seq;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let holderId = '';
let colleagueId = '';
let accountId = '';
let clientId = '';
let agentSnapshot: AgentConfig | null = null;
let autoSnapshot: AutoConfig | null = null;
let sendingBefore = false;
/** The raw settings rows this file touches, as found (null = no row). */
const settingsBefore = new Map<string, unknown>();
const TOUCHED_SETTINGS = [AGENT_SEAT_KEY, OPEN_CALC_LIMIT_KEY, 'crm_ai_contacted_stage', 'crm_ai_quoted_stage', 'agent_calc_markup_value'];
const madeLeads: string[] = [];
const madeStages: string[] = [];
const madeRequests: string[] = [];
const madeRules: string[] = [];

const superAdmin = () => ({ id: holderId, roles: ['super_admin'] });
const holderActor = () => ({ id: holderId, roles: ['sales_manager'] });
const ctx = () => ({ actorId: holderId });
const stepCtx = () => ({ accountId, caughtUp: () => true, random: () => 0 });

async function rawSetting(key: string): Promise<unknown> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  return row ? row.value : null;
}

async function putSetting(key: string, value: unknown): Promise<void> {
  if (value === null) await db.delete(settings).where(eq(settings.key, key));
  else await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

async function makeUser(tag: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99893${SUFFIX}${tag}`, fullName: `P2 yadro ${tag} ${SUFFIX}`, passwordHash: 'x' })
    .returning({ id: users.id });
  return u!.id;
}

async function message(peer: bigint, id: bigint, direction: 'in' | 'out', sentAt: Date, body = 'Rastamojka qancha bo‘ladi?'): Promise<void> {
  await db.insert(tgMessages).values({ clientId, managerUserId: holderId, peerId: peer, tgMessageId: id, direction, body, sentAt });
}

/**
 * A chat: the customer's line `anchor` (aged `ageMs`), optionally the AI's own earlier «yubordim» sent after it
 * (stored as our agent send, with its Telegram id), and an APPROVED reply of `kind` / `policy` answering the anchor,
 * waiting on the pump at `step`.
 */
async function chat(input: {
  kind: 'reply' | 'price' | 'hand_back';
  policy?: Record<string, unknown>;
  ageMs?: number;
  ourSendAfter?: boolean;
  status?: 'approved' | 'pending';
}): Promise<{ row: AgentOutboxRow | null; peer: bigint; anchor: bigint; ours: bigint | null; draftId: string }> {
  const peer = next();
  const anchor = next();
  const now = Date.now();
  await message(peer, anchor, 'in', new Date(now - (input.ageMs ?? 10 * 60_000)));
  let ours: bigint | null = null;
  if (input.ourSendAfter) {
    ours = next();
    await message(peer, ours, 'out', new Date(now - 5 * 60_000), 'Hisoblatishga yubordim, javob kelishi bilan aytaman.');
    const [d0] = await db
      .insert(agentDrafts)
      .values({ managerUserId: holderId, peerId: peer, anchorTgMessageId: anchor, clientId, status: 'approved', kind: 'reply', proposedBody: 'yubordim' })
      .returning({ id: agentDrafts.id });
    await db.insert(agentOutbox).values({
      draftId: d0!.id,
      managerUserId: holderId,
      peerId: peer,
      clientId,
      body: 'Hisoblatishga yubordim, javob kelishi bilan aytaman.',
      randomId: next(),
      answersTgMessageId: anchor,
      status: 'sent',
      step: 'send',
      nextStepAt: new Date(now - 5 * 60_000),
      queuedBy: holderId,
      sentAt: new Date(now - 5 * 60_000),
      tgMessageId: ours,
    });
  }
  const [d] = await db
    .insert(agentDrafts)
    .values({
      managerUserId: holderId,
      peerId: peer,
      anchorTgMessageId: anchor,
      clientId,
      status: input.status ?? 'approved',
      kind: input.kind,
      proposedBody: input.kind === 'price' ? 'Rastamojka narxi: 1250 $.' : 'Yana bir savol: yuk necha kg?',
      policy: input.policy ?? {},
    })
    .returning({ id: agentDrafts.id });
  if ((input.status ?? 'approved') === 'pending') return { row: null, peer, anchor, ours, draftId: d!.id };
  const [o] = await db
    .insert(agentOutbox)
    .values({
      draftId: d!.id,
      managerUserId: holderId,
      peerId: peer,
      clientId,
      body: input.kind === 'price' ? 'Rastamojka narxi: 1250 $.' : 'Yana bir savol: yuk necha kg?',
      randomId: next(),
      answersTgMessageId: anchor,
      status: 'agent',
      step: 'verify',
      nextStepAt: new Date(now - 1000),
      queuedBy: holderId,
    })
    .returning({ id: agentOutbox.id });
  return { row: await agentRowById(o!.id), peer, anchor, ours, draftId: d!.id };
}

/** Telegram as the send step sees it: the live head is `head`, and a send answers a fresh id. */
function fakeTg(head: HeadMessage[]): AgentTelegram & { sent: number } {
  const tg = {
    sent: 0,
    history: async () => head,
    readHistory: async () => {},
    setTyping: async () => {},
    markUnread: async () => {},
    send: async () => {
      tg.sent += 1;
      return { tgMessageId: next() };
    },
  };
  return tg;
}

const headOf = (msgs: [bigint, boolean, string][]): HeadMessage[] => msgs.map(([id, out, text]) => ({ id, out, text, media: false }));

/** The step, with the real store's facts — the agent and the CRM's switch read as on (this file's config is its own). */
function step(row: AgentOutboxRow, tg: AgentTelegram) {
  return runAgentStep(row, {
    tg,
    store: {
      facts: async (r, now) => ({ ...(await sendFactsFor(r, now, stepCtx())), agentOn: true, ownerUserId: holderId, sendingEnabled: true }),
      claimSend: async (id) =>
        (await db.update(agentOutbox).set({ status: 'sending' }).where(and(eq(agentOutbox.id, id), eq(agentOutbox.status, 'agent'))).returning({ id: agentOutbox.id }))
          .length > 0,
    },
    classify: tgErrorKind,
    isNudge,
  });
}

const refused = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof AgentConfigError || e instanceof AutoConfigError ? e.code : String(e)),
  );

beforeAll(async () => {
  agentSnapshot = await readAgentConfig();
  autoSnapshot = await readAutoConfig();
  sendingBefore = (await getSetting('tg_sending_enabled')) === true;
  for (const key of TOUCHED_SETTINGS) settingsBefore.set(key, await rawSetting(key));
  holderId = await makeUser('01');
  colleagueId = await makeUser('02');
  const [acc] = await db
    .insert(tgAccounts)
    .values({ managerUserId: holderId, tgPhone: `+99894${SUFFIX}01`, sessionEnc: 'v1.x.y.z', status: 'active', lastSeenAt: new Date() })
    .returning({ id: tgAccounts.id });
  accountId = acc!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `PK${SUFFIX}`, name: `P2 yadro mijoz ${SUFFIX}`, phones: [`+99897${SUFFIX}11`] })
    .returning({ id: clients.id });
  clientId = c!.id;
  await db
    .update(agentConfig)
    .set({ mode: 'shadow', ownerUserId: holderId, sessionExclusiveAt: new Date(), sessionExclusiveBy: holderId, startedAt: new Date(Date.now() - 30 * DAY) })
    .where(eq(agentConfig.id, 1));
  // No seat and no typed cap while this file starts: every cap here is the code's own.
  await putSetting(AGENT_SEAT_KEY, null);
  await putSetting(OPEN_CALC_LIMIT_KEY, null);
  __forgetAgentFullP2Ready();
});

afterEach(() => {
  vi.useRealTimers();
  __forgetAgentFullP2Ready();
});

afterAll(async () => {
  vi.useRealTimers();
  try {
    if (madeRules.length) await db.delete(automationRules).where(inArray(automationRules.id, madeRules));
    await db.delete(tasks).where(inArray(tasks.assigneeId, [holderId, colleagueId]));
    await db.delete(notifications).where(inArray(notifications.userId, [holderId, colleagueId]));
    await db.delete(agentOutbox).where(eq(agentOutbox.managerUserId, holderId));
    await db.delete(agentRuns).where(eq(agentRuns.managerUserId, holderId));
    await db.delete(agentDrafts).where(eq(agentDrafts.managerUserId, holderId));
    await db.delete(tgMessages).where(eq(tgMessages.managerUserId, holderId));
    if (madeRequests.length) await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    if (madeLeads.length) {
      await db.delete(events).where(inArray(events.entityId, madeLeads));
      await db.delete(leads).where(inArray(leads.id, madeLeads));
    }
    if (madeStages.length) await db.delete(leadStages).where(inArray(leadStages.id, madeStages));
    await db.delete(tgAccountGuard).where(eq(tgAccountGuard.accountId, accountId));
    await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
    await db.delete(clients).where(eq(clients.id, clientId));
  } finally {
    await __restoreAgentConfig(agentSnapshot);
    await __restoreAutoConfig(autoSnapshot);
    await setSetting('tg_sending_enabled', sendingBefore, null);
    for (const [key, value] of settingsBefore) await putSetting(key, value);
    await db.update(users).set({ active: false }).where(inArray(users.id, [holderId, colleagueId]));
    await pgClient.end();
  }
});

describe('0149 — what the migration leaves (§4.1, §4.2)', () => {
  it('the probe finds it; the kinds CHECK admits the two new kinds and nothing else; the stored kinds are untouched', async () => {
    expect(await agentFullP2Ready()).toBe(true);
    const code = async (categories: string[]) =>
      db
        .update(agentAutoConfig)
        .set({ categories })
        .where(eq(agentAutoConfig.id, 1))
        .then(
          () => 'ok',
          (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code ?? 'error',
        );
    const before = (await readAutoConfig())!.categories;
    try {
      expect(await code(['faq', 'calc', 'calc_price'])).toBe('ok');
      expect(await code(['complaint'])).toBe('23514');
      expect(await code(['calc_offer'])).toBe('23514');
    } finally {
      await db.update(agentAutoConfig).set({ categories: [...before] }).where(eq(agentAutoConfig.id, 1));
    }
    expect(before).not.toContain('calc');
    expect(before).not.toContain('calc_price');
  });

  it('agent_offers: the offer cascades, the request cascades, the draft only lets go (SET NULL) — and the reader role gets nothing', async () => {
    const rows = await db.execute<{ col: string; ref: string; del: string }>(sql`
      SELECT a.attname AS col, cl.relname AS ref, c.confdeltype AS del
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        JOIN pg_class cl ON cl.oid = c.confrelid
       WHERE c.conrelid = 'public.agent_offers'::regclass AND c.contype = 'f'
       ORDER BY a.attname`);
    expect([...rows].map((r) => [r.col, r.ref, r.del])).toEqual([
      ['draft_id', 'agent_drafts', 'n'],
      ['offer_id', 'calc_offers', 'c'],
      ['request_id', 'calc_requests', 'c'],
    ]);
    const grants = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE table_name = 'agent_offers' AND grantee = 'gsr_ai_reader'`);
    expect(Number([...grants][0]!.n)).toBe(0);
  });
});

describe('one migration behind 0149 — every reader runs, the two new boxes are refused in words', () => {
  it('the configs, the caps and the page read; ticking «Hisoblatish» or «VED narxi» is not_ready; the old kinds still save', async () => {
    const before = (await readAutoConfig())!.categories;
    __pretendAgentFullP2Behind();
    try {
      expect(await agentFullP2Ready()).toBe(false);
      expect(await readAgentConfig()).not.toBeNull();
      expect(await readAutoConfig()).not.toBeNull();
      expect((await readSendCaps()).ready).toBe(true);
      const panel = await autoPanel({ id: holderId, roles: ['super_admin'] }, holderId);
      expect(panel).toMatchObject({ fullReady: true, p2Ready: false });
      expect(await openCalcsFor(holderId)).toMatchObject({ cap: OPEN_CALC_CAP_PEOPLE });
      expect(await refused(setAutoCategories(holderActor(), ['faq', 'calc'], ctx()))).toBe('not_ready');
      expect(await refused(setAutoCategories(holderActor(), ['calc_price'], ctx()))).toBe('not_ready');
      expect(await refused(setAutoCategories(holderActor(), ['faq', 'status'], ctx()))).toBe('ok');
    } finally {
      __forgetAgentFullP2Ready();
      await db.update(agentAutoConfig).set({ categories: [...before] }).where(eq(agentAutoConfig.id, 1));
    }
    // With 0149 there, the same tick saves — and the page offers the boxes.
    try {
      expect(await refused(setAutoCategories(holderActor(), ['faq', 'calc', 'calc_price'], ctx()))).toBe('ok');
      expect((await autoPanel({ id: holderId, roles: ['super_admin'] }, holderId))!.p2Ready).toBe(true);
    } finally {
      await db.update(agentAutoConfig).set({ categories: [...before] }).where(eq(agentAutoConfig.id, 1));
    }
  });
});

describe('the AI seat (K4) and the one open-calc cap (§1.3)', () => {
  it('a super_admin names the holder as the seat — nobody else, never another user — audited with the key', async () => {
    try {
      expect(await refused(setAgentSeat(holderActor(), holderId, ctx()))).toBe('forbidden');
      expect(await refused(setAgentSeat(superAdmin(), colleagueId, ctx()))).toBe('seat_not_holder');
      expect(await holderIsSeat()).toBe(false);
      expect(await setAgentSeat(superAdmin(), holderId, ctx())).toBe(holderId);
      expect(await holderIsSeat()).toBe(true);
      expect(await seatPanel()).toMatchObject({ state: 'holds' });
      const [audit] = await db
        .select({ before: auditLog.before, after: auditLog.after })
        .from(auditLog)
        .where(and(eq(auditLog.entityType, 'settings'), eq(auditLog.entityId, SETTINGS_AUDIT_ID), eq(auditLog.actorId, holderId)))
        .orderBy(desc(auditLog.id))
        .limit(1);
      expect(audit).toEqual({ before: { [AGENT_SEAT_KEY]: null }, after: { [AGENT_SEAT_KEY]: holderId } });
      // The seat is not on /admin/settings: no default key, so getAllSettings never lists it.
      expect(Object.keys((await import('@/modules/platform/settings/service')).SETTING_DEFAULTS)).not.toContain(AGENT_SEAT_KEY);
    } finally {
      await putSetting(AGENT_SEAT_KEY, null);
    }
  });

  it('the seat holds → its own number (100, or typed); a person, no seat, or a seat the holder left → 20', async () => {
    try {
      expect(await openCalcCapFor(holderId)).toBe(20);
      await setAgentSeat(superAdmin(), holderId, ctx());
      expect(await openCalcCapFor(holderId)).toBe(100);
      expect(await openCalcCapFor(colleagueId)).toBe(20);
      expect(await openCalcsFor(holderId)).toMatchObject({ cap: 100 });
      // His typed number — a super_admin's alone, 1..200, audited.
      expect(await refused(setCalcOpenLimit(holderActor(), '150', ctx()))).toBe('forbidden');
      expect(await refused(setCalcOpenLimit(superAdmin(), '0', ctx()))).toBe('bad_value');
      expect(await refused(setCalcOpenLimit(superAdmin(), '201', ctx()))).toBe('bad_value');
      expect(await setCalcOpenLimit(superAdmin(), ' 150 ', ctx())).toBe(150);
      expect(await openCalcCapFor(holderId)).toBe(150);
      const [audit] = await db
        .select({ after: auditLog.after })
        .from(auditLog)
        .where(and(eq(auditLog.entityType, 'settings'), eq(auditLog.actorId, holderId), sql`${auditLog.after} ? ${OPEN_CALC_LIMIT_KEY}`))
        .orderBy(desc(auditLog.id))
        .limit(1);
      expect(audit).toEqual({ after: { [OPEN_CALC_LIMIT_KEY]: 150 } });
      // The holder re-pointed elsewhere: the seat names nobody who speaks — every seat-only act stops (fail closed).
      await db.update(agentConfig).set({ ownerUserId: colleagueId }).where(eq(agentConfig.id, 1));
      expect(await holderIsSeat()).toBe(false);
      expect(await openCalcCapFor(holderId)).toBe(20);
      expect(await seatPanel()).toMatchObject({ state: 'elsewhere' });
    } finally {
      await db.update(agentConfig).set({ ownerUserId: holderId }).where(eq(agentConfig.id, 1));
      await putSetting(AGENT_SEAT_KEY, null);
      await putSetting(OPEN_CALC_LIMIT_KEY, null);
    }
  });

  it('the queue refuses at the requester’s own cap: twenty open is the end for a person, not for the seat', async () => {
    const busy = await db
      .insert(calcRequests)
      .values(
        Array.from({ length: OPEN_CALC_CAP_PEOPLE }, () => ({
          entityType: 'lead',
          entityId: holderId,
          requestedBy: holderId,
          itemCount: 0,
          dueAt: new Date(Date.now() + HOUR),
        })),
      )
      .returning({ id: calcRequests.id });
    madeRequests.push(...busy.map((b) => b.id));
    try {
      expect(await calcOpenRefusal(holderId, 1)).toBe('too_many_open');
      await setAgentSeat(superAdmin(), holderId, ctx());
      expect(await calcOpenRefusal(holderId, 1)).toBeNull();
    } finally {
      await putSetting(AGENT_SEAT_KEY, null);
      await db.delete(calcRequests).where(inArray(calcRequests.id, busy.map((b) => b.id)));
    }
  });
});

describe('a key with its own door is refused by the generic settings form (K5)', () => {
  it.each(['agent_calc_markup_kind', 'agent_calc_markup_value', 'agent_calc_open_limit', 'crm_ai_contacted_stage', 'crm_ai_quoted_stage'])(
    '%s: nothing is written, the words are on the way',
    async (key) => {
      const before = await rawSetting(key);
      const form = new FormData();
      form.set('key', key);
      form.set('value', key === 'agent_calc_markup_kind' ? 'fixed' : key.startsWith('crm_') ? randomUUID() : '10');
      await expect(updateSettingAction(form)).rejects.toThrow(`REDIRECT:/admin/settings?own=${key}`);
      expect(await rawSetting(key)).toEqual(before);
    },
  );
});

describe('the live head forgives our own «yubordim» for an owner-started reply — through the real send step (K1)', () => {
  it('his 💵: customer line → the AI’s «yubordim» sent → his price approved → verify passes, and it sends', async () => {
    const c = await chat({ kind: 'price', policy: { priceRequestId: randomUUID() }, ourSendAfter: true });
    const head = headOf([
      [c.ours!, true, 'Hisoblatishga yubordim, javob kelishi bilan aytaman.'],
      [c.anchor, false, 'Rastamojka qancha bo‘ladi?'],
    ]);
    const tg = fakeTg(head);
    expect(await step(c.row!, tg)).toMatchObject({ kind: 'advance', step: 'read' });
    expect(await step({ ...c.row!, step: 'send' }, tg)).toMatchObject({ kind: 'sent' });
    expect(tg.sent).toBe(1);
  });

  it('the hand-back question: the same', async () => {
    const c = await chat({ kind: 'hand_back', ourSendAfter: true });
    const tg = fakeTg(headOf([[c.ours!, true, 'yubordim'], [c.anchor, false, 'Rastamojka?']]));
    expect(await step(c.row!, tg)).toMatchObject({ kind: 'advance', step: 'read' });
  });

  it('a hand-typed message of his after the anchor still cancels — the live head saw it before the store did', async () => {
    const c = await chat({ kind: 'price', policy: { priceRequestId: randomUUID() }, ourSendAfter: true });
    const his = next();
    const tg = fakeTg(headOf([[his, true, 'Narx 1200 $'], [c.ours!, true, 'yubordim'], [c.anchor, false, 'Rastamojka?']]));
    expect(await step(c.row!, tg)).toEqual({ kind: 'cancel', reason: 'human_replied', markUnread: false });
    expect(tg.sent).toBe(0);
  });

  it('an ordinary inbound reply keeps today’s rule: an earlier send of ours after its anchor cancels it (two replies to one burst never both go)', async () => {
    const c = await chat({ kind: 'reply', ourSendAfter: true });
    const tg = fakeTg(headOf([[c.ours!, true, 'yubordim'], [c.anchor, false, 'Rastamojka?']]));
    expect(await step(c.row!, tg)).toEqual({ kind: 'cancel', reason: 'human_replied', markUnread: false });
  });
});

describe('ONE anchor clock at the send step, the sweep, the run and his ✅ (K2)', () => {
  const PRICE = () => ({ priceRequestId: randomUUID() });

  it('the send step: his 💵 lives a week, an ordinary reply a day', async () => {
    const verdictAt = async (kind: 'reply' | 'price', ageMs: number) => {
      const c = await chat({ kind, policy: kind === 'price' ? PRICE() : {}, ageMs });
      const f = await sendFactsFor(c.row!, new Date(), stepCtx());
      return agentSendVerdict(c.row!, { ...f, agentOn: true, ownerUserId: holderId, sendingEnabled: true });
    };
    const tooOld = (v: Awaited<ReturnType<typeof verdictAt>>) => !v.ok && v.final && v.reason === 'anchor_too_old';
    expect(tooOld(await verdictAt('price', 25 * HOUR))).toBe(false);
    expect(tooOld(await verdictAt('price', 7 * DAY - HOUR))).toBe(false);
    expect(tooOld(await verdictAt('price', 7 * DAY + HOUR))).toBe(true);
    expect(tooOld(await verdictAt('reply', 25 * HOUR))).toBe(true);
    expect(tooOld(await verdictAt('reply', 23 * HOUR))).toBe(false);
  });

  it('the sweep expires each draft by its own clock — a 💵 card born two days after the request stays', async () => {
    const at = async (kind: 'reply' | 'price', ageMs: number) =>
      (await chat({ kind, policy: kind === 'price' ? PRICE() : {}, ageMs, status: 'pending' })).draftId;
    const ids = {
      price25h: await at('price', 25 * HOUR),
      price6d23h: await at('price', 7 * DAY - HOUR),
      price7d1h: await at('price', 7 * DAY + HOUR),
      reply23h: await at('reply', 23 * HOUR),
      reply25h: await at('reply', 25 * HOUR),
    };
    const expired = new Set((await expireStaleDrafts(new Date())).map((r) => r.id));
    expect(Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, expired.has(id)]))).toEqual({
      price25h: false,
      price6d23h: false,
      price7d1h: true,
      reply23h: false,
      reply25h: true,
    });
  });

  it('the sweep’s SQL and the function agree on every draft shape', async () => {
    const GRID: { kind: string; policy: unknown }[] = [
      { kind: 'reply', policy: {} },
      { kind: 'hand_back', policy: {} },
      { kind: 'price', policy: { priceRequestId: 'r1' } },
      { kind: 'price', policy: {} },
      { kind: 'price', policy: { priceRequestId: 5 } },
      { kind: 'reply', policy: { calcAnswer: { requestId: 'r1' } } },
      { kind: 'reply', policy: { calcAnswer: 'r1' } },
      { kind: 'reply', policy: { calcAnswer: {} } },
      { kind: 'reply', policy: { priceRequestId: 'r1' } },
      { kind: 'price', policy: { calcAnswer: { requestId: 'r1' } } },
    ];
    const rows = await db.execute<{ i: number; ms: string }>(sql`
      SELECT d.i, ${sql.raw(anchorMaxAgeMsSqlText('d'))}::text AS ms
        FROM (VALUES ${sql.join(
          GRID.map((g, i) => sql`(${i}::int, ${g.kind}::text, ${JSON.stringify(g.policy)}::jsonb)`),
          sql`, `,
        )}) d(i, kind, policy)
       ORDER BY d.i`);
    expect([...rows].map((r) => Number(r.ms))).toEqual(GRID.map((g) => anchorMaxAgeMsFor(g)));
  });

  it('the run: a VED answer’s run answers a line up to a week old; the hand-back keeps a day', async () => {
    await stampAgentPump(accountId, true);
    const failing = (async () => {
      throw new Error('no model in this test');
    }) as never;
    const runAt = async (trigger: 'hand_back' | 'calc_answer', ageMs: number) => {
      const peer = next();
      await message(peer, next(), 'in', new Date(Date.now() - ageMs));
      return runOwnerTriggered(
        { trigger, managerUserId: holderId, peerId: peer, sourceKey: `p2k:${peer}`, instruction: 'x' },
        { callModel: failing },
      );
    };
    expect(await runAt('hand_back', 25 * HOUR)).toEqual({ outcome: 'skipped', reason: 'no_fresh_inbound' });
    // Past BOTH age checks (the run's and the eligibility rule's) — it reached the model, which this test refuses.
    expect(await runAt('calc_answer', 25 * HOUR)).toMatchObject({ outcome: 'error' });
    expect(await runAt('calc_answer', 7 * DAY - HOUR)).toMatchObject({ outcome: 'error' });
    expect(await runAt('calc_answer', 7 * DAY + HOUR)).toEqual({ outcome: 'skipped', reason: 'no_fresh_inbound' });
  });

  it('his ✅ on an agent lead’s chat: a 💵 within the week is approved, past it — and an ordinary reply past a day — window_closed', async () => {
    const [source] = await db.select({ id: leadSources.id }).from(leadSources).where(eq(leadSources.key, 'agent'));
    const [stage] = await db.select({ id: leadStages.id }).from(leadStages).where(eq(leadStages.kind, 'open')).orderBy(leadStages.sortOrder).limit(1);
    const [lead] = await db
      .insert(leads)
      .values({ name: `P2 oyna ${SUFFIX}`, phone: `+99890${SUFFIX}77`, stageId: stage!.id, sourceId: source!.id, ownerId: holderId })
      .returning({ id: leads.id });
    madeLeads.push(lead!.id);
    // Thursday 12:00 Tashkent — inside the agent lead's window, so the send is now and the age is the anchor's own.
    const noon = new Date('2026-10-29T12:00:00+05:00');
    // The ramp's clock is the agent's start: a month before this test's own day, so the day's ceiling is the cap.
    await db.update(agentConfig).set({ startedAt: new Date(noon.getTime() - 30 * DAY) }).where(eq(agentConfig.id, 1));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(noon);
    await db.update(tgAccountGuard).set({ agentPumpAt: noon, caughtUpAt: noon }).where(eq(tgAccountGuard.accountId, accountId));
    await setSetting('tg_sending_enabled', true, holderId);
    const drafted = async (kind: 'reply' | 'price', ageMs: number) => {
      const peer = next();
      const anchor = next();
      await db.insert(tgMessages).values({
        leadId: lead!.id,
        managerUserId: holderId,
        peerId: peer,
        tgMessageId: anchor,
        direction: 'in',
        body: 'Rastamojka qancha bo‘ladi?',
        sentAt: new Date(noon.getTime() - ageMs),
      });
      const [d] = await db
        .insert(agentDrafts)
        .values({
          managerUserId: holderId,
          peerId: peer,
          anchorTgMessageId: anchor,
          leadId: lead!.id,
          status: 'pending',
          kind,
          ...(kind === 'price' ? { proposedBody: 'Rastamojka narxi: 1250 $.', policy: PRICE() } : { finalBody: 'Ha, olib kelamiz.' }),
        })
        .returning({ id: agentDrafts.id });
      return d!.id;
    };
    const decide = async (id: string) => decideDraft({ id: holderId, roles: ['super_admin'], permissions: new Set<string>() }, id, 'send', {}, ctx());
    expect(await decide(await drafted('price', 7 * DAY - HOUR))).toMatchObject({ ok: true, status: 'approved' });
    expect(await decide(await drafted('price', 7 * DAY + HOUR))).toEqual({ ok: false, code: 'window_closed' });
    expect(await decide(await drafted('reply', 25 * HOUR))).toEqual({ ok: false, code: 'window_closed' });
    expect(await decide(await drafted('reply', 23 * HOUR))).toMatchObject({ ok: true, status: 'approved' });
  });
});

describe('the machine moves a lead — forward, between OPEN stages, on the locked row (§3.2, §3.3)', () => {
  const stageIds: Record<'new' | 'lost' | 'contacted' | 'won' | 'quoted', string> = { new: '', lost: '', contacted: '', won: '', quoted: '' };

  beforeAll(async () => {
    // A funnel of this file's own, far down the sort order; the AI's two stages point into it.
    const rows: [keyof typeof stageIds, string, number][] = [
      ['new', 'open', 9_101],
      ['lost', 'lost', 9_102],
      ['contacted', 'open', 9_103],
      ['won', 'won', 9_104],
      ['quoted', 'open', 9_105],
    ];
    for (const [key, kind, sortOrder] of rows) {
      const [s] = await db
        .insert(leadStages)
        .values({ name: `P2 ${key} ${SUFFIX}`, kind, sortOrder })
        .returning({ id: leadStages.id });
      stageIds[key] = s!.id;
      madeStages.push(s!.id);
    }
    await putSetting('crm_ai_contacted_stage', stageIds.contacted);
    await putSetting('crm_ai_quoted_stage', stageIds.quoted);
  });

  async function lead(stage: keyof typeof stageIds, owner: string | null = holderId, extra: Partial<typeof leads.$inferInsert> = {}): Promise<string> {
    const [l] = await db
      .insert(leads)
      .values({ name: `P2 lid ${SUFFIX}`, stageId: stageIds[stage], ownerId: owner, ...extra })
      .returning({ id: leads.id });
    madeLeads.push(l!.id);
    return l!.id;
  }
  const stageOf = async (id: string) => (await db.select({ s: leads.stageId, why: leads.lostReason, next: leads.nextActionAt }).from(leads).where(eq(leads.id, id)))[0]!;
  /** Wait until a backend waits on a row lock — the mover parked on the lead's FOR UPDATE. */
  async function moverParked(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const rows = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
           AND query ILIKE '%for update%' AND query ILIKE '%leads%'`);
      if (Number([...rows][0]!.n) > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the mover never parked on the lock');
  }

  it('contacted: moved forward, the seller’s booked call KEPT, the audit names the machine under no actor', async () => {
    const id = await lead('new', holderId, { nextActionAt: '2030-01-15', nextActionNote: 'Qo‘ng‘iroq qilish' });
    expect(await moveLeadByMachine(id, 'ai_contacted', { holderId })).toEqual({ moved: true, stageId: stageIds.contacted });
    expect(await stageOf(id)).toEqual({ s: stageIds.contacted, why: null, next: '2030-01-15' });
    const [row] = await db
      .select({ actorId: auditLog.actorId, before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'lead'), eq(auditLog.entityId, id)))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(row).toEqual({
      actorId: null,
      before: { stageId: stageIds.new },
      after: { stageId: stageIds.contacted, lostReason: null, via: 'ai', holder: holderId },
    });
    // The History tab's own rule names it «AI sotuvchi».
    expect(auditByAi({ actorId: row!.actorId, after: row!.after as Record<string, unknown> })).toBe(true);
    // The stage event went out under no actor, so «entered stage» rules still hear it.
    const [ev] = await db.select({ actor: events.actorId, payload: events.payload }).from(events).where(and(eq(events.type, 'LeadStageChanged'), eq(events.entityId, id)));
    expect(ev).toMatchObject({ actor: null, payload: { stageId: stageIds.contacted, ownerId: holderId } });
  });

  it('quoted, then a late «contacted»: the card is never walked back', async () => {
    const id = await lead('new');
    expect(await moveLeadByMachine(id, 'ai_quoted', { holderId })).toMatchObject({ moved: true });
    expect(await moveLeadByMachine(id, 'ai_contacted', { holderId })).toEqual({ moved: false, reason: 'not_forward' });
    expect((await stageOf(id)).s).toBe(stageIds.quoted);
  });

  it('a colleague’s lead, an empty setting, a LOST lead whose stage sits before the target: nothing moves, nothing is revived', async () => {
    const theirs = await lead('new', colleagueId);
    expect(await moveLeadByMachine(theirs, 'ai_contacted', { holderId })).toEqual({ moved: false, reason: 'not_mine' });
    const lost = await lead('lost', holderId, { lostReason: 'Narx qimmat' });
    expect(await moveLeadByMachine(lost, 'ai_contacted', { holderId })).toEqual({ moved: false, reason: 'current_closed' });
    expect(await stageOf(lost)).toMatchObject({ s: stageIds.lost, why: 'Narx qimmat' });
    // Nobody's lead is the machine's to move (K3).
    const nobody = await lead('new', null);
    expect(await moveLeadByMachine(nobody, 'ai_contacted', { holderId })).toMatchObject({ moved: true });
    const before = await rawSetting('crm_calc_stage');
    try {
      await putSetting('crm_calc_stage', null);
      expect(await moveLeadByMachine(await lead('new'), 'calc', { holderId })).toEqual({ moved: false, reason: 'not_configured' });
    } finally {
      await putSetting('crm_calc_stage', before);
    }
    expect(await moveLeadByMachine(randomUUID(), 'ai_contacted', { holderId })).toEqual({ moved: false, reason: 'lead_gone' });
  });

  it.each([
    ['won by a person', { stageKey: 'won' as const }, 'current_closed'],
    ['dragged to lost with a reason', { stageKey: 'lost' as const, lostReason: 'Boshqa kargo' }, 'current_closed'],
    ['handed to a colleague', { owner: true }, 'not_mine'],
  ])('a lead %s between the mover’s reads and its write stays as the person left it', async (_label, change, reason) => {
    const id = await lead('new');
    // The holder's own transaction holds the row; the mover parks on it, the person's write commits, and only
    // then does the mover read the row it locked. (The promise travels out in an object: returned bare, the
    // transaction would wait for the mover it is blocking.)
    const { mover } = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM leads WHERE id = ${id}::uuid FOR UPDATE`);
      const mover = moveLeadByMachine(id, 'ai_contacted', { holderId });
      await moverParked();
      await tx
        .update(leads)
        .set({
          ...('stageKey' in change ? { stageId: stageIds[change.stageKey] } : {}),
          ...('lostReason' in change ? { lostReason: change.lostReason } : {}),
          ...('owner' in change ? { ownerId: colleagueId } : {}),
        })
        .where(eq(leads.id, id));
      return { mover };
    });
    expect(await mover).toEqual({ moved: false, reason });
    const now = await stageOf(id);
    expect(now.s).toBe('stageKey' in change ? stageIds[change.stageKey] : stageIds.new);
    if ('lostReason' in change) expect(now.why).toBe(change.lostReason);
  });

  it('an «entered stage» rule with the owner as assignee fires on the machine’s move; «whoever did it» finds nobody', async () => {
    const id = await lead('new');
    const [owner, actor] = await db
      .insert(automationRules)
      .values([
        {
          name: `P2 egasi ${SUFFIX}`,
          triggerType: 'lead_stage',
          triggerStageId: stageIds.contacted,
          actionType: 'create_task',
          actionConfig: { title: `P2 vazifa egasiga ${SUFFIX}`, assignee: 'owner', dueDays: null, priority: 2 },
          createdBy: holderId,
        },
        {
          name: `P2 kim qilgan ${SUFFIX}`,
          triggerType: 'lead_stage',
          triggerStageId: stageIds.contacted,
          actionType: 'create_task',
          actionConfig: { title: `P2 vazifa qilganga ${SUFFIX}`, assignee: 'actor', dueDays: null, priority: 2 },
          createdBy: holderId,
        },
      ])
      .returning({ id: automationRules.id });
    madeRules.push(owner!.id, actor!.id);
    try {
      expect(await moveLeadByMachine(id, 'ai_contacted', { holderId })).toMatchObject({ moved: true });
      const [ev] = await db.select().from(events).where(and(eq(events.type, 'LeadStageChanged'), eq(events.entityId, id)));
      expect(await runAutomationRules({ type: ev!.type, payload: ev!.payload as Record<string, unknown>, entityType: ev!.entityType, entityId: ev!.entityId, actorId: ev!.actorId })).toBe(1);
      const made = await db.select({ title: tasks.title, assignee: tasks.assigneeId }).from(tasks).where(eq(tasks.entityId, id));
      expect(made).toEqual([{ title: `P2 vazifa egasiga ${SUFFIX}`, assignee: holderId }]);
    } finally {
      await db.update(events).set({ processedAt: new Date() }).where(eq(events.entityId, id));
      await db.update(automationRules).set({ active: false }).where(inArray(automationRules.id, [owner!.id, actor!.id]));
    }
  });
});
