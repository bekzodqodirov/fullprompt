import { sql } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { agentSignals } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { kickTelegramDrain, queueStaffTelegram } from '../../platform/notifications/staff';
import { quietHour } from '../../platform/telegram/send';
import { tashkentDay, tashkentDayStart, tashkentMinute } from '../../platform/time/tashkent';
import { agentOffWords } from '../crm/account-alarm';
import { AGENT_CONFIG_AUDIT_ID, agentToliq1aReady, type AgentConfig } from './config';
import { designated } from './designations';
import { isForcedOffReason, type ForcedOffReason } from './forced-off';
import { unansweredLines } from './liveness';
import { agentPageReaders, agentPageUrl } from './signals';

/**
 * «AI o'zi o'chib qolsa va siz qayta yoqmasangiz: har kuni 08:40 da va ish vaqtida har 2 soatda sizga bitta eslatma
 * keladi: «AI o'chiq turibdi — sabab: …, N ta mijoz javobsiz»» (his 18 a, binding). The machine's own «off»
 * (`forceAgentOff`) is said ONCE, at the moment (crm account-alarm); on 2026-11-19 that one line was all there was,
 * and the AI stayed off for two and a half days after two of his own sign-ins read as notices. So while the agent
 * stays off BY THE MACHINE, the «rahbar va o‘rinbosar» pair is reminded on a fixed grid until somebody switches it
 * on — and never when a person switched it off himself (he knows; it is his decision).
 *
 * The grid is the morning line's minute and every two hours after it until the night: 08:40, 10:40, 12:40, 14:40,
 * 16:40, 18:40, 20:40 Tashkent, every day. No clock of its own: the first slot is the morning line's
 * (`JOB_AGENT_MORNING`, 08:40), and «ish vaqti» ends where the house's one night clock begins (`quietHour`, 22:00 —
 * the very clock that closes the office day of `isOfficeTime`, platform/time/office-hours, whose 09:00 opening the
 * 08:40 slot precedes by its own right). His 1b answer 11 a (Monday-Saturday 09:00-19:00 for the cards to people) is
 * a setting stage 1B builds; the day it exists, this grid asks it.
 *
 * A slot is said once (the claim is an `agent_signals` row, unique `dedupe_key` — the stage's «said once» table,
 * 0151), and only a slot that BEGAN after the off: the alarm itself has just said it. The claim and the copies are
 * written in ONE transaction (`sendSignal`'s shape: no claim without its copies, no copy without its claim); the
 * Telegram send is the drain's, after the commit, never inside it.
 */

/** The morning line's minute of the Tashkent day — the grid's first slot. */
export const OFF_REMINDER_FIRST_MINUTE = 8 * 60 + 40;
/** «har 2 soatda». */
export const OFF_REMINDER_STEP_MINUTES = 120;

/** The claim's topic in `agent_signals` — not a chat's: the row names no chat (peer 0, which no chat is). */
export const OFF_REMINDER_TOPIC = 'forced_off';

export interface OffReminderSlot {
  /** `agent:forced_off:<Tashkent day>:<HHMM>` — once per slot, ever. */
  key: string;
  startsAt: Date;
}

/**
 * Pure: the slot `now` stands in, or null — at night (`quietHour`) and before 08:40. A slot stays current until the
 * next one begins (or the night), so a sweep that was down at 10:40 still says it at 11:30.
 */
export function offReminderSlot(now: Date): OffReminderSlot | null {
  if (quietHour(now)) return null;
  const day = tashkentDay(now);
  const dayStart = tashkentDayStart(day).getTime();
  const minute = Math.floor((now.getTime() - dayStart) / 60_000);
  if (minute < OFF_REMINDER_FIRST_MINUTE) return null;
  const k = Math.floor((minute - OFF_REMINDER_FIRST_MINUTE) / OFF_REMINDER_STEP_MINUTES);
  const slotMinute = OFF_REMINDER_FIRST_MINUTE + k * OFF_REMINDER_STEP_MINUTES;
  const startsAt = new Date(dayStart + slotMinute * 60_000);
  const hhmm = `${String(Math.floor(slotMinute / 60)).padStart(2, '0')}${String(slotMinute % 60).padStart(2, '0')}`;
  return { key: `agent:forced_off:${day}:${hhmm}`, startsAt };
}

/** The machine's last «off», as the audit wrote it. */
export interface ForcedOff {
  reason: ForcedOffReason;
  at: Date;
}

/**
 * Is the agent's last switch the MACHINE's? The newest audit row of the agent's config that wrote a mode
 * (`setAgentMode` — a person's press, on or off, even one that found it off already — and `forceAgentOff`): a forced
 * off when that row switched to «off» with a reason of the closed list and no actor (`forceAgentOff` writes both,
 * nobody pressed anything), else null — a person's off, a switch on, or no row at all. A person who presses «off» on
 * an agent the machine stopped has looked: the reminders end there. The config's own `mode` is the caller's to ask
 * (the audit is the history; the row is the truth). One indexed read (`audit_entity_idx`); `on` is for the test's
 * rolled-back transaction — the audit trail takes no DELETE.
 */
export async function agentForcedOff(on: Db | Tx = db): Promise<ForcedOff | null> {
  const [row] = await on.execute<{ mode: string | null; reason: string | null; actor: string | null; at_ms: number }>(sql`
    SELECT after->>'mode' AS mode, after->>'reason' AS reason, actor_id::text AS actor,
           (extract(epoch FROM created_at) * 1000)::float8 AS at_ms
      FROM audit_log
     WHERE entity_type = 'agent_config' AND entity_id = ${AGENT_CONFIG_AUDIT_ID}::uuid
       AND after->>'mode' IS NOT NULL
     ORDER BY created_at DESC, id DESC
     LIMIT 1`);
  if (!row || row.mode !== 'off' || row.actor !== null || !row.reason || !isForcedOffReason(row.reason)) return null;
  return { reason: row.reason, at: new Date(Number(row.at_ms)) };
}

/** `dd.mm HH:MM` on Tashkent's wall clock. */
function sinceText(at: Date): string {
  const t = tashkentMinute(at);
  return `${t.slice(8, 10)}.${t.slice(5, 7)} ${t.slice(11, 16)}`;
}

/**
 * Pure: the reminder as one recipient reads it — counts only, never a customer (leak-13). «Qayta yoqish» and the
 * page's link only for a recipient the page admits (J17: a line that sends somebody to a door goes only to those it
 * opens for).
 */
export function offReminderText(input: { reason: ForcedOffReason; at: Date; waiting: number }, withPage: boolean): string {
  const lines = [
    `⚠️ AI sotuvchi o‘chiq turibdi — sabab: ${agentOffWords(input.reason)}, ${sinceText(input.at)} dan beri.`,
    `Javobsiz mijozlar: ${input.waiting}.`,
  ];
  if (withPage) lines.push('Qayta yoqish: «Suhbatlar → AI sotuvchi».', agentPageUrl());
  return lines.join('\n');
}

/**
 * The suites' switch (`AGENT_OFF_REMINDER=off`, set by vitest.config and the Playwright server's env — the
 * `AGENT_LIVENESS` precedent): any sweep of a test that leaves the agent forced off would claim the slot of the real
 * clock's hour and queue a copy to whoever the designations name. Off, the step does nothing. The reminder's own
 * tests switch it on.
 */
export function offReminderOn(): boolean {
  return process.env.AGENT_OFF_REMINDER !== 'off';
}

export type OffReminderOutcome = 'said' | 'already' | 'not_due' | 'unheard' | 'behind';

/**
 * The sweep's step while the agent does NOT run (`agentSweep`). `off` is REQUIRED — the caller reads it
 * (`agentForcedOff`), null = not the machine's off. Nothing unless the config says «off», an account holder is
 * set, and the current slot began after the off. Who is told: the «rahbar va o‘rinbosar» pair through
 * `designated('supervisor')` and its fallback chain (never «nobody»), read before the transaction (#714). «Javobsiz
 * mijozlar» is the liveness reader's own notion of waiting (`unansweredLines`: a card-bound chat whose newest live
 * line is the customer's and that nothing answered and nothing will) over the lines written since the off — the AI
 * writes no run while off, so each such line counts. A copy that reaches nobody rolls the claim back ('unheard'):
 * the next minute of the same slot tries again. One migration behind 0151 there is no claim table: 'behind'.
 */
export async function sweepOffReminder(
  config: Pick<AgentConfig, 'mode' | 'ownerUserId'> | null,
  now: Date,
  off: ForcedOff | null,
): Promise<OffReminderOutcome> {
  if (!offReminderOn() || !config || config.mode !== 'off' || !config.ownerUserId || !off) return 'not_due';
  const slot = offReminderSlot(now);
  if (!slot || slot.startsAt.getTime() <= off.at.getTime()) return 'not_due';
  if (!(await agentToliq1aReady())) return 'behind';
  const holderId = config.ownerUserId;
  const waiting = (await unansweredLines(holderId, { from: off.at, to: now, workingHours: false }, now)).length;
  const recipients = await designated('supervisor');
  const readers = await agentPageReaders(recipients, config);
  const copies = recipients.map((userId) => ({
    userId,
    text: offReminderText({ reason: off.reason, at: off.at, waiting }, readers.has(userId)),
  }));
  class Unheard extends Error {}
  let outcome: OffReminderOutcome;
  try {
    outcome = await db.transaction(async (tx) => {
      const claim = await tx
        .insert(agentSignals)
        .values({
          topic: OFF_REMINDER_TOPIC,
          managerUserId: holderId,
          peerId: 0n,
          leadId: null,
          clientId: null,
          facts: { reason: off.reason, offAt: off.at.toISOString(), waiting, slot: slot.startsAt.toISOString() },
          dedupeKey: slot.key,
        })
        .onConflictDoNothing({ target: agentSignals.dedupeKey })
        .returning({ id: agentSignals.id });
      if (claim.length === 0) return 'already' as const;
      let queued = 0;
      for (const copy of copies) {
        // `AgentForcedOff`: the alarm's own type — unmutable and loud, like the line it repeats.
        queued += await queueStaffTelegram(tx, { userIds: [copy.userId], type: 'AgentForcedOff', text: copy.text });
      }
      if (queued === 0) throw new Unheard();
      return 'said' as const;
    });
  } catch (err) {
    if (err instanceof Unheard) return 'unheard';
    throw err;
  }
  if (outcome === 'said') {
    await kickTelegramDrain();
    logger.warn({ reason: off.reason, waiting, slot: slot.key }, '[agent] forced-off reminder');
  }
  return outcome;
}
