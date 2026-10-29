import { AGENT_LIMITS } from './limits';

/**
 * May the agent draft a reply in this chat now (spec §17.4)? Pure — the
 * worker gathers the facts, this decides, and each refusal is a word the
 * ledger keeps (`agent_runs.outcome = 'refused'`, `error = reason`).
 *
 * Every clause is a way the first design would have drafted something it
 * should not: a colleague's phone in the client book (leak-1), a customer's
 * own auto-replier (ban-4), a chat he is answering himself (fit-3), an
 * account Telegram has limited (ban-1), a listener that will never send
 * (regression-3), a session the old server may still hold (ban-9).
 */

export interface EligibilityFacts {
  now: Date;
  agentOn: boolean;
  sessionConfirmed: boolean;
  /** The listener's agent pump stamped recently — a ✅ would actually be sent. */
  listenerCurrent: boolean;
  accountPaused: boolean;
  /** A private one-to-one chat with a real user (not a bot, a group, a channel). */
  privateUser: boolean;
  /** The chat names a client or a lead. */
  hasOwner: boolean;
  ruleExcluded: boolean;
  /** The peer's phone is an active staff member's. */
  peerIsStaff: boolean;
  muted: boolean;
  /** His own message in this chat (phone or CRM) within the human pause, or 🙋 still in force. */
  humanActive: boolean;
  /** The anchor is still the newest live (not deleted) inbound in the chat. */
  anchorIsNewest: boolean;
  anchorSentAt: Date;
  anchorAutoSent: boolean;
  /** Our newest out message's time, for the echo window. */
  lastOutAt: Date | null;
  /** The anchor repeats one of the peer's previous three messages word for word. */
  anchorRepeats: boolean;
}

export type Ineligible =
  | 'agent_off'
  | 'session_not_confirmed'
  | 'listener_behind'
  | 'account_paused'
  | 'not_private_user'
  | 'no_owner'
  | 'excluded'
  | 'staff_peer'
  | 'muted'
  | 'human_active'
  | 'not_newest'
  | 'too_old'
  | 'auto_sent'
  | 'echo'
  | 'repeat';

export function eligibleForRun(f: EligibilityFacts): { ok: true } | { ok: false; reason: Ineligible } {
  const no = (reason: Ineligible) => ({ ok: false as const, reason });
  if (!f.agentOn) return no('agent_off');
  if (!f.sessionConfirmed) return no('session_not_confirmed');
  if (!f.listenerCurrent) return no('listener_behind');
  if (f.accountPaused) return no('account_paused');
  if (!f.privateUser) return no('not_private_user');
  if (!f.hasOwner) return no('no_owner');
  if (f.ruleExcluded) return no('excluded');
  if (f.peerIsStaff) return no('staff_peer');
  if (f.muted) return no('muted');
  if (f.humanActive) return no('human_active');
  if (!f.anchorIsNewest) return no('not_newest');
  if (f.now.getTime() - f.anchorSentAt.getTime() > AGENT_LIMITS.anchorMaxAgeMs) return no('too_old');
  if (f.anchorAutoSent) return no('auto_sent');
  if (f.lastOutAt && f.anchorSentAt.getTime() - f.lastOutAt.getTime() < AGENT_LIMITS.echoWindowMs &&
      f.anchorSentAt.getTime() >= f.lastOutAt.getTime()) {
    return no('echo');
  }
  if (f.anchorRepeats) return no('repeat');
  return { ok: true };
}
