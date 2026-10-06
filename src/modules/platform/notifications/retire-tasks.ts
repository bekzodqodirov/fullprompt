import { logger } from '../logger';

/**
 * A task's Telegram copies stop offering buttons once the task is no longer
 * the assignee's to act on (docs/TELEGRAM-TOPSHIRIQ.md §4, review
 * telegram-mechanics-2/5/6/7) — the shape of `retireApprovalCopies`.
 *
 * The INTERFACE is written once, before the two rounds of 2026-10-06 fork, so
 * the VED round's direct task writers (the stale-task script, the calc
 * endings) can call it while the topshiriq round fills the body: mute the
 * copies still pending, edit the single-task copies to the outcome line
 * without buttons, and redraw a `TasksDue` digest's keyboard from the tasks
 * still open (its text stays — one closed task must not wipe seven others).
 *
 * Callers run it AFTER their transaction commits (#714), never inside one.
 */
export type TaskCopyOutcome = 'done' | 'cancelled' | 'reassigned';

export interface RetireTaskCopiesInput {
  taskIds: string[];
  outcome: TaskCopyOutcome;
  /** Nothing older can be one of its copies (bounds the scan). */
  since?: Date;
  /** On a reassign: the NEW assignee, whose fresh copy must survive. */
  exceptUserIds?: string[];
}

export async function retireTaskCopies(input: RetireTaskCopiesInput): Promise<number> {
  // Filled by the topshiriq round. Until then there is nothing to retire:
  // today's copies carry only the single «✅ Bajarildi», which refuses a
  // closed task in words at the press.
  void input;
  return 0;
}

/**
 * The fire-and-forget form for a request path or the bot's sequential poller
 * (#706): a slow Telegram edit must never hold either.
 */
export function retireTaskCopiesSoon(input: RetireTaskCopiesInput): void {
  if (input.taskIds.length === 0) return;
  void retireTaskCopies(input).catch((err: unknown) => {
    logger.error({ err, taskIds: input.taskIds }, '[tasks] retiring Telegram copies failed');
  });
}
