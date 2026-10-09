/**
 * What stood on the screen when a person pressed ✅ (VED phase E1).
 *
 * The owner's question is one sentence: «ai bergan taklif bilan narx berib
 * yuborganda» — did somebody confirm a number the model invented without
 * looking at it? Answering it needs the warnings recorded AT the moment of
 * confirming, because the dictionaries move: re-deriving them a month later
 * asks a different question and answers it about a different world.
 *
 * Pure on purpose — zero imports. The workspace, the confirm buttons, the
 * seal's counters and the control screen all call THESE functions, so there
 * is one definition of «this needed a second look» rather than four that
 * drift (#166).
 */

export type CalcWarningKind =
  /** The dictionary HAD a rate for this code and a person typed a different one. */
  | 'rate_off_dictionary'
  /** The dictionary HAD a baza for this product and a person typed a different one. */
  | 'baza_off_dictionary'
  /** Confirmed with the model's low-confidence guess untouched and no dictionary answer. */
  | 'ai_low_confidence'
  /** The model's own duty rate survived to the seal. */
  | 'ai_rate_taken'
  /** The dictionary rate driving this group carries the law's own note — e.g.
   * the 21 sm³ vehicle rows whose «…за куб. см. для» condition the parse cut
   * short. The price computes; the confirm must RECORD that the book's answer
   * came with a condition attached (phase 3). */
  | 'rate_noted'
  /** At least one baza in this group was FILLED FROM THE CUSTOMS IMPORT and
   * nobody has retyped it (0094). The file is a real declaration, not a
   * guess, but it was matched to our cargo by a NAME — so the ✅ must record
   * that the person looked at a price the machine chose, exactly as
   * `ai_low_confidence` records a rate it chose. */
  | 'baza_from_import'
  /** At least one baza in this group was answered by a SEALED calculation of
   * this company's own (0096) and nobody has retyped it. It is the strongest
   * of the machine's three sources — a VED person confirmed that number and
   * sealed it — but it is still a NAME match against an older job, so the ✅
   * records that the person looked at a price they did not state today. */
  | 'baza_from_memory'
  /** The code's law COUNTS in a unit (kg / m² / juft / litr) and at least one
   * row's baza is priced per another (0125, the owner's A1). Allowed — the
   * baza is the row's own question since his 18a — but «$8» meant per juft
   * and saved per kg is +59 % customs on a measured case, a number that is
   * right and a unit that is wrong. The ✅ records that a person looked.
   * SILENT on an advalor code and on a per-dona law: those pin no baza unit,
   * so an override there is free and this list does not watch it. */
  | 'basis_not_law'
  /**
   * The BOOK moved under a group that took its law from the book (2026-10-09,
   * P2.2): today's row for the code says another duty, VAT or shape than the
   * group carries. A dictionary group is the book's word AS OF its mint, and
   * the dictionary is versioned by date — so a correction the VED made to the
   * book this morning reached nobody's open job, silently. Only for a group
   * the book wrote (`rateSource` not 'typed'): a TYPED group that differs is
   * `rate_off_dictionary`'s sentence already — one fact, one warning (UX9).
   */
  | 'dictionary_moved'
  /**
   * A SHORT code whose heading hides other laws (P2.3, judge MR-10/UX8): the
   * typed code is under 10 digits AND the book holds deeper rows under it
   * with a DIFFERENT law (8528 → 852872…: 15 %). PP-3818 is written by
   * heading, so «answered from a shorter row» alone is true of nearly every
   * group and is footer INFORMATION, never this warning.
   */
  | 'code_heading'
  /**
   * The code falls under a heading that MAY carry an excise (`calc/excise.ts`
   * — beer, spirits, tobacco, fuel, cars) and nobody has answered it: no
   * percentage, no «yo'q», no per-unit amount. Never a blocker — the VED
   * answers «yo'q» and it is gone.
   */
  | 'excise_unanswered';

/** A law as the book or a group states it — the five columns that price a duty. */
export interface LawFacts {
  dutyPct: number;
  vatPct: number;
  dutyMode: 'advalor' | 'specific' | 'max' | 'plus';
  dutySpecific: number | null;
  dutyUnit: string | null;
}

export interface WarningGroupFacts {
  /** What the rates dictionary answers for this group's code today, if
   * anything — the whole law (2026-10-09), not only its two percentages. */
  dictionaryRates: (LawFacts & { feeUsd: number }) | null;
  /** The note on the dictionary row — the law's own condition, when it has one. */
  dictionaryNote: string | null;
  rateSource: 'dictionary' | 'typed' | null;
  dutyPct: number | null;
  vatPct: number | null;
  /** The group's own law shape — compared with the book's beside the two
   * percentages, or a MAX floor the book dropped stays on the job unseen. */
  dutyMode: 'advalor' | 'specific' | 'max' | 'plus';
  dutySpecific: number | null;
  aiProposed: boolean;
  aiConfidence: 'high' | 'medium' | 'low' | null;
  aiDutyPct: number | null;
  /** The group's law unit (its `duty_unit`) — null on an advalor code.
   * REQUIRED: `basis_not_law` cannot be judged without it (0125). */
  dutyUnit: string | null;
  /** The book holds deeper rows under this SHORT code with another law
   * (`code_heading`) — decided by the caller from the book, REQUIRED. */
  headingHidesLaws: boolean;
  /** The code may carry an excise (`calc/excise.ts`, read by the caller —
   * this file imports nothing) and the group has not answered it. */
  exciseUnanswered: boolean;
  /** One entry per ITEM: what the baza dictionary answers, and what stands.
   * The basis union is RESTATED here (this file is zero-import on purpose) —
   * `tests/unit/basis-vocabulary.test.ts` holds it to pricing.ts's
   * `BAZA_BASES`. */
  items: {
    hasDictionaryBaza: boolean;
    bazaSource: 'dictionary' | 'typed' | 'import' | 'memory' | null;
    bazaUsd: number | null;
    bazaBasis: 'unit' | 'kg' | 'm3' | 'm2' | 'juft' | 'litr' | null;
    dictionaryBaza: { bazaUsd: number; basis: 'unit' | 'kg' | 'm3' | 'm2' | 'juft' | 'litr' } | null;
  }[];
}

/**
 * The baza unit a law PINS — restated from `defaultBasisFor` (basis.ts) for
 * the zero-import rule, and held to it by `tests/unit/calc-warnings.test.ts`
 * over every DutyUnit: kg and the three pair units pin their own; dona,
 * 1000_dona, sm³ and advalor pin none.
 */
export function lawPinnedBasis(dutyUnit: string | null): 'kg' | 'm2' | 'juft' | 'litr' | null {
  return dutyUnit === 'kg' || dutyUnit === 'm2' || dutyUnit === 'juft' || dutyUnit === 'litr'
    ? dutyUnit
    : null;
}

/**
 * A1's one sentence, asked by the server's warning list AND by the browser's
 * block footer over the LIVE rows — the footer drew the server's verdict on
 * the stored rows beside a baza built from the drafts, and warned about the
 * very unit it was showing until Saqlash (review units-r2-2).
 */
export function basisNotLaw(
  dutyUnit: string | null,
  items: readonly { bazaUsd: number | null; bazaBasis: string | null }[],
): boolean {
  const pinned = lawPinnedBasis(dutyUnit);
  return pinned !== null && items.some((i) => i.bazaUsd !== null && i.bazaBasis !== null && i.bazaBasis !== pinned);
}

/**
 * A warning means «the dictionary HAD an answer and a person typed something
 * else», and BOTH halves of that sentence are load-bearing.
 *
 * `dictionary !== null`: without it the rule reads «rate_source is typed»,
 * which was TRUE of every group in the company while `0086`/`0087` shipped
 * the dictionaries empty. The owner's first list would have been 23 rows out
 * of 23, and a list that names everything names nothing.
 *
 * «something ELSE»: since 0091 the seed fills the rates dictionary with all
 * 1,489 PP-3818 rows, so `dictionary !== null` is now true of nearly every
 * real code — and a VED who types 10 % where the law says 10 % has typed the
 * LAW, not a deviation. The warning fires only when a typed number actually
 * DIFFERS from the dictionary's, which is what its own sentence always
 * claimed.
 */
export function warningsForGroup(facts: WarningGroupFacts): CalcWarningKind[] {
  const out: CalcWarningKind[] = [];

  const dict = facts.dictionaryRates;
  // The law is FIVE columns, not two percentages (2026-10-09): a typed 20 %
  // under a book that says «20 %, kamida $3/juft» is off the book by the whole
  // floor, and comparing the percentages alone called it equal.
  const lawDiffers = dict !== null && lawOffBook(facts, dict);
  if (dict !== null && facts.rateSource === 'typed' && lawDiffers) {
    out.push('rate_off_dictionary');
  }
  // The same comparison for a group the BOOK wrote: its law was right on the
  // day it was minted, and the book has since moved. A group with no law at
  // all is `rates_missing` (a blocker), never «moved».
  if (dict !== null && facts.rateSource !== 'typed' && facts.dutyPct !== null && lawDiffers) {
    out.push('dictionary_moved');
  }
  if (facts.headingHidesLaws) out.push('code_heading');
  if (facts.exciseUnanswered) out.push('excise_unanswered');
  // The baza half carries the SAME «something else» clause (phase 2's judge:
  // the group-baza cell stamps 'typed' on every member, so source-alone would
  // warn on essentially every group the day the baza dictionary has answers —
  // the exact from-nothing-to-everything flip the rates half was fixed for).
  // The BASIS is part of the price: $20/kg against the book's $20/unit warns.
  if (
    facts.items.some(
      (i) =>
        i.dictionaryBaza !== null &&
        (i.bazaSource === 'typed' || i.bazaSource === 'import') &&
        i.bazaUsd !== null &&
        (i.bazaUsd !== i.dictionaryBaza.bazaUsd || i.bazaBasis !== i.dictionaryBaza.basis),
    )
  ) {
    out.push('baza_off_dictionary');
  }
  // The import's own half. It does NOT need the dictionary clause the two
  // above carry: a value «off the dictionary» is a person disagreeing with
  // the book, while this one is nobody having stated the price at all — the
  // machine matched a declaration by name and the row is still wearing its
  // «📥 taxmin» chip.
  if (facts.items.some((i) => i.bazaSource === 'import' && i.bazaUsd !== null)) {
    out.push('baza_from_import');
  }
  // The memory's half, on the import's terms and for the import's reason.
  // Deliberately its OWN kind and not folded into `baza_from_import`: the two
  // differ in who stands behind the number — our own sealed answer against a
  // stranger's declaration — and the owner's list is read to decide where to
  // look first.
  if (facts.items.some((i) => i.bazaSource === 'memory' && i.bazaUsd !== null)) {
    out.push('baza_from_memory');
  }
  // A blind confirm is a CONJUNCTION and each clause earns its place: the
  // model actually proposed this group (`mergeProposals` mints orphan groups
  // with `aiProposed: false`), it said so itself with low confidence, and the
  // dictionary could not have corrected it.
  if (facts.aiProposed && facts.aiConfidence === 'low' && facts.dictionaryRates === null) {
    out.push('ai_low_confidence');
  }
  if (aiRateTaken(facts)) out.push('ai_rate_taken');
  // The book answered WITH a condition (its note), and that answer is what
  // drives the price. A typed rate means a person already looked past the
  // note; a dictionary-sourced one means nobody had to — so the confirm must
  // carry the fact (phase 3, the clauseCut vehicle rows).
  if (facts.rateSource === 'dictionary' && facts.dictionaryNote !== null) {
    out.push('rate_noted');
  }
  // A1 (0125): a PRICED row whose baza is per another unit than the one the
  // law counts in. An unpriced row's chosen unit prices nothing yet, so it is
  // not «a number confirmed in the wrong unit» — the row will say so the day
  // it carries a price.
  if (basisNotLaw(facts.dutyUnit, facts.items)) out.push('basis_not_law');

  return out;
}

/**
 * Does the group's law differ from the book's? Each column compared on its
 * own, a percentage only where the group HAS one (a null is «not stated»,
 * the same `differs` rule the percentages always had).
 */
export function lawOffBook(
  group: { dutyPct: number | null; vatPct: number | null; dutyMode: string; dutySpecific: number | null; dutyUnit: string | null },
  book: LawFacts,
): boolean {
  const differs = (typed: number | null, against: number) => typed !== null && typed !== against;
  return (
    differs(group.dutyPct, book.dutyPct) ||
    differs(group.vatPct, book.vatPct) ||
    group.dutyMode !== book.dutyMode ||
    (group.dutySpecific ?? null) !== (book.dutySpecific ?? null) ||
    (group.dutyUnit ?? null) !== (book.dutyUnit ?? null)
  );
}

/**
 * The model's own duty rate survived to the seal.
 *
 * Literally the owner's sentence, and the kind the design was missing.
 * `ai_duty_pct` has existed since 0086 «read by nothing» — this is the reader.
 * It is not an accusation: the model is often right, and a VED who checked it
 * and agreed did their job. It is the bucket where a blind confirm turns into
 * money, which is why the customs comparison exists at all.
 */
export function aiRateTaken(facts: {
  aiDutyPct: number | null;
  dutyPct: number | null;
  rateSource: 'dictionary' | 'typed' | null;
}): boolean {
  if (facts.aiDutyPct === null || facts.dutyPct === null) return false;
  if (facts.rateSource !== 'typed') return false;
  return Math.abs(facts.dutyPct - facts.aiDutyPct) < 0.0005;
}

export interface ProposalSnapshot {
  tnvedCode: string | null;
  aiDutyPct: number | null;
  /** The item positions the model put in this group. */
  itemSeqs: number[];
}

/**
 * Is this group still exactly what the model proposed?
 *
 * The MEMBERSHIP check is the half that matters and the half a diff on the
 * code alone would miss: moving one carton between two groups changes both
 * groups' customs figure while leaving every rate untouched, and that is the
 * commonest correction a VED makes. Compared as a SET — the order items are
 * listed in is the seller's, and it never meant anything here.
 */
export function unchangedFromProposal(
  proposal: ProposalSnapshot | null,
  now: { tnvedCode: string | null; dutyPct: number | null; itemSeqs: number[] },
): boolean {
  if (!proposal) return false;
  if ((proposal.tnvedCode ?? '') !== (now.tnvedCode ?? '')) return false;
  if (proposal.aiDutyPct === null || now.dutyPct === null) return false;
  if (Math.abs(proposal.aiDutyPct - now.dutyPct) >= 0.0005) return false;
  const was = new Set(proposal.itemSeqs);
  if (was.size !== new Set(now.itemSeqs).size) return false;
  return now.itemSeqs.every((seq) => was.has(seq));
}

/**
 * The three numbers a sealed version carries away with it.
 *
 * `aiBlind` is a STATISTIC and never a row on anybody's list: `setGroupRates`
 * lets a VED retype the identical code, so a per-person measure built on it
 * would reward cosmetic edits and punish the model for being right.
 */
export function sealCounters(
  groups: { warnings: CalcWarningKind[]; blind: boolean }[],
): { warnedGroups: number; aiBlindGroups: number; aiRateTakenGroups: number } {
  return {
    warnedGroups: groups.filter((g) => g.warnings.length > 0).length,
    aiBlindGroups: groups.filter((g) => g.blind).length,
    aiRateTakenGroups: groups.filter((g) => g.warnings.includes('ai_rate_taken')).length,
  };
}
