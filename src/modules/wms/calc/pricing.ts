/**
 * The VED calculation, as arithmetic (docs/VED.md phase B). Pure — no
 * imports, no database, no clock — so every rule below is unit-testable and
 * the screen and the seal cannot disagree about a number.
 *
 * The governing rule of this file is that **it never returns a number it had
 * to invent**. `4 * null` is `0` in JavaScript, and the goods a seller
 * forwards from Telegram routinely carry no weight and often no quantity,
 * while the rates dictionary is born EMPTY — so an engine that multiplies
 * happily would seal a locked, client-facing «rastamojka: $0.00» on a real
 * consignment. Every entry point answers `{ok:true, …}` or
 * `{ok:false, reason}`, and the caller has to look.
 */

export type CalcSectionName = 'yolkira' | 'rastamojka' | 'podklyuch';
export type BazaBasis = 'unit' | 'kg';

/** What a section is made of. The seal and the screen both ask this. */
export function sectionParts(section: CalcSectionName): {
  customs: boolean;
  freight: boolean;
  extras: boolean;
} {
  return {
    customs: section !== 'yolkira',
    freight: section !== 'rastamojka',
    extras: true,
  };
}

/* ------------------------------------------------------------------ */
/* Customs                                                             */
/* ------------------------------------------------------------------ */

/**
 * The priced unit is the ITEM, not the group.
 *
 * The owner's law 5: a baza belongs to a PRODUCT, and one TNVED code holds
 * several products with different bazas. Two products under 8471.30 at $8/kg
 * and $3/kg, priced at whichever of the two the group happened to carry, is
 * a 45 % error on a realistic pair — so the baza lives here and the group
 * keeps only what is genuinely per-code.
 */
export interface PricedItem {
  seq: number;
  label: string;
  quantity: number | null;
  weightKg: number | null;
  bazaUsd: number | null;
  bazaBasis: BazaBasis | null;
}

/**
 * PP-3818's four shapes of a duty (VED 2.0 phase 1). `advalor` is BQ × %;
 * `specific` is Miqdor × T per unit; `max` is the greater of the two («20 %,
 * lekin 3 AQSH dollaridan kam emas» — 198 rows); `plus` is their sum (the
 * vehicle rows). A `max` read as its percentage alone silently loses the
 * floor, which on light goods IS the duty — hence a mode and not a flag.
 */
export type DutyMode = 'advalor' | 'specific' | 'max' | 'plus';

/**
 * The units the law writes specific rates in. The ENGINE prices the first
 * three — a calc request's items carry weight and quantity and nothing else —
 * and refuses the rest with `unit_unsupported`, because reading a litre rate
 * against a piece count is a number, just the wrong one.
 */
export type DutyUnit = 'kg' | 'dona' | 'litr' | 'juft' | '1000_dona' | 'sm3' | 'm2';

export interface PricedGroup {
  seq: number;
  label: string;
  tnvedCode: string | null;
  dutyPct: number | null;
  vatPct: number | null;
  feeUsd: number | null;
  /** All three REQUIRED (null duty_mode in the db reads as 'advalor' — the
   * mapping layer resolves it, so no caller can forget the law's shape). */
  dutyMode: DutyMode;
  dutySpecific: number | null;
  dutyUnit: DutyUnit | null;
  /** Advalor excise, the rare case. null means «not an excise good». */
  excisePct: number | null;
  /** Resolved by the caller: the group's own answer, else the request's.
   * Without a certificate of origin the 28.02.2026 additional duty applies. */
  hasCertificate: boolean;
  /** The lgota, decided per CALCULATION — the same code is not always free. */
  dutyFree: boolean;
  vatFree: boolean;
}

export type CustomsRefusal =
  | 'group_empty'
  | 'baza_missing'
  | 'measure_missing'
  | 'rates_missing'
  | 'unit_unsupported'
  | 'not_a_number';

/**
 * A number this file is willing to multiply.
 *
 * `Number('1 000')` and `Number('abc')` are both `NaN`, and NaN passes every
 * comparison guard ever written: `NaN < 0 || NaN > 100` is false, `NaN > 0` is
 * false, `NaN >= 0` is false. Postgres then stores `'NaN'::numeric` happily —
 * and `'NaN'::numeric >= 0` is TRUE there, so even the seal's own
 * `total_usd >= 0` CHECK waves it through onto a customer's locked card.
 *
 * The forms and the actions refuse a typo before it reaches here. This is the
 * layer that makes the file's contract true rather than merely intended: a
 * number that is not finite is not a number, and the answer is a refusal.
 */
export const isNumber = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n);

const ok = isNumber;

export interface CustomsBreakdown {
  ok: true;
  valueUsd: number;
  dutyUsd: number;
  /** BK 300-1 (28.02.2026): BQ × 5/10/15/20 % when no origin certificate. */
  addDutyUsd: number;
  /** The band the advalor rate fell in — 0 when a certificate stands. */
  addDutyPct: number;
  exciseUsd: number;
  vatUsd: number;
  feeUsd: number;
  customsUsd: number;
}

export type CustomsResult =
  | CustomsBreakdown
  | { ok: false; reason: CustomsRefusal; itemSeq?: number; itemLabel?: string };

/**
 * One group's customs.
 *
 * Rounding follows what a broker does by hand, and it is done in this order
 * for one reason: every figure the screen prints must be reproducible from
 * the figures printed beside it. The declared VALUE is rounded first, duty is
 * taken from the rounded value, VAT from value + rounded duty. A table whose
 * lines do not add up to its total is read as a broken screen, however
 * defensible the extra precision behind it was.
 */
export function customsFor(group: PricedGroup, items: PricedItem[]): CustomsResult {
  if (items.length === 0) return { ok: false, reason: 'group_empty' };

  // A group whose lgota frees it needs no rate; anything else must have been
  // decided by a person or read from the dictionary. Absent is not zero.
  const dutyPct = group.dutyFree ? 0 : group.dutyPct;
  const vatPct = group.vatFree ? 0 : group.vatPct;
  if (dutyPct === null || vatPct === null) return { ok: false, reason: 'rates_missing' };
  if (
    !ok(dutyPct) ||
    !ok(vatPct) ||
    (group.feeUsd !== null && !ok(group.feeUsd)) ||
    (group.excisePct !== null && !ok(group.excisePct))
  ) {
    return { ok: false, reason: 'not_a_number' };
  }
  // A non-advalor mode without its specific half is a row the CHECK forbids;
  // reaching here means a mapping bug, and the honest answer is a refusal.
  if (group.dutyMode !== 'advalor' && !group.dutyFree) {
    if (group.dutySpecific === null || group.dutyUnit === null) {
      return { ok: false, reason: 'rates_missing' };
    }
    if (!ok(group.dutySpecific)) return { ok: false, reason: 'not_a_number' };
  }

  let value = 0;
  for (const item of items) {
    if (item.bazaUsd === null || item.bazaBasis === null) {
      return { ok: false, reason: 'baza_missing', itemSeq: item.seq, itemLabel: item.label };
    }
    const measure = item.bazaBasis === 'kg' ? item.weightKg : item.quantity;
    if (measure === null || !(measure > 0)) {
      return { ok: false, reason: 'measure_missing', itemSeq: item.seq, itemLabel: item.label };
    }
    if (!ok(item.bazaUsd) || !ok(measure)) {
      return { ok: false, reason: 'not_a_number', itemSeq: item.seq, itemLabel: item.label };
    }
    value += item.bazaUsd * measure;
  }

  const valueUsd = round2(value);

  // The advalor half. For 'max' and 'plus' rows this is one of two parts.
  const advalorUsd = round2((valueUsd * dutyPct) / 100);

  // The specific half: Miqdor × T, over the measure the LAW names — never a
  // reinterpretation. A request's items carry weight and quantity; a litre or
  // a square metre exists on neither, and pricing a juft rate against a piece
  // count would be a number that is simply wrong, so those refuse.
  let dutyUsd = advalorUsd;
  if (group.dutyMode !== 'advalor' && !group.dutyFree) {
    const unit = group.dutyUnit!;
    let quantity: number;
    if (unit === 'kg') {
      let kg = 0;
      for (const item of items) {
        if (item.weightKg === null || !(item.weightKg > 0)) {
          return { ok: false, reason: 'measure_missing', itemSeq: item.seq, itemLabel: item.label };
        }
        if (!ok(item.weightKg)) {
          return { ok: false, reason: 'not_a_number', itemSeq: item.seq, itemLabel: item.label };
        }
        kg += item.weightKg;
      }
      quantity = kg;
    } else if (unit === 'dona' || unit === '1000_dona') {
      let count = 0;
      for (const item of items) {
        if (item.quantity === null || !(item.quantity > 0)) {
          return { ok: false, reason: 'measure_missing', itemSeq: item.seq, itemLabel: item.label };
        }
        if (!ok(item.quantity)) {
          return { ok: false, reason: 'not_a_number', itemSeq: item.seq, itemLabel: item.label };
        }
        count += item.quantity;
      }
      quantity = unit === '1000_dona' ? count / 1000 : count;
    } else {
      return { ok: false, reason: 'unit_unsupported' };
    }

    const specificUsd = round2(quantity * group.dutySpecific!);
    dutyUsd =
      group.dutyMode === 'specific'
        ? specificUsd
        : group.dutyMode === 'max'
          ? Math.max(advalorUsd, specificUsd)
          : round2(advalorUsd + specificUsd);
  }

  // BK 300-1 (28.02.2026): without a certificate of origin the additional
  // duty is BQ × the band the code's ADVALOR rate falls in. Not when the
  // lgota frees the duty — a lgota is proven origin, and origin proven and
  // origin unknown cannot both be true of one consignment.
  const addDutyPct = !group.hasCertificate && !group.dutyFree ? addDutyBand(dutyPct) : 0;
  const addDutyUsd = round2((valueUsd * addDutyPct) / 100);

  // Excise is the rare case — ordinary consumer goods carry none, and null
  // means exactly that. Base = customs value (SK 285).
  const exciseUsd = round2((valueUsd * (group.excisePct ?? 0)) / 100);

  // SK 254: the VAT base is value + duty + additional duty + excise.
  const vatUsd = round2(((valueUsd + dutyUsd + addDutyUsd + exciseUsd) * vatPct) / 100);
  // A fee is additively zero far more often than it is unknown, and the
  // per-DECLARATION fee (`customsFeeFor`) lands at the request grain — this
  // per-group column survives for rows a person typed one into.
  const feeUsd = round2(group.feeUsd ?? 0);

  return {
    ok: true,
    valueUsd,
    dutyUsd,
    addDutyUsd,
    addDutyPct,
    exciseUsd,
    vatUsd,
    feeUsd,
    customsUsd: round2(dutyUsd + addDutyUsd + exciseUsd + vatUsd + feeUsd),
  };
}

/**
 * BK 300-1's band, decided by the code's advalor rate.
 *
 * The boundaries are inclusive-HIGH — exactly 20 % lands in the «20 dan 30
 * gacha» band — because the guide's own worked example 9.2 prices a 20 %
 * idish-tovoq at +15 %, and the law's text («10 dan 20 gacha») does not
 * decide it. The guide says to ask the post about boundary codes; until the
 * post disagrees, the example is the spec.
 */
export function addDutyBand(advalorPct: number): number {
  if (advalorPct < 10) return 5;
  if (advalorPct < 20) return 10;
  if (advalorPct < 30) return 15;
  return 20;
}

/* ------------------------------------------------------------------ */
/* Freight                                                             */
/* ------------------------------------------------------------------ */

export interface FreightBand {
  zone: string;
  minDensity: number;
  /** Inclusive. null is the open-ended top row. */
  maxDensity: number | null;
  priceUsd: number;
  perKg: boolean;
}

export type BandRefusal = 'band_missing' | 'band_ambiguous';

export type BandResult = { ok: true; band: FreightBand } | { ok: false; reason: BandRefusal };

/**
 * The whole kg/m³ a band is looked up by.
 *
 * His tariff is written in whole numbers — «1–100», «101–150» — so the band
 * that answers a load must be found with a whole number too. Carried to the
 * lookup raw, a perfectly ordinary 100.4 kg/m³ falls between his first row's
 * top and his second row's floor and is covered by NEITHER: eleven
 * one-wide holes, in the densest part of the traffic. Rounding closes exactly
 * those and closes nothing else — 900.6 still finds no row, which is the hole
 * he actually has.
 *
 * It is also what the VED sees. Every screen in this system prints density
 * with `Math.round`, so a band chosen on the raw value would disagree with
 * the number printed beside it, and «it says 100 and charges the 101 rate» is
 * a support call, not an explanation. The raw density is kept for the record;
 * this is the one the money is decided by.
 */
export const bandDensityOf = (density: number) => Math.round(density);

/**
 * The band a density falls in, within one zone.
 *
 * Both refusals are his table's, not ours. 900-999 kg/m³ is covered by no row
 * (`band_missing`), and 700 is covered by two (`band_ambiguous`). Reading the
 * rows as bare lower bounds would answer both silently and cheaply — $9,600
 * instead of $15,675 on 30 m³ at 950 — so the lookup refuses and the owner's
 * answer becomes a dated row.
 */
export function bandFor(rows: FreightBand[], zone: string, density: number): BandResult {
  const d = bandDensityOf(density);
  const hits = rows.filter(
    (r) => r.zone === zone && d >= r.minDensity && (r.maxDensity === null || d <= r.maxDensity),
  );
  if (hits.length === 0) return { ok: false, reason: 'band_missing' };
  if (hits.length > 1) return { ok: false, reason: 'band_ambiguous' };
  return { ok: true, band: hits[0]! };
}

export type FreightRefusal = 'zone_required' | 'measure_missing' | 'not_a_number' | BandRefusal;

/**
 * Law 8's «no minimum charge — very small cargo gets only a warning».
 *
 * The first half has always held (nothing floors `listUsd`); this constant is
 * the second half. MONEY and not volume, because the point of the warning is
 * a tiny invoice — 0.3 m³ of light goods and 40 kg of dense ones are both
 * under it, and both are jobs where the VED may want to quote differently
 * rather than send a $22 freight line.
 */
export const SMALL_FREIGHT_USD = 50;

export interface FreightBreakdown {
  ok: true;
  density: number;
  /** What the band was actually chosen by — the override when there is one. */
  bandDensity: number;
  band: FreightBand;
  listUsd: number;
  /** Under SMALL_FREIGHT_USD — priced honestly, flagged loudly. */
  small: boolean;
}

export type FreightResult = FreightBreakdown | { ok: false; reason: FreightRefusal };

/**
 * The list price of the road, before any concession.
 *
 * `overrideDensity` is the VED's judgement that this load really belongs in
 * another band — a statement about the cargo, recorded and flagged. It is not
 * a discount, and the two are kept apart all the way into the seal, because
 * only one of them is a concession to the client and phase D withdraws the
 * upsale right on exactly that one.
 */
export function freightFor(
  rows: FreightBand[],
  input: {
    zone: string | null;
    weightKg: number | null;
    volumeM3: number | null;
    overrideDensity?: number | null;
  },
): FreightResult {
  if (!input.zone) return { ok: false, reason: 'zone_required' };
  const kg = input.weightKg;
  const m3 = input.volumeM3;
  if (kg === null || !(kg > 0) || m3 === null || !(m3 > 0)) {
    return { ok: false, reason: 'measure_missing' };
  }
  if (!ok(kg) || !ok(m3) || (input.overrideDensity != null && !ok(input.overrideDensity))) {
    return { ok: false, reason: 'not_a_number' };
  }

  const density = kg / m3;
  const bandDensity = bandDensityOf(input.overrideDensity ?? density);
  const found = bandFor(rows, input.zone, bandDensity);
  if (!found.ok) return found;

  const band = found.band;
  const listUsd = round2(band.perKg ? band.priceUsd * kg : band.priceUsd * m3);
  return {
    ok: true,
    density,
    bandDensity,
    band,
    listUsd,
    small: listUsd < SMALL_FREIGHT_USD,
  };
}

/* ------------------------------------------------------------------ */
/* The customs fee (bojxona yig'imi)                                   */
/* ------------------------------------------------------------------ */

/**
 * VMQ-55's step scale (2026 edition): the declaration's customs value in
 * USD decides a BHM coefficient. Each entry is «value up to and including
 * this → this many BHM»; past the last row the law's own words are
 * «1 000 000 USD va undan ortiq → 25», so exactly a million pays 25.
 */
export const FEE_TIERS: ReadonlyArray<readonly [maxValueUsd: number, bhm: number]> = [
  [10_000, 1],
  [20_000, 1.5],
  [40_000, 2.5],
  [60_000, 4],
  [100_000, 7],
  [200_000, 10],
  [500_000, 15],
  [1_000_000, 20],
];

export type FeeRefusal = 'fee_fx_missing' | 'not_a_number';

export interface FeeBreakdown {
  ok: true;
  feeUsd: number;
  /** The coefficient the value landed on — the screen prints «2,5 BHM». */
  bhmCoefficient: number;
  /** True when a typed override stands in for the computed tier. */
  overridden: boolean;
}

export type FeeResult = FeeBreakdown | { ok: false; reason: FeeRefusal };

/**
 * The fee prices a DECLARATION, not a group — one request, one fee — which
 * is why it is not a per-code dictionary number: a per-code fee would be
 * added once per group and a three-group job would pay it three times.
 *
 * The scale is written in BHM (so'm) and this system prices in USD, so the
 * day's UZS rate is load-bearing: absent, the answer is a refusal and never
 * an invented conversion. `overrideUsd` is the VED's word that this job's
 * declaration count or tier differs (the −20 % preliminary-declaration
 * discount lives there too, stated rather than modelled).
 */
export function customsFeeFor(input: {
  valueUsd: number;
  bhmUzs: number;
  /** UZS per USD on the day. null = no rate in the book. */
  fxUzsPerUsd: number | null;
  overrideUsd: number | null;
}): FeeResult {
  if (input.overrideUsd !== null) {
    if (!ok(input.overrideUsd) || input.overrideUsd < 0) {
      return { ok: false, reason: 'not_a_number' };
    }
    return { ok: true, feeUsd: round2(input.overrideUsd), bhmCoefficient: 0, overridden: true };
  }
  if (!ok(input.valueUsd) || !ok(input.bhmUzs) || !(input.bhmUzs > 0)) {
    return { ok: false, reason: 'not_a_number' };
  }
  if (input.fxUzsPerUsd === null || !(input.fxUzsPerUsd > 0)) {
    return { ok: false, reason: 'fee_fx_missing' };
  }
  if (!ok(input.fxUzsPerUsd)) return { ok: false, reason: 'not_a_number' };

  // «1 000 000 USD va undan ortiq → 25» — the ONE boundary the law's own
  // words decide, and it lands in the HIGHER tier unlike every «gacha» below
  // it. Checked first, or the last tier's `<=` would hand exactly a million
  // the 20 it does not get (this off-by-one shipped and its boundary test
  // caught it).
  const tier = input.valueUsd >= 1_000_000 ? undefined : FEE_TIERS.find(([max]) => input.valueUsd <= max);
  const bhmCoefficient = tier ? tier[1] : 25;
  const feeUsd = round2((bhmCoefficient * input.bhmUzs) / input.fxUzsPerUsd);
  return { ok: true, feeUsd, bhmCoefficient, overridden: false };
}

/* ------------------------------------------------------------------ */
/* Totals                                                              */
/* ------------------------------------------------------------------ */

export type TotalsRefusal = 'discount_exceeds_total' | 'not_a_number';

export interface Totals {
  ok: true;
  customsUsd: number;
  freightUsd: number;
  extrasUsd: number;
  discountUsd: number;
  totalUsd: number;
  perM3Usd: number | null;
  perKgUsd: number | null;
}

export type TotalsResult = Totals | { ok: false; reason: TotalsRefusal };

/**
 * The section comes FIRST, and it decides which parts exist.
 *
 * A `rastamojka` quote does not have a freight line that happens to be zero —
 * it does not have a freight line, and the band must not appear anywhere on
 * the sheet. Zeroing a computed number and never computing it look identical
 * in a total and read very differently to the client holding the offer.
 */
export function totalsFor(input: {
  section: CalcSectionName;
  customsUsd: number;
  freightUsd: number;
  extrasUsd: number;
  discountUsd: number;
  weightKg: number | null;
  volumeM3: number | null;
}): TotalsResult {
  for (const n of [input.customsUsd, input.freightUsd, input.extrasUsd, input.discountUsd]) {
    if (!ok(n)) return { ok: false, reason: 'not_a_number' };
  }

  const parts = sectionParts(input.section);
  const customsUsd = parts.customs ? round2(input.customsUsd) : 0;
  const freightUsd = parts.freight ? round2(input.freightUsd) : 0;
  const extrasUsd = parts.extras ? round2(input.extrasUsd) : 0;
  const discountUsd = round2(input.discountUsd);

  const gross = round2(customsUsd + freightUsd + extrasUsd);
  if (discountUsd > gross) return { ok: false, reason: 'discount_exceeds_total' };
  const totalUsd = round2(gross - discountUsd);

  const m3 = input.volumeM3;
  const kg = input.weightKg;
  return {
    ok: true,
    customsUsd,
    freightUsd,
    extrasUsd,
    discountUsd,
    totalUsd,
    perM3Usd: m3 !== null && m3 > 0 ? round2(totalUsd / m3) : null,
    perKgUsd: kg !== null && kg > 0 ? round4(totalUsd / kg) : null,
  };
}

/** Unrounded, like `computeLotTotals` — the band lookup depends on it. */
export function densityOf(weightKg: number | null, volumeM3: number | null): number | null {
  if (weightKg === null || volumeM3 === null || !(volumeM3 > 0)) return null;
  return weightKg / volumeM3;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
