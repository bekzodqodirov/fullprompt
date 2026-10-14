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
  placeCostAccount,
  voidCostEntry,
} from '@/modules/wms/costing/service';
import { mayPickTill } from '@/modules/wms/accounting/till-door';
import { costSightFor } from '@/modules/wms/costing/cost-sight';
import { isStaffPartner, maySeeStaffMoney } from '@/modules/wms/partners/staff';
import { firmDebtVoidRefusal } from '@/modules/wms/partners/service';
import { amountRefusal, nativeAmount } from '@/modules/wms/finance/money-bounds';
import { mayEnterBatchCost } from '@/modules/wms/costing/cost-door';
import { copyDigest, prepareFreightCopy } from '@/modules/wms/costing/freight-copy';
import type { RebasePreview, UnsplitView } from '@/modules/wms/costing/freight-types';
import { isServerBehind, violatedCheck } from '@/modules/platform/db/errors';
import {
  costCandidateFrom,
  mustWarn,
  TwinWarning,
  twinAckOf,
  twinGap,
  type TwinGap,
  twinsForCost,
  twinsForGrid,
  twinView,
  type ReaderSight,
  type TwinView,
} from '@/modules/wms/accounting/twins';

export interface CostActionResult {
  ok: boolean;
  error?: string;
  /** The grid only: cells that DID become entries before a failure. */
  saved?: string[];
  /**
   * «Bu pul allaqachon yozilgan» (SARFLAR §3): nothing was written; the form
   * shows the twins and «Baribir saqlash» posts `twins.ackToken` back.
   */
  twins?: TwinView;
  /** A clean save that could not compare everything (§8.1, `no_rate`) — said, never hidden. */
  unchecked?: TwinGap;
  /** What a refusal's sentence NAMES (the warehouse, the column, the date). */
  params?: Record<string, string | number>;
  /** Saved, but held: the freight bill is written and on no box yet (§6). */
  unsplit?: UnsplitView;
  /** The re-basis door's first press: who moves how much (§8). */
  rebase?: RebasePreview;
  /** A re-basis whose post-commit split was queued (§8.4). */
  pending?: true;
}

/**
 * The ONE way a CostError becomes a result (docs/YOLKIRA-TAQSIMOT.md §5, T9):
 * the code AND the params the sentence needs. No catch writes the code by
 * hand — a sentence that names the warehouse cannot be one that forgot it.
 */
function costRefusal(err: CostError): CostActionResult {
  return { ok: false, error: err.code, ...(err.params ? { params: err.params } : {}) };
}

/**
 * A database one migration behind 0132 (#472): the widened basis CHECK by
 * NAME (the 0125 idiom — never a blanket 23514), or the missing side tables.
 */
const freightServerBehind = (err: unknown) =>
  isServerBehind(err) || violatedCheck(err) === 'cost_entries_basis_check';

/** The digest of the version the person's preview drew (M6), read from the RAW post. */
function freightSeenOf(input: unknown): string | null {
  const v = (input as { freightSeen?: unknown } | null)?.freightSeen;
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null;
}

const readerOf = (actor: { id: string; permissions: ReadonlySet<string> }): ReaderSight => ({
  id: actor.id,
  permissions: actor.permissions,
  ownOnly: costSightFor(actor).ownOnly,
});

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
  let warehouseId: string;
  try {
    if (parsed.data.scope === 'batch') {
      const batch = await db.query.batches.findFirst({
        where: eq(batches.id, parsed.data.batchId!),
      });
      if (!batch) return { ok: false, error: 'not_found' };
      actor = await authorize('costs.enter_batch', { warehouseId: batch.originWarehouseId });
      // The ADD door (SARFLAR §8.5): the grant held, so a refusal here is the
      // cancelled truck — the service re-asks it under the truck's lock.
      if (!mayEnterBatchCost(actor, batch)) return { ok: false, error: 'cancelled' };
      warehouseId = batch.originWarehouseId;
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
      warehouseId = pickup.destWarehouseId;
      path = `/zavod/${pickup.id}`;
    } else if (parsed.data.scope === 'crate') {
      // Same gate as the receipt-side local handling — packing money is
      // origin-warehouse money.
      const crate = await db.query.crates.findFirst({
        where: eq(crates.id, parsed.data.crateId!),
      });
      if (!crate) return { ok: false, error: 'not_found' };
      actor = await authorize('costs.enter_receipt', { warehouseId: crate.warehouseId });
      warehouseId = crate.warehouseId;
      path = `/crates/${crate.id}`;
    } else {
      const receipt = await db.query.receipts.findFirst({
        where: eq(receipts.id, parsed.data.receiptId!),
      });
      if (!receipt) return { ok: false, error: 'not_found' };
      actor = await authorize('costs.enter_receipt', { warehouseId: receipt.warehouseId });
      warehouseId = receipt.warehouseId;
      path = `/receipts/${receipt.id}`;
    }
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }

  const refused = await payerRefusal(parsed.data, actor.permissions);
  if (refused) return { ok: false, error: refused };
  const meta = await requestMeta();
  let gap: TwinGap | undefined;
  let unsplit: UnsplitView | undefined;
  try {
    // The freight basis's tariff CONFIGURATION (0132) is refused BEFORE the
    // twin warning: nobody is asked «Baribir saqlash?» about a save that
    // would then be refused. And what is frozen must be what the person saw
    // (M6): a remap or a tariff edit between the render and the press is
    // refused in words, never frozen silently. `addCostEntry` asks the same
    // door again for a hand-built call.
    const draft = await prepareFreightCopy(parsed.data);
    const seen = freightSeenOf(input);
    if (draft && seen && copyDigest(draft) !== seen) {
      return { ok: false, error: 'freight_changed', params: { column: draft.zone, from: draft.tariffFrom } };
    }
    // «Bu pul allaqachon yozilganmi?» — after the target's door and the
    // payer's, before anything is written (§8.2). Null for a reader who is
    // not the expense book's: no twin query runs for them at all.
    const twins = await twinsForCost(readerOf(actor), await costCandidateFrom(parsed.data), { warehouseId });
    if (mustWarn(twins, twinAckOf(input))) return { ok: false, twins: twinView(twins!) };
    const entry = await addCostEntry(parsed.data, { actorId: actor.id, ...meta }, { twinAck: twins?.ids.length ? twins.ids : undefined });
    gap = twinGap(twins);
    if (entry.verdict?.kind === 'held') unsplit = { held: entry.verdict.held };
  } catch (err) {
    if (err instanceof CostError) return costRefusal(err);
    if (freightServerBehind(err)) return { ok: false, error: 'server_behind' };
    throw err;
  }
  revalidatePath(path);
  return { ok: true, ...(gap ? { unchecked: gap } : {}), ...(unsplit ? { unsplit } : {}) };
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
  // The same ADD door as the truck's own bills (§8.5): the grid stamps every
  // cell onto this truck.
  if (!mayEnterBatchCost(actor, batch)) return { ok: false, error: 'cancelled' };

  const refused = await payerRefusal(parsed.data, actor.permissions);
  if (refused) return { ok: false, error: refused };
  const meta = await requestMeta();
  const grid = parsed.data;
  const reader = readerOf(actor);
  const posted = twinAckOf(input);
  let gridGap: TwinGap | undefined;
  let result;
  try {
    result = await addReceiptCostsBulk(
      grid,
      { actorId: actor.id, ...meta },
      {
        // ONE warning for the sheet, over every posted cell, after the bulk
        // save's own refusals and before the first cell is written (§3).
        beforeWrite: async () => {
          const cells = [];
          for (const cell of grid.cells) {
            cells.push(
              await costCandidateFrom(
                {
                  scope: 'receipt',
                  receiptId: cell.receiptId,
                  costTypeId: cell.costTypeId,
                  amount: cell.amount,
                  currency: grid.currency,
                  costDate: grid.costDate,
                  accountId: grid.accountId || undefined,
                  partnerId: grid.partnerId || undefined,
                },
                grid.batchId,
              ),
            );
          }
          const twins = await twinsForGrid(reader, cells, { warehouseId: batch.originWarehouseId });
          if (mustWarn(twins, posted)) throw new TwinWarning(twins!);
          gridGap = twinGap(twins);
          return twins?.ids.length ? twins.ids : undefined;
        },
      },
    );
  } catch (err) {
    if (err instanceof TwinWarning) return { ok: false, twins: twinView(err.answer) };
    if (err instanceof CostError) return costRefusal(err);
    throw err;
  }
  // The grid has its own page now (round 47); revalidating the card alone
  // left the grid's «≈ written» hints a save behind.
  revalidatePath(`/batches/${batch.id}`);
  revalidatePath(`/batches/${batch.id}/xarajatlar`);
  return result.error
    ? { ok: false, error: result.error, saved: result.saved }
    : { ok: true, saved: result.saved, ...(gridGap ? { unchecked: gridGap } : {}) };
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

  // A MERGED cost (Q8) is nobody's to void until the merge is undone — the
  // service refuses it for everyone. Asked FIRST, so each reader is told what
  // to do in words that fit who they are: the kassa holder undoes the merge
  // (the ↩ beside the row), anybody else asks the accountant.
  if (entry.mergedExpenseId) {
    return { ok: false, error: mayPickTill(actor.permissions) ? 'merged_cost' : 'merged_cost_ask' };
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
      { mayMoveTill: mayPickTill(actor.permissions), payerSeen: entry.partnerId },
    );
  } catch (err) {
    if (err instanceof CostError) return costRefusal(err);
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
  // The queue PLACES, it never clears: moving or clearing a cost's kassa is
  // the service's correction path (`setCostAccount`), not a queue press.
  accountId: z.string().uuid(),
  // The shared bound (U44) — the literal 1e12 was one unit past the column.
  accountAmount: nativeAmount().optional(),
});

/**
 * The accountant's place-later door (0101): which kassa a cost's money left
 * from, said after the warehouse or the logist typed the cost. The kassa
 * holders' grant only — the same `mayPickTill` the entry doors ask. A CLAIM
 * under the queue's own predicate (`placeCostAccount`, Q8): a second press or
 * a stale screen is told `already_placed`, never moves money twice.
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
    await placeCostAccount(parsed.data.id, parsed.data.accountId, parsed.data.accountAmount, {
      actorId: actor.id,
      ...meta,
    });
  } catch (err) {
    if (err instanceof CostError) return costRefusal(err);
    throw err;
  }
  revalidatePath('/accounting/xarajat-kassa');
  revalidatePath('/accounting/accounts');
  return { ok: true };
}
