import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  HINT_KEYS,
  hintOf,
  STATE_CLASS,
  STATE_KEY,
  stateKeyOf,
} from '@/app/(protected)/upsale/state-words';
import type { DealCargoPaid } from '@/modules/wms/finance/paid-cartons';

/**
 * /upsale's words for his 3a — the chip and the «why it waits» hint.
 *
 * The keys are handed out at RUNTIME (`t(stateKeyOf(r))`, `t(hint.key)`), so
 * the literal-key fence cannot see them: they are checked here against all
 * four bundles, anchored on the lists the page itself reads (#163).
 */
const BUNDLES = ['uz', 'ru', 'en', 'zh-CN'].map((locale) => ({
  locale,
  upsale: (JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as { upsale: Record<string, string> }).upsale,
}));

describe('every runtime key has its words in all four bundles (#163)', () => {
  const keys = [...new Set([...Object.values(STATE_KEY), 'stCargoLost', ...HINT_KEYS, 'notComputedPage', 'paidRule'])];

  it('found the keys to check', () => {
    expect(keys.length).toBeGreaterThanOrEqual(15);
  });

  for (const { locale, upsale } of BUNDLES) {
    it(`${locale}`, () => {
      const missing = keys.filter((key) => typeof upsale[key] !== 'string' || upsale[key]!.trim() === '');
      expect(missing, `missing in ${locale}`).toEqual([]);
    });
  }
});

describe('the chip', () => {
  it('an unknown is a warning, never the neutral grey of a settled fact', () => {
    expect(STATE_CLASS.not_computed).not.toBe('chip chip-neutral');
  });

  it('arrived and all gone is «Yuk qolmagan», never arrived is «Yuk kelmagan»', () => {
    expect(stateKeyOf({ state: 'no_cargo', cargoReceipts: 1 })).toBe('stCargoLost');
    expect(stateKeyOf({ state: 'no_cargo', cargoReceipts: 0 })).toBe('stNoCargo');
    expect(stateKeyOf({ state: 'payable', cargoReceipts: 1 })).toBe('stPayable');
  });
});

const w = (over: Partial<DealCargoPaid> = {}): DealCargoPaid => ({
  cartons: 1,
  uncovered: 0,
  uncoveredElsewhere: 0,
  unpaid: 1,
  ownChargesOwed: 1,
  toOpenUsd: 1300,
  olderOwedElsewhere: false,
  ...over,
});
const money = (usd: number) => `$${usd.toFixed(2)}`;

describe('the hint', () => {
  it('names the client’s money only to whom round 91 already shows it', () => {
    const row = { state: 'awaiting_payment' as const, cargoReceipts: 1, cargoWalk: w() };
    expect(hintOf(row, { seesMoney: false, money })).toBeNull();
    expect(hintOf(row, { seesMoney: true, money })).toEqual({ key: 'fifoToOpen', values: { amount: '$1300.00' } });
  });

  it('says the money went to an older debt first', () => {
    const row = { state: 'awaiting_payment' as const, cargoReceipts: 1, cargoWalk: w({ olderOwedElsewhere: true, toOpenUsd: 1800 }) };
    expect(hintOf(row, { seesMoney: true, money })).toEqual({ key: 'fifoToOpenOlder', values: { amount: '$1800.00' } });
  });

  it('tells a price written but not ridden from one really missing', () => {
    expect(
      hintOf(
        { state: 'no_invoice', cargoReceipts: 1, cargoWalk: w({ uncovered: 1, uncoveredElsewhere: 1, cartons: 2 }) },
        { seesMoney: true, money },
      ),
    ).toEqual({ key: 'fifoPricedElsewhere', values: { uncovered: 1, cartons: 2 } });
    expect(
      hintOf(
        { state: 'no_invoice', cargoReceipts: 1, cargoWalk: w({ uncovered: 2, uncoveredElsewhere: 0, cartons: 3 }) },
        { seesMoney: false, money },
      ),
    ).toEqual({ key: 'fifoUncovered', values: { uncovered: 2, cartons: 3 } });
  });

  it('the invoice check before the walk has no hint of its own (the chip says it)', () => {
    expect(hintOf({ state: 'no_invoice', cargoReceipts: 1, cargoWalk: null }, { seesMoney: true, money })).toBeNull();
  });

  it('an unknown says so, and cargo that is all gone says where it went', () => {
    expect(hintOf({ state: 'not_computed', cargoReceipts: 1, cargoWalk: null }, { seesMoney: false, money })).toEqual({
      key: 'fifoNotComputed',
      values: {},
    });
    expect(
      hintOf({ state: 'no_cargo', cargoReceipts: 1, cargoWalk: w({ cartons: 0 }) }, { seesMoney: false, money }),
    ).toEqual({ key: 'fifoNoLive', values: {} });
  });
});
