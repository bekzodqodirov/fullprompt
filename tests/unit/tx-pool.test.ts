import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Nothing may ask for a SECOND database connection while it already holds
 * one inside a transaction.
 *
 * `db` is a pool of ten, shared by the whole application. `db.transaction()`
 * reserves one of the ten for as long as its body runs, so a call inside that
 * body which goes through the pool — `getSetting`, `db.query.…`, anything but
 * the `tx` handle it was given — has to wait for an eleventh. With ten such
 * transactions open at once there is no eleventh and never will be: all ten
 * connections sit `idle in transaction` waiting for each other, and because
 * the pool belongs to every page in the app, every screen for every person
 * stops with them until the container is restarted.
 *
 * This was live in createClient, where the prefix setting was read from
 * inside the transaction. MEASURED against that code: nine simultaneous
 * client creations finished in 121 ms, twelve never returned at all, and
 * pg_stat_activity showed exactly ten backends parked on `begin`.
 *
 * Source-shape, and deliberately so: the behaviour that proves it is a
 * deadlock, and a test that deadlocks takes the suite's own pool down with
 * it. This reads the code instead, and it guards all 25 files that open a
 * transaction rather than the one that got it wrong.
 */

/** Names that reach the pool, whatever handle the surrounding code holds. */
const NEEDS_A_SECOND_CONNECTION = [
  'getSetting\\(',
  'getAllSettings\\(',
  'usersWithPermission\\(',
  'listStages\\(',
  'listSources\\(',
  'getActor\\(',
  'db\\.query\\.',
  'db\\.select\\(',
  'db\\.insert\\(',
  'db\\.update\\(',
  'db\\.delete\\(',
  'db\\.execute\\(',
  'db\\.transaction\\(',
  'writeAudit\\(db',
  'emitEvent\\(db',
];

/** The body of every `db.transaction(` in the file, paren-matched. */
function transactionBodies(source: string): { line: number; body: string }[] {
  const found: { line: number; body: string }[] = [];
  let at = 0;
  while ((at = source.indexOf('db.transaction(', at)) !== -1) {
    const open = source.indexOf('(', at);
    let depth = 0;
    let i = open;
    for (; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    found.push({ line: source.slice(0, at).split('\n').length, body: source.slice(open + 1, i) });
    at = i;
  }
  return found;
}

describe('a transaction never reaches back into the pool', () => {
  const files = execSync("grep -rl 'db.transaction(' --include=*.ts src", { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);

  it('finds the transactions to check at all', () => {
    // A rule nobody is subject to is not a rule — if the grep stops matching
    // (a rename, a move) this test says so instead of passing on an empty set.
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)('%s keeps every query on its own tx handle', (file) => {
    const source = readFileSync(file, 'utf8');
    const offenders: string[] = [];
    for (const { line, body } of transactionBodies(source)) {
      for (const name of NEEDS_A_SECOND_CONNECTION) {
        const hit = new RegExp(name).exec(body);
        if (hit) offenders.push(`${file}:${line} calls ${hit[0]}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
