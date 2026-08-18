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
import { inScope, type ScopedActor } from '../../platform/rbac/scope';

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
    // The two numbers the price is made of (owner: "kubi kilosi ham muhim").
    weightKg: z.number().positive().max(1_000_000).optional(),
    volumeM3: z.number().positive().max(100_000).optional(),
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
  actor: ScopedActor,
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new ArrivalError('unauthenticated');
  // The picker offers a scoped operator only their own warehouses; the wire
  // does not (#171's rule about re-posted forms, worn by a promise): a
  // re-posted warehouseId planted a promise on another country's arrivals
  // list, with nothing telling the manager who wrote it.
  if (!inScope(actor, input.warehouseId)) throw new ArrivalError('wrong_warehouse');

  const [row] = await db
    .insert(expectedArrivals)
    .values({
      warehouseId: input.warehouseId,
      clientId: input.clientId || null,
      marking: input.marking || null,
      boxCount: input.boxCount ?? null,
      weightKg: input.weightKg !== undefined ? String(input.weightKg) : null,
      volumeM3: input.volumeM3 !== undefined ? String(input.volumeM3) : null,
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
      weightKg: input.weightKg ?? null,
      volumeM3: input.volumeM3 ?? null,
      expectedOn: input.expectedOn || null,
    },
  });
  return row!;
}

export async function cancelExpectedArrival(
  id: string,
  reason: string,
  actor: ScopedActor,
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new ArrivalError('unauthenticated');
  if (reason.trim().length < 2) throw new ArrivalError('reason_required');
  const row = await db.query.expectedArrivals.findFirst({ where: eq(expectedArrivals.id, id) });
  if (!row) throw new ArrivalError('not_found');
  // Judged by the ROW's warehouse, not the form's: the id arrived in a form
  // post, and a promise belonging to another country must not be closable by
  // whoever read its id off a shared screen.
  if (!inScope(actor, row.warehouseId)) throw new ArrivalError('wrong_warehouse');
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
export async function markArrived(id: string, actor: ScopedActor, ctx: AuditContext) {
  if (!ctx.actorId) throw new ArrivalError('unauthenticated');
  const row = await db.query.expectedArrivals.findFirst({ where: eq(expectedArrivals.id, id) });
  if (!row) throw new ArrivalError('not_found');
  // Same fence as the cancel above.
  if (!inScope(actor, row.warehouseId)) throw new ArrivalError('wrong_warehouse');
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
  weightKg: number | null;
  volumeM3: number | null;
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
      weightKg: expectedArrivals.weightKg,
      volumeM3: expectedArrivals.volumeM3,
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
  return rows.map((row) => ({
    ...row,
    weightKg: row.weightKg === null ? null : Number(row.weightKg),
    volumeM3: row.volumeM3 === null ? null : Number(row.volumeM3),
    createdByName: null,
  }));
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

/**
 * What the receipt actually brought, next to what the promise said.
 * Pure and unit-tested — the interesting decisions live here, not in the glue.
 */
export interface ArrivalMeasures {
  boxes: number | null;
  kg: number | null;
  m3: number | null;
}

/**
 * Is the difference worth a message?
 *
 * Boxes are counted, so ANY difference is real. Weight and volume are the
 * client's estimates against a warehouse scale — hairline drift is the normal
 * case, and messaging every 2 % would teach the manager to mute the type
 * (the same law as #342). 5 % is where an estimate stops being one.
 */
export function arrivalMismatch(expected: ArrivalMeasures, actual: ArrivalMeasures): boolean {
  if (expected.boxes !== null && actual.boxes !== null && expected.boxes !== actual.boxes) {
    return true;
  }
  for (const key of ['kg', 'm3'] as const) {
    const want = expected[key];
    const got = actual[key];
    if (want !== null && want > 0 && got !== null && Math.abs(got - want) / want > 0.05) {
      return true;
    }
  }
  return false;
}

/**
 * Close EXACTLY the promise the operator tapped «Qabul qilish» on.
 *
 * The heuristic in `closeExpectedOnReceipt` gives up when a client has two
 * open promises — correctly, it cannot know which one landed — and the
 * operator then had to walk back to /arrivals and press "arrived" by hand
 * (owner: "bu juda noqulay"). When the receipt CARRIES the promise id there
 * is nothing to guess. Refuses quietly on anything not waiting or at another
 * warehouse: a planning aid must never fail a receipt.
 */
export async function closeExpectedById(
  dbOrTx: Db | Tx,
  input: { arrivalId: string; warehouseId: string; receiptId: string },
): Promise<typeof expectedArrivals.$inferSelect | null> {
  const [row] = await dbOrTx
    .select()
    .from(expectedArrivals)
    .where(eq(expectedArrivals.id, input.arrivalId))
    .limit(1);
  if (!row || row.status !== 'waiting' || row.warehouseId !== input.warehouseId) return null;
  await dbOrTx
    .update(expectedArrivals)
    .set({ status: 'arrived', arrivedAt: new Date(), receiptId: input.receiptId })
    .where(eq(expectedArrivals.id, row.id));
  return row;
}

/**
 * Tell the promise's author what actually landed, when it differs
 * (owner: "kutilayotgan yukni farqi … managerga xabar bo'lib borishi",
 * "kubi va kilosida farq bo'lsa ham xabar kelsin").
 *
 * Straight to the person who wrote the promise — they made it to the client
 * and they will be answering for the difference. Never to the receiver:
 * they are looking at the boxes.
 */
export async function announceArrivalDiff(input: {
  arrival: typeof expectedArrivals.$inferSelect;
  actual: ArrivalMeasures;
  receiptId: string;
  receiptNumber: string;
  actorId: string | null;
}): Promise<void> {
  const { notifyStaffTelegram } = await import('../../platform/notifications/staff');
  const { cardLink } = await import('../../platform/notifications/links');
  const expected: ArrivalMeasures = {
    boxes: input.arrival.boxCount,
    kg: input.arrival.weightKg === null ? null : Number(input.arrival.weightKg),
    m3: input.arrival.volumeM3 === null ? null : Number(input.arrival.volumeM3),
  };
  if (!arrivalMismatch(expected, input.actual)) return;

  const who = input.arrival.clientId
    ? ((await db.query.clients.findFirst({ where: eq(clients.id, input.arrival.clientId) }))
        ?.clientCode ?? '')
    : (input.arrival.marking ?? '');
  const line = (m: ArrivalMeasures) =>
    [
      m.boxes !== null ? `${m.boxes} 📦` : null,
      m.kg !== null ? `${Math.round(m.kg * 10) / 10} kg` : null,
      m.m3 !== null ? `${Math.round(m.m3 * 100) / 100} m³` : null,
    ]
      .filter(Boolean)
      .join(' · ') || '—';
  await notifyStaffTelegram({
    userIds: [input.arrival.createdBy],
    type: 'ArrivalDiff',
    text:
      `⚠️ Kutilgan yuk farq bilan keldi: ${who}\n` +
      `Kutilgan: ${line(expected)}\n` +
      `Qabul (${input.receiptNumber}): ${line(input.actual)}\n` +
      `🔗 ${cardLink('receipt', input.receiptId)}`,
    exceptUserId: input.actorId,
  });
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
