import { describe, expect, it } from 'vitest';
import {
  AI_RECODE_PREFIX,
  aiRateTaken,
  aiRecoded,
  keepRecodeMark,
  lawPinnedBasis,
  sealCounters,
  unchangedFromProposal,
  warningsForGroup,
  type WarningGroupFacts,
} from '@/modules/wms/calc/warnings';
import { defaultBasisFor } from '@/modules/wms/calc/basis';

const base: WarningGroupFacts = {
  dictionaryRates: null,
  dictionaryNote: null,
  rateSource: 'typed',
  dutyPct: 10,
  vatPct: 12,
  aiProposed: false,
  aiConfidence: null,
  aiDutyPct: null,
  dutyMode: 'advalor',
  dutySpecific: null,
  dutyUnit: null,
  headingHidesLaws: false,
  exciseUnanswered: false,
  items: [],
};

/** A book row as `dictionaryRates` carries it — the whole law (2026-10-09). */
const book = (dutyPct: number, over: Partial<NonNullable<WarningGroupFacts['dictionaryRates']>> = {}) => ({
  dutyPct,
  vatPct: 12,
  feeUsd: 0,
  dutyMode: 'advalor' as const,
  dutySpecific: null,
  dutyUnit: null,
  ...over,
});

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
          bazaReason: null,
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
          bazaReason: null,
        },
      ],
    };
    const out = warningsForGroup(facts);
    expect(out).toContain('baza_off_dictionary');
    expect(out).toContain('baza_from_import');
  });

  it('warns once the dictionary HAS an answer and a DIFFERENT rate was typed', () => {
    const facts = { ...base, dictionaryRates: book(5) };
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
    const facts = { ...base, dictionaryRates: book(10) };
    expect(warningsForGroup(facts)).toEqual([]);
  });

  it('a typed VAT alone off the book still warns', () => {
    const facts = {
      ...base,
      vatPct: 0,
      dictionaryRates: book(10),
    };
    expect(warningsForGroup(facts)).toContain('rate_off_dictionary');
  });

  /*
   * Subject changed deliberately (2026-10-09, P2.2): a group the BOOK wrote
   * whose law differs from today's book row is not silent any more — the
   * book MOVED under an open job, and that is `dictionary_moved`'s sentence.
   * It is never `rate_off_dictionary` (nobody typed anything), and a group
   * that still equals the book says nothing at all.
   */
  it('a dictionary group that still equals the book says nothing', () => {
    const facts: WarningGroupFacts = { ...base, rateSource: 'dictionary', dictionaryRates: book(10) };
    expect(warningsForGroup(facts)).toEqual([]);
  });

  it('a dictionary group whose book MOVED says so — once, never as «typed off the book»', () => {
    const facts: WarningGroupFacts = { ...base, rateSource: 'dictionary', dictionaryRates: book(5) };
    expect(warningsForGroup(facts)).toEqual(['dictionary_moved']);
    // The shape alone moving is the book moving too: a MAX floor the book
    // added (or dropped) under the same percentage.
    const floor = book(10, { dutyMode: 'max', dutySpecific: 3, dutyUnit: 'juft' });
    expect(warningsForGroup({ ...base, rateSource: 'dictionary', dictionaryRates: floor })).toEqual([
      'dictionary_moved',
    ]);
    // A group with no law at all is `rates_missing` (a blocker), never «moved».
    expect(
      warningsForGroup({ ...base, rateSource: null, dutyPct: null, vatPct: null, dictionaryRates: book(5) }),
    ).toEqual([]);
  });

  it('a TYPED group off the book by its SHAPE alone is off the book (UX9: one fact, one warning)', () => {
    const floor = book(10, { dutyMode: 'max', dutySpecific: 3, dutyUnit: 'juft' });
    const out = warningsForGroup({ ...base, rateSource: 'typed', dictionaryRates: floor });
    expect(out).toContain('rate_off_dictionary');
    expect(out).not.toContain('dictionary_moved');
  });

  it('a short code hiding other laws, and an unanswered excise, are recorded by the ✅', () => {
    expect(warningsForGroup({ ...base, headingHidesLaws: true })).toEqual(['code_heading']);
    expect(warningsForGroup({ ...base, exciseUnanswered: true })).toEqual(['excise_unanswered']);
  });

  it('warns on a typed baza only when the dictionary answered AND the value differs', () => {
    const dict = { bazaUsd: 12, basis: 'unit' as const };
    const item = (over: Partial<WarningGroupFacts['items'][number]>) => ({
      hasDictionaryBaza: true,
      bazaSource: 'typed' as const,
      bazaUsd: 12,
      bazaBasis: 'unit' as const,
      dictionaryBaza: dict,
      bazaReason: null,
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
      dictionaryRates: book(5),
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

describe('0125 A1: basis_not_law — a priced row per another unit than the law counts in', () => {
  const priced = (
    bazaBasis: WarningGroupFacts['items'][number]['bazaBasis'],
    bazaUsd: number | null = 8,
  ) => ({
    hasDictionaryBaza: false,
    bazaSource: 'typed' as const,
    bazaUsd,
    bazaBasis,
    dictionaryBaza: null,
    bazaReason: null,
  });

  it('fires when the law PINS a unit and a priced row is per another', () => {
    expect(warningsForGroup({ ...base, dutyUnit: 'juft', items: [priced('kg')] })).toContain('basis_not_law');
    expect(warningsForGroup({ ...base, dutyUnit: 'kg', items: [priced('m3')] })).toContain('basis_not_law');
    expect(warningsForGroup({ ...base, dutyUnit: 'm2', items: [priced('unit')] })).toContain('basis_not_law');
  });

  it('is silent when the row is per the law’s own unit, or carries no price yet', () => {
    expect(warningsForGroup({ ...base, dutyUnit: 'juft', items: [priced('juft')] })).not.toContain(
      'basis_not_law',
    );
    // An unpriced row's chosen unit prices nothing — not a confirmed number.
    expect(warningsForGroup({ ...base, dutyUnit: 'juft', items: [priced('kg', null)] })).not.toContain(
      'basis_not_law',
    );
  });

  it('is SILENT on an advalor code and on a per-dona law — they pin no baza unit', () => {
    // Stated to him: on these (1,250 of 1,489 rows) an override is free and
    // this list does not watch it.
    for (const dutyUnit of [null, 'dona', '1000_dona', 'sm3']) {
      expect(
        warningsForGroup({ ...base, dutyUnit, items: [priced('kg'), priced('m3')] }),
      ).not.toContain('basis_not_law');
    }
  });

  it('the restated pin agrees with defaultBasisFor over every law unit (the zero-import rule)', () => {
    for (const dutyUnit of [null, 'kg', 'dona', '1000_dona', 'sm3', 'm2', 'juft', 'litr']) {
      const law = defaultBasisFor({ dutyUnit });
      expect(lawPinnedBasis(dutyUnit), String(dutyUnit)).toBe(law === 'unit' ? null : law);
    }
  });
});

describe('round 2: the book moved under a 📖 row, and the pick chose a code', () => {
  const row = (over: Partial<WarningGroupFacts['items'][number]>): WarningGroupFacts['items'][number] => ({
    hasDictionaryBaza: true,
    bazaSource: 'dictionary',
    bazaUsd: 2,
    bazaBasis: 'kg',
    dictionaryBaza: { bazaUsd: 2, basis: 'kg' },
    bazaReason: null,
    ...over,
  });

  /**
   * `bazaStale` reads the CURRENT book row's date, so a 📖 row filled at $2
   * whose book row now says $3 would read fresh while holding the old price
   * (docs/SAKKIZ-R2.md §7.2.6). Price AND unit, as `baza_off_dictionary`
   * compares them — but only on the BOOK's own rows: a typed row off the
   * book is that warning's sentence, never this one (one fact, one warning).
   */
  it('a 📖 row whose book row moved says so — by price or by unit', () => {
    expect(warningsForGroup({ ...base, items: [row({})] })).toEqual([]);
    expect(warningsForGroup({ ...base, items: [row({ dictionaryBaza: { bazaUsd: 3, basis: 'kg' } })] })).toEqual([
      'baza_dictionary_moved',
    ]);
    expect(
      warningsForGroup({ ...base, items: [row({ dictionaryBaza: { bazaUsd: 2, basis: 'unit' } })] }),
    ).toContain('baza_dictionary_moved');
    // Not the book's row, not this warning.
    expect(
      warningsForGroup({ ...base, items: [row({ bazaSource: 'typed', dictionaryBaza: { bazaUsd: 3, basis: 'kg' } })] }),
    ).not.toContain('baza_dictionary_moved');
    // No book row today: nothing to have moved from.
    expect(warningsForGroup({ ...base, items: [row({ hasDictionaryBaza: false, dictionaryBaza: null })] })).toEqual(
      [],
    );
  });

  /**
   * law-money-4: a pick from a heading's list chooses the declaration's CODE,
   * and with it the duty law — the ✅ must record that a person looked. Read
   * off the reason's prefix (its one home); a same-code pick is the import's
   * own `baza_from_import` and nothing more.
   */
  it('a row the pick recoded raises ai_recode; a same-code pick does not', () => {
    const picked = row({
      bazaSource: 'import',
      hasDictionaryBaza: false,
      dictionaryBaza: null,
      bazaReason: `${AI_RECODE_PREFIX}6403 → 6403991000 · charm poyabzal`,
    });
    expect(warningsForGroup({ ...base, items: [picked] })).toEqual(['baza_from_import', 'ai_recode']);
    expect(warningsForGroup({ ...base, items: [{ ...picked, bazaReason: 'charm poyabzal' }] })).toEqual([
      'baza_from_import',
    ]);
    expect(aiRecoded(picked.bazaReason)).toBe(true);
    expect(aiRecoded(null)).toBe(false);
  });

  /**
   * Review P2-LAW-2: the mark records the CODE the model chose, so a writer
   * that re-prices the row over that code keeps it — stripped of the model's
   * words about the declaration it no longer wears — and only a writer that
   * posts its own mark replaces it.
   */
  it('a price written over the model’s code keeps the recode mark, stripped of the model’s words', () => {
    const stood = `${AI_RECODE_PREFIX}6403 → 6403991000 · charm poyabzal`;
    expect(keepRecodeMark(stood, null)).toBe(`${AI_RECODE_PREFIX}6403 → 6403991000`);
    expect(aiRecoded(keepRecodeMark(stood, null))).toBe(true);
    // The machine's same-code words ride after the mark…
    expect(keepRecodeMark(stood, 'tufli')).toBe(`${AI_RECODE_PREFIX}6403 → 6403991000 · tufli`);
    // …a fresh recode mark is its own…
    const fresh = `${AI_RECODE_PREFIX}6403 → 6403120000 · kg`;
    expect(keepRecodeMark(stood, fresh)).toBe(fresh);
    // …and a row the model never recoded carries only what was posted.
    expect(keepRecodeMark('charm poyabzal', null)).toBeNull();
    expect(keepRecodeMark(null, 'tufli')).toBe('tufli');
    // A mark already stripped stays itself.
    expect(keepRecodeMark(`${AI_RECODE_PREFIX}6403 → 6403991000`, null)).toBe(`${AI_RECODE_PREFIX}6403 → 6403991000`);
  });
});
