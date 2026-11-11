import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { isServerBehind, violatedCheck } from '../../platform/db/errors';
import { ANALYST_MODEL, approxMicroUsd, microUsdToUsd, type ModelTokens } from '../../platform/ai/model';
import { getSetting } from '../../platform/settings/service';
import { logger } from '../../platform/logger';
import type { CompanyMoneySight } from '../finance/scope';

/**
 * A PRESSED model call that belongs to no calculation request (0144,
 * docs/TARKIB-TAKLIFLAR.md §1.3): the Bojxona tab's 🤖 (`tnved`) and the
 * tarkib editor's «📄 Fayldan to'ldirish» (`tarkib`).
 *
 * Both are a person's finger on a button that costs money, and before this
 * the first had no ledger row and no ceiling — one press of «🤖 AI taklif (N)»
 * is up to N calls. So a press is COUNTED BEFORE it spends and BILLED AFTER:
 *
 *   reservePress → one row, `outcome = 'reserved'`, written only while the
 *                  day's count is under the limit — atomically;
 *   the model call;
 *   settlePress  → the same row gets its outcome and its tokens.
 *
 * Not `ai-cost.ts`'s soft budget (count read before, row written after): that
 * one is safe because ONE worker drains its queue. Here twenty people hold
 * the button, so the count and the row are one statement under a lock —
 * `ai_questions`' measured shape (`platform/ai/assistant.ts`), with the lock
 * as its OWN statement: folded into the INSERT it granted ten of ten against
 * a limit of three.
 *
 * What counts against the day: a row that is `reserved`, `ok` or `failed`.
 * `failed` = the model ANSWERED and the answer was no good — it was paid
 * for. `no_answer` = no usage came back (a timeout, the network, a refused
 * key): recorded, never counted — a dead key must not spend the day. A row
 * left `reserved` by a killed process stays counted: a crash still spent
 * its slot.
 *
 * The three columns this module names (`lot_id`, `batch_id`, `outcome`) are
 * SQL-only — not on the drizzle table, see `schema/wms.ts` — so everything
 * here is raw SQL, and a server one migration behind answers `server_behind`
 * (no count, no spend) instead of a white page.
 */

export type PressKind = 'tnved' | 'tarkib';

const LIMIT_SETTING = {
  tnved: 'tnved_ai_daily_limit',
  tarkib: 'tarkib_ai_daily_limit',
} as const satisfies Record<PressKind, string>;

/** The CHECKs 0144 re-made: a 23514 naming one of them is «the migration has not landed». */
const WIDENED_CHECKS = new Set(['ai_calc_passes_kind_check', 'ai_calc_passes_anchor_check', 'ai_calc_passes_outcome_check']);

/**
 * A typed limit as the number the cap uses: whole and not negative, or 0.
 * A cap on a bill fails CLOSED — an unreadable limit is «off», never «no
 * cap» (`ai_calc_daily_limit` reads 0 the other way; this is not copied).
 */
export function limitOf(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Today's ceiling for one kind. Pooled — never inside a transaction. */
export async function pressLimit(kind: PressKind): Promise<number> {
  return limitOf(await getSetting(LIMIT_SETTING[kind]));
}

/**
 * The rows that count against today, for one kind — ONE fragment for the cap
 * and for the number a screen shows, so the two cannot disagree. The day is
 * Tashkent's, cut at the same midnight as every other AI limit.
 */
export function pressCountedSql(kind: PressKind): SQL {
  return sql`kind = ${kind}
    AND outcome IS DISTINCT FROM 'no_answer'
    AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent'`;
}

export type PressRefusal = 'ai_off' | 'ai_limit' | 'server_behind' | 'failed';

/**
 * Take one of today's presses, or say why not. Never throws.
 *
 * `ai_off` = the limit is 0 (switched off in settings); `ai_limit` = today's
 * are spent; `server_behind` = 0144 has not landed; `failed` = the ledger
 * could not be written — and then nothing is spent, because a press the
 * ledger cannot count is a press nobody can cap.
 */
export async function reservePress(input: {
  kind: PressKind;
  staffId: string;
  lotId: string;
  batchId: string | null;
}): Promise<{ ok: true; id: string } | { ok: false; error: PressRefusal }> {
  try {
    const limit = await pressLimit(input.kind);
    if (limit <= 0) return { ok: false, error: 'ai_off' };
    const id = await db.transaction(async (tx) => {
      // Its own statement: the lock must be HELD before the count is read.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ai-press:${input.kind}`}))`);
      const rows = (await tx.execute(sql`
        INSERT INTO ai_calc_passes (kind, staff_id, lot_id, batch_id, model, outcome)
        SELECT ${input.kind}, ${input.staffId}::uuid, ${input.lotId}::uuid, ${input.batchId}::uuid, ${ANALYST_MODEL}, 'reserved'
         WHERE (SELECT count(*) FROM ai_calc_passes WHERE ${pressCountedSql(input.kind)}) < ${limit}
        RETURNING id
      `)) as unknown as { id: string }[];
      return rows[0]?.id ?? null;
    });
    return id ? { ok: true, id } : { ok: false, error: 'ai_limit' };
  } catch (err) {
    if (isServerBehind(err) || WIDENED_CHECKS.has(violatedCheck(err) ?? '')) return { ok: false, error: 'server_behind' };
    logger.error({ err, kind: input.kind }, '[ai-press] reservation failed');
    return { ok: false, error: 'failed' };
  }
}

export type PressOutcome = 'ok' | 'failed' | 'no_answer';

/**
 * Close a reserved press with what happened. Never throws: a ledger that
 * cannot be written must not cost the answer it was measuring. Only a row
 * still `reserved` moves, so a second settle is a no-op.
 */
export async function settlePress(id: string, result: { outcome: PressOutcome; usage?: ModelTokens | null }): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE ai_calc_passes
         SET outcome = ${result.outcome},
             model = ${result.usage?.model ?? ANALYST_MODEL},
             input_tokens = ${Math.max(0, Math.round(result.usage?.inputTokens ?? 0))},
             output_tokens = ${Math.max(0, Math.round(result.usage?.outputTokens ?? 0))}
       WHERE id = ${id}::uuid AND outcome = 'reserved'
    `);
  } catch (err) {
    logger.warn({ err, id }, '[ai-press] press not settled');
  }
}

export interface PressToday {
  /** Presses counted against today. */
  used: number;
  /** Today's ceiling; 0 = switched off. */
  limit: number;
  /** ≈ dollars today and over the last 30 days — only for a reader of the company's money. */
  usd: number | null;
  usd30: number | null;
}

/**
 * Today's count for one kind and — for a reader holding the company's money
 * sight, and nobody else — what the answered calls cost at list price.
 *
 * `sight` is REQUIRED and branded (`finance/scope.ts`): the count is not
 * money and everyone behind the button's door needs it to understand a
 * refusal; the dollars are the company's spending. Throws when the ledger
 * cannot be read (a server behind) — the caller draws no line.
 */
export async function pressToday(kind: PressKind, sight: CompanyMoneySight | null): Promise<PressToday> {
  const limit = await pressLimit(kind);
  const [counted] = (await db.execute(sql`
    SELECT count(*)::int AS used FROM ai_calc_passes WHERE ${pressCountedSql(kind)}
  `)) as unknown as { used: number }[];
  const used = Number(counted?.used ?? 0);
  if (!sight) return { used, limit, usd: null, usd30: null };
  const rows = (await db.execute(sql`
    SELECT model,
           (created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent') AS today,
           sum(input_tokens)::bigint AS input_tokens,
           sum(output_tokens)::bigint AS output_tokens
      FROM ai_calc_passes
     WHERE kind = ${kind} AND created_at >= now() - interval '30 days'
     GROUP BY 1, 2
  `)) as unknown as { model: string; today: boolean; input_tokens: string; output_tokens: string }[];
  const tokens = (only: boolean): ModelTokens[] =>
    rows
      .filter((row) => !only || row.today)
      .map((row) => ({ model: row.model, inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens) }));
  const dollars = (only: boolean): number | null => {
    const micro = approxMicroUsd(tokens(only));
    return micro === null ? null : microUsdToUsd(micro);
  };
  return { used, limit, usd: dollars(true), usd30: dollars(false) };
}
