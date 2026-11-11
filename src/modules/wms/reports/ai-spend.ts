import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { approxMicroUsd } from '../../platform/ai/model';
import { logger } from '../../platform/logger';

/**
 * What the machine cost over a window — the evening summary's «🤖 AI» line
 * (docs/PRIXOD-XABARI.md §B, the owner's «8 ha», 2026-11-11).
 *
 * THREE ledgers hold model usage and they know three different things, so
 * the reader is honest about each instead of printing one smaller number as
 * if it were the bill:
 *
 *  · `ai_calc_passes` — the AI VED's calls, «Oldingi narx»'s 🤖, the Bojxona
 *    🤖 and the tarkib's file reading. The two PRESSED kinds freeze their
 *    dollars on the row (`cost_usd`, 0144) and are never re-priced here; the
 *    rest carry tokens and their model and are priced at today's list;
 *  · `agent_runs` — the AI sotuvchi, with its cache tokens;
 *  · `ai_questions` — the staff AI yordamchi. It held NO tokens until 0145;
 *    a question answered before that is counted and cannot be priced.
 *
 * «A request» (murojaat), per ledger — what reached the model, and nothing
 * that did not:
 *  · calc: one row = one answered model call, or one settled press (`ok` /
 *    `failed`). A press still `reserved` or settled `no_answer` is not one —
 *    nothing can have been generated (`ai-press.ts`);
 *  · agent: one RUN that spent tokens (a run is several model calls), or one
 *    that ended in `error` with none recorded — it may have reached the model
 *    and its usage was lost with the error. A run that was `refused`, sent a
 *    `notice`, was `capped` or stood down never called anything;
 *  · assistant: one QUESTION (up to six model rounds) that has tokens, or an
 *    answer with none (asked before 0145).
 *
 * «Unpriced» = a request no dollar figure can be made for: its model has no
 * list price, or its usage was never recorded. Those are COUNTED and said,
 * never summed as $0 — the same rule the Bojxona tab's own line follows
 * (`pressToday`: a settled press with tokens and no frozen cost).
 *
 * NOT in any ledger, and so not in this figure: the deal card's goods-file
 * import (its AI grouping writes no usage row), and an AI-sotuvchi run whose
 * chat was purged afterwards (the purge removes its rows). The figure is an
 * approximation at list price — «≈» — and is on no screen; the summary is
 * its one place.
 *
 * Three grouped statements, one per ledger. A ledger that cannot be read is
 * NAMED (`unread`): its part is empty, the other two still stand, and the
 * line says which bill it could not read — the summary must not fail on a
 * bill, and must not shrink one in silence either.
 */

export interface AiSpendPart {
  /** Requests that reached the model. */
  calls: number;
  /** ≈ dollars of the requests that could be priced (list price). */
  usd: number;
  /** Requests that could not be priced — counted, and not in `usd`. */
  unpriced: number;
}

export type AiLedger = 'calc' | 'agent' | 'assistant';

export interface AiSpend {
  /** The calculation side: AI VED, «Oldingi narx», Bojxona 🤖, the tarkib's file reading. */
  calc: AiSpendPart;
  /** The AI sotuvchi. */
  agent: AiSpendPart;
  /** The staff AI yordamchi (bot and /ai). */
  assistant: AiSpendPart;
  total: AiSpendPart;
  /** The ledgers that could not be read at all — said on the line, never a silent zero. */
  unread: AiLedger[];
}

const EMPTY: AiSpendPart = { calls: 0, usd: 0, unpriced: 0 };

/** `created_at` inside [from, to) — instants bound as ISO text and cast (#156: a Date in a raw fragment reaches postgres.js untyped). */
function inWindow(column: SQL, from: Date, to: Date): SQL {
  return sql`${column} >= ${from.toISOString()}::timestamptz AND ${column} < ${to.toISOString()}::timestamptz`;
}

export interface SpendGroup {
  model: string | null;
  /** Requests of this group. */
  calls: number;
  /** Dollars already frozen on rows (the pressed kinds). */
  frozenUsd: number;
  /** Requests whose usage was never recorded — unpriced whatever the model. */
  unrecorded: number;
  /** Requests to be priced from tokens. */
  tokenCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Pure: one ledger's groups → its part. Exported for the unit test. */
export function spendOf(groups: readonly SpendGroup[]): AiSpendPart {
  let calls = 0;
  let micro = 0;
  let unpriced = 0;
  for (const g of groups) {
    calls += g.calls;
    micro += Math.round(g.frozenUsd * 1_000_000);
    unpriced += g.unrecorded;
    if (g.tokenCalls === 0) continue;
    const priced =
      g.model === null
        ? null
        : approxMicroUsd([
            {
              model: g.model,
              inputTokens: g.inputTokens,
              outputTokens: g.outputTokens,
              cacheReadTokens: g.cacheReadTokens,
              cacheWriteTokens: g.cacheWriteTokens,
            },
          ]);
    if (priced === null) unpriced += g.tokenCalls;
    else micro += priced;
  }
  return { calls, usd: Math.round(micro / 10_000) / 100, unpriced };
}

type Row = {
  model: string | null;
  calls: number | string;
  frozen_usd: number | string | null;
  unrecorded: number | string;
  token_calls: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  cache_read_tokens: number | string;
  cache_write_tokens: number | string;
};

const groupsOf = (rows: readonly Row[]): SpendGroup[] =>
  rows.map((row) => ({
    model: row.model,
    calls: Number(row.calls),
    frozenUsd: Number(row.frozen_usd ?? 0),
    unrecorded: Number(row.unrecorded),
    tokenCalls: Number(row.token_calls),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
  }));

async function calcPart(from: Date, to: Date): Promise<AiSpendPart> {
  // `outcome` NULL = a calculation pass (written when the model answered);
  // 'ok' / 'failed' = a settled press. `cost_usd` wins where a row has it,
  // and a row with neither a frozen cost nor tokens has nothing to price —
  // `pressToday`'s own reading of the same press.
  const rows = (await db.execute(sql`
    SELECT model,
           count(*)::int AS calls,
           coalesce(sum(cost_usd), 0)::float8 AS frozen_usd,
           0::int AS unrecorded,
           count(*) FILTER (WHERE cost_usd IS NULL AND input_tokens + output_tokens > 0)::int AS token_calls,
           coalesce(sum(input_tokens) FILTER (WHERE cost_usd IS NULL), 0)::bigint AS input_tokens,
           coalesce(sum(output_tokens) FILTER (WHERE cost_usd IS NULL), 0)::bigint AS output_tokens,
           0::bigint AS cache_read_tokens, 0::bigint AS cache_write_tokens
      FROM ai_calc_passes
     WHERE ${inWindow(sql`created_at`, from, to)}
       AND (outcome IS NULL OR outcome IN ('ok', 'failed'))
     GROUP BY model
  `)) as unknown as Row[];
  return spendOf(groupsOf(rows));
}

async function agentPart(from: Date, to: Date): Promise<AiSpendPart> {
  const spent = sql`(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)`;
  const rows = (await db.execute(sql`
    SELECT model,
           count(*)::int AS calls,
           0::float8 AS frozen_usd,
           count(*) FILTER (WHERE ${spent} = 0)::int AS unrecorded,
           count(*) FILTER (WHERE ${spent} > 0)::int AS token_calls,
           coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
           coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
           coalesce(sum(cache_read_tokens), 0)::bigint AS cache_read_tokens,
           coalesce(sum(cache_write_tokens), 0)::bigint AS cache_write_tokens
      FROM agent_runs
     WHERE ${inWindow(sql`created_at`, from, to)}
       AND (${spent} > 0 OR outcome = 'error')
     GROUP BY model
  `)) as unknown as Row[];
  return spendOf(groupsOf(rows));
}

async function assistantPart(from: Date, to: Date): Promise<AiSpendPart> {
  // The token columns are 0145's: read through the row's json, so a server
  // one migration behind reads NULL — «no tokens» — and never a 42703.
  const tokens = (name: string) => sql`coalesce((to_jsonb(q)->>${name})::bigint, 0)`;
  const spent = sql`(${tokens('input_tokens')} + ${tokens('output_tokens')} + ${tokens('cache_read_tokens')} + ${tokens('cache_write_tokens')})`;
  const rows = (await db.execute(sql`
    SELECT to_jsonb(q)->>'model' AS model,
           count(*)::int AS calls,
           0::float8 AS frozen_usd,
           count(*) FILTER (WHERE ${spent} = 0)::int AS unrecorded,
           count(*) FILTER (WHERE ${spent} > 0)::int AS token_calls,
           coalesce(sum(${tokens('input_tokens')}), 0)::bigint AS input_tokens,
           coalesce(sum(${tokens('output_tokens')}), 0)::bigint AS output_tokens,
           coalesce(sum(${tokens('cache_read_tokens')}), 0)::bigint AS cache_read_tokens,
           coalesce(sum(${tokens('cache_write_tokens')}), 0)::bigint AS cache_write_tokens
      FROM ai_questions q
     WHERE ${inWindow(sql`q.created_at`, from, to)}
       AND (${spent} > 0 OR q.answer IS NOT NULL)
     GROUP BY 1
  `)) as unknown as Row[];
  return spendOf(groupsOf(rows));
}

/** One ledger's part, or null when it cannot be read — never a throw at the summary. */
async function part(ledger: AiLedger, read: () => Promise<AiSpendPart>): Promise<AiSpendPart | null> {
  try {
    return await read();
  } catch (err) {
    logger.warn({ err, ledger }, '[ai-spend] ledger not read');
    return null;
  }
}

/** What the three ledgers recorded in [from, to). */
export async function aiSpend(from: Date, to: Date): Promise<AiSpend> {
  const [calc, agent, assistant] = await Promise.all([
    part('calc', () => calcPart(from, to)),
    part('agent', () => agentPart(from, to)),
    part('assistant', () => assistantPart(from, to)),
  ]);
  const read = { calc, agent, assistant };
  const parts = { calc: calc ?? EMPTY, agent: agent ?? EMPTY, assistant: assistant ?? EMPTY };
  const unread = (['calc', 'agent', 'assistant'] as const).filter((ledger) => read[ledger] === null);
  const usd = Math.round((parts.calc.usd + parts.agent.usd + parts.assistant.usd) * 100) / 100;
  return {
    ...parts,
    total: {
      calls: parts.calc.calls + parts.agent.calls + parts.assistant.calls,
      usd,
      unpriced: parts.calc.unpriced + parts.agent.unpriced + parts.assistant.unpriced,
    },
    unread,
  };
}

/**
 * The window the summary's line covers.
 *
 * The daily message (and the pull, at any hour): the LAST 24 HOURS to the
 * moment it is read. Not «today»: the message goes out at 20:00, and a
 * Tashkent-day window would never show 20:00-24:00 in any daily message —
 * the hours the AI sotuvchi answers customers in. Rolling, every hour is
 * said exactly once across the evenings.
 *
 * The Monday message is the closed week, like every other figure on it:
 * whole Tashkent days, `from`'s midnight to the midnight after `to`
 * (Tashkent keeps no summer time: +05:00 all year). It ALSO carries the
 * last 24 hours on a second line (`aiDay`, the caller asks this function
 * twice): on a Monday there is no daily message, and without that line
 * Monday's own working hours were said on no evening at all.
 */
export function aiSpendWindow(input: { weekly: boolean; from: string; to: string; now: Date }): { from: Date; to: Date } {
  if (!input.weekly) return { from: new Date(input.now.getTime() - 24 * 3_600_000), to: input.now };
  const end = new Date(`${input.to}T00:00:00+05:00`);
  return { from: new Date(`${input.from}T00:00:00+05:00`), to: new Date(end.getTime() + 24 * 3_600_000) };
}
