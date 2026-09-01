import { describe, expect, it } from 'vitest';
import {
  aiRateTaken,
  sealCounters,
  unchangedFromProposal,
  warningsForGroup,
  type WarningGroupFacts,
} from '@/modules/wms/calc/warnings';

const base: WarningGroupFacts = {
  dictionaryRates: null,
  rateSource: 'typed',
  dutyPct: 10,
  vatPct: 12,
  aiProposed: false,
  aiConfidence: null,
  aiDutyPct: null,
  items: [],
};

describe('a warning means the dictionary had an answer and a person typed another', () => {
  /**
   * THE test this file exists for. `0086` and `0087` ship the dictionaries
   * EMPTY, so on deploy morning `rate_source` is 'typed' on every group in
   * the company — a rule without the `dictionaryRates !== null` half would
   * put every calculation on the owner's list on day one, and a list that
   * names everything names nothing.
   */
  it('says nothing at all while the dictionaries are empty', () => {
    for (const dutyPct of [5, 10, 20]) {
      expect(warningsForGroup({ ...base, dutyPct })).toEqual([]);
    }
  });

  it('warns once the dictionary HAS an answer and a DIFFERENT rate was typed', () => {
    const facts = { ...base, dictionaryRates: { dutyPct: 5, vatPct: 12, feeUsd: 0 } };
    expect(warningsForGroup(facts)).toContain('rate_off_dictionary');
  });

  /**
   * VED 2.0's second half of the sentence. The 0091 seed fills the rates
   * dictionary with all 1,489 PP-3818 rows, so «the dictionary answered» is
   * now true of nearly every real code — and a person who TYPES the law's own
   * numbers has deviated from nothing. Source-only, the owner's list would
   * have gone from naming nothing to naming everything in one deploy.
   */
  it('says nothing when the typed numbers EQUAL the dictionary’s', () => {
    const facts = { ...base, dictionaryRates: { dutyPct: 10, vatPct: 12, feeUsd: 0 } };
    expect(warningsForGroup(facts)).toEqual([]);
  });

  it('a typed VAT alone off the book still warns', () => {
    const facts = {
      ...base,
      vatPct: 0,
      dictionaryRates: { dutyPct: 10, vatPct: 12, feeUsd: 0 },
    };
    expect(warningsForGroup(facts)).toContain('rate_off_dictionary');
  });

  it('says nothing when the rate CAME from the dictionary', () => {
    const facts: WarningGroupFacts = {
      ...base,
      rateSource: 'dictionary',
      dictionaryRates: { dutyPct: 5, vatPct: 12, feeUsd: 0 },
    };
    expect(warningsForGroup(facts)).toEqual([]);
  });

  it('warns on a typed baza only when the dictionary could have answered', () => {
    const off = warningsForGroup({
      ...base,
      items: [{ hasDictionaryBaza: true, bazaSource: 'typed' }],
    });
    expect(off).toContain('baza_off_dictionary');

    const quiet = warningsForGroup({
      ...base,
      items: [{ hasDictionaryBaza: false, bazaSource: 'typed' }],
    });
    expect(quiet).toEqual([]);
  });

  /** A blind confirm is a conjunction; each clause is load-bearing. */
  it('calls a low-confidence group blind only when the model proposed it', () => {
    const proposed = warningsForGroup({
      ...base,
      aiProposed: true,
      aiConfidence: 'low',
    });
    expect(proposed).toContain('ai_low_confidence');

    // `mergeProposals` mints the ORPHAN group — the cargo the model did not
    // place — with confidence 'low' and aiProposed false.
    const orphan = warningsForGroup({ ...base, aiProposed: false, aiConfidence: 'low' });
    expect(orphan).not.toContain('ai_low_confidence');

    // A dictionary rate means the number could have been corrected, so an
    // unsure model is not the risk.
    const covered = warningsForGroup({
      ...base,
      aiProposed: true,
      aiConfidence: 'low',
      dictionaryRates: { dutyPct: 5, vatPct: 12, feeUsd: 0 },
    });
    expect(covered).not.toContain('ai_low_confidence');
  });
});

describe("the model's own rate reaching the price", () => {
  it('fires when the typed duty equals the estimate', () => {
    expect(aiRateTaken({ aiDutyPct: 12, dutyPct: 12, rateSource: 'typed' })).toBe(true);
    expect(warningsForGroup({ ...base, aiDutyPct: 12, dutyPct: 12 })).toContain('ai_rate_taken');
  });

  it('is silent when a person typed a different number', () => {
    expect(aiRateTaken({ aiDutyPct: 12, dutyPct: 15, rateSource: 'typed' })).toBe(false);
  });

  it('is silent when the rate came from the dictionary, however it compares', () => {
    expect(aiRateTaken({ aiDutyPct: 12, dutyPct: 12, rateSource: 'dictionary' })).toBe(false);
  });

  it('is silent when the model proposed no rate', () => {
    expect(aiRateTaken({ aiDutyPct: null, dutyPct: 12, rateSource: 'typed' })).toBe(false);
  });
});

describe('is the group still exactly what the model proposed', () => {
  const proposal = { tnvedCode: '8528520000', aiDutyPct: 10, itemSeqs: [1, 2, 3] };

  it('yes when nothing moved', () => {
    expect(
      unchangedFromProposal(proposal, { tnvedCode: '8528520000', dutyPct: 10, itemSeqs: [3, 1, 2] }),
    ).toBe(true);
  });

  /**
   * The MEMBERSHIP half, and the half a code-only diff would miss: moving one
   * carton between two groups changes both groups' customs figure and touches
   * no rate at all. It is the commonest correction a VED makes.
   */
  it('no when one item was moved out', () => {
    expect(
      unchangedFromProposal(proposal, { tnvedCode: '8528520000', dutyPct: 10, itemSeqs: [1, 2] }),
    ).toBe(false);
  });

  it('no when one item was moved in', () => {
    expect(
      unchangedFromProposal(proposal, {
        tnvedCode: '8528520000',
        dutyPct: 10,
        itemSeqs: [1, 2, 3, 4],
      }),
    ).toBe(false);
  });

  it('no when the code or the rate was corrected', () => {
    expect(
      unchangedFromProposal(proposal, { tnvedCode: '9403700000', dutyPct: 10, itemSeqs: [1, 2, 3] }),
    ).toBe(false);
    expect(
      unchangedFromProposal(proposal, { tnvedCode: '8528520000', dutyPct: 15, itemSeqs: [1, 2, 3] }),
    ).toBe(false);
  });

  it('no when there was no proposal at all', () => {
    expect(unchangedFromProposal(null, { tnvedCode: 'x', dutyPct: 1, itemSeqs: [] })).toBe(false);
  });
});

describe('the three counters a seal carries away', () => {
  it('counts warned groups once however many warnings each has', () => {
    const counters = sealCounters([
      { warnings: ['rate_off_dictionary', 'ai_rate_taken'], blind: false },
      { warnings: [], blind: false },
      { warnings: ['ai_low_confidence'], blind: true },
    ]);
    expect(counters).toEqual({ warnedGroups: 2, aiBlindGroups: 1, aiRateTakenGroups: 1 });
  });

  it('is all zeroes on a calculation nobody had to be warned about', () => {
    expect(sealCounters([{ warnings: [], blind: false }])).toEqual({
      warnedGroups: 0,
      aiBlindGroups: 0,
      aiRateTakenGroups: 0,
    });
  });
});
