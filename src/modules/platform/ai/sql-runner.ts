import { pgClient } from '../db/client';
import { logger } from '../logger';
import { vetAnalystSql } from './vet';

/**
 * Run one vetted, model-written SELECT under the full fence stack.
 *
 * Four fences, each of which alone stops a class of escape, all of them
 * probed against a live database before this shipped:
 *  1. `vetAnalystSql` — single SELECT/WITH statement, no comments (vet.ts).
 *  2. The LIMIT is a BOUND parameter, which forces the extended protocol —
 *     the server itself refuses a smuggled second statement (42601).
 *  3. `BEGIN READ ONLY` — a CTE hiding DML dies with 25006 even though the
 *     vet cannot parse it out.
 *  4. `SET LOCAL ROLE gsr_ai_reader` — the confidentiality boundary: the
 *     role's explicit grants (0079) are what keep sessions, password hashes
 *     and Telegram session blobs out of the model's context. permission
 *     denied (42501) comes back as an ordinary error the model can read.
 *
 * EVERYTHING runs on the ONE connection `.begin` reserves — `tx`, never the
 * module-level `db`/`pgClient` — because SET LOCAL lives on a socket, and a
 * query issued through the pool would run as the app's own superuser on a
 * read-write connection with no fence at all. That is the difference between
 * this file being a fence and being a decoration.
 *
 * If the role is missing — a dump restored onto a fresh cluster carries the
 * grants but not the cluster-wide role — SET LOCAL ROLE throws and we FAIL
 * CLOSED with a loud log: the query is refused rather than run unfenced. The
 * fix is the standing restore rule, `docker compose run --rm migrate`.
 */

export const ANALYST_ROW_CAP = 200;
const CELL_CAP = 400;
const DEFAULT_TIMEOUT_MS = 5_000;

export type AnalystSqlResult =
  | { ok: true; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean }
  | { ok: false; error: string };

export async function runAnalystSql(
  raw: string,
  opts: { timeoutMs?: number } = {},
): Promise<AnalystSqlResult> {
  const vetted = vetAnalystSql(raw);
  if (!vetted.ok) return { ok: false, error: `refused: ${vetted.reason}` };
  const timeoutMs = Math.min(Math.max(Math.round(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS), 100), 15_000);

  try {
    const rows = await pgClient.begin('read only', async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
      await tx.unsafe(`SET LOCAL ROLE gsr_ai_reader`);
      // Belt over the braces: if SET ROLE ever silently failed to engage,
      // refuse to run at all rather than run as the app user.
      const who = await tx.unsafe(`SELECT current_user AS u`);
      if (who[0]?.u !== 'gsr_ai_reader') {
        throw new Error('fence: gsr_ai_reader did not engage');
      }
      return tx.unsafe(`SELECT * FROM ( ${vetted.sql} ) __ai LIMIT $1`, [ANALYST_ROW_CAP + 1]);
    });

    const list = rows as unknown as Record<string, unknown>[];
    const truncated = list.length > ANALYST_ROW_CAP;
    return {
      ok: true,
      rows: list.slice(0, ANALYST_ROW_CAP).map(serializeRow),
      rowCount: Math.min(list.length, ANALYST_ROW_CAP),
      truncated,
    };
  } catch (err) {
    // The error TEXT is the tool result — «permission denied for table
    // sessions» or a syntax error is exactly what lets the model correct
    // itself on the next round. Never rethrown: a bad query is an answer.
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('fence:') || /gsr_ai_reader.*does not exist/i.test(message)) {
      logger.error({ err }, '[ai] analyst fence did not engage — run migrations');
      return { ok: false, error: 'fence unavailable — migrations incomplete' };
    }
    return { ok: false, error: message.slice(0, 500) };
  }
}

/** Dates → ISO, long text → capped; numeric already arrives as text. */
function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) out[key] = value.toISOString();
    else if (typeof value === 'string' && value.length > CELL_CAP) out[key] = `${value.slice(0, CELL_CAP)}…`;
    else out[key] = value;
  }
  return out;
}
