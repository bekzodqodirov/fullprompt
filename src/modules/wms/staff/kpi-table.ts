import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { kpiRates } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import type { KpiCell } from './kpi-engine';
import { calendarMonth } from './month';
import type { Exec } from './cargo';

/**
 * The owner's KPI table as DATA (0117): one row per cell, versioned by the
 * month a version starts to apply — `calc_freight_tariffs`' and `fx_rates`'
 * shape, read as «the newest version on or before the month» and with NO
 * earliest-row fallback: a month before the first version is simply outside
 * KPI (the service never prices it), never priced by a table that did not yet
 * exist.
 *
 * A save writes ONE full grid and nothing else can: a half-typed table would
 * price the rows it has and refuse the rest, month by month, which is the
 * «hole» the tariff lookup refuses (`band_missing`). And no version may start
 * at or before a month somebody has already been PAID for (`kpi_version_paid`)
 * — repricing a paid month would make the netting pay or claw back the
 * difference on a table nobody agreed to at the time.
 */

export type KpiTableError =
  | 'grid_empty'
  | 'grid_hole'
  | 'grid_duplicate'
  | 'grid_no_open_tier'
  | 'grid_no_open_band'
  | 'bad_rate'
  | 'bad_bound'
  | 'bad_month'
  | 'kpi_version_paid';

export class KpiTableRefusal extends Error {
  constructor(public readonly code: KpiTableError) {
    super(code);
  }
}

/** The audit row every table save is written against — a table has no single id. */
export const KPI_TABLE_AUDIT_ID = '00000000-0000-0000-0000-000000000117';

const isNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Every tier × band cell exactly once, one open tier, one open band, a finite rate ≥ 0. Pure. */
export function validateKpiGrid(cells: KpiCell[]): { ok: true } | { ok: false; reason: KpiTableError } {
  if (cells.length === 0) return { ok: false, reason: 'grid_empty' };
  for (const cell of cells) {
    if (!isNumber(cell.rateUsd) || cell.rateUsd < 0) return { ok: false, reason: 'bad_rate' };
    if (cell.maxM3 !== null && (!isNumber(cell.maxM3) || cell.maxM3 <= 0)) return { ok: false, reason: 'bad_bound' };
    if (cell.maxDensity !== null && (!Number.isInteger(cell.maxDensity) || cell.maxDensity <= 0)) {
      return { ok: false, reason: 'bad_bound' };
    }
  }
  const tiers = [...new Set(cells.map((c) => c.maxM3))];
  const bands = [...new Set(cells.map((c) => c.maxDensity))];
  if (!tiers.includes(null)) return { ok: false, reason: 'grid_no_open_tier' };
  if (!bands.includes(null)) return { ok: false, reason: 'grid_no_open_band' };
  const key = (t: number | null, b: number | null) => `${t ?? '∞'}|${b ?? '∞'}`;
  const seen = new Map<string, number>();
  for (const cell of cells) seen.set(key(cell.maxM3, cell.maxDensity), (seen.get(key(cell.maxM3, cell.maxDensity)) ?? 0) + 1);
  if ([...seen.values()].some((n) => n > 1)) return { ok: false, reason: 'grid_duplicate' };
  for (const t of tiers) for (const b of bands) if (!seen.has(key(t, b))) return { ok: false, reason: 'grid_hole' };
  return { ok: true };
}

export interface KpiVersion {
  /** `YYYY-MM`. */
  month: string;
  cells: KpiCell[];
}

/** Every version, oldest first — a table of a few dozen rows, read once per page. */
export async function kpiVersions(exec: Exec): Promise<KpiVersion[]> {
  const rows = (await exec.execute(sql`
    SELECT to_char(effective_month, 'YYYY-MM') AS month, max_m3, max_density, rate_usd
      FROM kpi_rates
     ORDER BY effective_month, max_m3 NULLS LAST, max_density NULLS LAST`)) as unknown as {
    month: string;
    max_m3: string | null;
    max_density: number | null;
    rate_usd: string;
  }[];
  const out = new Map<string, KpiCell[]>();
  for (const row of rows) {
    const list = out.get(row.month) ?? [];
    list.push({
      maxM3: row.max_m3 === null ? null : Number(row.max_m3),
      maxDensity: row.max_density === null ? null : Number(row.max_density),
      rateUsd: Number(row.rate_usd),
    });
    out.set(row.month, list);
  }
  return [...out.entries()].map(([month, cells]) => ({ month, cells }));
}

/** The version in force for `month` — the newest on or before it, never an earlier-row fallback. Pure. */
export function versionFor(versions: KpiVersion[], month: string): KpiVersion | null {
  let found: KpiVersion | null = null;
  for (const version of versions) if (version.month <= month && (!found || version.month > found.month)) found = version;
  return found;
}

/** The table that prices `month`, or null (before the first version). */
export async function kpiTableFor(exec: Exec, month: string): Promise<KpiVersion | null> {
  return versionFor(await kpiVersions(exec), month);
}

/** The first month KPI counts at all — his open point 1, the seed's `OWNER_KPI_FROM`. */
export async function firstKpiMonth(exec: Exec): Promise<string | null> {
  const [row] = (await exec.execute(sql`
    SELECT to_char(min(effective_month), 'YYYY-MM') AS month FROM kpi_rates`)) as unknown as { month: string | null }[];
  return row?.month ?? null;
}

/**
 * Save ONE full grid as the version starting `effectiveMonth` (`YYYY-MM`),
 * replacing a version of the same month in the same transaction.
 *
 * Serialised against `payKpi` by an advisory lock the payout takes SHARED:
 * a table saved while a payout is being computed would otherwise pass the
 * «nothing paid there yet» check on a payout that commits a moment later.
 */
export async function saveKpiTable(cells: KpiCell[], effectiveMonth: string, ctx: AuditContext): Promise<void> {
  const month = calendarMonth(effectiveMonth);
  if (!month) throw new KpiTableRefusal('bad_month');
  const verdict = validateKpiGrid(cells);
  if (!verdict.ok) throw new KpiTableRefusal(verdict.reason);

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('kpi:table'))`);
    const [paid] = (await tx.execute(sql`
      SELECT to_char(max(kp.through_month), 'YYYY-MM') AS month
        FROM kpi_payouts kp
        JOIN expenses e ON e.id = kp.expense_id AND e.voided_at IS NULL`)) as unknown as { month: string | null }[];
    if (paid?.month && month <= paid.month) throw new KpiTableRefusal('kpi_version_paid');

    const before = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM kpi_rates WHERE effective_month = ${`${month}-01`}::date`)) as unknown as {
      n: number;
    }[];
    await tx.execute(sql`DELETE FROM kpi_rates WHERE effective_month = ${`${month}-01`}::date`);
    await tx.insert(kpiRates).values(
      cells.map((cell) => ({
        effectiveMonth: `${month}-01`,
        maxM3: cell.maxM3 === null ? null : cell.maxM3.toFixed(3),
        maxDensity: cell.maxDensity,
        rateUsd: cell.rateUsd.toFixed(2),
        createdBy: ctx.actorId,
      })),
    );
    await writeAudit(tx, ctx, {
      entityType: 'kpi_rates',
      entityId: KPI_TABLE_AUDIT_ID,
      action: 'update',
      before: { month, replacedCells: Number(before[0]?.n ?? 0) },
      after: { month, cells: cells.map((c) => [c.maxM3, c.maxDensity, c.rateUsd]) },
    });
  });
}
