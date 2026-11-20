import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clearSignal, raiseSignal, signalStanding } from '../../platform/diagnostics/signals';
import { logger } from '../../platform/logger';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { getSetting, SETTING_DEFAULTS, SETTING_VALIDATORS } from '../../platform/settings/service';
import { quietHour } from '../../platform/telegram/send';
import type { AgentConfig } from './config';
import { designated } from './designations';
import type { Ineligible } from './eligibility';
import { INTERRUPTED_RUN_MS } from './jobs';
import { AGENT_LIMITS } from './limits';
import { agentPageReaders, agentPageUrl } from './signals';

/**
 * «AI sotuvchi javob bermayapti» (stage 1a §4.5, lead ruling R9 — `critic-guard.md` §D.1 made it the condition for
 * taking the card and the hold off ordinary talk). A customer's line written in WORKING hours, in a chat bound to a
 * card, that is still the chat's newest line `agent_liveness_minutes` later, and whose run says nothing was or will
 * be answered — the minute sweep (step 3b of `agentSweep`) tells the «rahbar va o‘rinbosar» pair ONCE, and once
 * more when no such customer is left.
 *
 * It tells; it stops nothing. It does not watch the listener (with the listener down no line is stored —
 * `sweepQuietListeners`' business), asks nothing about night lines (nobody is awake to act; the morning line's
 * «Javobsiz» counts them), and is not the alarm for a card nobody received (stated, not built).
 *
 * «Said once» is the system watch's own state row (0115, `platform/diagnostics/signals.ts`): it stands while the
 * fault stands and is deleted when it clears, so the home screen's red row survives a DEAD staff bot — the Telegram
 * line rides that very bot (round 49: an alarm about a component must not depend on that component alone).
 */

/** The state row's key — free text, its own (`diskSignals` reads `disk:%`, `botRefused` its own key). */
export const LIVENESS_SIGNAL_KEY = 'agent:liveness';

/** Every `agent_runs.outcome` the 0138 CHECK admits — `livenessOf` judges each (the test reads the CHECK's text). */
export const RUN_OUTCOMES = ['reserved', 'draft', 'no_reply', 'notice', 'stood_down', 'refused', 'capped', 'error'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/**
 * A refused run, by its stored reason: `fault` — the machine is broken or held, and the customer is left with
 * nobody (the listener behind, the account paused, the session never confirmed); `by_design` — somebody decided
 * this chat is not the AI's (it is personal, a colleague's, muted, his own conversation, an echo, a repeat). One
 * entry per member, a Record and not a Partial: a new refusal does not compile until somebody classifies it.
 */
export const INELIGIBLE_LIVENESS: Record<Ineligible, 'by_design' | 'fault'> = {
  agent_off: 'by_design',
  session_not_confirmed: 'fault',
  listener_behind: 'fault',
  account_paused: 'fault',
  not_private_user: 'by_design',
  no_owner: 'by_design',
  excluded: 'by_design',
  staff_peer: 'by_design',
  muted: 'by_design',
  human_active: 'by_design',
  not_newest: 'by_design',
  too_old: 'by_design',
  auto_sent: 'by_design',
  echo: 'by_design',
  repeat: 'by_design',
};

export type Liveness = 'answered' | 'unanswered';

/** The newest run of a line's anchor, as the sweep reads it. */
export interface AnchorRun {
  outcome: string;
  error: string | null;
  createdAt: Date;
}

/**
 * Was the line answered, or will it be? Pure. No run at all: unanswered — the worker or the queue is dead (the
 * sweep's deploy-gap pass has re-queued the line, and nothing came of it). A draft counts whether it went or waits
 * (a waiting one is on his card and in the morning line); `no_reply`, a notice to him and a stand-down are answers by
 * design. A refusal is judged by its reason (`INELIGIBLE_LIVENESS`; a `draftWorthy` reason shares the column and is
 * by design). A cap, an error, and a run reserved longer than any run lives (`INTERRUPTED_RUN_MS`) are unanswered.
 * An outcome this build does not know is unanswered — the alarm errs toward telling.
 */
export function livenessOf(run: AnchorRun | null, now: Date): Liveness {
  if (!run) return 'unanswered';
  switch (run.outcome as RunOutcome) {
    case 'draft':
    case 'no_reply':
    case 'notice':
    case 'stood_down':
      return 'answered';
    case 'refused': {
      const why = run.error ?? '';
      return Object.hasOwn(INELIGIBLE_LIVENESS, why) && INELIGIBLE_LIVENESS[why as Ineligible] === 'fault' ? 'unanswered' : 'answered';
    }
    case 'reserved':
      return now.getTime() - run.createdAt.getTime() > INTERRUPTED_RUN_MS ? 'unanswered' : 'answered';
    case 'capped':
    case 'error':
      return 'unanswered';
    default:
      return 'unanswered';
  }
}

/** A customer's line nobody answered, as the sweep and the morning line count it. */
export interface WaitingLine {
  peerId: string;
  tgMessageId: string;
  sentAt: Date;
}

/**
 * The holder's chats bound to a card whose NEWEST line is inbound and was written in [`from`, `to`] — «the newest
 * line is inbound» is the whole of «nothing was sent»: our reply, his own typing or his robot would be an out line
 * after it — each with the newest run of THAT anchor (`anchor_tg_message_id`, the key the deploy-gap pass reads, never
 * the chat's newest run: yesterday's draft would hide today's silence), judged by `livenessOf`. `workingHours`: only
 * lines written outside the house's one night clock (`quietHour`, 22:00-08:00 Tashkent — never a second clock). ONE
 * statement on the pool.
 */
export async function unansweredLines(
  holderId: string,
  window: { from: Date; to: Date; workingHours: boolean },
  now: Date,
): Promise<WaitingLine[]> {
  // Timestamps as epoch milliseconds: a raw execute hands timestamps back as TEXT (history.ts's lesson).
  const rows = await db.execute<{
    peer_id: string;
    tg_message_id: string;
    sent_ms: number;
    outcome: string | null;
    error: string | null;
    run_ms: number | null;
  }>(sql`
    WITH newest AS (
      SELECT DISTINCT ON (m.peer_id) m.peer_id, m.tg_message_id, m.sent_at, m.direction, m.client_id, m.lead_id
        FROM tg_messages m
       WHERE m.manager_user_id = ${holderId}::uuid
         AND m.sent_at >= ${window.from.toISOString()}::timestamptz
       ORDER BY m.peer_id, m.sent_at DESC, m.tg_message_id DESC
    )
    SELECT n.peer_id::text AS peer_id, n.tg_message_id::text AS tg_message_id,
           (extract(epoch FROM n.sent_at) * 1000)::float8 AS sent_ms,
           r.outcome, r.error, (extract(epoch FROM r.created_at) * 1000)::float8 AS run_ms
      FROM newest n
      LEFT JOIN LATERAL (
        SELECT ar.outcome, ar.error, ar.created_at FROM agent_runs ar
         WHERE ar.manager_user_id = ${holderId}::uuid AND ar.peer_id = n.peer_id
           AND ar.trigger = 'inbound' AND ar.anchor_tg_message_id = n.tg_message_id
         ORDER BY ar.created_at DESC, ar.attempt DESC
         LIMIT 1) r ON true
     WHERE n.direction = 'in'
       AND (n.client_id IS NOT NULL OR n.lead_id IS NOT NULL)
       AND n.sent_at <= ${window.to.toISOString()}::timestamptz`);
  const out: WaitingLine[] = [];
  for (const row of rows) {
    const sentAt = new Date(Number(row.sent_ms));
    if (window.workingHours && quietHour(sentAt)) continue;
    const run = row.outcome === null ? null : { outcome: row.outcome, error: row.error, createdAt: new Date(Number(row.run_ms)) };
    if (livenessOf(run, now) === 'unanswered') out.push({ peerId: row.peer_id, tgMessageId: row.tg_message_id, sentAt });
  }
  return out;
}

/**
 * The suites' switch (`AGENT_LIVENESS=off`, set by vitest.config and the Playwright server's env — the
 * `AGENT_TARIFF_NOTICE` precedent): the alarm is ONE state row any sweep may raise, judged on the real clock's
 * working hours and on lines a test left minutes old, so every file that runs `agentSweep` would raise or clear it by
 * the hour of the run. Off, the step leaves the row as it is (the browser spec that draws it puts it in and takes it
 * out itself). The alarm's own tests switch it on.
 */
export function livenessOn(): boolean {
  return process.env.AGENT_LIVENESS !== 'off';
}

/** The setting as the sweep reads it: minutes, 0 = off; a stored value its shape refuses is the default. */
export async function readLivenessMinutes(): Promise<number> {
  const raw = String(await getSetting('agent_liveness_minutes'));
  return SETTING_VALIDATORS.agent_liveness_minutes!(raw) ? Number(raw) : SETTING_DEFAULTS.agent_liveness_minutes;
}

/** How far back a line can still be the alarm's: step 3's own set made wider in time (§4.5). */
export const LIVENESS_WINDOW_MS = 2 * 60 * 60_000;

/** What the state row carries: how many customers wait, and since when the oldest of them does. */
export interface LivenessDetail {
  n: number;
  oldest: Date;
}

export function livenessDetailText(d: LivenessDetail): string {
  return JSON.stringify({ n: d.n, oldest: d.oldest.toISOString() });
}

/** The row's detail read back — null for one no build of this file wrote. */
export function livenessDetailOf(detail: string | null): LivenessDetail | null {
  try {
    const parsed = JSON.parse(detail ?? '') as { n?: unknown; oldest?: unknown };
    const oldest = typeof parsed.oldest === 'string' ? new Date(parsed.oldest) : null;
    if (typeof parsed.n !== 'number' || !oldest || Number.isNaN(oldest.getTime())) return null;
    return { n: parsed.n, oldest };
  } catch {
    return null;
  }
}

/** Whole minutes the oldest customer has waited. */
export function waitedMinutes(oldest: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 60_000));
}

/**
 * The alarm, as one recipient reads it — counts only (no customer's name, words or phone, leak-13). «AI sahifasini
 * oching» and the page's link only for a recipient the page admits (J17).
 */
export function livenessAlarmText(d: LivenessDetail, now: Date, withPage: boolean): string {
  const head = `⚠️ AI sotuvchi javob bermayapti: ${d.n} ta mijoz ${waitedMinutes(d.oldest, now)} daqiqadan beri kutyapti.`;
  return withPage ? [head, 'AI sahifasini oching.', agentPageUrl()].join('\n') : head;
}

/**
 * …and the one line when it clears. Said as what is TRUE when it clears — no customer of the working hours is left
 * waiting — never «the AI answers again»: the same zero comes when he answered them himself while the AI is still
 * down (#1106: a claim nobody has).
 */
export const LIVENESS_CLEARED_TEXT = '✅ Javobsiz kutayotgan mijoz qolmadi — «AI sotuvchi javob bermayapti» ogohlantirishi yopildi.';

/**
 * The sweep's step 3b. Called only while the agent runs and the model is configured, outside any transaction, in
 * its own try/catch (`agentSweep`). Reads the setting once; 0 takes a standing alarm down without a word (he
 * switched it off). Not standing: lines of the last two hours. Standing: of the last day (the anchor's own reply
 * window) — a line the alarm was raised for keeps it standing until somebody answers it, never until it ages out of
 * two hours. Returns how many customers wait.
 */
export async function sweepUnanswered(config: Pick<AgentConfig, 'ownerUserId'>, now: Date): Promise<number> {
  if (!livenessOn()) return 0;
  const holderId = config.ownerUserId;
  const minutes = await readLivenessMinutes();
  if (minutes === 0 || !holderId) {
    await clearSignal(LIVENESS_SIGNAL_KEY);
    return 0;
  }
  const standing = await signalStanding(LIVENESS_SIGNAL_KEY);
  const reach = standing ? AGENT_LIMITS.anchorMaxAgeMs : LIVENESS_WINDOW_MS;
  const lines = await unansweredLines(
    holderId,
    { from: new Date(now.getTime() - reach), to: new Date(now.getTime() - minutes * 60_000), workingHours: true },
    now,
  );
  if (lines.length === 0) {
    if (standing && (await clearSignal(LIVENESS_SIGNAL_KEY))) {
      await notifyStaffTelegram({ userIds: await designated('supervisor'), type: 'AgentLiveness', text: LIVENESS_CLEARED_TEXT });
      logger.info('[agent] liveness alarm cleared');
    }
    return 0;
  }
  const detail: LivenessDetail = { n: lines.length, oldest: new Date(Math.min(...lines.map((l) => l.sentAt.getTime()))) };
  if (!(await raiseSignal(LIVENESS_SIGNAL_KEY, livenessDetailText(detail)))) return lines.length;
  // The write that OPENED the row tells — both ranks of the pair, or the fallback chain when he named nobody.
  const recipients = await designated('supervisor');
  const readers = await agentPageReaders(recipients, config);
  for (const userId of recipients) {
    await notifyStaffTelegram({ userIds: [userId], type: 'AgentLiveness', text: livenessAlarmText(detail, now, readers.has(userId)) });
  }
  logger.warn({ waiting: detail.n }, '[agent] liveness alarm raised');
  return lines.length;
}

/**
 * The standing alarm as a screen prints it (the home's red row, the AI page's line) — null when none stands or its
 * detail is unreadable. A reader for whoever may open the AI page, and only while the agent runs (the callers ask).
 */
export async function livenessStanding(now: Date): Promise<{ n: number; minutes: number } | null> {
  const row = await signalStanding(LIVENESS_SIGNAL_KEY);
  const d = row ? livenessDetailOf(row.detail) : null;
  return d ? { n: d.n, minutes: waitedMinutes(d.oldest, now) } : null;
}
