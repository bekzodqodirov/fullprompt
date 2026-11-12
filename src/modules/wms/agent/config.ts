import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db, type Db, type Tx } from '../../platform/db/client';
import { agentAutoConfig, agentAutoVerdicts, agentConfig, agentDrafts, agentOutbox, tgAccounts, users } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { canLogInSql } from '../../platform/users/login';
import type { ForcedOffReason } from './forced-off';

/**
 * Whether the AI sotuvchi runs, from whose account, and who may say so.
 *
 * His answer 15 and review leak-5: a message leaves a personal account only by
 * its HOLDER. So switching the agent on is the holder's alone — the person
 * whose Telegram it will speak from — while «off» is open to the holder and to
 * any super_admin (an off switch must never wait for one person). Choosing
 * that account is a super_admin's, and only among people who hold a live
 * Telegram connection here.
 *
 * Phase 1 is SHADOW only (§17.1): every reply waits for his ✅. `auto` is in
 * the 0138 CHECK for the phase that earns it, and refused by every writer.
 */

export type AgentMode = 'off' | 'shadow';

export interface AgentConfig {
  mode: AgentMode;
  ownerUserId: string | null;
  sessionExclusiveAt: Date | null;
  humanPauseMin: number;
  dailyDraftCap: number;
  dailyTokenCap: number;
  startedAt: Date | null;
  styleGuide: string | null;
  styleGuideProposed: string | null;
  styleApprovedAt: Date | null;
  /** His avia rate, $/kg (§17.14, «kg uchun 17$»); null = avia is not quoted. */
  aviaUsdPerKg: number | null;
  aviaRateSetAt: Date | null;
  aviaRateSetBy: string | null;
  updatedAt: Date;
}

let ready = false;

/**
 * Does 0138 exist? Caches TRUE only (the `redeliveryReady` idiom): on deploy
 * morning the code is up before the migration lands, and every agent reader
 * asks this first so a «no» is today's behaviour, never a 42P01.
 */
export async function agentTablesReady(): Promise<boolean> {
  if (ready) return true;
  try {
    const rows = await db.execute<{ ok: boolean }>(sql`
      SELECT to_regclass('public.agent_config') IS NOT NULL
         AND to_regclass('public.agent_outbox') IS NOT NULL
         AND to_regclass('public.tg_account_guard') IS NOT NULL AS ok`);
    ready = rows[0]?.ok === true;
  } catch (err) {
    logger.warn({ err }, '[agent] tables not checked');
    return false;
  }
  return ready;
}

/** Tests: a server one migration behind, as far as this process knows. */
export function __forgetAgentReady(): void {
  ready = false;
}

let autoReady = false;
let autoBehind = false;

/**
 * Does 0145 exist — «o'zi yuborish» (docs/AI-SOTUVCHI.md §18.3)? Cached TRUE
 * only, like `agentTablesReady`. EVERY reader and writer of the auto layer
 * asks it first: one migration behind there are no verdict rows, every card is
 * the ordinary card, and the layer's doors answer «yangilanmagan».
 */
export async function agentAutoReady(): Promise<boolean> {
  if (autoBehind) return false;
  if (autoReady) return true;
  if (!(await agentTablesReady())) return false;
  try {
    const rows = await db.execute<{ ok: boolean }>(sql`
      SELECT to_regclass('public.agent_auto_config') IS NOT NULL
         AND to_regclass('public.agent_auto_verdicts') IS NOT NULL
         AND to_regclass('public.agent_auto_chats') IS NOT NULL AS ok`);
    autoReady = rows[0]?.ok === true;
  } catch (err) {
    logger.warn({ err }, '[agent] auto tables not checked');
    return false;
  }
  return autoReady;
}

/** Tests: forget the cached answer (and any pretence below). */
export function __forgetAgentAutoReady(): void {
  autoReady = false;
  autoBehind = false;
}

/**
 * Tests: a server one migration behind 0145 — the probe answers «no» until
 * forgotten. The other processes on the shared database still see the
 * tables; dropping them in a rolled-back transaction would hide them from
 * nobody but that one connection.
 */
export function __pretendAgentAutoBehind(): void {
  autoBehind = true;
  autoReady = false;
}

let fullP1Ready = false;
let fullP1Behind = false;

/**
 * Does 0146 exist — the full AI seller's part 1 (spec SPEC-P1-v2 §6)? Its two side tables, and the two widened
 * CHECKs of `agent_auto_config` (the categories admit `price`, `per_day` admits NULL): a server whose tables are
 * there but whose CHECKs are not would refuse the very writes this asks for. Cached TRUE only (the
 * `agentAutoReady` idiom). Every 0146 writer and reader asks it first: one migration behind, the caps read as
 * today's constants, a write of `price` or of no daily count is refused in words, and the prompt has no lessons.
 */
export async function agentFullP1Ready(): Promise<boolean> {
  if (fullP1Behind) return false;
  if (fullP1Ready) return true;
  if (!(await agentAutoReady())) return false;
  try {
    const rows = await db.execute<{ ok: boolean }>(sql`
      SELECT to_regclass('public.agent_lessons') IS NOT NULL
         AND to_regclass('public.agent_send_caps') IS NOT NULL
         AND coalesce((SELECT pg_get_constraintdef(oid) LIKE '%''price''%' FROM pg_constraint
                        WHERE conname = 'agent_auto_config_categories_check'
                          AND conrelid = 'public.agent_auto_config'::regclass), false)
         AND coalesce((SELECT pg_get_constraintdef(oid) LIKE '%IS NULL%' FROM pg_constraint
                        WHERE conname = 'agent_auto_config_day_check'
                          AND conrelid = 'public.agent_auto_config'::regclass), false) AS ok`);
    fullP1Ready = rows[0]?.ok === true;
  } catch (err) {
    logger.warn({ err }, '[agent] 0146 not checked');
    return false;
  }
  return fullP1Ready;
}

/** Tests: forget the cached answer (and any pretence below). */
export function __forgetAgentFullP1Ready(): void {
  fullP1Ready = false;
  fullP1Behind = false;
}

/**
 * Tests: a server one migration behind 0146 — the probe answers «no» until forgotten (the `__pretendAgentAutoBehind`
 * idiom: the shared database still has the tables for every other process).
 */
export function __pretendAgentFullP1Behind(): void {
  fullP1Behind = true;
  fullP1Ready = false;
}

/** Why the layer was disarmed — the person's press, the agent's «off», or a step-down (§18.3). */
export type AutoDisarmReason =
  | 'manual'
  | 'agent_off'
  | 'owner_changed'
  | 'feedback'
  | 'blocked'
  | 'bot_question'
  // The agent's account set back to «Shaxsiy raqam» (crm `setWorkAccount`, fix pass A, C5): arming needs «Ish raqami».
  | 'not_work_account'
  // The machine's own «off» (`forceAgentOff`), with WHY — each reason worded apart (forced-off, fix pass B, C10).
  | `forced: ${ForcedOffReason}`;

/** The `last_error` of a reply a disarm took back (card-io CANCEL_WORDS names it). */
export const AUTO_OFF_CANCEL = 'auto_off';

/**
 * The auto layer off, INSIDE the caller's transaction (§18.3: «off» disarms
 * the layer in the same transaction; re-arming is always his press): armed
 * no more, the reason and the moment stamped, and every reply still WAITING
 * its press — or CLAIMED by the sweep and not yet pressed — stopped (fix
 * pass A, C2/C5). That is safe because the machine's approval takes this row
 * FOR SHARE as its first statement and moves its verdict to 'pressed' as its
 * last (decide `auto`, auto-send `autoPressStandsInTx`/`settleAutoPressInTx`):
 * a disarm that locks the row first makes the press lose, and one that waits
 * on the press finds its verdict already 'pressed'.
 *
 * `takeBack`: also take back what the machine approved and has not yet sent
 * (outbox 'agent' under a 'pressed' verdict) — the person's «o‘chirish», a
 * step-down and «Shaxsiy raqam» mean «stop sending by yourself», and a reply
 * pressed a second before must not reach the customer after it. «Off» and a
 * forced off cancel EVERY waiting reply themselves, with their own reason.
 *
 * The caller asks `agentAutoReady()` BEFORE its transaction: a statement on a
 * missing table would abort it.
 */
export async function disarmAutoInTx(
  tx: Tx,
  reason: AutoDisarmReason,
  by: string | null,
  opts: { takeBack?: boolean } = {},
): Promise<{ wasArmed: boolean; stoppedDraftIds: string[]; takenBackDraftIds: string[] }> {
  const now = new Date();
  const was = await tx
    .update(agentAutoConfig)
    .set({ armedAt: null, armedBy: null, disarmedAt: now, disarmReason: reason.slice(0, 200), updatedAt: now })
    .where(and(eq(agentAutoConfig.id, 1), isNotNull(agentAutoConfig.armedAt)))
    .returning({ id: agentAutoConfig.id });
  const stopped = await tx
    .update(agentAutoVerdicts)
    .set({ state: 'stopped', outcome: 'disarmed', stoppedAt: now, stoppedBy: by })
    .where(inArray(agentAutoVerdicts.state, ['waiting', 'pressing']))
    .returning({ draftId: agentAutoVerdicts.draftId });
  let takenBack: string[] = [];
  if (opts.takeBack) {
    // The send step claims by 'agent' (outbox-store `claimAgentSend`): a row already 'sending' is in flight and goes.
    const rows = await tx
      .update(agentOutbox)
      .set({ status: 'cancelled', lastError: `${AUTO_OFF_CANCEL}: ${reason}`.slice(0, 500) })
      .where(
        and(
          eq(agentOutbox.status, 'agent'),
          sql`EXISTS (SELECT 1 FROM agent_auto_verdicts v WHERE v.draft_id = ${agentOutbox}.draft_id AND v.state = 'pressed')`,
        ),
      )
      .returning({ draftId: agentOutbox.draftId });
    takenBack = rows.map((r) => r.draftId);
  }
  return { wasArmed: was.length > 0, stoppedDraftIds: stopped.map((r) => r.draftId), takenBackDraftIds: takenBack };
}

function toConfig(row: typeof agentConfig.$inferSelect): AgentConfig {
  return {
    // A row someone set to 'auto' by hand is not a mode this phase runs.
    mode: row.mode === 'shadow' ? 'shadow' : 'off',
    ownerUserId: row.ownerUserId,
    sessionExclusiveAt: row.sessionExclusiveAt,
    humanPauseMin: row.humanPauseMin,
    dailyDraftCap: row.dailyDraftCap,
    dailyTokenCap: row.dailyTokenCap,
    startedAt: row.startedAt,
    styleGuide: row.styleGuide,
    styleGuideProposed: row.styleGuideProposed,
    styleApprovedAt: row.styleApprovedAt,
    // numeric comes back as text; the CHECK keeps it positive, finite, < 1 000.
    aviaUsdPerKg: row.aviaUsdPerKg === null ? null : Number(row.aviaUsdPerKg),
    aviaRateSetAt: row.aviaRateSetAt,
    aviaRateSetBy: row.aviaRateSetBy,
    updatedAt: row.updatedAt,
  };
}

/** The config, or null when 0138 has not landed. */
export async function readAgentConfig(handle: Db | Tx = db): Promise<AgentConfig | null> {
  if (!(await agentTablesReady())) return null;
  const [row] = await handle.select().from(agentConfig).where(eq(agentConfig.id, 1));
  return row ? toConfig(row) : null;
}

/** Is the agent drafting right now? */
export function agentRunning(config: AgentConfig | null): config is AgentConfig & { ownerUserId: string } {
  return config !== null && config.mode === 'shadow' && config.ownerUserId !== null && config.sessionExclusiveAt !== null;
}

/**
 * Who may open the agent's page, its commands and its settings (fit-11): the
 * configured owner, or anyone holding the super_admin ROLE (a role predicate,
 * not a permission — #170: a new code would not reach his customised roles).
 * Deciding a DRAFT asks more: the account holder alone (`decideDraft`).
 */
export function mayRunAgent(
  actor: { id: string; roles: readonly string[] },
  config: Pick<AgentConfig, 'ownerUserId'> | null,
): boolean {
  if (actor.roles.includes('super_admin')) return true;
  return config !== null && config.ownerUserId !== null && config.ownerUserId === actor.id;
}

export type AgentConfigRefusal =
  | 'not_ready'
  | 'forbidden'
  | 'not_account_holder'
  | 'auto_not_in_phase1'
  | 'no_owner'
  | 'session_not_confirmed'
  | 'owner_not_connected'
  | 'turn_off_first'
  | 'bad_value';

export class AgentConfigError extends Error {
  constructor(public readonly code: AgentConfigRefusal) {
    super(code);
  }
}

type AgentActor = { id: string; roles: readonly string[] };

async function lockConfig(tx: Tx): Promise<AgentConfig> {
  const [row] = await tx.select().from(agentConfig).where(eq(agentConfig.id, 1)).for('update');
  if (!row) throw new AgentConfigError('not_ready');
  return toConfig(row);
}

/** Does this user hold a Telegram connection here that is not signed out? */
async function ownerConnected(handle: Db | Tx, userId: string): Promise<boolean> {
  const [acc] = await handle
    .select({ status: tgAccounts.status, sessionEnc: tgAccounts.sessionEnc })
    .from(tgAccounts)
    .where(eq(tgAccounts.managerUserId, userId));
  return acc !== undefined && acc.status !== 'signed_out' && acc.sessionEnc !== null;
}

export interface ModeChange {
  config: AgentConfig;
  /** Pending/editing drafts retired by an «off» — their cards are the caller's to edit. */
  expiredDraftIds: string[];
  /** Approved replies that had not started sending, cancelled by an «off». */
  cancelledOutboxIds: string[];
}

/**
 * Switch the agent on (shadow) or off.
 *
 * «off» is the kill switch (map P12): the mode the pump reads every tick, plus
 * every approved reply that has not started sending cancelled and every live
 * draft expired, in ONE transaction — a press of «off» leaves nothing that a
 * later tick could still send.
 */
export async function setAgentMode(actor: AgentActor, mode: string, ctx: AuditContext): Promise<ModeChange> {
  if (mode === 'auto') throw new AgentConfigError('auto_not_in_phase1');
  if (mode !== 'off' && mode !== 'shadow') throw new AgentConfigError('bad_value');
  if (!(await agentTablesReady())) throw new AgentConfigError('not_ready');
  const pre = await readAgentConfig();
  if (!pre) throw new AgentConfigError('not_ready');
  if (mode === 'shadow') {
    if (!pre.ownerUserId) throw new AgentConfigError('no_owner');
    if (actor.id !== pre.ownerUserId) throw new AgentConfigError('not_account_holder');
    if (!pre.sessionExclusiveAt) throw new AgentConfigError('session_not_confirmed');
    if (!(await ownerConnected(db, pre.ownerUserId))) throw new AgentConfigError('owner_not_connected');
  } else if (!mayRunAgent(actor, pre)) {
    throw new AgentConfigError('forbidden');
  }
  // Read BEFORE the transaction: a statement on a missing table would abort it.
  const autoReady = mode === 'off' && (await agentAutoReady());

  return db.transaction(async (tx) => {
    const before = await lockConfig(tx);
    let expiredDraftIds: string[] = [];
    let cancelledOutboxIds: string[] = [];
    if (mode === 'off') {
      // «Off» disarms «o'zi yuborish» in the same transaction (§18.3); re-arming is always his press.
      if (autoReady) await disarmAutoInTx(tx, 'agent_off', actor.id);
      const cancelled = await tx
        .update(agentOutbox)
        .set({ status: 'cancelled', lastError: 'agent_off' })
        .where(eq(agentOutbox.status, 'agent'))
        .returning({ id: agentOutbox.id });
      cancelledOutboxIds = cancelled.map((r) => r.id);
      const expired = await tx
        .update(agentDrafts)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(inArray(agentDrafts.status, ['pending', 'editing']))
        .returning({ id: agentDrafts.id });
      expiredDraftIds = expired.map((r) => r.id);
    }
    const now = new Date();
    const [row] = await tx
      .update(agentConfig)
      .set({
        mode,
        updatedBy: actor.id,
        updatedAt: now,
        ...(mode === 'shadow' && !before.startedAt ? { startedAt: now } : {}),
      })
      .where(eq(agentConfig.id, 1))
      .returning();
    await writeAudit(tx, ctx, {
      entityType: 'agent_config',
      entityId: '00000000-0000-0000-0000-000000000136',
      action: 'update',
      before: { mode: before.mode },
      after: { mode, expired: expiredDraftIds.length, cancelled: cancelledOutboxIds.length },
    });
    return { config: toConfig(row!), expiredDraftIds, cancelledOutboxIds };
  });
}

/**
 * Whose account the agent speaks from — a super_admin's choice, among people
 * who can sign in and hold a live connection. Only while the agent is off: a
 * new owner is a new account, and the old one's confirmation does not carry
 * over (the session exclusivity is a fact about ONE session).
 */
export async function setAgentOwner(actor: AgentActor, userId: string | null, ctx: AuditContext): Promise<AgentConfig> {
  if (!actor.roles.includes('super_admin')) throw new AgentConfigError('forbidden');
  if (!(await agentTablesReady())) throw new AgentConfigError('not_ready');
  if (userId !== null) {
    const [u] = await db.select({ live: canLogInSql() }).from(users).where(eq(users.id, userId));
    if (!u?.live) throw new AgentConfigError('bad_value');
    if (!(await ownerConnected(db, userId))) throw new AgentConfigError('owner_not_connected');
  }
  const autoReady = await agentAutoReady();
  return db.transaction(async (tx) => {
    const before = await lockConfig(tx);
    if (before.mode !== 'off') throw new AgentConfigError('turn_off_first');
    const changed = before.ownerUserId !== userId;
    // A new account is a new person's name: whatever was armed was armed by the old holder (§18.3).
    if (autoReady) await disarmAutoInTx(tx, 'owner_changed', actor.id);
    const [row] = await tx
      .update(agentConfig)
      .set({
        ownerUserId: userId,
        ...(changed ? { sessionExclusiveAt: null, sessionExclusiveBy: null } : {}),
        updatedBy: actor.id,
        updatedAt: new Date(),
      })
      .where(eq(agentConfig.id, 1))
      .returning();
    await writeAudit(tx, ctx, {
      entityType: 'agent_config',
      entityId: '00000000-0000-0000-0000-000000000136',
      action: 'update',
      before: { ownerUserId: before.ownerUserId },
      after: { ownerUserId: userId },
    });
    return toConfig(row!);
  });
}

/**
 * «Eski serverda Telegram sessiyasi yo'q qilindi» (review ban-9, his Q1 ⭐).
 * The advisory lock that keeps a session to one process works per DATABASE,
 * and the rollback VPS has its own copy of the session and the key. Nothing
 * this release writes can reach that machine, so the agent cannot leave «off»
 * until the person responsible SAYS it is gone. The holder or a super_admin.
 */
export async function confirmSessionExclusive(actor: AgentActor, ctx: AuditContext): Promise<AgentConfig> {
  if (!(await agentTablesReady())) throw new AgentConfigError('not_ready');
  return db.transaction(async (tx) => {
    const before = await lockConfig(tx);
    if (!before.ownerUserId) throw new AgentConfigError('no_owner');
    if (!mayRunAgent(actor, before)) throw new AgentConfigError('forbidden');
    const now = new Date();
    const [row] = await tx
      .update(agentConfig)
      .set({ sessionExclusiveAt: now, sessionExclusiveBy: actor.id, updatedBy: actor.id, updatedAt: now })
      .where(eq(agentConfig.id, 1))
      .returning();
    await writeAudit(tx, ctx, {
      entityType: 'agent_config',
      entityId: '00000000-0000-0000-0000-000000000136',
      action: 'update',
      before: { sessionExclusiveAt: before.sessionExclusiveAt?.toISOString() ?? null },
      after: { sessionExclusiveAt: now.toISOString() },
    });
    return toConfig(row!);
  });
}

/** The numbers on /suhbatlar/ai — the holder or a super_admin; each bounded by the 0138 CHECKs. */
export async function setAgentNumbers(
  actor: AgentActor,
  values: { humanPauseMin?: number; dailyDraftCap?: number; dailyTokenCap?: number },
  ctx: AuditContext,
): Promise<AgentConfig> {
  const bad = (n: number | undefined, lo: number, hi: number) =>
    n !== undefined && (!Number.isInteger(n) || n < lo || n > hi);
  if (bad(values.humanPauseMin, 1, 10_080) || bad(values.dailyDraftCap, 0, 1_000) || bad(values.dailyTokenCap, 0, 50_000_000)) {
    throw new AgentConfigError('bad_value');
  }
  if (!(await agentTablesReady())) throw new AgentConfigError('not_ready');
  return db.transaction(async (tx) => {
    const before = await lockConfig(tx);
    if (!mayRunAgent(actor, before)) throw new AgentConfigError('forbidden');
    const [row] = await tx
      .update(agentConfig)
      .set({ ...values, updatedBy: actor.id, updatedAt: new Date() })
      .where(eq(agentConfig.id, 1))
      .returning();
    await writeAudit(tx, ctx, {
      entityType: 'agent_config',
      entityId: '00000000-0000-0000-0000-000000000136',
      action: 'update',
      before: { humanPauseMin: before.humanPauseMin, dailyDraftCap: before.dailyDraftCap, dailyTokenCap: before.dailyTokenCap },
      after: values,
    });
    return toConfig(row!);
  });
}

/**
 * The avia rate's label among a draft's stored number sources (tools.ts
 * `avia`) — how a new rate finds the live drafts quoted at the old one. Here,
 * beside the rate, so the writer and the reader name one word.
 */
export const AVIA_RATE_LABEL = 'avia tarifi';

/**
 * His avia rate on /suhbatlar/ai (§17.14: «Avia hozir kg uchun 17$ dan») — the
 * one money figure the agent multiplies that is not the website's table. The
 * same door as the numbers: the configured owner or the super_admin role.
 * Null = avia is not quoted (the tool refuses and the model asks him). A rate
 * with more than cents is refused, never rounded: numeric(10,2) would round
 * it silently into a figure nobody typed. Stamped and audited.
 *
 * A pending draft quoted at another rate stops being sendable in the same
 * transaction (review A3): ✅ re-runs the policy over the draft's STORED
 * sources, which still carry the old rate and the old total, so without this
 * yesterday's figure would pass G1 and leave. It is retired — `superseded`,
 * `policy.stale = 'avia_rate'` — and its card says why. A draft he is
 * rewriting himself ('editing') is his words and is left alone; one he already
 * approved was his decision on the figure the card showed.
 */
export async function setAviaRate(actor: AgentActor, value: number | null, ctx: AuditContext): Promise<AgentConfig> {
  if (value !== null) {
    if (!Number.isFinite(value) || !(value > 0) || !(value < 1000)) throw new AgentConfigError('bad_value');
    if (Math.abs(Math.round(value * 100) - value * 100) > 1e-6) throw new AgentConfigError('bad_value');
  }
  if (!(await agentTablesReady())) throw new AgentConfigError('not_ready');
  const out = await db.transaction(async (tx) => {
    const before = await lockConfig(tx);
    if (!mayRunAgent(actor, before)) throw new AgentConfigError('forbidden');
    const now = new Date();
    const [row] = await tx
      .update(agentConfig)
      .set({
        aviaUsdPerKg: value === null ? null : value.toFixed(2),
        aviaRateSetAt: now,
        aviaRateSetBy: actor.id,
        updatedBy: actor.id,
        updatedAt: now,
      })
      .where(eq(agentConfig.id, 1))
      .returning();
    await writeAudit(tx, ctx, {
      entityType: 'agent_config',
      entityId: '00000000-0000-0000-0000-000000000136',
      action: 'update',
      before: { aviaUsdPerKg: before.aviaUsdPerKg },
      after: { aviaUsdPerKg: value },
    });
    // jsonpath, so a draft whose policy has no sources array is simply not one.
    const quoted = sql`jsonb_path_exists(${agentDrafts.policy}, '$.memory.sources[*] ? (@.label == $l && (!($v.type() == "number") || @.value != $v))', ${JSON.stringify({ l: AVIA_RATE_LABEL, v: value })}::jsonb)`;
    const stale = await tx
      .update(agentDrafts)
      .set({ status: 'superseded', policy: sql`${agentDrafts.policy} || ${JSON.stringify({ stale: 'avia_rate' })}::jsonb`, updatedAt: now })
      .where(and(eq(agentDrafts.status, 'pending'), quoted))
      .returning({ id: agentDrafts.id });
    return { config: toConfig(row!), stale: stale.map((r) => r.id) };
  });
  for (const id of out.stale) {
    const { refreshAgentCard } = await import('./card-io');
    await refreshAgentCard(id).catch((err: unknown) => logger.warn({ err, draftId: id }, '[agent] card not refreshed'));
  }
  return out.config;
}

/**
 * Tests: put the singleton back the way a file found it (#183 — a
 * configuration row is the next file's input on the one shared database).
 */
export async function __restoreAgentConfig(snapshot: AgentConfig | null): Promise<void> {
  if (!snapshot) return;
  await db
    .update(agentConfig)
    .set({
      mode: snapshot.mode,
      ownerUserId: snapshot.ownerUserId,
      sessionExclusiveAt: snapshot.sessionExclusiveAt,
      sessionExclusiveBy: snapshot.sessionExclusiveAt ? snapshot.ownerUserId : null,
      humanPauseMin: snapshot.humanPauseMin,
      dailyDraftCap: snapshot.dailyDraftCap,
      dailyTokenCap: snapshot.dailyTokenCap,
      startedAt: snapshot.startedAt,
      styleGuide: snapshot.styleGuide,
      styleGuideProposed: snapshot.styleGuideProposed,
      styleApprovedAt: snapshot.styleApprovedAt,
      styleApprovedBy: snapshot.styleApprovedAt ? snapshot.ownerUserId : null,
      aviaUsdPerKg: snapshot.aviaUsdPerKg === null ? null : snapshot.aviaUsdPerKg.toFixed(2),
      aviaRateSetAt: snapshot.aviaRateSetAt,
      aviaRateSetBy: snapshot.aviaRateSetBy,
    })
    .where(eq(agentConfig.id, 1));
}

/**
 * The machine's own «off» (review ban-2, ban-10, map P13): a restriction, a
 * second send-path flood in a day, two blocks in a week. Same effect as the
 * kill switch — no approved reply left to send, no live draft — written with
 * no actor, because nobody pressed anything. Returns null when the agent was
 * already off (the alarm is sent once, by the call that switched it). The
 * reason is one of a closed list (forced-off `ForcedOffReason`): «o'zi
 * yuborish» stores it as its last «off», and each is said as itself.
 */
export async function forceAgentOff(reason: ForcedOffReason): Promise<ModeChange | null> {
  if (!(await agentTablesReady())) return null;
  const autoReady = await agentAutoReady();
  return db.transaction(async (tx) => {
    const before = await lockConfig(tx);
    if (before.mode === 'off') return null;
    if (autoReady) await disarmAutoInTx(tx, `forced: ${reason}`, null);
    const cancelled = await tx
      .update(agentOutbox)
      .set({ status: 'cancelled', lastError: `agent_off: ${reason}`.slice(0, 500) })
      .where(eq(agentOutbox.status, 'agent'))
      .returning({ id: agentOutbox.id });
    const expired = await tx
      .update(agentDrafts)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(inArray(agentDrafts.status, ['pending', 'editing']))
      .returning({ id: agentDrafts.id });
    const [row] = await tx
      .update(agentConfig)
      .set({ mode: 'off', updatedBy: null, updatedAt: new Date() })
      .where(eq(agentConfig.id, 1))
      .returning();
    await writeAudit(tx, { actorId: null }, {
      entityType: 'agent_config',
      entityId: '00000000-0000-0000-0000-000000000136',
      action: 'update',
      before: { mode: before.mode },
      after: { mode: 'off', reason, expired: expired.length, cancelled: cancelled.length },
    });
    return {
      config: toConfig(row!),
      expiredDraftIds: expired.map((r) => r.id),
      cancelledOutboxIds: cancelled.map((r) => r.id),
    };
  });
}
