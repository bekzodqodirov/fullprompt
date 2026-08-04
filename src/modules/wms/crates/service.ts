import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  boxes,
  boxMovements,
  clients,
  costEntries,
  costTypes,
  crates,
  receiptLots,
  receipts,
  warehouses,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';
import { recomputeEntry } from '../costing/service';
import { nextCrateCode } from '../codes';

export class CrateError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export const createCrateSchema = z.object({
  /** Client-generated so photos can upload against it before create. */
  crateId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  boxIds: z.array(z.string().uuid()).min(1).max(500),
  kind: z.enum(['yashik', 'karkas']),
  /** Mandatory real-world "logist approved" confirmation (spec 6.2). */
  logistApproved: z.literal(true),
  note: z.string().trim().max(500).optional().or(z.literal('')),
  lengthCm: z.number().int().min(1).max(1000).optional(),
  widthCm: z.number().int().min(1).max(1000).optional(),
  heightCm: z.number().int().min(1).max(1000).optional(),
  weightKg: z.number().min(0.001).max(100_000).optional(),
  /** Crating cost (spec 6.2): stored scope=crate under the `crating` type. */
  cratingCost: z
    .object({ amount: z.number().min(0.01).max(100_000_000), currency: z.string().length(3) })
    .optional(),
});
export type CreateCrateInput = z.infer<typeof createCrateSchema>;

/**
 * Build a crate from in-stock boxes (spec 6.2). One client per crate; multiple
 * lots of the same client are fine; unclaimed cargo must be assigned to a
 * client first. Boxes stay `in_stock` — crate membership is `crate_id`
 * (DECISIONS #4), so every later scan mode fans a crate out to its members.
 */
export async function createCrate(input: CreateCrateInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new CrateError('unauthenticated');
  const actorId = ctx.actorId;
  const { crate, cratingEntryId } = await db.transaction(async (tx) => {
    // Idempotent by client-generated id (double-tap safe).
    const existing = await tx.query.crates.findFirst({ where: eq(crates.id, input.crateId) });
    if (existing) return { crate: existing, cratingEntryId: null };

    const warehouse = await tx.query.warehouses.findFirst({
      where: eq(warehouses.id, input.warehouseId),
    });
    if (!warehouse) throw new CrateError('warehouse_not_found');

    const rows = await tx
      .select({ box: boxes, clientId: receipts.clientId })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .where(inArray(boxes.id, input.boxIds))
      .for('update', { of: boxes });

    if (rows.length !== input.boxIds.length) throw new CrateError('box_not_found');
    for (const { box } of rows) {
      if (box.status !== 'in_stock') throw new CrateError('box_not_in_stock');
      if (box.currentWarehouseId !== input.warehouseId) throw new CrateError('box_wrong_warehouse');
      if (box.crateId) throw new CrateError('box_already_crated');
    }
    const clientIds = new Set(rows.map((r) => r.clientId));
    if (clientIds.has(null)) throw new CrateError('unclaimed_not_allowed');
    if (clientIds.size !== 1) throw new CrateError('multiple_clients');
    const clientId = [...clientIds][0]!;

    const code = await nextCrateCode(tx, warehouse);
    const [crate] = await tx
      .insert(crates)
      .values({
        id: input.crateId,
        code,
        warehouseId: input.warehouseId,
        clientId,
        kind: input.kind,
        logistApproved: true,
        note: input.note || null,
        lengthCm: input.lengthCm ?? null,
        widthCm: input.widthCm ?? null,
        heightCm: input.heightCm ?? null,
        weightKg: input.weightKg != null ? String(input.weightKg) : null,
        createdBy: actorId,
      })
      .returning();

    let cratingEntryId: string | null = null;
    if (input.cratingCost) {
      const cratingType = await tx.query.costTypes.findFirst({
        where: eq(costTypes.code, 'crating'),
      });
      if (!cratingType) throw new CrateError('crating_cost_type_missing');
      const [entry] = await tx
        .insert(costEntries)
        .values({
          scope: 'crate',
          crateId: crate!.id,
          clientId,
          costTypeId: cratingType.id,
          amount: input.cratingCost.amount.toString(),
          currency: input.cratingCost.currency,
          costDate: new Date().toISOString().slice(0, 10),
          enteredBy: actorId,
        })
        .returning({ id: costEntries.id });
      cratingEntryId = entry!.id;
    }

    await tx.update(boxes).set({ crateId: crate!.id }).where(inArray(boxes.id, input.boxIds));
    await tx.insert(boxMovements).values(
      rows.map(({ box }) => ({
        boxId: box.id,
        fromWarehouseId: box.currentWarehouseId,
        toWarehouseId: box.currentWarehouseId,
        fromStatus: box.status,
        toStatus: box.status,
        cause: 'crate_packed',
        refType: 'crate',
        refId: crate!.id,
        actorId: ctx.actorId,
      })),
    );
    await writeAudit(tx, { ...ctx, warehouseId: input.warehouseId }, {
      entityType: 'crate',
      entityId: crate!.id,
      action: 'create',
      after: { code, clientId, kind: input.kind, boxCount: rows.length, note: input.note || null },
    });
    await emitEvent(tx, {
      type: 'CrateFormed',
      payload: { crateId: crate!.id, code, warehouseId: input.warehouseId, clientId, boxCount: rows.length },
      entityType: 'crate',
      entityId: crate!.id,
      actorId: ctx.actorId,
    });
    return { crate: crate!, cratingEntryId };
  });
  // FX-convert and split across the members the moment the entry is born,
  // like every cost the forms enter. Until this ran, the yashik fee sat with
  // amount_usd NULL — in no tannarx, no client share, no P&L.
  if (cratingEntryId) await recomputeEntry(cratingEntryId);
  return crate;
}

/** Update measured dims/weight/note after packing (spec: "measured after packing"). */
export async function updateCrate(
  crateId: string,
  patch: { lengthCm?: number | null; widthCm?: number | null; heightCm?: number | null; weightKg?: number | null; note?: string | null },
  ctx: AuditContext,
) {
  return db.transaction(async (tx) => {
    const crate = await tx.query.crates.findFirst({ where: eq(crates.id, crateId) });
    if (!crate) throw new CrateError('crate_not_found');
    if (crate.status !== 'active') throw new CrateError('crate_dissolved');
    const [updated] = await tx
      .update(crates)
      .set({
        lengthCm: patch.lengthCm ?? crate.lengthCm,
        widthCm: patch.widthCm ?? crate.widthCm,
        heightCm: patch.heightCm ?? crate.heightCm,
        weightKg: patch.weightKg != null ? String(patch.weightKg) : crate.weightKg,
        note: patch.note !== undefined ? patch.note : crate.note,
      })
      .where(eq(crates.id, crateId))
      .returning();
    await writeAudit(tx, { ...ctx, warehouseId: crate.warehouseId }, {
      entityType: 'crate',
      entityId: crateId,
      action: 'update',
      before: { lengthCm: crate.lengthCm, widthCm: crate.widthCm, heightCm: crate.heightCm, weightKg: crate.weightKg, note: crate.note },
      after: { lengthCm: updated!.lengthCm, widthCm: updated!.widthCm, heightCm: updated!.heightCm, weightKg: updated!.weightKg, note: updated!.note },
    });
    return updated!;
  });
}

/** Dissolve a crate: members return to loose boxes (audited, spec 6.2). */
export async function dissolveCrate(crateId: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new CrateError('unauthenticated');
  const actorId = ctx.actorId;
  return db.transaction(async (tx) => {
    const crate = await tx.query.crates.findFirst({ where: eq(crates.id, crateId) });
    if (!crate) throw new CrateError('crate_not_found');
    if (crate.status !== 'active') throw new CrateError('crate_dissolved');

    const members = await tx
      .select()
      .from(boxes)
      .where(eq(boxes.crateId, crateId))
      .for('update');
    for (const box of members) {
      if (box.status !== 'in_stock') throw new CrateError('box_not_in_stock');
    }

    await tx.update(boxes).set({ crateId: null }).where(eq(boxes.crateId, crateId));
    await tx
      .update(crates)
      .set({ status: 'dissolved', dissolvedAt: new Date(), dissolvedBy: actorId })
      .where(eq(crates.id, crateId));
    // A crate can be EMPTY by now (every member voided with its receipt) —
    // an empty values() throws, and the memberless crate stayed undissolvable.
    if (members.length) {
      await tx.insert(boxMovements).values(
        members.map((box) => ({
          boxId: box.id,
          fromWarehouseId: box.currentWarehouseId,
          toWarehouseId: box.currentWarehouseId,
          fromStatus: box.status,
          toStatus: box.status,
          cause: 'crate_dissolved',
          refType: 'crate',
          refId: crateId,
          actorId: ctx.actorId,
        })),
      );
    }
    await writeAudit(tx, { ...ctx, warehouseId: crate.warehouseId }, {
      entityType: 'crate',
      entityId: crateId,
      action: 'update',
      before: { status: 'active' },
      after: { status: 'dissolved', boxCount: members.length },
    });
    await emitEvent(tx, {
      type: 'CrateDissolved',
      payload: { crateId, code: crate.code, boxCount: members.length },
      entityType: 'crate',
      entityId: crateId,
      actorId: ctx.actorId,
    });
    return { boxCount: members.length };
  });
}

/**
 * Crate resolution — the shared primitive for M3–M5 scan modes: a crate scan
 * substitutes for scanning each member box.
 */
export async function resolveCrate(codeOrId: string) {
  const byCode = await db
    .select({
      crate: crates,
      clientCode: clients.clientCode,
      whCode: warehouses.code,
    })
    .from(crates)
    .innerJoin(clients, eq(crates.clientId, clients.id))
    .innerJoin(warehouses, eq(crates.warehouseId, warehouses.id))
    .where(
      /^CR-/i.test(codeOrId) ? eq(crates.code, codeOrId.toUpperCase()) : eq(crates.id, codeOrId),
    )
    .limit(1);
  const hit = byCode[0];
  if (!hit) return null;
  const members = await db
    .select({
      box: boxes,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(eq(boxes.crateId, hit.crate.id))
    .orderBy(receiptLots.letter, boxes.seqInLot);
  return { ...hit, members };
}

/** Contents summary for the label/detail: "GS777: A×10, B×8". */
export async function crateContents(crateId: string) {
  const rows = await db
    .select({
      letter: receiptLots.letter,
      count: sql<number>`count(*)`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(and(eq(boxes.crateId, crateId)))
    .groupBy(receiptLots.letter)
    .orderBy(receiptLots.letter);
  return rows.map((r) => ({ letter: r.letter ?? '?', count: Number(r.count) }));
}
