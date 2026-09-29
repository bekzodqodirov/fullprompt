/**
 * The owner's KPI rule, pure (2026-09-29, his 3a / 4a):
 *
 *   KPI = the month's m³ × the $/m³ in his table's cell, where the ROW is the
 *   month's m³ «gacha» (≤30, ≤50 … >150) and the COLUMN is the month's
 *   average density «до» (≤100, ≤200, ≤350, >350 kg/m³).
 *
 * The freight tariff's lookup shape (calc/pricing.ts, #767): both bounds are
 * INCLUSIVE at the top — exactly 30 m³ is the ≤30 row, exactly 100 kg/m³ is
 * «до 100» (his own «40 m³ lands in the 50 row» and «exactly 100 → до 100») —
 * the NULL top is the open row/column, and the density is looked up as a
 * WHOLE kg/m³ (`Math.round`, the tariff's rule: 100.4 is «до 100», 100.5 is
 * 101 and «до 200»). The m³ is NOT rounded to a whole number: 30.0001 m³ is
 * past the ≤30 row, and his table pays per cube.
 *
 * It NEVER returns a number it had to invent (#767's law): every answer is
 * `{ok:true,…}` or `{ok:false, reason}`, and a screen prints ⚠ + the reason,
 * never $0. `no_cargo` is the one refusal that is a TRUE zero — a month with
 * no cargo earns nothing and blocks nothing; every other one blocks the pay
 * and names its month.
 *
 * Zero imports: the unit test reads it directly, and so could a browser.
 */

export interface KpiCell {
  /** Tier top in m³, inclusive; null = the open top («>150»). */
  maxM3: number | null;
  /** Band top in kg/m³, inclusive; null = the open top («от 350»). */
  maxDensity: number | null;
  rateUsd: number;
}

export type KpiRefusal = 'no_cargo' | 'lot_unmeasured' | 'rate_missing' | 'rate_ambiguous' | 'not_a_number';

export type KpiResult =
  | {
      ok: true;
      m3: number;
      kg: number;
      /** Σkg ÷ Σm³, as the WHOLE kg/m³ the band was looked up by. */
      density: number;
      tierMaxM3: number | null;
      bandMaxDensity: number | null;
      rate: number;
      earnedUsd: number;
    }
  | {
      ok: false;
      reason: KpiRefusal;
      /** Receipt NUMBERS behind `lot_unmeasured` — never a client, never a figure. */
      receipts?: string[];
    };

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const isNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * The top that claims a value: the smallest bound that `fits`, else the open
 * top. `undefined` = nothing claims it (a table with no open top and a value
 * past its last bound). The comparison is the CALLER's, written out at each
 * of the two call sites, so the tier's inclusive top and the band's are two
 * facts a test can hold separately.
 */
function claim(bounds: (number | null)[], fits: (top: number) => boolean): number | null | undefined {
  const closed = [...new Set(bounds.filter((b): b is number => b !== null))].sort((a, b) => a - b);
  const hit = closed.find(fits);
  if (hit !== undefined) return hit;
  return bounds.includes(null) ? null : undefined;
}

export function kpiFor(
  cells: KpiCell[] | null,
  cargo: { m3: number; kg: number; unmeasured: string[] },
): KpiResult {
  // NaN answers false to every comparison a guard is built of (#777), so it
  // is asked FIRST and by name.
  if (!isNumber(cargo.m3) || !isNumber(cargo.kg)) return { ok: false, reason: 'not_a_number' };
  // A lot with no positive kg or m³ would move the band without being cargo
  // anybody measured — the month waits for the receipt to be corrected.
  if (cargo.unmeasured.length > 0) return { ok: false, reason: 'lot_unmeasured', receipts: [...cargo.unmeasured] };
  const m3 = round4(cargo.m3);
  if (m3 <= 0) return { ok: false, reason: 'no_cargo' };
  if (!cells || cells.length === 0) return { ok: false, reason: 'rate_missing' };
  if (cells.some((c) => !isNumber(c.rateUsd) || (c.maxM3 !== null && !isNumber(c.maxM3)) || (c.maxDensity !== null && !isNumber(c.maxDensity)))) {
    return { ok: false, reason: 'not_a_number' };
  }

  const density = Math.round(cargo.kg / m3);
  // «gacha» — up to AND including the top (his 3a: 40 m³ is the ≤50 row, 30 the ≤30 one).
  const tier = claim(
    cells.map((c) => c.maxM3),
    (top) => m3 <= top,
  );
  // «до» — likewise (his 4a: exactly 100 kg/m³ is «до 100»).
  const band = claim(
    cells.map((c) => c.maxDensity),
    (top) => density <= top,
  );
  if (tier === undefined || band === undefined) return { ok: false, reason: 'rate_missing' };

  const hits = cells.filter((c) => c.maxM3 === tier && c.maxDensity === band);
  if (hits.length === 0) return { ok: false, reason: 'rate_missing' };
  if (hits.length > 1) return { ok: false, reason: 'rate_ambiguous' };
  const rate = hits[0]!.rateUsd;

  return {
    ok: true,
    m3,
    kg: Math.round(cargo.kg * 1000) / 1000,
    density,
    tierMaxM3: tier,
    bandMaxDensity: band,
    rate,
    earnedUsd: round2(m3 * rate),
  };
}

/** What a month earns on the PAID part of its cargo, at the month's own rate (his 6b). */
export function earnedOnPaid(paidM3: number, rate: number): number {
  return round2(round4(paidM3) * rate);
}
