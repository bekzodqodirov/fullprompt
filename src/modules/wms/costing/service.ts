import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  clients,
  costAllocations,
  costEntries,
  costTypes,
  crates,
  fxRates,
  receiptLots,
  receipts,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { getSetting } from '../../platform/settings/service';
import { allocateEntry, toUsd, type AllocBox, type AllocationBasis } from './engine';
import { batchMemberFilter } from '../scanning/unload';

export class CostError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

// ---------------------------------------------------------------------------
// FX
// ---------------------------------------------------------------------------

export const fxRateSchema = z.object({
  currency: z.string().length(3).toUpperCase(),
  rateToUsd: z.number().positive().max(1_000_000),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function upsertFxRate(input: z.infer<typeof fxRateSchema>, ctx: AuditContext) {
  if (!ctx.actorId) throw new CostError('unauthenticated');
  const [row] = await db
    .insert(fxRates)
    .values({
      currency: input.currency,
      rateToUsd: String(input.rateToUsd),
      effectiveDate: input.effectiveDate,
      enteredBy: ctx.actorId,
    })
    .onConflictDoUpdate({
      target: [fxRates.currency, fxRates.effectiveDate],
      set: { rateToUsd: String(input.rateToUsd), enteredBy: ctx.actorId },
    })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'fx_rate',
    entityId: row!.id,
    action: 'update',
    after: { currency: input.currency, rateToUsd: input.rateToUsd, date: input.effectiveDate },
  });
  return row!;
}

/**
 * Rate in force on a date: the latest rate with effective_date ≤ costDate;
 * falls back to the earliest known rate (better than nothing for entries
 * dated before the first rate). USD is always 1. Null = currency has no
 * rates at all — the entry stays unconverted and reports flag it.
 */
export async function rateFor(currency: string, costDate: string): Promise<number | null> {
  if (currency === 'USD') return 1;
  const [hit] = await db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.currency, currency), lte(fxRates.effectiveDate, costDate)))
    .orderBy(desc(fxRates.effectiveDate))
    .limit(1);
  if (hit) return Number(hit.rateToUsd);
  const [earliest] = await db
    .select()
    .from(fxRates)
    .where(eq(fxRates.currency, currency))
    .orderBy(asc(fxRates.effectiveDate))
    .limit(1);
  return earliest ? Number(earliest.rateToUsd) : null;
}

// ---------------------------------------------------------------------------
// Cost entry capture
// ---------------------------------------------------------------------------

export const costEntrySchema = z.object({
  // 'crate' joined in round 31: the yashik fee could only ever be typed at
  // crate creation — a wrong amount had no void and no second entry.
  scope: z.enum(['receipt', 'batch', 'crate']),
  receiptId: z.string().uuid().optional(),
  batchId: z.string().uuid().optional(),
  crateId: z.string().uuid().optional(),
  costTypeId: z.string().uuid(),
  amount: z.number().positive().max(1_000_000_000),
  currency: z.string().length(3).toUpperCase(),
  costDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  allocationBasis: z.enum(['weight', 'volume', 'chargeable', 'boxes', 'direct_to_client']),
  clientId: z.string().uuid().optional(),
  /**
   * Somebody else settled this — the customs firm's own account, the
   * transport company's (round 39). The cost still belongs to the cargo, so
   * tannarx is untouched; what changes is that no cash box of ours opened,
   * and the amount lands on that partner's ledger as a debt instead.
   */
  partnerId: z.string().uuid().optional().or(z.literal('')),
  note: z.string().trim().max(2000).optional().or(z.literal('')),
});

export async function addCostEntry(input: z.infer<typeof costEntrySchema>, ctx: AuditContext) {
  if (!ctx.actorId) throw new CostError('unauthenticated');
  if (input.scope === 'receipt' && !input.receiptId) throw new CostError('validation');
  if (input.scope === 'batch' && !input.batchId) throw new CostError('validation');
  if (input.scope === 'crate' && !input.crateId) throw new CostError('validation');
  if (input.allocationBasis === 'direct_to_client' && !input.clientId) {
    throw new CostError('client_required');
  }

  const [entry] = await db
    .insert(costEntries)
    .values({
      scope: input.scope,
      receiptId: input.receiptId ?? null,
      batchId: input.batchId ?? null,
      crateId: input.crateId ?? null,
      costTypeId: input.costTypeId,
      amount: String(input.amount),
      currency: input.currency,
      costDate: input.costDate,
      allocationBasis: input.allocationBasis,
      clientId: input.clientId ?? null,
      partnerId: input.partnerId || null,
      note: input.note || null,
      enteredBy: ctx.actorId,
    })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'cost_entry',
    entityId: entry!.id,
    action: 'create',
    after: { scope: input.scope, amount: input.amount, currency: input.currency },
  });
  await recomputeEntry(entry!.id);
  // The debt side. Written AFTER the allocation so a partner never carries a
  // charge for a cost that failed to land; dynamic import because costing is
  // the older module and partners reaches back into it for the FX rate.
  if (input.partnerId) {
    const { chargeForCost } = await import('../partners/link');
    await chargeForCost(entry!.id, ctx);
  }
  return entry!;
}

export async function voidCostEntry(id: string, reason: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new CostError('unauthenticated');
  const entry = await db.query.costEntries.findFirst({ where: eq(costEntries.id, id) });
  if (!entry) throw new CostError('not_found');
  if (entry.voidedAt) throw new CostError('already_voided');
  await db
    .update(costEntries)
    .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason })
    .where(eq(costEntries.id, id));
  await db.delete(costAllocations).where(eq(costAllocations.costEntryId, id));
  // A cancelled cost cannot leave a live debt behind it: the truck we are no
  // longer paying for must stop appearing on the transport company's account.
  if (entry.partnerId) {
    const { voidChargeForCost } = await import('../partners/link');
    await voidChargeForCost(id, reason, ctx);
  }
  await writeAudit(db, ctx, {
    entityType: 'cost_entry',
    entityId: id,
    action: 'void',
    after: { reason },
  });
}

// ---------------------------------------------------------------------------
// Recompute (idempotent — spec 6.9)
// ---------------------------------------------------------------------------

interface BoxDims {
  boxId: string;
  clientId: string | null;
  weightKg: number;
  volumeM3: number;
}

/** Per-box kg/m³ pro-rated from the lot; client from the receipt. */
async function boxDims(boxIds: string[]): Promise<BoxDims[]> {
  if (boxIds.length === 0) return [];
  const rows = await db
    .select({
      boxId: boxes.id,
      clientId: receipts.clientId,
      boxCount: receiptLots.boxCount,
      totalWeightKg: receiptLots.totalWeightKg,
      totalVolumeM3: receiptLots.totalVolumeM3,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(inArray(boxes.id, boxIds));
  return rows.map((r) => ({
    boxId: r.boxId,
    clientId: r.clientId,
    weightKg: Number(r.totalWeightKg) / r.boxCount,
    volumeM3: Number(r.totalVolumeM3) / r.boxCount,
  }));
}

/** Boxes in an entry's scope: receipt → its boxes; crate → its boxes; batch → everything that rode it. */
async function scopeBoxIds(entry: typeof costEntries.$inferSelect): Promise<string[]> {
  if (entry.scope === 'receipt' && entry.receiptId) {
    const rows = await db
      .select({ id: boxes.id })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .where(eq(receiptLots.receiptId, entry.receiptId));
    return rows.map((r) => r.id);
  }
  if (entry.scope === 'crate' && entry.crateId) {
    // Membership is written once at packing, and issue/dissolve/lost CLEAR
    // the live pointer — money must not follow it out: the crating fee was
    // paid for exactly the boxes that were packed, and a recompute after the
    // crate's life ended used to erase the allocations for good.
    const packed = await db
      .selectDistinct({ id: boxMovements.boxId })
      .from(boxMovements)
      .where(
        and(
          eq(boxMovements.refType, 'crate'),
          eq(boxMovements.refId, entry.crateId),
          eq(boxMovements.cause, 'crate_packed'),
        ),
      );
    if (packed.length) return packed.map((r) => r.id);
    const live = await db.select({ id: boxes.id }).from(boxes).where(eq(boxes.crateId, entry.crateId));
    return live.map((r) => r.id);
  }
  if (entry.scope === 'batch' && entry.batchId) {
    // Departed boxes are the ground truth; before departure fall back to the
    // currently loaded/reserved members so early-entered costs still show.
    const departed = await db
      .selectDistinct({ id: boxMovements.boxId })
      .from(boxMovements)
      .where(
        and(
          eq(boxMovements.refType, 'batch'),
          eq(boxMovements.refId, entry.batchId),
          eq(boxMovements.cause, 'batch_departed'),
        ),
      );
    if (departed.length) return departed.map((r) => r.id);
    const current = await db
      .select({ id: boxes.id })
      .from(boxes)
      .where(eq(boxes.currentBatchId, entry.batchId));
    return current.map((r) => r.id);
  }
  return [];
}

/** Rebuild one entry's USD conversion + per-box allocation rows. */
export async function recomputeEntry(costEntryId: string): Promise<void> {
  const entry = await db.query.costEntries.findFirst({ where: eq(costEntries.id, costEntryId) });
  if (!entry) return;
  if (entry.voidedAt) {
    await db.delete(costAllocations).where(eq(costAllocations.costEntryId, costEntryId));
    return;
  }

  const rate = await rateFor(entry.currency, entry.costDate);
  const amountUsd = rate !== null ? toUsd(Number(entry.amount), rate) : null;
  await db
    .update(costEntries)
    .set({ amountUsd: amountUsd !== null ? String(amountUsd) : null, fxRateUsed: rate !== null ? String(rate) : null })
    .where(eq(costEntries.id, costEntryId));

  await db.delete(costAllocations).where(eq(costAllocations.costEntryId, costEntryId));
  if (amountUsd === null) return; // unconverted — reports flag it

  const ids = await scopeBoxIds(entry);
  const dims = await boxDims(ids);
  const factor = await getSetting('chargeable_weight_factor');
  const pool: AllocBox[] = dims.map((d) => ({
    ...d,
    chargeableKg: Math.max(d.weightKg, d.volumeM3 * Number(factor)),
  }));
  const shares = allocateEntry(
    {
      amountUsd,
      basis: entry.allocationBasis as AllocationBasis,
      clientId: entry.clientId,
    },
    pool,
  );
  if (shares.length) {
    await db.insert(costAllocations).values(
      shares.map((s) => ({
        costEntryId,
        boxId: s.boxId,
        clientId: s.clientId,
        amountUsd: String(s.amountUsd),
      })),
    );
  }
}

/**
 * Sweep recompute: everything (FX table edited), one currency, or one
 * batch/receipt. Idempotent — safe to run repeatedly.
 */
export async function recomputeAll(filter?: { currency?: string; batchId?: string; receiptId?: string }) {
  const rows = await db
    .select({ id: costEntries.id })
    .from(costEntries)
    .where(
      and(
        isNull(costEntries.voidedAt),
        filter?.currency ? eq(costEntries.currency, filter.currency) : undefined,
        filter?.batchId ? eq(costEntries.batchId, filter.batchId) : undefined,
        filter?.receiptId ? eq(costEntries.receiptId, filter.receiptId) : undefined,
      ),
    );
  for (const row of rows) await recomputeEntry(row.id);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

/** Landed cost of one box: entry-level shares with type names (spec 6.9). */
export async function boxLandedCost(boxId: string) {
  const rows = await db
    .select({
      amountUsd: costAllocations.amountUsd,
      scope: costEntries.scope,
      typeName: costTypes.name,
      currency: costEntries.currency,
      amount: costEntries.amount,
      batchCode: batches.code,
      crateCode: crates.code,
    })
    .from(costAllocations)
    .innerJoin(costEntries, eq(costAllocations.costEntryId, costEntries.id))
    .innerJoin(costTypes, eq(costEntries.costTypeId, costTypes.id))
    .leftJoin(batches, eq(costEntries.batchId, batches.id))
    .leftJoin(crates, eq(costEntries.crateId, crates.id))
    .where(eq(costAllocations.boxId, boxId))
    .orderBy(asc(costAllocations.id));
  const totalUsd = rows.reduce((a, r) => a + Number(r.amountUsd), 0);
  return { totalUsd: Math.round(totalUsd * 100) / 100, shares: rows };
}

export interface ClientLandedCost {
  clientId: string;
  /** Everything spent on this client's boxes so far, in USD. */
  totalUsd: number;
  /** The part that came from THIS batch's own cost entries. */
  batchUsd: number;
}

/**
 * What each client's cargo on a batch has cost us (owner: "rastamojka
 * summalarini qayerda klientga kiritamiz — narxni shakllantirish uchun").
 *
 * The allocation engine already split every cost entry down to the box, so
 * the answer is a sum over `cost_allocations` grouped by the box's client —
 * customs entered once for the truck arrives here as each client's share.
 * Two figures because they answer different questions: `totalUsd` is what the
 * cargo cost us end to end (China-side receipt costs included) and is the one
 * a price has to beat; `batchUsd` is what this trip added.
 */
export async function batchLandedCostByClient(batchId: string): Promise<Map<string, ClientLandedCost>> {
  const rows = await db
    .select({
      clientId: receipts.clientId,
      totalUsd: sql<string>`coalesce(sum(${costAllocations.amountUsd}), 0)`,
      batchUsd: sql<string>`coalesce(sum(${costAllocations.amountUsd}) filter (where ${costEntries.batchId} = ${batchId}), 0)`,
    })
    .from(costAllocations)
    .innerJoin(costEntries, eq(costAllocations.costEntryId, costEntries.id))
    .innerJoin(boxes, eq(costAllocations.boxId, boxes.id))
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(and(isNull(costEntries.voidedAt), batchMemberFilter(batchId)))
    .groupBy(receipts.clientId);

  const out = new Map<string, ClientLandedCost>();
  for (const row of rows) {
    if (!row.clientId) continue;
    out.set(row.clientId, {
      clientId: row.clientId,
      totalUsd: Math.round(Number(row.totalUsd) * 100) / 100,
      batchUsd: Math.round(Number(row.batchUsd) * 100) / 100,
    });
  }
  return out;
}

/** Batch cost sheet: entries + totals + unit costs per kg / m³. */
export async function batchCostSheet(batchId: string) {
  const entries = await db
    .select({
      entry: costEntries,
      typeName: costTypes.name,
      clientCode: clients.clientCode,
    })
    .from(costEntries)
    .innerJoin(costTypes, eq(costEntries.costTypeId, costTypes.id))
    .leftJoin(clients, eq(costEntries.clientId, clients.id))
    .where(and(eq(costEntries.batchId, batchId), isNull(costEntries.voidedAt)))
    .orderBy(asc(costEntries.createdAt));

  const [load] = await db
    .select({
      boxCount: sql<number>`count(*)`,
      kg: sql<string>`coalesce(sum(${receiptLots.totalWeightKg} / ${receiptLots.boxCount}), 0)`,
      m3: sql<string>`coalesce(sum(${receiptLots.totalVolumeM3} / ${receiptLots.boxCount}), 0)`,
    })
    .from(boxMovements)
    .innerJoin(boxes, eq(boxMovements.boxId, boxes.id))
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(
      and(
        eq(boxMovements.refType, 'batch'),
        eq(boxMovements.refId, batchId),
        eq(boxMovements.cause, 'batch_departed'),
      ),
    );

  const totalUsd = entries.reduce((a, e) => a + Number(e.entry.amountUsd ?? 0), 0);
  const kg = Number(load?.kg ?? 0);
  const m3 = Number(load?.m3 ?? 0);
  return {
    entries,
    totalUsd: Math.round(totalUsd * 100) / 100,
    unconverted: entries.filter((e) => e.entry.amountUsd === null).length,
    boxCount: Number(load?.boxCount ?? 0),
    kg: Math.round(kg * 10) / 10,
    m3: Math.round(m3 * 1000) / 1000,
    usdPerKg: kg > 0 ? Math.round((totalUsd / kg) * 1000) / 1000 : null,
    usdPerM3: m3 > 0 ? Math.round((totalUsd / m3) * 100) / 100 : null,
  };
}

// ---------------------------------------------------------------------------
// The receipt-cost grid (round 29) — the accountant's Excel, kept
//
// Her sheet had a row per prixod and a column per expense: rastamojka,
// firma uslugasi, yo'lkira, sertifikat, jami. Entering those one form at a
// time is why «rastamojkani yozishga uspet qilmayman». The grid puts the
// same table on the batch card; one save turns every filled cell into an
// ordinary receipt-scope cost entry — audited, FX-converted and allocated
// by the same engine as everything else, so the landed cost cannot tell a
// grid entry from a form entry.
// ---------------------------------------------------------------------------

export interface BatchReceiptRow {
  receiptId: string;
  number: string | null;
  clientCode: string | null;
  clientName: string | null;
  boxCount: number;
  kg: number;
  m3: number;
}

/** The batch's receipts, one grid row each — membership through the
 * movement rows (#152), same ground truth as the cost engine itself. */
export async function batchReceiptRows(batchId: string): Promise<BatchReceiptRow[]> {
  const rows = await db
    .select({
      receiptId: receipts.id,
      number: receipts.number,
      clientCode: clients.clientCode,
      clientName: clients.name,
      boxCount: sql<number>`count(distinct ${boxes.id})`,
      kg: sql<string>`coalesce(sum(${receiptLots.totalWeightKg} / ${receiptLots.boxCount}), 0)`,
      m3: sql<string>`coalesce(sum(${receiptLots.totalVolumeM3} / ${receiptLots.boxCount}), 0)`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(batchMemberFilter(batchId))
    .groupBy(receipts.id, receipts.number, clients.clientCode, clients.name)
    .orderBy(asc(clients.clientCode), asc(receipts.number));
  return rows.map((row) => ({
    receiptId: row.receiptId,
    number: row.number,
    clientCode: row.clientCode,
    clientName: row.clientName,
    boxCount: Number(row.boxCount),
    kg: Math.round(Number(row.kg) * 10) / 10,
    m3: Math.round(Number(row.m3) * 1000) / 1000,
  }));
}

/**
 * What is ALREADY written per receipt per type (USD, non-void) — shown under
 * the grid's inputs so a second session never double-enters blind. Keyed
 * `receiptId:costTypeId`.
 */
export async function receiptCostMatrix(receiptIds: string[]): Promise<Map<string, number>> {
  if (receiptIds.length === 0) return new Map();
  const rows = await db
    .select({
      receiptId: costEntries.receiptId,
      costTypeId: costEntries.costTypeId,
      usd: sql<string>`coalesce(sum(${costEntries.amountUsd}), 0)`,
    })
    .from(costEntries)
    .where(
      and(
        eq(costEntries.scope, 'receipt'),
        inArray(costEntries.receiptId, receiptIds),
        isNull(costEntries.voidedAt),
      ),
    )
    .groupBy(costEntries.receiptId, costEntries.costTypeId);
  return new Map(
    rows.map((row) => [`${row.receiptId}:${row.costTypeId}`, Math.round(Number(row.usd) * 100) / 100]),
  );
}

export const receiptCostGridSchema = z.object({
  batchId: z.string().uuid(),
  currency: z.string().trim().length(3).toUpperCase(),
  costDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cells: z
    .array(
      z.object({
        receiptId: z.string().uuid(),
        costTypeId: z.string().uuid(),
        amount: z.number().positive().max(1_000_000_000),
      }),
    )
    .min(1)
    .max(500),
});
export type ReceiptCostGridInput = z.infer<typeof receiptCostGridSchema>;

/**
 * One save, many entries. Every cell must name a receipt that is actually ON
 * this batch — the grid only offers those, but a stale tab or a hand-built
 * request must not be able to hang somebody else's prixod with our customs
 * bill, so the membership is re-proved here, not trusted from the form.
 */
export async function addReceiptCostsBulk(
  input: ReceiptCostGridInput,
  ctx: AuditContext,
): Promise<number> {
  const allowed = new Set((await batchReceiptRows(input.batchId)).map((row) => row.receiptId));
  for (const cell of input.cells) {
    if (!allowed.has(cell.receiptId)) throw new CostError('receipt_not_on_batch');
  }
  for (const cell of input.cells) {
    await addCostEntry(
      {
        scope: 'receipt',
        receiptId: cell.receiptId,
        costTypeId: cell.costTypeId,
        amount: cell.amount,
        currency: input.currency,
        costDate: input.costDate,
        // Within one receipt the split lands on one client either way;
        // weight is the house default the rest of the engine uses.
        allocationBasis: 'weight',
      },
      ctx,
    );
  }
  return input.cells.length;
}

export interface ClientCostPart {
  /** Where the money was written: a batch code, a prixod number, a crate. */
  source: string;
  typeName: string;
  usd: number;
}

/**
 * WHAT a client's tannarx on this batch is made of (round 29, owner:
 * «GS500 tannarxi ustida nimalar o'tirganini ko'rsam») — every cost entry
 * whose allocation landed on the client's boxes aboard, grouped by its
 * source and type: «YW-001 · yo'lkira — $60», «prixod · rastamojka — $45».
 * The same rows `boxLandedCost` prints per box, folded per client.
 */
export async function batchClientCostBreakdown(
  batchId: string,
): Promise<Map<string, ClientCostPart[]>> {
  const rows = await db
    .select({
      clientId: costAllocations.clientId,
      typeName: costTypes.name,
      batchCode: batches.code,
      receiptNumber: receipts.number,
      crateCode: crates.code,
      usd: sql<string>`sum(${costAllocations.amountUsd})`,
    })
    .from(costAllocations)
    .innerJoin(costEntries, eq(costAllocations.costEntryId, costEntries.id))
    .innerJoin(costTypes, eq(costEntries.costTypeId, costTypes.id))
    .innerJoin(boxes, eq(costAllocations.boxId, boxes.id))
    .leftJoin(batches, eq(costEntries.batchId, batches.id))
    .leftJoin(receipts, eq(costEntries.receiptId, receipts.id))
    .leftJoin(crates, eq(costEntries.crateId, crates.id))
    .where(
      and(
        batchMemberFilter(batchId),
        isNull(costEntries.voidedAt),
        sql`${costAllocations.clientId} IS NOT NULL`,
      ),
    )
    .groupBy(
      costAllocations.clientId,
      costTypes.name,
      batches.code,
      receipts.number,
      crates.code,
    );
  const out = new Map<string, ClientCostPart[]>();
  for (const row of rows) {
    const list = out.get(row.clientId!) ?? [];
    list.push({
      source: row.batchCode ?? row.receiptNumber ?? row.crateCode ?? '—',
      typeName: row.typeName,
      usd: Math.round(Number(row.usd) * 100) / 100,
    });
    out.set(row.clientId!, list);
  }
  for (const list of out.values()) list.sort((a, b) => b.usd - a.usd);
  return out;
}
