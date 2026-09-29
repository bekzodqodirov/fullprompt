import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../platform/db/client';
import { batches, boxes, receiptLots, receipts, warehouses } from '../../platform/db/schema';
import { roundKg, roundM3, shareOf, sumRounded } from '../../platform/telegram/format';
import { latestPositions } from '../tracking/devices';
import { truckFor } from '../tracking/truck';
import { loadBorderHours } from '../tracking/border-queue';
import { warehousePoint } from '../tracking/warehouse-point';

/**
 * Where the client's own cargo is, drawn (the owner, 2026-09-26, item 11:
 * «yonida karta iconi bolsin bosganda hamma yukini kartada korsin mashinani
 * ustiga bosganda ozini yukini korsin qanchasi qayerda. skladlarda ham
 * shunday»). Round 98 kept the truck off the cabinet «until every client can
 * see their own cargo on a real map» — this is that map.
 *
 * Every place carries ONLY this client's cargo: a warehouse is drawn because
 * their boxes stand in it, a truck because their boxes ride it, and the
 * marker says what of THEIRS is there. What is deliberately NOT passed on
 * from the staff marker (`truckFor`): the batch code (the company's
 * throughput), the plate, and the truck's other contents — twenty other
 * customers' codes.
 */
export interface CabinetMapLot {
  lotId: string;
  letter: string | null;
  productNameZh: string;
  productNameRu: string | null;
  boxes: number;
  kg: number;
  m3: number;
}

export interface CabinetMapPlace {
  key: string;
  kind: 'warehouse' | 'truck';
  /** Warehouse: its name. Truck: «from → to», the two warehouses' names. */
  name: string;
  /**
   * lon, lat — or NULL when nobody has typed the warehouse's coordinates and
   * the built-in dictionary does not know its code. Such a place is still
   * LISTED under the map (the owner: «hamma yuklarni korish kerak») — it was
   * dropped entirely, so cargo in an unplotted warehouse vanished from the
   * screen that exists to show where it is.
   */
  point: { x: number; y: number } | null;
  /** A truck's position is from the driver's phone (true) or estimated. */
  live: boolean;
  /** A truck's road, so the map can draw the line it is on. */
  route: { x: number; y: number }[];
  remainingDays: [number, number] | null;
  boxes: number;
  kg: number;
  m3: number;
  lots: CabinetMapLot[];
}

const STOCK = ['in_stock', 'planned', 'loading', 'ready_for_pickup'];

export async function cabinetMap(clientIds: string[]): Promise<CabinetMapPlace[]> {
  if (clientIds.length === 0) return [];
  const rows = await db
    .select({
      status: boxes.status,
      warehouseId: boxes.currentWarehouseId,
      // The live pointer is the right question for a box STILL in transit
      // (the cabinet's own rule, cargoOverview).
      batchId: boxes.currentBatchId,
      lotId: receiptLots.id,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      productNameRu: receiptLots.productNameRu,
      n: sql<number>`count(*)`,
      lotKg: receiptLots.totalWeightKg,
      lotM3: receiptLots.totalVolumeM3,
      lotBoxes: receiptLots.boxCount,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(
      and(
        inArray(receipts.clientId, clientIds),
        ne(receipts.status, 'voided'),
        inArray(boxes.status, [...STOCK, 'in_transit']),
      ),
    )
    .groupBy(
      boxes.status,
      boxes.currentWarehouseId,
      boxes.currentBatchId,
      receiptLots.id,
      receiptLots.letter,
      receiptLots.productNameZh,
      receiptLots.productNameRu,
      receiptLots.totalWeightKg,
      receiptLots.totalVolumeM3,
      receiptLots.boxCount,
    );

  // Each lot's own figures; a place's lot line is `shareOf` over them and the
  // place adds its lines as printed — the lot card's and the push's rules, so
  // the map under the header says what the header says (round C review,
  // second pass: it rounded kilos to ONE place, 5.7 beside 5.71).
  const lotOf = new Map<string, { kg: number; m3: number; boxes: number }>();
  const places = new Map<string, Omit<CabinetMapPlace, 'name' | 'point' | 'live' | 'route' | 'remainingDays'> & { ref: string }>();
  for (const r of rows) {
    const transit = r.status === 'in_transit';
    const ref = transit ? r.batchId : r.warehouseId;
    if (!ref) continue;
    const key = `${transit ? 'truck' : 'warehouse'}:${ref}`;
    const place =
      places.get(key) ?? { key, kind: transit ? ('truck' as const) : ('warehouse' as const), ref, boxes: 0, kg: 0, m3: 0, lots: [] };
    const n = Number(r.n);
    lotOf.set(r.lotId, { kg: Number(r.lotKg ?? 0), m3: Number(r.lotM3 ?? 0), boxes: Number(r.lotBoxes) });
    place.boxes += n;
    const lot = place.lots.find((l) => l.lotId === r.lotId);
    if (lot) {
      lot.boxes += n;
    } else {
      place.lots.push({
        lotId: r.lotId,
        letter: r.letter,
        productNameZh: r.productNameZh,
        productNameRu: r.productNameRu,
        boxes: n,
        kg: 0,
        m3: 0,
      });
    }
    places.set(key, place);
  }
  if (places.size === 0) return [];

  const whIds = [...places.values()].filter((p) => p.kind === 'warehouse').map((p) => p.ref);
  const batchIds = [...places.values()].filter((p) => p.kind === 'truck').map((p) => p.ref);
  const origin = alias(warehouses, 'o');
  const dest = alias(warehouses, 'd');
  const [whRows, batchRows, fixes] = await Promise.all([
    whIds.length ? db.select().from(warehouses).where(inArray(warehouses.id, whIds)) : Promise.resolve([]),
    batchIds.length
      ? db
          .select({ batch: batches, originCode: origin.code, originName: origin.name, destCode: dest.code, destName: dest.name })
          .from(batches)
          .innerJoin(origin, eq(batches.originWarehouseId, origin.id))
          .innerJoin(dest, eq(batches.destWarehouseId, dest.id))
          .where(inArray(batches.id, batchIds))
      : Promise.resolve([]),
    batchIds.length ? latestPositions(batchIds) : Promise.resolve(new Map()),
  ]);

  const out: CabinetMapPlace[] = [];
  const finish = (p: (typeof places extends Map<string, infer V> ? V : never)) => {
    const lots = p.lots.map((l) => {
      const m = lotOf.get(l.lotId);
      return {
        ...l,
        kg: roundKg(m ? shareOf(m.kg, l.boxes, m.boxes) : 0),
        m3: roundM3(m ? shareOf(m.m3, l.boxes, m.boxes) : 0),
      };
    });
    return {
      boxes: p.boxes,
      kg: sumRounded(lots.map((l) => l.kg), roundKg),
      m3: sumRounded(lots.map((l) => l.m3), roundM3),
      lots,
    };
  };
  for (const w of whRows) {
    const place = places.get(`warehouse:${w.id}`);
    if (!place) continue;
    out.push({
      key: place.key,
      kind: 'warehouse',
      name: w.name,
      point: warehousePoint(w),
      live: false,
      route: [],
      remainingDays: null,
      ...finish(place),
    });
  }
  // The typed border queues, once for the whole map (#432) — the dates on it
  // are the dates the cabinet prints.
  const waits = batchRows.length ? await loadBorderHours() : {};
  for (const b of batchRows) {
    const place = places.get(`truck:${b.batch.id}`);
    if (!place) continue;
    // A truck with neither a phone nor a known road has no position — it is
    // still the client's cargo, so it is listed rather than dropped.
    const marker = await truckFor(b.batch, b.originCode, b.destCode, waits, fixes.get(b.batch.id)).catch(
      () => null,
    );
    out.push({
      key: place.key,
      kind: 'truck',
      name: `${b.originName} → ${b.destName}`,
      point: marker ? { x: marker.x, y: marker.y } : null,
      live: marker?.live ?? false,
      route: marker?.routePoints ?? [],
      remainingDays: marker && !marker.overdue && marker.remainingDays[1] > 0 ? marker.remainingDays : null,
      ...finish(place),
    });
  }
  return out;
}
