import { aliasedTable, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches, warehouses } from '../../platform/db/schema';

/**
 * An INTERNAL leg — a truck that crosses no border (owner, 2026-09-24:
 * «ichki partiyalarda biz yuk tarqatmaymiz, shunda narx qo'yilmagan partiyalar
 * deb ko'rinib qolyabti» → his answer C1a: an internal truck is never billed).
 * Yiwu → Kashgar is one, and so is Andijan → Tashkent; the client pays once,
 * on the truck that carries the cargo across, and an internal leg's cost
 * reaches that price as «shu reysgacha» through the allocations.
 *
 * Decided by the two warehouses' COUNTRIES and never by `batches.type`: that
 * column has two writers that disagree (plan approval types Kashgar →
 * Tashkent as 'transfer', the quick batch types a direct Yiwu → Andijan
 * export as 'distribution') and no reader at all, so keying on it would have
 * hidden the price on real export trucks.
 *
 * This is a MONEY rule and deliberately not the client cabinet's journey
 * rule: the cabinet calls any departure into Uzbekistan «export» (the ladder
 * a customer reads), while here a truck that starts in Uzbekistan too is
 * internal — the client was priced on the truck that brought the cargo
 * across, and a second price on Andijan → Tashkent is the same false «narx
 * qo'yilmagan» the owner reported for Yiwu → Kashgar.
 *
 * `warehouses.country` is free text, so both sides are normalised, and an
 * empty country is NOT internal: an unknown border is treated as crossed,
 * which leaves the price door where it has always been.
 */
export function isInternalLeg(
  originCountry: string | null | undefined,
  destCountry: string | null | undefined,
): boolean {
  const a = (originCountry ?? '').trim().toUpperCase();
  const b = (destCountry ?? '').trim().toUpperCase();
  return a !== '' && a === b;
}

/**
 * The same rule over two warehouse table references, for queries that
 * aggregate batches (a counter must not restate it by hand, #513).
 */
export function internalLegSql(origin: SQL | string, dest: SQL | string): SQL {
  const o = typeof origin === 'string' ? sql.raw(origin) : origin;
  const d = typeof dest === 'string' ? sql.raw(dest) : dest;
  return sql`(nullif(upper(trim(${o}.country)), '') = upper(trim(${d}.country)))`;
}

export interface BatchRoute {
  originCountry: string;
  destCountry: string;
  internal: boolean;
}

/** One batch's route, or null when the batch does not exist. */
export async function batchRoute(batchId: string): Promise<BatchRoute | null> {
  const dest = aliasedTable(warehouses, 'dest');
  const [row] = await db
    .select({ originCountry: warehouses.country, destCountry: dest.country })
    .from(batches)
    .innerJoin(warehouses, eq(batches.originWarehouseId, warehouses.id))
    .innerJoin(dest, eq(batches.destWarehouseId, dest.id))
    .where(eq(batches.id, batchId))
    .limit(1);
  if (!row) return null;
  return { ...row, internal: isInternalLeg(row.originCountry, row.destCountry) };
}
