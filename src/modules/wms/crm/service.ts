import { and, asc, desc, eq, inArray, isNull, isNotNull, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  clients,
  crmActivities,
  deals,
  leads,
  leadSources,
  leadStages,
  lostReasons,
  users,
} from '../../platform/db/schema';
import { diffFields, writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';
import { createClient } from '../../platform/clients/service';
import { likeNeedle, parseQuery } from '../search/query';
import { closedAtFor, reasonAllowed, stageWrite } from './stage-law';
import { orderForMove, topOfColumn, type BoardTable } from './board-place';
import { isUniqueViolation } from '../../platform/db/errors';
import { logger } from '../../platform/logger';
import { isServerBehind } from '../../platform/db/errors';

/**
 * The funnel's own board-order table (0075).
 *
 * The tie-break is `updated_at DESC` because that is the order this board has
 * always shown, and it is what an unplaced card still falls back to — the
 * numbers took over the ordering, they did not change what «unordered» means.
 */
const LEAD_BOARD: BoardTable = { table: leads, tieBreak: sql`updated_at DESC` };

/**
 * Phase 7 hears the funnel through this one door. Every path that changes a
 * lead's stage announces it — the board's move, the edit form, conversion —
 * or a rule watching «entered stage X» would fire on some moves and sleep
 * through others depending on WHICH button did it.
 */
async function announceLeadStage(
  lead: { id: string; name: string; ownerId: string | null },
  stageId: string,
  ctx: AuditContext,
): Promise<void> {
  const stage = await db.query.leadStages.findFirst({ where: eq(leadStages.id, stageId) });
  await emitEvent(db, {
    type: 'LeadStageChanged',
    payload: {
      leadId: lead.id,
      leadName: lead.name,
      stageId,
      stageName: stage?.name ?? '',
      stageKind: stage?.kind ?? 'open',
      ownerId: lead.ownerId,
    },
    entityType: 'lead',
    entityId: lead.id,
    actorId: ctx.actorId,
  });
}

/**
 * CRM (Phase 2.3) — the sales job BEFORE a client code exists, and the record
 * of every conversation after it does.
 *
 * Deliberately narrow. The client registry, the Telegram cabinet, the money
 * ledger and profit-per-client already exist and are not rebuilt here. What
 * was missing is three things a kargo business actually loses money on:
 * people who asked about prices and were never called back, a client who
 * quietly stopped sending cargo, and a conversation nobody wrote down.
 *
 * There are still NO tariffs (DECISIONS #108): a price is agreed per
 * shipment, so a lead carries a note about what was quoted, not a price list.
 */

export class CrmError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const OPTIONAL_DATE = DATE.optional().or(z.literal(''));

// --- Dictionaries the owner maintains -------------------------------------

export const sourceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
  active: z.boolean().default(true),
});

/** Compiled Tailwind classes, so the palette cannot be free-form. */
export const STAGE_COLORS = ['gray', 'blue', 'green', 'amber', 'red', 'purple', 'teal'] as const;

export const stageSchema = sourceSchema.extend({
  /** The only part the code reasons about; the NAME is the owner's to choose. */
  kind: z.enum(['open', 'won', 'lost']).default('open'),
  color: z.enum(STAGE_COLORS).default('gray'),
});

export async function listSources(includeInactive = false) {
  return db
    .select()
    .from(leadSources)
    .where(includeInactive ? undefined : eq(leadSources.active, true))
    .orderBy(asc(leadSources.sortOrder), asc(leadSources.name));
}

export async function listStages(includeInactive = false) {
  return db
    .select()
    .from(leadStages)
    .where(includeInactive ? undefined : eq(leadStages.active, true))
    .orderBy(asc(leadStages.sortOrder), asc(leadStages.name));
}

export async function saveSource(
  input: z.infer<typeof sourceSchema> & { id?: string },
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  const values = { name: input.name, sortOrder: input.sortOrder, active: input.active };
  const sourceId = input.id;
  const [row] = await catchTakenName(() =>
    sourceId
      ? db.update(leadSources).set(values).where(eq(leadSources.id, sourceId)).returning()
      : db.insert(leadSources).values(values).returning(),
  );
  if (!row) throw new CrmError('not_found');
  await writeAudit(db, ctx, {
    entityType: 'lead_source',
    entityId: row.id,
    action: input.id ? 'update' : 'create',
    after: values,
  });
  return row;
}

/**
 * The lost-reason dictionary (0076). One list for BOTH funnels — «narx
 * qimmat» kills a lead and a deal the same way, and two lists would make the
 * analytics page's breakdown add across two spellings of one answer.
 */
export async function listLostReasons(includeInactive = false) {
  return db
    .select()
    .from(lostReasons)
    .where(includeInactive ? undefined : eq(lostReasons.active, true))
    .orderBy(asc(lostReasons.sortOrder), asc(lostReasons.label));
}

export async function activeLostReasonLabels(): Promise<string[]> {
  const rows = await listLostReasons();
  return rows.map((row) => row.label);
}

/** Any dictionary write, with a taken name turned into a coded refusal. */
async function catchTakenName<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (isUniqueViolation(err)) throw new CrmError('name_taken');
    throw err;
  }
}

export async function saveLostReason(
  input: { id?: string; label: string; sortOrder: number; active: boolean },
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  const label = input.label.trim();
  if (label.length < 2) throw new CrmError('reason_required');
  const values = { label, sortOrder: input.sortOrder, active: input.active };
  // `lost_reasons_label_unique` is ON lower(label), so «Narx» collides with
  // «narx» — which is precisely the pair the owner cannot tell apart on his
  // own screen, and precisely why the answer must be a sentence and not the
  // error page (#472).
  const [row] = await catchTakenName(() =>
    input.id
      ? db.update(lostReasons).set(values).where(eq(lostReasons.id, input.id)).returning()
      : db.insert(lostReasons).values(values).returning(),
  );
  if (!row) throw new CrmError('not_found');
  await writeAudit(db, ctx, {
    entityType: 'lost_reason',
    entityId: row.id,
    action: input.id ? 'update' : 'create',
    after: values,
  });
  return row;
}

export async function saveStage(
  input: z.infer<typeof stageSchema> & { id?: string },
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  const values = {
    name: input.name,
    kind: input.kind,
    color: input.color,
    sortOrder: input.sortOrder,
    active: input.active,
  };
  const row = await db.transaction(async (tx) => {
    const [saved] = input.id
      ? await tx.update(leadStages).set(values).where(eq(leadStages.id, input.id)).returning()
      : await tx.insert(leadStages).values(values).returning();
    if (!saved) throw new CrmError('not_found');
    // A funnel with no won stage silently breaks conversion; a funnel with no
    // open stage leaves nowhere to put a new lead. Checked INSIDE the
    // transaction so a refusal rolls the change back — validating after the
    // write left the funnel in exactly the state it had just refused.
    const remaining = await tx.select().from(leadStages).where(eq(leadStages.active, true));
    for (const required of ['open', 'won'] as const) {
      if (!remaining.some((stage) => stage.kind === required)) {
        throw new CrmError(`needs_${required}`);
      }
    }
    return saved;
  });
  await writeAudit(db, ctx, {
    entityType: 'lead_stage',
    entityId: row.id,
    action: input.id ? 'update' : 'create',
    after: values,
  });
  return row;
}

/**
 * Reorder the funnel in one go (owner: "etaplarni qo'shib-ayirish imkoni").
 *
 * Takes the stage ids in the order the owner arranged them and rewrites
 * `sort_order` from that, so dragging a stage between two others never has to
 * renumber by hand and two stages can never share a position.
 */
export async function reorderStages(ids: string[], ctx: AuditContext) {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  await db.transaction(async (tx) => {
    for (const [index, stageId] of ids.entries()) {
      await tx
        .update(leadStages)
        .set({ sortOrder: (index + 1) * 10 })
        .where(eq(leadStages.id, stageId));
    }
  });
  await writeAudit(db, ctx, {
    entityType: 'lead_stage',
    entityId: ids[0] ?? '00000000-0000-0000-0000-000000000000',
    action: 'update',
    after: { order: ids },
  });
}

/**
 * Remove a stage, moving whatever sits in it somewhere else first.
 *
 * Deleting a stage that still holds leads would either orphan them or hide
 * them from every screen, so the caller must say where they go — and the
 * funnel must still have an open and a won stage when the dust settles.
 */
export async function deleteStage(id: string, moveToId: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  if (id === moveToId) throw new CrmError('same_stage');
  const target = await db.query.leadStages.findFirst({ where: eq(leadStages.id, moveToId) });
  if (!target) throw new CrmError('stage_not_found');
  // Deleting a column must not silently DECIDE its leads: a won landing needs
  // a client and a deal per lead, a lost one a reason — neither can be
  // answered by a mass move (round 107).
  if (target.kind !== 'open') throw new CrmError('move_target_closed');

  await db.transaction(async (tx) => {
    await tx.update(leads).set({ stageId: moveToId }).where(eq(leads.stageId, id));
    await tx.delete(leadStages).where(eq(leadStages.id, id));
    const remaining = await tx.select().from(leadStages).where(eq(leadStages.active, true));
    for (const required of ['open', 'won'] as const) {
      if (!remaining.some((stage) => stage.kind === required)) {
        throw new CrmError(`needs_${required}`);
      }
    }
  });

  await writeAudit(db, ctx, {
    entityType: 'lead_stage',
    entityId: id,
    action: 'delete',
    after: { movedTo: moveToId },
  });
}

/** How many leads sit in each stage — shown before a stage can be removed. */
export async function stageUsage() {
  const rows = await db
    .select({ stageId: leads.stageId, n: sql<number>`count(*)` })
    .from(leads)
    .groupBy(leads.stageId);
  return Object.fromEntries(rows.map((row) => [row.stageId, Number(row.n)]));
}

// --- Leads ------------------------------------------------------------------

export const leadSchema = z.object({
  name: z.string().trim().min(2).max(200),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  company: z.string().trim().max(200).optional().or(z.literal('')),
  sourceId: z.string().uuid().optional().or(z.literal('')),
  stageId: z.string().uuid().optional().or(z.literal('')),
  ownerId: z.string().uuid().optional().or(z.literal('')),
  note: z.string().trim().max(4000).optional().or(z.literal('')),
  /**
   * The SERVICE price, written after the hisoblatish stage (round 71 — the
   * owner's answer overriding #108's "no price on a lead"): the number that
   * rides with the lead into won/lost, and into the deal's quote when the won
   * lead opens its job. Null means "not quoted yet", which is most leads.
   */
  quotedAmount: z.number().nonnegative().nullable().optional(),
  quotedCurrency: z.enum(['USD', 'UZS', 'CNY']).nullable().optional(),
  quotedVolumeM3: z.number().nonnegative().nullable().optional(),
  quotedWeightKg: z.number().nonnegative().nullable().optional(),
  nextActionAt: OPTIONAL_DATE,
  nextActionNote: z.string().trim().max(500).optional().or(z.literal('')),
});
export type LeadInput = z.infer<typeof leadSchema>;

/** The first open stage, used when a lead is created without one. */
async function defaultStageId() {
  const stages = await listStages();
  const first = stages.find((stage) => stage.kind === 'open') ?? stages[0];
  if (!first) throw new CrmError('no_stages');
  return first.id;
}

/**
 * The lead's quote, written as the DATABASE will hand it back: numeric(14,2)
 * returns trailing-zero strings ("1500.00"), and `diffFields` compares
 * strings — write "1500" where postgres stores "1500.00" and every later
 * save would audit a phantom change and reshuffle the board (#503's lesson,
 * one table over). A currency without an amount is noise, so it clears with
 * the price.
 */
/**
 * A sealed price is a fact about what the client was told, so the ✏️ form may
 * not quietly overwrite it (docs/VED.md law 2).
 *
 * The check is a CHANGE check and not a presence check, and #171 is why: the
 * form posts every field it renders, so a locked quote re-posts its own
 * values as hidden inputs and an ordinary save — a corrected phone number,
 * say — must not become a refusal. Only a DIFFERENT number is refused, and
 * the door back is «Qayta hisoblash», which mints a new calculation.
 *
 * Dynamically imported: `calc/workspace` reaches this module through
 * `calc/service`, and a static import would close the circle.
 */
export async function quoteLockedFor(
  entityType: 'lead' | 'deal',
  entityId: string,
): Promise<number | null> {
  try {
    const { currentSealFor, releasedPriceFor } = await import('../calc/workspace');
    const seal = await currentSealFor(entityType, entityId);
    if (!seal) return null;
    // What is LOCKED is what is on the card, which is not always the floor.
    //
    // Phase D writes the released CLIENT price onto `quoted_amount`, because
    // law 4 says the client pays the VED price plus the upsale and every
    // revenue surface reads that column. The lock compares the form's posted
    // value against this number, and the locked form re-posts what it renders
    // (#171) — so returning the floor here would refuse EVERY later save on a
    // card that has been quoted, for ever. Found by reading the lock, not by
    // a test: the card and the lock have to agree about which number is the
    // one nobody may change.
    const offered = await releasedPriceFor(entityType, entityId);
    // LATER WRITER WINS, by the clock, because that is exactly how the card
    // column was written: sealCalc stamps the floor at seal time, an offer
    // stamps the client price when it is made or released. A deal carries
    // many jobs (0085 dropped one-open-per-card), so «offer beats seal»
    // unconditionally would hold the lock on job A's released price after
    // job B's newer seal rewrote the card — and every later ✏️ save would be
    // refused against a number the card no longer shows.
    if (offered && offered.at >= seal.sealedAt) return offered.price;
    return seal.totalUsd;
  } catch (err) {
    // Deploy morning: this module works without 0086, and the lock is a
    // safeguard rather than a gate — its absence must not take the card down.
    if (!isServerBehind(err)) throw err;
    logger.error({ err, entityType, entityId }, '[crm] quote lock: server behind');
    return null;
  }
}

const sameMoney = (a: number | null, b: string | null) =>
  a === null ? b === null : b !== null && Math.abs(a - Number(b)) < 0.005;

function quoteValues(input: LeadInput) {
  const money = (n: number | null | undefined) => (n == null ? null : n.toFixed(2));
  const size = (n: number | null | undefined) => (n == null ? null : n.toFixed(3));
  const priced = input.quotedAmount !== null && input.quotedAmount !== undefined;
  return {
    quotedAmount: money(input.quotedAmount),
    quotedCurrency: priced ? (input.quotedCurrency ?? 'USD') : null,
    quotedVolumeM3: size(input.quotedVolumeM3),
    quotedWeightKg: size(input.quotedWeightKg),
  };
}

/**
 * Somebody already in the funnel who looks like this one.
 *
 * The owner: «CRM da lead dublicat bo'lmasligiga e'tibor ber, kimdir uje bor
 * leadni kirgazsa bu uje borligini ogohlantirsin». Two sellers taking the same
 * enquiry is not a data problem, it is two people ringing one customer about
 * one shipment — which is the exact harm the funnel's ownership rule exists to
 * prevent (#200).
 *
 * The PHONE is the only strong match and it is compared the way the whole app
 * compares phones: the last nine digits, so «+998 90 123 45 67» and
 * «901234567» are one person. The name is a weak match and is used only when
 * there is no phone to go on — two «Aziz»es are common and refusing them would
 * teach people to click past the warning.
 *
 * OPEN leads only: a lost lead coming back IS a new enquiry, and a won one is
 * already a client. Never blocks — it hands back who it found and the caller
 * decides. A duplicate that a person has looked at and still wants is a
 * legitimate record; one nobody was told about is the bug.
 */
export async function similarLeads(input: { phone?: string | null; name?: string }) {
  const digits = (input.phone ?? '').replace(/[^0-9]/g, '').slice(-9);
  const name = (input.name ?? '').trim();
  if (digits.length < 9 && name.length < 3) return [];

  const open = await db
    .select({ id: leadStages.id })
    .from(leadStages)
    .where(eq(leadStages.kind, 'open'));
  if (open.length === 0) return [];

  const match =
    digits.length === 9
      ? sql`right(regexp_replace(coalesce(${leads.phone}, ''), '[^0-9]', '', 'g'), 9) = ${digits}`
      : sql`lower(${leads.name}) = lower(${name})`;

  return db
    .select({
      id: leads.id,
      name: leads.name,
      phone: leads.phone,
      ownerName: users.fullName,
    })
    .from(leads)
    .leftJoin(users, eq(leads.ownerId, users.id))
    .where(
      and(
        match,
        inArray(
          leads.stageId,
          open.map((row) => row.id),
        ),
      ),
    )
    .orderBy(desc(leads.updatedAt))
    .limit(5);
}

/**
 * `system: true` = nobody pressed anything.
 *
 * An advert lead has no author, and `leads.created_by` was NOT NULL until
 * migration 0065 precisely because until now every lead came from a person.
 * Naming the round-robin owner as the author would put a sentence in the audit
 * trail that nobody said, so the column is left null and the option has to be
 * asked for explicitly — an actorless call from a screen is still a bug.
 */
export interface SystemOpts {
  system?: true;
}

export async function createLead(input: LeadInput, ctx: AuditContext, opts?: SystemOpts) {
  if (!ctx.actorId && !opts?.system) throw new CrmError('unauthenticated');
  const stageId = input.stageId || (await defaultStageId());
  // A lead cannot be BORN decided (round 107). Won demands the convert dialog
  // — a client and a deal — and lost demands a written reason; the create form
  // offers neither, so a closed stageId arriving here is a forged post (#514),
  // not a person's choice. The picker stopped offering them in the same round.
  if (input.stageId) {
    const stage = await db.query.leadStages.findFirst({ where: eq(leadStages.id, stageId) });
    if (!stage) throw new CrmError('stage_not_found');
    if (stage.kind === 'won') throw new CrmError('convert_required');
    if (stage.kind === 'lost') throw new CrmError('reason_required');
  }
  const [row] = await db
    .insert(leads)
    .values({
      name: input.name,
      phone: input.phone || null,
      company: input.company || null,
      sourceId: input.sourceId || null,
      stageId,
      // An unassigned lead is the one nobody calls, so it defaults to whoever
      // entered it rather than to nobody. A machine is not a "whoever": an
      // inbound lead with no free seller stays unowned on purpose, and
      // `followUps` shows an unclaimed one to everybody (round 74's rule).
      ownerId: input.ownerId || ctx.actorId,
      note: input.note || null,
      ...quoteValues(input),
      nextActionAt: input.nextActionAt || null,
      nextActionNote: input.nextActionNote || null,
      createdBy: ctx.actorId,
      // A new lead belongs at the top of its column — which is where it has
      // always appeared, back when «top» only meant «most recently touched».
      // Numbering it here rather than leaving it NULL keeps the whole column
      // comparable, so the first card somebody drags past it lands where they
      // dropped it instead of under everything unplaced.
      boardOrder: await topOfColumn(db, LEAD_BOARD, stageId),
    })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'lead',
    entityId: row!.id,
    action: 'create',
    after: { name: input.name, phone: input.phone, stageId },
  });
  return row!;
}

export async function updateLead(id: string, input: LeadInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  const before = await db.query.leads.findFirst({ where: eq(leads.id, id) });
  if (!before) throw new CrmError('not_found');
  // The business columns, WITHOUT `updatedAt`: a fresh Date never equals the
  // stored one, so diffing a value set that carries it always reports a change.
  const values = {
    name: input.name,
    phone: input.phone || null,
    company: input.company || null,
    sourceId: input.sourceId || null,
    stageId: input.stageId || before.stageId,
    ownerId: input.ownerId || null,
    note: input.note || null,
    ...quoteValues(input),
    nextActionAt: input.nextActionAt || null,
    nextActionNote: input.nextActionNote || null,
  };

  const sealedTotal = await quoteLockedFor('lead', id);
  if (sealedTotal !== null && !sameMoney(sealedTotal, values.quotedAmount)) {
    throw new CrmError('quote_sealed');
  }

  /*
   * The funnel's law, asked by the SECOND door too.
   *
   * This form writes `stage_id` from a `<select>` of every stage, and until
   * round 83 it neither demanded a reason for «Yo'qotildi» nor cleared the
   * one a revived lead was still carrying. It carries no reason box, so
   * passing none is what makes the shared rule refuse it — the board keeps
   * the only door that can lose a lead, because it is the only one that asks
   * why. Only on an actual MOVE: an ordinary save on a lead that is already
   * lost must not be a refusal, and must not wipe its reason either.
   */
  let lostReason: string | null | undefined;
  let closedAt: Date | null | undefined;
  if (values.stageId !== before.stageId) {
    const stage = await db.query.leadStages.findFirst({
      where: eq(leadStages.id, values.stageId),
    });
    if (!stage) throw new CrmError('stage_not_found');
    const law = stageWrite(stage.kind, null);
    if (!law.ok) throw new CrmError(law.reason);
    // Winning demands the dialog — a client and a deal — and this form has
    // neither (round 107). The picker stopped offering won stages in the same
    // round, so reaching this line is a forged post, not a person's choice.
    if (stage.kind === 'won') throw new CrmError('convert_required');
    lostReason = law.lostReason;
    closedAt = closedAtFor(stage.kind, new Date());
  }

  const [row] = await db
    .update(leads)
    .set({
      ...values,
      ...(lostReason === undefined ? {} : { lostReason }),
      ...(closedAt === undefined ? {} : { closedAt }),
      // A stage changed from the ✏️ form is still an arrival: this door says
      // nothing about position, so the card goes to the top of where it lands
      // exactly as the board's own move does. Left alone otherwise — an
      // ordinary save must not reshuffle the column somebody arranged.
      ...(values.stageId !== before.stageId
        ? { boardOrder: await topOfColumn(db, LEAD_BOARD, values.stageId) }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(leads.id, id))
    .returning();
  // The form writes nine columns; the audit used to record three fixed ones,
  // so correcting a phone here left no trace while correcting it inline did —
  // and every save wrote a row whose before equalled its after. The trail says
  // what changed, or it says nothing.
  const diff = diffFields(before, values);
  if (diff) {
    await writeAudit(db, ctx, {
      entityType: 'lead',
      entityId: id,
      action: 'update',
      before: diff.before,
      after: diff.after,
    });
  }
  if (values.stageId !== before.stageId) await announceLeadStage(row!, values.stageId, ctx);
  return row!;
}

/**
 * Hand a lead to somebody, and nothing else.
 *
 * `updateLead` replaces every field it is given, so using it to change one
 * would blank the other nine unless the caller re-sent them — which is fine
 * for a form that HAS them all and wrong for a bulk action that has an id and
 * a name. The audit row says exactly what changed, which is the point.
 */
export async function setLeadOwner(id: string, ownerId: string | null, ctx: AuditContext) {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  const before = await db.query.leads.findFirst({ where: eq(leads.id, id) });
  if (!before) throw new CrmError('not_found');
  if (before.ownerId === ownerId) return;
  await db.update(leads).set({ ownerId, updatedAt: new Date() }).where(eq(leads.id, id));
  await writeAudit(db, ctx, {
    entityType: 'lead',
    entityId: id,
    action: 'update',
    before: { ownerId: before.ownerId },
    after: { ownerId },
  });
}

/**
 * Move a lead along the funnel.
 *
 * A lost stage demands a reason — "why did we lose them" is the only thing
 * that makes a lost-deal list worth reading a year later — and moving back
 * out of lost clears it rather than leaving a stale explanation attached.
 *
 * `place` is the DRAG, and only the drag: it names the card the moved one
 * landed above, so a drop inside one column is a real move (round 96, the
 * owner's «qaysi ketma ketlikda qoysa usha saqlanib qoladgan»). Every other
 * caller — the one-tap button, the ⋯ sheet, a bulk sweep, an automation rule,
 * the cargo trigger — passes nothing and lands at the top of the destination.
 */
export async function moveLead(
  id: string,
  stageId: string,
  reason: string,
  ctx: AuditContext,
  place?: { beforeId: string | null },
  opts?: {
    /**
     * Only `winLead` sets this, and no server ACTION exposes it (a public
     * action taking a `viaConvert` argument would BE the bypass — any browser
     * can call an action with arbitrary arguments). The guard below is what
     * makes the convert dialog mandatory rather than polite.
     */
    viaConvert?: boolean;
  },
) {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, id) });
  if (!lead) throw new CrmError('not_found');
  const stage = await db.query.leadStages.findFirst({ where: eq(leadStages.id, stageId) });
  if (!stage) throw new CrmError('stage_not_found');
  const law = stageWrite(stage.kind, reason);
  if (!law.ok) throw new CrmError(law.reason);
  // Winning is not a drag, it is a handover (round 107, owner: «kod ochish
  // majburiy bo'lsin yokida eski klient kodga biriktirib bitimga o'tish
  // kerak»): a real move into a won stage must come through `winLead`, which
  // settles the client and opens the deal first. A same-column drag inside
  // won stays a reorder — deciding nothing is exactly what it does.
  if (stage.kind === 'won' && stage.id !== lead.stageId && !opts?.viaConvert)
    throw new CrmError('convert_required');
  // Once the owner has written his list, «why we lost» is one of ITS answers —
  // the pickers offer only those, so anything else arriving here is a forged
  // post. An empty list keeps free text legal (day one, and every test fixture
  // written before the dictionary existed).
  if (law.lostReason !== null && !reasonAllowed(law.lostReason, await activeLostReasonLabels()))
    throw new CrmError('lost_reason_not_listed');

  const boardOrder = await orderForMove(db, LEAD_BOARD, stageId, id, place);
  await db
    .update(leads)
    .set({
      stageId,
      lostReason: law.lostReason,
      boardOrder,
      // Only a real move decides anything: a drag inside the won column is a
      // re-order, not a second win, and must not move the month it counts in.
      ...(stageId !== lead.stageId
        ? {
            closedAt: closedAtFor(stage.kind, new Date()),
            nextActionAt: null,
            nextActionNote: null,
            // Moving the card IS the work (owner's answer, go-live day):
            // «bosqichni o'zgartirgan zahoti avtomatik tushsin — bugun
            // qo'ng'iroq qildim deb hisoblansin». So a real move clears the
            // follow-up, and the lead leaves «bugun qo'ng'iroq» without
            // anybody opening the ✏️ form to re-date it by hand. Setting a
            // NEW date is the seller's own decision, made from the day
            // screen's «ertaga» or on the card.
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(leads.id, id));
  // Only a real move is a fact about the lead. A card dragged one place up its
  // own column is a fact about how somebody likes to look at the board — the
  // sidebar being collapsed, not the stage changing — and auditing it would
  // write a row whose before equals its after, which the history renders as a
  // change with no lines in it (#502).
  if (stageId !== lead.stageId) {
    await writeAudit(db, ctx, {
      entityType: 'lead',
      entityId: id,
      action: 'update',
      before: { stageId: lead.stageId },
      after: { stageId, lostReason: law.lostReason },
    });
    await announceLeadStage(lead, stageId, ctx);
  }
}

/**
 * Winning a lead, whole (round 107, owner: «yutdi deganda bitim yangi ochilib
 * ketsin … kod ochish majburiy bo'lsin yokida eski klient kodga biriktirib
 * bitimga o'tish kerak»). ONE landing for every won door — the board's drag,
 * the ⋯ sheet, the card's stage fold and the card's convert panel — because
 * `moveLead` refuses a won stage that did not come through here.
 *
 * The order of the writes is the recovery story, not tidiness: the client is
 * settled and written onto the lead FIRST, so a failure after that point
 * (a deleted stage, a network blink) leaves a lead whose retry lands in the
 * «already has a client» path and mints nothing twice. Deliberately NOT one
 * transaction — `createClient` and `createDeal` each open their own, and a
 * wrapper holding a connection across them is #714's freeze.
 *
 * A lead that already carries a client (born from the Telegram tray, or won
 * once and revived) skips the mint and STILL opens a deal: a re-won enquiry
 * is a new job, and pressing the dialog's confirm is what says so.
 */
export interface WinLeadResult {
  clientId: string;
  clientCode: string;
  dealId: string;
  dealCode: string;
  /** True when a brand-new client card was created (the banner leads with the code). */
  minted: boolean;
}

export async function winLead(
  id: string,
  input: {
    /** The won stage pressed; defaults to the funnel's won stage. */
    stageId?: string;
    /** Attach to an existing client by the CODE a person typed (mode B). */
    attachCode?: string;
    /** Mint (mode A): optional typed code + editable name. */
    clientCode?: string;
    name?: string;
    salesManagerId?: string;
  },
  ctx: AuditContext,
): Promise<WinLeadResult> {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, id) });
  if (!lead) throw new CrmError('not_found');

  const stages = await listStages();
  const won = input.stageId
    ? stages.find((stage) => stage.id === input.stageId && stage.kind === 'won')
    : stages.find((stage) => stage.kind === 'won');
  if (!won) throw new CrmError('stage_not_found');

  let clientId = lead.clientId;
  let clientCode: string;
  let minted = false;
  if (clientId) {
    const existing = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
    if (!existing) throw new CrmError('client_not_found');
    clientCode = existing.clientCode;
  } else if (input.attachCode?.trim()) {
    // Attach by CODE, resolved here and only here: the form posts the code a
    // person typed, never a uuid it could forge (#514). Inactive is a refusal
    // — a retired code taking a new job is exactly the mistake being typed.
    const code = input.attachCode.trim().toUpperCase();
    const existing = await db.query.clients.findFirst({
      where: sql`upper(${clients.clientCode}) = ${code}`,
    });
    if (!existing) throw new CrmError('client_not_found');
    if (!existing.active) throw new CrmError('client_inactive');
    clientId = existing.id;
    clientCode = existing.clientCode;
  } else {
    const client = await createClient(
      {
        clientCode: input.clientCode?.trim() ?? '',
        name: input.name?.trim() || lead.company || lead.name,
        phones: lead.phone ? [lead.phone] : [],
        // Round 91's money scope keys every seller read on this column — a
        // client minted without it is invisible to the seller who just won it.
        salesManagerId: input.salesManagerId || lead.ownerId || ctx.actorId,
        messengerNote: '',
        notes: lead.note ?? '',
        active: true,
      },
      ctx,
    );
    clientId = client.id;
    clientCode = client.clientCode;
    minted = true;
  }

  if (!lead.clientId) {
    // The client lands on the lead BEFORE the deal and the move, so a failure
    // in either leaves a retry that finds the client and mints nothing twice.
    await db
      .update(leads)
      .set({ clientId, updatedAt: new Date() })
      .where(eq(leads.id, id));
    await writeAudit(db, ctx, {
      entityType: 'lead',
      entityId: id,
      action: 'update',
      after: minted ? { convertedTo: clientId, clientCode } : { attachedTo: clientId, clientCode },
    });
    // The prospect's kept calls (0063) follow the person onto the code —
    // dynamic import: the calls module is a leaf and this is its only door in.
    const { rekeyLeadCalls } = await import('../calls/service');
    await rekeyLeadCalls(id, clientId);
    // …and the conversation with them (0064). Both halves of «what do we have
    // on this person» follow the same person onto the same code, or the client
    // card would show the calls and not the chat.
    const { rekeyLeadChats } = await import('./chat-lead');
    await rekeyLeadChats(id, clientId);
  }

  // ALWAYS a deal — that is the owner's sentence, and the lead's quote is the
  // price it opens with. Per-column null mapping, because numeric comes back
  // a string and `Number(null)` is 0: a lead with NO price must not become a
  // deal «quoted $0 by <actor> today» (quotedAt/quotedBy stamp on priced).
  const { createDeal } = await import('../deals/service');
  const dealId = await createDeal(
    {
      clientId,
      ownerId: lead.ownerId ?? undefined,
      quotedAmount: lead.quotedAmount === null ? null : Number(lead.quotedAmount),
      quotedCurrency: lead.quotedAmount === null ? null : (lead.quotedCurrency ?? 'USD'),
      quotedVolumeM3: lead.quotedVolumeM3 === null ? null : Number(lead.quotedVolumeM3),
      quotedWeightKg: lead.quotedWeightKg === null ? null : Number(lead.quotedWeightKg),
    },
    ctx,
  );
  const deal = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });

  // An open calculation follows the cargo onto the deal — the same door the
  // calls and the chat already use. Without it the request stays keyed to the
  // lead, the seller saves the DEAL's lines, and `completeCalcForDeal` finds
  // nothing: that clock could then never stop.
  try {
    const { rekeyLeadCalcRequests } = await import('../calc/service');
    await rekeyLeadCalcRequests(id, dealId);
  } catch (err) {
    logger.error({ err, leadId: id, dealId }, '[calc] rekey on win failed');
  }

  if (lead.stageId !== won.id) {
    await moveLead(id, won.id, '', ctx, undefined, { viaConvert: true });
  }

  return { clientId, clientCode, dealId, dealCode: deal?.code ?? '', minted };
}

/**
 * What the board's search box matches, as ONE fragment.
 *
 * Exported and shared because the rows and the COUNTS have to be filtered by
 * the same question: the closed columns show a slice and the header prints the
 * true total (#447), so a filter that reaches the cards and not the totals
 * turns «+3 · show all» into «+143 · show all» on a column matching two.
 *
 * The needles are the global search's own (`likeNeedle`, `parseQuery`), so
 * typing a name into the board finds what typing it into ⌘K finds.
 */
export function leadTextWhere(q?: string) {
  const text = q?.trim();
  if (!text) return undefined;
  const like = likeNeedle(text);
  const phone = parseQuery(text).phone;
  return phone
    ? sql`(${leads.name} ILIKE ${like} OR ${leads.company} ILIKE ${like} OR right(regexp_replace(coalesce(${leads.phone}, ''), '[^0-9]', '', 'g'), 9) = ${phone})`
    : sql`(${leads.name} ILIKE ${like} OR ${leads.company} ILIKE ${like})`;
}

/**
 * Everything the board's filter panel can ask (round 71).
 *
 * ONE builder consumed by `listLeads` AND `closedLeadCounts`, which is #513's
 * rule with more fields: the closed columns show a slice and the header
 * prints the true total, so any filter that reaches the cards and not the
 * counts turns the «+N · show all» footer into a lie.
 *
 * Ranges are numbers from the URL; dates are `YYYY-MM-DD` strings bound with
 * an explicit `::date` (a bare Date beside a raw fragment is #156). A range
 * over the quote naturally EXCLUDES unquoted leads — NULL answers no
 * comparison — which is what «narxi 500$ dan baland» means.
 */
export interface LeadBoardFilters {
  ownerId?: string;
  stageId?: string;
  /** The board's search box. */
  q?: string;
  sourceId?: string;
  /** Created-at bounds, inclusive, the typist's calendar days. */
  createdFrom?: string;
  createdTo?: string;
  amountMin?: number;
  amountMax?: number;
  volMin?: number;
  volMax?: number;
  kgMin?: number;
  kgMax?: number;
  /**
   * Text sought across the card's WRITTEN record: the lead's own note and
   * every lenta entry (calls, meetings, notes). Deliberately NOT the Telegram
   * messages: those are scoped per manager (#383), and a shared board whose
   * result set differed by viewer — or leaked a chat's words through a
   * card's presence — would break the rule that made them private.
   */
  lenta?: string;
}

export function leadBoardWhere(filters: LeadBoardFilters) {
  const where = [];
  // «Meniki» means mine AND the ones nobody has taken (round 74).
  //
  // A lead with no owner used to appear on NO seller's board: the personal
  // scope asks `owner_id = me`, and «Hammasi» needs `crm.leads.view_all`,
  // which a seller does not have. On his real data 27 of 383 leads (7 %) are
  // unowned — at 100 leads a day that is ~7 every day landing where nobody
  // is looking. They are everybody's until somebody claims one, which is how
  // a shared inbox has to behave; the alternative is a pile that only grows.
  if (filters.ownerId) {
    where.push(or(eq(leads.ownerId, filters.ownerId), isNull(leads.ownerId))!);
  }
  if (filters.stageId) where.push(eq(leads.stageId, filters.stageId));
  const text = leadTextWhere(filters.q);
  if (text) where.push(text);
  if (filters.sourceId) where.push(eq(leads.sourceId, filters.sourceId));
  if (filters.createdFrom) where.push(sql`${leads.createdAt} >= ${filters.createdFrom}::date`);
  // Inclusive: «to 15th» means through the 15th's midnight, not up to it.
  if (filters.createdTo) where.push(sql`${leads.createdAt} < ${filters.createdTo}::date + 1`);
  if (filters.amountMin !== undefined) where.push(sql`${leads.quotedAmount} >= ${filters.amountMin}`);
  if (filters.amountMax !== undefined) where.push(sql`${leads.quotedAmount} <= ${filters.amountMax}`);
  if (filters.volMin !== undefined) where.push(sql`${leads.quotedVolumeM3} >= ${filters.volMin}`);
  if (filters.volMax !== undefined) where.push(sql`${leads.quotedVolumeM3} <= ${filters.volMax}`);
  if (filters.kgMin !== undefined) where.push(sql`${leads.quotedWeightKg} >= ${filters.kgMin}`);
  if (filters.kgMax !== undefined) where.push(sql`${leads.quotedWeightKg} <= ${filters.kgMax}`);
  const lenta = filters.lenta?.trim();
  if (lenta) {
    const like = likeNeedle(lenta);
    // EXISTS, not a join: several matching entries must not multiply the
    // card, and (entity_type, entity_id) is the lenta's own index.
    where.push(
      sql`(${leads.note} ILIKE ${like} OR EXISTS (
        SELECT 1 FROM crm_activities a
        WHERE a.entity_type = 'lead' AND a.entity_id = ${leads.id} AND a.note ILIKE ${like}
      ))`,
    );
  }
  return where;
}

/**
 * How many OPEN cards one column carries (round 74).
 *
 * The open half used to share ONE cap of 300 across every column, sorted by
 * stage order — so the first stage took all 300 and every column after it
 * rendered empty. Measured at 36,000 leads: «Yangi 300», then five columns
 * saying 0 while each held ~4,500. At 100 leads a day that is a matter of
 * days, and it arrives as a screen that lies rather than as an error.
 *
 * Forty is two screens of scrolling in one column; the header prints the
 * true total beside it and the «+N» footer opens the rest.
 */
export const OPEN_PER_STAGE = 40;

export async function listLeads(
  filters: LeadBoardFilters & {
    openOnly?: boolean;
    /** Only the finished ones — what the board shows a recent slice of. */
    closedOnly?: boolean;
    limit?: number;
    /** Open cards per COLUMN. Ignored unless `openOnly`. */
    perStage?: number;
  },
) {
  // In SQL, never over the fetched array: the closed slice is capped at 20 and
  // each open column at `perStage`, so filtering afterwards would search the
  // newest twenty and answer «nothing found» about a database that has it.
  const where = leadBoardWhere(filters);
  if (filters.openOnly) where.push(eq(leadStages.kind, 'open'));
  if (filters.closedOnly) where.push(ne(leadStages.kind, 'open'));

  // The open board is capped PER COLUMN, which a single LIMIT cannot express.
  // One extra query names the surviving ids — the typed select below is then
  // the same one every other caller gets, so nothing downstream had to change.
  if (filters.openOnly) {
    const perStage = filters.perStage ?? OPEN_PER_STAGE;
    const ranked = await db.execute<{ id: string }>(sql`
      SELECT id FROM (
        SELECT ${leads.id} AS id,
               row_number() OVER (
                 PARTITION BY ${leads.stageId}
                 ORDER BY ${leads.boardOrder} ASC NULLS FIRST, ${leads.updatedAt} DESC
               ) AS rn
        FROM ${leads}
        INNER JOIN ${leadStages} ON ${leadStages.id} = ${leads.stageId}
        ${where.length ? sql`WHERE ${and(...where)}` : sql``}
      ) ranked
      WHERE rn <= ${perStage}
    `);
    if (ranked.length === 0) return [];
    where.push(
      inArray(
        leads.id,
        ranked.map((row) => row.id),
      ),
    );
  }

  return db
    .select({
      lead: leads,
      stageName: leadStages.name,
      stageKind: leadStages.kind,
      stageOrder: leadStages.sortOrder,
      sourceName: leadSources.name,
      ownerName: users.fullName,
      clientCode: clients.clientCode,
    })
    .from(leads)
    .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
    .leftJoin(leadSources, eq(leads.sourceId, leadSources.id))
    .leftJoin(users, eq(leads.ownerId, users.id))
    .leftJoin(clients, eq(leads.clientId, clients.id))
    .where(where.length ? and(...where) : undefined)
    .orderBy(
      // The owner's own order first (0075), «last touched» only where nobody
      // has placed a card. THE SAME two keys rank the per-stage cap above — a
      // cap ordered differently from the board sends forty cards and then
      // draws a different forty, so a card dragged low would vanish rather
      // than sink (#513's rule wearing a slice's clothes).
      //
      // The closed half is cut by `limit`, so its order also decides which
      // cards survive. Round 47 sorted it by date to stop the slice being
      // «whichever leads sit in the earliest column» — and the numbers are
      // per-column ranks, so that stays true: what arrives is the top of
      // every closed column rather than all of one.
      ...(filters.closedOnly
        ? [sql`${leads.boardOrder} ASC NULLS FIRST`, desc(leads.updatedAt)]
        : [
            asc(leadStages.sortOrder),
            sql`${leads.boardOrder} ASC NULLS FIRST`,
            desc(leads.updatedAt),
          ]),
    )
    .limit(filters.limit ?? 300);
}

/**
 * How many OPEN leads each column really holds (round 74).
 *
 * The twin of `closedLeadCounts`, and the reason the funnel can be capped per
 * column without lying: the cards are a slice, the header is the truth. Same
 * builder as the rows (#513) — a filter the counts do not hear turns every
 * column header into a lie on a filtered board.
 */
export async function openLeadCounts(
  filters: LeadBoardFilters,
): Promise<Record<string, number>> {
  const where = [eq(leadStages.kind, 'open'), ...leadBoardWhere(filters)];
  const rows = await db
    .select({ stageId: leads.stageId, n: sql<number>`count(*)` })
    .from(leads)
    .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
    .where(and(...where))
    .groupBy(leads.stageId);
  return Object.fromEntries(rows.map((row) => [row.stageId, Number(row.n)]));
}

/**
 * How many finished leads each closed stage really holds (round 47).
 *
 * The board shows a recent slice of them — the owner: «lost bo'lganlar va
 * yutuq bo'lganlar juda chalg'itadi» — and a column that shows twelve of a
 * hundred and forty must still SAY a hundred and forty, or the funnel is
 * lying about the year's work. Scoped the same way the board is.
 */
export async function closedLeadCounts(
  filters: LeadBoardFilters,
): Promise<Record<string, number>> {
  // The SAME builder as the rows (#513): a filter the counts do not hear
  // turns the «+N · show all» footer into a lie on a filtered board.
  const where = [ne(leadStages.kind, 'open'), ...leadBoardWhere(filters)];
  const rows = await db
    .select({ stageId: leads.stageId, n: sql<number>`count(*)` })
    .from(leads)
    .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
    .where(and(...where))
    .groupBy(leads.stageId);
  return Object.fromEntries(rows.map((row) => [row.stageId, Number(row.n)]));
}

// --- Contact history --------------------------------------------------------

export const activitySchema = z.object({
  /** Client-generated when files were attached BEFORE saving (pre-binding). */
  id: z.string().uuid().optional(),
  entityType: z.enum(['lead', 'client', 'deal']),
  entityId: z.string().uuid(),
  kind: z.enum(['call', 'meeting', 'message', 'note']),
  note: z.string().trim().min(1).max(4000),
  happenedAt: OPTIONAL_DATE,
  /** Setting the next call in the same breath as logging this one. */
  nextActionAt: OPTIONAL_DATE,
  nextActionNote: z.string().trim().max(500).optional().or(z.literal('')),
});

export async function addActivity(
  input: z.infer<typeof activitySchema>,
  ctx: AuditContext,
  opts?: SystemOpts,
) {
  if (!ctx.actorId && !opts?.system) throw new CrmError('unauthenticated');
  const [row] = await db
    .insert(crmActivities)
    .values({
      ...(input.id ? { id: input.id } : {}),
      entityType: input.entityType,
      entityId: input.entityId,
      kind: input.kind,
      note: input.note,
      happenedAt: input.happenedAt ? new Date(`${input.happenedAt}T12:00:00Z`) : new Date(),
      createdBy: ctx.actorId,
    })
    .returning();

  // The follow-up date lives on the lead/client, not on the log line: there
  // must be exactly one answer to "when are we calling them next".
  if (input.nextActionAt !== undefined) {
    const patch = {
      nextActionAt: input.nextActionAt || null,
      nextActionNote: input.nextActionNote || null,
      updatedAt: new Date(),
    };
    if (input.entityType === 'lead') {
      await db.update(leads).set(patch).where(eq(leads.id, input.entityId));
    } else {
      await db.update(clients).set(patch).where(eq(clients.id, input.entityId));
    }
  }

  await writeAudit(db, ctx, {
    entityType: `crm_${input.entityType}_activity`,
    entityId: input.entityId,
    action: 'create',
    after: { kind: input.kind, note: input.note.slice(0, 200) },
  });
  return row!;
}

export async function listActivities(entityType: 'lead' | 'client', entityId: string, limit = 100) {
  return db
    .select({ activity: crmActivities, authorName: users.fullName })
    .from(crmActivities)
    .leftJoin(users, eq(crmActivities.createdBy, users.id))
    .where(and(eq(crmActivities.entityType, entityType), eq(crmActivities.entityId, entityId)))
    .orderBy(desc(crmActivities.happenedAt))
    .limit(limit);
}

// --- The two lists a sales manager opens in the morning ----------------------

export interface FollowUp {
  kind: 'lead' | 'client';
  id: string;
  title: string;
  subtitle: string | null;
  dueOn: string;
  note: string | null;
  ownerId: string | null;
}

/**
 * Everything due today or overdue, leads and clients in ONE list.
 *
 * Split across two screens it would be two things to remember; the point of
 * the feature is that there is a single answer to "who am I calling today".
 */
export async function followUps(asOf: string, ownerId?: string): Promise<FollowUp[]> {
  const leadRows = await db
    .select({
      id: leads.id,
      name: leads.name,
      company: leads.company,
      phone: leads.phone,
      dueOn: leads.nextActionAt,
      note: leads.nextActionNote,
      ownerId: leads.ownerId,
    })
    .from(leads)
    // The stage is joined for ONE reason, and it is the defect the owner
    // reported on go-live day («call today bo'lib yig'ilib turibti … ular
    // bilan ishlash boshlagandan keyin ham o'sha yerda turibti»): this list
    // had no stage filter at all, so a lead moved to WON or LOST — a job
    // finished, a customer gone — kept its old follow-up date and sat on the
    // call list for ever. Every advert lead arrives booked for TODAY
    // (`inbound.ts`), so the pile grows by itself.
    .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
    .where(
      and(
        isNotNull(leads.nextActionAt),
        lte(leads.nextActionAt, asOf),
        isNull(leads.clientId),
        eq(leadStages.kind, 'open'),
        // Mine OR unclaimed — the board's rule (round 74), and now load-bearing:
        // a lead that arrives from an advert is booked for today and handed to
        // whoever's turn it is, but when nobody is in the rotation it has no
        // owner at all, and a call list that only knows «owner_id = me» would
        // put it on nobody's screen. The client half deliberately does NOT
        // widen: a client follow-up is a date a person typed on a card, so it
        // already belongs to somebody.
        ownerId ? or(eq(leads.ownerId, ownerId), isNull(leads.ownerId)) : undefined,
      ),
    );

  const clientRows = await db
    .select({
      id: clients.id,
      code: clients.clientCode,
      name: clients.name,
      dueOn: clients.nextActionAt,
      note: clients.nextActionNote,
      ownerId: clients.salesManagerId,
    })
    .from(clients)
    .where(
      and(
        isNotNull(clients.nextActionAt),
        lte(clients.nextActionAt, asOf),
        eq(clients.active, true),
        ownerId ? eq(clients.salesManagerId, ownerId) : undefined,
      ),
    );

  return [
    ...leadRows.map((row) => ({
      kind: 'lead' as const,
      id: row.id,
      title: row.name,
      subtitle: row.company ?? row.phone,
      dueOn: row.dueOn!,
      note: row.note,
      ownerId: row.ownerId,
    })),
    ...clientRows.map((row) => ({
      kind: 'client' as const,
      id: row.id,
      title: `${row.code} · ${row.name}`,
      subtitle: null,
      dueOn: row.dueOn!,
      note: row.note,
      ownerId: row.ownerId,
    })),
  ].sort((a, b) => a.dueOn.localeCompare(b.dueOn));
}

export class FollowUpError extends Error {
  constructor(public readonly code: 'not_found' | 'not_yours') {
    super(code);
  }
}

/**
 * Close or postpone one row of «bugun qo'ng'iroq», from the day screen.
 *
 * The list had no action at all: the only way to take a name off it was to
 * open the card, unfold the ✏️ form and re-date it by hand, which is why the
 * owner watched it fill up instead of empty («yig'ilib turibti»). One tap is
 * the whole fix — `until: null` means «done, nothing scheduled», a date means
 * «not today, then».
 *
 * Ownership is re-derived here rather than trusted from the screen: the row
 * arrived as an id in a form post, and the list this action serves is
 * per-person. The rule matches `followUps`' own — mine, or unclaimed for a
 * lead — so the button can never reach a colleague's call.
 */
export async function setFollowUp(
  kind: 'lead' | 'client',
  id: string,
  until: string | null,
  ctx: AuditContext & { viewAll?: boolean },
): Promise<void> {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  const row =
    kind === 'lead'
      ? await db.query.leads.findFirst({ where: eq(leads.id, id) })
      : await db.query.clients.findFirst({ where: eq(clients.id, id) });
  if (!row) throw new FollowUpError('not_found');

  const owner = 'ownerId' in row ? row.ownerId : row.salesManagerId;
  // A lead nobody has claimed is on everybody's list (round 74), so anyone
  // whose list showed it may also clear it.
  const mine = owner === ctx.actorId || (kind === 'lead' && owner === null);
  if (!ctx.viewAll && !mine) throw new FollowUpError('not_yours');

  const table = kind === 'lead' ? leads : clients;
  await db
    .update(table)
    .set({
      nextActionAt: until,
      // The note belongs to the date that carried it: keeping «call about the
      // Guangzhou quote» against a cleared follow-up would put a stale
      // sentence on the card for ever.
      ...(until === null ? { nextActionNote: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(table.id, id));

  await writeAudit(db, ctx, {
    entityType: kind,
    entityId: id,
    action: 'update',
    before: { nextActionAt: row.nextActionAt },
    after: { nextActionAt: until },
  });
}

/**
 * Clients who used to send cargo and have stopped.
 *
 * This is the report a repeat-business kargo company loses the most money to:
 * nobody notices a regular going quiet, because nothing happens — no receipt,
 * no alert, no row anywhere. "Last cargo" is the last confirmed receipt, so a
 * client whose boxes are still in transit is not counted as dormant.
 */
export async function dormantClients(days: number, ownerId?: string) {
  const rows = await db
    .select({
      id: clients.id,
      code: clients.clientCode,
      name: clients.name,
      ownerId: clients.salesManagerId,
      ownerName: users.fullName,
      lastReceiptAt: sql<string | null>`(
        SELECT max(r.received_at) FROM receipts r
        WHERE r.client_id = ${clients}.id AND r.status = 'confirmed'
      )`,
      receiptCount: sql<number>`(
        SELECT count(*) FROM receipts r
        WHERE r.client_id = ${clients}.id AND r.status = 'confirmed'
      )`,
      balanceUsd: sql<string>`coalesce((
        SELECT sum(CASE WHEN ct.type = 'charge' THEN ct.amount_usd ELSE -ct.amount_usd END)
        FROM client_transactions ct
        WHERE ct.client_id = ${clients}.id AND ct.voided_at IS NULL
      ), 0)`,
    })
    .from(clients)
    .leftJoin(users, eq(clients.salesManagerId, users.id))
    .where(and(eq(clients.active, true), ownerId ? eq(clients.salesManagerId, ownerId) : undefined));

  const cutoff = Date.now() - days * 86_400_000;
  return rows
    // A client who never sent anything is not "dormant" — they are a lead who
    // was opened as a card, and mixing the two would bury the real signal.
    .filter((row) => row.lastReceiptAt && new Date(row.lastReceiptAt).getTime() < cutoff)
    .map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      ownerId: row.ownerId,
      ownerName: row.ownerName,
      lastReceiptAt: row.lastReceiptAt!,
      daysQuiet: Math.floor((Date.now() - new Date(row.lastReceiptAt!).getTime()) / 86_400_000),
      receiptCount: Number(row.receiptCount),
      balanceUsd: Math.round(Number(row.balanceUsd) * 100) / 100,
    }))
    .sort((a, b) => b.daysQuiet - a.daysQuiet);
}

/** Funnel counts per stage, plus how each SOURCE actually converted. */
export async function funnelReport(ownerId?: string) {
  const scope = ownerId ? eq(leads.ownerId, ownerId) : undefined;

  const byStage = await db
    .select({
      stageId: leadStages.id,
      name: leadStages.name,
      kind: leadStages.kind,
      sortOrder: leadStages.sortOrder,
      n: sql<number>`count(${leads.id})`,
    })
    .from(leadStages)
    .leftJoin(leads, and(eq(leads.stageId, leadStages.id), scope))
    .groupBy(leadStages.id, leadStages.name, leadStages.kind, leadStages.sortOrder)
    // Same tiebreak as `listStages` above: a tie leaves the order to Postgres.
    .orderBy(asc(leadStages.sortOrder), asc(leadStages.name));

  const bySource = await db
    .select({
      name: sql<string>`coalesce(${leadSources.name}, '—')`,
      total: sql<number>`count(*)`,
      won: sql<number>`count(*) FILTER (WHERE ${leadStages.kind} = 'won')`,
      lost: sql<number>`count(*) FILTER (WHERE ${leadStages.kind} = 'lost')`,
      /**
       * The money behind a source, added in round 86b because «which advert
       * pays» was answerable only in lead COUNTS — and a channel bringing
       * half as many jobs at four times the size is the one to spend on.
       * Round 71 gave a lead its own quote; this is the first report to read
       * it. WON only: a quote on an open lead is a hope, and on a lost one it
       * is a price somebody refused.
       */
      wonUsd: sql<string>`coalesce(sum(${leads.quotedAmount}) FILTER (WHERE ${leadStages.kind} = 'won'), 0)`,
    })
    .from(leads)
    .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
    .leftJoin(leadSources, eq(leads.sourceId, leadSources.id))
    .where(scope)
    .groupBy(sql`coalesce(${leadSources.name}, '—')`)
    .orderBy(sql`count(*) DESC`);

  return {
    stages: byStage.map((row) => ({ ...row, n: Number(row.n) })),
    sources: bySource.map((row) => {
      const total = Number(row.total);
      const won = Number(row.won);
      return {
        name: row.name,
        total,
        won,
        lost: Number(row.lost),
        wonUsd: Math.round(Number(row.wonUsd ?? 0) * 100) / 100,
        // Conversion counts only DECIDED leads: an open lead is not a failure
        // yet, and counting it as one makes a young source look terrible.
        decided: won + Number(row.lost),
        winRate: won + Number(row.lost) ? Math.round((won / (won + Number(row.lost))) * 1000) / 10 : 0,
      };
    }),
  };
}

/** Follow-ups are one query away from the home screen; keep the shape stable. */
export async function openLeadCount(ownerId?: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(leads)
    .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
    .where(
      and(
        eq(leadStages.kind, 'open'),
        isNull(leads.clientId),
        ownerId ? or(eq(leads.ownerId, ownerId), isNull(leads.ownerId)) : undefined,
      ),
    );
  return Number(row?.n ?? 0);
}
