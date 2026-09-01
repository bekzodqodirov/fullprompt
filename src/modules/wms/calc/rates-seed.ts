import ratesJson from './pp3818-rates.json';

/**
 * PP-3818's import duty table, parsed from the owner's own lex.uz export
 * («shuni baza qilib ol stavkalarni») — 1,489 rows in the law's four shapes:
 * advalor (BQ × %), MAX («20 %, lekin 3 AQSH dollaridan kam emas», 198 rows)
 * and the vehicle SUM rows (BQ × % + Miqdor × T, 41 rows). A `code` is a
 * PREFIX at the law's own grain — 4, 6, 8, 9 or 10 digits — and the lookup
 * takes the LONGEST prefix that matches the typed 10-digit code, so
 * 6403120000's own 5 % beats heading 6403's «20 %, min $3/juft».
 *
 * This file is consumed by scripts/seed.ts and the fence test ONLY. The
 * running app reads `calc_rates` — the seed is where the law enters, the
 * dictionary is where it lives, and a person's correction (a NEWER dated row,
 * source 'manual'/'correction') wins by date exactly as fx_rates do.
 */

export type Pp3818Mode = 'advalor' | 'max' | 'plus';

export type Pp3818Record = {
  code: string;
  name: string;
  raw: string;
  mode: Pp3818Mode;
  pct: number;
  specific?: number;
  unit?: string;
  notes?: string;
  clauseCut?: boolean;
};

/**
 * The seed's own date, fixed for ever: re-running the seed mints the SAME
 * (code, date) pairs, so `ON CONFLICT DO NOTHING` makes it idempotent and a
 * person's later correction — a different date — is never touched.
 */
export const PP3818_FROM = '2026-01-01';

export function pp3818Records(): Pp3818Record[] {
  return ratesJson as Pp3818Record[];
}

/**
 * Rows in `calc_rates` shape. VAT is 12 % on EVERY row — the law's flat rate
 * — and not 0: `pullRates` copies the dictionary's word verbatim, so a seed
 * that left `vat_pct` at the column default would silently price every
 * calculation VAT-free. `fee_usd` stays 0 because the fee is not a per-code
 * fact at all — it is the BHM step scale over the whole declaration, computed
 * by the engine (`customsFeeFor`), and a per-code number here would be added
 * once per group.
 */
export function pp3818Rows() {
  return pp3818Records().map((r) => ({
    tnvedCode: r.code,
    dutyPct: r.pct.toFixed(3),
    vatPct: '12.000',
    feeUsd: '0.00',
    dutyMode: r.mode,
    dutySpecific: r.specific === undefined ? null : r.specific.toFixed(4),
    dutyUnit: r.unit ?? null,
    effectiveDate: PP3818_FROM,
    source: 'pp3818' as const,
    note: r.notes ? `PP-3818 izoh: ${r.notes}` : null,
  }));
}
