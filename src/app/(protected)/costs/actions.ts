'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { batches, costEntries, crates, pickups, receipts } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  addCostEntry,
  addReceiptCostsBulk,
  CostError,
  costEntrySchema,
  receiptCostGridSchema,
  setCostAccount,
  voidCostEntry,
} from '@/modules/wms/costing/service';
import { mayPickTill } from '@/modules/wms/accounting/till-door';
import { costSightFor } from '@/modules/wms/costing/cost-sight';
import { isStaffPartner, maySeeStaffMoney } from '@/modules/wms/partners/staff';
import { firmDebtVoidRefusal } from '@/modules/wms/partners/service';
import { amountRefusal, nativeAmount } from '@/modules/wms/finance/money-bounds';

export interface CostActionResult {
  ok: boolean;
  error?: string;
  /** The grid only: cells that DID become entries before a failure. */
  saved?: string[];
}

/**
 * The two payer rules every cost door asks AFTER its own grant (0101):
 * a kassa is named only by the kassa holders (`mayPickTill`, owner M2a), and
 * a colleague's staff account only by those who may see staff money (M3a) —
 * «o'z pulimdan to'ladim» is said through the rasxod xabari, never picked on
 * a cost form (M1a). The select offers neither to anybody else; this is the
 * same refusal for a hand-built post (#531).
 */
async function payerRefusal(
  input: { partnerId?: string; accountId?: string },
  permissions: ReadonlySet<string>,
): Promise<string | null> {
  if (input.accountId && !mayPickTill(permissions)) return 'till_forbidden';
  if (input.partnerId && !maySeeStaffMoney(permissions) && (await isStaffPartner(input.partnerId))) {
    return 'staff_payer_forbidden';
  }
  return null;
}

export async function addCostEntryAction(input: unknown): Promise<CostActionResult> {
  const parsed = costEntrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: amountRefusal(parsed.error) ?? 'validation' };

  let path: string;
  let actor;
  try {
    if (parsed.data.scope === 'batch') {
      const batch = await db.query.batches.findFirst({
        where: eq(batches.id, parsed.data.batchId!),
      });
      if (!batch) return { ok: false, error: 'not_found' };
      actor = await authorize('costs.enter_batch', { warehouseId: batch.originWarehouseId });
      path = `/batches/${batch.id}`;
    } else if (parsed.data.scope === 'pickup') {
      // The factory truck (0100): hired by the logist, paid by whoever pays
      // trucks — the same grant as a batch's freight, at the warehouse the
      // truck is bringing the cargo to.
      const pickup = await db.query.pickups.findFirst({
        where: eq(pickups.id, parsed.data.pickupId!),
      });
      if (!pickup) return { ok: false, error: 'not_found' };
      if (pickup.status === 'cancelled') return { ok: false, error: 'cancelled' };
      actor = await authorize('costs.enter_batch', { warehouseId: pickup.destWarehouseId });
      path = `/zavod/${pickup.id}`;
    } else if (parsed.data.scope === 'crate') {
      // Same gate as the receipt-side local handling — packing money is
      // origin-warehouse money.
      const crate = await db.query.crates.findFirst({
        where: eq(crates.id, parsed.data.crateId!),
      });
      if (!crate) return { ok: false, error: 'not_found' };
      actor = await authorize('costs.enter_receipt', { warehouseId: crate.warehouseId });
      path = `/crates/${crate.id}`;
    } else {
      const receipt = await db.query.receipts.findFirst({
        where: eq(receipts.id, parsed.data.receiptId!),
      });
      if (!receipt) return { ok: false, error: 'not_found' };
      actor = await authorize('costs.enter_receipt', { warehouseId: receipt.warehouseId });
      path = `/receipts/${receipt.id}`;
    }
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }

  const refused = await payerRefusal(parsed.data, actor.permissions);
  if (refused) return { ok: false, error: refused };
  const meta = await requestMeta();
  try {
    await addCostEntry(parsed.data, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof CostError) return { ok: false, error: err.code };
    throw err;
  }
  revalidatePath(path);
  return { ok: true };
}

/**
 * The receipt-cost grid's one save (round 29). Gated like the batch costs
 * panel — the person doing customs at the batch — and the service re-proves
 * every receipt's membership before a single entry is written.
 */
export async function saveReceiptCostGridAction(input: unknown): Promise<CostActionResult> {
  const parsed = receiptCostGridSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: amountRefusal(parsed.error) ?? 'validation' };

  const batch = await db.query.batches.findFirst({ where: eq(batches.id, parsed.data.batchId) });
  if (!batch) return { ok: false, error: 'not_found' };
  let actor;
  try {
    actor = await authorize('costs.enter_batch', { warehouseId: batch.originWarehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }

  const refused = await payerRefusal(parsed.data, actor.permissions);
  if (refused) return { ok: false, error: refused };
  const meta = await requestMeta();
  let result;
  try {
    result = await addReceiptCostsBulk(parsed.data, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof CostError) return { ok: false, error: err.code };
    throw err;
  }
  // The grid has its own page now (round 47); revalidating the card alone
  // left the grid's «≈ written» hints a save behind.
  revalidatePath(`/batches/${batch.id}`);
  revalidatePath(`/batches/${batch.id}/xarajatlar`);
  return result.error
    ? { ok: false, error: result.error, saved: result.saved }
    : { ok: true, saved: result.saved };
}

const voidSchema = z.object({
  id: z.string().uuid(),
  reason: z.string().trim().min(2).max(500),
});

export async function voidCostEntryAction(input: unknown): Promise<CostActionResult> {
  const parsed = voidSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };

  const entry = await db.query.costEntries.findFirst({
    where: eq(costEntries.id, parsed.data.id),
  });
  if (!entry) return { ok: false, error: 'not_found' };

  let actor;
  try {
    if (entry.scope === 'batch' && entry.batchId) {
      const batch = await db.query.batches.findFirst({ where: eq(batches.id, entry.batchId) });
      actor = await authorize('costs.enter_batch', { warehouseId: batch?.originWarehouseId });
    } else if (entry.scope === 'crate' && entry.crateId) {
      const crate = await db.query.crates.findFirst({ where: eq(crates.id, entry.crateId) });
      actor = await authorize('costs.enter_receipt', { warehouseId: crate?.warehouseId });
    } else if (entry.scope === 'pickup' && entry.pickupId) {
      // Without this branch a truck's cost fell into the receipt one below,
      // found no receipt and answered `not_found` — uncancellable money.
      const pickup = await db.query.pickups.findFirst({ where: eq(pickups.id, entry.pickupId) });
      if (!pickup) return { ok: false, error: 'not_found' };
      actor = await authorize('costs.enter_batch', { warehouseId: pickup.destWarehouseId });
    } else {
      const receipt = entry.receiptId
        ? await db.query.receipts.findFirst({ where: eq(receipts.id, entry.receiptId) })
        : null;
      if (!receipt) return { ok: false, error: 'not_found' };
      actor = await voidReceiptCostDoor(receipt.warehouseId, entry.batchId);
    }
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }

  // A reader who sees only their OWN cost entries (the VED, owner's Q19 D1)
  // cannot void one they cannot see: the card never draws a colleague's row
  // for them, so a post naming one is hand-built. Their own typo stays theirs
  // to take back.
  if (costSightFor(actor).ownOnly && entry.enteredBy !== actor.id) {
    return { ok: false, error: 'cost_not_yours' };
  }

  // A cost paid out of a kassa: voiding it puts the money BACK into the till
  // — a cash movement, and the kassa holders' alone (0101). The warehouse and
  // the logist may still void the costs they typed with no kassa.
  if (entry.accountId && !mayPickTill(actor.permissions)) {
    return { ok: false, error: 'kassa_cost_needs_finance' };
  }
  // A cost a COLLEAGUE paid out of their own pocket: voiding it takes the
  // company's debt to that person off their staff account — staff money,
  // which the owner gave to the accountant and the admin alone (M3a, #1020),
  // the same pair `staffDoor` and `payerRefusal` ask. Without this a
  // warehouse user's void bypassed that door and the colleague's /profile
  // said he owed the company (U34).
  if (entry.partnerId && !maySeeStaffMoney(actor.permissions) && (await isStaffPartner(entry.partnerId))) {
    return { ok: false, error: 'staff_cost_needs_finance' };
  }
  // A cost a FIRM paid (owner's answer B, 2026-09-25): the person who typed
  // it may take back their own typo until the firm's account has moved after
  // it; from then on the void reopens money already settled against — a paid
  // firm would read as owing US — so it is the accountant's and the admin's
  // (the kassa holders' grant, the same people who pay the firm).
  if (entry.partnerId) {
    const refusal = await firmDebtVoidRefusal(actor, {
      partnerId: entry.partnerId,
      costEntryId: entry.id,
      expenseId: null,
      costEnteredBy: entry.enteredBy,
    });
    if (refusal) return { ok: false, error: refusal };
  }
  const meta = await requestMeta();
  try {
    // The kassa gate above read the row BEFORE this; the service re-judges it
    // in its own UPDATE, so a cost placed into a till in between is refused
    // there and not voided back into the drawer (Q19 review).
    await voidCostEntry(
      parsed.data.id,
      parsed.data.reason,
      { actorId: actor.id, ...meta },
      { mayMoveTill: mayPickTill(actor.permissions) },
    );
  } catch (err) {
    if (err instanceof CostError) return { ok: false, error: err.code };
    throw err;
  }
  if (entry.batchId) revalidatePath(`/batches/${entry.batchId}`);
  if (entry.receiptId) revalidatePath(`/receipts/${entry.receiptId}`);
  if (entry.crateId) revalidatePath(`/crates/${entry.crateId}`);
  if (entry.pickupId) revalidatePath(`/zavod/${entry.pickupId}`);
  return { ok: true };
}

/**
 * Who may void a PRIXOD cost. The receipt card's door — costs.enter_receipt
 * at the receipt's warehouse — and, for a cell typed on a truck's grid (the
 * entry carries that truck as attribution), ALSO the grid's own door:
 * costs.enter_batch at the truck's origin. Before, the logist or VED who
 * typed a customs cell on the grid could not take it back, while a
 * warehouse operator at the prixod's warehouse could. A missing receipt is
 * refused above rather than authorised with no warehouse, which
 * `authorize()` reads as «any warehouse» (it failed OPEN).
 */
async function voidReceiptCostDoor(receiptWarehouseId: string, stampedBatchId: string | null) {
  try {
    return await authorize('costs.enter_receipt', { warehouseId: receiptWarehouseId });
  } catch (err) {
    if (!(err instanceof AuthError) || !stampedBatchId) throw err;
    const batch = await db.query.batches.findFirst({ where: eq(batches.id, stampedBatchId) });
    if (!batch) throw err;
    return authorize('costs.enter_batch', { warehouseId: batch.originWarehouseId });
  }
}

const placeSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid().nullable(),
  // The shared bound (U44) — the literal 1e12 was one unit past the column.
  accountAmount: nativeAmount().optional(),
});

/**
 * The accountant's place-later door (0101): which kassa a cost's money left
 * from, said after the warehouse or the logist typed the cost. The kassa
 * holders' grant only — the same `mayPickTill` the entry doors ask.
 */
export async function setCostAccountAction(input: unknown): Promise<CostActionResult> {
  const parsed = placeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: amountRefusal(parsed.error) ?? 'validation' };
  let actor;
  try {
    actor = await authorize('finance.expenses');
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
  if (!mayPickTill(actor.permissions)) return { ok: false, error: 'till_forbidden' };
  const meta = await requestMeta();
  try {
    await setCostAccount(parsed.data.id, parsed.data.accountId, parsed.data.accountAmount, {
      actorId: actor.id,
      ...meta,
    });
  } catch (err) {
    if (err instanceof CostError) return { ok: false, error: err.code };
    throw err;
  }
  revalidatePath('/accounting/xarajat-kassa');
  revalidatePath('/accounting/accounts');
  return { ok: true };
}
