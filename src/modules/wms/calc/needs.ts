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
  /** The baza's VALUE asks it, the law's per-unit FLOOR does, or a specific
   * EXCISE does (beer per litre). */
  why: 'baza' | 'duty' | 'excise';
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
  /** A specific excise asks its own figure — absent/null when there is none
   * (the engine charges it only when `excisePct` is not positive). */
  excisePct?: number | null;
  exciseSpecific?: number | null;
  exciseUnit?: DutyUnit | null;
}

/** The ONE way a group becomes a NeedLaw — every screen builds it here, so a
 * field the engine reads (excise) reaches every need without each caller
 * learning its name. */
export function needLawOf(g: {
  dutyMode: DutyMode;
  dutyUnit: DutyUnit | null;
  dutySpecific: number | null;
  dutyFree: boolean;
  excisePct?: number | null;
  exciseSpecific?: number | null;
  exciseUnit?: DutyUnit | null;
}): NeedLaw {
  return {
    dutyMode: g.dutyMode,
    dutyUnit: g.dutyUnit,
    dutySpecific: g.dutySpecific,
    dutyFree: g.dutyFree,
    excisePct: g.excisePct ?? null,
    exciseSpecific: g.exciseSpecific ?? null,
    exciseUnit: g.exciseUnit ?? null,
  };
}

export type NeedItem = Pick<
  PricedItem,
  'quantity' | 'weightKg' | 'volumeM3' | 'measureUnit' | 'measureQty'
>;

/** A baza basis or a law unit in the needs' vocabulary — the baza's storage
 * spelling `unit` is a count, read as dona. */
export const needUnitOf = (u: BazaBasis | DutyUnit): NeedUnit => (u === 'unit' ? 'dona' : u);
const asNeed = needUnitOf;

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
  // The engine's own condition (pricing.ts): a specific excise is charged only
  // when no ad-valorem excise is.
  const advaloremExcise = law?.excisePct !== null && law?.excisePct !== undefined && law.excisePct > 0;
  if (law && !advaloremExcise && law.exciseSpecific != null && law.exciseUnit != null) {
    out.push({
      unit: asNeed(law.exciseUnit),
      why: 'excise',
      present: has(item, law.exciseUnit),
      rate: law.exciseSpecific,
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

/**
 * A missing figure in the office's Uzbek — ONE sentence for the bot's
 * question, the bot's blocker and the checklist (judge S3, S5), so the seller
 * never reads two different names for one number. The screen speaks the
 * reader's locale through `calc.refusals.need*` (hisoblash/[id]/words.ts),
 * built from the same three facts.
 */
const NEED_WHAT_UZ: Record<NeedUnit, string> = {
  dona: 'soni (dona)',
  kg: 'sof og‘irligi (kg)',
  m3: 'hajmi (m³)',
  m2: 'maydoni (m²)',
  juft: 'juft soni',
  litr: 'hajmi (litr)',
  sm3: 'dvigatel hajmi (sm³)',
  '1000_dona': 'soni (dona)',
};

const NEED_SHORT_UZ: Record<NeedUnit, string> = {
  dona: 'dona',
  kg: 'kg',
  m3: 'm³',
  m2: 'm²',
  juft: 'juft',
  litr: 'litr',
  sm3: 'sm³',
  '1000_dona': '1000 dona',
};

const rateText = (n: number) => String(Number(n.toFixed(4)));

export function needWhatUz(unit: NeedUnit): string {
  return NEED_WHAT_UZ[unit];
}

/** The unit's own short word — «dona», «m²» — for the bot's examples and
 * figures, so the bot never spells a unit two ways. */
export function needShortUz(unit: NeedUnit): string {
  return NEED_SHORT_UZ[unit];
}

/** Why the figure is asked: the baza is per it, or the law's floor / a
 * specific excise counts in it — with the rate, so «nega kerak» is answered
 * in the same line. */
export function needWhyUz(n: Pick<RowNeed, 'unit' | 'why' | 'rate'>): string {
  const per = NEED_SHORT_UZ[n.unit];
  if (n.why === 'baza') return `baza ${per} bo‘yicha`;
  const rate = n.rate !== null && Number.isFinite(n.rate) ? `$${rateText(n.rate)}/${per}` : per;
  return n.why === 'duty' ? `boj kamida ${rate}` : `aksiz ${rate}`;
}

/** «soni (dona) kiritilmagan — boj kamida $3/dona». */
export function needPhraseUz(n: Pick<RowNeed, 'unit' | 'why' | 'rate'>): string {
  return `${needWhatUz(n.unit)} kiritilmagan — ${needWhyUz(n)}`;
}
