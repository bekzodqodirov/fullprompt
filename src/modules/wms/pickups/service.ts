import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db, type Db, type Tx } from '../../platform/db/client';
import {
  clientNotices,
  clients,
  costEntries,
  factories,
  pickupLineReceipts,
  pickupLines,
  pickups,
  pickupStops,
  receipts,
  users,
  warehouses,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { inScope, type ScopedActor } from '../../platform/rbac/scope';
import { isServerBehind } from '../../platform/db/errors';
import { getSetting } from '../../platform/settings/service';
import { markingOfCode, markingOfCodeSql, ownerLooselyMatches, type OwnerSide } from './owner-match';
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
  constructor(
    public readonly code: string,
    /** What the sentence names — the trip's code for `shared_cost_orphaned`. */
    public readonly detail: string | null = null,
  ) {
    super(code);
  }
}

/**
 * Every state a trip can be in — the latest `pickups_status_check` and the
 * `pickups.status.*` keys in all four bundles are pinned to this list
 * (tests/unit/pickup-status.test.ts): a status nobody can name throws at
 * render time (#163).
 */
export const PICKUP_STATUSES = ['planned', 'on_road', 'arrived', 'closed', 'cancelled'] as const;
export type PickupStatus = (typeof PICKUP_STATUSES)[number];

/**
 * A trip that can still change: collected, received from, linked to, edited.
 * `closed` (0133, his 1a/2a) is terminal like `cancelled` and never reopens.
 */
export const OPEN_STATUSES = ['planned', 'on_road', 'arrived'] as const satisfies readonly PickupStatus[];

export function isOpenStatus(status: string): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}

/** Refuse any edit of a trip that is no longer open, by its own word. */
function assertOpen(status: string): void {
  if (status === 'cancelled') throw new PickupError('cancelled');
  if (status === 'closed') throw new PickupError('closed');
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

// ---------------------------------------------------------------------------
// What a prixod answers (0133)
// ---------------------------------------------------------------------------

/**
 * «This line is received»: a LIVE prixod answers it in `pickup_line_receipts`.
 * The one sentence every reader asks — the /receive list, its prefill, the
 * door question, the candidates, the home count, the auto-close and the
 * checker — instead of re-matching the owner's text on every read, which is
 * how a claimed marking or a voided prixod brought a finished trip back.
 *
 * `lineId` must be QUALIFIED by the caller (`sql\`pl.id\``): an unqualified
 * column inside this subquery would bind to its own `receipts` (#128).
 */
export function lineAnsweredSql(lineId: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM pickup_line_receipts plr
                       JOIN receipts plr_r ON plr_r.id = plr.receipt_id AND plr_r.voided_at IS NULL
                      WHERE plr.line_id = ${lineId})`;
}

const fold = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

/**
 * Which of a stop's lines a prixod's OWNER names — used ONLY to DERIVE what a
 * prixod answers when nobody chose, and to find candidates. ORDERED, never a
 * union: a prixod received under a marking keeps that marking after a client
 * claims it (#683), so a union made «3 MARK cartons, later claimed by A» answer
 * A's own 50-box line too and closed the trip on cargo still on the road (the
 * judge's blocker). The door's own identity wins:
 *
 *  1. the prixod's marking equals a MARKING line of this stop → those lines;
 *  2. otherwise → the CLIENT lines of the prixod's client.
 */
export function ownerLinesOf<L extends { clientId: string | null; marking: string | null }>(
  stopLines: L[],
  receipt: { clientId: string | null; unclaimedMarking: string | null },
): L[] {
  const mark = fold(receipt.unclaimedMarking);
  const byMarking = mark
    ? stopLines.filter((l) => !l.clientId && fold(l.marking) !== '' && fold(l.marking) === mark)
    : [];
  if (byMarking.length) return byMarking;
  return receipt.clientId ? stopLines.filter((l) => l.clientId === receipt.clientId) : [];
}

/**
 * `ownerLinesOf` in SQL for ONE line `line` of its own stop, over the
 * caller's aliases (pinned equal by a test over a stop holding both kinds).
 */
export function ownerMatchSql(line: string, receipt: string): SQL {
  const l = sql.raw(line);
  const r = sql.raw(receipt);
  return sql`(CASE WHEN EXISTS (SELECT 1 FROM pickup_lines ml
                                 WHERE ml.stop_id = ${l}.stop_id AND ml.client_id IS NULL
                                   AND btrim(coalesce(ml.marking, '')) <> ''
                                   AND lower(btrim(ml.marking)) = lower(btrim(${r}.unclaimed_marking)))
                THEN ${l}.client_id IS NULL
                     AND lower(btrim(coalesce(${l}.marking, ''))) = lower(btrim(${r}.unclaimed_marking))
                ELSE ${l}.client_id IS NOT NULL AND ${l}.client_id = ${r}.client_id
              END)`;
}

export interface LineOwner {
  clientId: string | null;
  /** The prixod's unclaimed marking (kept after a claim), else null. */
  marking: string | null;
}

/**
 * Write which lines of `stopId` the prixod answers — on the caller's
 * transaction, AFTER `assertStopReceivable` has locked the trip, so the
 * «already answered» read below cannot race another phone. Everything is
 * read through `tx`: this runs inside confirmReceipt and linkReceiptToStop,
 * and a pool read here is #714's freeze.
 *
 *  - Explicit ids (the wizard's lots — each lot names the line it is — and
 *    the card's per-line buttons): each must be a line of THIS stop. At the
 *    DOOR (`mode: 'door'`) none may already be answered — two operators
 *    receiving one line is the double receive the round exists to stop; on
 *    the card (`mode: 'card'`) a person at the money gate may add a second
 *    prixod to a line (one line delivered in two parts). A CLIENT line takes
 *    only that client's cargo (`assertLinesOwned`); a marking line received
 *    under the client it belongs to was answered by it.
 *  - No ids (an old phone bundle, a stale draft, the receipt card's select):
 *    the owner's lines (`ownerLinesOf`). Exactly ONE unanswered → that one.
 *    Several → none: which of two lines a prixod carried is a person's
 *    answer, never a guess (a partial prixod answering both closed the trip
 *    on cargo still at the factory); the card then offers the line buttons.
 *    None left → at the door the double receive (`line_answered`), on the
 *    card extra cargo from that factory, answering nothing.
 */
export async function answerLinesInTx(
  tx: Tx,
  input: {
    receiptId: string;
    stopId: string;
    lineIds?: string[] | null;
    owner: LineOwner;
    mode: 'door' | 'card';
    /** The door's «Bu qolgan qismi»: linked to the trip, answering nothing. */
    extra?: boolean;
  },
  actorId: string | null,
): Promise<string[]> {
  const lines = await tx
    .select({ id: pickupLines.id, clientId: pickupLines.clientId, marking: pickupLines.marking })
    .from(pickupLines)
    .where(eq(pickupLines.stopId, input.stopId));
  // A stop with no lines: nothing to answer, whatever a stale draft posts.
  if (!lines.length) return [];
  const answered = new Set(
    (
      await tx
        .select({ lineId: pickupLineReceipts.lineId })
        .from(pickupLineReceipts)
        .innerJoin(receipts, and(eq(receipts.id, pickupLineReceipts.receiptId), isNull(receipts.voidedAt)))
        .where(
          inArray(
            pickupLineReceipts.lineId,
            lines.map((l) => l.id),
          ),
        )
    ).map((r) => r.lineId),
  );
  let chosen: string[];
  // A line id that no longer exists ANYWHERE is a draft older than the
  // logist's last edit of the stop (an edit re-mints the lines): it is
  // dropped, and with none left the owner's lines are derived — a typo fix
  // on the card must not refuse the skladchi's photographed receipt. An id
  // that exists on ANOTHER stop is a forged or crossed post and is refused.
  let ids = input.lineIds?.length ? [...new Set(input.lineIds)] : [];
  if (ids.length) {
    const own = new Set(lines.map((l) => l.id));
    const foreign = ids.filter((id) => !own.has(id));
    if (foreign.length) {
      const existing = await tx.select({ id: pickupLines.id }).from(pickupLines).where(inArray(pickupLines.id, foreign));
      if (existing.length) throw new PickupError('line_not_on_stop');
      ids = ids.filter((id) => own.has(id));
    }
  }
  if (input.extra) {
    // «Bu qolgan qismi» (the door's own answer to `line_answered`): the
    // prixod rides the trip — its cartons carry the truck's cost — and
    // answers nothing, so it can never close a line twice.
    chosen = [];
  } else if (ids.length) {
    if (input.mode === 'door' && ids.some((id) => answered.has(id))) throw new PickupError('line_answered');
    await assertLinesOwned(
      tx,
      lines.filter((l) => ids.includes(l.id)),
      input.owner,
    );
    chosen = ids;
  } else {
    const mine = ownerLinesOf(lines, { clientId: input.owner.clientId, unclaimedMarking: input.owner.marking });
    const open = mine.filter((l) => !answered.has(l.id));
    if (input.mode === 'door' && mine.length && !open.length) throw new PickupError('line_answered');
    chosen = open.length === 1 ? [open[0]!.id] : [];
  }
  if (chosen.length) {
    await tx
      .insert(pickupLineReceipts)
      .values(chosen.map((lineId) => ({ lineId, receiptId: input.receiptId, createdBy: actorId })))
      .onConflictDoNothing();
  }
  return chosen;
}

/**
 * An explicit line choice (the door's ticks, the card's per-line button) is
 * the operator's word about WHICH line came — but a CLIENT line can only be
 * answered by that client's cargo (the judge's money-3): a ticked line kept
 * across a client switch would otherwise close another client's line, close
 * the trip for ever (2a) and move that client's truck share onto a stranger.
 * The cargo is the line client's when the prixod is that client's, or was
 * received under a marking that is that client's by the code-prefix
 * convention (`markingOfCode`). A MARKING line takes any owner — a marking
 * received under the client it belongs to was answered by it (probe S4).
 * On the caller's transaction (#714).
 */
async function assertLinesOwned(
  tx: Tx,
  chosen: { clientId: string | null }[],
  owner: LineOwner,
): Promise<void> {
  const foreign = [
    ...new Set(
      chosen.map((l) => l.clientId).filter((id): id is string => Boolean(id) && id !== owner.clientId),
    ),
  ];
  if (!foreign.length) return;
  const codes = await tx
    .select({ id: clients.id, code: clients.clientCode })
    .from(clients)
    .where(inArray(clients.id, foreign));
  const byId = new Map(codes.map((c) => [c.id, c.code]));
  if (foreign.some((id) => !markingOfCode(owner.marking, byId.get(id)))) throw new PickupError('line_owner_mismatch');
}

/**
 * His 1a, the automatic half: a trip whose every line a live prixod answers
 * is closed — in the transaction of the write that answered the last line,
 * with the trip already locked by it. A trip with no lines never closes by
 * itself (nothing to answer), and closed is terminal (his 2a): nothing here
 * or anywhere reopens it.
 */
export async function closeIfAnsweredInTx(tx: Tx, pickupId: string, ctx: AuditContext): Promise<boolean> {
  const closed = await tx.execute<{ id: string }>(sql`
    UPDATE pickups p
       SET status = 'closed', close_kind = 'auto', closed_at = now(),
           closed_by = ${ctx.actorId ?? null}, updated_at = now()
     WHERE p.id = ${pickupId}
       AND p.status IN ('planned', 'on_road', 'arrived')
       AND EXISTS (SELECT 1 FROM pickup_stops ps JOIN pickup_lines pl ON pl.stop_id = ps.id
                    WHERE ps.pickup_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM pickup_stops ps JOIN pickup_lines pl ON pl.stop_id = ps.id
                        WHERE ps.pickup_id = p.id AND NOT ${lineAnsweredSql(sql`pl.id`)})
    RETURNING p.id`);
  if (!closed.length) return false;
  await writeAudit(tx, ctx, {
    entityType: 'pickup',
    entityId: pickupId,
    action: 'status_change',
    after: { status: 'closed', closeKind: 'auto' },
  });
  return true;
}

async function liveCostExists(tx: Tx, pickupId: string): Promise<boolean> {
  const [cost] = await tx
    .select({ id: costEntries.id })
    .from(costEntries)
    .where(and(eq(costEntries.pickupId, pickupId), isNull(costEntries.voidedAt)))
    .limit(1);
  return Boolean(cost);
}

const closeText = (raw: string | null | undefined): string | null => {
  const text = (raw ?? '').trim();
  return text ? text : null;
};

/**
 * «Reysni yopish» — his 1a, the manual half: the logist finishes a trip whose
 * remaining lines will never come (the factory did not give them, the cargo
 * came on another truck), with a reason. The optional «Xarajat yo'q» (5a)
 * rides on the same press when the truck was paid somewhere else; it is a
 * money statement, so the ACTION says whether this person may make it.
 */
export async function closePickup(
  pickupId: string,
  input: { reason: string; noCostReason?: string | null },
  ctx: AuditContext,
  opts: { mayMarkNoCost: boolean },
): Promise<void> {
  if (!ctx.actorId) throw new PickupError('unauthenticated');
  const reason = closeText(input.reason);
  if (!reason || reason.length < 3) throw new PickupError('close_reason_required');
  if (reason.length > 500) throw new PickupError('validation');
  const noCost = input.noCostReason === undefined ? null : closeText(input.noCostReason);
  if (input.noCostReason !== undefined && input.noCostReason !== null && (!noCost || noCost.length < 3)) {
    throw new PickupError('no_cost_reason_required');
  }
  if (noCost && noCost.length > 500) throw new PickupError('validation');
  if (noCost && !opts.mayMarkNoCost) throw new PickupError('forbidden');
  await db.transaction(async (tx) => {
    const pickup = await lockPickup(tx, pickupId);
    if (pickup.status === 'closed') throw new PickupError('already_closed');
    assertOpen(pickup.status);
    if (noCost && (await liveCostExists(tx, pickupId))) throw new PickupError('has_costs');
    const now = new Date();
    await tx
      .update(pickups)
      .set({
        status: 'closed',
        closeKind: 'manual',
        closeReason: reason,
        closedAt: now,
        closedBy: ctx.actorId,
        ...(noCost && !pickup.noCostAt ? { noCostAt: now, noCostBy: ctx.actorId, noCostReason: noCost } : {}),
        updatedAt: now,
      })
      .where(eq(pickups.id, pickupId));
    await writeAudit(tx, { ...ctx, warehouseId: pickup.destWarehouseId }, {
      entityType: 'pickup',
      entityId: pickupId,
      action: 'status_change',
      before: { status: pickup.status },
      after: { status: 'closed', closeKind: 'manual', closeReason: reason, noCostReason: noCost },
    });
  });
}

/**
 * «Xarajat yo'q» on its own (5a): set with a reason, or cleared (null) by
 * whoever may enter the truck's cost — the ACTION asks that. Refused while a
 * live cost exists: a truck with a bill was not paid «somewhere else».
 */
export async function setPickupNoCost(pickupId: string, reason: string | null, ctx: AuditContext): Promise<void> {
  if (!ctx.actorId) throw new PickupError('unauthenticated');
  const text = closeText(reason);
  if (reason !== null && (!text || text.length < 3)) throw new PickupError('no_cost_reason_required');
  if (text && text.length > 500) throw new PickupError('validation');
  await db.transaction(async (tx) => {
    const pickup = await lockPickup(tx, pickupId);
    if (pickup.status === 'cancelled') throw new PickupError('cancelled');
    if (text && (await liveCostExists(tx, pickupId))) throw new PickupError('has_costs');
    await tx
      .update(pickups)
      .set(
        text
          ? { noCostAt: new Date(), noCostBy: ctx.actorId, noCostReason: text, updatedAt: new Date() }
          : { noCostAt: null, noCostBy: null, noCostReason: null, updatedAt: new Date() },
      )
      .where(eq(pickups.id, pickupId));
    await writeAudit(tx, { ...ctx, warehouseId: pickup.destWarehouseId }, {
      entityType: 'pickup',
      entityId: pickupId,
      action: 'update',
      before: { noCostReason: pickup.noCostReason },
      after: { noCostReason: text },
    });
  });
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
    // A CLOSED trip still takes the truck's own facts — the plate, the
    // driver, the note: the plate is often learned after the trip was
    // planned, and it is what names «this truck» on the agent's sheet (his
    // 6). Its destination and its date are history, and stay.
    if (pickup.status === 'closed') {
      if (input.destWarehouseId !== pickup.destWarehouseId || (input.plannedOn ?? null) !== (pickup.plannedOn ?? null)) {
        throw new PickupError('closed');
      }
    } else assertOpen(pickup.status);
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
    assertOpen(pickup.status);
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
    assertOpen(pickup.status);
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
    // The stop that went may have held the only unanswered line: what is
    // left is all received, and «by itself» (his 1a) means here too.
    await closeIfAnsweredInTx(tx, stop.pickupId, { ...ctx, warehouseId: pickup.destWarehouseId });
    return stop.pickupId;
  });
  await refreshLegs(pickupId);
}

/**
 * Replace a stop's lines. Refused once a LIVE prixod came from this stop —
 * the lines are what the receive door and the candidates list read, and
 * editing them under a received prixod would rewrite what was promised after
 * the fact. A VOIDED prixod's answers go with the lines they named (the FK
 * cascades): they answered nothing live, and a draft still holding an old
 * line id is refused `line_not_on_stop` in words.
 */
export async function saveStopLines(stopId: string, rawLines: LineInput[], ctx: AuditContext): Promise<void> {
  const lines = z.array(lineSchema).max(40).parse(rawLines);
  await db.transaction(async (tx) => {
    const stop = await tx.query.pickupStops.findFirst({ where: eq(pickupStops.id, stopId) });
    if (!stop) throw new PickupError('not_found');
    const pickup = await lockPickup(tx, stop.pickupId);
    assertOpen(pickup.status);
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
    // Removing the never-given line leaves the rest all received (his 1a).
    await closeIfAnsweredInTx(tx, stop.pickupId, { ...ctx, warehouseId: pickup.destWarehouseId });
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
    // A trip can close before «Olindi» — the warehouse received the whole
    // load at 10:00 and the logist presses at 18:00 with the driver's recount.
    // On a closed trip the press is a RECORD: the count and the stamp land,
    // the status does not move and nobody is told anything (the cargo is in).
    const closed = pickup.status === 'closed';
    if (!closed) assertOpen(pickup.status);
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

    // «Already received» for the CUSTOMER's message stays the client's own
    // fact — has «keldi» been said about cargo from this stop — and not the
    // line memory: the question is what the customer knows, not which line
    // a prixod answered.
    const received = new Set(
      (
        await tx
          .select({ clientId: receipts.clientId })
          .from(receipts)
          .where(and(eq(receipts.pickupStopId, stopId), isNull(receipts.voidedAt)))
      ).map((r) => r.clientId),
    );
    const clientIds = [...new Set(lines.map((l) => l.clientId).filter((v): v is string => Boolean(v)))];
    for (const clientId of closed ? [] : clientIds) {
      if (received.has(clientId)) continue;
      await tx
        .insert(clientNotices)
        .values({ clientId, kind: NOTICE_PICKED_UP, refType: 'pickup_stop', refId: stopId, sendAfter: now, claimedBy: ctx.actorId, staffNotifiedAt: now })
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
    assertOpen(pickup.status);
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
    // Closed is terminal (his 2a): a finished trip is history, not a mistake.
    if (pickup.status === 'closed') throw new PickupError('closed');
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
 * exists, its truck is OPEN and heading to THIS warehouse.
 *
 * It LOCKS the trip (FOR UPDATE): the lines it is about to answer are read
 * after it, so two phones receiving the same line wait on each other and the
 * second is told `line_answered` instead of making a second prixod of the
 * same cargo; and a close or a cancel that commits first is SEEN, not
 * overwritten. The trip is the first row either door locks — `confirmReceipt`
 * inserts a new receipt after it, and `linkReceiptToStop` locks its receipt
 * first but that receipt is one no confirm can be holding.
 */
/**
 * Lock the stop's trip and check a prixod may join it. At the DOOR (a
 * receive) the trip must be open — a closed trip takes no more cargo (his
 * 2a). From the CARD (a person at the money gate correcting a link) a closed
 * trip may be joined WITHOUT reopening it: otherwise a void-and-redo of its
 * prixod left the truck's freight on no carton for good, with no way back
 * (the judge's money finding).
 */
export async function assertStopReceivable(
  tx: Tx,
  stopId: string,
  warehouseId: string,
  mode: 'door' | 'card' = 'door',
): Promise<{ id: string; status: string }> {
  const [stop] = await tx
    .select({ pickupId: pickupStops.pickupId })
    .from(pickupStops)
    .where(eq(pickupStops.id, stopId));
  if (!stop) throw new PickupError('stop_not_found');
  const trip = await lockPickup(tx, stop.pickupId);
  if (!(mode === 'card' && trip.status === 'closed')) assertOpen(trip.status);
  if (trip.destWarehouseId !== warehouseId) throw new PickupError('wrong_warehouse');
  return { id: trip.id, status: trip.status };
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
 *
 * The lines the prixod answered go with it when it leaves (0133); joining,
 * it answers the stop's lines its owner matches (`answerLinesInTx`). A trip
 * it leaves stays as it is — a closed one stays closed (his 2a) — and a
 * CLOSED trip may be joined from here without reopening (the card's door,
 * `assertStopReceivable`'s 'card' mode).
 *
 * Leaving a CLOSED trip asks the void guard's question first (the judge's
 * money-1): if this prixod is the last cargo a live bill of that trip splits
 * over, the detach is refused (`shared_cost_orphaned`, naming the trip) —
 * nothing brings cargo to a closed trip by itself, so the freight would sit
 * on no carton. An OPEN trip keeps #1004's rule: more may still come.
 * Lock order: the receipt, then the trips in id order — and NO cost lock
 * here, because the void doors take receipt → costs → cartons → trip, and
 * a trip → cost order would be their deadlock pair; the trip lock alone
 * serialises a detach against a void, each re-reading the base after the
 * wait.
 */
export async function linkReceiptToStop(
  receiptId: string,
  stopId: string | null,
  ctx: AuditContext,
  lineIds?: string[] | null,
): Promise<void> {
  // On the pool, before the transaction (#714): the guard's splitter needs it.
  const factor = Number(await getSetting('chargeable_weight_factor'));
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
    // A press that already happened (two logists on one card) is a no-op,
    // decided BEFORE any lock or derive: the prixod's own rows would read as
    // «already answered» and refuse a link that succeeded.
    if (receipt.pickupStopId === stopId && !lineIds?.length) return { before: null, after: null };
    const targetPickup = stopId
      ? ((await tx.select({ id: pickupStops.pickupId }).from(pickupStops).where(eq(pickupStops.id, stopId)))[0]?.id ??
        null)
      : null;
    // Both trips locked in id order before anything is judged or written.
    const tripLocks = [...new Set([beforePickup, targetPickup].filter((id): id is string => Boolean(id)))].sort();
    const locked = new Map<string, Awaited<ReturnType<typeof lockPickup>>>();
    for (const id of tripLocks) locked.set(id, await lockPickup(tx, id));
    if (beforePickup && beforePickup !== targetPickup && locked.get(beforePickup)?.status === 'closed') {
      await refuseOrphaningDetach(beforePickup, receiptId, factor, tx);
    }
    // Leaving a stop takes the lines it answered with it; a per-line press on
    // the stop it is already on ADDS to them (the card's «this prixod is that
    // line»).
    if (receipt.pickupStopId && receipt.pickupStopId !== stopId) {
      await tx.delete(pickupLineReceipts).where(eq(pickupLineReceipts.receiptId, receiptId));
    }
    let afterPickup: string | null = null;
    let answered: string[] = [];
    if (stopId) {
      const trip = await assertStopReceivable(tx, stopId, receipt.warehouseId, 'card');
      afterPickup = trip.id;
      answered = await answerLinesInTx(
        tx,
        {
          receiptId,
          stopId,
          lineIds: lineIds ?? null,
          owner: { clientId: receipt.clientId, marking: receipt.unclaimedMarking },
          mode: 'card',
        },
        ctx.actorId ?? null,
      );
      if (trip.status !== 'closed') await arriveInTx(tx, afterPickup);
    }
    await tx.update(receipts).set({ pickupStopId: stopId }).where(eq(receipts.id, receiptId));
    await writeAudit(tx, { ...ctx, warehouseId: receipt.warehouseId }, {
      entityType: 'receipt',
      entityId: receiptId,
      action: 'update',
      before: { pickupStopId: receipt.pickupStopId },
      after: { pickupStopId: stopId, pickupLines: answered.length },
    });
    if (afterPickup) await closeIfAnsweredInTx(tx, afterPickup, { ...ctx, warehouseId: receipt.warehouseId });
    return { before: beforePickup, after: afterPickup };
  });
  await recomputePickupCosts(before);
  if (after !== before) await recomputePickupCosts(after);
}

/**
 * The detach half of the void guard (`costOrphanedByVoid`'s question, asked
 * by the one door that moves a prixod's cartons out of a trip's base without
 * voiding them): would a live, converted bill of this CLOSED trip go from
 * splitting over something to splitting over nothing once this prixod
 * leaves? Same base, same splitter (`costHomedOn`), on the caller's
 * transaction — the costs are read, never locked (see linkReceiptToStop).
 */
async function refuseOrphaningDetach(
  pickupId: string,
  receiptId: string,
  factor: number,
  tx: Db | Tx = db,
): Promise<void> {
  const bills = await tx
    .select()
    .from(costEntries)
    .where(and(eq(costEntries.pickupId, pickupId), isNull(costEntries.voidedAt), isNotNull(costEntries.amountUsd)));
  if (!bills.length) return;
  const { scopeBoxIds } = await import('../costing/service');
  const { costHomedOn } = await import('../costing/void-guard');
  const leaving = new Set(
    (
      await tx.execute<{ id: string }>(sql`
        SELECT b.id FROM boxes b JOIN receipt_lots rl ON rl.id = b.lot_id WHERE rl.receipt_id = ${receiptId}`)
    ).map((r) => r.id),
  );
  for (const bill of bills) {
    const base = await scopeBoxIds(bill, tx);
    if (!base.some((id) => leaving.has(id))) continue;
    if (!(await costHomedOn(bill, base, factor, tx))) continue;
    if (await costHomedOn(bill, base.filter((id) => !leaving.has(id)), factor, tx)) continue;
    const [trip] = await tx.select({ code: pickups.code }).from(pickups).where(eq(pickups.id, pickupId));
    throw new PickupError('shared_cost_orphaned', trip?.code ?? null);
  }
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
    // A finished trip's road is history: nothing draws or estimates it again.
    if (!pickup || !isOpenStatus(pickup.status)) return;
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
    .where(and(eq(pickupStops.factoryId, factoryId), inArray(pickups.status, [...OPEN_STATUSES])));
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
  /** The LIVE prixods that answer this line (0133's memory, never re-matched). */
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
  /**
   * Live prixods linked to this stop that answer NO line — extra cargo from
   * the factory, or cargo received under an owner no line names. Listed on
   * the card so a count nobody can see does not hide them.
   */
  unmatched: {
    id: string;
    number: string | null;
    clientCode: string | null;
    clientId: string | null;
    unclaimedMarking: string | null;
  }[];
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
  const lineIds = lineRows.map((r) => r.line.id);
  // One migration behind (0133 not applied yet) the memory table does not
  // exist: the screens read «nothing answered» rather than going down — the
  // writers refuse in words (`server_behind`) until `migrate` lands.
  const answerRows = lineIds.length
    ? await db
        .select({
          lineId: pickupLineReceipts.lineId,
          id: receipts.id,
          number: receipts.number,
          voidedAt: receipts.voidedAt,
        })
        .from(pickupLineReceipts)
        .innerJoin(receipts, eq(receipts.id, pickupLineReceipts.receiptId))
        .where(inArray(pickupLineReceipts.lineId, lineIds))
        .orderBy(asc(receipts.confirmedAt))
        .catch((err: unknown) => {
          if (isServerBehind(err)) return [];
          throw err;
        })
    : [];
  for (const { stop, factory, collectedByName } of stopRows) {
    const linked = receiptRows.filter((r) => r.stopId === stop.id);
    const stopLineIds = new Set(lineRows.filter((r) => r.line.stopId === stop.id).map((r) => r.line.id));
    const answering = new Set(answerRows.filter((a) => stopLineIds.has(a.lineId) && !a.voidedAt).map((a) => a.id));
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
          receipts: answerRows
            .filter((a) => a.lineId === line.id && !a.voidedAt)
            .map((a) => ({ id: a.id, number: a.number })),
        })),
      receipts: linked.map((r) => ({ id: r.id, number: r.number, clientCode: r.clientCode, voided: Boolean(r.voidedAt) })),
      unmatched: linked
        .filter((r) => !r.voidedAt && !answering.has(r.id))
        .map((r) => ({
          id: r.id,
          number: r.number,
          clientCode: r.clientCode,
          clientId: r.clientId,
          unclaimedMarking: r.unclaimedMarking,
        })),
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

/**
 * The /zavod list — newest first, by tab. «Yetib kelgan» is a trip that came and
 * is still OPEN (a line not received); finished trips are «Yopilgan».
 */
export type PickupListTab = 'live' | 'arrived' | 'closed' | 'xarajatsiz' | 'cancelled' | 'all';

/**
 * «Xarajat yo'q» is still owed: a trip that came (arrived or closed) with no
 * live cost and no «xarajat yo'q» mark (his 5a). One sentence for the list's
 * tab, the card's banner and the home row's count.
 */
export function noCostOwedSql(pickup: SQL): SQL {
  return sql`${pickup}.status IN ('arrived', 'closed') AND ${pickup}.no_cost_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM cost_entries ce WHERE ce.pickup_id = ${pickup}.id AND ce.voided_at IS NULL)`;
}

export async function listPickups(opts: { status?: PickupListTab } = {}) {
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
        : status === 'xarajatsiz'
          ? noCostOwedSql(sql`${pickups}`)
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
  // Who closed the trip and who marked «xarajat yo'q» are named on the card —
  // a manual close is a person's sentence and reads as one (his 1a).
  const closer = alias(users, 'closer');
  const marker = alias(users, 'no_cost_marker');
  const [row] = await db
    .select({
      pickup: pickups,
      dest: warehouses,
      createdByName: users.fullName,
      closedByName: closer.fullName,
      noCostByName: marker.fullName,
    })
    .from(pickups)
    .innerJoin(warehouses, eq(pickups.destWarehouseId, warehouses.id))
    .leftJoin(users, eq(pickups.createdBy, users.id))
    .leftJoin(closer, eq(pickups.closedBy, closer.id))
    .leftJoin(marker, eq(pickups.noCostBy, marker.id))
    .where(eq(pickups.id, pickupId));
  if (!row) return null;
  const stops = (await stopsFor([pickupId])).get(pickupId) ?? [];
  return { ...row, stops };
}

/**
 * A prixod that looks like it came off trip `p` and is linked to nothing —
 * over aliases `p` (pickups) and `r` (receipts). Confirmed at the trip's
 * destination on or after its first «olindi», live, unlinked, and its owner
 * matching a line of the trip that NO prixod has answered yet: once a line is
 * answered, every later cargo of that client is somebody else's question (an
 * old trip lit up by a new prixod months later was probe S5). One sentence
 * for the card's list and the logist's home count.
 */
/**
 * The skladchi answered «Yo'q» about this trip at the receive door — over
 * aliases `p` and `r`. Read off the receipt's create audit row (0133 stores
 * no column for it): the candidate stays listed on the card, SAYING so, and
 * leaves the home count — a floor fact the logist cannot see must not be
 * overridden by a one-tap «biriktirish» nobody questioned.
 */
export function declinedAtDoorSql(): SQL {
  return sql`EXISTS (SELECT 1 FROM audit_log a
                      WHERE a.entity_type = 'receipt' AND a.entity_id = r.id AND a.action = 'create'
                        AND EXISTS (SELECT 1 FROM pickup_stops s3
                                     WHERE s3.pickup_id = p.id
                                       AND jsonb_exists(coalesce(a.after -> 'pickupDeclined', '[]'::jsonb), s3.id::text)))`;
}

/**
 * May a person be shown line `line` as this prixod's — `ownerLooselyMatches`
 * in SQL over the caller's aliases: the exact owner, or the code-prefix
 * convention either way (a GS500 line for cargo received as «GS500MANIKEN»).
 * For the lists a PERSON reads (candidates, the door, the warnings) — never
 * for a derivation nobody looks at (`ownerMatchSql` stays exact).
 */
export function ownerLooselyMatchesSql(line: string, receipt: string): SQL {
  const l = sql.raw(line);
  const r = sql.raw(receipt);
  return sql`coalesce(CASE WHEN ${l}.client_id IS NOT NULL
      THEN ${l}.client_id = ${r}.client_id
           OR ${markingOfCodeSql(sql`${r}.unclaimed_marking`, sql`(SELECT lc.client_code FROM clients lc WHERE lc.id = ${l}.client_id)`)}
      ELSE (btrim(coalesce(${l}.marking, '')) <> ''
            AND lower(btrim(${l}.marking)) = lower(btrim(coalesce(${r}.unclaimed_marking, ''))))
           OR ${markingOfCodeSql(sql`${l}.marking`, sql`(SELECT rc.client_code FROM clients rc WHERE rc.id = ${r}.client_id)`)}
    END, false)`;
}

/**
 * The window opens at the trip's FIRST «Olindi», or — when nobody pressed it
 * (the driver forgot; the round's own probe) — at the trip's creation: a
 * prixod received off a trip nobody marked collected is still that trip's
 * candidate, where `min(collected_at)` alone was NULL and listed nothing.
 */
export function candidateReceiptSql(): SQL {
  return sql`r.status = 'confirmed' AND r.voided_at IS NULL AND r.pickup_stop_id IS NULL
    AND r.warehouse_id = p.dest_warehouse_id
    AND r.confirmed_at >= coalesce((SELECT min(s2.collected_at) FROM pickup_stops s2 WHERE s2.pickup_id = p.id),
                                   p.created_at)
    AND EXISTS (SELECT 1 FROM pickup_stops ps JOIN pickup_lines pl ON pl.stop_id = ps.id
                 WHERE ps.pickup_id = p.id
                   AND NOT ${lineAnsweredSql(sql`pl.id`)}
                   AND ${ownerLooselyMatchesSql('pl', 'r')})`;
}

/**
 * Prixods that look like they came off this truck and are linked to nothing
 * (`candidateReceiptSql`). Said aloud on the card — the logist decides,
 * nothing links itself (#809).
 */
export async function pickupCandidates(pickupId: string) {
  const pickup = await db.query.pickups.findFirst({ where: eq(pickups.id, pickupId) });
  // His 4a: only while the trip is open — a closed one owes nothing more.
  if (!pickup || !isOpenStatus(pickup.status)) return [];
  const stops = (await stopsFor([pickupId])).get(pickupId) ?? [];
  const rows = await db.execute<{
    id: string;
    number: string | null;
    client_id: string | null;
    client_code: string | null;
    unclaimed_marking: string | null;
    confirmed_at: string | null;
    declined: boolean;
  }>(sql`
    SELECT r.id, r.number, r.client_id, c.client_code, r.unclaimed_marking, r.confirmed_at,
           ${declinedAtDoorSql()} AS declined
      FROM pickups p
      JOIN receipts r ON r.warehouse_id = p.dest_warehouse_id
      LEFT JOIN clients c ON c.id = r.client_id
     WHERE p.id = ${pickupId}
       AND ${candidateReceiptSql()}
     ORDER BY r.confirmed_at
     LIMIT 50`);
  return rows.map((r) => {
    const receipt: OwnerSide = { clientId: r.client_id, clientCode: r.client_code, marking: r.unclaimed_marking };
    return {
      id: r.id,
      number: r.number,
      clientId: r.client_id,
      clientCode: r.client_code,
      unclaimedMarking: r.unclaimed_marking,
      // Raw `db.execute` hands timestamps back as TEXT.
      confirmedAt: r.confirmed_at ? new Date(r.confirmed_at) : null,
      declined: Boolean(r.declined),
      // Which stops could have brought it — a stop with an UNANSWERED line
      // this prixod's owner names (the code-prefix convention included). With
      // several such lines the card offers one button per LINE: which of them
      // came is a person's answer. With one, the button still POSTS that line
      // (`onlyLineId`): the server's own derivation is exact, so a prefix
      // match left to it would link the prixod and answer nothing.
      stops: stops
        .map((s) => ({
          s,
          open: s.lines.filter((l) => !l.receipts.length && ownerLooselyMatches(l, receipt)),
        }))
        .filter(({ open }) => open.length > 0)
        .map(({ s, open }) => ({
          id: s.id,
          seq: s.seq,
          factoryName: s.factory.name,
          lines: open.length > 1 ? open.map((l) => ({ id: l.id, goods: l.goods })) : [],
          onlyLineId: open.length === 1 ? open[0]!.id : null,
        })),
    };
  });
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
  /** This owner's prixods already received here OFF the trip (`lookalikesFor`). */
  lookalikes: Lookalike[];
}

/** A prixod that may already BE a line's cargo, received without the trip. */
export interface Lookalike {
  id: string;
  number: string | null;
  confirmedAt: Date | null;
  boxes: number;
}

/**
 * The double receive the trip's own list cannot see (the judge's intent-5,
 * probe S6 → S2): the cargo was received through the plain form, linked to
 * nothing, and the line still reads «waiting» — so «Qabul qilish» is pressed
 * again and the same cartons become a second prixod. Before anybody receives
 * a line, the door, the /receive row and the prefill say so: «GS777: P-201
 * (12.10, 30 📦) reysga biriktirilmagan — shu yukmi?».
 *
 * The SAME set the card's candidates are (`candidateReceiptSql` — unlinked,
 * live, at the trip's destination, inside its window, owner-matching an open
 * line), minus a prixod whose receiver already answered «Yo'q» about this
 * trip (`declinedAtDoorSql`): that was a person saying it is not. Matched to
 * a row by the lenient owner rule a person reads (`ownerLooselyMatches`).
 * Keyed by trip; the caller picks per stop/owner. Newest first, a handful.
 */
async function lookalikesFor(pickupIds: string[]): Promise<Map<string, (Lookalike & OwnerSide)[]>> {
  const out = new Map<string, (Lookalike & OwnerSide)[]>();
  if (!pickupIds.length) return out;
  const rows = await db.execute<{
    pickup_id: string;
    id: string;
    number: string | null;
    confirmed_at: string | null;
    client_id: string | null;
    client_code: string | null;
    unclaimed_marking: string | null;
    boxes: number;
  }>(sql`
    SELECT p.id AS pickup_id, r.id, r.number, r.confirmed_at, r.client_id, c.client_code, r.unclaimed_marking,
           (SELECT count(*)::int FROM boxes b JOIN receipt_lots rl ON rl.id = b.lot_id
             WHERE rl.receipt_id = r.id AND b.status <> 'void') AS boxes
      FROM pickups p
      JOIN receipts r ON r.warehouse_id = p.dest_warehouse_id
      LEFT JOIN clients c ON c.id = r.client_id
     WHERE p.id IN (${sql.join(
       pickupIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
       AND ${candidateReceiptSql()}
       AND NOT ${declinedAtDoorSql()}
     ORDER BY r.confirmed_at DESC
     LIMIT 200`);
  for (const r of rows) {
    const list = out.get(r.pickup_id) ?? [];
    list.push({
      id: r.id,
      number: r.number,
      // Raw `db.execute` hands timestamps back as TEXT.
      confirmedAt: r.confirmed_at ? new Date(r.confirmed_at) : null,
      boxes: Number(r.boxes),
      clientId: r.client_id,
      clientCode: r.client_code,
      marking: r.unclaimed_marking,
    });
    out.set(r.pickup_id, list);
  }
  return out;
}

/** The lookalikes of one row: those whose owner one of these lines is. */
function lookalikesOf(all: (Lookalike & OwnerSide)[] | undefined, lines: OwnerSide[]): Lookalike[] {
  return (all ?? [])
    .filter((r) => lines.some((l) => ownerLooselyMatches(l, r)))
    .slice(0, 3)
    .map(({ id, number, confirmedAt, boxes }) => ({ id, number, confirmedAt, boxes }));
}

export interface IncomingTruck {
  pickupId: string;
  code: string;
  status: string;
  destWarehouseId: string;
  vehiclePlate: string | null;
  driverName: string | null;
  driverPhone: string | null;
  /** Arrived in the last 48 h — the only thing that opens the /receive fold by itself. */
  freshArrival: boolean;
  stops: { id: string; seq: number; factoryName: string; collected: boolean; owners: IncomingOwner[] }[];
}

/**
 * «Zavoddan kelayotgan yuk» on /receive: live trips heading to these
 * warehouses, grouped truck → factory → owner, and only what has NOT been
 * received from it yet — so the list empties itself as the prixods land.
 */
/** An arrived trip still open after this many days is the logist's, not the floor's. */
export const INCOMING_STALE_DAYS = 14;

/**
 * An arrived trip left open past `INCOMING_STALE_DAYS` — a line the factory
 * never gave, a prixod received off the trip — over alias `p`. The logist's
 * home row counts it («N tasi yopilmagan»); /receive no longer lists it.
 */
export function staleOpenSql(pickup: SQL): SQL {
  return sql`${pickup}.status = 'arrived'
             AND coalesce(${pickup}.arrived_at, ${pickup}.created_at) <= now() - make_interval(days => ${INCOMING_STALE_DAYS})`;
}

export async function incomingForWarehouses(warehouseIds: string[]): Promise<IncomingTruck[]> {
  if (!warehouseIds.length) return [];
  // Open trips with a line nobody has answered yet — decided in SQL BEFORE the
  // cap. It used to read the oldest 50 trips and drop the finished ones after
  // the limit, so once 50 trips had come a NEW truck never reached this list
  // (probe S7). Newest first, and a trip that ARRIVED more than
  // `INCOMING_STALE_DAYS` ago leaves the warehouse's screen: what is still
  // unanswered on it is the logist's to close (his home row says so), not
  // a «Qabul qilish» the floor should keep pressing.
  const rows = await db
    .select()
    .from(pickups)
    .where(
      and(
        inArray(pickups.destWarehouseId, warehouseIds),
        inArray(pickups.status, [...OPEN_STATUSES]),
        sql`(${pickups}.status <> 'arrived' OR coalesce(${pickups}.arrived_at, ${pickups}.created_at)
               > now() - make_interval(days => ${INCOMING_STALE_DAYS}))`,
        sql`EXISTS (SELECT 1 FROM pickup_stops ps JOIN pickup_lines pl ON pl.stop_id = ps.id
                     WHERE ps.pickup_id = ${pickups}.id AND NOT ${lineAnsweredSql(sql`pl.id`)})`,
      ),
    )
    .orderBy(desc(pickups.createdAt))
    .limit(50);
  const stopsBy = await stopsFor(rows.map((r) => r.id));
  const lookalikes = await lookalikesFor(rows.map((r) => r.id));
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
          lookalikes: [],
        };
        owner.lines.push(line);
        owners.set(ownerKey, owner);
      }
      for (const owner of owners.values()) owner.lookalikes = lookalikesOf(lookalikes.get(pickup.id), owner.lines);
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
      freshArrival:
        pickup.status === 'arrived' && pickup.arrivedAt !== null && Date.now() - pickup.arrivedAt.getTime() < 48 * 3600 * 1000,
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
  // A finished trip offers nothing to receive (his 2a), even by a typed URL.
  if (!row || !isOpenStatus(row.pickup.status)) return null;
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
  const lookalikes = lookalikesOf((await lookalikesFor([row.pickup.id])).get(row.pickup.id), lines);
  return {
    stopId,
    lookalikes,
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

/**
 * A trip whose truck has a bill and no live cargo to carry it — a CLOSED
 * trip whose prixod was voided or detached. The money sits on no carton
 * until somebody links the replacement from the receipt card (the one door
 * that may join a closed trip). Over alias `p`.
 */
export function costWithoutCargoSql(pickup: SQL): SQL {
  return sql`${pickup}.status = 'closed'
             AND EXISTS (SELECT 1 FROM cost_entries ce WHERE ce.pickup_id = ${pickup}.id AND ce.voided_at IS NULL)
             AND NOT EXISTS (SELECT 1 FROM pickup_stops ps JOIN receipts r ON r.pickup_stop_id = ps.id
                              WHERE ps.pickup_id = ${pickup}.id AND r.voided_at IS NULL)`;
}

/**
 * The logist home's counts: trips whose cost is still owed
 * (`noCostOwedSql`), OPEN trips with a prixod to link (`candidateReceiptSql`
 * — the card's own list, so the two never disagree), and closed trips whose
 * bill carries no cargo (`costWithoutCargoSql`).
 */
export async function pickupAttentionCounts(): Promise<{
  noCost: number;
  unlinked: number;
  costNoCargo: number;
  staleOpen: number;
}> {
  const [row] = await db.execute<{ no_cost: number; unlinked: number; cost_no_cargo: number; stale_open: number }>(sql`
    SELECT
      (SELECT count(*)::int FROM pickups p WHERE ${noCostOwedSql(sql`p`)}) AS no_cost,
      (SELECT count(*)::int FROM pickups p
        WHERE p.status IN ('on_road', 'arrived')
          AND EXISTS (SELECT 1 FROM receipts r WHERE ${candidateReceiptSql()} AND NOT ${declinedAtDoorSql()})) AS unlinked,
      (SELECT count(*)::int FROM pickups p WHERE ${costWithoutCargoSql(sql`p`)}) AS cost_no_cargo,
      (SELECT count(*)::int FROM pickups p WHERE ${staleOpenSql(sql`p`)}) AS stale_open
  `);
  return {
    noCost: Number(row?.no_cost ?? 0),
    unlinked: Number(row?.unlinked ?? 0),
    costNoCargo: Number(row?.cost_no_cargo ?? 0),
    staleOpen: Number(row?.stale_open ?? 0),
  };
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
      status: pickups.status,
      vehiclePlate: pickups.vehiclePlate,
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
 * The stops a prixod at this warehouse could be attached to from its CARD:
 * every stop of an open trip heading here, plus trips CLOSED in the last 30
 * days — the card is the correction door (a void-and-redo must be able to
 * find its truck again; joining does not reopen it, his 2a). Newest first and
 * bounded; the card's own current stop is added by the page.
 */
export async function stopOptionsForWarehouse(warehouseId: string) {
  return db
    .select({
      stopId: pickupStops.id,
      seq: pickupStops.seq,
      code: pickups.code,
      status: pickups.status,
      factoryName: factories.name,
    })
    .from(pickupStops)
    .innerJoin(pickups, eq(pickupStops.pickupId, pickups.id))
    .innerJoin(factories, eq(pickupStops.factoryId, factories.id))
    .where(
      and(
        eq(pickups.destWarehouseId, warehouseId),
        sql`(${pickups}.status IN ('planned', 'on_road', 'arrived')
             OR (${pickups}.status = 'closed' AND ${pickups}.closed_at > now() - interval '30 days'))`,
      ),
    )
    .orderBy(desc(pickups.createdAt), asc(pickupStops.seq))
    .limit(60);
}

export interface OpenStopForOwner {
  pickupId: string;
  code: string;
  status: string;
  vehiclePlate: string | null;
  stopId: string;
  seq: number;
  factoryName: string;
  collected: boolean;
  lines: Pick<PickupLineView, 'id' | 'clientId' | 'goods' | 'factoryBoxes' | 'driverBoxes' | 'weightKg' | 'volumeM3'>[];
  /** This owner's prixods already received here OFF the trip (`lookalikesFor`). */
  lookalikes: Lookalike[];
}

/**
 * The receive door's question (his 3a, «Bu yuk ZR-… reysidan keldimi?»): the
 * COLLECTED stops of OPEN trips heading to this warehouse with lines of THIS
 * owner that no prixod has answered. Collected only: a client's courier
 * parcel on Monday must not be offered Wednesday's truck that has not left
 * the factory yet — a reflexive «Ha» would arrive it and could close it
 * before «Olindi» (the judge's floor finding). The «driver forgot Olindi»
 * case stays reachable through the /receive list and the logist's card. A
 * client by id; a marking as written (trimmed, case-folded — the line's own
 * identity). Newest trips first; at most ten.
 */
export async function openStopsForOwner(
  warehouseId: string,
  owner: { clientId: string } | { marking: string },
): Promise<OpenStopForOwner[]> {
  // The owner as a person reads it (`ownerLooselyMatches`): a client is also
  // asked about the marking lines its code begins («GS500MANIKEN» is
  // GS500's), a marking about the client lines whose code begins it — or the
  // cargo is received unlinked and the double receive waits one step later
  // (the judge's intent-7, round 98's #683 convention).
  const asked: OwnerSide =
    'clientId' in owner
      ? {
          clientId: owner.clientId,
          clientCode:
            (await db.select({ code: clients.clientCode }).from(clients).where(eq(clients.id, owner.clientId)))[0]
              ?.code ?? null,
          marking: null,
        }
      : { clientId: null, clientCode: null, marking: owner.marking };
  const ownerSql =
    'clientId' in owner
      ? sql`(pl.client_id = ${owner.clientId}
             OR (pl.client_id IS NULL AND ${markingOfCodeSql(sql`pl.marking`, sql`${asked.clientCode}::text`)}))`
      : sql`((pl.client_id IS NULL AND lower(btrim(pl.marking)) = lower(btrim(${owner.marking})))
             OR (pl.client_id IS NOT NULL
                 AND ${markingOfCodeSql(sql`${owner.marking}::text`, sql`(SELECT lc.client_code FROM clients lc WHERE lc.id = pl.client_id)`)}))`;
  const trips = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT p.id, p.created_at
      FROM pickups p
      JOIN pickup_stops ps ON ps.pickup_id = p.id
      JOIN pickup_lines pl ON pl.stop_id = ps.id
     WHERE p.dest_warehouse_id = ${warehouseId}
       AND p.status IN ('planned', 'on_road', 'arrived')
       AND ps.collected_at IS NOT NULL
       AND ${ownerSql}
       AND NOT ${lineAnsweredSql(sql`pl.id`)}
     ORDER BY p.created_at DESC
     LIMIT 10`);
  if (!trips.length) return [];
  const ids = trips.map((t) => t.id);
  const header = new Map(
    (await db.select().from(pickups).where(inArray(pickups.id, ids))).map((p) => [p.id, p]),
  );
  const stopsBy = await stopsFor(ids);
  const lookalikes = await lookalikesFor(ids);
  const wanted = (l: PickupLineView) => ownerLooselyMatches(l, asked);
  const out: OpenStopForOwner[] = [];
  for (const id of ids) {
    const trip = header.get(id);
    if (!trip) continue;
    for (const stop of stopsBy.get(id) ?? []) {
      if (!stop.collectedAt) continue;
      const lines = stop.lines.filter((l) => !l.receipts.length && wanted(l));
      if (!lines.length) continue;
      out.push({
        pickupId: trip.id,
        code: trip.code,
        status: trip.status,
        vehiclePlate: trip.vehiclePlate,
        stopId: stop.id,
        seq: stop.seq,
        factoryName: stop.factory.name,
        collected: Boolean(stop.collectedAt),
        lookalikes: lookalikesOf(lookalikes.get(trip.id), lines),
        lines: lines.map((l) => ({
          id: l.id,
          clientId: l.clientId,
          goods: l.goods,
          factoryBoxes: l.factoryBoxes,
          driverBoxes: l.driverBoxes,
          weightKg: l.weightKg,
          volumeM3: l.volumeM3,
        })),
      });
    }
  }
  return out.slice(0, 10);
}

/**
 * Why a «Qabul qilish» tap opened no prefill — said on the page instead of a
 * blank wizard (the judge's double-receive finding: a colleague received it a
 * minute ago, and a silent blank screen is how it gets received twice).
 */
export async function receivePrefillRefusal(stopId: string, ownerKey: string) {
  const [row] = await db
    .select({ status: pickups.status, code: pickups.code })
    .from(pickupStops)
    .innerJoin(pickups, eq(pickupStops.pickupId, pickups.id))
    .where(eq(pickupStops.id, stopId));
  if (!row) return null;
  if (row.status === 'closed' || row.status === 'cancelled') return { code: row.code, why: row.status, numbers: [] as string[] };
  const isMarking = ownerKey.startsWith('m:');
  const owner = isMarking
    ? sql`pl.client_id IS NULL AND lower(btrim(pl.marking)) = lower(btrim(${ownerKey.slice(2)}))`
    : sql`pl.client_id = ${ownerKey}`;
  if (!isMarking && !/^[0-9a-f-]{36}$/i.test(ownerKey)) return null;
  const answered = await db.execute<{ number: string | null }>(sql`
    SELECT DISTINCT r.number FROM pickup_lines pl
      JOIN pickup_line_receipts plr ON plr.line_id = pl.id
      JOIN receipts r ON r.id = plr.receipt_id AND r.voided_at IS NULL
     WHERE pl.stop_id = ${stopId} AND ${owner}`);
  return { code: row.code, why: 'received' as const, numbers: answered.map((a) => a.number ?? '').filter(Boolean) };
}

/**
 * What a restored /receive draft must know about the stop it carries before
 * anybody photographs six lots against it (the judge's stale-draft finding):
 * the trip's status and which of the stop's lines a LIVE prixod has answered.
 */
export async function stopReceivability(stopId: string) {
  const [row] = await db
    .select({ status: pickups.status, destWarehouseId: pickups.destWarehouseId, code: pickups.code })
    .from(pickupStops)
    .innerJoin(pickups, eq(pickupStops.pickupId, pickups.id))
    .where(eq(pickupStops.id, stopId));
  if (!row) return null;
  const answered = await db.execute<{ id: string }>(sql`
    SELECT pl.id FROM pickup_lines pl
     WHERE pl.stop_id = ${stopId} AND ${lineAnsweredSql(sql`pl.id`)}`);
  return { ...row, answered: answered.map((a) => a.id) };
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
