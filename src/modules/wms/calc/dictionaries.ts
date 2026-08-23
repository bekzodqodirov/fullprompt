import { and, asc, desc, inArray, lte, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { calcBazas, calcFreightTariffs, calcRates } from '@/modules/platform/db/schema';
import { writeAudit, type AuditContext } from '@/modules/platform/audit/service';
import { productKey } from '../tnved/service';
import { CalcError } from './service';
import { isNumber } from './pricing';
import type { BazaBasis, FreightBand } from './pricing';

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
  effectiveDate: string;
  source: 'manual' | 'correction';
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

export async function ratesForCodes(codes: string[], date: string): Promise<Map<string, RatesRow>> {
  const list = [...new Set(codes.map((c) => c.trim()))].filter(Boolean);
  if (list.length === 0) return new Map();
  const rows = await db
    .select()
    .from(calcRates)
    .where(and(inArray(calcRates.tnvedCode, list), lte(calcRates.effectiveDate, date)))
    .orderBy(desc(calcRates.effectiveDate));
  const out = new Map<string, RatesRow>();
  for (const r of rows) if (!out.has(r.tnvedCode)) out.set(r.tnvedCode, toRates(r));
  return out;
}

export async function ratesFor(code: string, date: string): Promise<RatesRow | null> {
  return (await ratesForCodes([code], date)).get(code.trim()) ?? null;
}

export async function listRates(): Promise<(RatesRow & { future: boolean })[]> {
  const today = onDate();
  const rows = await db
    .select()
    .from(calcRates)
    .orderBy(asc(calcRates.tnvedCode), desc(calcRates.effectiveDate));
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
  },
  ctx: AuditContext,
): Promise<string> {
  const code = input.tnvedCode.trim();
  if (!code) throw new CalcError('code_required');
  mustBeNumber(input.dutyPct, input.vatPct, input.feeUsd);
  if (input.dutyPct < 0 || input.dutyPct > 100 || input.vatPct < 0 || input.vatPct > 100) {
    throw new CalcError('rate_range');
  }
  if (input.feeUsd < 0) throw new CalcError('rate_range');

  const [row] = await db
    .insert(calcRates)
    .values({
      tnvedCode: code,
      dutyPct: input.dutyPct.toFixed(3),
      vatPct: input.vatPct.toFixed(3),
      feeUsd: input.feeUsd.toFixed(2),
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
  effectiveDate: r.effectiveDate,
  source: r.source as 'manual' | 'correction',
  note: r.note,
});
