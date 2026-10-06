import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  basesFor,
  basisConflicts,
  basisLabel,
  basisOnScreen,
  defaultBasisFor,
  isBehindOnBasisCheck,
  pairUnitFor,
  uniformBazaOf,
} from '@/modules/wms/calc/basis';
import { BAZA_BASES, type BazaBasis, type DutyUnit } from '@/modules/wms/calc/pricing';

/**
 * 0125 (his 18a/19a): what a row may be priced PER, what its one measure
 * pair must hold, and the one combination it cannot hold — over EVERY law
 * unit × EVERY basis, so a unit added to either vocabulary is a row of this
 * matrix that has to be decided, never a gap.
 */
const LAWS: (DutyUnit | null)[] = [null, 'kg', 'dona', '1000_dona', 'sm3', 'm2', 'juft', 'litr'];
const PAIR_LAWS = new Set<DutyUnit | null>(['m2', 'juft', 'litr', 'sm3']);
const PAIR_BASES = new Set<BazaBasis>(['m2', 'juft', 'litr']);

describe('basesFor × pairUnitFor × basisConflicts — the whole matrix', () => {
  it('a law with no pair unit offers all six; a pair law offers dona, kg, m³ and its own', () => {
    for (const law of LAWS) {
      const offered = basesFor(law);
      if (law === 'm2' || law === 'juft' || law === 'litr') {
        expect(offered, String(law)).toEqual(['unit', 'kg', 'm3', law]);
      } else if (law === 'sm3') {
        // A vehicle's duty owns the pair; its baza is per dona (#868).
        expect(offered).toEqual(['unit', 'kg', 'm3']);
      } else {
        expect(offered, String(law)).toEqual([...BAZA_BASES]);
      }
    }
  });

  for (const law of LAWS) {
    for (const basis of BAZA_BASES) {
      it(`${law ?? 'advalor'} × ${basis}`, () => {
        const pair = pairUnitFor(law, basis);
        // The law's pair unit wins; otherwise a pair BASIS asks its own; dona,
        // kg and m³ each have a column and never touch the pair.
        if (PAIR_LAWS.has(law)) expect(pair).toBe(law);
        else if (PAIR_BASES.has(basis)) expect(pair).toBe(basis);
        else expect(pair).toBeNull();
        // The ONE refusal: a pair law with ANOTHER pair basis — one pair
        // cannot hold two quantities.
        const conflict = PAIR_LAWS.has(law) && PAIR_BASES.has(basis) && basis !== law;
        expect(basisConflicts(law, basis)).toBe(conflict);
        expect(basesFor(law).includes(basis)).toBe(!conflict);
      });
    }
  }

  it('a missing basis asks nothing of its own and conflicts with nothing', () => {
    expect(pairUnitFor(null, null)).toBeNull();
    expect(pairUnitFor('juft', null)).toBe('juft');
    expect(basisConflicts('juft', null)).toBe(false);
  });

  it('m³ is a baza unit and never a pair unit — it reads volume_m3', () => {
    for (const law of LAWS) {
      if (!PAIR_LAWS.has(law)) expect(pairUnitFor(law, 'm3')).toBeNull();
      expect(basisConflicts(law, 'm3')).toBe(false);
    }
  });
});

describe('basisOnScreen — draft, else stored, else the law', () => {
  it('a draft wins, a stored unit stands, and the law decides only when neither speaks', () => {
    expect(basisOnScreen('m3', 'kg', { dutyUnit: 'juft' })).toBe('m3');
    expect(basisOnScreen(undefined, 'kg', { dutyUnit: 'juft' })).toBe('kg');
    expect(basisOnScreen(undefined, null, { dutyUnit: 'juft' })).toBe('juft');
    expect(basisOnScreen(undefined, null, null)).toBe('unit');
  });
});

describe('basisLabel — the storage spelling is nobody’s word', () => {
  it('dona is the caller’s word; m² and m³ are symbols; the rest as written', () => {
    expect(basisLabel('unit', 'шт')).toBe('шт');
    expect(basisLabel('m2', 'шт')).toBe('m²');
    expect(basisLabel('m3', 'шт')).toBe('m³');
    expect(basisLabel('kg', 'шт')).toBe('kg');
    expect(basisLabel('juft', 'шт')).toBe('juft');
  });
});

describe('a 23514 is «server behind» only on the two CHECKs 0125 widened', () => {
  const pg = (code: string, constraint_name?: string) => ({ code, constraint_name });
  it('matches by NAME, through a drizzle wrapper too', () => {
    expect(isBehindOnBasisCheck(pg('23514', 'calc_items_baza_basis_check'))).toBe(true);
    expect(isBehindOnBasisCheck(pg('23514', 'calc_bazas_basis_check'))).toBe(true);
    expect(isBehindOnBasisCheck({ cause: pg('23514', 'calc_items_baza_basis_check') })).toBe(true);
  });
  it('never a blanket 23514 — a broken pair CHECK is a real fault', () => {
    expect(isBehindOnBasisCheck(pg('23514', 'calc_items_measure_pair_check'))).toBe(false);
    expect(isBehindOnBasisCheck(pg('23514'))).toBe(false);
    expect(isBehindOnBasisCheck(pg('23505', 'calc_items_baza_basis_check'))).toBe(false);
    expect(isBehindOnBasisCheck(null)).toBe(false);
  });
});

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
    // One payable per JOB across both anchors: the rank partitions on the
    // COALESCEd request (named once in `base`, audit A18's restructure).
    expect(upsale).toContain('COALESCE(v.request_id, o.request_id) AS request_id');
    expect(upsale).toContain('PARTITION BY base.request_id, base.stands');
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
