import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Db, type Tx } from '../../platform/db/client';
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
  moneyAccounts,
  partnerTransactions,
  pickups,
  receiptLots,
  receipts,
  settings,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { getSetting } from '../../platform/settings/service';
import { tashkentDayStart } from '../../platform/time/tashkent';
import { latestTxDate } from '../finance/dates';
import { exceedsRowUsd, nativeAmount } from '../finance/money-bounds';
import { allocateEntry, toUsd, type AllocBox, type AllocationBasis } from './engine';
import { leftBehindSql, riderCtesSql, riderFilter, riderLoad } from '../batches/riders';
import { internalLegSql } from '../batches/internal';
import { CUSTOMS_CODES_SETTING, parseCustomsCodes } from '../calc/customs-codes';

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
  // The column's bound in every currency (U44); the dollar ceiling is the
  // service's, where the rate is known.
  amount: nativeAmount(),
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
  /**
   * The kassa the money LEFT from (0101, owner 3b). Exclusive with the payer.
   * `accountAmount` is what left it in the KASSA's currency — required when
   * the kassa speaks another currency than the cost (customs typed in USD,
   * paid out of the firm's som account), the amount itself otherwise.
   */
  accountId: z.string().uuid().optional().or(z.literal('')),
  // numeric(14,2) like every amount — 1e12 was one unit past the column (U44).
  accountAmount: nativeAmount().optional(),
  note: z.string().trim().max(2000).optional().or(z.literal('')),
});

/**
 * A kassa a cost may name: it exists and is open. Read on the POOL before any
 * transaction (#714). The currency is returned so the caller can decide the
 * kassa-side amount.
 */
export async function assertTill(accountId: string): Promise<{ currency: string }> {
  const [till] = await db
    .select({ currency: moneyAccounts.currency, active: moneyAccounts.active })
    .from(moneyAccounts)
    .where(eq(moneyAccounts.id, accountId))
    .limit(1);
  if (!till || !till.active) throw new CostError('account_not_found');
  return { currency: till.currency };
}

/**
 * What left the kassa, in the kassa's own currency. The same currency: the
 * cost's amount (a typed figure that differs is a typo — refused, not
 * silently preferred). Another currency: the person must say it, because
 * only the bank statement knows the rate the bank used.
 */
export function tillAmountFor(
  cost: { amount: number; currency: string },
  tillCurrency: string,
  typed: number | undefined,
): number {
  if (tillCurrency === cost.currency) {
    if (typed !== undefined && Math.abs(typed - cost.amount) > 0.004) {
      throw new CostError('account_amount_mismatch');
    }
    return cost.amount;
  }
  if (typed === undefined || !Number.isFinite(typed) || typed <= 0) {
    throw new CostError('account_amount_required');
  }
  return typed;
}

export async function addCostEntry(input: z.infer<typeof costEntrySchema>, ctx: AuditContext) {
  if (!ctx.actorId) throw new CostError('unauthenticated');
  if (input.scope === 'receipt' && !input.receiptId) throw new CostError('validation');
  if (input.scope === 'batch' && !input.batchId) throw new CostError('validation');
  if (input.scope === 'crate' && !input.crateId) throw new CostError('validation');
  if (input.scope === 'pickup' && !input.pickupId) throw new CostError('validation');
  if (input.allocationBasis === 'direct_to_client' && !input.clientId) {
    throw new CostError('client_required');
  }
  // #995's rule (U21): a cost dated next month entered the tannarx, the P&L
  // month and — kassa-paid — the drawer today. Tomorrow stays open for a
  // Chinese warehouse already past midnight.
  if (input.costDate > latestTxDate()) throw new CostError('future_date');
  // The dollar ceiling where a rate is known (U44). Unconverted, the
  // conversion itself refuses it later (`recomputeEntry`).
  const entryRate = await rateFor(input.currency, input.costDate);
  if (entryRate !== null && exceedsRowUsd(input.amount * entryRate)) {
    throw new CostError('amount_too_large');
  }
  // Naming a payer means recording a DEBT, and a debt with no dollar figure
  // cannot be recorded: `chargeForCost` returns silently when the conversion
  // is missing, so the cost row would go on showing the firm's name while
  // that firm's account never heard of it. `addPartnerTx` and `addExpense`
  // already refuse the same way — this path did not.
  if (input.partnerId && entryRate === null) {
    throw new CostError('fx_missing');
  }
  // Who paid is ONE of: a counterparty (a debt) or a kassa (cash out) — or
  // nobody has said yet, which is the accountant's queue (the DB's
  // cost_entries_payer_check says the same).
  if (input.partnerId && input.accountId) throw new CostError('payer_conflict');
  let accountAmount: number | null = null;
  if (input.accountId) {
    const till = await assertTill(input.accountId);
    accountAmount = tillAmountFor(input, till.currency, input.accountAmount);
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
      accountId: input.accountId || null,
      accountAmount: accountAmount === null ? null : String(accountAmount),
      note: input.note || null,
      enteredBy: ctx.actorId,
    })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'cost_entry',
    entityId: entry!.id,
    action: 'create',
    after: {
      scope: input.scope,
      amount: input.amount,
      currency: input.currency,
      ...(input.accountId ? { accountId: input.accountId, accountAmount } : {}),
    },
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

/**
 * A cost nobody has said the kassa of (0101): live, no counterparty, no
 * kassa, not merged into an expense — and entered on or after
 * `cost_kassa_since`. ONE predicate for the queue screen, the accountant's
 * home counter and the Balans line (#513). The bound is the deploy day the
 * migration wrote: every older cost has no kassa BY CONSTRUCTION and is
 * inside some till's counted opening, so placing it would debit the drawer a
 * second time (the design judge's blocker).
 */
export function unplacedCostSql(since: string): SQL {
  return and(
    isNull(costEntries.voidedAt),
    isNull(costEntries.partnerId),
    isNull(costEntries.accountId),
    isNull(costEntries.mergedExpenseId),
    /^\d{4}-\d{2}-\d{2}$/.test(since)
      ? sql`${costEntries.createdAt} >= ${tashkentDayStart(since).toISOString()}::timestamptz`
      : undefined,
  )!;
}

/** The queue's start day, as the setting holds it ('' = no bound). */
export async function unplacedCostSince(): Promise<string> {
  const value = String((await getSetting('cost_kassa_since')) ?? '');
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

/** How many costs wait for a kassa, and their dollars — the counter and the Balans. */
export async function unplacedCostTotals() {
  const since = await unplacedCostSince();
  const [row] = await db
    .select({
      n: sql<number>`count(*)::int`,
      usd: sql<string>`coalesce(sum(coalesce(${costEntries.amountUsd}, 0)), 0)`,
    })
    .from(costEntries)
    .where(unplacedCostSql(since));
  return { count: Number(row?.n ?? 0), usd: Math.round(Number(row?.usd ?? 0) * 100) / 100 };
}

/**
 * Say, afterwards, which kassa a cost's money left from — or that it left
 * none (`accountId` null clears it). The accountant's place-later door
 * (0101): the warehouse and the logist type costs and hold no kassa grant,
 * so their costs arrive with no kassa and wait in the queue.
 *
 * A CLAIM, like `placePayment`: the UPDATE demands the cost is live and has
 * no counterparty, so a stale screen cannot put a partner-settled cost into
 * a kassa as well (that would be the double debit #528 was about).
 */
export async function setCostAccount(
  costId: string,
  accountId: string | null,
  typedAmount: number | undefined,
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new CostError('unauthenticated');
  const entry = await db.query.costEntries.findFirst({ where: eq(costEntries.id, costId) });
  if (!entry) throw new CostError('not_found');
  if (entry.voidedAt) throw new CostError('already_voided');
  if (entry.partnerId) throw new CostError('payer_conflict');
  let accountAmount: number | null = null;
  if (accountId) {
    const till = await assertTill(accountId);
    accountAmount = tillAmountFor(
      { amount: Number(entry.amount), currency: entry.currency },
      till.currency,
      typedAmount,
    );
  }
  const [row] = await db
    .update(costEntries)
    .set({
      accountId,
      accountAmount: accountAmount === null ? null : String(accountAmount),
      updatedAt: new Date(),
    })
    .where(and(eq(costEntries.id, costId), isNull(costEntries.voidedAt), isNull(costEntries.partnerId)))
    .returning({ id: costEntries.id });
  if (!row) throw new CostError('payer_conflict');
  await writeAudit(db, ctx, {
    entityType: 'cost_entry',
    entityId: costId,
    action: 'update',
    before: { accountId: entry.accountId, accountAmount: entry.accountAmount },
    after: { accountId, accountAmount },
  });
}

/**
 * «A colleague paid this out of pocket» — said by the ACCOUNTANT on the
 * queue (0101, owner M1a: the staff member says it through the rasxod
 * xabari, the accountant confirms). The cost gets the colleague's staff
 * account as its payer, which posts the debt through the ordinary
 * `chargeForCost` — one writer of that charge, whichever door asked.
 */
export async function setCostStaffPayer(costId: string, partnerId: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new CostError('unauthenticated');
  const { isStaffPartner } = await import('../partners/staff');
  if (!(await isStaffPartner(partnerId))) throw new CostError('not_staff');
  const entry = await db.query.costEntries.findFirst({ where: eq(costEntries.id, costId) });
  if (!entry) throw new CostError('not_found');
  // A debt needs a dollar figure (the entry-time rule, #427).
  if (entry.amountUsd === null) throw new CostError('fx_missing');
  const [row] = await db
    .update(costEntries)
    .set({ partnerId, updatedAt: new Date() })
    .where(
      and(
        eq(costEntries.id, costId),
        isNull(costEntries.voidedAt),
        isNull(costEntries.partnerId),
        isNull(costEntries.accountId),
        isNull(costEntries.mergedExpenseId),
      ),
    )
    .returning({ id: costEntries.id });
  if (!row) throw new CostError('payer_conflict');
  await writeAudit(db, ctx, {
    entityType: 'cost_entry',
    entityId: costId,
    action: 'update',
    before: { partnerId: null },
    after: { partnerId, from: 'staff_own_pocket' },
  });
  const { chargeForCost } = await import('../partners/link');
  await chargeForCost(costId, ctx);
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

/**
 * Per-box kg/m³ pro-rated from the lot; client from the receipt. Ordered by
 * box id so the same base always splits the same way — with the largest
 * remainder the order decides only who carries a single $0.0001, but an
 * unordered list made even that arbitrary between two recomputes.
 */
export async function boxDims(boxIds: string[], handle: Db | Tx = db): Promise<BoxDims[]> {
  if (boxIds.length === 0) return [];
  const rows = await handle
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
    .where(inArray(boxes.id, boxIds))
    .orderBy(asc(boxes.id));
  return rows.map((r) => ({
    boxId: r.boxId,
    clientId: r.clientId,
    weightKg: Number(r.totalWeightKg) / r.boxCount,
    volumeM3: Number(r.totalVolumeM3) / r.boxCount,
  }));
}

/**
 * The cost types that are «rastamojka» — the ONE list the calc control
 * already reads (`calc_customs_cost_type_codes`, parsed by
 * `calc/customs-codes.ts` for both readers; DATA because the owner mints his
 * own types), resolved to ids. On the caller's handle: the recompute asks it
 * from inside its own transaction, where a pool read is #714's freeze — so
 * the setting row is read directly and not through `getSetting`.
 */
export async function customsCostTypeIds(handle: Db | Tx = db): Promise<string[]> {
  const [row] = await handle
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, CUSTOMS_CODES_SETTING));
  const codes = parseCustomsCodes(row?.value);
  const types = await handle.select({ id: costTypes.id }).from(costTypes).where(inArray(costTypes.code, codes));
  return types.map((type) => type.id);
}

/**
 * The boxes a truck's bill is split over. A ROAD cost — freight and every
 * other non-customs bill — covers what rode it (`riderFilter`). A CUSTOMS
 * bill covers the truck's DECLARATION, i.e. its manifest: a carton scanned
 * aboard and found back at the origin was declared and its customs was paid,
 * so it keeps that share, and when it rides the next truck the share rides
 * with it as «shu reysgacha» and is billed there (owner, 2026-09-25: «a
 * mashinaga yuklanganda … ywda qolib ketgani aniqlansa uni yolkira narxi
 * yozilmasin, b partiyada yozilsin, lekin rastamojka qilib qoygan bolsak shu
 * rastamojka narxi ham partiyada yozilishi kerak»).
 */
function truckBaseSql(batchId: string, customs: boolean): SQL {
  return customs
    ? or(riderFilter(batchId), leftBehindSql(sql`${batchId}::uuid`, 'boxes'))!
    : riderFilter(batchId);
}

/**
 * Boxes in an entry's scope: receipt → its boxes; crate → its boxes; batch →
 * everything that rode it. `handle` is the recompute's own transaction (the
 * base is read under the entry's lock, so the last writer is also the
 * freshest) or a door's guard asking «would this void leave the money on no
 * box»; everything else reads on the pool.
 */
export async function scopeBoxIds(
  entry: typeof costEntries.$inferSelect,
  handle: Db | Tx = db,
): Promise<string[]> {
  if (entry.scope === 'receipt' && entry.receiptId && entry.batchId) {
    // A grid cell (the only writer of a receipt entry stamped with a truck)
    // is THAT truck's part of the prixod — #979's «hereUsd» hint already
    // reads it so. #532 spread it over the whole prixod as «attribution, not
    // scope», which was harmless while the truck report summed stamped
    // entries and wrong once it read allocations (R2a): a prixod split over
    // two trucks put half of each truck's customs on the other truck's
    // boxes, and the half on cargo that rode EARLIER was on no truck at all
    // (audit U18). Only its cargo that rode that truck carries it — and when
    // none did (a cell typed before anything was loaded, or on cargo that
    // never went), it stays on the prixod as before: an empty scope would
    // let the annul's empty-scope sweep void another prixod's customs. A
    // customs cell covers the prixod's DECLARED cartons, the truck bill's
    // own rule (`truckBaseSql`).
    const customs = (await customsCostTypeIds(handle)).includes(entry.costTypeId);
    const aboard = await handle
      .select({ id: boxes.id })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .where(
        and(
          eq(receiptLots.receiptId, entry.receiptId),
          ne(boxes.status, 'void'),
          truckBaseSql(entry.batchId, customs),
        ),
      );
    if (aboard.length) return aboard.map((r) => r.id);
  }
  if (entry.scope === 'receipt' && entry.receiptId) {
    // NOT the void ones. A lot-edit shrink voids the miscounted surplus, and
    // a share left (or re-swept) onto a void box is money on a box that never
    // existed: the batch pricing screen reads shares through membership a
    // shelf-voided box can never have, so «totalUsd» — the number a price has
    // to beat — understated by exactly the phantom boxes' share, while
    // profit-by-client (no box join) still counted all of it. Issued, loaded,
    // in-transit boxes all KEEP their shares — they are real cargo the money
    // was spent on; only `void` says «this box was a counting mistake».
    const rows = await handle
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
    const packed = await handle
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
    const live = await handle.select({ id: boxes.id }).from(boxes).where(eq(boxes.crateId, entry.crateId));
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
    const rows = await handle
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
    // What really rode it (`batches/riders.ts`): the departed boxes, minus a
    // carton found back at the origin (it paid the freight of a truck it
    // never boarded, U17), plus one that rode without a load scan (it paid
    // none, U25); before departure, the loaded/reserved members, so an
    // early-entered cost still shows. Minus the `void` ones (the annul
    // round, completing #530): a box voided after departing was a counting
    // mistake riding a real truck, and its share belongs to the cargo that
    // actually was on board. Deliberate for OLD data too — each of these
    // bases re-splits the next time the truck's costs are recomputed. A
    // customs bill keeps the found-back carton (`truckBaseSql`).
    const customs = (await customsCostTypeIds(handle)).includes(entry.costTypeId);
    const base = await handle
      .select({ id: boxes.id })
      .from(boxes)
      .where(and(truckBaseSql(entry.batchId, customs), ne(boxes.status, 'void')));
    return base.map((r) => r.id);
  }
  return [];
}

/**
 * Rebuild one entry's USD conversion + per-box allocation rows.
 *
 * ONE transaction holding the entry's row lock (audit U41). It used to be
 * four autocommitted statements — convert, DELETE the shares, re-read the
 * base, INSERT — so a process killed in between (a deploy restart, a failed
 * read) left a converted cost with NO shares: still in the P&L, gone from
 * every tannarx, and no sweep looked for it. And two recomputes of one entry
 * at once (two lot corrections on one truck, a correction during the depart
 * job) collided on the (entry, box) unique index: the loser threw 23505
 * after its warehouse correction had already committed, and in one measured
 * round in twenty the survivor was the one that had read the OLD weights.
 * Under the lock the second recompute waits, then reads the base the first
 * one left behind — the last writer is also the freshest.
 *
 * The setting and the rate are read on the POOL before the transaction
 * opens: a pool read inside it is #714's freeze (tests/unit/tx-pool.test.ts).
 * Reading the rate early is safe because an entry's currency, date and
 * amount have no edit door — a correction is void and re-enter.
 */
export async function recomputeEntry(costEntryId: string): Promise<void> {
  const peek = await db.query.costEntries.findFirst({ where: eq(costEntries.id, costEntryId) });
  if (!peek) return;
  const factor = Number(await getSetting('chargeable_weight_factor'));
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
  const frozenWhenPeeked = peek.amountUsd !== null && peek.fxRateUsed !== null;
  const rate =
    !peek.voidedAt && !frozenWhenPeeked ? await rateFor(peek.currency, peek.costDate) : undefined;

  const settled = await db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(costEntries)
      .where(eq(costEntries.id, costEntryId))
      .for('update');
    if (!entry) return null;
    // A void that committed first wins: it deleted the shares, and a
    // recompute that read the entry before it must not put them back.
    if (entry.voidedAt) {
      await tx.delete(costAllocations).where(eq(costAllocations.costEntryId, costEntryId));
      return null;
    }
    let amountUsd: number | null;
    const frozen = entry.amountUsd !== null && entry.fxRateUsed !== null;
    if (frozen) {
      // Somebody else's conversion may have landed while we waited — the
      // FIRST conversion wins (R1), so it is used as found.
      amountUsd = Number(entry.amountUsd);
    } else if (rate === undefined) {
      // Frozen when peeked, unfrozen under the lock: nothing un-freezes a
      // cost, so this is a state no door writes. Leave the row as it stands
      // rather than read a rate on the pool from inside the transaction.
      return entry;
    } else {
      amountUsd = rate !== null ? toUsd(Number(entry.amount), rate) : null;
      // Past the per-row dollar ceiling (U44) the figure is not written: an
      // allocation row is numeric(14,4) and would overflow inside this very
      // recompute. It stays «no dollars yet», which every report names, and
      // is corrected by void and re-entry like any other typo.
      if (amountUsd !== null && exceedsRowUsd(amountUsd)) {
        console.error('[costing] conversion past the per-row ceiling left unconverted', costEntryId);
        amountUsd = null;
      }
      await tx
        .update(costEntries)
        .set({
          amountUsd: amountUsd !== null ? String(amountUsd) : null,
          // Both or neither: a rate stamped beside no dollars would read as a
          // conversion that happened.
          fxRateUsed: amountUsd !== null && rate !== null ? String(rate) : null,
        })
        .where(eq(costEntries.id, costEntryId));
    }

    // The base is read INSIDE the lock, before the old shares go: whatever a
    // concurrent correction committed while we waited is what we split over.
    const ids = amountUsd === null ? [] : await scopeBoxIds(entry, tx);
    const dims = await boxDims(ids, tx);
    await tx.delete(costAllocations).where(eq(costAllocations.costEntryId, costEntryId));
    if (amountUsd === null) return entry; // unconverted — reports flag it

    const pool: AllocBox[] = dims.map((d) => ({
      ...d,
      chargeableKg: Math.max(d.weightKg, d.volumeM3 * factor),
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
      await tx.insert(costAllocations).values(
        shares.map((s) => ({
          costEntryId,
          boxId: s.boxId,
          clientId: s.clientId,
          amountUsd: String(s.amountUsd),
        })),
      );
    }
    return entry;
  });

  // The debt this cost owes its payer, posted the moment a dollar figure
  // exists. Rows entered before the entry-time refusal above shipped — and
  // any row whose rate arrived later — are repaired by the /admin/fx
  // recompute and the nightly unconverted sweep, which convert them once.
  // `chargeForCost` is idempotent per cost, so a re-run costs nothing. After
  // the commit, never inside it: the partner side reads on the pool.
  if (settled?.partnerId) {
    try {
      const { chargeForCost } = await import('../partners/link');
      await chargeForCost(costEntryId, { actorId: settled.enteredBy });
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
  /**
   * The nightly repair of a split that went wrong (audits U20/U41), OR-ed
   * like `pickups`: a converted cost with NO share at all (a recompute that
   * died between its old DELETE and INSERT, before it was one transaction),
   * and a cost with a share still sitting on a VOID box (voidReceipt and the
   * box card never re-split — money on a box that was a counting mistake,
   * counted by every client-side report and dropped by the truck-side ones).
   * A cost whose base is legitimately empty (a direct_to_client fee on a
   * client with no box in scope, a truck cost typed before anything was
   * reserved) is re-swept every night for nothing — cheap and idempotent,
   * and it is NEVER voided here: the empty-scope void is the annul's alone
   * (#848), and the pickup scope is kept out of even that (#1004).
   */
  orphaned?: boolean;
}) {
  const repairs = [
    filter?.unconverted ? isNull(costEntries.amountUsd) : undefined,
    filter?.pickups ? eq(costEntries.scope, 'pickup') : undefined,
    filter?.orphaned
      ? sql`((${costEntries.amountUsd} IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM cost_allocations ca WHERE ca.cost_entry_id = ${costEntries}.id))
          OR EXISTS (
            SELECT 1 FROM cost_allocations ca JOIN boxes b ON b.id = ca.box_id
             WHERE ca.cost_entry_id = ${costEntries}.id AND b.status = 'void'))`
      : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);
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
        repairs.length ? or(...repairs) : undefined,
      ),
    );
  await recomputeEach(rows.map((r) => r.id));
  return rows.length;
}

/**
 * One entry's failure costs ONE entry (U41): the loop used to stop at the
 * first throw, so a single bad row left every entry after it on its old
 * split. Each failure is logged by id, the rest still run, and ONE error is
 * thrown at the end so a job still fails and pg-boss still retries it.
 */
export async function recomputeEach(ids: string[]): Promise<void> {
  const failed: string[] = [];
  let first: unknown;
  for (const id of ids) {
    try {
      await recomputeEntry(id);
    } catch (error) {
      failed.push(id);
      first ??= error;
      console.error('[costing] recompute failed', id, error);
    }
  }
  if (failed.length) {
    throw new Error(`recompute failed for ${failed.length} of ${ids.length} cost entries: ${failed.join(', ')}`, {
      cause: first,
    });
  }
}

/**
 * Re-split every live cost stamped with these trucks after their RIDERS
 * changed — the half of DECISIONS #15 that was never built («missing-in-
 * transit resolved, undocumented transfer … re-triggers the recompute»,
 * audit U17/U25). A carton found back at the origin leaves the base of the
 * truck it never boarded, one scanned off without a load scan joins it; the
 * truck's freight and its stamped grid cells re-split over what really rode.
 * The dollars are frozen (R1), so only the per-box shares move.
 *
 * Called AFTER the commit that moved the carton — it reads settings and rates
 * on the pool (#714) — and never allowed to fail the door that called it: a
 * miss is a late re-split, logged, and `pnpm repair-riders` finds it.
 */
export async function recomputeRiderChange(batchIds: (string | null | undefined)[], why: string): Promise<void> {
  for (const batchId of new Set(batchIds.filter((id): id is string => !!id))) {
    try {
      await recomputeAll({ batchId });
    } catch (err) {
      console.error('[costing] rider re-split failed', why, batchId, err);
    }
  }
}

/**
 * The trucks these boxes may just have stopped riding: every truck they
 * departed on (or came off unscanned) that STARTS at the warehouse they were
 * found in. Read after the commit, for `recomputeRiderChange`.
 */
export async function trucksFoundBackAt(boxIds: string[], warehouseId: string): Promise<string[]> {
  if (boxIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ id: boxMovements.refId })
    .from(boxMovements)
    .innerJoin(batches, eq(batches.id, boxMovements.refId))
    .where(
      and(
        inArray(boxMovements.boxId, boxIds),
        eq(boxMovements.refType, 'batch'),
        inArray(boxMovements.cause, ['batch_departed', 'undocumented_transfer']),
        eq(batches.originWarehouseId, warehouseId),
      ),
    );
  return rows.map((row) => row.id).filter((id): id is string => !!id);
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
 * Membership is `costEntriesTouchingLots` (void-guard.ts) — ONE home for
 * «which costs share money over these boxes», read from the ledger that
 * defines it (#440): an entry with a share on any of the lot's boxes, the
 * lot's receipt's own costs, and the batch, crate and pickup entries of every
 * truck, crate and factory trip the lot's boxes were part of — including a
 * truck they rode without a load scan (U25). A box that got no share because
 * its old weight was zero is still on that truck.
 */
export async function recomputeForLot(lotId: string): Promise<number> {
  const { costEntriesTouchingLots } = await import('./void-guard');
  const ids = await costEntriesTouchingLots([lotId]);
  await recomputeEach(ids);
  return ids.length;
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
 *
 * The same allocations `batchLandedCostTotals` sums, through the same fence,
 * grouped by client instead of by lot.
 */
export async function batchLandedCostByClient(batchId: string): Promise<Map<string, ClientLandedCost>> {
  const landed = landedAllocationsSql(sql`${batchId}::uuid`);
  const rows = (await db.execute(sql`
    WITH ${landed.with}
    SELECT rc.client_id,
           coalesce(sum(ca.amount_usd), 0) AS total_usd,
           coalesce(sum(ca.amount_usd) FILTER (WHERE ce.batch_id = m.batch_id), 0) AS batch_usd
      ${landed.joins}
      JOIN receipt_lots rl ON rl.id = bx.lot_id
      JOIN receipts rc ON rc.id = rl.receipt_id
     WHERE ${landed.where}
     GROUP BY rc.client_id
  `)) as unknown as { client_id: string | null; total_usd: string; batch_usd: string }[];

  const out = new Map<string, ClientLandedCost>();
  for (const row of rows) {
    if (!row.client_id) continue;
    out.set(row.client_id, {
      clientId: row.client_id,
      totalUsd: Math.round(Number(row.total_usd) * 100) / 100,
      batchUsd: Math.round(Number(row.batch_usd) * 100) / 100,
    });
  }
  return out;
}

/**
 * The allocations each listed truck's landed cost is made of — ONE home for
 * «Partiya moliyasi» (per lot, per client, and the breakdown under the
 * tannarx) and «Partiya foydasi» (owner's R2a: «bitta mashina bitta foyda»),
 * so none of the four readers can say something the others do not (#513).
 *
 * Members are the truck's RIDERS (`riderCtesSql`, audit U17/U25), written as
 * a CTE of the indexed lookups rather than an OR: joined to
 * `cost_allocations`, the OR leaves the planner guessing that half of all
 * boxes ride every truck and it scans the allocations table whole (#152).
 * An annulled box is not cargo (the annul round).
 *
 * Which of a member box's allocations the truck carries — «shu reysgacha»:
 * - its own entries, always;
 * - never a LATER leg's: an entry stamped with a truck that departed after
 *   this one (or at all, while this one is still forming) is the future
 *   (#532e — re-opening an internal leg after the export had left printed
 *   the export's customs as «before this trip»);
 * - and each allocation on exactly ONE priced truck (audit U16). Since U1b a
 *   truck inside Uzbekistan is priced, and the old fence let every later
 *   priced leg count again everything an earlier one had carried — the
 *   cross-border freight, the prixod's own money, the Chinese legs — so
 *   Andijan → Tashkent printed the whole journey against a price for one
 *   road, and the page's Jami counted the first truck's cost twice. The rule
 *   is per BOX, because it is «what this carton brought with it since the
 *   last truck that was priced»: a truckless entry (receipt, crate, pickup)
 *   counts only while the box has no earlier priced truck, and another
 *   truck's entry only when that truck departed after the box's previous
 *   priced one (in practice a Chinese internal leg in between). The rows are
 *   then disjoint, so the priced rows add up to the distinct allocations —
 *   the P&L's direct cost for a fully priced, fully allocated set of trucks.
 *   The answer does not depend on whether the later truck IS priced (the
 *   owner's pending A/B): the money is counted once either way.
 *
 * An INTERNAL truck (both ends in China) looks for no previous priced truck —
 * it keeps the plain fence, as #1010 has it: a cost row, shown and left out
 * of every total.
 *
 * Stated, not refined: truckless money spent in Uzbekistan between two legs
 * (a crate built in Andijan, a receipt cost typed later) lands on the FIRST
 * priced truck — conserved and never doubled, but attributed early.
 */
function landedAllocationsSql(list: SQL): { with: SQL; joins: SQL; where: SQL } {
  return {
    with: sql`
      ${riderCtesSql(list)},
      clock AS (
        SELECT t.id AS batch_id, coalesce(t.departed_at, now()) AS at,
               ${internalLegSql('tow', 'tdw')} AS internal
          FROM batches t
          JOIN warehouses tow ON tow.id = t.origin_warehouse_id
          JOIN warehouses tdw ON tdw.id = t.dest_warehouse_id
         WHERE t.id IN (${list})
      ),
      prev_priced AS (
        SELECT m.batch_id, m.box_id, max(pb.departed_at) AS prev_at
          FROM members m
          JOIN clock c ON c.batch_id = m.batch_id AND NOT c.internal
          JOIN box_rides r ON r.box_id = m.box_id AND r.batch_id <> m.batch_id
          JOIN batches pb ON pb.id = r.batch_id
          JOIN warehouses po ON po.id = pb.origin_warehouse_id
          JOIN warehouses pd ON pd.id = pb.dest_warehouse_id
         WHERE pb.departed_at IS NOT NULL AND pb.departed_at < c.at
           AND NOT ${internalLegSql('po', 'pd')}
         GROUP BY m.batch_id, m.box_id
      )`,
    joins: sql`
      FROM members m
      JOIN clock c ON c.batch_id = m.batch_id
      JOIN boxes bx ON bx.id = m.box_id
      JOIN cost_allocations ca ON ca.box_id = m.box_id
      JOIN cost_entries ce ON ce.id = ca.cost_entry_id
      LEFT JOIN batches eb ON eb.id = ce.batch_id
      LEFT JOIN prev_priced pp ON pp.batch_id = m.batch_id AND pp.box_id = m.box_id`,
    where: sql`ce.voided_at IS NULL
       AND (
         ce.batch_id = m.batch_id
         OR (ce.batch_id IS NULL AND pp.prev_at IS NULL)
         OR (eb.departed_at IS NOT NULL AND eb.departed_at <= c.at
             AND (pp.prev_at IS NULL OR eb.departed_at > pp.prev_at))
       )`,
  };
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
 * One truck's slice of `batchLandedCostTotals`, so «Partiya moliyasi» and
 * «Partiya foydasi» are one query and cannot drift apart (owner's R2a,
 * 2026-09-24: «bitta mashina bitta foyda»).
 */
export async function batchLandedCostByLot(batchId: string): Promise<Map<string, LotLandedCost>> {
  return (await batchLandedCostTotals([batchId])).get(batchId) ?? new Map();
}

/**
 * `batchLandedCostByLot` for MANY trucks at once — per truck, per lot — so
 * the profit report reads every truck of a period in ONE grouped query and
 * not one per row (#432: a list's length is the business growing). The
 * members, the clock and the fence are `landedAllocationsSql`'s.
 */
export async function batchLandedCostTotals(
  batchIds: string[],
): Promise<Map<string, Map<string, LotLandedCost>>> {
  const out = new Map<string, Map<string, LotLandedCost>>();
  const ids = [...new Set(batchIds)];
  if (ids.length === 0) return out;
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const landed = landedAllocationsSql(list);
  const rows = (await db.execute(sql`
    WITH ${landed.with}
    SELECT m.batch_id, bx.lot_id,
           coalesce(sum(ca.amount_usd), 0) AS total_usd,
           coalesce(sum(ca.amount_usd) FILTER (WHERE ce.batch_id = m.batch_id), 0) AS batch_usd
      ${landed.joins}
     WHERE ${landed.where}
     GROUP BY m.batch_id, bx.lot_id
  `)) as unknown as { batch_id: string; lot_id: string; total_usd: string; batch_usd: string }[];
  for (const row of rows) {
    const byLot = out.get(row.batch_id) ?? new Map<string, LotLandedCost>();
    byLot.set(row.lot_id, {
      lotId: row.lot_id,
      totalUsd: Math.round(Number(row.total_usd) * 100) / 100,
      batchUsd: Math.round(Number(row.batch_usd) * 100) / 100,
    });
    out.set(row.batch_id, byLot);
  }
  return out;
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
      accountName: moneyAccounts.name,
    })
    .from(costEntries)
    .innerJoin(costTypes, eq(costEntries.costTypeId, costTypes.id))
    .leftJoin(clients, eq(costEntries.clientId, clients.id))
    .leftJoin(partners, eq(costEntries.partnerId, partners.id))
    .leftJoin(moneyAccounts, eq(costEntries.accountId, moneyAccounts.id))
    .where(and(eq(costEntries.batchId, batchId), isNull(costEntries.voidedAt)))
    .orderBy(asc(costEntries.createdAt));

  // The per-unit costs divide by what the freight was split over — the
  // truck's riders (a carton found back at the origin never rode, one
  // scanned off without a load scan did; a void box is not cargo).
  const load = (await riderLoad([batchId])).get(batchId);

  const totalUsd = entries.reduce((a, e) => a + Number(e.entry.amountUsd ?? 0), 0);
  const kg = load?.kg ?? 0;
  const m3 = load?.m3 ?? 0;
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

/** The batch's receipts, one grid row each — its riders, the same ground
 * truth as the cost engine itself: a grid cell splits over exactly these
 * boxes of the prixod (U18), so the row must count exactly them. */
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
    .where(and(riderFilter(batchId), ne(boxes.status, 'void')))
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
  /**
   * Or the kassa the whole sheet was paid from (0101) — one per save, like
   * the payer. The grid has ONE currency select, so the kassa must speak it:
   * a per-cell amount in another currency is twenty more boxes on a phone.
   */
  accountId: z.string().uuid().optional().or(z.literal('')),
  cells: z
    .array(
      z.object({
        receiptId: z.string().uuid(),
        costTypeId: z.string().uuid(),
        amount: nativeAmount(),
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
  // The sheet shares ONE date, so #995's rule (U21) is asked once, first —
  // per cell it would stop the save on cell 1 with a bare code.
  if (input.costDate > latestTxDate()) throw new CostError('future_date');
  const allowed = new Set((await batchReceiptRows(input.batchId)).map((row) => row.receiptId));
  for (const cell of input.cells) {
    if (!allowed.has(cell.receiptId)) throw new CostError('receipt_not_on_batch');
  }
  // Refused BEFORE the first cell, or a mismatched kassa would stop the save
  // part-way with half the sheet written.
  if (input.partnerId && input.accountId) throw new CostError('payer_conflict');
  if (input.accountId && (await assertTill(input.accountId)).currency !== input.currency) {
    throw new CostError('account_currency_mismatch');
  }
  // ONE currency too, so the dollar ceiling (U44) is asked of every cell
  // before the first is written — per cell it would stop the save part-way.
  const sheetRate = await rateFor(input.currency, input.costDate);
  if (sheetRate !== null && input.cells.some((cell) => exceedsRowUsd(cell.amount * sheetRate))) {
    throw new CostError('amount_too_large');
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
      accountId: input.accountId,
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
  // The header's own allocations through the header's own fence
  // (`landedAllocationsSql`), or the parts would not add up to the tannarx
  // printed above them.
  const landed = landedAllocationsSql(sql`${batchId}::uuid`);
  const rows = (await db.execute(sql`
    WITH ${landed.with}
    SELECT ca.client_id, ct.name AS type_name, eb.code AS batch_code,
           er.number AS receipt_number, cr.code AS crate_code, pk.code AS pickup_code,
           sum(ca.amount_usd) AS usd
      ${landed.joins}
      JOIN cost_types ct ON ct.id = ce.cost_type_id
      LEFT JOIN receipts er ON er.id = ce.receipt_id
      LEFT JOIN crates cr ON cr.id = ce.crate_id
      LEFT JOIN pickups pk ON pk.id = ce.pickup_id
     WHERE ${landed.where} AND ca.client_id IS NOT NULL
     GROUP BY ca.client_id, ct.name, eb.code, er.number, cr.code, pk.code
  `)) as unknown as {
    client_id: string;
    type_name: string;
    batch_code: string | null;
    receipt_number: string | null;
    crate_code: string | null;
    pickup_code: string | null;
    usd: string;
  }[];
  const out = new Map<string, ClientCostPart[]>();
  for (const row of rows) {
    const list = out.get(row.client_id) ?? [];
    list.push({
      source: row.batch_code ?? row.receipt_number ?? row.crate_code ?? row.pickup_code ?? '—',
      typeName: row.type_name,
      usd: Math.round(Number(row.usd) * 100) / 100,
    });
    out.set(row.client_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => b.usd - a.usd);
  return out;
}
