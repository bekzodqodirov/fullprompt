import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
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
import { diffFields, writeAudit, type AuditContext } from '@/modules/platform/audit/service';
import { emitEvent } from '@/modules/platform/events/service';
import { getSetting } from '@/modules/platform/settings/service';
import { logger } from '@/modules/platform/logger';
import { bumpCounter } from '../codes';
import { likeNeedle } from '../search/query';
import { STAGE_COLORS, activeLostReasonLabels } from '../crm/service';
import { closedAtFor, reasonAllowed, stageWrite } from '../crm/stage-law';
import { orderForMove, topOfColumn, type BoardTable } from '../crm/board-place';
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

/**
 * One spelling for a stored number.
 *
 * `numeric(14,2)` comes back from postgres at its full scale ("200.00") while a
 * form sends "200". Both are the same money, and every comparison in this file
 * that forgot it treated an untouched price as a new one.
 */
const canonical = (value: string | null) => (value === null ? null : String(Number(value)));
const sameNumber = (a: string | null, b: string | null) => canonical(a) === canonical(b);

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
        // Top of its column, which is where a newly raised job has always
        // appeared — see the funnel's own create (0075).
        boardOrder: await topOfColumn(tx, DEAL_BOARD, stageId),
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
  // number the client was told has an author and a date behind it. Compared as
  // NUMBERS — postgres hands back `numeric(14,2)` as "200.00" and the form
  // sends "200", so a string comparison called every save a re-pricing and
  // moved the quote's author and date onto whoever last fixed a typo.
  const amountChanged =
    input.quotedAmount !== undefined && !sameNumber(num(input.quotedAmount), before.quotedAmount);
  const priced = input.quotedAmount !== null && input.quotedAmount !== undefined;

  // A sealed calculation is what the client was told (docs/VED.md law 2), so
  // this form may not overwrite it. A CHANGE check, not a presence check: the
  // locked form re-posts the sealed figure as hidden inputs (#171), and an
  // ordinary save — a corrected title — must not become a refusal. The door
  // back is «Qayta hisoblash», which mints a new calculation.
  if (amountChanged) {
    const { quoteLockedFor } = await import('../crm/service');
    const sealedTotal = await quoteLockedFor('deal', id);
    if (sealedTotal !== null) throw new DealError('quote_sealed');
  }

  // What the audit trail records. The old row named `amount` and `volume` only,
  // so a retitled or re-staged deal left no trace, and the scale difference
  // above printed `200.00 → 200` on every save.
  const audited = {
    title: input.title || null,
    stageId: input.stageId ?? before.stageId,
    ownerId: input.ownerId === undefined ? before.ownerId : input.ownerId,
    amount: canonical(num(input.quotedAmount)),
    volumeM3: canonical(num(input.quotedVolumeM3)),
    weightKg: canonical(num(input.quotedWeightKg)),
    currency: input.quotedCurrency ?? (priced ? before.quotedCurrency ?? 'USD' : null),
    note: input.note || null,
  };
  const diff = diffFields(
    {
      title: before.title,
      stageId: before.stageId,
      ownerId: before.ownerId,
      amount: canonical(before.quotedAmount),
      volumeM3: canonical(before.quotedVolumeM3),
      weightKg: canonical(before.quotedWeightKg),
      currency: before.quotedCurrency,
      note: before.note,
    },
    audited,
  );

  /*
   * The funnel's law, asked by this door too (round 83). `moveDeal` has
   * demanded a reason for «Yo'qotildi» and cleared it on the way back out
   * since it shipped; the ✏️ form wrote `stage_id` from a `<select>` of every
   * stage and did neither. It carries no reason box, so passing none is what
   * makes the shared rule refuse it. Only on an actual MOVE — an ordinary
   * save on a deal that is already lost is not a refusal, and must not wipe
   * the reason it was lost for.
   */
  let lostReason: string | null | undefined;
  let closedAt: Date | null | undefined;
  if ((input.stageId ?? before.stageId) !== before.stageId) {
    const stage = await db.query.dealStages.findFirst({
      where: eq(dealStages.id, input.stageId!),
    });
    if (!stage) throw new DealError('stage_not_found');
    const law = stageWrite(stage.kind, null);
    if (!law.ok) throw new DealError('lost_reason_required');
    lostReason = law.lostReason;
    closedAt = closedAtFor(stage.kind, new Date());
  }

  await db.transaction(async (tx) => {
    await tx
      .update(deals)
      .set({
        stageId: input.stageId ?? before.stageId,
        ...(lostReason === undefined ? {} : { lostReason }),
        ...(closedAt === undefined ? {} : { closedAt }),
        // A stage changed from the ✏️ form is an arrival with nothing said
        // about position, so it lands at the top — the board's own rule.
        ...((input.stageId ?? before.stageId) !== before.stageId
          ? { boardOrder: await topOfColumn(tx, DEAL_BOARD, input.stageId!) }
          : {}),
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

    if (diff) {
      await writeAudit(tx, ctx, {
        entityType: 'deal',
        entityId: id,
        action: 'update',
        before: diff.before,
        after: diff.after,
      });
    }
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
  place?: { beforeId: string | null },
): Promise<void> {
  const before = await db.query.deals.findFirst({ where: eq(deals.id, id) });
  if (!before) throw new DealError('not_found');
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.id, stageId) });
  if (!stage) throw new DealError('stage_not_found');
  // A job that was dropped is worth more to the business than a job that was
  // won, and only if somebody wrote down why.
  const law = stageWrite(stage.kind, lostReason);
  if (!law.ok) throw new DealError('lost_reason_required');
  // The owner's list, when he has written one — the funnel's rule, verbatim
  // (see `moveLead`). One dictionary serves both boards.
  if (law.lostReason !== null && !reasonAllowed(law.lostReason, await activeLostReasonLabels()))
    throw new DealError('lost_reason_not_listed');

  await db.transaction(async (tx) => {
    // `place` is the drag and nothing else — the funnel's rule, verbatim.
    const boardOrder = await orderForMove(tx, DEAL_BOARD, stageId, id, place);
    await tx
      .update(deals)
      .set({
        stageId,
        lostReason: law.lostReason,
        boardOrder,
        ...(stageId !== before.stageId
          ? { closedAt: closedAtFor(stage.kind, new Date()) }
          : {}),
      })
      .where(eq(deals.id, id));
    // Only a real move is a fact about the deal; re-ordering one column is a
    // fact about how somebody reads the board (see `moveLead`).
    if (stageId !== before.stageId) {
      await writeAudit(tx, ctx, {
        entityType: 'deal',
        entityId: id,
        action: 'update',
        before: { stage: before.stageId },
        after: { stage: stageId, lostReason: lostReason ?? null },
      });
    }
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

  // The honest end of a calculation's clock: the lines were SAVED.
  //
  // Outside the transaction, because everything in the calc service runs on
  // the pool and a second connection asked for while one is held is what
  // freezes the whole app (tests/unit/tx-pool.test.ts). Fenced, because a
  // stuck clock must never refuse the save itself. Guarded on a non-empty
  // save: wiping a deal's lines is a deletion, not a calculation.
  if (lines.length > 0 && ctx.actorId) {
    try {
      const { completeCalcForDeal } = await import('../calc/service');
      await completeCalcForDeal(dealId, ctx.actorId);
    } catch (err) {
      logger.error({ err, dealId }, '[calc] clock stop on saveLines failed');
    }
  }
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
  // Round 26: «sdelkaga qaysi yukligini ulaganimdan keyin…» — linking is where
  // the owner starts, and by then the cargo is usually already sitting in the
  // Chinese warehouse. A confirmed receipt IS received cargo, so the link
  // itself counts as the first trigger; the later states catch up on their own
  // events. Fenced: a funnel that refuses to move must never fail the link.
  if (dealId && receipt.status === 'confirmed') {
    try {
      await applyCargoTrigger([dealId], 'received', ctx);
    } catch (err) {
      logger.error({ err, dealId }, 'deal auto-stage on link failed');
    }
  }
}

// ---------------------------------------------------------------------------
// Deal stages: the owner's editor, and the cargo that moves the funnel
// (round 26, owner's item 6)
// ---------------------------------------------------------------------------

/**
 * The cargo states a stage may follow, in the order cargo lives them. Five
 * are the moments the warehouse announces as events; `handed_partial` is the
 * owner's round-27 addition for split shipments — the first handover parks
 * the deal there, and `handed` fires only once EVERYTHING is in the client's
 * hands. The migration's CHECK constraint repeats this list.
 */
export const CARGO_TRIGGERS = [
  'received',
  'departed',
  'arrived',
  'ready',
  'handed_partial',
  'handed',
] as const;
export type CargoTrigger = (typeof CARGO_TRIGGERS)[number];

/**
 * Is every box of the deal's linked cargo in the client's hands?
 *
 * The denominator excludes lost and void boxes — they will never be issued,
 * and counting them would park the deal at «qisman topshirildi» for ever,
 * which is the deferral's lesson retold (deviation.ts). At least one box must
 * actually be issued: a deal whose entire cargo was voided is not "handed".
 */
export async function dealFullyIssued(dealId: string): Promise<boolean> {
  const outstanding = notInArray(boxes.status, ['issued', 'lost', 'void']);
  const [row] = await db
    .select({
      issued: sql<number>`count(*) FILTER (WHERE ${boxes.status} = 'issued')`,
      outstanding: sql<number>`count(*) FILTER (WHERE ${outstanding})`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(and(eq(receipts.dealId, dealId), isNull(receipts.voidedAt)));
  return Number(row?.issued ?? 0) > 0 && Number(row?.outstanding ?? 0) === 0;
}

export const dealStageSchema = z.object({
  name: z.string().trim().min(2).max(120),
  kind: z.enum(['open', 'won', 'lost']).default('open'),
  color: z.enum(STAGE_COLORS).default('gray'),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
  active: z.boolean().default(true),
  cargoTrigger: z.enum(CARGO_TRIGGERS).nullable().default(null),
});

export async function saveDealStage(
  input: z.infer<typeof dealStageSchema> & { id?: string },
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new DealError('unauthenticated');
  // Cargo may win a deal, only a person may lose one: a lost stage needs a
  // written-down reason (see moveDeal), which an automatic move cannot give.
  if (input.cargoTrigger && input.kind === 'lost') throw new DealError('trigger_on_lost');
  const values = {
    name: input.name,
    kind: input.kind,
    color: input.color,
    sortOrder: input.sortOrder,
    active: input.active,
    cargoTrigger: input.cargoTrigger,
  };
  const row = await db.transaction(async (tx) => {
    const [saved] = input.id
      ? await tx.update(dealStages).set(values).where(eq(dealStages.id, input.id)).returning()
      : await tx.insert(dealStages).values(values).returning();
    if (!saved) throw new DealError('not_found');
    // The lead editor's funnel law, checked INSIDE the transaction so a
    // refusal rolls the change back: no won stage silently breaks winning,
    // no open stage leaves a new deal nowhere to start.
    const remaining = await tx.select().from(dealStages).where(eq(dealStages.active, true));
    for (const required of ['open', 'won'] as const) {
      if (!remaining.some((stage) => stage.kind === required)) {
        throw new DealError(`needs_${required}`);
      }
    }
    return saved;
  });
  await writeAudit(db, ctx, {
    entityType: 'deal_stage',
    entityId: row.id,
    action: input.id ? 'update' : 'create',
    after: values,
  });
  return row;
}

/**
 * Reorder the deal funnel in one go — the lead editor's move, verbatim: the
 * ids arrive in the order the owner arranged and `sort_order` is rewritten
 * from that, so two stages can never share a position. Order is load-bearing
 * here twice over: the board's columns AND the cargo engine's forward-only
 * rule both read it.
 */
export async function reorderDealStages(ids: string[], ctx: AuditContext): Promise<void> {
  if (!ctx.actorId) throw new DealError('unauthenticated');
  await db.transaction(async (tx) => {
    for (const [index, stageId] of ids.entries()) {
      await tx
        .update(dealStages)
        .set({ sortOrder: (index + 1) * 10 })
        .where(eq(dealStages.id, stageId));
    }
  });
  await writeAudit(db, ctx, {
    entityType: 'deal_stage',
    entityId: ids[0] ?? '00000000-0000-0000-0000-000000000000',
    action: 'update',
    after: { order: ids },
  });
}

/**
 * Remove a stage, moving its deals somewhere else first — orphaning a deal
 * off the board is how a job disappears. The funnel law holds inside the
 * transaction, same as the save.
 */
export async function deleteDealStage(
  id: string,
  moveToId: string,
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId) throw new DealError('unauthenticated');
  if (id === moveToId) throw new DealError('same_stage');
  const target = await db.query.dealStages.findFirst({ where: eq(dealStages.id, moveToId) });
  if (!target) throw new DealError('stage_not_found');

  await db.transaction(async (tx) => {
    await tx.update(deals).set({ stageId: moveToId }).where(eq(deals.stageId, id));
    await tx.delete(dealStages).where(eq(dealStages.id, id));
    const remaining = await tx.select().from(dealStages).where(eq(dealStages.active, true));
    for (const required of ['open', 'won'] as const) {
      if (!remaining.some((stage) => stage.kind === required)) {
        throw new DealError(`needs_${required}`);
      }
    }
  });
  await writeAudit(db, ctx, {
    entityType: 'deal_stage',
    entityId: id,
    action: 'delete',
    after: { movedTo: moveToId },
  });
}

/** How many deals sit in each stage — shown beside the editor. */
export async function dealStageUsage(): Promise<Record<string, number>> {
  const rows = await db
    .select({ stageId: deals.stageId, n: sql<number>`count(*)` })
    .from(deals)
    .groupBy(deals.stageId);
  return Object.fromEntries(rows.map((row) => [row.stageId, Number(row.n)]));
}

/**
 * Move every open deal in `dealIds` forward to the stage that follows this
 * cargo state — the whole of the owner's item 6 in one function.
 *
 * Forward ONLY: a second truck departing must never drag a deal that is
 * already «tayyor» back to «yo'lda» — with several receipts on one job the
 * SAME state arrives many times, and the furthest point reached is the truth.
 * Won and lost deals are settled and stay where the person put them. The move
 * itself goes through `moveDeal`, so the audit row, the DealStageChanged
 * event and the owner's phase-7 rules all see an automatic move exactly as
 * they see a drag on the board.
 */
export async function applyCargoTrigger(
  dealIds: string[],
  trigger: CargoTrigger,
  ctx: AuditContext,
): Promise<number> {
  if (dealIds.length === 0) return 0;
  const all = await listStages(true);
  // First matching active column left to right; a lost stage never qualifies
  // (the editor refuses it, and this guard holds even against hand-edited
  // rows).
  const target = all.find(
    (stage) => stage.active && stage.cargoTrigger === trigger && stage.kind !== 'lost',
  );
  if (!target) return 0;
  const byId = new Map(all.map((stage) => [stage.id, stage]));
  let moved = 0;
  for (const dealId of dealIds) {
    // Fenced per deal: one refused move must not strand the rest of the truck.
    try {
      const deal = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
      if (!deal) continue;
      const current = byId.get(deal.stageId);
      if (!current || current.kind !== 'open') continue;
      if (target.sortOrder <= current.sortOrder) continue;
      await moveDeal(dealId, target.id, ctx);
      moved += 1;
    } catch (err) {
      logger.error({ err, dealId, trigger }, 'deal auto-stage move failed');
    }
  }
  return moved;
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

const EMPTY_REALITY: DealReality = {
  receiptCount: 0,
  boxCount: 0,
  volumeM3: 0,
  weightKg: 0,
  pendingBoxes: 0,
  arrivedBoxes: 0,
  lostBoxes: 0,
};

/**
 * What actually turned up, summed from the receipts — for a whole LIST of
 * deals in one pair of grouped queries.
 *
 * This is the board's shape, not the card's: `dealsNeedingAttention` asks the
 * question for every open deal on every render of /bitimlar, and asking it one
 * deal at a time was two round trips per deal — ~350 queries on the owner's
 * board, growing with every deal he opens, which is the screen he reported
 * freezing. A deal with no receipts is simply absent from the grouped rows;
 * the caller gets the zero object, which is what per-deal aggregation returned
 * for it anyway.
 *
 * Voided receipts are excluded: a receipt that was cancelled never happened,
 * and counting its volume would make the deal look 40 % over when it is not.
 */
export async function dealRealitiesFor(dealIds: string[]): Promise<Map<string, DealReality>> {
  const map = new Map<string, DealReality>();
  if (dealIds.length === 0) return map;

  const totals = await db
    .select({
      dealId: receipts.dealId,
      receipts: sql<number>`count(DISTINCT ${receipts.id})`,
      boxes: sql<number>`coalesce(sum(${receiptLots.boxCount}), 0)`,
      volume: sql<number>`coalesce(sum(${receiptLots.totalVolumeM3}), 0)`,
      weight: sql<number>`coalesce(sum(${receiptLots.totalWeightKg}), 0)`,
    })
    .from(receipts)
    .leftJoin(receiptLots, eq(receiptLots.receiptId, receipts.id))
    .where(and(inArray(receipts.dealId, dealIds), isNull(receipts.voidedAt)))
    .groupBy(receipts.dealId);

  // inArray/notInArray, never `IN ${array}`: a JS array interpolated into a raw
  // drizzle fragment is bound as ONE parameter and postgres refuses it.
  const settled = notInArray(boxes.status, [...SETTLED_BOX_STATUSES]);
  const arrived = inArray(boxes.status, [...ARRIVED_BOX_STATUSES]);
  const boxStates = await db
    .select({
      dealId: receipts.dealId,
      pending: sql<number>`count(*) FILTER (WHERE ${settled})`,
      arrived: sql<number>`count(*) FILTER (WHERE ${arrived})`,
      lost: sql<number>`count(*) FILTER (WHERE ${boxes.status} = 'lost')`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(and(inArray(receipts.dealId, dealIds), isNull(receipts.voidedAt)))
    .groupBy(receipts.dealId);

  const states = new Map(boxStates.map((row) => [row.dealId, row]));
  for (const row of totals) {
    if (!row.dealId) continue;
    const state = states.get(row.dealId);
    map.set(row.dealId, {
      receiptCount: Number(row.receipts),
      boxCount: Number(row.boxes),
      volumeM3: Number(row.volume),
      weightKg: Number(row.weight),
      pendingBoxes: Number(state?.pending ?? 0),
      arrivedBoxes: Number(state?.arrived ?? 0),
      lostBoxes: Number(state?.lost ?? 0),
    });
  }
  return map;
}

export async function dealReality(dealId: string): Promise<DealReality> {
  return (await dealRealitiesFor([dealId])).get(dealId) ?? EMPTY_REALITY;
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
    /**
     * Read by the CALLER, before its transaction opened.
     *
     * This used to be a `getSetting` right here, and `getSetting` runs on the
     * pooled `db` handle — so a receipt confirm, which is the busiest button
     * in the warehouse, asked for an eleventh connection while its
     * transaction already held one of the ten. That is #714's total freeze in
     * the receive path: ten simultaneous confirms and every screen in the
     * company stops. The value is a number now, and the door is shut for
     * anything else this function grows.
     */
    deviationThreshold: number;
    /**
     * The client's open-deal codes, read by the caller inside its own
     * transaction. Splits the no-deal branch (round 107, owner's item 3): a
     * receipt that COULD be attached to an open deal gets «biriktir», one
     * that has nothing to attach to keeps «narx qo'ying» — they are
     * different jobs for the seller.
     */
    openDealCodes: string[];
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
      // complaints is cargo that was never quoted at all — unless the deal
      // EXISTS and simply was not linked, where the honest ask is «attach
      // it», not «set a price» (the price already lives on the deal).
      await emitEvent(tx, {
        type: input.openDealCodes.length > 0 ? 'UnlinkedCargo' : 'UnquotedCargo',
        payload: {
          openDealCodes: input.openDealCodes,
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
    const threshold = input.deviationThreshold;
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
    // A tiebreak, because two stages may share a sortOrder and Postgres then
    // returns them in whatever order it likes — the funnel's columns would
    // swap between page loads, and anything that picks "the next stage" from
    // this list stops being repeatable. The lead funnel has always had one.
    .orderBy(asc(dealStages.sortOrder), asc(dealStages.name));
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
  quotedWeightKg: string | null;
  /** What the cargo is: the first goods line, or the typed title. */
  goods: string | null;
  /** How many more goods lines there are beyond the first. */
  goodsExtra: number;
  deferred: boolean;
  createdAt: Date;
  /** Where the owner put it in its column; null = nobody has (0075). */
  boardOrder: number | null;
}

/**
 * The board and the list read through here.
 *
 * `ownerId` narrows to one salesperson's own jobs. It is a parameter rather
 * than a rule baked in because who may see everyone's work is a permission
 * question the CALLER already answered — the same split `listLeads` uses.
 */
/**
 * What the deal board's search box matches, as ONE fragment.
 *
 * Shared with `closedDealCounts` for the reason the lead one is: the closed
 * columns show a slice and print the true total, so filtering the cards
 * without filtering the totals makes the «+N · show all» footer lie.
 *
 * It reaches the CLIENT CODE, which is what a person actually types when they
 * are looking for somebody's job — so both queries carry the clients join.
 */
export function dealTextWhere(q?: string) {
  const text = q?.trim();
  if (!text) return undefined;
  const like = likeNeedle(text);
  return sql`(${deals.code} ILIKE ${like} OR ${deals.title} ILIKE ${like} OR ${clients.clientCode} ILIKE ${like})`;
}

/**
 * Everything the board's filter panel can ask (round 71) — the deal board's
 * twin of `LeadBoardFilters`, consumed by `listDeals` AND `closedDealCounts`
 * so the «+N · show all» footer cannot lie on a filtered board (#513).
 */
export interface DealBoardFilters {
  ownerId?: string;
  clientId?: string;
  stageId?: string;
  /** The board's search box (code, title, client code). */
  q?: string;
  createdFrom?: string;
  createdTo?: string;
  amountMin?: number;
  amountMax?: number;
  volMin?: number;
  volMax?: number;
  kgMin?: number;
  kgMax?: number;
  /** Text across the deal's written record: its note and the lenta. */
  lenta?: string;
}

export function dealBoardWhere(filters: DealBoardFilters) {
  const conditions = [];
  const text = dealTextWhere(filters.q);
  if (text) conditions.push(text);
  if (filters.ownerId) conditions.push(eq(deals.ownerId, filters.ownerId));
  if (filters.clientId) conditions.push(eq(deals.clientId, filters.clientId));
  if (filters.stageId) conditions.push(eq(deals.stageId, filters.stageId));
  if (filters.createdFrom) conditions.push(sql`${deals.createdAt} >= ${filters.createdFrom}::date`);
  if (filters.createdTo) conditions.push(sql`${deals.createdAt} < ${filters.createdTo}::date + 1`);
  if (filters.amountMin !== undefined) conditions.push(sql`${deals.quotedAmount} >= ${filters.amountMin}`);
  if (filters.amountMax !== undefined) conditions.push(sql`${deals.quotedAmount} <= ${filters.amountMax}`);
  if (filters.volMin !== undefined) conditions.push(sql`${deals.quotedVolumeM3} >= ${filters.volMin}`);
  if (filters.volMax !== undefined) conditions.push(sql`${deals.quotedVolumeM3} <= ${filters.volMax}`);
  if (filters.kgMin !== undefined) conditions.push(sql`${deals.quotedWeightKg} >= ${filters.kgMin}`);
  if (filters.kgMax !== undefined) conditions.push(sql`${deals.quotedWeightKg} <= ${filters.kgMax}`);
  const lenta = filters.lenta?.trim();
  if (lenta) {
    const like = likeNeedle(lenta);
    // EXISTS, never a join — a card with three matching notes is one card.
    // Telegram messages stay out on purpose: they are per-manager (#383).
    conditions.push(
      sql`(${deals.note} ILIKE ${like} OR EXISTS (
        SELECT 1 FROM crm_activities a
        WHERE a.entity_type = 'deal' AND a.entity_id = ${deals.id} AND a.note ILIKE ${like}
      ))`,
    );
  }
  return conditions;
}

/** See `OPEN_PER_STAGE` on the funnel — the same rule, the same reason. */
export const OPEN_DEALS_PER_STAGE = 40;

/**
 * The deal board's own board-order table (0075).
 *
 * The tie-break is `created_at DESC` and not `updated_at`, because that is
 * what this board has always sorted by: a deal is worked on for weeks and an
 * edit must not shuffle it, which is the very complaint this round answers.
 */
const DEAL_BOARD: BoardTable = { table: deals, tieBreak: sql`created_at DESC` };

export async function listDeals(
  filters: DealBoardFilters & {
    openOnly?: boolean;
    /** Only the finished ones — what the board shows a recent slice of. */
    closedOnly?: boolean;
    limit?: number;
    /** Open cards per COLUMN. Ignored unless `openOnly`. */
    perStage?: number;
  },
): Promise<DealRow[]> {
  // In SQL, never over the fetched array — the closed slice is capped at 20.
  const conditions = dealBoardWhere(filters);
  if (filters.openOnly || filters.closedOnly) {
    const terminal = await db
      .select({ id: dealStages.id })
      .from(dealStages)
      .where(notInArray(dealStages.kind, ['open']));
    if (filters.closedOnly) {
      // No terminal stage at all means nothing is closed — and an empty
      // `inArray` is a SQL error, so say "match nothing" out loud.
      conditions.push(
        terminal.length > 0 ? inArray(deals.stageId, terminal.map((s) => s.id)) : sql`false`,
      );
    } else if (terminal.length > 0) {
      conditions.push(notInArray(deals.stageId, terminal.map((s) => s.id)));
    }
  }

  // The open board is capped PER COLUMN (round 74, the funnel's fix applied
  // to its twin): one LIMIT of 300 sorted by date showed the newest 7 % at a
  // year's volume and understated every open column's header by the same
  // 93 %. One extra query names the surviving ids; the typed select below is
  // untouched, so nothing downstream had to change.
  if (filters.openOnly) {
    const perStage = filters.perStage ?? OPEN_DEALS_PER_STAGE;
    const ranked = await db.execute<{ id: string }>(sql`
      SELECT id FROM (
        SELECT ${deals.id} AS id,
               row_number() OVER (
                 PARTITION BY ${deals.stageId}
                 ORDER BY ${deals.boardOrder} ASC NULLS FIRST, ${deals.createdAt} DESC
               ) AS rn
        FROM ${deals}
        INNER JOIN ${clients} ON ${clients.id} = ${deals.clientId}
        ${conditions.length ? sql`WHERE ${and(...conditions)}` : sql``}
      ) ranked
      WHERE rn <= ${perStage}
    `);
    if (ranked.length === 0) return [];
    conditions.push(
      inArray(
        deals.id,
        ranked.map((row) => row.id),
      ),
    );
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
      quotedWeightKg: deals.quotedWeightKg,
      deferredAt: deals.deferredAt,
      deferralEndedAt: deals.deferralEndedAt,
      createdAt: deals.createdAt,
      boardOrder: deals.boardOrder,
    })
    .from(deals)
    .innerJoin(clients, eq(deals.clientId, clients.id))
    .leftJoin(users, eq(deals.ownerId, users.id))
    .where(conditions.length ? and(...conditions) : undefined)
    // The owner's own order first (0075), «newest raised» only where nobody
    // has placed a card — and THE SAME two keys rank the per-stage cap above,
    // or the board sends forty cards and draws a different forty. The closed
    // slice is cut by `limit` and the numbers are per-column ranks, so what
    // survives is the top of every closed column (the funnel's own note).
    .orderBy(sql`${deals.boardOrder} ASC NULLS FIRST`, desc(deals.createdAt))
    .limit(filters.limit ?? 300);

  // What the cargo IS, which the owner reads before anything else on a board
  // card: «tovar nomi muhum». A deal says it twice — the title somebody typed
  // when they raised it, and the goods lines the VED files during hisoblash —
  // and neither is always there, so the card takes whichever exists and the
  // lines win, being the priced truth. ONE grouped query for the whole board:
  // a description per row would be a query per card (#432, #526).
  const goods = new Map<string, { first: string; extra: number }>();
  if (rows.length > 0) {
    const lines = await db
      .select({
        dealId: dealLines.dealId,
        first: sql<string>`(array_agg(${dealLines.description} ORDER BY ${dealLines.seq}))[1]`,
        n: sql<number>`count(*)`,
      })
      .from(dealLines)
      .where(
        inArray(
          dealLines.dealId,
          rows.map((row) => row.id),
        ),
      )
      .groupBy(dealLines.dealId);
    for (const line of lines) {
      goods.set(line.dealId, { first: line.first, extra: Number(line.n) - 1 });
    }
  }

  return rows.map(({ deferredAt, deferralEndedAt, ...row }) => {
    const own = goods.get(row.id);
    return {
      ...row,
      goods: own?.first ?? row.title ?? null,
      goodsExtra: own?.extra ?? 0,
      deferred: Boolean(deferredAt) && !deferralEndedAt,
    };
  });
}

/**
 * How many finished deals each closed stage really holds (round 47).
 *
 * The board draws a recent slice of them and the header keeps the true total,
 * so «Sotuv 143» stays 143 even when twelve cards are on screen.
 */
/**
 * How many OPEN deals each column really holds (round 74).
 *
 * The twin of `closedDealCounts`, and what lets the open half be capped per
 * column without lying: the cards are a slice, the header is the truth.
 */
export async function openDealCounts(
  filters: DealBoardFilters,
): Promise<Record<string, number>> {
  const where = [eq(dealStages.kind, 'open'), ...dealBoardWhere(filters)];
  const rows = await db
    .select({ stageId: deals.stageId, n: sql<number>`count(*)` })
    .from(deals)
    .innerJoin(dealStages, eq(deals.stageId, dealStages.id))
    // The predicate reaches the client code, so the join comes with it.
    .innerJoin(clients, eq(deals.clientId, clients.id))
    .where(and(...where))
    .groupBy(deals.stageId);
  return Object.fromEntries(rows.map((row) => [row.stageId, Number(row.n)]));
}

export async function closedDealCounts(
  filters: DealBoardFilters,
): Promise<Record<string, number>> {
  // The SAME builder as the rows (#513) — a filter the counts do not hear
  // makes the «+N · show all» footer lie on a filtered board.
  const where = [notInArray(dealStages.kind, ['open']), ...dealBoardWhere(filters)];
  const rows = await db
    .select({ stageId: deals.stageId, n: sql<number>`count(*)` })
    .from(deals)
    .innerJoin(dealStages, eq(deals.stageId, dealStages.id))
    // The predicate reaches the client code, so the join comes with it.
    .innerJoin(clients, eq(deals.clientId, clients.id))
    .where(and(...where))
    .groupBy(deals.stageId);
  return Object.fromEntries(rows.map((row) => [row.stageId, Number(row.n)]));
}

export async function dealById(id: string) {
  const [row] = await db
    .select({
      deal: deals,
      clientCode: clients.clientCode,
      clientName: clients.name,
      /** For the Telegram lookback panel — the card already joins the client. */
      clientPhones: clients.phones,
      /** Pre-selects the offer's language. NULL for nearly everybody, which
          is exactly why the seller chooses rather than the column deciding. */
      clientLocale: clients.locale,
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
  // The same contents the PICKER prints (round 79): linking a prixod must
  // not cost it its goods/kg/m³ — the enrichment had been written into one
  // of the two readers only (round 100, owner's item 2).
  const contents = await receiptContents(linked.map((r) => r.id));
  return {
    ...row,
    lines,
    receipts: linked.map((r) => {
      const own = contents.get(r.id);
      return {
        ...r,
        goods: own?.goods ?? '',
        volumeM3: own ? Number(own.volumeM3) : 0,
        weightKg: own ? Number(own.weightKg) : 0,
      };
    }),
  };
}

/**
 * What a set of prixods CONTAINS — goods (ru name preferred), kg, m³ — in
 * ONE grouped query (#432). The picker and the linked list both read this,
 * so the two say the same words about the same cargo.
 */
async function receiptContents(receiptIds: string[]) {
  if (receiptIds.length === 0)
    return new Map<string, { goods: string; volumeM3: string; weightKg: string }>();
  const rows = await db
    .select({
      receiptId: receiptLots.receiptId,
      goods: sql<string>`string_agg(DISTINCT coalesce(nullif(${receiptLots.productNameRu}, ''), ${receiptLots.productNameZh}), ', ')`,
      volumeM3: sql<string>`coalesce(sum(${receiptLots.totalVolumeM3}), 0)`,
      weightKg: sql<string>`coalesce(sum(${receiptLots.totalWeightKg}), 0)`,
    })
    .from(receiptLots)
    .where(inArray(receiptLots.receiptId, receiptIds))
    .groupBy(receiptLots.receiptId);
  return new Map(rows.map((row) => [row.receiptId, row]));
}

/** Confirmed receipts of this client that belong to no deal yet. */
/**
 * The client's confirmed prixods that belong to no deal yet.
 *
 * Each row carries WHAT IS IN IT, not when it landed. A picker reading
 * «YW-in-001 · 2026-08-04» asks somebody to remember which day which cargo
 * arrived; the owner: «bizga date kerak emas, shuni tovar nomi va kg kubini
 * ko'rsatadigan qilsa bo'ladimi». The goods name is the receipt's own lots,
 * joined in ONE grouped query rather than one per row (#432) — and it is the
 * Russian name when there is one, because the pickers here are read by the
 * Uzbek office and `product_name_zh` is the supplier's own label.
 */
export async function unlinkedReceipts(clientId: string) {
  const rows = await db
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
  if (rows.length === 0) return [];

  const byReceipt = await receiptContents(rows.map((row) => row.id));

  return rows.map((row) => {
    const own = byReceipt.get(row.id);
    return {
      ...row,
      goods: own?.goods ?? '',
      volumeM3: own ? Number(own.volumeM3) : 0,
      weightKg: own ? Number(own.weightKg) : 0,
    };
  });
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
 * The deals the LEDGER may attach money to (round 100 item 3).
 *
 * Wider than the receiving picker on purpose: the cargo triggers walk a deal
 * into its won column the moment the last box is handed over, so a charge
 * posted the day after delivery — the commonest correction there is — would
 * find an open-only list empty and silently land with no deal, which the
 * deferral gate and dealProfit can never see. Open deals, anything decided
 * in the last 60 days, and anything with a LIVE deferral (whatever its age —
 * that deferral exists to cover exactly this charge).
 */
export async function ledgerDealsForClient(clientId: string) {
  const cutoff = new Date(Date.now() - 60 * 24 * 3600 * 1000);
  return db
    .select({
      id: deals.id,
      code: deals.code,
      title: deals.title,
      quotedAmount: deals.quotedAmount,
      quotedCurrency: deals.quotedCurrency,
    })
    .from(deals)
    .innerJoin(dealStages, eq(deals.stageId, dealStages.id))
    .where(
      and(
        eq(deals.clientId, clientId),
        or(
          eq(dealStages.kind, 'open'),
          gte(deals.closedAt, cutoff),
          and(isNotNull(deals.deferredAt), isNull(deals.deferralEndedAt)),
        ),
      ),
    )
    .orderBy(desc(deals.createdAt))
    .limit(40);
}

/**
 * The open book, in two honest numbers (round 107, the admin home): how many
 * jobs are open, and what the USD-quoted ones add up to. The sum FILTERS on
 * currency — a CNY quote added at face value to dollars is #701's «money
 * from raw columns is confidently wrong» — and the non-USD leftovers are
 * counted so the card can say «+N boshqa valyutada» instead of lying by
 * omission. A quote on an open deal is a pipeline figure, not cash; the
 * label's job, stated here so it stays that way.
 */
export async function openDealsSummary() {
  const [row] = await db
    .select({
      n: sql<number>`count(*)`,
      usd: sql<string>`coalesce(sum(${deals.quotedAmount}) FILTER (WHERE ${deals.quotedCurrency} = 'USD'), 0)`,
      otherCurrency: sql<number>`count(*) FILTER (WHERE ${deals.quotedAmount} IS NOT NULL AND ${deals.quotedCurrency} <> 'USD')`,
    })
    .from(deals)
    .innerJoin(dealStages, eq(deals.stageId, dealStages.id))
    .where(eq(dealStages.kind, 'open'));
  return {
    count: Number(row?.n ?? 0),
    usdSum: Math.round(Number(row?.usd ?? 0) * 100) / 100,
    otherCurrency: Number(row?.otherCurrency ?? 0),
  };
}

/**
 * Deals that need somebody's attention right now, for the client card and the
 * sales manager's day: quoted but the cargo is over the threshold, or landed
 * with no price at all.
 */
export async function dealsNeedingAttention(ownerId?: string, q?: string): Promise<
  { id: string; code: string; clientCode: string; clientName: string; reason: string; pct: number | null }[]
> {
  // The filter reaches here too — narrowing the board narrows this as well.
  // The realities come GROUPED: this used to be two queries per open deal on
  // every render of the board, which is the linear cost that turned into the
  // owner's «qotyabti» as his deal count grew. The quote columns ride on the
  // list row for the same reason — refetching each deal to read its quoted
  // weight was a third query per row.
  const rows = await listDeals({ ownerId, q, openOnly: true, limit: 200 });
  const [threshold, realities] = await Promise.all([
    deviationThreshold(),
    dealRealitiesFor(rows.map((row) => row.id)),
  ]);
  const out = [];
  for (const row of rows) {
    const reality = realities.get(row.id);
    if (!reality || reality.receiptCount === 0) continue;
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
    const deviation = compareQuote(
      {
        volumeM3: row.quotedVolumeM3 === null ? null : Number(row.quotedVolumeM3),
        weightKg: row.quotedWeightKg === null ? null : Number(row.quotedWeightKg),
        amount: Number(row.quotedAmount),
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
