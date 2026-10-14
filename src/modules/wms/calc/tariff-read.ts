import { desc, lte } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { calcFreightTariffs } from '@/modules/platform/db/schema';
import type { FreightBand } from './pricing';

/**
 * The freight tariff's READS, as a leaf (docs/YOLKIRA-TAQSIMOT.md §9.1).
 *
 * They used to live in `./dictionaries`, and they still answer from there by
 * re-export. They moved because the cost split now needs the tariff too
 * (costing/freight-copy.ts) and `./dictionaries` imports `CalcError` and the
 * TNVED service, which reach `costing/service` back through calc → crm →
 * clients → client-cabinet → finance → costing. A leaf that imports only the
 * database and the pure engine's types cannot close that loop.
 */

/**
 * The bands in force on a date, for the pure engine to filter by zone.
 *
 * The whole tariff is small (a dozen rows a zone), so it is fetched once and
 * `bandFor` picks inside pure code — which is also what lets a test drive the
 * band edges without a database.
 */
export async function tariffFor(date: string): Promise<FreightBand[]> {
  const rows = await db
    .select()
    .from(calcFreightTariffs)
    .where(lte(calcFreightTariffs.effectiveDate, date))
    .orderBy(desc(calcFreightTariffs.effectiveDate));
  const seen = new Set<string>();
  const out: FreightBand[] = [];
  for (const r of rows) {
    const key = `${r.zone}|${r.minDensity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      zone: r.zone,
      minDensity: Number(r.minDensity),
      maxDensity: r.maxDensity === null ? null : Number(r.maxDensity),
      priceUsd: Number(r.priceUsd),
      perKg: r.perKg,
    });
  }
  return out.sort((a, b) => a.zone.localeCompare(b.zone) || a.minDensity - b.minDensity);
}

/**
 * EVERY tariff row ever written, newest date first, for a reader that needs
 * to price several different DAYS in one pass.
 *
 * `tariffFor(date)` is one query per date, which is right for a screen
 * pricing one calculation and wrong for a list of a hundred sealed quotes
 * (#432: a per-row query on a list is the business growing). His whole table
 * is 24 rows, so the honest shape is to load it once and pick per row.
 */
export async function tariffHistory(): Promise<
  (FreightBand & { effectiveDate: string })[]
> {
  const rows = await db
    .select()
    .from(calcFreightTariffs)
    .orderBy(desc(calcFreightTariffs.effectiveDate));
  return rows.map((r) => ({
    zone: r.zone,
    minDensity: Number(r.minDensity),
    maxDensity: r.maxDensity === null ? null : Number(r.maxDensity),
    priceUsd: Number(r.priceUsd),
    perKg: r.perKg,
    effectiveDate: r.effectiveDate,
  }));
}

/**
 * Every zone the tariff has EVER had a row for, any date — the warehouse
 * form's «is this column priced at all» (§2.4). A future-dated zone counts:
 * it is priced, just not yet, and the save refuses by DATE in words.
 */
export async function tariffZoneNames(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ zone: calcFreightTariffs.zone })
    .from(calcFreightTariffs);
  return rows.map((r) => r.zone).sort();
}
