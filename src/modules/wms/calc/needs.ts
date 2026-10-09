/**
 * What ONE row must state before its customs can be computed — the engine's
 * own two questions, asked ahead of time so every screen, the checklist and
 * the bot can say WHICH figure is missing and WHY.
 *
 * `customsFor` multiplies a baza by the row's measure in the baza's unit (the
 * VALUE), and — on a max / specific / plus law — sums the row's measure in the
 * LAW's unit (the floor). Those are two different numbers whenever the two
 * units differ, and that is the owner's «kg hamda donani birga kirgizadgan
 * tovarlar» (2026-10-09): a jacket valued per kg whose law says «20 %, but at
 * least $3 per piece» needs its weight AND its count; a table valued per piece
 * under «15 %, but at least $0.4 per kg» needs its count AND its weight. The
 * intake checklist used to accept any ONE figure (#910), so such a row landed
 * «to'liq» and was refused later with «o'lchov yo'q», naming neither figure.
 *
 * Pure: the engine's `itemMeasure` is the one reading of «how much of this
 * row in that unit», so a need and a refusal can never disagree.
 */
import {
  itemMeasure,
  type BazaBasis,
  type DutyMode,
  type DutyUnit,
  type PricedItem,
} from './pricing';

/** A unit in the words a person reads it in — dona, not the baza's `unit`. */
export type NeedUnit = 'dona' | 'kg' | 'm3' | 'm2' | 'juft' | 'litr' | 'sm3' | '1000_dona';

export interface RowNeed {
  unit: NeedUnit;
  /** The baza's VALUE asks it, or the law's per-unit FLOOR does. */
  why: 'baza' | 'duty';
  /** The row states a positive figure in this unit. */
  present: boolean;
  /** The floor's rate per unit, for the sentence «boj kamida $3/dona». */
  rate: number | null;
}

export interface NeedLaw {
  dutyMode: DutyMode;
  dutyUnit: DutyUnit | null;
  dutySpecific: number | null;
  dutyFree: boolean;
}

export type NeedItem = Pick<
  PricedItem,
  'quantity' | 'weightKg' | 'volumeM3' | 'measureUnit' | 'measureQty'
>;

const asNeed = (u: BazaBasis | DutyUnit): NeedUnit => (u === 'unit' ? 'dona' : u);

const has = (item: NeedItem, u: BazaBasis | DutyUnit) => {
  const m = itemMeasure({ ...item, seq: 0, label: '', bazaUsd: null, bazaBasis: null }, u);
  return m !== null && m > 0;
};

/**
 * The row's needs, baza first. `basis` null means nobody has said what the
 * baza is per yet — the VALUE half asks nothing until it is known (the screen
 * shows «avto» and the law's default; `defaultBasisFor` answers that). `law`
 * null means the row has no code, or its code's law is not known yet.
 *
 * A duty-free (lgota) row asks no floor: the engine skips the specific half.
 */
export function rowNeeds(law: NeedLaw | null, basis: BazaBasis | null, item: NeedItem): RowNeed[] {
  const out: RowNeed[] = [];
  if (basis !== null) {
    out.push({ unit: asNeed(basis), why: 'baza', present: has(item, basis), rate: null });
  }
  if (law && law.dutyMode !== 'advalor' && !law.dutyFree && law.dutyUnit !== null) {
    out.push({
      unit: asNeed(law.dutyUnit),
      why: 'duty',
      present: has(item, law.dutyUnit),
      rate: law.dutySpecific,
    });
  }
  return out;
}

/** The figures still missing, each unit once — `dona` and `1000_dona` both
 * read the count, so a row missing its count is asked for it once. */
export function missingNeeds(needs: RowNeed[]): RowNeed[] {
  const seen = new Set<string>();
  const out: RowNeed[] = [];
  for (const n of needs) {
    if (n.present) continue;
    const key = n.unit === '1000_dona' ? 'dona' : n.unit;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}
