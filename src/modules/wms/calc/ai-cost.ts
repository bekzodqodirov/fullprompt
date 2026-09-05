import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { aiCalcPasses } from '../../platform/db/schema';
import { getSetting } from '../../platform/settings/service';
import { logger } from '../../platform/logger';

/**
 * What the AI VED hodimi costs, and when to stop for the day (0096).
 *
 * The assistant's `ai_questions` is a different audience and a different
 * rule: it is one PERSON's atomic daily cap, keyed on `user_id NOT NULL`.
 * This pass runs as NOBODY — a background job on a request, sometimes with no
 * staff member to bill it to — so it gets a ledger of its own, one row per
 * model call, readable as a bill after a real week.
 *
 * STATED PLAINLY, because it matters: this is a SOFT budget, not a claim.
 * `ai_questions` takes a lock and refuses the (n+1)th question atomically;
 * here the count is read before the pass and the rows are written after, so
 * two workers draining at once can both pass a cap they are about to cross.
 * The queue has one worker and the cap is 200 a day — the failure mode is a
 * couple of calls over, not a runaway — and an atomic claim would need a
 * table lock on the path that must never hold one (#714).
 */

export type AiPassKind = 'intake' | 'grouping' | 'pick' | 'invoice';

/**
 * Record one model call. Never throws: a ledger that cannot be written must
 * not cost the answer it was measuring.
 */
export async function recordAiPass(input: {
  requestId: string;
  staffId?: string | null;
  kind: AiPassKind;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
}): Promise<void> {
  try {
    await db.insert(aiCalcPasses).values({
      requestId: input.requestId,
      staffId: input.staffId ?? null,
      kind: input.kind,
      model: input.model,
      inputTokens: Math.max(0, Math.round(Number(input.inputTokens ?? 0)) || 0),
      outputTokens: Math.max(0, Math.round(Number(input.outputTokens ?? 0)) || 0),
    });
  } catch (err) {
    logger.warn({ err, requestId: input.requestId }, '[ai-cost] pass not recorded');
  }
}

/**
 * How many model calls are left today.
 *
 * The day is UTC — the same convention `/bugun` and the task deadlines use
 * (#457's note), and moving it would have to move those too. Infinity when
 * the setting is not a positive number: an unreadable cap must not stop the
 * feature, it must stop being a cap.
 */
export async function aiCalcBudgetLeft(): Promise<number> {
  const configured = Number(await getSetting('ai_calc_daily_limit'));
  if (!Number.isFinite(configured) || configured <= 0) return Number.POSITIVE_INFINITY;
  const [row] = await db.execute<{ used: string }>(sql`
    SELECT count(*)::text AS used
      FROM ai_calc_passes
     WHERE created_at >= date_trunc('day', now())
  `);
  return Math.max(0, configured - Number(row?.used ?? 0));
}
