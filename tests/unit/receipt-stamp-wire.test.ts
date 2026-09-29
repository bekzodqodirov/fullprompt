import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The receipt's seller stamp (0117, his 2a) is written in the SAME statement
 * as the client, by every writer — so no reader ever sees a claimed prixod
 * with nobody on it, and a claim or a correction can never leave the stamp
 * on the previous owner's seller. DERIVED: every drizzle `insert(receipts)`
 * and every `update(receipts).set({…})` that names `clientId`, anywhere in
 * src/ or scripts/, must name `salesManagerId` in the same object. A new
 * writer is red the day it is written (#896's shape).
 *
 * Scope stated: the `scripts/dev-walk-*.mjs` probes write throwaway local
 * rows in raw SQL; a missing stamp there reads as «sotuvchisiz», which is the
 * honest answer about a row nobody sold.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The balanced `{…}` starting at `open` (an index of `{`). */
function objectAt(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

const FILES = [...globSync('src/**/*.{ts,tsx}'), ...globSync('scripts/**/*.ts')];

function writers(kind: 'insert' | 'update'): { path: string; body: string }[] {
  const out: { path: string; body: string }[] = [];
  const opener = kind === 'insert' ? /\.insert\(receipts\)\s*\.values\(\s*\{/g : /\.update\(receipts\)\s*\.set\(\s*\{/g;
  for (const path of FILES) {
    const source = stripComments(readFileSync(path, 'utf8'));
    for (const match of source.matchAll(opener)) {
      out.push({ path, body: objectAt(source, match.index! + match[0].length - 1) });
    }
  }
  return out;
}

describe('the seller stamp rides with the client', () => {
  it('finds the writers it guards', () => {
    expect(writers('insert').map((w) => w.path)).toContain('src/modules/wms/receipts/service.ts');
    const updates = writers('update').filter((w) => /\bclientId\b/.test(w.body));
    expect(updates.map((w) => w.path)).toContain('src/modules/wms/receipts/edit.ts');
  });

  it('every insert(receipts) names salesManagerId', () => {
    const offenders = writers('insert')
      .filter((w) => !/\bsalesManagerId\s*:/.test(w.body))
      .map((w) => w.path);
    expect(offenders).toEqual([]);
  });

  it('every update(receipts) that moves clientId moves salesManagerId with it', () => {
    const offenders = writers('update')
      .filter((w) => /\bclientId\b/.test(w.body) && !/\bsalesManagerId\s*:/.test(w.body))
      .map((w) => w.path);
    expect(offenders).toEqual([]);
  });

  it('the stamp is read off the client IN the statement, never passed in from a read before it', () => {
    for (const w of [...writers('insert'), ...writers('update').filter((u) => /\bclientId\b/.test(u.body))]) {
      // An unclaimed prixod binds no client and stamps NULL (`clientId ? … : null`).
      expect(w.body, w.path).toMatch(/salesManagerId:\s*(?:[\w.]+\s*\?\s*)?stampFor\(/);
    }
  });

  it('no raw SQL in src/ inserts a receipt or rewrites its client behind the fence', () => {
    const offenders: string[] = [];
    for (const path of globSync('src/**/*.{ts,tsx}')) {
      const source = stripComments(readFileSync(path, 'utf8'));
      if (/INSERT\s+INTO\s+receipts\b/i.test(source) && !/sales_manager_id/.test(source)) offenders.push(path);
      // The SET list alone — a `WHERE client_id = …` is a read, not a move.
      for (const m of source.matchAll(/UPDATE\s+receipts\b(?:\s+\w+)?\s+SET\s+([\s\S]*?)\bWHERE\b/gi)) {
        if (/\bclient_id\s*=/.test(m[1]!) && !/sales_manager_id\s*=/.test(m[1]!)) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});
