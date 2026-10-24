import { and, count, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db, type Db, type Tx } from '../../platform/db/client';
import { tgAccountFloods, tgAccountGuard, tgAccounts } from '../../platform/db/schema';
import { agentTablesReady } from '../agent/config';
import { floodEnds, type PauseKind } from './telegram-guard';

/**
 * The account's guard row (0136): its pause, the wait Telegram ordered, and
 * the stamps a current listener writes. Every connected account has one the
 * first time anything is written; no row reads as «nothing wrong».
 *
 * Every reader asks `agentTablesReady()` first — a listener one migration
 * ahead of its database runs today's paths untouched (regression-3 b).
 */

export interface GuardState {
  pausedAt: Date | null;
  pausedKind: PauseKind | null;
  pauseReason: string | null;
  floodUntil: Date | null;
  agentPumpAt: Date | null;
  caughtUpAt: Date | null;
}

const EMPTY: GuardState = {
  pausedAt: null,
  pausedKind: null,
  pauseReason: null,
  floodUntil: null,
  agentPumpAt: null,
  caughtUpAt: null,
};

export async function readGuard(accountId: string, handle: Db | Tx = db): Promise<GuardState> {
  if (!(await agentTablesReady())) return EMPTY;
  const [row] = await handle.select().from(tgAccountGuard).where(eq(tgAccountGuard.accountId, accountId));
  if (!row) return EMPTY;
  return {
    pausedAt: row.pausedAt,
    pausedKind: (row.pausedKind as PauseKind | null) ?? null,
    pauseReason: row.pauseReason,
    floodUntil: row.floodUntil,
    agentPumpAt: row.agentPumpAt,
    caughtUpAt: row.caughtUpAt,
  };
}

/**
 * Pause the account. The FIRST pause stands (a second error does not move the
 * time or rewrite the reason the person will read); returns true when this
 * call is the one that paused it — the alarm is sent once.
 */
export async function pauseAccount(accountId: string, kind: PauseKind, reason: string): Promise<boolean> {
  if (!(await agentTablesReady())) return false;
  const rows = await db.execute<{ fresh: boolean }>(sql`
    INSERT INTO tg_account_guard (account_id, paused_at, paused_kind, pause_reason, updated_at)
    VALUES (${accountId}, now(), ${kind}, ${reason.slice(0, 500)}, now())
    ON CONFLICT (account_id) DO UPDATE
      SET paused_at = now(), paused_kind = EXCLUDED.paused_kind, pause_reason = EXCLUDED.pause_reason, updated_at = now()
      WHERE tg_account_guard.paused_at IS NULL
    RETURNING true AS fresh`);
  return rows.length > 0;
}

/**
 * A flood wait: always a ledger row; a RAISED one (gramjs did not sleep
 * through it) also moves `flood_until`, uncapped — the wait is Telegram's
 * terms of keeping the account, and `MAX_FLOOD_WAIT_S` shortening it was a
 * finding (map §3). Never earlier than a wait already in force.
 */
export async function recordFlood(input: {
  accountId: string;
  method: string;
  seconds: number;
  source: 'sleep' | 'raise';
  now?: Date;
}): Promise<void> {
  if (!(await agentTablesReady())) return;
  const now = input.now ?? new Date();
  await db.insert(tgAccountFloods).values({
    accountId: input.accountId,
    method: input.method.slice(0, 120),
    seconds: Math.max(0, Math.round(input.seconds)),
    source: input.source,
    at: now,
  });
  if (input.source === 'raise') {
    const until = floodEnds(input.seconds, now).toISOString();
    await db.execute(sql`
      INSERT INTO tg_account_guard (account_id, flood_until, updated_at)
      VALUES (${input.accountId}, ${until}::timestamptz, now())
      ON CONFLICT (account_id) DO UPDATE
        SET flood_until = GREATEST(coalesce(tg_account_guard.flood_until, EXCLUDED.flood_until), EXCLUDED.flood_until),
            updated_at = now()`);
  }
}

/** Floods on the SEND path in a window — «two in 24 h» switches the agent off (ban-2). */
export async function sendFloodsSince(accountId: string, since: Date): Promise<number> {
  if (!(await agentTablesReady())) return 0;
  const [row] = await db
    .select({ n: count() })
    .from(tgAccountFloods)
    .where(
      and(
        eq(tgAccountFloods.accountId, accountId),
        gte(tgAccountFloods.at, since),
        sql`${tgAccountFloods.method} IN ('messages.SendMessage', 'SendMessage', 'messages.SendMedia', 'sendMessage', 'sendFile')`,
      ),
    );
  return Number(row?.n ?? 0);
}

/** The listener's tick: «a pump that knows agent_outbox is running here», and whether its start-up catch-up is done. */
export async function stampAgentPump(accountId: string, caughtUp: boolean): Promise<void> {
  if (!(await agentTablesReady())) return;
  await db.execute(sql`
    INSERT INTO tg_account_guard (account_id, agent_pump_at, caught_up_at, updated_at)
    VALUES (${accountId}, now(), ${caughtUp ? sql`now()` : sql`NULL`}, now())
    ON CONFLICT (account_id) DO UPDATE
      SET agent_pump_at = now(),
          caught_up_at = CASE WHEN ${caughtUp} THEN coalesce(tg_account_guard.caught_up_at, now()) ELSE NULL END,
          updated_at = now()`);
}

/** The guard of the account a USER holds — what the web and the bot read. */
export async function guardForUser(userId: string): Promise<(GuardState & { accountId: string }) | null> {
  if (!(await agentTablesReady())) return null;
  const [acc] = await db.select({ id: tgAccounts.id }).from(tgAccounts).where(eq(tgAccounts.managerUserId, userId));
  if (!acc) return null;
  return { accountId: acc.id, ...(await readGuard(acc.id)) };
}

export type ClearRefusal = 'forbidden' | 'not_paused' | 'not_ready';
export class GuardError extends Error {
  constructor(public readonly code: ClearRefusal) {
    super(code);
  }
}

/**
 * «Tekshirdim, qayta yoqish» (regression-11, his Q13 ⭐): the account's own
 * manager or a super_admin. Clears the pause only — the flood wait Telegram
 * ordered is not ours to shorten.
 */
export async function clearAccountPause(
  actor: { id: string; roles: readonly string[] },
  accountId: string,
  ctx: AuditContext,
): Promise<void> {
  if (!(await agentTablesReady())) throw new GuardError('not_ready');
  const [acc] = await db
    .select({ managerUserId: tgAccounts.managerUserId })
    .from(tgAccounts)
    .where(eq(tgAccounts.id, accountId));
  if (!acc || (acc.managerUserId !== actor.id && !actor.roles.includes('super_admin'))) {
    throw new GuardError('forbidden');
  }
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(tgAccountGuard)
      .set({ pausedAt: null, pausedKind: null, clearedAt: new Date(), clearedBy: actor.id, updatedAt: new Date() })
      .where(and(eq(tgAccountGuard.accountId, accountId), isNotNull(tgAccountGuard.pausedAt)))
      .returning({ reason: tgAccountGuard.pauseReason });
    if (!row) throw new GuardError('not_paused');
    await writeAudit(tx, ctx, {
      entityType: 'tg_account',
      entityId: accountId,
      action: 'update',
      before: { paused: true, reason: row.reason },
      after: { paused: false },
    });
  });
}
