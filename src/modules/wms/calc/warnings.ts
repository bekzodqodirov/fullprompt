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
  aiProposed: boolean;
  aiConfidence: 'high' | 'medium' | 'low' | null;
  aiDutyPct: number | null;
  /** One entry per ITEM: did the baza dictionary answer, and what was typed. */
  items: { hasDictionaryBaza: boolean; bazaSource: 'dictionary' | 'typed' | null }[];
}

/**
 * A warning means «the dictionary HAD an answer and a person typed something
 * else», and the `dictionary !== null` half is what makes the list useful.
 *
 * Without it the rule reads «rate_source is typed», which is TRUE of every
 * group in the company: `0086` and `0087` ship the dictionaries EMPTY, so on
 * deploy morning nobody has ever priced anything from one. The owner's first
 * list would be 23 rows out of 23, and a list that names everything names
 * nothing. Typing a rate the dictionary cannot supply is not a mistake — it
 * is the only thing a person can do.
 */
export function warningsForGroup(facts: WarningGroupFacts): CalcWarningKind[] {
  const out: CalcWarningKind[] = [];

  if (facts.dictionaryRates !== null && facts.rateSource === 'typed') {
    out.push('rate_off_dictionary');
  }
  if (facts.items.some((i) => i.hasDictionaryBaza && i.bazaSource === 'typed')) {
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
