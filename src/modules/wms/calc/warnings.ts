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
  | 'ai_rate_taken';

export interface WarningGroupFacts {
  /** What the rates dictionary answers for this group's code today, if anything. */
  dictionaryRates: { dutyPct: number; vatPct: number; feeUsd: number } | null;
  rateSource: 'dictionary' | 'typed' | null;
  dutyPct: number | null;
  vatPct: number | null;
  aiProposed: boolean;
  aiConfidence: 'high' | 'medium' | 'low' | null;
  aiDutyPct: number | null;
  /** One entry per ITEM: what the baza dictionary answers, and what stands. */
  items: {
    hasDictionaryBaza: boolean;
    bazaSource: 'dictionary' | 'typed' | null;
    bazaUsd: number | null;
    bazaBasis: 'unit' | 'kg' | null;
    dictionaryBaza: { bazaUsd: number; basis: 'unit' | 'kg' } | null;
  }[];
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
  const differs = (typed: number | null, book: number) => typed !== null && typed !== book;
  if (
    dict !== null &&
    facts.rateSource === 'typed' &&
    (differs(facts.dutyPct, dict.dutyPct) || differs(facts.vatPct, dict.vatPct))
  ) {
    out.push('rate_off_dictionary');
  }
  // The baza half carries the SAME «something else» clause (phase 2's judge:
  // the group-baza cell stamps 'typed' on every member, so source-alone would
  // warn on essentially every group the day the baza dictionary has answers —
  // the exact from-nothing-to-everything flip the rates half was fixed for).
  // The BASIS is part of the price: $20/kg against the book's $20/unit warns.
  if (
    facts.items.some(
      (i) =>
        i.dictionaryBaza !== null &&
        i.bazaSource === 'typed' &&
        i.bazaUsd !== null &&
        (i.bazaUsd !== i.dictionaryBaza.bazaUsd || i.bazaBasis !== i.dictionaryBaza.basis),
    )
  ) {
    out.push('baza_off_dictionary');
  }
  // A blind confirm is a CONJUNCTION and each clause earns its place: the
  // model actually proposed this group (`mergeProposals` mints orphan groups
  // with `aiProposed: false`), it said so itself with low confidence, and the
  // dictionary could not have corrected it.
  if (facts.aiProposed && facts.aiConfidence === 'low' && facts.dictionaryRates === null) {
    out.push('ai_low_confidence');
  }
  if (aiRateTaken(facts)) out.push('ai_rate_taken');

  return out;
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
