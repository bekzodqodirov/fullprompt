import { cache } from 'react';
import { aliasedTable, and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { auditLog, batches, boxMovements, boxes, receiptLots, users, warehouses } from '../../platform/db/schema';
import { writeAudit } from '../../platform/audit/service';
import { isUuidShaped } from '../../platform/audit/fields';
import { emitEvent } from '../../platform/events/service';
import type { Actor } from '../../platform/rbac/authorize';
import { inScope, type ScopedActor } from '../../platform/rbac/scope';
import { roundKg, roundM3, shareOf, sumRounded } from '../../platform/telegram/format';
import { setCountLockTimeout } from '../scanning/count-rules';
import { awaitingUnloadWhere } from '../scanning/unload';
import { isGenericRoute, pinOnRoute } from '../tracking/eta';
import { routeFor } from '../tracking/map-data';
import { countryKey } from './country-key';
import { lostThroughReroute, rerouteRefusal, type RerouteErrorCode } from './reroute-rules';

/*
 * «Yo'nalishni o'zgartirish» — the ONE writer of `batches.dest_warehouse_id`
 * after a truck exists (owner, 2026-09-30: «yo'lda qabul skladini
 * o'zgartirish», answers 1a 2a 3a 4a and 5 → its starred default «a»).
 *
 * What it writes is exactly the live destination, one audit row carrying the
 * typed reason, and one `BatchRerouted` event — nothing else on the truck
 * moves. Every reader that asks the live destination follows by itself (the
 * card door, the lists, /transit, /map, the homes, the ETA, the landing
 * status); the records that tell what HAPPENED are deliberately left alone:
 * the `batch_departed` movements (#121 — «Rejada» is read off them, and they
 * are written once), the approved plan's destination, `batches.type` (two
 * writers that disagree and no reader), the «where is it» pin (`checkpoint.ts`
 * stays its one writer; an off-route pin is simply not drawn), and
 * `sent_to_agent_at`. Money is untouched by construction: every money rule
 * reads the two ends' COUNTRIES, and the reroute never changes one.
 *
 * `tests/unit/batch-reroute-wire.test.ts` scans `src/` for every writer of the
 * column and demands exactly this file.
 */

export class RerouteError extends Error {
  constructor(readonly code: RerouteErrorCode) {
    super(code);
  }
}

export type RerouteActor = Pick<Actor, 'id' | 'fullName' | 'permissions' | 'warehouseScoped' | 'warehouseIds'>;

export interface RerouteResult {
  batchId: string;
  code: string;
  from: { id: string; code: string };
  to: { id: string; code: string };
  /** The truck's «where is it» pin is not on the new road, so it is not drawn (it is kept). */
  pinOffRoute: boolean;
  /** No described road between the origin and the new warehouse — no date anywhere. */
  noSchedule: boolean;
}

/**
 * What the new pair means before anybody presses — said on the form under
 * the option, and again on the success line. Pure: the same two questions
 * `scheduleEstimate` and the pin's reader ask.
 */
function consequencesOf(
  pin: unknown,
  originCode: string,
  target: { code: string; country: string | null },
): { pinOffRoute: boolean; noSchedule: boolean } {
  const pinned = !!pin && typeof (pin as { key?: unknown }).key === 'string';
  const route = routeFor(originCode, target.code);
  return {
    pinOffRoute: pinned && pinOnRoute(pin, originCode, target.code, target.country) === null,
    noSchedule: !route || isGenericRoute(route),
  };
}

/**
 * Change the receiving warehouse of a truck on the road.
 *
 * ONE transaction on the truck row under `FOR NO KEY UPDATE` — the lock the
 * phone's first unload scan, the office's count and «Tushirish tugadi» all
 * take — so a reroute and the first carton landing cannot both win: after
 * the first carton the truck is `arrived` and the reroute is refused, and a
 * scan waiting behind a reroute reads the new destination and refuses itself
 * (`landUnloadInput`'s locked re-read). A compare-and-set against the
 * destination the presser SAW: two logists or a stale tab answer
 * `dest_changed` instead of silently chaining «TAS1 → AND» into «TAS2 → AND».
 */
export async function rerouteBatch(
  actor: RerouteActor,
  batchId: string,
  input: { destWarehouseId: string; seenDestWarehouseId: string; reason: string },
  meta: { ip: string | null; userAgent: string | null },
): Promise<RerouteResult> {
  // Asked here too: this is the door a test can press (#531).
  if (!actor.permissions.has('plans.manage')) throw new RerouteError('forbidden');
  // Never cut: a reason is a person's sentence, and a cut one reads as a
  // different one.
  const reason = input.reason.trim().replace(/\s+/g, ' ');
  if (reason.length < 3) throw new RerouteError('reason_required');
  if (reason.length > 500) throw new RerouteError('reason_too_long');
  // A garbage id would reach postgres as a 22P02 and a white page (#472).
  if (!isUuidShaped(batchId)) throw new RerouteError('batch_not_found');
  if (!isUuidShaped(input.destWarehouseId)) throw new RerouteError('bad_target');
  // It can equal nothing, so the truck's destination has «changed» from it.
  if (!isUuidShaped(input.seenDestWarehouseId)) throw new RerouteError('dest_changed');

  // `tx` only inside, nothing pooled (#714).
  return db.transaction(async (tx) => {
    // A 200-carton count chunk holding the truck makes this wait; ten
    // seconds, then «busy, press again» in words.
    await setCountLockTimeout(tx);
    // NO KEY, so a phone's scan events on the truck (their foreign key takes
    // the key-share lock) are not blocked; it still conflicts with the pin's
    // FOR UPDATE and with every unload door's own NO KEY lock.
    const [batch] = await tx.select().from(batches).where(eq(batches.id, batchId)).for('no key update');
    if (!batch) throw new RerouteError('batch_not_found');
    if (!inScope(actor, batch.destWarehouseId)) throw new RerouteError('out_of_scope');
    if (batch.status !== 'in_transit') throw new RerouteError('not_in_transit');
    // The compare-and-set — `border-queue.ts`'s «changed» idiom.
    if (batch.destWarehouseId !== input.seenDestWarehouseId) throw new RerouteError('dest_changed');

    const ends = await tx
      .select({ id: warehouses.id, code: warehouses.code, country: warehouses.country })
      .from(warehouses)
      .where(inArray(warehouses.id, [batch.originWarehouseId, batch.destWarehouseId]));
    const origin = ends.find((w) => w.id === batch.originWarehouseId)!;
    const dest = ends.find((w) => w.id === batch.destWarehouseId)!;
    // FOR SHARE: «deactivate this warehouse» is a row UPDATE and waits for us,
    // so the target cannot turn inactive under a reroute that already read it
    // active. Lock order is truck → warehouse; nothing takes them the other way.
    const [target] = await tx
      .select({ id: warehouses.id, code: warehouses.code, country: warehouses.country, active: warehouses.active })
      .from(warehouses)
      .where(eq(warehouses.id, input.destWarehouseId))
      .for('share');
    const refusal = rerouteRefusal(
      { originWarehouseId: batch.originWarehouseId, destWarehouseId: batch.destWarehouseId, destCountry: dest.country },
      target ?? null,
    );
    if (refusal) throw new RerouteError(refusal);
    if (!inScope(actor, target!.id)) throw new RerouteError('out_of_scope');

    // The warehouse we are leaving was itself told «coming to you» by an
    // earlier reroute — it is told «not any more» (the design's objection:
    // a withdrawn promise must be withdrawn in words). Decided by the
    // RECORD, never by «it is not the planned warehouse»: that stand-in is
    // false exactly when the truck was sent BACK to the planned warehouse
    // (A → B → A → C), where the second reroute told A «endi sizga keladi»
    // and the third then left A with that promise standing. Read on `tx`
    // under the truck's lock, so every earlier reroute has committed.
    const [told] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(rerouteRowsOf([batchId]), sql`${auditLog.after}->>'destWarehouseId' = ${batch.destWarehouseId}`))
      .limit(1);
    const fromWasTold = told !== undefined;

    // What is coming, for the Telegram: the cargo still aboard, which on a
    // truck on the road is the whole cargo — `awaitingUnloadWhere` is the
    // «still on the truck» home (#513). Kilos and cubes by the one share rule.
    const lots = await tx
      .select({
        n: sql<number>`count(*)::int`,
        boxCount: receiptLots.boxCount,
        kg: receiptLots.totalWeightKg,
        m3: receiptLots.totalVolumeM3,
      })
      .from(boxes)
      .innerJoin(receiptLots, eq(receiptLots.id, boxes.lotId))
      .where(awaitingUnloadWhere([batchId]))
      .groupBy(receiptLots.id);
    const cartons = lots.reduce((acc, lot) => acc + Number(lot.n), 0);
    const kg = sumRounded(
      lots.map((lot) => shareOf(Number(lot.kg ?? 0), Number(lot.n), lot.boxCount)),
      roundKg,
    );
    const m3 = sumRounded(
      lots.map((lot) => shareOf(Number(lot.m3 ?? 0), Number(lot.n), lot.boxCount)),
      roundM3,
    );
    const { pinOffRoute, noSchedule } = consequencesOf(batch.trackingCheckpoint, origin.code, target!);

    // Drizzle, never raw SQL — the writer fence reads `.update(batches)`.
    // The WHERE repeats the compare-and-set: a belt, impossible under the lock.
    const moved = await tx
      .update(batches)
      .set({ destWarehouseId: target!.id, updatedAt: new Date() })
      .where(
        and(
          eq(batches.id, batchId),
          eq(batches.status, 'in_transit'),
          eq(batches.destWarehouseId, input.seenDestWarehouseId),
        ),
      )
      .returning({ id: batches.id });
    if (moved.length === 0) throw new RerouteError('dest_changed');

    // No new verb: the `destWarehouseId` key IS the marker the history and
    // the unload doors read, and this is its one writer.
    await writeAudit(
      tx,
      { actorId: actor.id, ip: meta.ip, userAgent: meta.userAgent, warehouseId: batch.originWarehouseId },
      {
        entityType: 'batch',
        entityId: batchId,
        action: 'update',
        before: { destWarehouseId: batch.destWarehouseId },
        after: { destWarehouseId: target!.id, reason },
      },
    );
    // In the transaction, so a crash cannot lose it; fanned out by the drain.
    await emitEvent(tx, {
      type: 'BatchRerouted',
      entityType: 'batch',
      entityId: batchId,
      actorId: actor.id,
      payload: {
        batchId,
        batchCode: batch.code,
        originWarehouseId: batch.originWarehouseId,
        originCode: origin.code,
        fromWarehouseId: batch.destWarehouseId,
        fromCode: dest.code,
        toWarehouseId: target!.id,
        toCode: target!.code,
        reason,
        presserId: actor.id,
        presserName: actor.fullName,
        cartons,
        kg,
        m3,
        plate: batch.vehiclePlate ?? null,
        fromWasTold,
      },
    });
    return {
      batchId,
      code: batch.code,
      from: { id: dest.id, code: dest.code },
      to: { id: target!.id, code: target!.code },
      pinOffRoute,
      noSchedule,
    };
  });
}

/** The reroute's own audit rows — its one writer's marker, nothing else writes it. */
function rerouteRowsOf(batchIds: string[]) {
  return and(
    eq(auditLog.entityType, 'batch'),
    batchIds.length === 1 ? eq(auditLog.entityId, batchIds[0]!) : inArray(auditLog.entityId, batchIds),
    eq(auditLog.action, 'update'),
    sql`${auditLog.after}->>'destWarehouseId' IS NOT NULL`,
  );
}

export interface RerouteRow {
  id: string;
  at: Date;
  who: string | null;
  fromCode: string | null;
  toCode: string | null;
  reason: string | null;
}

/**
 * Every change of this truck's receiving warehouse: who, when, from where,
 * to where and why — for every card reader, on the Mashina tab and in the
 * header's «Rejada» line.
 *
 * Ordered by the audit row's ID, never its `created_at`: the id is allocated
 * inside the reroute's transaction under the truck's lock, so it is commit
 * order, while `now()` is the transaction's START and two reroutes racing
 * would list inverted. Rides `audit_entity_idx`.
 */
export const rerouteHistory = cache(async function rerouteHistory(batchId: string): Promise<RerouteRow[]> {
  if (!isUuidShaped(batchId)) return [];
  const rrFrom = aliasedTable(warehouses, 'rr_from');
  const rrTo = aliasedTable(warehouses, 'rr_to');
  const rows = await db
    .select({
      id: auditLog.id,
      at: auditLog.createdAt,
      who: users.fullName,
      fromCode: rrFrom.code,
      toCode: rrTo.code,
      reason: sql<string | null>`${auditLog.after}->>'reason'`,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    // Compared as TEXT: a malformed value in a jsonb key is a row that names
    // no warehouse, never a failed cast that takes the card down.
    .leftJoin(rrFrom, sql`${rrFrom.id}::text = ${auditLog.before}->>'destWarehouseId'`)
    .leftJoin(rrTo, sql`${rrTo.id}::text = ${auditLog.after}->>'destWarehouseId'`)
    .where(rerouteRowsOf([batchId]))
    .orderBy(asc(auditLog.id));
  return rows.map((row) => ({ ...row, id: String(row.id) }));
});

/**
 * «Rejada» — the warehouse the truck was sent to on departure day, read off
 * the departure movements, which are written once and never rewritten. Null
 * on a truck that departed empty; the card then falls back to the first
 * reroute's «from».
 */
export const departureDestination = cache(async function departureDestination(
  batchId: string,
): Promise<{ id: string; code: string } | null> {
  if (!isUuidShaped(batchId)) return null;
  const [row] = await db
    .select({ id: warehouses.id, code: warehouses.code })
    .from(boxMovements)
    .innerJoin(warehouses, eq(warehouses.id, boxMovements.toWarehouseId))
    .where(
      and(
        eq(boxMovements.refType, 'batch'),
        eq(boxMovements.refId, batchId),
        eq(boxMovements.cause, 'batch_departed'),
      ),
    )
    .limit(1);
  return row ?? null;
});

/**
 * The warehouses each truck was heading to BEFORE a reroute — one query for
 * a whole sync body (the phone's partition asks it once for every truck it
 * refused), `/planned` and the unload page.
 */
export async function formerDestinationsFor(batchIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(batchIds.filter(isUuidShaped))];
  if (ids.length === 0) return out;
  const rows = await db
    .select({ batchId: auditLog.entityId, former: sql<string | null>`${auditLog.before}->>'destWarehouseId'` })
    .from(auditLog)
    .where(rerouteRowsOf(ids));
  for (const row of rows) {
    if (!row.former) continue;
    const list = out.get(row.batchId) ?? [];
    if (!list.includes(row.former)) list.push(row.former);
    out.set(row.batchId, list);
  }
  return out;
}

/**
 * Did this person lose the truck through a reroute — and if so, where does it
 * go now? The old destination's staff are told «endi {to} ga boradi» on the
 * unload page, by `/planned` (409) and by the sync, instead of «not your
 * warehouse / session expired, sign in again».
 */
export async function reroutedAwayFor(
  actor: ScopedActor & { permissions: ReadonlySet<string> },
  permission: string,
  batch: { id: string; destWarehouseId: string },
): Promise<{ toCode: string } | null> {
  const former = (await formerDestinationsFor([batch.id])).get(batch.id) ?? [];
  if (!lostThroughReroute(actor, permission, former, batch.destWarehouseId)) return null;
  const [dest] = await db
    .select({ code: warehouses.code })
    .from(warehouses)
    .where(eq(warehouses.id, batch.destWarehouseId));
  return { toCode: dest?.code ?? '—' };
}

export interface RerouteTarget {
  id: string;
  label: string;
  code: string;
  pinOffRoute: boolean;
  noSchedule: boolean;
}

/**
 * The warehouses the form offers — exactly the ones the service admits:
 * active, not either end, the destination's own country (answer 5a), in the
 * person's scope. Every hidden case is still refused by the service for a
 * hand-made post (#531).
 */
export async function rerouteTargets(
  batch: { originWarehouseId: string; destWarehouseId: string; trackingCheckpoint: unknown },
  head: { originCode: string; destCountry: string | null },
  actor: ScopedActor,
): Promise<RerouteTarget[]> {
  const key = countryKey(head.destCountry);
  if (!key) return [];
  const rows = await db
    .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name, country: warehouses.country })
    .from(warehouses)
    .where(
      and(
        eq(warehouses.active, true),
        ne(warehouses.id, batch.originWarehouseId),
        ne(warehouses.id, batch.destWarehouseId),
        sql`upper(trim(${warehouses.country})) = ${key}`,
      ),
    )
    .orderBy(asc(warehouses.code));
  return rows
    .filter((row) => inScope(actor, row.id))
    .map((row) => ({
      id: row.id,
      label: `${row.code} · ${row.name}`,
      code: row.code,
      ...consequencesOf(batch.trackingCheckpoint, head.originCode, row),
    }));
}
