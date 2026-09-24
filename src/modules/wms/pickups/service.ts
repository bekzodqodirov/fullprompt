import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Tx } from '../../platform/db/client';
import {
  clientNotices,
  clients,
  costEntries,
  factories,
  pickupLines,
  pickups,
  pickupStops,
  receipts,
  users,
  warehouses,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { inScope, type ScopedActor } from '../../platform/rbac/scope';
import { warehousePoint } from '../tracking/warehouse-point';
import { fetchLeg, geocodeAddress } from './geo-fetch';
import { gcj02ToWgs84, parsePastedPoint, type LngLat } from './geo';

/**
 * «Zavod reysi» — a truck WE hire collects cargo from one to three factories
 * and brings it to our warehouse (owner, 2026-09-24, B1-B6 + D1). Designed,
 * judged by four lenses and redesigned before any code (DECISIONS #1002-):
 *
 *  - The pickup's LINES are the promise. `expected_arrivals` is not touched:
 *    six of its readers would have treated a truck's cargo as a seller's
 *    promise and closed, counted or calendared it.
 *  - A prixod names the STOP it came from (`receipts.pickup_stop_id`), and
 *    only a person writes that: the receive door, or attach on the receipt
 *    card. Nothing links by itself — a guess that moves money is worse than
 *    a question (#809).
 *  - The truck's cost is a `cost_entries` row in scope 'pickup', split by m³
 *    over the boxes of the linked prixods — the engine, not a second one.
 *  - The map is an ESTIMATE (tracking/pickup-route.ts); nothing on the truck
 *    reports a position, and every screen says «taxminiy».
 */

export class PickupError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

// ---------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------

/** Who writes a trip, its stops and its lines: the logist who hires the truck (B1). */
export const PICKUP_WRITE = 'plans.manage';

/**
 * Who may open the pickup list at all — the logist, whoever enters a truck's
 * cost (the accountant, the VED: the cost lives on the card), and the money
 * reports. The warehouse sees its incoming trucks on /receive, through
 * `mayReadPickup`'s last clause, never through the list.
 */
export function mayReadPickups(permissions: { has(code: string): boolean }): boolean {
  return (
    permissions.has(PICKUP_WRITE) ||
    permissions.has('costs.enter_batch') ||
    permissions.has('finance.reports')
  );
}

/** One trip's card: the list's door, or a receiver standing at its destination. */
export function mayReadPickup(
  actor: ScopedActor & { permissions: { has(code: string): boolean } },
  destWarehouseId: string,
): boolean {
  if (mayReadPickups(actor.permissions)) return true;
  return actor.permissions.has('receipts.create') && inScope(actor, destWarehouseId);
}

// ---------------------------------------------------------------------------
// Factories (B6)
// ---------------------------------------------------------------------------

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal(''))
    .transform((v) => (v ? v : null));

export const factorySchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  address: optionalText(500),
  phone: optionalText(100),
  wechat: optionalText(100),
  goodsNote: optionalText(500),
  note: optionalText(2000),
});

export type FactoryInput = z.input<typeof factorySchema>;

export async function listFactories(opts: { includeInactive?: boolean } = {}) {
  return db
    .select()
    .from(factories)
    .where(opts.includeInactive ? undefined : eq(factories.active, true))
    .orderBy(asc(sql`lower(${factories.name})`));
}

/**
 * Create or update a factory. When the ADDRESS changed and nobody has placed
 * the pin by hand, the address is geocoded AFTER the write — outside any
 * transaction (#714), with a deadline, and never able to fail the save: a
 * factory without a map point is still a phone number and an address.
 */
export async function saveFactory(
  raw: FactoryInput,
  ctx: AuditContext,
): Promise<{ id: string; geocoded: 'found' | 'not_found' | 'kept' }> {
  if (!ctx.actorId) throw new PickupError('unauthenticated');
  const input = factorySchema.parse(raw);
  const values = {
    name: input.name,
    address: input.address,
    phone: input.phone,
    wechat: input.wechat,
    goodsNote: input.goodsNote,
    note: input.note,
  };

  let id: string;
  let addressChanged: boolean;
  if (input.id) {
    const before = await db.query.factories.findFirst({ where: eq(factories.id, input.id) });
    if (!before) throw new PickupError('not_found');
    addressChanged = (before.address ?? '') !== (input.address ?? '');
    await db
      .update(factories)
      .set({
        ...values,
        updatedAt: new Date(),
        // A new address makes the old pin a guess about somewhere else. A pin
        // a person placed by hand stays: they may have typed a nicer address
        // for the same gate.
        ...(addressChanged && before.geoSource !== 'manual'
          ? { lat: null, lon: null, geoSource: null, geoPrecision: null, geoLabel: null, geoConfirmedAt: null, geoConfirmedBy: null }
          : {}),
      })
      .where(eq(factories.id, input.id));
    id = input.id;
    await writeAudit(db, ctx, { entityType: 'factory', entityId: id, action: 'update', after: values });
  } else {
    const [row] = await db
      .insert(factories)
      .values({ ...values, createdBy: ctx.actorId })
      .returning({ id: factories.id });
    id = row!.id;
    addressChanged = Boolean(input.address);
    await writeAudit(db, ctx, { entityType: 'factory', entityId: id, action: 'create', after: values });
  }

  const current = await db.query.factories.findFirst({ where: eq(factories.id, id) });
  if (!addressChanged || !current?.address || current.geoSource === 'manual') {
    return { id, geocoded: 'kept' };
  }
  const hit = await geocodeAddress(current.address);
  if (!hit) return { id, geocoded: 'not_found' };
  // Guarded by the address it was asked for: a second save while the
  // geocoder was answering must not receive the first address's pin.
  await db
    .update(factories)
    .set({
      lat: hit.point[1].toFixed(6),
      lon: hit.point[0].toFixed(6),
      geoSource: hit.source,
      geoPrecision: null,
      geoLabel: hit.label.slice(0, 500),
      geoConfirmedAt: null,
      geoConfirmedBy: null,
    })
    .where(and(eq(factories.id, id), eq(factories.address, current.address)));
  await refreshLegsForFactory(id);
  return { id, geocoded: 'found' };
}

/**
 * A pin placed by hand: «lat, lon» pasted from a phone map, or a map link.
 * A CHINESE map (Amap, Tencent, Baidu's GCJ export) speaks GCJ-02 and the
 * paste box asks which map it came from — drawn raw, its pin lands a few
 * hundred metres off, sometimes across the river.
 */
export async function setFactoryPoint(
  id: string,
  input: { text: string; datum: 'wgs84' | 'gcj02' },
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId) throw new PickupError('unauthenticated');
  const parsed = parsePastedPoint(input.text);
  if (!parsed) throw new PickupError('bad_point');
  const point: LngLat = input.datum === 'gcj02' ? gcj02ToWgs84(parsed) : parsed;
  const updated = await db
    .update(factories)
    .set({
      lat: point[1].toFixed(6),
      lon: point[0].toFixed(6),
      geoSource: 'manual',
      geoPrecision: input.datum,
      geoLabel: null,
      // Placing it IS looking at it.
      geoConfirmedAt: new Date(),
      geoConfirmedBy: ctx.actorId,
      updatedAt: new Date(),
    })
    .where(eq(factories.id, id))
    .returning({ id: factories.id });
  if (!updated.length) throw new PickupError('not_found');
  await writeAudit(db, ctx, {
    entityType: 'factory',
    entityId: id,
    action: 'update',
    after: { point, datum: input.datum },
  });
  await refreshLegsForFactory(id);
}

/** «✓ to'g'ri» — a person looked at the geocoder's pin and it is the gate. */
export async function confirmFactoryPoint(id: string, ctx: AuditContext): Promise<void> {
  if (!ctx.actorId) throw new PickupError('unauthenticated');
  const updated = await db
    .update(factories)
    .set({ geoConfirmedAt: new Date(), geoConfirmedBy: ctx.actorId })
    .where(and(eq(factories.id, id), isNotNull(factories.lat)))
    .returning({ id: factories.id });
  if (!updated.length) throw new PickupError('no_point');
  await writeAudit(db, ctx, { entityType: 'factory', entityId: id, action: 'update', after: { geoConfirmed: true } });
}

export async function setFactoryActive(id: string, active: boolean, ctx: AuditContext): Promise<void> {
  await db.update(factories).set({ active, updatedAt: new Date() }).where(eq(factories.id, id));
  await writeAudit(db, ctx, { entityType: 'factory', entityId: id, action: 'update', after: { active } });
}

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

const measure = z
  .union([z.number(), z.null()])
  .optional()
  .refine((v) => v === undefined || v === null || (Number.isFinite(v) && v > 0 && v < 100_000), 'bad_number')
  .transform((v) => v ?? null);

export const lineSchema = z
  .object({
    clientId: z.string().uuid().nullable().optional(),
    marking: z.string().trim().max(50).optional().or(z.literal('')),
    goods: z.string().trim().min(1).max(300),
    factoryBoxes: z.number().int().positive().max(100_000),
    volumeM3: measure,
    weightKg: measure,
    note: z.string().trim().max(500).optional().or(z.literal('')),
  })
  .refine((l) => Boolean(l.clientId) || Boolean(l.marking?.trim()), 'owner_required');

export type LineInput = z.input<typeof lineSchema>;

export const pickupSchema = z.object({
  destWarehouseId: z.string().uuid(),
  vehiclePlate: optionalText(30),
  driverName: optionalText(100),
  driverPhone: optionalText(40),
  plannedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal(''))
    .transform((v) => v || null),
  note: optionalText(2000),
  // B3: «ba'zan 2-3 ta zavoddan» — six is room, not a design limit.
  stops: z
    .array(z.object({ factoryId: z.string().uuid(), lines: z.array(lineSchema).max(40) }))
    .min(1)
    .max(6),
});

export type PickupInput = z.input<typeof pickupSchema>;

async function nextPickupCode(tx: Tx): Promise<string> {
  const [row] = await tx.execute<{ n: string }>(sql`SELECT nextval('pickup_code_seq')::text AS n`);
  return `ZR-${String(row!.n).padStart(5, '0')}`;
}

function lineRow(stopId: string, line: z.output<typeof lineSchema>) {
  return {
    stopId,
    clientId: line.clientId ?? null,
    marking: line.clientId ? null : line.marking?.trim() || null,
    goods: line.goods,
    factoryBoxes: line.factoryBoxes,
    volumeM3: line.volumeM3 === null ? null : line.volumeM3.toFixed(4),
    weightKg: line.weightKg === null ? null : line.weightKg.toFixed(3),
    note: line.note || null,
  };
}

async function assertFactoriesExist(tx: Tx, ids: string[]) {
  if (!ids.length) return;
  const rows = await tx
    .select({ id: factories.id })
    .from(factories)
    .where(inArray(factories.id, [...new Set(ids)]));
  if (rows.length !== new Set(ids).size) throw new PickupError('factory_not_found');
}

async function assertClientsExist(tx: Tx, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (!wanted.length) return;
  const rows = await tx.select({ id: clients.id }).from(clients).where(inArray(clients.id, wanted));
  if (rows.length !== wanted.length) throw new PickupError('client_not_found');
}

export async function createPickup(raw: PickupInput, ctx: AuditContext): Promise<{ id: string; code: string }> {
  if (!ctx.actorId) throw new PickupError('unauthenticated');
  const input = pickupSchema.parse(raw);
  const created = await db.transaction(async (tx) => {
    const dest = await tx.query.warehouses.findFirst({ where: eq(warehouses.id, input.destWarehouseId) });
    if (!dest || !dest.active) throw new PickupError('warehouse_not_found');
    await assertFactoriesExist(tx, input.stops.map((s) => s.factoryId));
    await assertClientsExist(tx, input.stops.flatMap((s) => s.lines.map((l) => l.clientId)));
    const code = await nextPickupCode(tx);
    const [pickup] = await tx
      .insert(pickups)
      .values({
        code,
        destWarehouseId: dest.id,
        vehiclePlate: input.vehiclePlate,
        driverName: input.driverName,
        driverPhone: input.driverPhone,
        plannedOn: input.plannedOn,
        note: input.note,
        createdBy: ctx.actorId!,
      })
      .returning({ id: pickups.id });
    for (const [i, stop] of input.stops.entries()) {
      const [row] = await tx
        .insert(pickupStops)
        .values({ pickupId: pickup!.id, seq: i + 1, factoryId: stop.factoryId })
        .returning({ id: pickupStops.id });
      if (stop.lines.length) await tx.insert(pickupLines).values(stop.lines.map((l) => lineRow(row!.id, l)));
    }
    await writeAudit(tx, { ...ctx, warehouseId: dest.id }, {
      entityType: 'pickup',
      entityId: pickup!.id,
      action: 'create',
      after: { code, stops: input.stops.length },
    });
    return { id: pickup!.id, code };
  });
  await refreshLegs(created.id);
  return created;
}

async function lockPickup(tx: Tx, pickupId: string) {
  const [row] = await tx.select().from(pickups).where(eq(pickups.id, pickupId)).for('update');
  if (!row) throw new PickupError('not_found');
  return row;
}

/** Linked, LIVE prixods — a voided one keeps its link as history and blocks nothing. */
async function liveLinkedReceipts(tx: Tx, where: { pickupId?: string; stopId?: string }) {
  return tx
    .select({ id: receipts.id, stopId: receipts.pickupStopId })
    .from(receipts)
    .innerJoin(pickupStops, eq(receipts.pickupStopId, pickupStops.id))
    .where(
      and(
        isNull(receipts.voidedAt),
        where.pickupId ? eq(pickupStops.pickupId, where.pickupId) : undefined,
        where.stopId ? eq(pickupStops.id, where.stopId) : undefined,
      ),
    );
}

export const pickupHeaderSchema = pickupSchema.omit({ stops: true });

/** The header. The destination only while no prixod is linked — they were received THERE. */
export async function updatePickupHeader(
  pickupId: string,
  raw: z.input<typeof pickupHeaderSchema>,
  ctx: AuditContext,
): Promise<void> {
  const input = pickupHeaderSchema.parse(raw);
  await db.transaction(async (tx) => {
    const pickup = await lockPickup(tx, pickupId);
    if (pickup.status === 'cancelled') throw new PickupError('cancelled');
    if (input.destWarehouseId !== pickup.destWarehouseId) {
      if ((await liveLinkedReceipts(tx, { pickupId })).length) throw new PickupError('dest_locked');
      const dest = await tx.query.warehouses.findFirst({ where: eq(warehouses.id, input.destWarehouseId) });
      if (!dest || !dest.active) throw new PickupError('warehouse_not_found');
    }
    await tx
      .update(pickups)
      .set({
        destWarehouseId: input.destWarehouseId,
        vehiclePlate: input.vehiclePlate,
        driverName: input.driverName,
        driverPhone: input.driverPhone,
        plannedOn: input.plannedOn,
        note: input.note,
        updatedAt: new Date(),
      })
      .where(eq(pickups.id, pickupId));
    await writeAudit(tx, ctx, { entityType: 'pickup', entityId: pickupId, action: 'update', after: input });
  });
  await refreshLegs(pickupId);
}

export async function addStop(pickupId: string, factoryId: string, ctx: AuditContext): Promise<string> {
  const stopId = await db.transaction(async (tx) => {
    const pickup = await lockPickup(tx, pickupId);
    if (pickup.status === 'cancelled') throw new PickupError('cancelled');
    await assertFactoriesExist(tx, [factoryId]);
    const [{ n }] = (await tx.execute<{ n: number }>(
      sql`SELECT coalesce(max(seq), 0)::int AS n FROM pickup_stops WHERE pickup_id = ${pickupId}`,
    )) as unknown as [{ n: number }];
    if (n >= 6) throw new PickupError('too_many_stops');
    const [row] = await tx
      .insert(pickupStops)
      .values({ pickupId, seq: n + 1, factoryId })
      .returning({ id: pickupStops.id });
    await writeAudit(tx, ctx, { entityType: 'pickup', entityId: pickupId, action: 'update', after: { addStop: factoryId } });
    return row!.id;
  });
  await refreshLegs(pickupId);
  return stopId;
}

/** A stop goes only while nothing happened at it: not collected, nothing received from it. */
export async function removeStop(stopId: string, ctx: AuditContext): Promise<void> {
  const pickupId = await db.transaction(async (tx) => {
    const stop = await tx.query.pickupStops.findFirst({ where: eq(pickupStops.id, stopId) });
    if (!stop) throw new PickupError('not_found');
    const pickup = await lockPickup(tx, stop.pickupId);
    if (pickup.status === 'cancelled') throw new PickupError('cancelled');
    if (stop.collectedAt) throw new PickupError('stop_collected');
    // Voided links count here: the FK would refuse the delete, and history
    // pointing at a stop is the reason it must stay.
    const [linked] = await tx.select({ id: receipts.id }).from(receipts).where(eq(receipts.pickupStopId, stopId)).limit(1);
    if (linked) throw new PickupError('stop_linked');
    const [{ n }] = (await tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pickup_stops WHERE pickup_id = ${stop.pickupId}`,
    )) as unknown as [{ n: number }];
    if (n <= 1) throw new PickupError('last_stop');
    await tx.delete(pickupStops).where(eq(pickupStops.id, stopId));
    // Close the gap so «1, 2, 3» stays the order the truck drives. Two
    // passes because (pickup_id, seq) is unique at every row, not at commit.
    await tx.execute(sql`UPDATE pickup_stops SET seq = -seq WHERE pickup_id = ${stop.pickupId}`);
    await tx.execute(sql`
      UPDATE pickup_stops ps SET seq = ranked.rn
        FROM (SELECT id, row_number() OVER (ORDER BY -seq) AS rn FROM pickup_stops WHERE pickup_id = ${stop.pickupId}) ranked
       WHERE ps.id = ranked.id
    `);
    await writeAudit(tx, ctx, { entityType: 'pickup', entityId: stop.pickupId, action: 'update', after: { removeStop: stopId } });
    return stop.pickupId;
  });
  await refreshLegs(pickupId);
}

/**
 * Replace a stop's lines. Refused once a prixod came from this stop — the
 * lines are what the receive door and the candidates list read, and editing
 * them under a received prixod would rewrite what was promised after the fact.
 */
export async function saveStopLines(stopId: string, rawLines: LineInput[], ctx: AuditContext): Promise<void> {
  const lines = z.array(lineSchema).max(40).parse(rawLines);
  await db.transaction(async (tx) => {
    const stop = await tx.query.pickupStops.findFirst({ where: eq(pickupStops.id, stopId) });
    if (!stop) throw new PickupError('not_found');
    const pickup = await lockPickup(tx, stop.pickupId);
    if (pickup.status === 'cancelled') throw new PickupError('cancelled');
    if ((await liveLinkedReceipts(tx, { stopId })).length) throw new PickupError('stop_linked');
    await assertClientsExist(tx, lines.map((l) => l.clientId));
    await tx.delete(pickupLines).where(eq(pickupLines.stopId, stopId));
    if (lines.length) await tx.insert(pickupLines).values(lines.map((l) => lineRow(stopId, l)));
    await writeAudit(tx, ctx, {
      entityType: 'pickup',
      entityId: stop.pickupId,
      action: 'update',
      after: { stopLines: stopId, lines: lines.length },
    });
  });
}

/** The kind of the client notice this module writes (client_notices.kind). */
export const NOTICE_PICKED_UP = 'picked_up';

/**
 * «Olindi» — the truck LEFT this factory with the cargo (B2: the factory's
 * count is exact, the driver recounts). ONE press: the UPDATE carries
 * `collected_at IS NULL`, so a double tap or two logists at once record it
 * once. The first press puts the trip on the road.
 *
 * Every client with cargo on this stop is told — one `client_notices` row
 * each, claimed in THIS transaction (a rolled-back press must not leave a
 * message behind) and sent by the same drain as «yukingiz keldi», with its
 * claim, deadline and retries. Only for a client whose cargo from this stop
 * has not already been received (a late press after the prixod exists must
 * not tell them something older than what they know), and nobody for a
 * marking-only line — a marking is not a person.
 */
export async function collectStop(
  stopId: string,
  input: { driverBoxes?: Record<string, number | null>; stampNote?: string | null },
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId) throw new PickupError('unauthenticated');
  await db.transaction(async (tx) => {
    const stop = await tx.query.pickupStops.findFirst({ where: eq(pickupStops.id, stopId) });
    if (!stop) throw new PickupError('not_found');
    const pickup = await lockPickup(tx, stop.pickupId);
    if (pickup.status === 'cancelled') throw new PickupError('cancelled');
    const now = new Date();
    const claimed = await tx
      .update(pickupStops)
      .set({ collectedAt: now, collectedBy: ctx.actorId, stampNote: input.stampNote?.trim() || null })
      .where(and(eq(pickupStops.id, stopId), isNull(pickupStops.collectedAt)))
      .returning({ id: pickupStops.id });
    if (!claimed.length) throw new PickupError('already_collected');

    const lines = await tx.select().from(pickupLines).where(eq(pickupLines.stopId, stopId));
    for (const line of lines) {
      const recount = input.driverBoxes?.[line.id];
      if (recount === undefined) continue;
      if (recount !== null && (!Number.isInteger(recount) || recount <= 0 || recount > 100_000)) {
        throw new PickupError('bad_number');
      }
      await tx.update(pickupLines).set({ driverBoxes: recount }).where(eq(pickupLines.id, line.id));
    }

    if (pickup.status === 'planned') {
      await tx
        .update(pickups)
        .set({ status: 'on_road', startedAt: pickup.startedAt ?? now, updatedAt: now })
        .where(eq(pickups.id, pickup.id));
    }

    const received = new Set(
      (
        await tx
          .select({ clientId: receipts.clientId })
          .from(receipts)
          .where(and(eq(receipts.pickupStopId, stopId), isNull(receipts.voidedAt)))
      ).map((r) => r.clientId),
    );
    const clientIds = [...new Set(lines.map((l) => l.clientId).filter((v): v is string => Boolean(v)))];
    for (const clientId of clientIds) {
      if (received.has(clientId)) continue;
      await tx
        .insert(clientNotices)
        .values({ clientId, kind: NOTICE_PICKED_UP, refType: 'pickup_stop', refId: stopId, sendAfter: now, claimedBy: ctx.actorId })
        .onConflictDoNothing();
    }

    await writeAudit(tx, { ...ctx, warehouseId: pickup.destWarehouseId }, {
      entityType: 'pickup',
      entityId: pickup.id,
      action: 'status_change',
      after: { collected: stopId, driverBoxes: input.driverBoxes ?? null },
    });
  });
}

/** «Yetib keldi» by hand — the first linked prixod does the same by itself. */
export async function markArrived(pickupId: string, ctx: AuditContext): Promise<void> {
  await db.transaction(async (tx) => {
    const pickup = await lockPickup(tx, pickupId);
    if (pickup.status === 'cancelled') throw new PickupError('cancelled');
    if (pickup.status === 'arrived') return;
    await arriveInTx(tx, pickup.id);
    await writeAudit(tx, ctx, { entityType: 'pickup', entityId: pickupId, action: 'status_change', after: { status: 'arrived' } });
  });
}

/** Forward only: planned/on_road → arrived. No state here ever goes back. */
async function arriveInTx(tx: Tx, pickupId: string) {
  await tx
    .update(pickups)
    .set({ status: 'arrived', arrivedAt: sql`coalesce(${pickups.arrivedAt}, now())`, updatedAt: new Date() })
    .where(and(eq(pickups.id, pickupId), inArray(pickups.status, ['planned', 'on_road'])));
}

/**
 * Cancel a trip. Refused while money or cargo hangs off it (#288's rule, the
 * batch cancel's): a live cost is finance's to void on the card, a linked
 * prixod is received cargo that belongs somewhere. A cancel after «Olindi»
 * tells clients nothing further, and a message still queued is skipped by
 * the sender, which re-reads the trip.
 */
export async function cancelPickup(pickupId: string, reason: string, ctx: AuditContext): Promise<void> {
  if (reason.trim().length < 3) throw new PickupError('reason_required');
  await db.transaction(async (tx) => {
    const pickup = await lockPickup(tx, pickupId);
    if (pickup.status === 'cancelled') return;
    const [cost] = await tx
      .select({ id: costEntries.id })
      .from(costEntries)
      .where(and(eq(costEntries.pickupId, pickupId), isNull(costEntries.voidedAt)))
      .limit(1);
    if (cost) throw new PickupError('pickup_has_costs');
    if ((await liveLinkedReceipts(tx, { pickupId })).length) throw new PickupError('pickup_has_receipts');
    await tx
      .update(pickups)
      // `::text` on the bound reason: postgres cannot infer a parameter's
      // type inside concat_ws's variadic list, and without it the cancel was
      // a 500 — found by the e2e, the one test that pressed it for real.
      .set({ status: 'cancelled', cancelledAt: new Date(), note: sql`concat_ws(E'\n', ${pickups.note}, ${`✖ ${reason.trim()}`}::text)`, updatedAt: new Date() })
      .where(eq(pickups.id, pickupId));
    await writeAudit(tx, ctx, { entityType: 'pickup', entityId: pickupId, action: 'void', after: { reason } });
  });
}

/**
 * Re-split every live cost of one trip. After the commit of whatever moved
 * its base — a prixod linked, unlinked, voided, annulled or corrected — and
 * nightly as the repair (jobs/cost-recompute.ts). Never inside a
 * transaction: the engine reads settings and rates on the pool (#714).
 */
export async function recomputePickupCosts(pickupId: string | null | undefined): Promise<void> {
  if (!pickupId) return;
  const { recomputeAll } = await import('../costing/service');
  await recomputeAll({ pickupId }).catch((err) =>
    console.error('[pickup] cost recompute failed', pickupId, err),
  );
}

export async function pickupIdOfStop(stopId: string | null | undefined): Promise<string | null> {
  if (!stopId) return null;
  const row = await db.query.pickupStops.findFirst({
    where: eq(pickupStops.id, stopId),
    columns: { pickupId: true },
  });
  return row?.pickupId ?? null;
}

/**
 * The receive door's check, on the CALLER's transaction (`confirmReceipt`
 * runs it inside its own — a pool read there is #714's freeze): the stop
 * exists, its truck is live and it is heading to THIS warehouse.
 */
export async function assertStopReceivable(tx: Tx, stopId: string, warehouseId: string): Promise<string> {
  const [row] = await tx
    .select({ pickupId: pickups.id, dest: pickups.destWarehouseId, status: pickups.status })
    .from(pickupStops)
    .innerJoin(pickups, eq(pickupStops.pickupId, pickups.id))
    .where(eq(pickupStops.id, stopId));
  if (!row) throw new PickupError('stop_not_found');
  if (row.status === 'cancelled') throw new PickupError('cancelled');
  if (row.dest !== warehouseId) throw new PickupError('wrong_warehouse');
  return row.pickupId;
}

/** Called by `confirmReceipt` in its transaction once the receipt row exists. */
export async function arriveOnReceipt(tx: Tx, pickupId: string): Promise<void> {
  await arriveInTx(tx, pickupId);
}

/**
 * Attach a prixod to a stop, or detach it (`stopId` null). The door is the
 * receipt card's «Zavod reysi» control and the pickup card's candidate
 * buttons; the gate (costs.enter_batch at the receipt's warehouse) is the
 * action's, because this moves the truck's money. Both trips — the one it
 * leaves and the one it joins — are re-split after the commit.
 */
export async function linkReceiptToStop(
  receiptId: string,
  stopId: string | null,
  ctx: AuditContext,
): Promise<void> {
  const { before, after } = await db.transaction(async (tx) => {
    const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for('update');
    if (!receipt) throw new PickupError('receipt_not_found');
    if (receipt.voidedAt || receipt.status !== 'confirmed') throw new PickupError('receipt_not_live');
    const beforePickup = receipt.pickupStopId
      ? ((
          await tx
            .select({ id: pickupStops.pickupId })
            .from(pickupStops)
            .where(eq(pickupStops.id, receipt.pickupStopId))
        )[0]?.id ?? null)
      : null;
    let afterPickup: string | null = null;
    if (stopId) {
      afterPickup = await assertStopReceivable(tx, stopId, receipt.warehouseId);
      await arriveInTx(tx, afterPickup);
    }
    if (receipt.pickupStopId === stopId) return { before: null, after: null };
    await tx.update(receipts).set({ pickupStopId: stopId }).where(eq(receipts.id, receiptId));
    await writeAudit(tx, { ...ctx, warehouseId: receipt.warehouseId }, {
      entityType: 'receipt',
      entityId: receiptId,
      action: 'update',
      before: { pickupStopId: receipt.pickupStopId },
      after: { pickupStopId: stopId },
    });
    return { before: beforePickup, after: afterPickup };
  });
  await recomputePickupCosts(before);
  if (after !== before) await recomputePickupCosts(after);
}

// ---------------------------------------------------------------------------
// The road (D1)
// ---------------------------------------------------------------------------

const keyOf = (from: LngLat, to: LngLat) =>
  [from[0], from[1], to[0], to[1]].map((v) => v.toFixed(4)).join(',');

/**
 * Fetch (or draw straight) every leg whose endpoints changed. Endpoints are
 * the stop factories in order, then the destination warehouse through the
 * SAME resolver /map uses. A factory with no point ends the road there — the
 * leg into it and out of it are cleared, never guessed.
 *
 * Outside any transaction and after the save that caused it (#714); each
 * write is guarded by the factory it was fetched for, so a stop re-pointed
 * while the router was answering keeps the newer truth.
 */
export async function refreshLegs(pickupId: string): Promise<void> {
  try {
    const pickup = await db.query.pickups.findFirst({ where: eq(pickups.id, pickupId) });
    if (!pickup || pickup.status === 'cancelled') return;
    const dest = await db.query.warehouses.findFirst({ where: eq(warehouses.id, pickup.destWarehouseId) });
    const destPoint = dest ? warehousePoint(dest) : null;
    const stops = await db
      .select({ stop: pickupStops, lat: factories.lat, lon: factories.lon })
      .from(pickupStops)
      .innerJoin(factories, eq(pickupStops.factoryId, factories.id))
      .where(eq(pickupStops.pickupId, pickupId))
      .orderBy(asc(pickupStops.seq));
    const points: (LngLat | null)[] = stops.map((s) =>
      s.lat !== null && s.lon !== null ? [Number(s.lon), Number(s.lat)] : null,
    );
    for (let i = 0; i < stops.length; i += 1) {
      const { stop } = stops[i]!;
      const from = points[i];
      const to = i + 1 < stops.length ? points[i + 1] : destPoint ? ([destPoint.x, destPoint.y] as LngLat) : null;
      if (!from || !to) {
        if (stop.legKey !== null) {
          await db
            .update(pickupStops)
            .set({ legPoints: null, legHours: null, legSource: null, legKey: null })
            .where(and(eq(pickupStops.id, stop.id), eq(pickupStops.factoryId, stop.factoryId)));
        }
        continue;
      }
      const key = keyOf(from, to);
      if (stop.legKey === key && stop.legPoints) continue;
      const leg = await fetchLeg(from, to);
      await db
        .update(pickupStops)
        .set({ legPoints: leg.points, legHours: leg.hours.toFixed(2), legSource: leg.source, legKey: key })
        .where(and(eq(pickupStops.id, stop.id), eq(pickupStops.factoryId, stop.factoryId)));
    }
  } catch (err) {
    // A road is an improvement to the drawing and never a reason a save fails.
    console.error('[pickup] leg refresh failed', pickupId, err);
  }
}

async function refreshLegsForFactory(factoryId: string): Promise<void> {
  const trips = await db
    .selectDistinct({ id: pickupStops.pickupId })
    .from(pickupStops)
    .innerJoin(pickups, eq(pickupStops.pickupId, pickups.id))
    .where(and(eq(pickupStops.factoryId, factoryId), ne(pickups.status, 'cancelled')));
  for (const trip of trips) await refreshLegs(trip.id);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface PickupLineView {
  id: string;
  clientId: string | null;
  clientCode: string | null;
  clientName: string | null;
  marking: string | null;
  goods: string;
  factoryBoxes: number;
  driverBoxes: number | null;
  volumeM3: number | null;
  weightKg: number | null;
  note: string | null;
  /** Live prixods from this stop for this line's owner. */
  receipts: { id: string; number: string | null }[];
}

export interface PickupStopView {
  id: string;
  seq: number;
  factory: typeof factories.$inferSelect;
  collectedAt: Date | null;
  collectedByName: string | null;
  stampNote: string | null;
  legPoints: [number, number][] | null;
  legHours: number | null;
  legSource: string | null;
  lines: PickupLineView[];
  /** Every prixod linked to this stop, live or voided (a voided one is history). */
  receipts: { id: string; number: string | null; clientCode: string | null; voided: boolean }[];
}

/** Does a line's owner match a prixod's? The client, or the marking as written. */
export function lineOwnerMatches(
  line: { clientId: string | null; marking: string | null },
  receipt: { clientId: string | null; unclaimedMarking: string | null },
): boolean {
  if (line.clientId) return receipt.clientId === line.clientId;
  return (
    !receipt.clientId &&
    Boolean(line.marking) &&
    (receipt.unclaimedMarking ?? '').trim().toLowerCase() === line.marking!.trim().toLowerCase()
  );
}

async function stopsFor(pickupIds: string[]): Promise<Map<string, PickupStopView[]>> {
  const out = new Map<string, PickupStopView[]>();
  if (!pickupIds.length) return out;
  const stopRows = await db
    .select({ stop: pickupStops, factory: factories, collectedByName: users.fullName })
    .from(pickupStops)
    .innerJoin(factories, eq(pickupStops.factoryId, factories.id))
    .leftJoin(users, eq(pickupStops.collectedBy, users.id))
    .where(inArray(pickupStops.pickupId, pickupIds))
    .orderBy(asc(pickupStops.pickupId), asc(pickupStops.seq));
  const stopIds = stopRows.map((r) => r.stop.id);
  const lineRows = stopIds.length
    ? await db
        .select({ line: pickupLines, clientCode: clients.clientCode, clientName: clients.name })
        .from(pickupLines)
        .leftJoin(clients, eq(pickupLines.clientId, clients.id))
        .where(inArray(pickupLines.stopId, stopIds))
        .orderBy(asc(pickupLines.createdAt), asc(pickupLines.id))
    : [];
  const receiptRows = stopIds.length
    ? await db
        .select({
          id: receipts.id,
          number: receipts.number,
          stopId: receipts.pickupStopId,
          clientId: receipts.clientId,
          unclaimedMarking: receipts.unclaimedMarking,
          voidedAt: receipts.voidedAt,
          clientCode: clients.clientCode,
        })
        .from(receipts)
        .leftJoin(clients, eq(receipts.clientId, clients.id))
        .where(inArray(receipts.pickupStopId, stopIds))
        .orderBy(asc(receipts.confirmedAt))
    : [];
  for (const { stop, factory, collectedByName } of stopRows) {
    const linked = receiptRows.filter((r) => r.stopId === stop.id);
    const live = linked.filter((r) => !r.voidedAt);
    const view: PickupStopView = {
      id: stop.id,
      seq: stop.seq,
      factory,
      collectedAt: stop.collectedAt,
      collectedByName,
      stampNote: stop.stampNote,
      legPoints: stop.legPoints ?? null,
      legHours: stop.legHours === null ? null : Number(stop.legHours),
      legSource: stop.legSource,
      lines: lineRows
        .filter((r) => r.line.stopId === stop.id)
        .map(({ line, clientCode, clientName }) => ({
          id: line.id,
          clientId: line.clientId,
          clientCode,
          clientName,
          marking: line.marking,
          goods: line.goods,
          factoryBoxes: line.factoryBoxes,
          driverBoxes: line.driverBoxes,
          volumeM3: line.volumeM3 === null ? null : Number(line.volumeM3),
          weightKg: line.weightKg === null ? null : Number(line.weightKg),
          note: line.note,
          receipts: live.filter((r) => lineOwnerMatches(line, r)).map((r) => ({ id: r.id, number: r.number })),
        })),
      receipts: linked.map((r) => ({ id: r.id, number: r.number, clientCode: r.clientCode, voided: Boolean(r.voidedAt) })),
    };
    const list = out.get(stop.pickupId) ?? [];
    list.push(view);
    out.set(stop.pickupId, list);
  }
  return out;
}

export interface PickupListRow {
  pickup: typeof pickups.$inferSelect;
  destCode: string;
  destName: string;
  stops: PickupStopView[];
  liveCostCount: number;
}

/** The /zavod list — live trips first, newest first; a finished month is paged by status. */
export async function listPickups(opts: { status?: 'live' | 'arrived' | 'cancelled' | 'all' } = {}) {
  const status = opts.status ?? 'live';
  const rows = await db
    .select({
      pickup: pickups,
      destCode: warehouses.code,
      destName: warehouses.name,
      liveCostCount: sql<number>`(SELECT count(*)::int FROM cost_entries ce WHERE ce.pickup_id = ${pickups}.id AND ce.voided_at IS NULL)`,
    })
    .from(pickups)
    .innerJoin(warehouses, eq(pickups.destWarehouseId, warehouses.id))
    .where(
      status === 'live'
        ? inArray(pickups.status, ['planned', 'on_road'])
        : status === 'all'
          ? undefined
          : eq(pickups.status, status),
    )
    .orderBy(desc(pickups.createdAt))
    .limit(200);
  const stops = await stopsFor(rows.map((r) => r.pickup.id));
  return rows.map<PickupListRow>((r) => ({
    ...r,
    liveCostCount: Number(r.liveCostCount),
    stops: stops.get(r.pickup.id) ?? [],
  }));
}

export async function loadPickup(pickupId: string) {
  const [row] = await db
    .select({ pickup: pickups, dest: warehouses, createdByName: users.fullName })
    .from(pickups)
    .innerJoin(warehouses, eq(pickups.destWarehouseId, warehouses.id))
    .leftJoin(users, eq(pickups.createdBy, users.id))
    .where(eq(pickups.id, pickupId));
  if (!row) return null;
  const stops = (await stopsFor([pickupId])).get(pickupId) ?? [];
  return { ...row, stops };
}

/**
 * Prixods that look like they came off this truck and are linked to nothing:
 * confirmed at its destination, for a client (or marking) on one of its
 * lines, on or after the first «olindi». Said aloud on the card — the logist
 * decides, nothing links itself (#809).
 */
export async function pickupCandidates(pickupId: string) {
  const pickup = await db.query.pickups.findFirst({ where: eq(pickups.id, pickupId) });
  if (!pickup || pickup.status === 'cancelled') return [];
  const stops = (await stopsFor([pickupId])).get(pickupId) ?? [];
  const firstCollect = stops
    .map((s) => s.collectedAt?.getTime())
    .filter((v): v is number => v !== undefined)
    .sort((a, b) => a - b)[0];
  if (firstCollect === undefined) return [];
  const lines = stops.flatMap((s) => s.lines);
  const clientIds = [...new Set(lines.map((l) => l.clientId).filter((v): v is string => Boolean(v)))];
  const markings = [...new Set(lines.map((l) => l.marking?.trim().toLowerCase()).filter((v): v is string => Boolean(v)))];
  if (!clientIds.length && !markings.length) return [];
  const rows = await db
    .select({
      id: receipts.id,
      number: receipts.number,
      clientId: receipts.clientId,
      clientCode: clients.clientCode,
      unclaimedMarking: receipts.unclaimedMarking,
      confirmedAt: receipts.confirmedAt,
    })
    .from(receipts)
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(
      and(
        eq(receipts.warehouseId, pickup.destWarehouseId),
        eq(receipts.status, 'confirmed'),
        isNull(receipts.voidedAt),
        isNull(receipts.pickupStopId),
        sql`${receipts.confirmedAt} >= ${new Date(firstCollect).toISOString()}::timestamptz`,
        sql`(${clientIds.length ? sql`${receipts.clientId} IN (${sql.join(clientIds.map((id) => sql`${id}`), sql`, `)})` : sql`false`}
             OR ${markings.length ? sql`(${receipts.clientId} IS NULL AND lower(trim(${receipts.unclaimedMarking})) IN (${sql.join(markings.map((m) => sql`${m}`), sql`, `)}))` : sql`false`})`,
      ),
    )
    .orderBy(asc(receipts.confirmedAt))
    .limit(50);
  return rows.map((r) => ({
    ...r,
    // Which stops could have brought it — the stop buttons the card offers.
    stops: stops
      .filter((s) => s.lines.some((l) => lineOwnerMatches(l, r)))
      .map((s) => ({ id: s.id, seq: s.seq, factoryName: s.factory.name })),
  }));
}

export interface IncomingOwner {
  stopId: string;
  /** `clientId`, or `m:<marking>` — the receive door's `c=` parameter. */
  ownerKey: string;
  clientId: string | null;
  clientCode: string | null;
  clientName: string | null;
  marking: string | null;
  lines: PickupLineView[];
}

export interface IncomingTruck {
  pickupId: string;
  code: string;
  status: string;
  destWarehouseId: string;
  vehiclePlate: string | null;
  driverName: string | null;
  driverPhone: string | null;
  stops: { id: string; seq: number; factoryName: string; collected: boolean; owners: IncomingOwner[] }[];
}

/**
 * «Zavoddan kelayotgan yuk» on /receive: live trips heading to these
 * warehouses, grouped truck → factory → owner, and only what has NOT been
 * received from it yet — so the list empties itself as the prixods land.
 */
export async function incomingForWarehouses(warehouseIds: string[]): Promise<IncomingTruck[]> {
  if (!warehouseIds.length) return [];
  const rows = await db
    .select()
    .from(pickups)
    .where(and(inArray(pickups.destWarehouseId, warehouseIds), inArray(pickups.status, ['planned', 'on_road', 'arrived'])))
    .orderBy(asc(pickups.createdAt))
    .limit(50);
  const stopsBy = await stopsFor(rows.map((r) => r.id));
  const out: IncomingTruck[] = [];
  for (const pickup of rows) {
    const stops = (stopsBy.get(pickup.id) ?? []).map((stop) => {
      const owners = new Map<string, IncomingOwner>();
      for (const line of stop.lines) {
        if (line.receipts.length) continue;
        const ownerKey = line.clientId ?? `m:${line.marking ?? ''}`;
        const owner = owners.get(ownerKey) ?? {
          stopId: stop.id,
          ownerKey,
          clientId: line.clientId,
          clientCode: line.clientCode,
          clientName: line.clientName,
          marking: line.marking,
          lines: [],
        };
        owner.lines.push(line);
        owners.set(ownerKey, owner);
      }
      return {
        id: stop.id,
        seq: stop.seq,
        factoryName: stop.factory.name,
        collected: Boolean(stop.collectedAt),
        owners: [...owners.values()],
      };
    });
    if (!stops.some((s) => s.owners.length)) continue;
    out.push({
      pickupId: pickup.id,
      code: pickup.code,
      status: pickup.status,
      destWarehouseId: pickup.destWarehouseId,
      vehiclePlate: pickup.vehiclePlate,
      driverName: pickup.driverName,
      driverPhone: pickup.driverPhone,
      stops,
    });
  }
  return out;
}

/** The receive door's prefill: this stop's un-received lines for one owner. */
export async function receivePrefillFor(stopId: string, ownerKey: string) {
  const [row] = await db
    .select({ stop: pickupStops, pickup: pickups, factoryName: factories.name, factoryPhone: factories.phone })
    .from(pickupStops)
    .innerJoin(pickups, eq(pickupStops.pickupId, pickups.id))
    .innerJoin(factories, eq(pickupStops.factoryId, factories.id))
    .where(eq(pickupStops.id, stopId));
  if (!row || row.pickup.status === 'cancelled') return null;
  const stop = ((await stopsFor([row.pickup.id])).get(row.pickup.id) ?? []).find((s) => s.id === stopId);
  if (!stop) return null;
  const isMarking = ownerKey.startsWith('m:');
  const lines = stop.lines.filter(
    (l) =>
      !l.receipts.length &&
      (isMarking
        ? !l.clientId && (l.marking ?? '').toLowerCase() === ownerKey.slice(2).toLowerCase()
        : l.clientId === ownerKey),
  );
  if (!lines.length) return null;
  return {
    stopId,
    pickupCode: row.pickup.code,
    warehouseId: row.pickup.destWarehouseId,
    factoryName: row.factoryName,
    clientId: isMarking ? null : ownerKey,
    clientCode: lines[0]!.clientCode,
    clientName: lines[0]!.clientName,
    marking: isMarking ? lines[0]!.marking : null,
    lines,
  };
}

/** The logist home's two counts: arrived with no cost, and trips with prixods to link. */
export async function pickupAttentionCounts(): Promise<{ noCost: number; unlinked: number }> {
  const [row] = await db.execute<{ no_cost: number; unlinked: number }>(sql`
    SELECT
      (SELECT count(*)::int FROM pickups p
        WHERE p.status = 'arrived'
          AND NOT EXISTS (SELECT 1 FROM cost_entries ce WHERE ce.pickup_id = p.id AND ce.voided_at IS NULL)) AS no_cost,
      (SELECT count(DISTINCT p.id)::int FROM pickups p
         JOIN pickup_stops ps ON ps.pickup_id = p.id
         JOIN pickup_lines pl ON pl.stop_id = ps.id
         JOIN receipts r ON r.warehouse_id = p.dest_warehouse_id
        WHERE p.status IN ('on_road', 'arrived')
          AND r.pickup_stop_id IS NULL AND r.voided_at IS NULL AND r.status = 'confirmed'
          AND r.confirmed_at >= (SELECT min(collected_at) FROM pickup_stops s2 WHERE s2.pickup_id = p.id)
          AND ((pl.client_id IS NOT NULL AND r.client_id = pl.client_id)
               OR (pl.client_id IS NULL AND r.client_id IS NULL
                   AND lower(trim(r.unclaimed_marking)) = lower(trim(pl.marking))))) AS unlinked
  `);
  return { noCost: Number(row?.no_cost ?? 0), unlinked: Number(row?.unlinked ?? 0) };
}

/**
 * The line form's owner box takes what a logist actually has — a client code
 * («GS777») or the marking painted on the carton when nobody has claimed it
 * yet. A code in the book wins; anything else is a marking, never refused:
 * the factory writes what it writes.
 */
export async function resolveLineOwners<T extends { owner: string }>(
  lines: T[],
): Promise<(Omit<T, 'owner'> & { clientId: string | null; marking: string })[]> {
  const codes = [...new Set(lines.map((l) => l.owner.trim().toUpperCase()).filter(Boolean))];
  const found = codes.length
    ? await db
        .select({ id: clients.id, code: clients.clientCode })
        .from(clients)
        .where(inArray(sql`upper(${clients.clientCode})`, codes))
    : [];
  const byCode = new Map(found.map((c) => [c.code.toUpperCase(), c.id]));
  return lines.map(({ owner, ...rest }) => {
    const clientId = byCode.get(owner.trim().toUpperCase()) ?? null;
    return { ...rest, clientId, marking: clientId ? '' : owner.trim() };
  });
}

/** What the receipt card says about the stop a prixod came from — «which factory, which phone». */
export async function receiptPickupInfo(stopId: string | null) {
  if (!stopId) return null;
  const [row] = await db
    .select({
      stopId: pickupStops.id,
      seq: pickupStops.seq,
      pickupId: pickups.id,
      code: pickups.code,
      factoryName: factories.name,
      factoryPhone: factories.phone,
      factoryWechat: factories.wechat,
    })
    .from(pickupStops)
    .innerJoin(pickups, eq(pickupStops.pickupId, pickups.id))
    .innerJoin(factories, eq(pickupStops.factoryId, factories.id))
    .where(eq(pickupStops.id, stopId));
  return row ?? null;
}

/**
 * The stops a prixod at this warehouse could be attached to: every stop of a
 * live trip heading here, newest trips first. Bounded — the picker is for
 * this month's trucks, and the card's own current stop is added by the page.
 */
export async function stopOptionsForWarehouse(warehouseId: string) {
  return db
    .select({
      stopId: pickupStops.id,
      seq: pickupStops.seq,
      code: pickups.code,
      factoryName: factories.name,
    })
    .from(pickupStops)
    .innerJoin(pickups, eq(pickupStops.pickupId, pickups.id))
    .innerJoin(factories, eq(pickupStops.factoryId, factories.id))
    .where(and(eq(pickups.destWarehouseId, warehouseId), ne(pickups.status, 'cancelled')))
    .orderBy(desc(pickups.createdAt), asc(pickupStops.seq))
    .limit(60);
}

/**
 * The trips /map draws: planned and on the road. An arrived truck is at the
 * warehouse and drawn as nothing but the warehouse's own dot; a cancelled
 * one is not a truck.
 */
export async function pickupsForMap() {
  const rows = await db
    .select({ pickup: pickups, destCode: warehouses.code, destActive: warehouses.active })
    .from(pickups)
    .innerJoin(warehouses, eq(pickups.destWarehouseId, warehouses.id))
    .where(inArray(pickups.status, ['planned', 'on_road']))
    .orderBy(desc(pickups.createdAt))
    .limit(40);
  const stops = await stopsFor(rows.map((r) => r.pickup.id));
  return rows.map((r) => ({ ...r, stops: stops.get(r.pickup.id) ?? [] }));
}
