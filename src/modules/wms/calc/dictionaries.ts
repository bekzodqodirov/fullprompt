import { and, asc, desc, inArray, lte, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { calcBazas, calcFreightTariffs, calcPriceBook, calcRates } from '@/modules/platform/db/schema';
import { writeAudit, type AuditContext } from '@/modules/platform/audit/service';
import { productKey } from '../tnved/service';
import { CalcError } from './service';
import { isNumber } from './pricing';
import type { BazaBasis, DutyMode, DutyUnit, FreightBand } from './pricing';

/**
 * A typo is refused before it is stored, not after it is priced.
 *
 * `Number('1 000')` is NaN, and NaN slips past every range check ever
 * written — then postgres stores `'NaN'::numeric` and answers TRUE to
 * `>= 0`, so the CHECK constraints wave it through too.
 */
function mustBeNumber(...values: (number | null | undefined)[]): void {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (!isNumber(v)) throw new CalcError('bad_number');
  }
}

/**
 * The three dictionaries phase B is born with (docs/VED.md, laws 5-7).
 *
 * All three are versioned by the date they took effect and read the way
 * `fx_rates`/`rateFor` has always been read: the newest row whose
 * `effective_date` is on or before the date being priced. That is what «edits
 * keep history — an old calc reads its own tariff» is asking for, and it is
 * why an admin correcting Monday's baza does not silently re-price Monday's
 * sealed quote.
 *
 * ONE thing here departs from `rateFor`, deliberately: **there is no
 * earliest-row fallback.** `rateFor` has one because a cost entered before
 * the first exchange rate still has to convert into something. Here a missing
 * baza means nobody has ever priced this product, and the fallback would also
 * let a row dated next month price today's calculation. Null is the answer,
 * the screen says so, and the engine refuses.
 */

/** «har 3 oyda korib chiqish» — the owner's review cadence, as a warning. */
export const BAZA_STALE_DAYS = 90;

export interface BazaRow {
  id: string;
  productKey: string;
  label: string;
  tnvedCode: string | null;
  bazaUsd: number;
  basis: BazaBasis;
  effectiveDate: string;
  note: string | null;
}

export interface RatesRow {
  id: string;
  tnvedCode: string;
  dutyPct: number;
  vatPct: number;
  feeUsd: number;
  dutyMode: DutyMode;
  dutySpecific: number | null;
  dutyUnit: DutyUnit | null;
  effectiveDate: string;
  source: 'manual' | 'correction' | 'pp3818';
  note: string | null;
}

/** ISO `yyyy-mm-dd` — what a `date` column compares against. */
export const onDate = (at: Date = new Date()) => at.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// 1. Product baza
// ---------------------------------------------------------------------------

/**
 * The in-force baza for each of these products, keyed by `productKey` so this
 * dictionary and the TNVED memory agree about what a product IS.
 *
 * Batched on purpose: a thousand-item calculation asking per item would be a
 * thousand round trips (#432), so the whole list is one grouped query and the
 * caller looks up in the map.
 */
export async function bazasFor(names: string[], date: string): Promise<Map<string, BazaRow>> {
  const keys = [...new Set(names.map(productKey))].filter(Boolean);
  if (keys.length === 0) return new Map();
  const rows = await db
    .select()
    .from(calcBazas)
    .where(and(inArray(calcBazas.productKey, keys), lte(calcBazas.effectiveDate, date)))
    .orderBy(desc(calcBazas.effectiveDate));
  // Newest first, so the first row seen for a key is the one in force.
  const out = new Map<string, BazaRow>();
  for (const r of rows) if (!out.has(r.productKey)) out.set(r.productKey, toBaza(r));
  return out;
}

export async function bazaFor(name: string, date: string): Promise<BazaRow | null> {
  return (await bazasFor([name], date)).get(productKey(name)) ?? null;
}

export async function listBazas(): Promise<(BazaRow & { stale: boolean; future: boolean })[]> {
  const today = onDate();
  const rows = await db
    .select()
    .from(calcBazas)
    .orderBy(asc(calcBazas.label), desc(calcBazas.effectiveDate));
  const cutoff = onDate(new Date(Date.now() - BAZA_STALE_DAYS * 86_400_000));
  return rows.map((r) => ({
    ...toBaza(r),
    stale: r.effectiveDate <= cutoff,
    // A row dated ahead of today is visible as a banner and priced by
    // nothing — the reader's `<= date` filter is what keeps it out.
    future: r.effectiveDate > today,
  }));
}

export async function saveBaza(
  input: {
    name: string;
    label: string;
    tnvedCode: string | null;
    bazaUsd: number;
    basis: BazaBasis;
    effectiveDate: string;
    note: string | null;
  },
  ctx: AuditContext,
): Promise<string> {
  const key = productKey(input.name);
  if (!key) throw new CalcError('product_required');
  mustBeNumber(input.bazaUsd);
  if (!(input.bazaUsd > 0)) throw new CalcError('baza_positive');

  const [row] = await db
    .insert(calcBazas)
    .values({
      productKey: key,
      label: input.label.trim() || input.name.trim(),
      tnvedCode: input.tnvedCode,
      bazaUsd: input.bazaUsd.toFixed(4),
      basis: input.basis,
      effectiveDate: input.effectiveDate,
      note: input.note,
      enteredBy: ctx.actorId ?? null,
    })
    // The same product corrected twice in one day is one correction: the last
    // word that day wins, which is what a correction means.
    .onConflictDoUpdate({
      target: [calcBazas.productKey, calcBazas.effectiveDate],
      set: {
        label: sql`excluded.label`,
        tnvedCode: sql`excluded.tnved_code`,
        bazaUsd: sql`excluded.baza_usd`,
        basis: sql`excluded.basis`,
        note: sql`excluded.note`,
        enteredBy: sql`excluded.entered_by`,
      },
    })
    .returning({ id: calcBazas.id });

  await writeAudit(db, ctx, {
    entityType: 'calc_baza',
    entityId: row!.id,
    action: 'update',
    after: { ...input, productKey: key },
  });
  return row!.id;
}

// ---------------------------------------------------------------------------
// 2. Code rates
// ---------------------------------------------------------------------------

/**
 * The prefixes a typed code is answered by, LONGEST FIRST.
 *
 * PP-3818 writes its rates at the law's own grain — a 4-digit heading with
 * 10-digit exceptions carved out (1,228 headings, 144 ten-digit rows in the
 * seed) — so «6403120000» must find its own 5 % row and «6403520000», which
 * has no row of its own, must fall back to heading 6403's «20 %, min
 * $3/juft». The longest stored prefix wins; within one prefix, the newest
 * dated row on or before the day, exactly as every dictionary here reads.
 */
export const codePrefixes = (code: string): string[] => {
  const c = code.trim();
  const out: string[] = [];
  for (let len = Math.min(c.length, 10); len >= 4; len--) out.push(c.slice(0, len));
  if (out.length === 0 && c) out.push(c);
  return out;
};

export async function ratesForCodes(codes: string[], date: string): Promise<Map<string, RatesRow>> {
  const list = [...new Set(codes.map((c) => c.trim()))].filter(Boolean);
  if (list.length === 0) return new Map();
  const prefixes = [...new Set(list.flatMap(codePrefixes))];
  const rows = await db
    .select()
    .from(calcRates)
    .where(and(inArray(calcRates.tnvedCode, prefixes), lte(calcRates.effectiveDate, date)))
    .orderBy(desc(calcRates.effectiveDate));
  // Newest first, so the first row seen for a stored code is the one in force.
  const inForce = new Map<string, RatesRow>();
  for (const r of rows) if (!inForce.has(r.tnvedCode)) inForce.set(r.tnvedCode, toRates(r));
  const out = new Map<string, RatesRow>();
  for (const code of list) {
    for (const prefix of codePrefixes(code)) {
      const hit = inForce.get(prefix);
      if (hit) {
        out.set(code, hit);
        break;
      }
    }
  }
  return out;
}

export async function ratesFor(code: string, date: string): Promise<RatesRow | null> {
  return (await ratesForCodes([code], date)).get(code.trim()) ?? null;
}

/**
 * The screen's list. Unfiltered it shows only PERSON-entered rows: the 0091
 * seed put all 1,489 PP-3818 rows in this table, and a page that renders
 * them all is /stock's DOM crush (round 68 — ~9,000 cells, seconds of
 * freeze on a phone). A typed code searches the WHOLE book both ways —
 * `6403…` finds the carved-out exceptions under the heading AND the heading
 * a full code falls back to, which is exactly the pair the lookup weighs.
 */
export async function listRates(search?: string | null): Promise<(RatesRow & { future: boolean })[]> {
  const today = onDate();
  const q = (search ?? '').trim();
  const rows = await db
    .select()
    .from(calcRates)
    .where(
      q
        ? sql`(${calcRates.tnvedCode} LIKE ${`${q}%`} OR ${q} LIKE ${calcRates.tnvedCode} || '%')`
        : sql`${calcRates.source} <> 'pp3818'`,
    )
    .orderBy(asc(calcRates.tnvedCode), desc(calcRates.effectiveDate))
    .limit(300);
  return rows.map((r) => ({ ...toRates(r), future: r.effectiveDate > today }));
}

export async function saveRates(
  input: {
    tnvedCode: string;
    dutyPct: number;
    vatPct: number;
    feeUsd: number;
    effectiveDate: string;
    source?: 'manual' | 'correction';
    note?: string | null;
    /** Absent = CARRY the in-force row's law shape forward — a person
     * correcting the percentage of a MAX code must not silently strip its
     * per-piece floor. Passing 'advalor' explicitly IS how the shape is
     * removed. */
    dutyMode?: DutyMode;
    dutySpecific?: number | null;
    dutyUnit?: DutyUnit | null;
  },
  ctx: AuditContext,
): Promise<string> {
  const code = input.tnvedCode.trim();
  if (!code) throw new CalcError('code_required');
  mustBeNumber(input.dutyPct, input.vatPct, input.feeUsd, input.dutySpecific);
  if (input.dutyPct < 0 || input.dutyPct > 100 || input.vatPct < 0 || input.vatPct > 100) {
    throw new CalcError('rate_range');
  }
  if (input.feeUsd < 0) throw new CalcError('rate_range');

  let dutyMode = input.dutyMode ?? null;
  let dutySpecific = input.dutySpecific ?? null;
  let dutyUnit = input.dutyUnit ?? null;
  if (dutyMode === null) {
    // Only an EXACT-code in-force row carries forward: heading 6403's shape
    // must not ride onto a 10-digit exception a person is minting on purpose.
    const standing = await ratesFor(code, input.effectiveDate);
    if (standing && standing.tnvedCode === code) {
      dutyMode = standing.dutyMode;
      dutySpecific = standing.dutySpecific;
      dutyUnit = standing.dutyUnit;
    } else {
      dutyMode = 'advalor';
    }
  }
  if (dutyMode === 'advalor') {
    dutySpecific = null;
    dutyUnit = null;
  } else if (dutySpecific === null || !(dutySpecific >= 0) || dutyUnit === null) {
    throw new CalcError('rate_range');
  }

  const [row] = await db
    .insert(calcRates)
    .values({
      tnvedCode: code,
      dutyPct: input.dutyPct.toFixed(3),
      vatPct: input.vatPct.toFixed(3),
      feeUsd: input.feeUsd.toFixed(2),
      dutyMode,
      dutySpecific: dutySpecific === null ? null : dutySpecific.toFixed(4),
      dutyUnit,
      effectiveDate: input.effectiveDate,
      source: input.source ?? 'manual',
      note: input.note ?? null,
      enteredBy: ctx.actorId ?? null,
    })
    .onConflictDoUpdate({
      target: [calcRates.tnvedCode, calcRates.effectiveDate],
      set: {
        dutyPct: sql`excluded.duty_pct`,
        vatPct: sql`excluded.vat_pct`,
        feeUsd: sql`excluded.fee_usd`,
        dutyMode: sql`excluded.duty_mode`,
        dutySpecific: sql`excluded.duty_specific`,
        dutyUnit: sql`excluded.duty_unit`,
        source: sql`excluded.source`,
        note: sql`excluded.note`,
        enteredBy: sql`excluded.entered_by`,
      },
    })
    .returning({ id: calcRates.id });

  await writeAudit(db, ctx, {
    entityType: 'calc_rate',
    entityId: row!.id,
    action: 'update',
    after: { ...input, tnvedCode: code },
  });
  return row!.id;
}

// ---------------------------------------------------------------------------
// 3. Freight tariff
// ---------------------------------------------------------------------------

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
 * The tariff in force on ONE day, out of the whole history. Pure — the same
 * «newest row on or before the date» rule `tariffFor` runs in SQL, restated
 * once here rather than in every caller (#513).
 */
export function bandsAsOf(
  history: (FreightBand & { effectiveDate: string })[],
  date: string,
): FreightBand[] {
  const seen = new Set<string>();
  const out: FreightBand[] = [];
  for (const r of history) {
    if (r.effectiveDate > date) continue;
    const key = `${r.zone}|${r.minDensity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      zone: r.zone,
      minDensity: r.minDensity,
      maxDensity: r.maxDensity,
      priceUsd: r.priceUsd,
      perKg: r.perKg,
    });
  }
  return out.sort((a, b) => a.zone.localeCompare(b.zone) || a.minDensity - b.minDensity);
}

/** The zones the tariff itself knows about — a third one needs no code. */
export async function tariffZones(date: string): Promise<string[]> {
  return [...new Set((await tariffFor(date)).map((r) => r.zone))].sort();
}

export async function listTariff(): Promise<
  (FreightBand & { id: string; effectiveDate: string; future: boolean })[]
> {
  const today = onDate();
  const rows = await db
    .select()
    .from(calcFreightTariffs)
    .orderBy(
      asc(calcFreightTariffs.zone),
      asc(calcFreightTariffs.minDensity),
      desc(calcFreightTariffs.effectiveDate),
    );
  return rows.map((r) => ({
    id: r.id,
    zone: r.zone,
    minDensity: Number(r.minDensity),
    maxDensity: r.maxDensity === null ? null : Number(r.maxDensity),
    priceUsd: Number(r.priceUsd),
    perKg: r.perKg,
    effectiveDate: r.effectiveDate,
    future: r.effectiveDate > today,
  }));
}

export async function saveTariffBand(
  input: {
    zone: string;
    minDensity: number;
    maxDensity: number | null;
    priceUsd: number;
    perKg: boolean;
    effectiveDate: string;
  },
  ctx: AuditContext,
): Promise<string> {
  const zone = input.zone.trim().toLowerCase();
  if (!zone) throw new CalcError('zone_required');
  mustBeNumber(input.priceUsd, input.minDensity, input.maxDensity);
  if (!(input.priceUsd > 0)) throw new CalcError('price_positive');
  if (input.minDensity < 0) throw new CalcError('band_range');
  if (input.maxDensity !== null && input.maxDensity < input.minDensity) {
    throw new CalcError('band_range');
  }

  const [row] = await db
    .insert(calcFreightTariffs)
    .values({
      zone,
      minDensity: input.minDensity.toFixed(2),
      maxDensity: input.maxDensity === null ? null : input.maxDensity.toFixed(2),
      priceUsd: input.priceUsd.toFixed(4),
      perKg: input.perKg,
      effectiveDate: input.effectiveDate,
      enteredBy: ctx.actorId ?? null,
    })
    .onConflictDoUpdate({
      target: [calcFreightTariffs.zone, calcFreightTariffs.minDensity, calcFreightTariffs.effectiveDate],
      set: {
        maxDensity: sql`excluded.max_density`,
        priceUsd: sql`excluded.price_usd`,
        perKg: sql`excluded.per_kg`,
        enteredBy: sql`excluded.entered_by`,
      },
    })
    .returning({ id: calcFreightTariffs.id });

  await writeAudit(db, ctx, {
    entityType: 'calc_tariff',
    entityId: row!.id,
    action: 'update',
    after: { ...input, zone },
  });
  return row!.id;
}

const toBaza = (r: typeof calcBazas.$inferSelect): BazaRow => ({
  id: r.id,
  productKey: r.productKey,
  label: r.label,
  tnvedCode: r.tnvedCode,
  bazaUsd: Number(r.bazaUsd),
  basis: r.basis as BazaBasis,
  effectiveDate: r.effectiveDate,
  note: r.note,
});

const toRates = (r: typeof calcRates.$inferSelect): RatesRow => ({
  id: r.id,
  tnvedCode: r.tnvedCode,
  dutyPct: Number(r.dutyPct),
  vatPct: Number(r.vatPct),
  feeUsd: Number(r.feeUsd),
  dutyMode: r.dutyMode as DutyMode,
  dutySpecific: r.dutySpecific === null ? null : Number(r.dutySpecific),
  dutyUnit: r.dutyUnit as DutyUnit | null,
  effectiveDate: r.effectiveDate,
  source: r.source as 'manual' | 'correction' | 'pp3818',
  note: r.note,
});

// ---------------------------------------------------------------------------
// 4. The SELLING price book
// ---------------------------------------------------------------------------

/**
 * What we CHARGE a client, per cube or per kilo — the owner's «monitor 1 kubi
 * uchun 450 dollardan klientlarimizga berilyabti».
 *
 * Keyed on the TNVED CODE and deliberately not on a product name. A name key
 * cannot work here: the spec says «product/category», his example is the bare
 * word «monitor», and the warehouse types «Монитор 27 дюйм» — those never
 * meet under any normaliser that does not also invent a classifier. A code is
 * the category grain, and phase B will not seal a group whose code and rates
 * nobody confirmed, so by the time a price exists a person has looked at it.
 *
 * It is NOT the sealed price. The sealed number is what the calculation cost
 * and, by law 4, the FLOOR the seller's price sits above; a book filled from
 * it would be a book of floors labelled as prices. It learns from
 * `calc_offers` — what a seller actually told a customer.
 */
export interface PriceBookRow {
  id: string;
  tnvedCode: string;
  label: string;
  priceUsd: number;
  unit: 'm3' | 'kg';
  effectiveDate: string;
  note: string | null;
}

export async function priceBookForCodes(
  codes: string[],
  date: string,
): Promise<Map<string, PriceBookRow>> {
  const list = [...new Set(codes.map((c) => c.trim()))].filter(Boolean);
  if (list.length === 0) return new Map();
  const rows = await db
    .select()
    .from(calcPriceBook)
    .where(and(inArray(calcPriceBook.tnvedCode, list), lte(calcPriceBook.effectiveDate, date)))
    .orderBy(desc(calcPriceBook.effectiveDate));
  const out = new Map<string, PriceBookRow>();
  for (const r of rows) if (!out.has(r.tnvedCode)) out.set(r.tnvedCode, toPrice(r));
  return out;
}

export async function priceBookAt(code: string, date: string): Promise<PriceBookRow | null> {
  return (await priceBookForCodes([code], date)).get(code.trim()) ?? null;
}

export async function listPriceBook(): Promise<
  (PriceBookRow & { stale: boolean; future: boolean })[]
> {
  const today = onDate();
  const rows = await db
    .select()
    .from(calcPriceBook)
    .orderBy(asc(calcPriceBook.label), desc(calcPriceBook.effectiveDate));
  const cutoff = onDate(new Date(Date.now() - BAZA_STALE_DAYS * 86_400_000));
  return rows.map((r) => ({
    ...toPrice(r),
    stale: r.effectiveDate <= cutoff,
    future: r.effectiveDate > today,
  }));
}

export async function savePriceBook(
  input: {
    tnvedCode: string;
    label: string;
    priceUsd: number;
    unit: 'm3' | 'kg';
    effectiveDate: string;
    note?: string | null;
  },
  ctx: AuditContext,
): Promise<string> {
  const code = input.tnvedCode.trim();
  if (!code) throw new CalcError('code_required');
  mustBeNumber(input.priceUsd);
  if (!(input.priceUsd > 0)) throw new CalcError('price_positive');
  const label = input.label.trim();
  if (!label) throw new CalcError('label_required');

  const [row] = await db
    .insert(calcPriceBook)
    .values({
      tnvedCode: code,
      label,
      priceUsd: input.priceUsd.toFixed(4),
      unit: input.unit,
      effectiveDate: input.effectiveDate,
      note: input.note ?? null,
      enteredBy: ctx.actorId ?? null,
    })
    .onConflictDoUpdate({
      target: [calcPriceBook.tnvedCode, calcPriceBook.effectiveDate],
      set: {
        label: sql`excluded.label`,
        priceUsd: sql`excluded.price_usd`,
        unit: sql`excluded.unit`,
        note: sql`excluded.note`,
        enteredBy: sql`excluded.entered_by`,
      },
    })
    .returning({ id: calcPriceBook.id });

  await writeAudit(db, ctx, {
    entityType: 'calc_price',
    entityId: row!.id,
    action: 'update',
    after: { ...input, tnvedCode: code },
  });
  return row!.id;
}

/** Rows nobody has revisited — what the monthly reminder counts. */
export async function staleDictionaryCounts(): Promise<{
  bazas: number;
  rates: number;
  prices: number;
  total: number;
}> {
  const cutoff = onDate(new Date(Date.now() - BAZA_STALE_DAYS * 86_400_000));
  const [bazas, rates, prices] = await Promise.all([
    countStale('calc_bazas', 'product_key', cutoff),
    countStale('calc_rates', 'tnved_code', cutoff),
    countStale('calc_price_book', 'tnved_code', cutoff),
  ]);
  return { bazas, rates, prices, total: bazas + rates + prices };
}

/**
 * How many DISTINCT keys have nothing newer than the cutoff.
 *
 * Counting rows would count history: a product corrected five times has five
 * rows and one in-force answer, and only the in-force one can be stale.
 */
async function countStale(table: string, keyColumn: string, cutoff: string): Promise<number> {
  const rows = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM (
      SELECT ${sql.raw(keyColumn)} AS k, max(effective_date) AS newest
        FROM ${sql.raw(table)}
       GROUP BY ${sql.raw(keyColumn)}
    ) t WHERE t.newest <= ${cutoff}::date
  `);
  return Number(rows[0]?.n ?? 0);
}

const toPrice = (r: typeof calcPriceBook.$inferSelect): PriceBookRow => ({
  id: r.id,
  tnvedCode: r.tnvedCode,
  label: r.label,
  priceUsd: Number(r.priceUsd),
  unit: r.unit as 'm3' | 'kg',
  effectiveDate: r.effectiveDate,
  note: r.note,
});
