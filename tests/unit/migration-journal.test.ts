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

const MIGRATIONS = 'src/modules/platform/db/migrations';
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
});
