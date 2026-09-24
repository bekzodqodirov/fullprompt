import { and, asc, desc, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Tx } from '../../platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  clients,
  partners,
  costAllocations,
  costEntries,
  costTypes,
  crates,
  fxRates,
  partnerTransactions,
  pickups,
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
 * read ONCE per cost entry — its first conversion is frozen (R1);
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
  // 'pickup' joined with the factory truck (0100, owner's B5a): the truck we
  // hire to collect from the factories, split over the cargo it brought.
  scope: z.enum(['receipt', 'batch', 'crate', 'pickup']),
  receiptId: z.string().uuid().optional(),
  batchId: z.string().uuid().optional(),
  crateId: z.string().uuid().optional(),
  pickupId: z.string().uuid().optional(),
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
  if (input.scope === 'pickup' && !input.pickupId) throw new CostError('validation');
  if (input.allocationBasis === 'direct_to_client' && !input.clientId) {
    throw new CostError('client_required');
  }
  // Naming a payer means recording a DEBT, and a debt with no dollar figure
  // cannot be recorded: `chargeForCost` returns silently when the conversion
  // is missing, so the cost row would go on showing the firm's name while
  // that firm's account never heard of it. `addPartnerTx` and `addExpense`
  // already refuse the same way — this path did not.
  if (input.partnerId && (await rateFor(input.currency, input.costDate)) === null) {
    throw new CostError('fx_missing');
  }

  const [entry] = await db
    .insert(costEntries)
    .values({
      scope: input.scope,
      receiptId: input.receiptId ?? null,
      batchId: input.batchId ?? null,
      crateId: input.crateId ?? null,
      pickupId: input.scope === 'pickup' ? (input.pickupId ?? null) : null,
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
  await db.transaction(async (tx) => voidCostEntryInTx(tx, id, reason, ctx));
}

/**
 * The void's writes, on the CALLER's transaction. ONE transaction,
 * deliberately: these used to be four autocommitted statements, and a crash
 * between the entry's void and the charge's left a live partner debt whose
 * backing cost was gone — with no retry possible ('already_voided') and no
 * sweep that could ever repair it. #360 added a reader-side belt for the
 * allocation half of that window; the charge half gets the transaction,
 * because a debt has no reader-side belt. The annul cascade runs this inside
 * ITS transaction so a later refusal rolls the money back with the cargo —
 * auto-voiding money ahead of a refusable step was the design review's first
 * blocker.
 */
export async function voidCostEntryInTx(tx: Tx, id: string, reason: string, ctx: AuditContext) {
  await tx
    .update(costEntries)
    .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason })
    .where(eq(costEntries.id, id));
  await tx.delete(costAllocations).where(eq(costAllocations.costEntryId, id));
  // A cancelled cost cannot leave a live debt behind it: the truck we are
  // no longer paying for must stop appearing on the firm's account.
  const voidedCharges = await tx
    .update(partnerTransactions)
    .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason })
    .where(and(eq(partnerTransactions.costEntryId, id), isNull(partnerTransactions.voidedAt)))
    .returning({ id: partnerTransactions.id });
  for (const row of voidedCharges) {
    await writeAudit(tx, ctx, {
      entityType: 'partner_transaction',
      entityId: row.id,
      action: 'void',
      after: { reason, from: 'cost_entry', costEntryId: id },
    });
  }
  await writeAudit(tx, ctx, {
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
export async function scopeBoxIds(entry: typeof costEntries.$inferSelect): Promise<string[]> {
  if (entry.scope === 'receipt' && entry.receiptId) {
    // NOT the void ones. A lot-edit shrink voids the miscounted surplus, and
    // a share left (or re-swept) onto a void box is money on a box that never
    // existed: the batch pricing screen reads shares through membership a
    // shelf-voided box can never have, so «totalUsd» — the number a price has
    // to beat — understated by exactly the phantom boxes' share, while
    // profit-by-client (no box join) still counted all of it. Issued, loaded,
    // in-transit boxes all KEEP their shares — they are real cargo the money
    // was spent on; only `void` says «this box was a counting mistake».
    const rows = await db
      .select({ id: boxes.id })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .where(and(eq(receiptLots.receiptId, entry.receiptId), ne(boxes.status, 'void')));
    return rows.map((r) => r.id);
  }
  if (entry.scope === 'crate' && entry.crateId) {
    // Membership is written once at packing, and issue/dissolve/lost CLEAR
    // the live pointer — money must not follow it out: the crating fee was
    // paid for exactly the boxes that were packed, and a recompute after the
    // crate's life ended used to erase the allocations for good.
    // …and, since the annul round, minus the `void` ones here too: the #530
    // rule was receipt-scope only, so a box voided AFTER packing (voidReceipt
    // on crated shelf boxes, or the annul) kept its share of the crating fee.
    // This is a RECORDED correction, not a no-op — old crates holding such
    // boxes re-split their fee onto the real members on the next recompute.
    const packed = await db
      .selectDistinct({ id: boxMovements.boxId })
      .from(boxMovements)
      .innerJoin(boxes, eq(boxMovements.boxId, boxes.id))
      .where(
        and(
          eq(boxMovements.refType, 'crate'),
          eq(boxMovements.refId, entry.crateId),
          eq(boxMovements.cause, 'crate_packed'),
          ne(boxes.status, 'void'),
        ),
      );
    if (packed.length) return packed.map((r) => r.id);
    const live = await db.select({ id: boxes.id }).from(boxes).where(eq(boxes.crateId, entry.crateId));
    return live.map((r) => r.id);
  }
  if (entry.scope === 'pickup' && entry.pickupId) {
    // What the factory truck brought: the real boxes of every prixod a
    // person linked to one of its stops (the receive door, or attach on the
    // receipt card — never a guess, #809's rule). A partly received truck
    // splits over what has been received so far and re-splits as the rest
    // lands; nothing is voided for an empty base (the annul sweep is NOT
    // taught this scope — it would void the truck's freight and the firm's
    // debt on a truck that is merely half-unloaded).
    const rows = await db
      .select({ id: boxes.id })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .where(
        and(
          sql`${receipts.pickupStopId} IN (SELECT ps.id FROM pickup_stops ps WHERE ps.pickup_id = ${entry.pickupId})`,
          isNull(receipts.voidedAt),
          ne(boxes.status, 'void'),
        ),
      );
    return rows.map((r) => r.id);
  }
  if (entry.scope === 'batch' && entry.batchId) {
    // Departed boxes are the ground truth; before departure fall back to the
    // currently loaded/reserved members so early-entered costs still show.
    // Minus the `void` ones (the annul round, completing #530): a box voided
    // after departing was a counting mistake riding a real truck, and its
    // share belongs to the cargo that actually was on board. Deliberate for
    // OLD data too — a void box already in this base repriced silently the
    // day it was voided under the old rule; now it leaves the base instead.
    const departed = await db
      .selectDistinct({ id: boxMovements.boxId })
      .from(boxMovements)
      .innerJoin(boxes, eq(boxMovements.boxId, boxes.id))
      .where(
        and(
          eq(boxMovements.refType, 'batch'),
          eq(boxMovements.refId, entry.batchId),
          eq(boxMovements.cause, 'batch_departed'),
          ne(boxes.status, 'void'),
        ),
      );
    if (departed.length) return departed.map((r) => r.id);
    const current = await db
      .select({ id: boxes.id })
      .from(boxes)
      .where(and(eq(boxes.currentBatchId, entry.batchId), ne(boxes.status, 'void')));
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

  // The dollar figure is FROZEN at the first conversion (owner, R1: «to'langan
  // paytdagi kurs bo'yicha hisoblansin»). A cost is money that left at the
  // rate of its day; a rate typed or corrected on /admin/fx later must not
  // move a past month's P&L, and must not move the firm's derived charge
  // while the payment that settled it stays where it was (audit A0 — a fully
  // paid firm read −$111 after one FX save). Only a row with no dollars yet
  // is converted; every later recompute re-SPLITS the frozen figure over its
  // boxes (a base change still moves the shares, never their sum).
  //
  // Stated, not solved: an entry dated before the currency's FIRST rate was
  // converted at the earliest rate on file (`rateFor`'s fallback) and is
  // frozen at that guess too; correcting it is void and re-enter, like every
  // other ledger row.
  const frozen = entry.amountUsd !== null && entry.fxRateUsed !== null;
  let amountUsd: number | null;
  if (frozen) {
    amountUsd = Number(entry.amountUsd);
  } else {
    const rate = await rateFor(entry.currency, entry.costDate);
    amountUsd = rate !== null ? toUsd(Number(entry.amount), rate) : null;
    await db
      .update(costEntries)
      .set({ amountUsd: amountUsd !== null ? String(amountUsd) : null, fxRateUsed: rate !== null ? String(rate) : null })
      .where(eq(costEntries.id, costEntryId));
  }

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

  // The debt this cost owes its payer, posted the moment a dollar figure
  // exists. Rows entered before the entry-time refusal above shipped — and
  // any row whose rate arrived later — are repaired by the /admin/fx
  // recompute and the nightly unconverted sweep, which convert them once.
  // `chargeForCost` is idempotent per cost, so a re-run costs nothing.
  if (entry.partnerId) {
    try {
      const { chargeForCost } = await import('../partners/link');
      await chargeForCost(costEntryId, { actorId: entry.enteredBy });
    } catch (error) {
      // Never let the partner side roll back an allocation rebuild — the same
      // fence every other costing→partners crossing uses.
      console.error('[costing] charge after recompute failed', error);
    }
  }
}

/**
 * Sweep recompute: everything (FX table edited), one currency, or one
 * batch/receipt. Idempotent — safe to run repeatedly.
 */
export async function recomputeAll(filter?: {
  currency?: string;
  batchId?: string;
  receiptId?: string;
  /** Only rows with no dollar figure yet — the nightly repair sweep. */
  unconverted?: boolean;
  /**
   * The nightly sweep also re-splits every live factory-truck cost: its base
   * grows as prixods are linked, and a post-commit recompute that a crash
   * skipped would otherwise leave the truck's money on the first client for
   * ever. OR-ed with `unconverted`, not AND-ed.
   */
  pickups?: boolean;
  pickupId?: string;
}) {
  const rows = await db
    .select({ id: costEntries.id })
    .from(costEntries)
    .where(
      and(
        isNull(costEntries.voidedAt),
        filter?.currency ? eq(costEntries.currency, filter.currency) : undefined,
        filter?.batchId ? eq(costEntries.batchId, filter.batchId) : undefined,
        filter?.receiptId ? eq(costEntries.receiptId, filter.receiptId) : undefined,
        filter?.pickupId ? eq(costEntries.pickupId, filter.pickupId) : undefined,
        filter?.unconverted && filter.pickups
          ? sql`(${costEntries.amountUsd} IS NULL OR ${costEntries.scope} = 'pickup')`
          : filter?.unconverted
            ? isNull(costEntries.amountUsd)
            : filter?.pickups
              ? eq(costEntries.scope, 'pickup')
              : undefined,
      ),
    );
  for (const row of rows) await recomputeEntry(row.id);
  return rows.length;
}

/**
 * Re-split every live cost that shares money over one lot's boxes (audit
 * A22) — after its kg, m³ or box count was corrected.
 *
 * `recomputeAll({ receiptId })` reached only the receipt's OWN costs. The
 * truck's freight (batch scope, no receipt id) and a crate's fee were split
 * over the old measures and nothing ever split them again: the depart job
 * runs once, and a USD entry is never touched by an FX save. So a 10 → 20 m³
 * fix on a departed lot left hundreds of dollars of freight on the wrong
 * client in every report that reads allocations — while the lot's row showed
 * the corrected kg beside the stale dollars.
 *
 * Membership is read from the ledger that defines it (#440): an entry with a
 * share on any of the lot's boxes, the lot's receipt's own costs, and the
 * batch and crate entries of every truck and crate the lot's boxes were ever
 * loaded into — a box that got no share because its old weight was zero is
 * still on that truck.
 */
export async function recomputeForLot(lotId: string): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT ce.id
      FROM cost_entries ce
     WHERE ce.voided_at IS NULL
       AND (
         ce.receipt_id = (SELECT rl.receipt_id FROM receipt_lots rl WHERE rl.id = ${lotId})
         OR ce.id IN (
           SELECT ca.cost_entry_id
             FROM cost_allocations ca
             JOIN boxes b ON b.id = ca.box_id
            WHERE b.lot_id = ${lotId}
         )
         OR (ce.scope = 'batch' AND ce.batch_id IN (
           SELECT bm.ref_id
             FROM box_movements bm
             JOIN boxes b ON b.id = bm.box_id
            WHERE b.lot_id = ${lotId} AND bm.cause = 'batch_departed' AND bm.ref_type = 'batch'
         ))
         OR (ce.scope = 'crate' AND ce.crate_id IN (
           SELECT bm.ref_id
             FROM box_movements bm
             JOIN boxes b ON b.id = bm.box_id
            WHERE b.lot_id = ${lotId} AND bm.cause = 'crate_packed' AND bm.ref_type = 'crate'
         ))
         OR (ce.scope = 'pickup' AND ce.pickup_id IN (
           SELECT ps.pickup_id
             FROM receipt_lots rl
             JOIN receipts r ON r.id = rl.receipt_id
             JOIN pickup_stops ps ON ps.id = r.pickup_stop_id
            WHERE rl.id = ${lotId}
         ))
       )
  `);
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
      pickupCode: pickups.code,
    })
    .from(costAllocations)
    .innerJoin(costEntries, eq(costAllocations.costEntryId, costEntries.id))
    .innerJoin(costTypes, eq(costEntries.costTypeId, costTypes.id))
    .leftJoin(batches, eq(costEntries.batchId, batches.id))
    .leftJoin(crates, eq(costEntries.crateId, crates.id))
    .leftJoin(pickups, eq(costEntries.pickupId, pickups.id))
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
/**
 * «Shu reysgacha» must not read the future. `batchMemberFilter` is
 * membership-for-ever, so re-opening an internal leg's money screen AFTER the
 * export departed showed the export's customs inside the internal leg's cost
 * column — every last-month leg read loss-making by exactly the later leg's
 * money, under a label that says «before this trip». An entry attributed to
 * another batch counts only when that batch departed BEFORE this one did (or
 * before now, while this one is still forming); an entry with no batch at all
 * is cargo money and rides everywhere it always did.
 */
function notLaterLeg(batchId: string) {
  return sql`(
    ${costEntries.batchId} IS NULL
    OR ${costEntries.batchId} = ${batchId}
    OR EXISTS (
      SELECT 1 FROM batches later
      WHERE later.id = ${costEntries.batchId}
        AND later.departed_at IS NOT NULL
        AND later.departed_at <= coalesce(
          (SELECT b0.departed_at FROM batches b0 WHERE b0.id = ${batchId}), now()
        )
    )
  )`;
}

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
    .where(
      and(isNull(costEntries.voidedAt), batchMemberFilter(batchId), notLaterLeg(batchId)),
    )
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

/** One lot's share of what the cargo cost us, as it stands on one truck. */
export interface LotLandedCost {
  lotId: string;
  /** End to end: this trip plus everything the cargo brought with it. */
  totalUsd: number;
  /** What THIS trip added. `totalUsd − batchUsd` is «shu reysgacha». */
  batchUsd: number;
}

/**
 * The tannarx per LOT (owner, 2026-09-24: «partiya ichidagi tovarlar
 * bo'yicha ko'rsatsin»). Exact, not apportioned: the engine already split
 * every entry down to the box, so grouping the same allocations by the box's
 * lot is a re-sum — `batchLandedCostByClient`'s question with a finer
 * GROUP BY and the same «shu reysgacha» fence.
 *
 * Membership is written as a CTE of the two indexed lookups rather than
 * `batchMemberFilter`'s OR: joined to `cost_allocations`, the OR leaves the
 * planner guessing that half of all boxes ride every truck and it scans the
 * allocations table whole (CLAUDE.md: batch membership is a JOIN through
 * box_movements). An annulled box is not cargo (the annul round).
 */
export async function batchLandedCostByLot(batchId: string): Promise<Map<string, LotLandedCost>> {
  const rows = (await db.execute(sql`
    WITH members AS (
      SELECT b.id FROM boxes b
       WHERE b.current_batch_id = ${batchId} AND b.status <> 'void'
      UNION
      SELECT bm.box_id FROM box_movements bm
        JOIN boxes b ON b.id = bm.box_id
       WHERE bm.ref_type = 'batch' AND bm.ref_id = ${batchId}
         AND bm.cause = 'batch_departed' AND b.status <> 'void'
    )
    SELECT bx.lot_id,
           coalesce(sum(ca.amount_usd), 0) AS total_usd,
           coalesce(sum(ca.amount_usd) FILTER (WHERE ${costEntries}.batch_id = ${batchId}), 0) AS batch_usd
      FROM members m
      JOIN boxes bx ON bx.id = m.id
      JOIN cost_allocations ca ON ca.box_id = m.id
      JOIN ${costEntries} ON ${costEntries}.id = ca.cost_entry_id
     WHERE ${costEntries}.voided_at IS NULL
       AND ${notLaterLeg(batchId)}
     GROUP BY bx.lot_id
  `)) as unknown as { lot_id: string; total_usd: string; batch_usd: string }[];
  return new Map(
    rows.map((row) => [
      row.lot_id,
      {
        lotId: row.lot_id,
        totalUsd: Math.round(Number(row.total_usd) * 100) / 100,
        batchUsd: Math.round(Number(row.batch_usd) * 100) / 100,
      },
    ]),
  );
}

/**
 * Cost entries touching this truck that have NO dollar figure yet — no FX
 * rate for their currency and date. The engine allocates nothing for them
 * (an allocation carries a USD amount or does not exist), so every tannarx
 * on the truck reads lower than it is, silently. The screen names the count.
 */
export async function unconvertedCostCount(batchId: string, receiptIds: string[]): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(costEntries)
    .where(
      and(
        isNull(costEntries.voidedAt),
        isNull(costEntries.amountUsd),
        receiptIds.length
          ? sql`(${costEntries.batchId} = ${batchId} OR ${inArray(costEntries.receiptId, receiptIds)})`
          : eq(costEntries.batchId, batchId),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Live cost entries attributed to this truck — its own batch-scope bills and
 * the grid's stamped prixod cells. The «rasxodini yozmading» warning (owner,
 * 2026-09-24) reads zero here; `costMissingBatches` asks the same question.
 */
export async function batchCostEntryCount(batchId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(costEntries)
    .where(and(eq(costEntries.batchId, batchId), isNull(costEntries.voidedAt)));
  return Number(row?.n ?? 0);
}

/** Batch cost sheet: entries + totals + unit costs per kg / m³. */
export async function batchCostSheet(batchId: string) {
  const entries = await db
    .select({
      entry: costEntries,
      typeName: costTypes.name,
      clientCode: clients.clientCode,
      partnerName: partners.name,
    })
    .from(costEntries)
    .innerJoin(costTypes, eq(costEntries.costTypeId, costTypes.id))
    .leftJoin(clients, eq(costEntries.clientId, clients.id))
    .leftJoin(partners, eq(costEntries.partnerId, partners.id))
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
        // A void (annulled) box is not cargo: it must not fatten the kg/m³
        // the per-unit costs divide by.
        ne(boxes.status, 'void'),
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
    // An annulled box keeps its `batch_departed` row for ever: without the
    // status clause its prixod stayed on the grid and took a customs cell
    // whose allocation pool is empty.
    .where(and(batchMemberFilter(batchId), ne(boxes.status, 'void')))
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

/** One grid cell's hint: everything on the prixod, and this truck's part of it. */
export interface GridCellWritten {
  usd: number;
  unconverted: boolean;
  /**
   * The part typed on THIS truck's grid (the entry's batch stamp, round 69).
   * A prixod split over two trucks carries both trucks' bills, and the
   * second truck must not read «already paid» off the first one's customs;
   * whatever is not stamped here — the other truck, the receipt card, the
   * wizard — is still printed beside it, because it may be the same bill.
   */
  hereUsd: number;
}

/**
 * What is ALREADY written per receipt per type (USD, non-void) — shown under
 * the grid's inputs so a second session never double-enters blind. Keyed
 * `receiptId:costTypeId`.
 */
export async function receiptCostMatrix(
  receiptIds: string[],
  batchId: string,
): Promise<Map<string, GridCellWritten>> {
  if (receiptIds.length === 0) return new Map();
  const rows = await db
    .select({
      receiptId: costEntries.receiptId,
      costTypeId: costEntries.costTypeId,
      usd: sql<string>`coalesce(sum(${costEntries.amountUsd}), 0)`,
      hereUsd: sql<string>`coalesce(sum(${costEntries.amountUsd}) FILTER (WHERE ${costEntries.batchId} = ${batchId}), 0)`,
      // A cell whose entry has no FX rate yet summed to «$0» — exactly the
      // face an EMPTY cell wears, on the hint whose whole job is stopping a
      // second session from double-entering blind (#86: unconverted money is
      // flagged, never silently zero).
      unconverted: sql<number>`count(*) FILTER (WHERE ${costEntries.amountUsd} IS NULL)`,
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
    rows.map((row) => [
      `${row.receiptId}:${row.costTypeId}`,
      {
        usd: Math.round(Number(row.usd) * 100) / 100,
        unconverted: Number(row.unconverted) > 0,
        hereUsd: Math.round(Number(row.hereUsd) * 100) / 100,
      },
    ]),
  );
}

/**
 * The truck's own BATCH-scope costs per type (non-void, USD). They cover
 * every prixod aboard and so appear in no grid cell: a truck whose customs
 * was entered once on the batch card showed an empty «Rastamojka» column,
 * which is an invitation to type the same bill a second time per prixod.
 */
export async function batchScopeCostByType(batchId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({
      costTypeId: costEntries.costTypeId,
      usd: sql<string>`coalesce(sum(${costEntries.amountUsd}), 0)`,
    })
    .from(costEntries)
    .where(
      and(
        eq(costEntries.scope, 'batch'),
        eq(costEntries.batchId, batchId),
        isNull(costEntries.voidedAt),
      ),
    )
    .groupBy(costEntries.costTypeId);
  return new Map(rows.map((row) => [row.costTypeId, Math.round(Number(row.usd) * 100) / 100]));
}

export const receiptCostGridSchema = z.object({
  batchId: z.string().uuid(),
  currency: z.string().trim().length(3).toUpperCase(),
  costDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /**
   * Who settled the whole sheet, when it was not us. One payer per save on
   * purpose — the accountant's Excel is «shu ustunlarni falon firma to'ladi»,
   * and per-cell payers would be twenty pickers on a phone. Without this the
   * grid was the ONE cost door with no payer (round 39 gave the single form
   * one), so partner-settled customs typed here landed as our own cash out
   * and the firm's ledger never heard of it.
   */
  partnerId: z.string().uuid().optional().or(z.literal('')),
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
export interface GridSaveResult {
  /** `receiptId:costTypeId` of every cell that became a cost entry. */
  saved: string[];
  /** Why the save stopped part-way; null when every cell landed. */
  error: string | null;
}

export async function addReceiptCostsBulk(
  input: ReceiptCostGridInput,
  ctx: AuditContext,
): Promise<GridSaveResult> {
  const allowed = new Set((await batchReceiptRows(input.batchId)).map((row) => row.receiptId));
  for (const cell of input.cells) {
    if (!allowed.has(cell.receiptId)) throw new CostError('receipt_not_on_batch');
  }
  // Each cell is its own `addCostEntry` — the engine cannot tell grid from
  // form (#398) and that is worth keeping — so a failure part-way leaves the
  // earlier cells saved. The answer NAMES them: the screen clears exactly
  // those and keeps the rest typed, where the old answer was a bare error and
  // the next press saved the landed cells a second time.
  const saved: string[] = [];
  for (const cell of input.cells) {
    try {
      await addGridCell(input, cell, ctx);
    } catch (err) {
      console.error('[cost-grid] cell failed after', saved.length, 'saved', err);
      return { saved, error: err instanceof CostError ? err.code : 'error' };
    }
    saved.push(`${cell.receiptId}:${cell.costTypeId}`);
  }
  return { saved, error: null };
}

async function addGridCell(
  input: ReceiptCostGridInput,
  cell: ReceiptCostGridInput['cells'][number],
  ctx: AuditContext,
) {
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
      // The engine cannot tell grid from form (#398), so the payer rides
      // the same field and derives the same partner charge per entry.
      partnerId: input.partnerId,
      // ATTRIBUTION, not scope: allocation still spreads over the RECEIPT's
      // boxes, but the entry names the truck whose grid it was typed on —
      // this is the truck's own customs bill, and without the stamp it
      // landed in NO batch's profit row: /accounting/profit showed the
      // truck's margin without the very customs typed on its own page.
      batchId: input.batchId,
    },
    ctx,
  );
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
        notLaterLeg(batchId),
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
