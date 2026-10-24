import { eq, inArray, sql } from 'drizzle-orm';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db, type Db, type Tx } from '../../platform/db/client';
import { agentConfig, agentDrafts, agentOutbox, tgAccounts, users } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { canLogIn } from '../../platform/users/login';

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
 * the 0136 CHECK for the phase that earns it, and refused by every writer.
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
  updatedAt: Date;
}

let ready = false;

/**
 * Does 0136 exist? Caches TRUE only (the `redeliveryReady` idiom): on deploy
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
    updatedAt: row.updatedAt,
  };
}

/** The config, or null when 0136 has not landed. */
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

  return db.transaction(async (tx) => {
    const before = await lockConfig(tx);
    let expiredDraftIds: string[] = [];
    let cancelledOutboxIds: string[] = [];
    if (mode === 'off') {
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
    const [u] = await db
      .select({ active: users.active, loginEnabled: users.loginEnabled })
      .from(users)
      .where(eq(users.id, userId));
    if (!u || !canLogIn(u)) throw new AgentConfigError('bad_value');
    if (!(await ownerConnected(db, userId))) throw new AgentConfigError('owner_not_connected');
  }
  return db.transaction(async (tx) => {
    const before = await lockConfig(tx);
    if (before.mode !== 'off') throw new AgentConfigError('turn_off_first');
    const changed = before.ownerUserId !== userId;
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

/** The numbers on /suhbatlar/ai — the holder or a super_admin; each bounded by the 0136 CHECKs. */
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
    })
    .where(eq(agentConfig.id, 1));
}

/**
 * The machine's own «off» (review ban-2, ban-10, map P13): a restriction, a
 * second send-path flood in a day, two blocks in a week. Same effect as the
 * kill switch — no approved reply left to send, no live draft — written with
 * no actor, because nobody pressed anything. Returns null when the agent was
 * already off (the alarm is sent once, by the call that switched it).
 */
export async function forceAgentOff(reason: string): Promise<ModeChange | null> {
  if (!(await agentTablesReady())) return null;
  return db.transaction(async (tx) => {
    const before = await lockConfig(tx);
    if (before.mode === 'off') return null;
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
