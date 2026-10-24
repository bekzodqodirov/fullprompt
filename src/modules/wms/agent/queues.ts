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
  /** 0 from the listener; the sweep's one retry of an errored run is 1 (fit-15). */
  attempt?: number;
  /** Why this job exists — the live hook, an edit of the newest inbound, a pull, the sweep. */
  origin: 'live' | 'edit' | 'pull' | 'sweep' | 'typing_wait';
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
