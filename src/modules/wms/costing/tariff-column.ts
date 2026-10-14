import { eq } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { warehouseTariffColumns } from '../../platform/db/schema';
import { KNOWN_TARIFF_ZONES } from '../calc/tariff-seed';
import { tariffZoneNames } from '../calc/tariff-read';

/**
 * Which column of his tariff a warehouse's trucks are split by — his 2c,
 * «har bir skladga ustun yozib chiqiladi, mashina ustunni o'z skladidan
 * oladi» (docs/YOLKIRA-TAQSIMOT.md §2). Written by a person on the warehouse
 * form; NEVER inferred from a country, a name or a type. No row = «—».
 *
 * The ONLY reader and writer of `warehouse_tariff_columns`. Wms, not
 * platform: the warehouse form lives in `src/app` and may import wms, while
 * platform must never import wms. The recompute never calls it — a saved
 * bill reads its own frozen copy (fenced).
 */
export async function tariffColumnOf(warehouseId: string, handle: Db | Tx = db): Promise<string | null> {
  const [row] = await handle
    .select({ zone: warehouseTariffColumns.tariffZone })
    .from(warehouseTariffColumns)
    .where(eq(warehouseTariffColumns.warehouseId, warehouseId));
  return row?.zone ?? null;
}

/**
 * The columns a warehouse may be mapped onto: every zone the tariff has ever
 * priced, the zones the app knows how to NAME (horgos before he types its
 * prices), and the warehouse's own STORED column even when no row has it any
 * more — or the select would fall to «—» and an unrelated capacity edit would
 * silently clear the mapping (#171). `priced` says whether the column has
 * any row at all; the form marks an unpriced one «(narx yo'q)».
 */
export async function mappableZones(stored: string | null): Promise<{ zone: string; priced: boolean }[]> {
  const priced = new Set(await tariffZoneNames());
  const all = new Set<string>([...priced, ...KNOWN_TARIFF_ZONES, ...(stored ? [stored] : [])]);
  return [...all].sort().map((zone) => ({ zone, priced: priced.has(zone) }));
}

/** null → delete the mapping; a zone → upsert it. The caller has validated it. */
export async function setTariffColumnInTx(tx: Tx, warehouseId: string, zone: string | null): Promise<void> {
  if (zone === null) {
    await tx.delete(warehouseTariffColumns).where(eq(warehouseTariffColumns.warehouseId, warehouseId));
    return;
  }
  await tx
    .insert(warehouseTariffColumns)
    .values({ warehouseId, tariffZone: zone })
    .onConflictDoUpdate({
      target: warehouseTariffColumns.warehouseId,
      set: { tariffZone: zone, updatedAt: new Date() },
    });
}
