import { aliasedTable, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches, warehouses } from '../../platform/db/schema';

/**
 * An INTERNAL leg — a truck inside CHINA, which is never billed (owner,
 * 2026-09-24: «ichki partiyalarda biz yuk tarqatmaymiz, shunda narx qo'yilmagan
 * partiyalar deb ko'rinib qolyabti» → his answer C1a). Yiwu → Kashgar is one:
 * the client pays once, on the truck that carries the cargo across, and the
 * internal leg's cost reaches that price as «shu reysgacha» through the
 * allocations.
 *
 * CHINA ONLY, by his answer U1b the same evening: «bazan qo'yiladi, Andijondan
 * berilganda qo'yiladi». A truck inside Uzbekistan — Andijan → Tashkent —
 * carries cargo that is sometimes handed over at its far end and priced for
 * that road, so it is an ordinary priced truck. v1 of this rule called any
 * same-country leg internal and hid the price form on exactly those trucks.
 *
 * Decided by the two warehouses' COUNTRIES and never by `batches.type`: that
 * column has two writers that disagree (plan approval types Kashgar →
 * Tashkent as 'transfer', the quick batch types a direct Yiwu → Andijan
 * export as 'distribution') and no reader at all, so keying on it would have
 * hidden the price on real export trucks.
 *
 * This is a MONEY rule and deliberately not the client cabinet's journey
 * rule, nor the VED's paperwork rule (`sameCountryLegSql` below): a truck
 * that crosses no border needs no export papers whichever country it is in.
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
  return a === 'CN' && b === 'CN';
}

/**
 * The money rule over two warehouse table references, for queries that
 * aggregate batches (a counter must not restate it by hand, #513).
 */
export function internalLegSql(origin: SQL | string, dest: SQL | string): SQL {
  const o = typeof origin === 'string' ? sql.raw(origin) : origin;
  const d = typeof dest === 'string' ? sql.raw(dest) : dest;
  return sql`(upper(trim(${o}.country)) = 'CN' AND upper(trim(${d}.country)) = 'CN')`;
}

/**
 * A truck that crosses NO border, in any country — the VED's paperwork rule
 * and not a money one: Andijan → Tashkent is priced (U1b) but still has no
 * export declaration to send to the agent.
 */
export function sameCountryLegSql(origin: SQL | string, dest: SQL | string): SQL {
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
