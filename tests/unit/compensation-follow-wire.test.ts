import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * U-K4 (0105): a compensation NAMES a prixod (`client_transactions.receipt_id`)
 * and denormalises two of its facts — the deal and the client. Every writer
 * that moves one of those on the RECEIPT must answer for the money that
 * names it (#528, the pair rule in one direction only):
 * - the deal is an attribution the system derived, so it FOLLOWS
 *   (`followCompensationDealTx`), or the job the cargo left keeps its revenue
 *   taken back while the handover gate reads another figure;
 * - the client is who we owe, so a change is REFUSED
 *   (`'receipt_has_compensation'`) until a person re-enters it;
 * - a void is REFUSED the same way — client money is never voided by a
 *   warehouse button (#852).
 *
 * DERIVED, the calc-rekey.test.ts shape: every function body in src/ that
 * writes `.update(receipts)` is read, its `.set(...)` inspected, and the rule
 * demanded of whichever it names. Anchored on the four known writers (#720)
 * so a fence that finds nothing is red, not quietly green. Comments stripped
 * first (#725).
 */
const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'migrations' ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

interface Writer {
  path: string;
  name: string;
  body: string;
  set: string;
}

/** Every `.update(receipts)` with its enclosing function and its SET text. */
function receiptWriters(): Writer[] {
  const out: Writer[] = [];
  for (const path of files('src')) {
    const text = strip(readFileSync(path, 'utf8'));
    if (!text.includes('.update(receipts)')) continue;
    const starts = [...text.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)].map((m) => ({
      at: m.index!,
      name: m[1]!,
    }));
    for (const m of text.matchAll(/\.update\(receipts\)/g)) {
      const at = m.index!;
      const own = starts.filter((s) => s.at < at).at(-1);
      const next = starts.find((s) => s.at > at);
      const body = text.slice(own?.at ?? 0, next?.at ?? text.length);
      const whereAt = text.indexOf('.where(', at);
      const set = text.slice(at, whereAt < 0 ? text.length : whereAt);
      out.push({ path, name: own?.name ?? '(module)', body, set });
    }
  }
  return out;
}

describe('U-K4 — every receipt writer answers for the compensation that names it', () => {
  const writers = receiptWriters();

  it('finds the four writers the rule was written for', () => {
    const names = new Set(writers.map((w) => w.name));
    for (const name of ['linkReceipt', 'assignReceiptClient', 'voidReceipt', 'annulReceipt']) {
      expect(names, name).toContain(name);
    }
  });

  it('a writer that moves the deal makes the compensation follow', () => {
    const blind = writers
      .filter((w) => /\bdealId\b/.test(w.set))
      .filter((w) => !w.body.includes('followCompensationDealTx('))
      .map((w) => `${w.path}: ${w.name}`);
    expect(blind).toEqual([]);
  });

  it('a writer that moves the client, or voids the prixod, refuses while a compensation names it', () => {
    const blind = writers
      .filter((w) => /\bclientId\b|\bvoidedAt\b/.test(w.set))
      .filter((w) => !w.body.includes("'receipt_has_compensation'"))
      .map((w) => `${w.path}: ${w.name}`);
    expect(blind).toEqual([]);
  });

  it('the follow runs AFTER the receipt row is written — the UPDATE holds its lock', () => {
    const link = writers.find((w) => w.name === 'linkReceipt')!;
    expect(link.body.indexOf('followCompensationDealTx(')).toBeGreaterThan(link.body.indexOf('.update(receipts)'));
  });

  it('the found-carton notice runs after the status write commits, off the pool', () => {
    const status = strip(readFileSync('src/modules/wms/boxes/status.ts', 'utf8'));
    const hook = status.indexOf('compensatedCargoFound(');
    expect(hook, 'compensatedCargoFound is called').toBeGreaterThan(0);
    // Outside the transaction: after the last `db.transaction(` opens and
    // closes, a post-commit dynamic import like the rest of this module's
    // cross-module hooks.
    expect(status.slice(0, hook)).toMatch(/await import\(['"][^'"]*finance\/compensation['"]\)/);
  });
});
