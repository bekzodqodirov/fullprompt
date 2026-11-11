import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { approxMicroUsd } from '../../platform/ai/model';
import { logger } from '../../platform/logger';

/**
 * What the machine cost over a window of days — the evening summary's «🤖 AI»
 * line (docs/PRIXOD-XABARI.md §B, the owner's «8 ha»).
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
 *    a question asked before that is counted and cannot be priced.
 *
 * A call is «unpriced» when it reached the model and no dollar figure can be
 * made for it: it carries no tokens, or its model has no list price. Those
 * are COUNTED and said, never summed as $0 (`ai-press.ts`'s rule).
 *
 * Not counted as calls at all: a press still `reserved` or settled
 * `no_answer` (nothing can have been generated), and an agent run that never
 * reached the model (a cap, a stand-down — no tokens of any kind).
 *
 * The window is whole Tashkent days, `from` and `to` inclusive — the window
 * every other figure of the message is read over. Three grouped statements,
 * one per ledger; a ledger that cannot be read is NAMED (`unread`) — its part
 * is empty, the other two still stand, and the line says which bill it could
 * not read rather than printing a smaller total (the summary must not fail on
 * a bill, and must not shrink one in silence either).
 */

export interface AiSpendPart {
  /** Calls that reached the model. */
  calls: number;
  /** ≈ dollars of the calls that could be priced (list price, answered calls). */
  usd: number;
  /** Calls that could not be priced — counted, and not in `usd`. */
  unpriced: number;
}

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

export type AiLedger = 'calc' | 'agent' | 'assistant';

const EMPTY: AiSpendPart = { calls: 0, usd: 0, unpriced: 0 };

/** `created_at` inside whole Tashkent days — bound as text and cast (#156). */
function inWindow(column: ReturnType<typeof sql>, from: string, to: string) {
  return sql`${column} >= (${from}::date::timestamp AT TIME ZONE 'Asia/Tashkent')
    AND ${column} < ((${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Tashkent')`;
}

interface Group {
  model: string | null;
  calls: number;
  /** Dollars already frozen on rows (the pressed kinds). */
  frozenUsd: number;
  /** Calls of this group that carry no frozen dollars and no tokens. */
  tokenless: number;
  /** Calls of this group to be priced from tokens. */
  tokenCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Pure: one ledger's groups → its part. Exported for the unit test. */
export function spendOf(groups: readonly Group[]): AiSpendPart {
  let calls = 0;
  let micro = 0;
  let unpriced = 0;
  for (const g of groups) {
    calls += g.calls;
    micro += Math.round(g.frozenUsd * 1_000_000);
    unpriced += g.tokenless;
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
  tokenless: number | string;
  token_calls: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  cache_read_tokens: number | string;
  cache_write_tokens: number | string;
};

const groupsOf = (rows: readonly Row[]): Group[] =>
  rows.map((row) => ({
    model: row.model,
    calls: Number(row.calls),
    frozenUsd: Number(row.frozen_usd ?? 0),
    tokenless: Number(row.tokenless),
    tokenCalls: Number(row.token_calls),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
  }));

async function calcPart(from: string, to: string): Promise<AiSpendPart> {
  // `outcome` NULL = a calculation pass (written when the model answered);
  // 'ok' / 'failed' = a settled press. `cost_usd` wins where a row has it.
  const rows = (await db.execute(sql`
    SELECT model,
           count(*)::int AS calls,
           coalesce(sum(cost_usd), 0)::float8 AS frozen_usd,
           count(*) FILTER (WHERE cost_usd IS NULL AND input_tokens + output_tokens = 0)::int AS tokenless,
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

async function agentPart(from: string, to: string): Promise<AiSpendPart> {
  const rows = (await db.execute(sql`
    SELECT model,
           count(*)::int AS calls,
           0::float8 AS frozen_usd,
           0::int AS tokenless,
           count(*)::int AS token_calls,
           coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
           coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
           coalesce(sum(cache_read_tokens), 0)::bigint AS cache_read_tokens,
           coalesce(sum(cache_write_tokens), 0)::bigint AS cache_write_tokens
      FROM agent_runs
     WHERE ${inWindow(sql`created_at`, from, to)}
       AND input_tokens + output_tokens + cache_read_tokens + cache_write_tokens > 0
     GROUP BY model
  `)) as unknown as Row[];
  return spendOf(groupsOf(rows));
}

async function assistantPart(from: string, to: string): Promise<AiSpendPart> {
  // The token columns are 0145's: read through the row's json, so a server
  // one migration behind reads NULL — «no tokens» — and never a 42703.
  const tokens = (name: string) => sql`coalesce((to_jsonb(q)->>${name})::bigint, 0)`;
  const spent = sql`(${tokens('input_tokens')} + ${tokens('output_tokens')} + ${tokens('cache_read_tokens')} + ${tokens('cache_write_tokens')})`;
  const rows = (await db.execute(sql`
    SELECT to_jsonb(q)->>'model' AS model,
           count(*)::int AS calls,
           0::float8 AS frozen_usd,
           count(*) FILTER (WHERE ${spent} = 0)::int AS tokenless,
           count(*) FILTER (WHERE ${spent} > 0)::int AS token_calls,
           coalesce(sum(${tokens('input_tokens')}), 0)::bigint AS input_tokens,
           coalesce(sum(${tokens('output_tokens')}), 0)::bigint AS output_tokens,
           coalesce(sum(${tokens('cache_read_tokens')}), 0)::bigint AS cache_read_tokens,
           coalesce(sum(${tokens('cache_write_tokens')}), 0)::bigint AS cache_write_tokens
      FROM ai_questions q
     WHERE ${inWindow(sql`q.created_at`, from, to)}
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

export async function aiSpend(from: string, to: string): Promise<AiSpend> {
  const [calc, agent, assistant] = await Promise.all([
    part('calc', () => calcPart(from, to)),
    part('agent', () => agentPart(from, to)),
    part('assistant', () => assistantPart(from, to)),
  ]);
  const parts = { calc: calc ?? EMPTY, agent: agent ?? EMPTY, assistant: assistant ?? EMPTY };
  const unread = (['calc', 'agent', 'assistant'] as const).filter(
    (ledger) => ({ calc, agent, assistant })[ledger] === null,
  );
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
