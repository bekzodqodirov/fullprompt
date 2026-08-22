/**
 * The gate in front of model-written SQL.
 *
 * This vet is NOT the confidentiality boundary — that is the `gsr_ai_reader`
 * role's grants (migration 0080) — but it is load-bearing for one specific
 * thing: postgres.js `unsafe` executes a multi-statement string, so
 * `x) __ai LIMIT 1; RESET ROLE; SELECT … --` smuggled into the runner's wrap
 * would climb back out of the role. Refusing every semicolon and both comment
 * markers closes that whole family; the runner then binds the LIMIT as a real
 * parameter, which forces the extended protocol where the SERVER refuses a
 * second statement too (42601, probed) — two independent answers to the same
 * escape.
 *
 * Refusing a semicolon INSIDE a string literal is a false positive we accept:
 * the model reads the refusal and retries without it.
 */

export type VetRefusal = 'empty' | 'too_long' | 'multi_statement' | 'comment' | 'not_select';

export type VetResult = { ok: true; sql: string } | { ok: false; reason: VetRefusal };

export const MAX_ANALYST_SQL = 4000;

export function vetAnalystSql(raw: string): VetResult {
  // One trailing semicolon is habit, not an attack — strip it before judging.
  const sql = raw.trim().replace(/;+\s*$/, '');
  if (!sql) return { ok: false, reason: 'empty' };
  if (sql.length > MAX_ANALYST_SQL) return { ok: false, reason: 'too_long' };
  if (sql.includes(';')) return { ok: false, reason: 'multi_statement' };
  if (sql.includes('--') || sql.includes('/*')) return { ok: false, reason: 'comment' };
  if (!/^(select|with)\b/i.test(sql)) return { ok: false, reason: 'not_select' };
  return { ok: true, sql };
}
