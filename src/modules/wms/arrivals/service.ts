import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Db, type Tx } from '../../platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  clients,
  expectedArrivals,
  receiptLots,
  warehouses,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';

/**
 * What is coming TO a warehouse (owner: "«Qabul» — Xitoy skladlari CRM'dan
 * kutilayotgan yukni ko'radi; O'zbekiston skladlari boshqa skladdan yo'lga
 * chiqqan mashinalarni ko'rib, skanerlab qabul qiladi").
 *
 * Two different things arrive at a warehouse and they were both invisible
 * until they were already in the building: a client's cargo, which the sales
 * side knows about days ahead, and a truck from one of our own warehouses,
 * which the system has known about since it departed. This module answers
 * both from the receiving warehouse's point of view.
 */

export class ArrivalError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export const expectedArrivalSchema = z
  .object({
    warehouseId: z.string().uuid(),
    clientId: z.string().uuid().optional().or(z.literal('')),
    marking: z.string().trim().max(200).optional().or(z.literal('')),
    boxCount: z.number().int().positive().max(100_000).optional(),
    expectedOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .or(z.literal('')),
    note: z.string().trim().max(2000).optional().or(z.literal('')),
  })
  // Someone has to be expecting something: a code, or the marking that will
  // be written on the boxes.
  .refine((value) => Boolean(value.clientId || value.marking), { message: 'who_required' });

export async function createExpectedArrival(
  input: z.infer<typeof expectedArrivalSchema>,
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new ArrivalError('unauthenticated');
  const [row] = await db
    .insert(expectedArrivals)
    .values({
      warehouseId: input.warehouseId,
      clientId: input.clientId || null,
      marking: input.marking || null,
      boxCount: input.boxCount ?? null,
      expectedOn: input.expectedOn || null,
      note: input.note || null,
      createdBy: ctx.actorId,
    })
    .returning();
  await writeAudit(db, { ...ctx, warehouseId: input.warehouseId }, {
    entityType: 'expected_arrival',
    entityId: row!.id,
    action: 'create',
    after: {
      clientId: input.clientId || null,
      marking: input.marking || null,
      boxCount: input.boxCount ?? null,
      expectedOn: input.expectedOn || null,
    },
  });
  return row!;
}

export async function cancelExpectedArrival(id: string, reason: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new ArrivalError('unauthenticated');
  if (reason.trim().length < 2) throw new ArrivalError('reason_required');
  const row = await db.query.expectedArrivals.findFirst({ where: eq(expectedArrivals.id, id) });
  if (!row) throw new ArrivalError('not_found');
  if (row.status !== 'waiting') throw new ArrivalError('not_waiting');
  await db
    .update(expectedArrivals)
    .set({ status: 'cancelled', cancelReason: reason.trim() })
    .where(eq(expectedArrivals.id, id));
  await writeAudit(db, { ...ctx, warehouseId: row.warehouseId }, {
    entityType: 'expected_arrival',
    entityId: id,
    action: 'void',
    after: { reason: reason.trim() },
  });
}

/** Closed by hand when the cargo turned up without a receipt of its own. */
export async function markArrived(id: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new ArrivalError('unauthenticated');
  const row = await db.query.expectedArrivals.findFirst({ where: eq(expectedArrivals.id, id) });
  if (!row) throw new ArrivalError('not_found');
  if (row.status !== 'waiting') return;
  await db
    .update(expectedArrivals)
    .set({ status: 'arrived', arrivedAt: new Date() })
    .where(eq(expectedArrivals.id, id));
  await writeAudit(db, { ...ctx, warehouseId: row.warehouseId }, {
    entityType: 'expected_arrival',
    entityId: id,
    action: 'status_change',
    after: { status: 'arrived', byHand: true },
  });
}

/**
 * Close the promise when the real cargo lands.
 *
 * Runs inside the receipt's own transaction, and only when the match is
 * unambiguous — exactly ONE waiting row for that client at that warehouse.
 * Two open promises mean we cannot know which receipt answers which, and
 * guessing would close a row that is still genuinely outstanding. Never
 * throws: a planning aid must not be able to fail a receipt.
 */
export async function closeExpectedOnReceipt(
  dbOrTx: Db | Tx,
  input: { warehouseId: string; clientId: string | null; receiptId: string },
): Promise<void> {
  if (!input.clientId) return;
  const open = await dbOrTx
    .select({ id: expectedArrivals.id })
    .from(expectedArrivals)
    .where(
      and(
        eq(expectedArrivals.warehouseId, input.warehouseId),
        eq(expectedArrivals.clientId, input.clientId),
        eq(expectedArrivals.status, 'waiting'),
      ),
    )
    .limit(2);
  if (open.length !== 1) return;
  await dbOrTx
    .update(expectedArrivals)
    .set({ status: 'arrived', arrivedAt: new Date(), receiptId: input.receiptId })
    .where(eq(expectedArrivals.id, open[0]!.id));
}

export interface ExpectedRow {
  id: string;
  warehouseId: string;
  warehouseCode: string;
  clientId: string | null;
  clientCode: string | null;
  clientName: string | null;
  marking: string | null;
  boxCount: number | null;
  expectedOn: string | null;
  note: string | null;
  createdByName: string | null;
}

/** Everything still promised to these warehouses, soonest first. */
export async function listExpected(warehouseIds?: string[]): Promise<ExpectedRow[]> {
  if (warehouseIds && warehouseIds.length === 0) return [];
  const rows = await db
    .select({
      id: expectedArrivals.id,
      warehouseId: expectedArrivals.warehouseId,
      warehouseCode: warehouses.code,
      clientId: expectedArrivals.clientId,
      clientCode: clients.clientCode,
      clientName: clients.name,
      marking: expectedArrivals.marking,
      boxCount: expectedArrivals.boxCount,
      expectedOn: expectedArrivals.expectedOn,
      note: expectedArrivals.note,
    })
    .from(expectedArrivals)
    .innerJoin(warehouses, eq(expectedArrivals.warehouseId, warehouses.id))
    .leftJoin(clients, eq(expectedArrivals.clientId, clients.id))
    .where(
      and(
        eq(expectedArrivals.status, 'waiting'),
        warehouseIds ? inArray(expectedArrivals.warehouseId, warehouseIds) : undefined,
      ),
    )
    // A row with no date is not urgent; a dated one is, in date order.
    .orderBy(asc(expectedArrivals.expectedOn), asc(expectedArrivals.createdAt))
    .limit(500);
  return rows.map((row) => ({ ...row, createdByName: null }));
}

export interface IncomingTruck {
  batchId: string;
  code: string;
  status: string;
  originCode: string | null;
  destId: string;
  destCode: string | null;
  vehiclePlate: string | null;
  driverName: string | null;
  departedAt: Date | null;
  arrivedAt: Date | null;
  boxCount: number;
  kg: number;
  /** Still on the truck as far as this warehouse knows. */
  remaining: number;
}

/**
 * Trucks on their way to these warehouses.
 *
 * Membership comes from what DEPARTED (DECISIONS #121) so the counter goes
 * DOWN as boxes are accepted instead of losing them; `remaining` is what the
 * unload screen still has to scan.
 */
export async function incomingTrucks(warehouseIds?: string[]): Promise<IncomingTruck[]> {
  if (warehouseIds && warehouseIds.length === 0) return [];
  const origin = aliasedTable(warehouses, 'origin_wh');
  const dest = aliasedTable(warehouses, 'dest_wh');
  const rows = await db
    .select({
      batchId: batches.id,
      code: batches.code,
      status: batches.status,
      originCode: origin.code,
      destId: batches.destWarehouseId,
      destCode: dest.code,
      vehiclePlate: batches.vehiclePlate,
      driverName: batches.driverName,
      departedAt: batches.departedAt,
      arrivedAt: batches.arrivedAt,
      boxCount: sql<number>`count(distinct ${boxes.id})`,
      kg: sql<string>`coalesce(sum(${receiptLots.totalWeightKg} / ${receiptLots.boxCount}), 0)`,
      remaining: sql<number>`count(distinct ${boxes.id}) filter (where ${boxes.status} = 'in_transit')`,
    })
    .from(batches)
    .leftJoin(origin, eq(batches.originWarehouseId, origin.id))
    .leftJoin(dest, eq(batches.destWarehouseId, dest.id))
    // Joined through the movement rows rather than a correlated subquery:
    // `boxes.id IN (SELECT …)` as a join condition makes Postgres walk the
    // whole box table once per batch, which is a table scan that grows with
    // every receipt ever taken.
    .leftJoin(
      boxMovements,
      and(
        eq(boxMovements.refType, 'batch'),
        eq(boxMovements.refId, batches.id),
        eq(boxMovements.cause, 'batch_departed'),
      ),
    )
    .leftJoin(boxes, eq(boxes.id, boxMovements.boxId))
    .leftJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(
      and(
        inArray(batches.status, ['in_transit', 'arrived']),
        warehouseIds ? inArray(batches.destWarehouseId, warehouseIds) : undefined,
      ),
    )
    .groupBy(batches.id, origin.code, dest.code)
    .orderBy(asc(batches.departedAt));

  return rows.map((row) => ({
    ...row,
    boxCount: Number(row.boxCount),
    kg: Math.round(Number(row.kg) * 10) / 10,
    remaining: Number(row.remaining),
  }));
}

/** Warehouses where a client actually collects cargo (owner: TAS and AND). */
export async function issuingWarehouseIds(scope?: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(
      and(
        eq(warehouses.issuesToClients, true),
        eq(warehouses.active, true),
        scope && scope.length ? inArray(warehouses.id, scope) : undefined,
      ),
    );
  return rows.map((row) => row.id);
}
