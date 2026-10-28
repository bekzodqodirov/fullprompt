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

export type AiPassKind = 'intake' | 'grouping' | 'pick' | 'invoice' | 'similar';

/**
 * What a pass is billed TO (0119): a calculation request, or — for
 * «Oldingi narx»'s fallback, which asks about a truck's lot and belongs to no
 * request — nothing. A union rather than an optional id, so the anchor CHECK
 * is a compile error before it is a 23514: `similar` cannot be handed a
 * request, and every other kind cannot be written without one.
 */
type AiPassAnchor =
  | { kind: 'similar'; requestId: null }
  | { kind: 'intake'; requestId: string; intakeNoteId?: string | null }
  // A collection's reading is billed when the model answers, before any
  // request exists (0137): the collection's note anchors it, and the landing
  // fills the request (`attachIntakePasses`). `string | null`, so the reading
  // job passes an add collection's request or none without a branch.
  | { kind: 'intake'; requestId: string | null; intakeNoteId: string }
  | { kind: Exclude<AiPassKind, 'similar' | 'intake'>; requestId: string };

/**
 * Record one model call. Never throws: a ledger that cannot be written must
 * not cost the answer it was measuring.
 */
export async function recordAiPass(
  input: AiPassAnchor & {
    staffId?: string | null;
    model: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
    /**
     * When the call was MADE, for a bill written later than it was spent (the
     * intake bills at the landing, judge concurrency-11) — the day's count
     * reads this column. Absent = now, the column's own default.
     */
    createdAt?: Date | null;
  },
): Promise<void> {
  try {
    await db.insert(aiCalcPasses).values({
      requestId: input.requestId,
      intakeNoteId: 'intakeNoteId' in input ? (input.intakeNoteId ?? null) : null,
      staffId: input.staffId ?? null,
      kind: input.kind,
      model: input.model,
      inputTokens: Math.max(0, Math.round(Number(input.inputTokens ?? 0)) || 0),
      outputTokens: Math.max(0, Math.round(Number(input.outputTokens ?? 0)) || 0),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
  } catch (err) {
    logger.warn({ err, requestId: input.requestId }, '[ai-cost] pass not recorded');
  }
}

/**
 * A collection's readings, billed on its note before it landed, now belong to
 * the request the landing opened (0137). Only rows still standing on the note
 * alone are moved, so a repeat is a no-op. Never throws, like the bill: a
 * ledger row left on the note still counts in the day's budget.
 */
export async function attachIntakePasses(noteId: string, requestId: string): Promise<number> {
  try {
    const rows = await db.execute<{ id: string }>(sql`
      UPDATE ai_calc_passes SET request_id = ${requestId}::uuid
       WHERE intake_note_id = ${noteId}::uuid AND request_id IS NULL
      RETURNING id::text AS id
    `);
    return rows.length;
  } catch (err) {
    logger.warn({ err, noteId, requestId }, '[ai-cost] intake passes not attached');
    return 0;
  }
}

/**
 * The two budgets the ledger is counted against (0119). The calculation
 * half — intake, grouping, the pick, the invoice — is what the VED's Telegram
 * estimate and the queued prefill run on; «Oldingi narx»'s 🤖 is pressed by
 * the accountant across a truck's lots. One shared count would let an
 * afternoon of pricing presses stop the VED's estimates until midnight, so
 * each is counted apart, against its own setting.
 */
export type AiBudget = 'calc' | 'similar';

const BUDGET_SETTING = {
  calc: 'ai_calc_daily_limit',
  similar: 'price_history_ai_daily_limit',
} as const satisfies Record<AiBudget, string>;

/**
 * How many model calls are left today on one budget.
 *
 * The day is Tashkent's (R5) — the AI assistant's daily cap cuts at the same
 * midnight, so the two budgets a person meets reset together. Infinity when
 * the setting is not a positive number: an unreadable cap must not stop the
 * feature, it must stop being a cap.
 */
export async function aiCalcBudgetLeft(budget: AiBudget = 'calc'): Promise<number> {
  const configured = Number(await getSetting(BUDGET_SETTING[budget]));
  if (!Number.isFinite(configured) || configured <= 0) return Number.POSITIVE_INFINITY;
  const kind = budget === 'similar' ? sql`kind = 'similar'` : sql`kind <> 'similar'`;
  const [row] = await db.execute<{ used: string }>(sql`
    SELECT count(*)::text AS used
      FROM ai_calc_passes
     WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent'
       AND ${kind}
  `);
  return Math.max(0, configured - Number(row?.used ?? 0));
}
