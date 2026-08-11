import type { LiveVerdict } from './telegram-live';
import type { MessageRow } from './telegram-import';

/**
 * «1 haftalik tarixi bilan tushsin»: when a manager connects their Telegram,
 * the listener pulls the last week of their CLIENT conversations, once. These
 * are the decisions; the gramjs walk in `tg-listen` stays a thin shell.
 *
 * The pull reuses the live path's own verdicts (`decideIncoming` → the same
 * store), so a message from last Tuesday lands exactly where it would have
 * landed live — with ONE deliberate exception, stated in `backfillOwner`.
 */

/** His words: «1 haftalik». */
export const BACKFILL_DAYS = 7;

/**
 * A busy chat's ceiling, so one client who sent three hundred voice notes
 * does not hold the listener's start hostage. Anything older or deeper is
 * still reachable through `pnpm tg-import`, which has been the long-history
 * tool since phase 1.
 */
export const BACKFILL_PER_CHAT = 500;

/** The oldest instant the pull reaches back to. */
export function backfillCutoff(now: Date): Date {
  return new Date(now.getTime() - BACKFILL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Telegram stamps a message with UNIX seconds; is it inside the window?
 * An undated message (Telegram's service rows) is not history anybody asked
 * for, and is refused rather than guessed at.
 */
export function withinWindow(messageDateSec: number | undefined, cutoff: Date): boolean {
  if (!messageDateSec) return false;
  return messageDateSec * 1000 >= cutoff.getTime();
}

/**
 * What one HISTORY message means for the walk.
 *
 * `decideIncoming` answers per message, but its answer is really about the
 * CHAT — the peer decides — with one exception: `empty`, a client's service
 * row ("call ended", a pinned marker), which says nothing about the chat at
 * all. So the walk stores what has an owner, steps over `empty`, and STOPS
 * the chat on everything else: once one message says «not ours», every
 * message in that chat says it.
 *
 * The stop covers `openLead` deliberately. Live, that verdict mints a lead
 * for a stranger writing to a work number; replayed over a week of history
 * at connect time it would mint a lead for every stranger who wrote in the
 * last seven days, all at once, with nobody having spoken to any of them.
 * The owner asked for history «hozirgi bor clientlari bilan» — client chats
 * and chats already attached to a lead. Strangers stay where the tray and
 * the live path offer them one at a time.
 */
export type BackfillStep =
  | { kind: 'store'; clientId: string | null; leadId: string | null; row: MessageRow }
  | { kind: 'skip' }
  | { kind: 'stop' };

export function backfillStep(verdict: LiveVerdict): BackfillStep {
  if (!verdict.store) {
    return 'reason' in verdict && verdict.reason === 'empty' ? { kind: 'skip' } : { kind: 'stop' };
  }
  if ('openLead' in verdict) return { kind: 'stop' };
  if ('leadId' in verdict) {
    return { kind: 'store', clientId: null, leadId: verdict.leadId, row: verdict.row };
  }
  return { kind: 'store', clientId: verdict.clientId, leadId: null, row: verdict.row };
}
