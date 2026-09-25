import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * F2 (0103, design §5.5.4): EVERY writer of a ledger row that can move a
 * currency cycle takes the account's money lock before its first write and
 * runs the kurs farqi reconciler after it — in the same transaction, or a
 * crash in between leaves a client blocked at the warehouse over a residue
 * nobody closed. DERIVED, the way `tx-pool.test.ts` derives the pooled set:
 * the fence finds the writers from the code, so a writer added next month is
 * judged without anyone remembering this file — and it is anchored on the
 * names it MUST find (#720), or a regex that stopped matching would pass
 * everything by finding nothing.
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

/** Top-level functions, each with the text up to the next top-level declaration. */
function functionsOf(text: string): { name: string; body: string }[] {
  const starts = [...text.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)];
  const next = [...text.matchAll(/^(?:export |async |function |const |let |class |interface |type |\})/gm)].map(
    (m) => m.index!,
  );
  return starts.map((m) => {
    const end = next.find((index) => index > m.index! + 1) ?? text.length;
    return { name: m[1]!, body: text.slice(m.index!, end) };
  });
}

const WRITES = [
  /\.insert\((?:clientTransactions|partnerTransactions)\)/,
  /\.update\((?:clientTransactions|partnerTransactions)\)\s*\.set\(\{[^}]*\b(?:voidedAt|amountUsd)\b/,
  /INSERT INTO (?:client_transactions|partner_transactions)\b/i,
  /UPDATE (?:client_transactions|partner_transactions)\s+SET[^`;]*\b(?:voided_at|amount_usd)\b/i,
];

function writers() {
  const out: { file: string; name: string; first: number; body: string }[] = [];
  for (const file of files('src')) {
    if (file.endsWith('finance/fx-residue.ts')) continue; // the reconciler itself
    for (const fn of functionsOf(strip(readFileSync(file, 'utf8')))) {
      const hits = WRITES.map((re) => fn.body.search(re)).filter((index) => index >= 0);
      if (hits.length) out.push({ file, name: fn.name, first: Math.min(...hits), body: fn.body });
    }
  }
  return out;
}

describe('F2 — every ledger writer locks the account and reconciles its kurs farqi', () => {
  const found = writers();

  it('finds the writers it must (anchored on names)', () => {
    const names = new Set(found.map((writer) => writer.name));
    for (const name of [
      'addTransaction',
      'voidTransaction',
      'recordSettlement',
      'addPartnerTx',
      'voidPartnerTx',
      'chargeForCost',
      'voidChargeForCost',
      'chargeForExpense',
      'voidChargeForExpense',
      'voidCostEntryInTx',
      'closeLegacyFxResidue',
      'closeCrossCurrencyResidue',
      'voidFxClose',
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it('each takes the lock before its first write and reconciles after it', () => {
    const offenders = found
      .filter(({ body, first }) => {
        const lock = body.indexOf('lockOwnersTx(');
        const reconcile = body.lastIndexOf('reconcileFxResidueTx(');
        return lock < 0 || lock > first || reconcile < first;
      })
      .map(({ file, name }) => `${file}:${name}`);
    expect(offenders).toEqual([]);
  });
});
