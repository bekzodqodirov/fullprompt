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
  dictionaryNote: null,
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

  /**
   * 0094's own half. It carries NO dictionary clause on purpose, and that
   * is the difference between the two sentences: `baza_off_dictionary`
   * means a person disagreed with the book, this one means NOBODY stated the
   * price — the machine matched a declaration by name and the row is still
   * wearing its «📥 taxmin» chip. The ✅ has to record that a person looked.
   */
  it('records that a baza came out of the customs import, book or no book', () => {
    const imported = {
      ...base,
      items: [
        {
          hasDictionaryBaza: false,
          bazaSource: 'import' as const,
          bazaUsd: 2,
          bazaBasis: 'kg' as const,
          dictionaryBaza: null,
        },
      ],
    };
    expect(warningsForGroup(imported)).toContain('baza_from_import');
    // A price the VED typed is theirs and says nothing.
    expect(
      warningsForGroup({
        ...imported,
        items: [{ ...imported.items[0]!, bazaSource: 'typed' as const }],
      }),
    ).not.toContain('baza_from_import');
    // An EMPTY row cannot have been filled from anything.
    expect(
      warningsForGroup({
        ...imported,
        items: [{ ...imported.items[0]!, bazaUsd: null }],
      }),
    ).not.toContain('baza_from_import');
  });

  it('an imported baza that disagrees with the book warns on BOTH counts', () => {
    const facts = {
      ...base,
      items: [
        {
          hasDictionaryBaza: true,
          bazaSource: 'import' as const,
          bazaUsd: 2,
          bazaBasis: 'kg' as const,
          dictionaryBaza: { bazaUsd: 5, basis: 'kg' as const },
        },
      ],
    };
    const out = warningsForGroup(facts);
    expect(out).toContain('baza_off_dictionary');
    expect(out).toContain('baza_from_import');
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

  it('warns on a typed baza only when the dictionary answered AND the value differs', () => {
    const dict = { bazaUsd: 12, basis: 'unit' as const };
    const item = (over: Partial<WarningGroupFacts['items'][number]>) => ({
      hasDictionaryBaza: true,
      bazaSource: 'typed' as const,
      bazaUsd: 12,
      bazaBasis: 'unit' as const,
      dictionaryBaza: dict,
      ...over,
    });

    // A different NUMBER warns…
    expect(warningsForGroup({ ...base, items: [item({ bazaUsd: 15 })] })).toContain(
      'baza_off_dictionary',
    );
    // …and so does the book's own number per the WRONG measure — the basis
    // is part of the price ($12/kg is not $12/unit).
    expect(warningsForGroup({ ...base, items: [item({ bazaBasis: 'kg' })] })).toContain(
      'baza_off_dictionary',
    );

    // Typing the dictionary's own answer deviates from nothing — phase 2's
    // group-baza cell stamps 'typed' on every member, so source-alone would
    // have named essentially every group the day the baza book fills up
    // (the exact flip the rates half was corrected for).
    expect(warningsForGroup({ ...base, items: [item({})] })).toEqual([]);

    // No dictionary answer → typing is the only thing a person CAN do.
    expect(
      warningsForGroup({
        ...base,
        items: [item({ hasDictionaryBaza: false, dictionaryBaza: null })],
      }),
    ).toEqual([]);
  });

  it('a NOTED dictionary rate warns only while the dictionary is driving', () => {
    // The 21 clauseCut sm³ vehicle rows: the book answered WITH a condition.
    const noted = { ...base, rateSource: 'dictionary' as const, dictionaryNote: '…за куб. см. для' };
    expect(warningsForGroup(noted)).toContain('rate_noted');
    // A person who TYPED over the rate has already looked past the note.
    expect(warningsForGroup({ ...noted, rateSource: 'typed' })).not.toContain('rate_noted');
    expect(warningsForGroup({ ...noted, dictionaryNote: null })).not.toContain('rate_noted');
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
