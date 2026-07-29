import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import {
  boxMovements,
  boxes,
  clientTransactions,
  clients,
  costAllocations,
  costEntries,
  dealLines,
  dealStages,
  deals,
  receiptLots,
  receipts,
  users,
} from '@/modules/platform/db/schema';
import type { Db, Tx } from '@/modules/platform/db/client';
import { writeAudit, type AuditContext } from '@/modules/platform/audit/service';
import { emitEvent } from '@/modules/platform/events/service';
import { getSetting } from '@/modules/platform/settings/service';
import { bumpCounter } from '../codes';
import {
  ARRIVED_BOX_STATUSES,
  SETTLED_BOX_STATUSES,
  allArrived,
  compareQuote,
  worthAlerting,
  type Deviation,
} from './deviation';

/**
 * Bitim (deal) — one client's job, from "please price this" to "paid".
 *
 * The specification is docs/DEALS.md. The shape follows from one sentence in
 * it: the pain is not the missing record, it is the gap between the price we
 * quoted and the cargo that turned up. So the QUOTE is typed in by a person
 * and the REALITY is never typed in at all — it is summed from the receipts
 * that point at the deal, which makes the two impossible to fake apart.
 */

export class DealError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** Both sides work a deal: sales quoted it, VED recalculated it (DEALS.md #2). */
export const DEAL_WRITE_PERMISSIONS = ['crm.leads', 'ved.docs', 'clients.manage'] as const;

export function canWriteDeal(permissions: { has(code: string): boolean }): boolean {
  return DEAL_WRITE_PERMISSIONS.some((code) => permissions.has(code));
}

export const dealSchema = z.object({
  clientId: z.string().uuid(),
  stageId: z.string().uuid().optional(),
  ownerId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(200).optional(),
  quotedVolumeM3: z.number().nonnegative().nullable().optional(),
  quotedWeightKg: z.number().nonnegative().nullable().optional(),
  quotedAmount: z.number().nonnegative().nullable().optional(),
  quotedCurrency: z.string().length(3).nullable().optional(),
  note: z.string().trim().max(2000).optional(),
});

export type DealInput = z.infer<typeof dealSchema>;

export const dealLineSchema = z.object({
  description: z.string().trim().min(1).max(300),
  tnvedCode: z.string().trim().max(20).nullable().optional(),
  quantity: z.number().nonnegative().nullable().optional(),
  unit: z.string().trim().max(20).nullable().optional(),
  quotedVolumeM3: z.number().nonnegative().nullable().optional(),
  quotedWeightKg: z.number().nonnegative().nullable().optional(),
  quotedAmount: z.number().nonnegative().nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

const num = (value: number | null | undefined) =>
  value === null || value === undefined ? null : value.toString();

/** `B-000123` — a lifetime sequence, because a deal is not scoped to a warehouse. */
async function nextDealCode(tx: Db | Tx): Promise<string> {
  const seq = await bumpCounter(tx, 'deal_seq', 'global');
  return `B-${String(seq).padStart(6, '0')}`;
}

/** The first open column, so a deal never starts life off the board. */
async function firstStageId(tx: Db | Tx): Promise<string> {
  const [stage] = await tx
    .select({ id: dealStages.id })
    .from(dealStages)
    .where(and(eq(dealStages.active, true), eq(dealStages.kind, 'open')))
    .orderBy(asc(dealStages.sortOrder))
    .limit(1);
  if (!stage) throw new DealError('no_stages');
  return stage.id;
}

export async function createDeal(input: DealInput, ctx: AuditContext): Promise<string> {
  const client = await db.query.clients.findFirst({ where: eq(clients.id, input.clientId) });
  if (!client) throw new DealError('client_not_found');

  return db.transaction(async (tx) => {
    const code = await nextDealCode(tx);
    const stageId = input.stageId ?? (await firstStageId(tx));
    // The quote is only "given" once a price exists; a deal opened to collect
    // the request carries sizes and no amount, and quotedAt stays null so the
    // "how long did we take to price this" clock is honest.
    const priced = input.quotedAmount !== null && input.quotedAmount !== undefined;
    const [row] = await tx
      .insert(deals)
      .values({
        code,
        clientId: input.clientId,
        stageId,
        // Whoever raises it owns it until somebody hands it on; falling back to
        // the client's sales manager keeps ownership true for a deal the
        // warehouse opens on somebody else's client.
        ownerId: input.ownerId ?? ctx.actorId ?? client.salesManagerId ?? null,
        title: input.title || null,
        quotedVolumeM3: num(input.quotedVolumeM3),
        quotedWeightKg: num(input.quotedWeightKg),
        quotedAmount: num(input.quotedAmount),
        quotedCurrency: input.quotedCurrency ?? (priced ? 'USD' : null),
        quotedAt: priced ? new Date() : null,
        quotedBy: priced ? ctx.actorId : null,
        note: input.note || null,
        createdBy: ctx.actorId!,
      })
      .returning();

    await writeAudit(tx, ctx, {
      entityType: 'deal',
      entityId: row!.id,
      action: 'create',
      after: { code, client: client.clientCode, amount: input.quotedAmount ?? null },
    });
    return row!.id;
  });
}

export async function updateDeal(id: string, input: DealInput, ctx: AuditContext): Promise<void> {
  const before = await db.query.deals.findFirst({ where: eq(deals.id, id) });
  if (!before) throw new DealError('not_found');

  // Re-pricing stamps who and when: the whole point of the deal is that the
  // number the client was told has an author and a date behind it.
  const amountChanged =
    input.quotedAmount !== undefined && num(input.quotedAmount) !== before.quotedAmount;
  const priced = input.quotedAmount !== null && input.quotedAmount !== undefined;

  await db.transaction(async (tx) => {
    await tx
      .update(deals)
      .set({
        stageId: input.stageId ?? before.stageId,
        ownerId: input.ownerId === undefined ? before.ownerId : input.ownerId,
        title: input.title || null,
        quotedVolumeM3: num(input.quotedVolumeM3),
        quotedWeightKg: num(input.quotedWeightKg),
        quotedAmount: num(input.quotedAmount),
        quotedCurrency: input.quotedCurrency ?? (priced ? before.quotedCurrency ?? 'USD' : null),
        quotedAt: amountChanged && priced ? new Date() : before.quotedAt,
        quotedBy: amountChanged && priced ? ctx.actorId : before.quotedBy,
        note: input.note || null,
      })
      .where(eq(deals.id, id));

    await writeAudit(tx, ctx, {
      entityType: 'deal',
      entityId: id,
      action: 'update',
      before: { amount: before.quotedAmount, volume: before.quotedVolumeM3 },
      after: { amount: num(input.quotedAmount), volume: num(input.quotedVolumeM3) },
    });
  });
  const newStageId = input.stageId ?? before.stageId;
  if (newStageId !== before.stageId) await announceDealStage(before, newStageId, ctx);
}

/**
 * Phase 7's ear on the deal funnel — announced from BOTH stage write paths
 * (the board's move and the edit form), or a rule would fire only for the
 * button that happened to be pressed.
 */
async function announceDealStage(
  deal: { id: string; code: string; clientId: string; ownerId: string | null },
  stageId: string,
  ctx: AuditContext,
): Promise<void> {
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.id, stageId) });
  await emitEvent(db, {
    type: 'DealStageChanged',
    payload: {
      dealId: deal.id,
      dealCode: deal.code,
      clientId: deal.clientId,
      stageId,
      stageName: stage?.name ?? '',
      stageKind: stage?.kind ?? 'open',
      ownerId: deal.ownerId,
    },
    entityType: 'deal',
    entityId: deal.id,
    actorId: ctx.actorId,
  });
}

/** Board drag, and the only way a deal changes column. */
export async function moveDeal(
  id: string,
  stageId: string,
  ctx: AuditContext,
  lostReason?: string,
): Promise<void> {
  const before = await db.query.deals.findFirst({ where: eq(deals.id, id) });
  if (!before) throw new DealError('not_found');
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.id, stageId) });
  if (!stage) throw new DealError('stage_not_found');
  // A job that was dropped is worth more to the business than a job that was
  // won, and only if somebody wrote down why.
  if (stage.kind === 'lost' && !lostReason?.trim()) throw new DealError('lost_reason_required');

  await db.transaction(async (tx) => {
    await tx
      .update(deals)
      .set({ stageId, lostReason: stage.kind === 'lost' ? lostReason!.trim() : null })
      .where(eq(deals.id, id));
    await writeAudit(tx, ctx, {
      entityType: 'deal',
      entityId: id,
      action: 'update',
      before: { stage: before.stageId },
      after: { stage: stageId, lostReason: lostReason ?? null },
    });
  });
  if (stageId !== before.stageId) await announceDealStage(before, stageId, ctx);
}

/** Replace the deal's lines wholesale — the form posts the whole set. */
export async function saveLines(
  dealId: string,
  lines: z.infer<typeof dealLineSchema>[],
  ctx: AuditContext,
): Promise<void> {
  const deal = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
  if (!deal) throw new DealError('not_found');
  await db.transaction(async (tx) => {
    await tx.delete(dealLines).where(eq(dealLines.dealId, dealId));
    if (lines.length > 0) {
      await tx.insert(dealLines).values(
        lines.map((line, i) => ({
          dealId,
          seq: i + 1,
          description: line.description,
          tnvedCode: line.tnvedCode || null,
          quantity: num(line.quantity),
          unit: line.unit || null,
          quotedVolumeM3: num(line.quotedVolumeM3),
          quotedWeightKg: num(line.quotedWeightKg),
          quotedAmount: num(line.quotedAmount),
          note: line.note || null,
        })),
      );
    }
    await writeAudit(tx, ctx, {
      entityType: 'deal',
      entityId: dealId,
      action: 'update',
      after: { lines: lines.length },
    });
  });
}

/**
 * Point a receipt at the job it belongs to.
 *
 * Refused across clients: a receipt for GS777 filed under GS102's deal would
 * make both clients' money wrong, and the mistake is invisible afterwards.
 */
export async function linkReceipt(
  receiptId: string,
  dealId: string | null,
  ctx: AuditContext,
): Promise<void> {
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
  if (!receipt) throw new DealError('receipt_not_found');
  if (dealId) {
    const deal = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
    if (!deal) throw new DealError('not_found');
    if (!receipt.clientId || receipt.clientId !== deal.clientId) {
      throw new DealError('client_mismatch');
    }
  }
  await db.transaction(async (tx) => {
    await tx.update(receipts).set({ dealId }).where(eq(receipts.id, receiptId));
    await writeAudit(tx, ctx, {
      entityType: 'receipt',
      entityId: receiptId,
      action: 'update',
      before: { deal: receipt.dealId },
      after: { deal: dealId },
    });
  });
}

export interface DealReality {
  receiptCount: number;
  boxCount: number;
  volumeM3: number;
  weightKg: number;
  /** Boxes still short of the client's hands — the deferral's end condition. */
  pendingBoxes: number;
  arrivedBoxes: number;
  lostBoxes: number;
}

/**
 * What actually turned up, summed from the receipts.
 *
 * Voided receipts are excluded: a receipt that was cancelled never happened,
 * and counting its volume would make the deal look 40 % over when it is not.
 */
export async function dealReality(dealId: string): Promise<DealReality> {
  const [totals] = await db
    .select({
      receipts: sql<number>`count(DISTINCT ${receipts.id})`,
      boxes: sql<number>`coalesce(sum(${receiptLots.boxCount}), 0)`,
      volume: sql<number>`coalesce(sum(${receiptLots.totalVolumeM3}), 0)`,
      weight: sql<number>`coalesce(sum(${receiptLots.totalWeightKg}), 0)`,
    })
    .from(receipts)
    .leftJoin(receiptLots, eq(receiptLots.receiptId, receipts.id))
    .where(and(eq(receipts.dealId, dealId), isNull(receipts.voidedAt)));

  // inArray/notInArray, never `IN ${array}`: a JS array interpolated into a raw
  // drizzle fragment is bound as ONE parameter and postgres refuses it.
  const settled = notInArray(boxes.status, [...SETTLED_BOX_STATUSES]);
  const arrived = inArray(boxes.status, [...ARRIVED_BOX_STATUSES]);
  const [boxState] = await db
    .select({
      pending: sql<number>`count(*) FILTER (WHERE ${settled})`,
      arrived: sql<number>`count(*) FILTER (WHERE ${arrived})`,
      lost: sql<number>`count(*) FILTER (WHERE ${boxes.status} = 'lost')`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(and(eq(receipts.dealId, dealId), isNull(receipts.voidedAt)));

  return {
    receiptCount: Number(totals?.receipts ?? 0),
    boxCount: Number(totals?.boxes ?? 0),
    volumeM3: Number(totals?.volume ?? 0),
    weightKg: Number(totals?.weight ?? 0),
    pendingBoxes: Number(boxState?.pending ?? 0),
    arrivedBoxes: Number(boxState?.arrived ?? 0),
    lostBoxes: Number(boxState?.lost ?? 0),
  };
}

export async function deviationThreshold(): Promise<number> {
  return getSetting('deal_deviation_threshold_pct');
}

/** The deal card's headline: quote, reality, and the gap between them. */
export async function dealDeviation(dealId: string): Promise<{
  reality: DealReality;
  deviation: Deviation;
}> {
  const deal = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
  if (!deal) throw new DealError('not_found');
  const reality = await dealReality(dealId);
  const deviation = compareQuote(
    {
      volumeM3: deal.quotedVolumeM3 === null ? null : Number(deal.quotedVolumeM3),
      weightKg: deal.quotedWeightKg === null ? null : Number(deal.quotedWeightKg),
      amount: deal.quotedAmount === null ? null : Number(deal.quotedAmount),
    },
    { volumeM3: reality.volumeM3, weightKg: reality.weightKg },
    await deviationThreshold(),
  );
  return { reality, deviation };
}

/**
 * Price control, run the moment a receipt is confirmed.
 *
 * This is the feature nobody asked for and everybody needs (DEALS.md). It
 * fires while the cargo is still sitting in the Chinese warehouse — the only
 * moment at which the client can still say "then send it back" — instead of at
 * the counter in Tashkent, which is where the argument happens today.
 *
 * Two cases, and no third:
 *  - the cargo belongs to no deal at all → "unquoted cargo, set a price"
 *  - a deal exists and reality is more than the threshold away from the quote
 *    → the numbers, both sides, and a suggested amount
 *
 * It NEVER blocks anything (owner's answer 1: "notify above 10 %, never block
 * loading"), and it never throws: a receipt that is physically in the building
 * must not fail to be recorded because a notification could not be composed.
 */
export async function priceControlOnReceipt(
  tx: Tx,
  input: {
    receiptId: string;
    receiptNumber: string;
    clientId: string | null;
    warehouseCode: string;
    volumeM3: number;
    weightKg: number;
    boxCount: number;
  },
  ctx: AuditContext,
): Promise<void> {
  try {
    if (!input.clientId) return; // unknown cargo already has its own alert

    const client = await tx.query.clients.findFirst({ where: eq(clients.id, input.clientId) });
    if (!client) return;

    // The deal this receipt belongs to, if the receiving screen was told. The
    // link is set before confirm; nothing here guesses, because a wrong guess
    // would silence the alert that matters most.
    const receipt = await tx.query.receipts.findFirst({ where: eq(receipts.id, input.receiptId) });
    const dealId = receipt?.dealId ?? null;

    if (!dealId) {
      // Case 1. The single biggest source of "it came out expensive"
      // complaints is cargo that was never quoted at all.
      await emitEvent(tx, {
        type: 'UnquotedCargo',
        payload: {
          receiptId: input.receiptId,
          number: input.receiptNumber,
          clientId: input.clientId,
          clientCode: client.clientCode,
          clientName: client.name,
          warehouseCode: input.warehouseCode,
          volumeM3: input.volumeM3,
          weightKg: input.weightKg,
          boxCount: input.boxCount,
        },
        entityType: 'receipt',
        entityId: input.receiptId,
        actorId: ctx.actorId,
      });
      return;
    }

    const deal = await tx.query.deals.findFirst({ where: eq(deals.id, dealId) });
    if (!deal) return;

    // Reality is the WHOLE deal, not this receipt: a shipment split over two
    // days is only over the threshold once both halves are in, and alerting on
    // the first half alone would cry wolf on every split job.
    const reality = await dealRealityIn(tx, dealId);
    const threshold = await getSetting('deal_deviation_threshold_pct');
    const deviation = compareQuote(
      {
        volumeM3: deal.quotedVolumeM3 === null ? null : Number(deal.quotedVolumeM3),
        weightKg: deal.quotedWeightKg === null ? null : Number(deal.quotedWeightKg),
        amount: deal.quotedAmount === null ? null : Number(deal.quotedAmount),
      },
      { volumeM3: reality.volumeM3, weightKg: reality.weightKg },
      threshold,
    );
    // Over the quote only: see `worthAlerting`. A job that has received half
    // its cargo is 50 % "under", and messaging about that on every split
    // shipment would train everyone to ignore the channel.
    if (!worthAlerting(deviation)) return;

    await emitEvent(tx, {
      type: 'DealDeviation',
      payload: {
        dealId,
        dealCode: deal.code,
        receiptId: input.receiptId,
        number: input.receiptNumber,
        clientId: input.clientId,
        clientCode: client.clientCode,
        clientName: client.name,
        warehouseCode: input.warehouseCode,
        quotedVolumeM3: deal.quotedVolumeM3 === null ? null : Number(deal.quotedVolumeM3),
        quotedWeightKg: deal.quotedWeightKg === null ? null : Number(deal.quotedWeightKg),
        quotedAmount: deal.quotedAmount === null ? null : Number(deal.quotedAmount),
        quotedCurrency: deal.quotedCurrency,
        actualVolumeM3: reality.volumeM3,
        actualWeightKg: reality.weightKg,
        worstPct: deviation.worstPct,
        driver: deviation.driver,
        suggestedAmount: deviation.suggestedAmount,
        ownerId: deal.ownerId,
      },
      entityType: 'deal',
      entityId: dealId,
      actorId: ctx.actorId,
    });
  } catch {
    // Deliberately swallowed. The cargo is in the building; the receipt is the
    // record of that fact and must survive a failure in the advisory layer.
    // The same choice `closeExpectedOnReceipt` already makes.
  }
}

/** `dealReality` against an open transaction, for the confirm path. */
async function dealRealityIn(tx: Tx, dealId: string): Promise<{ volumeM3: number; weightKg: number }> {
  const [totals] = await tx
    .select({
      volume: sql<number>`coalesce(sum(${receiptLots.totalVolumeM3}), 0)`,
      weight: sql<number>`coalesce(sum(${receiptLots.totalWeightKg}), 0)`,
    })
    .from(receipts)
    .innerJoin(receiptLots, eq(receiptLots.receiptId, receipts.id))
    .where(and(eq(receipts.dealId, dealId), isNull(receipts.voidedAt)));
  return { volumeM3: Number(totals?.volume ?? 0), weightKg: Number(totals?.weight ?? 0) };
}

// ---------------------------------------------------------------------------
// Deferred payment (DEALS.md answer 4)
// ---------------------------------------------------------------------------

export async function deferPayment(
  dealId: string,
  input: { reason: string; untilAllArrived: boolean; untilDate?: string | null },
  ctx: AuditContext,
): Promise<void> {
  if (!input.reason.trim()) throw new DealError('reason_required');
  if (!input.untilAllArrived && !input.untilDate) throw new DealError('end_required');
  const deal = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
  if (!deal) throw new DealError('not_found');

  await db.transaction(async (tx) => {
    await tx
      .update(deals)
      .set({
        deferralReason: input.reason.trim(),
        deferredBy: ctx.actorId,
        deferredAt: new Date(),
        deferUntilAllArrived: input.untilAllArrived,
        deferUntilDate: input.untilAllArrived ? null : input.untilDate!,
        deferralEndedAt: null,
      })
      .where(eq(deals.id, dealId));
    await writeAudit(tx, ctx, {
      entityType: 'deal',
      entityId: dealId,
      action: 'update',
      after: {
        deferred: true,
        reason: input.reason.trim(),
        until: input.untilAllArrived ? 'all_arrived' : input.untilDate,
      },
    });
  });
}

/** Is this client's money currently deferred, and what should the gate say? */
export async function activeDeferrals(clientId: string): Promise<
  { dealId: string; code: string; reason: string; pendingBoxes: number; untilDate: string | null }[]
> {
  const rows = await db
    .select({
      id: deals.id,
      code: deals.code,
      reason: deals.deferralReason,
      untilDate: deals.deferUntilDate,
      untilAllArrived: deals.deferUntilAllArrived,
    })
    .from(deals)
    .where(
      and(
        eq(deals.clientId, clientId),
        sql`${deals.deferredAt} IS NOT NULL`,
        isNull(deals.deferralEndedAt),
      ),
    );

  const out = [];
  for (const row of rows) {
    const reality = await dealReality(row.id);
    // A date-bound deferral that has passed is no longer a deferral; the sweep
    // below closes it properly, but the gate must not honour it in the meantime.
    if (!row.untilAllArrived && row.untilDate && row.untilDate < todayIso()) continue;
    if (row.untilAllArrived && allArrived({ total: reality.boxCount, pending: reality.pendingBoxes }))
      continue;
    out.push({
      dealId: row.id,
      code: row.code,
      reason: row.reason ?? '',
      pendingBoxes: reality.pendingBoxes,
      untilDate: row.untilDate,
    });
  }
  return out;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Close the deferrals that have run out, and say so.
 *
 * A deferral that expires in silence is how a debtor disappears from the
 * debtor list for good, so the client returns to the list AND the person who
 * granted it is told (DEALS.md: "the sales manager is nudged").
 */
export async function resolveExpiredDeferrals(now = new Date()): Promise<number> {
  const rows = await db
    .select({
      id: deals.id,
      code: deals.code,
      clientId: deals.clientId,
      ownerId: deals.ownerId,
      deferredBy: deals.deferredBy,
      untilDate: deals.deferUntilDate,
      untilAllArrived: deals.deferUntilAllArrived,
    })
    .from(deals)
    .where(and(sql`${deals.deferredAt} IS NOT NULL`, isNull(deals.deferralEndedAt)));

  const today = now.toISOString().slice(0, 10);
  let closed = 0;
  for (const row of rows) {
    let expired = false;
    if (row.untilAllArrived) {
      const reality = await dealReality(row.id);
      expired = allArrived({ total: reality.boxCount, pending: reality.pendingBoxes });
    } else if (row.untilDate) {
      expired = row.untilDate < today;
    }
    if (!expired) continue;

    await db.transaction(async (tx) => {
      await tx.update(deals).set({ deferralEndedAt: now }).where(eq(deals.id, row.id));
      await emitEvent(tx, {
        type: 'DealDeferralEnded',
        payload: {
          dealId: row.id,
          dealCode: row.code,
          clientId: row.clientId,
          ownerId: row.ownerId ?? row.deferredBy,
          reason: row.untilAllArrived ? 'all_arrived' : 'date_passed',
        },
        entityType: 'deal',
        entityId: row.id,
        actorId: null,
      });
    });
    closed += 1;
  }
  return closed;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listStages(includeInactive = false) {
  return db
    .select()
    .from(dealStages)
    .where(includeInactive ? sql`true` : eq(dealStages.active, true))
    .orderBy(asc(dealStages.sortOrder));
}

export interface DealRow {
  id: string;
  code: string;
  title: string | null;
  stageId: string;
  clientId: string;
  clientCode: string;
  clientName: string;
  ownerId: string | null;
  ownerName: string | null;
  quotedAmount: string | null;
  quotedCurrency: string | null;
  quotedVolumeM3: string | null;
  deferred: boolean;
  createdAt: Date;
}

/**
 * The board and the list read through here.
 *
 * `ownerId` narrows to one salesperson's own jobs. It is a parameter rather
 * than a rule baked in because who may see everyone's work is a permission
 * question the CALLER already answered — the same split `listLeads` uses.
 */
export async function listDeals(filters: {
  ownerId?: string;
  clientId?: string;
  stageId?: string;
  openOnly?: boolean;
  limit?: number;
}): Promise<DealRow[]> {
  const conditions = [];
  if (filters.ownerId) conditions.push(eq(deals.ownerId, filters.ownerId));
  if (filters.clientId) conditions.push(eq(deals.clientId, filters.clientId));
  if (filters.stageId) conditions.push(eq(deals.stageId, filters.stageId));
  if (filters.openOnly) {
    const terminal = await db
      .select({ id: dealStages.id })
      .from(dealStages)
      .where(notInArray(dealStages.kind, ['open']));
    if (terminal.length > 0) {
      conditions.push(notInArray(deals.stageId, terminal.map((s) => s.id)));
    }
  }

  const rows = await db
    .select({
      id: deals.id,
      code: deals.code,
      title: deals.title,
      stageId: deals.stageId,
      clientId: deals.clientId,
      clientCode: clients.clientCode,
      clientName: clients.name,
      ownerId: deals.ownerId,
      ownerName: users.fullName,
      quotedAmount: deals.quotedAmount,
      quotedCurrency: deals.quotedCurrency,
      quotedVolumeM3: deals.quotedVolumeM3,
      deferredAt: deals.deferredAt,
      deferralEndedAt: deals.deferralEndedAt,
      createdAt: deals.createdAt,
    })
    .from(deals)
    .innerJoin(clients, eq(deals.clientId, clients.id))
    .leftJoin(users, eq(deals.ownerId, users.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(deals.createdAt))
    .limit(filters.limit ?? 300);

  return rows.map(({ deferredAt, deferralEndedAt, ...row }) => ({
    ...row,
    deferred: Boolean(deferredAt) && !deferralEndedAt,
  }));
}

export async function dealById(id: string) {
  const [row] = await db
    .select({
      deal: deals,
      clientCode: clients.clientCode,
      clientName: clients.name,
      stageName: dealStages.name,
      stageKind: dealStages.kind,
      stageColor: dealStages.color,
      ownerName: users.fullName,
    })
    .from(deals)
    .innerJoin(clients, eq(deals.clientId, clients.id))
    .innerJoin(dealStages, eq(deals.stageId, dealStages.id))
    .leftJoin(users, eq(deals.ownerId, users.id))
    .where(eq(deals.id, id))
    .limit(1);
  if (!row) return null;
  const lines = await db
    .select()
    .from(dealLines)
    .where(eq(dealLines.dealId, id))
    .orderBy(asc(dealLines.seq));
  const linked = await db
    .select({
      id: receipts.id,
      number: receipts.number,
      receivedAt: receipts.receivedAt,
      voidedAt: receipts.voidedAt,
    })
    .from(receipts)
    .where(eq(receipts.dealId, id))
    .orderBy(desc(receipts.receivedAt));
  return { ...row, lines, receipts: linked };
}

/** Confirmed receipts of this client that belong to no deal yet. */
export async function unlinkedReceipts(clientId: string) {
  return db
    .select({ id: receipts.id, number: receipts.number, receivedAt: receipts.receivedAt })
    .from(receipts)
    .where(
      and(
        eq(receipts.clientId, clientId),
        isNull(receipts.dealId),
        isNull(receipts.voidedAt),
        eq(receipts.status, 'confirmed'),
      ),
    )
    .orderBy(desc(receipts.receivedAt))
    .limit(50);
}

/** Open deals of a client, for the receiving screen's picker. */
export async function openDealsForClient(clientId: string) {
  const openStages = await db
    .select({ id: dealStages.id })
    .from(dealStages)
    .where(eq(dealStages.kind, 'open'));
  if (openStages.length === 0) return [];
  return db
    .select({
      id: deals.id,
      code: deals.code,
      title: deals.title,
      quotedAmount: deals.quotedAmount,
      quotedCurrency: deals.quotedCurrency,
    })
    .from(deals)
    .where(
      and(
        eq(deals.clientId, clientId),
        inArray(deals.stageId, openStages.map((s) => s.id)),
      ),
    )
    .orderBy(desc(deals.createdAt))
    .limit(20);
}

/**
 * Deals that need somebody's attention right now, for the client card and the
 * sales manager's day: quoted but the cargo is over the threshold, or landed
 * with no price at all.
 */
export async function dealsNeedingAttention(ownerId?: string): Promise<
  { id: string; code: string; clientCode: string; clientName: string; reason: string; pct: number | null }[]
> {
  const rows = await listDeals({ ownerId, openOnly: true, limit: 200 });
  const threshold = await deviationThreshold();
  const out = [];
  for (const row of rows) {
    const reality = await dealReality(row.id);
    if (reality.receiptCount === 0) continue;
    if (row.quotedAmount === null) {
      out.push({
        id: row.id,
        code: row.code,
        clientCode: row.clientCode,
        clientName: row.clientName,
        reason: 'unpriced',
        pct: null,
      });
      continue;
    }
    const deal = await db.query.deals.findFirst({ where: eq(deals.id, row.id) });
    const deviation = compareQuote(
      {
        volumeM3: deal?.quotedVolumeM3 == null ? null : Number(deal.quotedVolumeM3),
        weightKg: deal?.quotedWeightKg == null ? null : Number(deal.quotedWeightKg),
        amount: deal?.quotedAmount == null ? null : Number(deal.quotedAmount),
      },
      { volumeM3: reality.volumeM3, weightKg: reality.weightKg },
      threshold,
    );
    if (worthAlerting(deviation)) {
      out.push({
        id: row.id,
        code: row.code,
        clientCode: row.clientCode,
        clientName: row.clientName,
        reason: 'deviation',
        pct: deviation.worstPct,
      });
    }
  }
  return out;
}

export { compareQuote, allArrived } from './deviation';
export type { Deviation, Quote, Reality } from './deviation';

/**
 * What has already been put on the client's account for this job, in USD.
 *
 * Shown on the card so nobody charges the same job twice — the commonest way
 * a client ends up disputing an invoice is being billed for one shipment two
 * different afternoons by two different people.
 */
export async function dealCharged(dealId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${clientTransactions.amountUsd}), 0)` })
    .from(clientTransactions)
    .where(
      and(
        eq(clientTransactions.dealId, dealId),
        eq(clientTransactions.type, 'charge'),
        isNull(clientTransactions.voidedAt),
      ),
    );
  return Math.round(Number(row?.total ?? 0) * 100) / 100;
}

/**
 * Damage is a DISCOUNT on the deal (DEALS.md answer 3): the deal amount goes
 * down, with a reason and an author, and profit follows — never a separate
 * compensation expense that would let the deal's profit keep lying.
 *
 * The record is the WHY; the ledger keeps its own truth. A charge already
 * posted at the old figure is adjusted through finance (void + re-post, both
 * audited) — this function never touches money that already moved.
 */
export async function setDealDiscount(
  dealId: string,
  input: { amount: number; reason?: string },
  ctx: AuditContext,
): Promise<void> {
  const before = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
  if (!before) throw new DealError('not_found');
  if (input.amount < 0) throw new DealError('validation');
  // Amount 0 = "the discount was a mistake, remove it" — allowed, audited.
  const clearing = input.amount <= 0.009;
  if (!clearing && !input.reason?.trim()) throw new DealError('discount_reason_required');

  await db.transaction(async (tx) => {
    await tx
      .update(deals)
      .set({
        discountAmount: clearing ? '0' : input.amount.toFixed(2),
        discountReason: clearing ? null : input.reason!.trim(),
        discountBy: clearing ? null : ctx.actorId,
        discountAt: clearing ? null : new Date(),
      })
      .where(eq(deals.id, dealId));
    await writeAudit(tx, ctx, {
      entityType: 'deal',
      entityId: dealId,
      action: 'update',
      before: { discount: before.discountAmount, discountReason: before.discountReason },
      after: {
        discount: clearing ? '0' : input.amount.toFixed(2),
        discountReason: clearing ? null : input.reason!.trim(),
      },
    });
  });
}

export interface DealProfit {
  /** Non-void charges carrying this deal, in USD — what was actually billed. */
  revenueUsd: number;
  /** Landed cost of the deal's boxes: the per-box allocation shares summed. */
  costUsd: number;
  profitUsd: number;
  marginPct: number | null;
  /**
   * Money the client paid through BATCH pricing on trucks that carried this
   * deal's boxes — posted without a deal, so it is not in revenueUsd. Shown,
   * not guessed at: pro-rating somebody's batch invoice across deals would
   * put invented numbers in front of an accountant.
   */
  unlinkedBatchUsd: number;
}

/**
 * Profit per deal, never per line (DEALS.md answer 7).
 *
 * Revenue is what was CHARGED, not the quote minus the discount — the
 * discount explains why a charge is lower than the quote, and subtracting it
 * again would count it twice. Costs come through cost_allocations, so a
 * shared truck's cost lands on this deal exactly as fairly as profitByClient
 * splits it. Voided rows are out on both sides.
 */
export async function dealProfit(dealId: string): Promise<DealProfit> {
  const deal = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
  if (!deal) throw new DealError('not_found');

  const revenueUsd = await dealCharged(dealId);

  const [costRow] = await db
    .select({ total: sql<string>`coalesce(sum(${costAllocations.amountUsd}), 0)` })
    .from(costAllocations)
    .innerJoin(costEntries, eq(costAllocations.costEntryId, costEntries.id))
    .innerJoin(boxes, eq(costAllocations.boxId, boxes.id))
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(
      and(
        eq(receipts.dealId, dealId),
        isNull(receipts.voidedAt),
        // Belt and braces (#360): a void that crashed between the update and
        // the allocation delete must not resurrect as cost.
        isNull(costEntries.voidedAt),
      ),
    );
  const costUsd = Math.round(Number(costRow?.total ?? 0) * 100) / 100;

  // The batches this deal's boxes actually rode (departed movements, plus a
  // batch still forming) — membership through box_movements, never a
  // subquery in a join predicate (#152).
  const ridden = await db
    .selectDistinct({ batchId: boxMovements.refId })
    .from(boxMovements)
    .innerJoin(boxes, eq(boxMovements.boxId, boxes.id))
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(
      and(
        eq(receipts.dealId, dealId),
        isNull(receipts.voidedAt),
        eq(boxMovements.refType, 'batch'),
        eq(boxMovements.cause, 'batch_departed'),
      ),
    );
  const current = await db
    .selectDistinct({ batchId: boxes.currentBatchId })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(and(eq(receipts.dealId, dealId), isNull(receipts.voidedAt)));
  const batchIds = [
    ...new Set(
      [...ridden.map((r) => r.batchId), ...current.map((r) => r.batchId)].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  ];

  let unlinkedBatchUsd = 0;
  if (batchIds.length > 0) {
    const [row] = await db
      .select({ total: sql<string>`coalesce(sum(${clientTransactions.amountUsd}), 0)` })
      .from(clientTransactions)
      .where(
        and(
          eq(clientTransactions.clientId, deal.clientId),
          inArray(clientTransactions.batchId, batchIds),
          isNull(clientTransactions.dealId),
          eq(clientTransactions.type, 'charge'),
          isNull(clientTransactions.voidedAt),
        ),
      );
    unlinkedBatchUsd = Math.round(Number(row?.total ?? 0) * 100) / 100;
  }

  const profitUsd = Math.round((revenueUsd - costUsd) * 100) / 100;
  return {
    revenueUsd,
    costUsd,
    profitUsd,
    marginPct: revenueUsd > 0 ? Math.round((profitUsd / revenueUsd) * 1000) / 10 : null,
    unlinkedBatchUsd,
  };
}
