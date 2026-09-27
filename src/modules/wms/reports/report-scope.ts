import { and, asc, inArray } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { warehouses } from '../../platform/db/schema';
import { isUuidShaped } from '../../platform/audit/fields';
import { listedWarehouseSql } from '../inventory/service';

/**
 * Which warehouses a report reads for a viewer, and the one they picked —
 * asked ONE way by the dashboard and by the receipts journal its intake chart
 * links to (O10). They used to answer differently: the dashboard intersected
 * the two scope rules, the journal read `reports.all_warehouses` alone, so a
 * warehouse-scoped role carrying an all-warehouse grant saw its own
 * warehouses on the dashboard and the whole company one tap later.
 */

/** The parts of an actor the rule reads — `Actor` satisfies it. */
export interface ScopeActor {
  permissions: Set<string>;
  warehouseScoped: boolean;
  warehouseIds: string[];
}

export interface ReportScope {
  /** `!reports.all_warehouses || actor.warehouseScoped`. */
  scoped: boolean;
  /** What the viewer may read at all: their warehouses, or `undefined` = the whole company. */
  baseIds: string[] | undefined;
  /** `baseIds` narrowed to the chosen warehouse — what the report actually reads. */
  ids: string[] | undefined;
  /** The chosen warehouse id, or null when none (or none that survived the checks). */
  ombor: string | null;
}

/**
 * The viewer's base scope, both rules intersected: an all-warehouse grant on
 * a warehouse-scoped ROLE still reads its own warehouses only (the roles
 * column, round 23, is the stronger statement), and a scoped viewer with no
 * warehouse gets an EMPTY list — which reads nothing, never «no filter».
 */
export function reportBaseIds(actor: ScopeActor): string[] | undefined {
  const scoped = !actor.permissions.has('reports.all_warehouses') || actor.warehouseScoped;
  return scoped ? [...actor.warehouseIds] : undefined;
}

/**
 * `?ombor=` → the scope a report reads. The raw value is a forged post until
 * proven otherwise (#514): it must be uuid-shaped (a garbage id reaching a
 * uuid column is a 22P02 white page) AND one of `options` — the viewer's own
 * list, from `warehouseOptions(baseIds)` — AND inside the base scope, which
 * the options already are and which is checked again so a caller handing in
 * the wrong list cannot widen anybody. Anything else is DROPPED to null and
 * the report reads the whole base scope, exactly as with no parameter.
 */
export function reportScope(
  actor: ScopeActor,
  rawOmbor: string | null | undefined,
  options: { id: string }[],
): ReportScope {
  const baseIds = reportBaseIds(actor);
  const candidate = typeof rawOmbor === 'string' ? rawOmbor.trim().toLowerCase() : '';
  const ombor =
    isUuidShaped(candidate) &&
    options.some((option) => option.id.toLowerCase() === candidate) &&
    (baseIds === undefined || baseIds.some((id) => id.toLowerCase() === candidate))
      ? candidate
      : null;
  return {
    scoped: baseIds !== undefined,
    baseIds,
    ids: ombor ? [ombor] : baseIds,
    ombor,
  };
}

export interface WarehouseOption {
  id: string;
  code: string;
  name: string;
  /** False for a deactivated warehouse that is listed only because cargo still stands in it. */
  active: boolean;
}

/**
 * The warehouses a report's «Ombor» select offers: the stock picker's own
 * rule (`listedWarehouseSql` — active, or deactivated with cargo still
 * standing in it), intersected with the base scope, ordered by code. ONE
 * statement, and none for an empty scope — there is nothing to offer.
 */
export async function warehouseOptions(baseIds: string[] | undefined): Promise<WarehouseOption[]> {
  if (baseIds !== undefined && baseIds.length === 0) return [];
  return db
    .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name, active: warehouses.active })
    .from(warehouses)
    .where(and(listedWarehouseSql(), baseIds ? inArray(warehouses.id, baseIds) : undefined))
    .orderBy(asc(warehouses.code));
}
