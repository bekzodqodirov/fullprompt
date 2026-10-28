/**
 * The 2.8 b block (docs/SAKKIZ-R3.md §10.2.6, his 1.14 a): the rows a stored
 * request owes a figure the LAW pins. K's stub; P5 fills it over `lineNeeds`.
 */
import type { CalcFacts, CalcSection } from './intake';
import type { NeedLaw, RowNeed } from './needs';

export interface LawAsk {
  itemId: string;
  seq: number;
  name: string;
  needs: RowNeed[];
}

/** The ⚠️ rows of the add table that are law-pinned, outside ✅'d groups, in seq order. K: none. */
export function lawAsksOf(_stored: {
  section: CalcSection;
  facts: CalcFacts;
  bookLaws: ReadonlyMap<string, NeedLaw>;
  confirmedSeqs: ReadonlySet<number>;
}): LawAsk[] {
  return [];
}
