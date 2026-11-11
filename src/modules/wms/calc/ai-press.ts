import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { isServerBehind } from '../../platform/db/errors';
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
 * `failed` = the provider WORKED on the call and the answer was no good — a
 * refusal, a cut-off, an unreadable one, or a TIMEOUT of ours after the
 * request was sent (the dearest failure there is: a minute of generation
 * abandoned; uncounted, the same file could be pressed again and again
 * outside the cap this module exists to set). `no_answer` = nothing can have
 * been generated — a refused key, a rate limit, a connection that never
 * opened: recorded, never counted — a dead key must not spend the day. A row
 * left `reserved` by a killed process stays counted: a crash still spent
 * its slot.
 *
 * The four columns this module names (`lot_id`, `batch_id`, `outcome`,
 * `cost_usd`) are SQL-only — not on the drizzle table, see `schema/wms.ts` —
 * so everything here is raw SQL, and a server one migration behind answers
 * `server_behind` (no count, no spend) instead of a white page.
 *
 * THE DOLLARS ARE FROZEN ON THE ROW at settle (`cost_usd`), from the list
 * price of the model the call was MADE with. Computed at read time from a
 * map keyed by today's constants, a model change would re-price every old
 * row at the new model's price — or, the old id gone from the map, show
 * «30 kun ≈» as nothing for a month (the design judge). A row whose model has
 * no known price keeps NULL and is COUNTED on the screen («N ta chaqiruv
 * narxi noma'lum»), never summed as zero.
 */

export type PressKind = 'tnved' | 'tarkib';

const LIMIT_SETTING = {
  tnved: 'tnved_ai_daily_limit',
  tarkib: 'tarkib_ai_daily_limit',
} as const satisfies Record<PressKind, string>;

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
    // «Behind» is the missing column or table (42703 / 42P01) and nothing
    // else: this INSERT names 0144's columns, so on an older schema it fails
    // there before any CHECK is evaluated (tried against a pre-0144 copy). A
    // 23514 is a fault of our own — or a later migration that re-made the
    // kind CHECK without these kinds, which `ai-press.test.ts` fences.
    if (isServerBehind(err)) return { ok: false, error: 'server_behind' };
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
    // Priced NOW, by the model the call was made with; null = no list price
    // known for it, and the row then says so by being NULL.
    const micro = result.usage ? approxMicroUsd([result.usage]) : null;
    await db.execute(sql`
      UPDATE ai_calc_passes
         SET outcome = ${result.outcome},
             model = ${result.usage?.model ?? ANALYST_MODEL},
             input_tokens = ${Math.max(0, Math.round(result.usage?.inputTokens ?? 0))},
             output_tokens = ${Math.max(0, Math.round(result.usage?.outputTokens ?? 0))},
             cost_usd = ${micro === null ? null : microUsdToUsd(micro).toFixed(6)}::numeric
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
  /** Answered calls of the last 30 days whose model had no known price — said, never summed as $0. */
  unpriced: number | null;
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
  if (!sight) return { used, limit, usd: null, usd30: null, unpriced: null };
  // The rows' own frozen dollars — never re-priced here.
  const [money] = (await db.execute(sql`
    SELECT coalesce(sum(cost_usd) FILTER (
             WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent'), 0)::float8 AS usd,
           coalesce(sum(cost_usd), 0)::float8 AS usd30,
           count(*) FILTER (WHERE cost_usd IS NULL AND outcome IN ('ok', 'failed') AND input_tokens + output_tokens > 0)::int AS unpriced
      FROM ai_calc_passes
     WHERE kind = ${kind} AND created_at >= now() - interval '30 days'
  `)) as unknown as { usd: number; usd30: number; unpriced: number }[];
  return { used, limit, usd: Number(money?.usd ?? 0), usd30: Number(money?.usd30 ?? 0), unpriced: Number(money?.unpriced ?? 0) };
}
