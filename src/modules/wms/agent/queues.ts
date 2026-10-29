/**
 * The agent's pg-boss queues and what each job carries — the contract between
 * the listener (a SENDER only, `enqueue` → `ensureListening`) and the app's
 * worker. Zero imports, so the listener can read it without pulling the
 * brain into its process.
 *
 * No singletonKey (regression-13): pg-boss 10 dedupes by key only under the
 * short/singleton/stately policies, and the queues here are created standard.
 * The debounce is `startAfter` + the worker's «is this anchor still the
 * newest live inbound» stand-down + the per-anchor UNIQUE on agent_runs.
 */

export const JOB_AGENT_INBOUND = 'agent.inbound';
export const JOB_AGENT_HUMAN_REPLY = 'agent.human_reply';
export const JOB_AGENT_SWEEP = 'agent.sweep';
/** The VED handed a linked calculation back — the customer's question is drafted off the VED's button (regression-3). */
export const JOB_AGENT_HAND_BACK = 'agent.hand_back';

/** A customer's message landed on the agent owner's account. */
export interface AgentInboundJob {
  managerUserId: string;
  /** bigints travel as strings through pg-boss's JSON. */
  peerId: string;
  anchorTgMessageId: string;
  /** 0 from the listener; the sweep's one retry of an errored run is 1 (fit-15); his press asks from 50 (`nextRedraftAttempt`). */
  attempt?: number;
  /**
   * Why this job exists — the live hook, an edit of the newest inbound, a
   * pull, the sweep, a typing wait, or his ✅/❌ on a card the chat had moved
   * past (decide `redraftNewest`): that one is HIS press, never the sweep's,
   * and the late note and the `[agent] inbound` line say so.
   */
  origin: 'live' | 'edit' | 'pull' | 'sweep' | 'typing_wait' | 'redraft';
}

/**
 * The attempt numbers of one inbound line (`agent_runs_inbound_unique` is per
 * anchor AND attempt), so no kind of asking takes another's slot:
 *  - 0 is the first look (the live hook, a pull, the sweep's gap pass), and 1
 *    its one retry by the sweep when it errored (fit-15);
 *  - from `REDRAFT_ATTEMPT_BASE`, his press asking the line again: each ask
 *    on an EVEN number and its own one retry on the odd number after it — a
 *    press-made redraft used to take attempt 1, the retry slot, so one that
 *    errored was never tried again;
 *  - from `EDIT_ATTEMPT_BASE`, an edit of the anchor (run `attemptFor`).
 */
export const REDRAFT_ATTEMPT_BASE = 50;
export const EDIT_ATTEMPT_BASE = 100;

/** An attempt that is an ask of its own — the first look or a press — and so earns the sweep's one retry at `attempt + 1`. */
export function isFirstAsk(attempt: number): boolean {
  return attempt === 0 || (attempt >= REDRAFT_ATTEMPT_BASE && attempt < EDIT_ATTEMPT_BASE && attempt % 2 === 0);
}

/** The next press-made ask of a line, past every ask (and retry) of the band already on it; null when the band is spent. */
export function nextRedraftAttempt(attempts: readonly number[]): number | null {
  const top = Math.max(REDRAFT_ATTEMPT_BASE - 2, ...attempts.filter((a) => a >= REDRAFT_ATTEMPT_BASE && a < EDIT_ATTEMPT_BASE));
  const next = top - (top % 2) + 2;
  return next < EDIT_ATTEMPT_BASE ? next : null;
}

/** He (or a colleague on his account, or the CRM) answered this chat himself. */
export interface AgentHumanReplyJob {
  managerUserId: string;
  peerId: string;
  tgMessageId: string;
}

/**
 * A hand-back to draft for the customer. The reason is the VED's own words —
 * the model's instruction, never the reply; the request keys the run
 * (`agent_runs_source_unique`), so a job delivered twice drafts once.
 */
export interface AgentHandBackJob {
  managerUserId: string;
  peerId: string;
  requestId: string;
  reason: string;
  /** 0 (absent) from the VED's button; 1 = the one retry after a refusal that passes by itself (run.ts `passesByItself`). */
  attempt?: number;
}

/** Seconds of quiet before the worker looks (AGENT_LIMITS.debounceMs). */
export const INBOUND_START_AFTER_S = 12;

/**
 * Should a stored message start an agent run? Pure (build-3). Only a LIVE
 * inbound on the agent owner's account: catch-up, the week's backfill and the
 * site sweep's replay are history, and a reply to a message a day old is the
 * shape that reads as a robot.
 */
export function shouldStartAgentRun(input: {
  origin: 'live' | 'catch_up' | 'backfill' | 'site_sweep' | 'pull';
  direction: 'in' | 'out';
  accountManagerUserId: string;
  agentOwnerUserId: string | null;
  agentOn: boolean;
  /** The verdict stored the message on a client or a lead. */
  stored: boolean;
}): 'run' | 'human_reply' | null {
  if (!input.agentOn || !input.stored) return null;
  if (input.agentOwnerUserId === null || input.accountManagerUserId !== input.agentOwnerUserId) return null;
  if (input.origin !== 'live' && input.origin !== 'pull') return null;
  if (input.direction === 'in') return 'run';
  return input.origin === 'live' ? 'human_reply' : null;
}
