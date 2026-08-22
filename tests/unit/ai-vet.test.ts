import { describe, expect, it } from 'vitest';
import { MAX_ANALYST_SQL, vetAnalystSql } from '@/modules/platform/ai/vet';

/**
 * The vet is the first fence under model-written SQL and the only one that
 * stops the multi-statement smuggle (`x) __ai LIMIT 1; RESET ROLE; … --`) —
 * postgres.js `unsafe` EXECUTES a multi-statement string, probed before this
 * shipped. The refusals are judged as a table: pass or refuse, with the
 * reason named, because the model reads the reason and retries.
 */
describe('vetAnalystSql', () => {
  it('passes a plain SELECT and a WITH, case-insensitively', () => {
    expect(vetAnalystSql('SELECT 1')).toEqual({ ok: true, sql: 'SELECT 1' });
    expect(vetAnalystSql('  select client_code from clients  ')).toEqual({
      ok: true,
      sql: 'select client_code from clients',
    });
    expect(vetAnalystSql('WITH x AS (SELECT 1) SELECT * FROM x').ok).toBe(true);
    expect(vetAnalystSql('wiTH x AS (SELECT 1) SELECT * FROM x').ok).toBe(true);
  });

  it('strips one trailing semicolon — habit, not an attack', () => {
    expect(vetAnalystSql('SELECT 1;')).toEqual({ ok: true, sql: 'SELECT 1' });
    expect(vetAnalystSql('SELECT 1;;  ')).toEqual({ ok: true, sql: 'SELECT 1' });
  });

  it('refuses every interior semicolon — the RESET ROLE smuggle', () => {
    const smuggle = "x) __ai LIMIT 1; RESET ROLE; SELECT * FROM sessions --";
    expect(vetAnalystSql(`SELECT ${smuggle}`)).toEqual({ ok: false, reason: 'multi_statement' });
    // Even inside a string literal: a false positive the model retries around.
    expect(vetAnalystSql("SELECT ';' AS c")).toEqual({ ok: false, reason: 'multi_statement' });
  });

  it('refuses comment markers — they could hide the wrap’s tail', () => {
    expect(vetAnalystSql('SELECT 1 -- tail')).toEqual({ ok: false, reason: 'comment' });
    expect(vetAnalystSql('SELECT /* x */ 1')).toEqual({ ok: false, reason: 'comment' });
  });

  it('refuses anything that is not a SELECT/WITH', () => {
    expect(vetAnalystSql('UPDATE clients SET name = name')).toEqual({
      ok: false,
      reason: 'not_select',
    });
    expect(vetAnalystSql('RESET ROLE')).toEqual({ ok: false, reason: 'not_select' });
    expect(vetAnalystSql('EXPLAIN SELECT 1')).toEqual({ ok: false, reason: 'not_select' });
    // SELECT as a prefix of another word is not the keyword.
    expect(vetAnalystSql('SELECTX 1').ok).toBe(false);
  });

  it('refuses empty and oversized input', () => {
    expect(vetAnalystSql('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(vetAnalystSql(';')).toEqual({ ok: false, reason: 'empty' });
    expect(vetAnalystSql(`SELECT '${'x'.repeat(MAX_ANALYST_SQL)}'`)).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });
});
