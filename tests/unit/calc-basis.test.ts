import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultBasisFor, uniformBazaOf } from '@/modules/wms/calc/basis';

/**
 * Phase 4, items 1+3 — the law-unit default and the block's one baza, plus
 * the payable predicate's anchor guards as SOURCE SHAPE (a NULL-evaluating
 * clause silently drops a request-anchored row, so the guards' existence is
 * the fence).
 */
describe('defaultBasisFor — the code says the unit, totally', () => {
  const cases: [string | null, string][] = [
    ['m2', 'm2'],
    ['juft', 'juft'],
    ['litr', 'litr'],
    ['kg', 'kg'],
    // A per-piece law prices per piece — and sm³ NEVER becomes a basis:
    // nobody values a vehicle by displacement (#868).
    ['dona', 'unit'],
    ['1000_dona', 'unit'],
    ['sm3', 'unit'],
    [null, 'unit'],
  ];
  for (const [dutyUnit, want] of cases) {
    it(`${dutyUnit ?? 'advalor'} → ${want}`, () => {
      expect(defaultBasisFor({ dutyUnit })).toBe(want);
    });
  }
  it('no group at all → unit', () => {
    expect(defaultBasisFor(null)).toBe('unit');
  });
});

describe('uniformBazaOf — one number only when it IS one number', () => {
  it('a uniform pair comes back', () => {
    expect(
      uniformBazaOf([
        { bazaUsd: 2, bazaBasis: 'kg' },
        { bazaUsd: 2, bazaBasis: 'kg' },
      ]),
    ).toEqual({ bazaUsd: 2, bazaBasis: 'kg' });
  });
  it('mixed amounts have no one number', () => {
    expect(
      uniformBazaOf([
        { bazaUsd: 2, bazaBasis: 'kg' },
        { bazaUsd: 3, bazaBasis: 'kg' },
      ]),
    ).toBeNull();
  });
  it('the BASIS is part of the price — same amount, different unit, no line', () => {
    expect(
      uniformBazaOf([
        { bazaUsd: 2, bazaBasis: 'kg' },
        { bazaUsd: 2, bazaBasis: 'unit' },
      ]),
    ).toBeNull();
  });
  it('an unpriced member and an empty block both refuse', () => {
    expect(uniformBazaOf([{ bazaUsd: null, bazaBasis: null }])).toBeNull();
    expect(uniformBazaOf([])).toBeNull();
  });
});

describe('the payable predicate carries BOTH anchor guards (source shape)', () => {
  const upsale = readFileSync('src/modules/wms/calc/upsale.ts', 'utf8');
  const workspace = readFileSync('src/modules/wms/calc/workspace.ts', 'utf8');
  const versionSet = readFileSync('src/modules/wms/calc/version-set.ts', 'utf8');

  it('payableOffersSql guards every version-only clause and floors by COALESCE', () => {
    expect(upsale).toContain('o.version_id IS NOT NULL AND');
    expect(upsale).toContain('o.version_id IS NULL AND');
    expect(upsale).toContain('COALESCE(v.total_usd, r.answer_amount)');
    expect(upsale).toContain('PARTITION BY COALESCE(v.request_id, o.request_id)');
    // The two outer version-only clauses stay guarded too.
    expect(upsale).toContain('ranked.version_id IS NULL OR ranked.discount_usd');
    expect(upsale).toContain('ranked.version_id IS NULL OR NOT (');
  });

  it('offerStandsSql is an anchor union — the release claim and the lock read it', () => {
    expect(workspace).toContain('request_id IS NOT NULL AND EXISTS');
    expect(workspace).toContain('answerFloorStandsSql()');
  });

  it('the answer-floor standing clause names its five money fences', () => {
    expect(versionSet).toContain("r.answer_currency = 'USD'");
    expect(versionSet).toContain('r.answer_amount > 0');
    expect(versionSet).toContain('rn.completed_at > r.completed_at');
    expect(versionSet).toContain('vn.sealed_at > r.completed_at');
  });
});
