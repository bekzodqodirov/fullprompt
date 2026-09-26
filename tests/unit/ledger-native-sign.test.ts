import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIENT_KINDS, CLIENT_NATIVE_SIGN } from '@/modules/wms/finance/ledger-kinds';
import { PARTNER_NATIVE_SIGN, PARTNER_TX_TYPES } from '@/modules/wms/partners/ledger-sign';

/**
 * F6 + F3 (0103): the ledgers' sign tables against the DATABASE's own list of
 * kinds, and the partner sign CASE kept in its one home.
 *
 * F6 reads the migrations' latest `…_type_check` text — the source of truth
 * outside the TypeScript (#163's rule: comparing two TS tables to each other
 * cannot catch a kind missing from both). Every kind the table may store,
 * except the system's `fx_diff` (native 0 by CHECK, it never walks), must
 * say which way it moves the account's own currency, or the kurs farqi walk
 * reads it as 0 and closes a cycle that is not closed.
 */
const MIGRATIONS = 'src/modules/platform/db/migrations';

function latestKinds(constraint: string): string[] {
  const texts = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(join(MIGRATIONS, name), 'utf8'));
  const re = new RegExp(`${constraint}\\s+CHECK \\(type IN \\(([^)]*)\\)\\)`, 'g');
  let last: string | null = null;
  for (const text of texts) for (const m of text.matchAll(re)) last = m[1]!;
  expect(last, constraint).not.toBeNull();
  return [...last!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

describe('F6 — every stored kind walks its own currency', () => {
  it('the client ledger', () => {
    const kinds = latestKinds('client_transactions_type_check');
    expect(new Set(kinds)).toEqual(new Set(CLIENT_KINDS));
    for (const kind of kinds.filter((k) => k !== 'fx_diff')) {
      expect(CLIENT_NATIVE_SIGN, kind).toHaveProperty(kind);
    }
  });

  it('the partner ledger', () => {
    const kinds = latestKinds('partner_tx_type_check');
    expect(new Set(kinds)).toEqual(new Set(PARTNER_TX_TYPES));
    for (const kind of kinds.filter((k) => k !== 'fx_diff')) {
      expect(PARTNER_NATIVE_SIGN, kind).toHaveProperty(kind);
    }
  });
});

const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'migrations' ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('F3 — the partner sign CASE has one home (regression-10)', () => {
  it('no file but partners/ledger-sign.ts restates it', () => {
    const offenders = files('src').filter(
      (path) =>
        !path.endsWith('partners/ledger-sign.ts') &&
        /IN \('charge', 'receipt'[^)]*\)\s*THEN/.test(strip(readFileSync(path, 'utf8'))),
    );
    expect(offenders).toEqual([]);
  });
});
