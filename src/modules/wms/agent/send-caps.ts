import { eq } from 'drizzle-orm';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db, type Db, type Tx } from '../../platform/db/client';
import { agentSendCaps } from '../../platform/db/schema';
import type { AutoConfigRefusal } from './auto-send';
import { agentFullP1Ready, mayRunAgent, readAgentConfig } from './config';
import { AGENT_LIMITS, HUMAN_LIMITS } from './limits';

/**
 * The account-protection limits he may edit (spec SPEC-P1-v2 §5.2, his «4
 * hozircha qolsin keyinchalik ozgartiirish imkoni kerak boladi»): the agent's
 * day ceiling and its hour cap. ONE home for the number every reader uses —
 * the ✅'s budget (decide `budgetLeft`), the gate's `budget_spent` (auto-send
 * `autoFactsFor`), the send step (outbox-store `sendFactsFor`) and the page
 * (web-page `agentToday`) — so the four can never count a different day.
 *
 * Stored on a SIDE table (0148 `agent_send_caps`), never a column of
 * agent_config: `readAgentConfig` selects every declared column behind a probe
 * that answers TRUE one migration behind, and a new one would be a 42703 in
 * every reader — the listener's send step among them. A missing table or row,
 * or a NULL, is today's constant. The 14-day ramp and the per-chat gap stay
 * constants (stated).
 */

/**
 * The bounds a typed cap keeps — the human queue's own (crm/telegram-send `DEFAULT_LIMITS`): 200 a day, and an
 * hour no faster than its minute (12 × 60) and never above 100. The agent may never be the reason the account
 * hits a ceiling the human bridge respects; `tests/unit/agent-send-step.test.ts` holds these against
 * `HUMAN_LIMITS` and against 0148's CHECKs.
 */
export const SEND_CAP_BOUNDS = {
  day: { min: 1, max: HUMAN_LIMITS.perDay },
  hour: { min: 1, max: Math.min(100, HUMAN_LIMITS.perMinute * 60) },
} as const;

export interface SendCaps {
  /** The day ceiling every reader uses — the stored one, else `AGENT_LIMITS.perDay`. */
  dayCap: number;
  /** The hour cap the send step uses — the stored one, else `AGENT_LIMITS.perHour`. */
  hourCap: number;
  /** As stored: null = today's constant (the page says which). */
  stored: { dayCap: number | null; hourCap: number | null };
  /** His ✅ on the China tariff as it stands (§1.6); null = never. */
  tariffConfirmedAt: Date | null;
  /** 0148 has landed — the page offers the form only then. */
  ready: boolean;
}

/** Today's constants — what every reader gets one migration behind, or with no row. */
export const DEFAULT_SEND_CAPS: SendCaps = {
  dayCap: AGENT_LIMITS.perDay,
  hourCap: AGENT_LIMITS.perHour,
  stored: { dayCap: null, hourCap: null },
  tariffConfirmedAt: null,
  ready: false,
};

/** The caps as they stand. Never throws on a server one migration behind: the probe is asked first. */
export async function readSendCaps(handle: Db | Tx = db): Promise<SendCaps> {
  if (!(await agentFullP1Ready())) return DEFAULT_SEND_CAPS;
  const [row] = await handle.select().from(agentSendCaps).where(eq(agentSendCaps.id, 1));
  return {
    dayCap: row?.dayCap ?? AGENT_LIMITS.perDay,
    hourCap: row?.hourCap ?? AGENT_LIMITS.perHour,
    stored: { dayCap: row?.dayCap ?? null, hourCap: row?.hourCap ?? null },
    tariffConfirmedAt: row?.tariffConfirmedAt ?? null,
    ready: true,
  };
}

/**
 * A refusal of the caps' door — the arming doors' own codes and words (auto-send `AUTO_CONFIG_WORDS`), so the page
 * says it as it says theirs. Its own class, not `AutoConfigError`: the listener reads this module, and importing
 * the auto layer's would pull the whole press into it.
 */
export class SendCapsError extends Error {
  constructor(public readonly code: Extract<AutoConfigRefusal, 'not_ready' | 'forbidden' | 'bad_value'>) {
    super(code);
  }
}

const within = (v: number | null, b: { min: number; max: number }) => v === null || (Number.isInteger(v) && v >= b.min && v <= b.max);

/**
 * His caps, typed on the page — the holder's or a super_admin's (`mayRunAgent`: an off switch never waits for one
 * person, and a cap is a brake). A whole number within `SEND_CAP_BOUNDS`, or null for today's constant. Audited.
 * One migration behind: refused in words.
 */
export async function setSendCaps(
  actor: { id: string; roles: readonly string[] },
  caps: { dayCap: number | null; hourCap: number | null },
  ctx: AuditContext,
): Promise<SendCaps> {
  if (!within(caps.dayCap, SEND_CAP_BOUNDS.day) || !within(caps.hourCap, SEND_CAP_BOUNDS.hour)) throw new SendCapsError('bad_value');
  if (!(await agentFullP1Ready())) throw new SendCapsError('not_ready');
  if (!mayRunAgent(actor, await readAgentConfig())) throw new SendCapsError('forbidden');
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(agentSendCaps).where(eq(agentSendCaps.id, 1)).for('update');
    if (before) {
      await tx
        .update(agentSendCaps)
        .set({ dayCap: caps.dayCap, hourCap: caps.hourCap, updatedAt: new Date(), updatedBy: actor.id })
        .where(eq(agentSendCaps.id, 1));
    } else {
      await tx.insert(agentSendCaps).values({ id: 1, dayCap: caps.dayCap, hourCap: caps.hourCap, updatedBy: actor.id });
    }
    await writeAudit(tx, ctx, {
      entityType: 'agent_send_caps',
      entityId: SEND_CAPS_AUDIT_ID,
      action: 'update',
      before: { dayCap: before?.dayCap ?? null, hourCap: before?.hourCap ?? null },
      after: { dayCap: caps.dayCap, hourCap: caps.hourCap },
    });
  });
  return readSendCaps();
}

/** The singleton's audit entity id (audit_log.entity_id is a uuid) — beside the auto layer's …143. */
export const SEND_CAPS_AUDIT_ID = '00000000-0000-0000-0000-000000000146';

/** Tests: the caps back as a file found them (#183 — a configuration row is the next file's input). */
export async function __restoreSendCaps(snapshot: SendCaps): Promise<void> {
  if (!snapshot.ready) return;
  await db
    .update(agentSendCaps)
    .set({ dayCap: snapshot.stored.dayCap, hourCap: snapshot.stored.hourCap, tariffConfirmedAt: snapshot.tariffConfirmedAt })
    .where(eq(agentSendCaps.id, 1));
}
