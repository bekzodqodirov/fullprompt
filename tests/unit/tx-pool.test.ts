import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
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
 * IT FOLLOWS THE CALL, AS FAR AS THE CALL GOES, and that is the whole
 * difference between this test and the two versions before it. A list of
 * known pooled NAMES (`getSetting`, `db.`) passed clean over `submitPlan`,
 * which calls `availableByLot(...)` — an ordinary project function whose body
 * happens to run on the pool. Following one hop then passed clean over
 * `confirmReceipt`, which calls `priceControlOnReceipt(tx, …)` — a function
 * that dutifully takes the transaction and then calls `getSetting` two lines
 * from the bottom. A rule that only sees what it was told to look for is not
 * a fence, and neither is one that stops looking after a single step.
 *
 * So the pooled set is closed TRANSITIVELY: seeded with every function whose
 * body touches the module handle, then grown with everything that calls one,
 * until it stops growing. 497 seeds become 714 of the 1,258 functions in
 * `src/` — and exactly one of them was reachable from inside a transaction,
 * which is what makes a closure this wide usable as a fence rather than a
 * source of noise.
 *
 * Source-shape deliberately: the behaviour that proves it is a deadlock, and
 * a test that deadlocks the pool takes its own worker's remaining files with
 * it.
 */

const ROOT = process.cwd();

/**
 * Comments out, before anything is read as code.
 *
 * Without this the declaration scan matched the words «function for» in a
 * prose sentence, minted a pooled function called `for`, and then every
 * `for (` loop in the codebase counted as calling it — which is how a fence
 * meant to catch one deadlock reported the client-code generator instead. A
 * scan that reads comments as code is a scan that reads the codebase's own
 * explanations of the bug as the bug.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote) {
      if (ch === '\\') {
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

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

interface Declared {
  name: string;
  file: string;
  body: string;
  signature: string;
  holdsDb: boolean;
}

/**
 * Every named function in `src/`, BY NAME — and a name is a LIST.
 *
 * 114 names are declared in more than one file (`pickAssignee` is the site
 * rota's, taking a handle, and the bot draft's, which never sees a
 * transaction). A map with one slot per name kept whichever file `grep -rl`
 * listed last, and that order is the filesystem's: this container walked
 * site-assign last and passed, the CI runner walked the bot last and read the
 * rota's `pickAssignee(team, tx)` as the bot's pooled one. A fence whose
 * verdict depends on readdir order is two fences, so every declaration is
 * kept and a call is resolved to the one its caller means (`resolve`).
 */
function declaredFunctions(): Map<string, Declared[]> {
  const out = new Map<string, Declared[]>();
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'));
    const holdsDb = /import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*['"][^'"]*db\/client['"]/.test(source);
    // `function NAME` and nothing more: a generic parameter list may sit
    // between the name and its arguments, and requiring the `(` immediately
    // after the name is how `getSetting<K extends SettingKey>` — the exact
    // function this whole fence was built for — slipped straight through it.
    const declaration = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\b/g;
    let match: RegExpExecArray | null;
    while ((match = declaration.exec(source))) {
      const bodyStart = afterParens(source, match.index);
      if (bodyStart === -1) continue;
      const name = match[1]!;
      out.set(name, [
        ...(out.get(name) ?? []),
        {
          name,
          file,
          holdsDb,
          signature: parensAt(source, match.index),
          body: blockAt(source, bodyStart),
        },
      ]);
    }
  }
  return out;
}

const sources = new Map<string, string>();
function sourceOf(file: string): string {
  let text = sources.get(file);
  if (text === undefined) {
    text = stripComments(readFileSync(file, 'utf8'));
    sources.set(file, text);
  }
  return text;
}

/**
 * The declarations a call of `name` from `callerFile` can mean: the caller's
 * own file first (a module calls its own function), then the module the
 * caller imports the name from, and only when neither says — a dynamic
 * import, a re-export — EVERY declaration of that name, because a fence that
 * cannot tell must assume the worst.
 */
function resolve(declared: Map<string, Declared[]>, name: string, callerFile: string): Declared[] {
  const all = declared.get(name) ?? [];
  if (all.length <= 1) return all;
  const own = all.filter((d) => d.file === callerFile);
  if (own.length > 0) return own;
  const imports = new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`);
  const spec = imports.exec(sourceOf(callerFile))?.[1];
  if (spec) {
    const base = spec.startsWith('@/')
      ? `src/${spec.slice(2)}`
      : posix.normalize(posix.join(posix.dirname(callerFile), spec));
    const hit = all.filter((d) => [`${base}.ts`, `${base}/index.ts`].includes(d.file));
    if (hit.length > 0) return hit;
  }
  return all;
}

const keyOf = (d: Declared) => `${d.file}#${d.name}`;

/** declaration → how it reaches the database, closed transitively. */
function pooledFunctions(declared: Map<string, Declared[]>): {
  pooled: Map<string, Pooled>;
  names: Set<string>;
  seeds: number;
} {
  const found = new Map<string, Pooled>();
  const all = [...declared.values()].flat();
  for (const fn of all) {
    if (!fn.holdsDb) continue;
    if (/=\s*db\b/.test(fn.signature)) found.set(keyOf(fn), { file: fn.file, kind: 'unlessGivenTx' });
    else if (usesPool(fn.body)) found.set(keyOf(fn), { file: fn.file, kind: 'always' });
  }
  const seeds = found.size;
  // …then everything that calls one of them, until nothing new is added.
  for (let pass = 0; pass < 20; pass += 1) {
    let added = 0;
    const pooledNames = new Set([...found.keys()].map((key) => key.slice(key.indexOf('#') + 1)));
    for (const fn of all) {
      if (found.has(keyOf(fn))) continue;
      for (const reached of pooledNames) {
        if (reached === fn.name) continue;
        if (!new RegExp(`(?<![.\\w])${reached}\\s*\\(`).test(fn.body)) continue;
        if (!resolve(declared, reached, fn.file).some((d) => found.has(keyOf(d)))) continue;
        found.set(keyOf(fn), { file: fn.file, kind: 'always' });
        added += 1;
        break;
      }
    }
    if (added === 0) break;
  }
  const names = new Set([...found.keys()].map((key) => key.slice(key.indexOf('#') + 1)));
  return { pooled: found, names, seeds };
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
  const declared = declaredFunctions();
  const { pooled, names, seeds } = pooledFunctions(declared);
  const kindOf = (name: string) =>
    [...pooled.entries()].find(([key]) => key.endsWith(`#${name}`))?.[1].kind;

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
    expect([...names], 'the plain kind').toContain('getSetting');
    expect([...names], 'the handle-taking kind').toContain('availableByLot');
    expect(kindOf('availableByLot')).toBe('unlessGivenTx');
    // …and that the closure ACTUALLY RAN. Naming one transitive example here
    // was the obvious anchor and it is the wrong one: the first candidate was
    // `priceControlOnReceipt`, and fixing that very function took the anchor
    // down with it. What must stay true is that following calls finds
    // functions the direct scan does not.
    expect(pooled.size, 'the closure adds reachers the seeds do not have').toBeGreaterThan(seeds);
    expect(
      files.filter((f) => readFileSync(f, 'utf8').includes('db.transaction(')).length,
    ).toBeGreaterThan(10);
    // And nothing that is not a function: `for`, `if` and friends can only
    // get in through prose, and once in they taint everything that loops.
    for (const reserved of ['for', 'if', 'while', 'switch', 'catch', 'return']) {
      expect([...names], `${reserved} is not a function`).not.toContain(reserved);
    }
  });

  it('no transaction body calls anything that runs on the pool', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      if (!source.includes('db.transaction(')) continue;
      for (const { line, body } of transactionBodies(source)) {
        // Direct use of the module handle.
        if (usesPool(body)) offenders.push(`${file}:${line} uses the pooled db handle directly`);
        // …and the indirect route, which is the one that hides.
        for (const name of names) {
          const meant = resolve(declared, name, file)
            .map((d) => pooled.get(keyOf(d)))
            .filter((p): p is Pooled => p !== undefined);
          if (meant.length === 0) continue;
          for (const args of callsIn(body, name)) {
            // A function that TAKES a handle is fine here — as long as this
            // call actually hands it the transaction's own, and as long as
            // every declaration the call can mean takes one.
            if (meant.every((p) => p.kind === 'unlessGivenTx') && /\btx\b/.test(args)) continue;
            offenders.push(
              `${file}:${line} calls ${name}() without the transaction's handle — ` +
                `defined in ${meant.map((p) => p.file).join(', ')}`,
            );
          }
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
