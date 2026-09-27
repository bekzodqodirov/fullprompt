import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';

/**
 * What stands in ONE warehouse, or rides ONE truck, lot by lot — the staff
 * map's answer to a tap (the owner, 2026-09-26: «mashinani yokida sklad
 * iconni ustiga bosganda shu bosgan joyini ustidan toliq yuki haqidagi info
 * chiqsin kubi kilosi qabul sanasi nomi rasimi»).
 *
 * The map page carries only «GS777 · 12» chips per place; this is fetched on
 * the tap, so a warehouse with four hundred lots costs nothing until somebody
 * opens it. Same membership as the page: boxes STANDING in the warehouse in a
 * stock status, or riding the truck by the live pointer (round 100 5A's
 * reading of «in transit»). kg and m³ are the lot's SHARE (boxes here ÷
 * boxes in the lot), the rule every per-place figure in this app uses.
 */
export interface PlaceCargoLot {
  lotId: string;
  receiptId: string;
  receiptNumber: string | null;
  /** ISO — the day the cargo came (a back-dated office prixod's REAL day, 0112). */
  receivedAt: string;
  /** The client's code, or the box's marking while nobody has claimed it. */
  clientCode: string;
  goods: string;
  boxes: number;
  kg: number | null;
  m3: number | null;
  /** The lot's first photograph, for the thumbnail. */
  photoId: string | null;
}

export const PLACE_CARGO_CAP = 80;

const STOCK = sql`('in_stock', 'planned', 'loading', 'ready_for_pickup')`;

export async function placeCargo(
  place: { warehouseId: string } | { batchId: string },
  clientCode: string | null = null,
): Promise<{ lots: PlaceCargoLot[]; total: number }> {
  const where =
    'warehouseId' in place
      ? sql`b.current_warehouse_id = ${place.warehouseId}::uuid AND b.status IN ${STOCK}`
      : sql`b.current_batch_id = ${place.batchId}::uuid AND b.status = 'in_transit'`;
  const client = clientCode ? sql`AND upper(c.client_code) = ${clientCode.toUpperCase()}` : sql``;
  const rows = (await db.execute(sql`
    SELECT l.id AS lot_id, r.id AS receipt_id, r.number AS receipt_number,
           r.received_at::text AS received_at,
           coalesce(c.client_code, r.unclaimed_marking, '?') AS client_code,
           coalesce(nullif(trim(l.product_name_ru), ''), l.product_name_zh) AS goods,
           count(*)::int AS boxes,
           l.total_weight_kg::float8 * count(*) / nullif(l.box_count, 0) AS kg,
           l.total_volume_m3::float8 * count(*) / nullif(l.box_count, 0) AS m3,
           (SELECT a.id FROM attachments a
             WHERE a.entity_type = 'receipt_lot' AND a.entity_id = l.id AND a.kind = 'photo'
             ORDER BY a.created_at LIMIT 1) AS photo_id,
           count(*) OVER ()::int AS total
      FROM boxes b
      JOIN receipt_lots l ON l.id = b.lot_id
      JOIN receipts r ON r.id = l.receipt_id
      LEFT JOIN clients c ON c.id = r.client_id
     WHERE ${where} ${client}
     GROUP BY l.id, r.id, c.client_code
     ORDER BY client_code, received_at, l.id
     LIMIT ${PLACE_CARGO_CAP}
  `)) as unknown as Record<string, unknown>[];
  const num = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 1000) / 1000);
  return {
    total: rows.length ? Number(rows[0]!.total) : 0,
    lots: rows.map((r) => ({
      lotId: String(r.lot_id),
      receiptId: String(r.receipt_id),
      receiptNumber: r.receipt_number ? String(r.receipt_number) : null,
      receivedAt: String(r.received_at),
      clientCode: String(r.client_code),
      goods: String(r.goods ?? ''),
      boxes: Number(r.boxes),
      kg: num(r.kg),
      m3: num(r.m3),
      photoId: r.photo_id ? String(r.photo_id) : null,
    })),
  };
}
