import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The migration ledger drizzle walks, checked as a shape (#1040).
 *
 * Drizzle applies a migration only when its journal `when` is later than the
 * last one the database has applied — it never asks WHICH are missing. So a
 * migration merged and deployed ahead of a lower-numbered one (two packages
 * built side by side, each given its number up front) makes production skip
 * the lower one for ever, with no error anywhere. The tree cannot see a
 * server, but it can refuse the state that leads there: a hole in the
 * numbering is a migration that has not landed yet, and the tree holding it
 * must not be the one that deploys.
 */

/**
 * The ledger under test. An override exists for ONE purpose: proving the
 * placeholder fence below against a scratch copy of this directory (a
 * package built beside another reserves the other's slot as a placeholder,
 * and that tree must read red here while a copy with the real body reads
 * green). Never set in CI.
 */
const MIGRATIONS = process.env.MIGRATIONS_DIR_UNDER_TEST ?? 'src/modules/platform/db/migrations';
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; when: number; tag: string }[];
};
const entries = journal.entries;

describe('the migration journal', () => {
  it('is in order: every `when` later than the one before it', () => {
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i]!.when, entries[i]!.tag).toBeGreaterThan(entries[i - 1]!.when);
    }
  });

  it('names each migration by its own index, and every one has its SQL file', () => {
    const files = new Set(readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')));
    for (const e of entries) {
      expect(e.tag.slice(0, 4), e.tag).toBe(String(e.idx).padStart(4, '0'));
      expect(files.has(`${e.tag}.sql`), e.tag).toBe(true);
    }
    expect(files.size).toBe(entries.length);
  });

  it('has no hole: a lower-numbered migration still to land must land first', () => {
    expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
  });

  /*
   * A RESERVED slot never deploys (Q5 a, judge T10). Two packages built side
   * by side each get a number up front, and a base that carries both reserves
   * the other's as `SELECT 1;` so the journal has no hole — which is exactly
   * the tree this fence makes red until the real migration replaces it: a
   * placeholder that reaches main is a migration that ran and did nothing,
   * and drizzle will never run the real one under that number. No shipped
   * migration is under 40 characters of SQL (measured), so the rule is not
   * close to anything real.
   */
  it('carries no placeholder: no migration whose SQL is empty or `SELECT 1;`', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    const placeholders = files.filter((f) => {
      const body = readFileSync(join(MIGRATIONS, f), 'utf8')
        .replace(/--> statement-breakpoint/g, ' ')
        .replace(/--[^\n]*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return body === '' || /^select 1;?$/i.test(body);
    });
    expect(placeholders, `placeholder migrations: ${placeholders.join(', ')}`).toEqual([]);
  });
});
