import { describe, expect, it } from 'vitest';
import { pp3818Records, pp3818Rows, PP3818_FROM } from '@/modules/wms/calc/rates-seed';
import { codePrefixes } from '@/modules/wms/calc/dictionaries';

/**
 * The fence around the parsed PP-3818 table (VED 2.0 phase 1).
 *
 * The JSON was machine-parsed out of the owner's lex.uz export, and a parser
 * bug re-run tomorrow would change the LAW as this system reads it — so the
 * counts and a handful of hand-checked rows are pinned here against the
 * source document, not against the parser. If a regeneration moves any of
 * these numbers, the diff is a question to answer, never noise to accept.
 */

describe('the parsed PP-3818 table', () => {
  const records = pp3818Records();
  const byCode = new Map(records.map((r) => [r.code, r]));

  it('holds exactly the rows the source held', () => {
    expect(records).toHaveLength(1489);
    const modes = { advalor: 0, max: 0, plus: 0 };
    for (const r of records) modes[r.mode] += 1;
    expect(modes).toEqual({ advalor: 1250, max: 198, plus: 41 });
  });

  it('codes are digit prefixes at the law’s own grains, no duplicates', () => {
    const lengths = new Set(records.map((r) => r.code.length));
    expect([...lengths].sort()).toEqual([10, 4, 6, 8, 9]);
    for (const r of records) expect(r.code).toMatch(/^\d+$/);
    expect(new Set(records.map((r) => r.code)).size).toBe(records.length);
  });

  it('every non-advalor row carries BOTH halves; no advalor row carries one', () => {
    for (const r of records) {
      if (r.mode === 'advalor') {
        expect(r.specific, r.code).toBeUndefined();
        expect(r.unit, r.code).toBeUndefined();
      } else {
        expect(r.specific, r.code).toBeGreaterThanOrEqual(0);
        expect(r.unit, r.code).toBeTruthy();
      }
    }
  });

  it('hand-checked rows read exactly as the decree prints them', () => {
    // Guide example codes first — the engine tests price these.
    expect(byCode.get('6102')).toMatchObject({ mode: 'max', pct: 20, specific: 3, unit: 'dona' });
    expect(byCode.get('5703')).toMatchObject({ mode: 'max', pct: 30, specific: 0.7, unit: 'kg' });
    expect(byCode.get('3924')).toMatchObject({ mode: 'advalor', pct: 20 });
    // The prefix pair the lookup test leans on.
    expect(byCode.get('6403')).toMatchObject({ mode: 'max', pct: 20, specific: 3, unit: 'juft' });
    expect(byCode.get('6403120000')).toMatchObject({ mode: 'advalor', pct: 5 });
    // A furniture MAX row and an electronics advalor row.
    expect(byCode.get('9403')).toMatchObject({ mode: 'max', pct: 15, specific: 0.4, unit: 'kg' });
    expect(byCode.get('8528')).toMatchObject({ mode: 'advalor', pct: 10 });
    // A vehicle 'plus' row: 70 % + $3/sm³.
    expect(byCode.get('8701299011')).toMatchObject({
      mode: 'plus',
      pct: 70,
      specific: 3,
      unit: 'sm3',
    });
  });

  it('598 zero-percent rows exist — without a certificate they still pay +5 %', () => {
    expect(records.filter((r) => r.mode === 'advalor' && r.pct === 0)).toHaveLength(598);
  });
});

describe('the seed rows', () => {
  const rows = pp3818Rows();

  it('every row carries VAT 12 and fee 0 under a FIXED date and its own source', () => {
    // vat 12 is J10's blocker: `pullRates` copies the dictionary verbatim, so
    // a seed that left the column default would price every job VAT-free.
    // fee 0 because the fee is the DECLARATION's (customsFeeFor), not the
    // code's. The constant date is the idempotence: same (code, date) pairs
    // every run, so ON CONFLICT DO NOTHING never touches a person's row.
    expect(PP3818_FROM).toBe('2026-01-01');
    for (const r of rows) {
      expect(r.vatPct).toBe('12.000');
      expect(r.feeUsd).toBe('0.00');
      expect(r.effectiveDate).toBe(PP3818_FROM);
      expect(r.source).toBe('pp3818');
    }
  });
});

describe('the prefix walk the lookup is built on', () => {
  it('longest first, down to the 4-digit heading', () => {
    expect(codePrefixes('6403520000')).toEqual([
      '6403520000',
      '640352000',
      '64035200',
      '6403520',
      '640352',
      '64035',
      '6403',
    ]);
    expect(codePrefixes('6403')).toEqual(['6403']);
    expect(codePrefixes(' 6403 ')).toEqual(['6403']);
  });
});
