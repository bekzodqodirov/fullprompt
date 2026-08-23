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

export interface PricedGroup {
  seq: number;
  label: string;
  tnvedCode: string | null;
  dutyPct: number | null;
  vatPct: number | null;
  feeUsd: number | null;
  /** The lgota, decided per CALCULATION — the same code is not always free. */
  dutyFree: boolean;
  vatFree: boolean;
}

export type CustomsRefusal =
  | 'group_empty'
  | 'baza_missing'
  | 'measure_missing'
  | 'rates_missing';

export interface CustomsBreakdown {
  ok: true;
  valueUsd: number;
  dutyUsd: number;
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

  let value = 0;
  for (const item of items) {
    if (item.bazaUsd === null || item.bazaBasis === null) {
      return { ok: false, reason: 'baza_missing', itemSeq: item.seq, itemLabel: item.label };
    }
    const measure = item.bazaBasis === 'kg' ? item.weightKg : item.quantity;
    if (measure === null || !(measure > 0)) {
      return { ok: false, reason: 'measure_missing', itemSeq: item.seq, itemLabel: item.label };
    }
    value += item.bazaUsd * measure;
  }

  const valueUsd = round2(value);
  const dutyUsd = round2((valueUsd * dutyPct) / 100);
  const vatUsd = round2(((valueUsd + dutyUsd) * vatPct) / 100);
  // A fee is additively zero far more often than it is unknown, and a group
  // whose rates came from the dictionary always carries one.
  const feeUsd = round2(group.feeUsd ?? 0);

  return {
    ok: true,
    valueUsd,
    dutyUsd,
    vatUsd,
    feeUsd,
    customsUsd: round2(dutyUsd + vatUsd + feeUsd),
  };
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

export type FreightRefusal = 'zone_required' | 'measure_missing' | BandRefusal;

export interface FreightBreakdown {
  ok: true;
  density: number;
  /** What the band was actually chosen by — the override when there is one. */
  bandDensity: number;
  band: FreightBand;
  listUsd: number;
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

  const density = kg / m3;
  const bandDensity = bandDensityOf(input.overrideDensity ?? density);
  const found = bandFor(rows, input.zone, bandDensity);
  if (!found.ok) return found;

  const band = found.band;
  return {
    ok: true,
    density,
    bandDensity,
    band,
    listUsd: round2(band.perKg ? band.priceUsd * kg : band.priceUsd * m3),
  };
}

/* ------------------------------------------------------------------ */
/* Totals                                                              */
/* ------------------------------------------------------------------ */

export type TotalsRefusal = 'discount_exceeds_total';

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
