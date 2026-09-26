import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_KINDS,
  CREDIT_KINDS,
  FEED_KINDS,
  LEDGER_FEED,
  LEDGER_RULES,
  LEDGER_TYPES,
  REVENUE_TYPES,
  isClientPayout,
  receivedUsd,
  revenueUsd,
  settlesUsd,
  signedUsd,
} from '@/modules/wms/finance/ledger-kinds';
import { TX_VIEW } from '@/modules/platform/telegram/client-labels';
import { FEED_LABELS } from '@/components/client-feed';

/**
 * U-K2 (0105): the client ledger's kinds said ONCE (`ledger-kinds.ts`) and
 * every other list held to it — the TypeScript tables to each other, and all
 * of them to the DATABASE's own text (#163: comparing two TS tables cannot
 * catch a kind missing from both).
 *
 * The compensation is where this earns its keep: a kind that lowers the
 * balance like a payment but moves no kassa and is revenue taken back. Every
 * place that restated «payment is the only credit» would have read it as a
 * DEBT — the cabinet among them, which platform code draws and which cannot
 * import this module, so its table (`TX_VIEW`) is checked from here.
 */
const MIGRATIONS = 'src/modules/platform/db/migrations';

/** Every migration's text, in the JOURNAL's order (the order drizzle applies them). */
function migrationsInOrder(): string[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), 'utf8'));
}

/** The last match of `re` across the migrations, its first group. */
function latest(re: RegExp): string {
  let last: string | null = null;
  for (const text of migrationsInOrder()) for (const m of text.matchAll(re)) last = m[1]!;
  expect(last, String(re)).not.toBeNull();
  return last!;
}

const kindsIn = (list: string) => [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);

describe('U-K2 — the ledger kinds are one list', () => {
  it('the rules answer for exactly the stored kinds', () => {
    expect(Object.keys(LEDGER_RULES)).toEqual([...CLIENT_KINDS]);
    expect(Object.keys(LEDGER_FEED)).toEqual([...CLIENT_KINDS]);
  });

  it('a person types charges, payments and refunds; the compensation has its own door', () => {
    for (const kind of LEDGER_TYPES) expect(CLIENT_KINDS).toContain(kind);
    expect(LEDGER_TYPES).not.toContain('compensation');
    expect(LEDGER_TYPES).not.toContain('fx_diff');
  });

  it('the compensation lowers the balance, is a price taken back and is never money received', () => {
    expect(LEDGER_RULES.compensation).toEqual({ balance: -1, revenue: -1, received: 0 });
    expect(CREDIT_KINDS).toEqual(['payment', 'compensation']);
    expect(REVENUE_TYPES).toEqual(['charge', 'compensation']);
    expect(isClientPayout('compensation')).toBe(true);
    expect(isClientPayout('refund')).toBe(true);
    expect(isClientPayout('payment')).toBe(false);
  });

  it('the cabinet shows every lenta kind, and signs exactly the credits', () => {
    expect(new Set(Object.keys(TX_VIEW))).toEqual(new Set(FEED_KINDS));
    for (const [kind, view] of Object.entries(TX_VIEW)) {
      const balance = LEDGER_RULES[kind as keyof typeof LEDGER_RULES].balance;
      expect(view.sign === '+', kind).toBe(balance === -1);
    }
  });

  it('the lenta draws every kind it shows (a literal label each, #163)', () => {
    for (const kind of FEED_KINDS) expect(FEED_LABELS, kind).toHaveProperty(kind);
  });

  it('the database stores exactly these kinds (the latest CHECK, journal order)', () => {
    const list = latest(/client_transactions_type_check\s+CHECK \(type IN \(([^)]*)\)\)/g);
    expect(new Set(kindsIn(list))).toEqual(new Set(CLIENT_KINDS));
  });

  it('the AI’s money view credits exactly the credit kinds (the latest view, journal order)', () => {
    const view = latest(/CREATE OR REPLACE VIEW v_client_balance_usd AS([\s\S]*?);/g);
    const credit = /CASE WHEN type IN \(([^)]*)\) THEN -amount_usd ELSE amount_usd END/.exec(view);
    expect(credit, 'the view’s sign CASE').not.toBeNull();
    expect(new Set(kindsIn(credit![1]!))).toEqual(new Set(CREDIT_KINDS));
  });
});

describe('U-K1 (i) — each kind’s arithmetic, read from its rule', () => {
  const row = (type: string, amountUsd = 100) => ({ type, amountUsd });

  it('the balance', () => {
    expect(signedUsd(row('charge'))).toBe(100);
    expect(signedUsd(row('refund'))).toBe(100);
    expect(signedUsd(row('payment'))).toBe(-100);
    expect(signedUsd(row('compensation'))).toBe(-100);
    // A signed kind carries its own sign, both ways.
    expect(signedUsd(row('fx_diff', 7))).toBe(7);
    expect(signedUsd(row('fx_diff', -7))).toBe(-7);
  });

  it('the revenue: a price, and a price taken back', () => {
    expect(revenueUsd(row('charge'))).toBe(100);
    expect(revenueUsd(row('compensation'))).toBe(-100);
    for (const type of ['payment', 'refund', 'fx_diff']) expect(revenueUsd(row(type)), type).toBe(0);
  });

  it('money received: a payment in, a refund out, a compensation neither', () => {
    expect(receivedUsd(row('payment'))).toBe(100);
    expect(receivedUsd(row('refund'))).toBe(-100);
    for (const type of ['charge', 'compensation', 'fx_diff']) expect(receivedUsd(row(type)), type).toBe(0);
  });

  it('what settles a price: every non-price row, by its balance sign', () => {
    expect(settlesUsd(row('charge'))).toBe(0);
    expect(settlesUsd(row('payment'))).toBe(100);
    expect(settlesUsd(row('compensation'))).toBe(100);
    expect(settlesUsd(row('refund'))).toBe(-100);
    expect(settlesUsd(row('fx_diff', -7))).toBe(7);
  });
});
