import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Nothing may ask for a SECOND database connection while it already holds
 * one inside a transaction.
 *
 * `db` is a pool of ten, shared by the whole application. `db.transaction()`
 * reserves one of the ten for as long as its body runs, so a call inside that
 * body which goes through the pool has to wait for an eleventh. With ten such
 * transactions open at once there is no eleventh and never will be: all ten
 * sit `idle in transaction` waiting for each other, and because the pool
 * belongs to every page in the app, every screen for every person stops with
 * them until the container is restarted.
 *
 * MEASURED against the code this was written for: nine simultaneous client
 * creations finished in 121 ms, twelve never returned at all, and
 * pg_stat_activity showed exactly ten backends parked on `begin`.
 *
 * IT FOLLOWS THE CALL, and that is the whole difference between this test and
 * the first version of it. A list of known pooled NAMES (`getSetting`, `db.`)
 * passed clean over `submitPlan`, which calls `availableByLot(...)` — an
 * ordinary project function two files away whose body happens to run on the
 * pool. A rule that only sees what it was told to look for is not a fence.
 * So: find every function whose body touches the module `db` handle, then
 * refuse any transaction body that calls one of them by name.
 *
 * Source-shape deliberately: the behaviour that proves it is a deadlock, and
 * a test that deadlocks the pool takes its own worker's remaining files with
 * it.
 */

const ROOT = process.cwd();

/** The braces-balanced block starting at the first `{` at or after `from`. */
function blockAt(source: string, from: number): string {
  let depth = 0;
  let started = false;
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === '{') {
      depth += 1;
      started = true;
    } else if (source[i] === '}') {
      depth -= 1;
      if (started && depth === 0) return source.slice(from, i);
    }
  }
  return source.slice(from);
}

/** The index just past the balanced `(...)` at or after `from`, or -1. */
function afterParens(source: string, from: number): number {
  const open = source.indexOf('(', from);
  if (open === -1) return -1;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * `db.select(...)` is a query on the pool; `typeof db.transaction` is a TYPE.
 * Both were matched by the first version of this scan, which reported two
 * `lettersFor` helpers that correctly take and use their `tx` — a false
 * positive is how a fence stops being read.
 */
function usesPool(body: string): boolean {
  const stripped = body.replace(/typeof\s+db\s*\.\s*\w+/g, '');
  return /\bdb\s*\.\s*(query|select|insert|update|delete|execute|transaction)\b/.test(stripped);
}

const files = execSync("grep -rl '' --include=*.ts src", { encoding: 'utf8', cwd: ROOT })
  .trim()
  .split('\n')
  .filter(Boolean);

/** The balanced parenthesised text starting at the `(` at or after `from`. */
function parensAt(source: string, from: number): string {
  const open = source.indexOf('(', from);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1);
}

interface Pooled {
  file: string;
  /**
   * `always` — the body reaches for the module handle itself, so every call
   * runs on the pool. `unlessGivenTx` — the handle is a parameter defaulting
   * to `db`, so the call is only pooled when nobody passes one. The second
   * kind is why this scan exists in its current form: parameterising
   * `availableByLot` and then NOT passing `tx` fixed nothing and hid the
   * function from a fence that only looked at bodies.
   */
  kind: 'always' | 'unlessGivenTx';
}

/** name → how it reaches the database, for every function that can run pooled. */
function pooledFunctions(): Map<string, Pooled> {
  const found = new Map<string, Pooled>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    // Only files that actually hold the module handle can run on the pool.
    if (!/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*['"][^'"]*db\/client['"]/.test(source)) continue;
    // `function NAME` and nothing more: a generic parameter list may sit
    // between the name and its arguments, and requiring the `(` immediately
    // after the name is how `getSetting<K extends SettingKey>` — the exact
    // function this whole fence was built for — slipped straight through it.
    const declaration = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\b/g;
    let match: RegExpExecArray | null;
    while ((match = declaration.exec(source))) {
      const name = match[1]!;
      const signature = parensAt(source, match.index);
      const bodyStart = afterParens(source, match.index);
      if (bodyStart === -1) continue;
      if (/=\s*db\b/.test(signature)) {
        found.set(name, { file, kind: 'unlessGivenTx' });
      } else if (usesPool(blockAt(source, bodyStart))) {
        found.set(name, { file, kind: 'always' });
      }
    }
  }
  return found;
}

/** Every call of `name` in this body, as its argument text. */
function callsIn(body: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![.\\w])${name}\\s*\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) out.push(parensAt(body, match.index));
  return out;
}

function transactionBodies(source: string): { line: number; body: string }[] {
  const out: { line: number; body: string }[] = [];
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
    out.push({ line: source.slice(0, at).split('\n').length, body: source.slice(open + 1, i) });
    at = i;
  }
  return out;
}

describe('a transaction never reaches back into the pool', () => {
  const pooled = pooledFunctions();

  it('finds the transactions and the pooled functions at all', () => {
    // A rule nobody is subject to is not a rule — if either scan stops
    // matching (a rename, a move) this says so instead of passing on an
    // empty set.
    expect(files.length).toBeGreaterThan(100);
    expect(pooled.size).toBeGreaterThan(50);
    // Anchored on functions the scan MUST find, because both of this fence's
    // first two versions were proven by putting a real violation back and
    // watching the test stay green (#166): one because a `typeof db.` type
    // annotation counted as a query, the other because a generic signature
    // hid the function entirely.
    expect([...pooled.keys()], 'the plain kind').toContain('getSetting');
    expect([...pooled.keys()], 'the handle-taking kind').toContain('availableByLot');
    expect(pooled.get('availableByLot')?.kind).toBe('unlessGivenTx');
    expect(
      files.filter((f) => readFileSync(f, 'utf8').includes('db.transaction(')).length,
    ).toBeGreaterThan(10);
  });

  it('no transaction body calls anything that runs on the pool', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('db.transaction(')) continue;
      for (const { line, body } of transactionBodies(source)) {
        // Direct use of the module handle.
        if (usesPool(body)) offenders.push(`${file}:${line} uses the pooled db handle directly`);
        // …and the indirect route, which is the one that hides.
        for (const [name, pooledFn] of pooled) {
          for (const args of callsIn(body, name)) {
            // A function that TAKES a handle is fine here — as long as this
            // call actually hands it the transaction's own.
            if (pooledFn.kind === 'unlessGivenTx' && /\btx\b/.test(args)) continue;
            offenders.push(
              `${file}:${line} calls ${name}() without the transaction's handle — ` +
                `defined in ${pooledFn.file}`,
            );
          }
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
