import { and, asc, desc, eq, isNull, isNotNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  clients,
  crmActivities,
  leads,
  leadSources,
  leadStages,
  users,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';
import { createClient } from '../../platform/clients/service';

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
  const [row] = input.id
    ? await db.update(leadSources).set(values).where(eq(leadSources.id, input.id)).returning()
    : await db.insert(leadSources).values(values).returning();
  if (!row) throw new CrmError('not_found');
  await writeAudit(db, ctx, {
    entityType: 'lead_source',
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

export async function createLead(input: LeadInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  const stageId = input.stageId || (await defaultStageId());
  const [row] = await db
    .insert(leads)
    .values({
      name: input.name,
      phone: input.phone || null,
      company: input.company || null,
      sourceId: input.sourceId || null,
      stageId,
      // An unassigned lead is the one nobody calls, so it defaults to whoever
      // entered it rather than to nobody.
      ownerId: input.ownerId || ctx.actorId,
      note: input.note || null,
      nextActionAt: input.nextActionAt || null,
      nextActionNote: input.nextActionNote || null,
      createdBy: ctx.actorId,
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
  const values = {
    name: input.name,
    phone: input.phone || null,
    company: input.company || null,
    sourceId: input.sourceId || null,
    stageId: input.stageId || before.stageId,
    ownerId: input.ownerId || null,
    note: input.note || null,
    nextActionAt: input.nextActionAt || null,
    nextActionNote: input.nextActionNote || null,
    updatedAt: new Date(),
  };
  const [row] = await db.update(leads).set(values).where(eq(leads.id, id)).returning();
  await writeAudit(db, ctx, {
    entityType: 'lead',
    entityId: id,
    action: 'update',
    before: { name: before.name, stageId: before.stageId, ownerId: before.ownerId },
    after: { name: values.name, stageId: values.stageId, ownerId: values.ownerId },
  });
  if (values.stageId !== before.stageId) await announceLeadStage(row!, values.stageId, ctx);
  return row!;
}

/**
 * Move a lead along the funnel.
 *
 * A lost stage demands a reason — "why did we lose them" is the only thing
 * that makes a lost-deal list worth reading a year later — and moving back
 * out of lost clears it rather than leaving a stale explanation attached.
 */
export async function moveLead(
  id: string,
  stageId: string,
  reason: string,
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, id) });
  if (!lead) throw new CrmError('not_found');
  const stage = await db.query.leadStages.findFirst({ where: eq(leadStages.id, stageId) });
  if (!stage) throw new CrmError('stage_not_found');
  if (stage.kind === 'lost' && reason.trim().length < 2) throw new CrmError('reason_required');

  await db
    .update(leads)
    .set({
      stageId,
      lostReason: stage.kind === 'lost' ? reason.trim() : null,
      updatedAt: new Date(),
    })
    .where(eq(leads.id, id));
  await writeAudit(db, ctx, {
    entityType: 'lead',
    entityId: id,
    action: 'update',
    before: { stageId: lead.stageId },
    after: { stageId, lostReason: stage.kind === 'lost' ? reason.trim() : null },
  });
  if (stageId !== lead.stageId) await announceLeadStage(lead, stageId, ctx);
}

/**
 * Turn a lead into a real client card.
 *
 * The client code is left to the existing generator (DECISIONS #115) unless
 * one is typed, and the lead row survives the conversion pointing at the
 * client — that link is what lets the funnel report say which source actually
 * produced paying customers, months later.
 */
export async function convertLead(
  id: string,
  input: { clientCode?: string; name?: string; salesManagerId?: string },
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, id) });
  if (!lead) throw new CrmError('not_found');
  if (lead.clientId) throw new CrmError('already_converted');

  const client = await createClient(
    {
      clientCode: input.clientCode?.trim() ?? '',
      name: input.name?.trim() || lead.company || lead.name,
      phones: lead.phone ? [lead.phone] : [],
      salesManagerId: input.salesManagerId || lead.ownerId || undefined,
      messengerNote: '',
      notes: lead.note ?? '',
      active: true,
    },
    ctx,
  );

  const stages = await listStages();
  const won = stages.find((stage) => stage.kind === 'won');
  await db
    .update(leads)
    .set({
      clientId: client.id,
      stageId: won?.id ?? lead.stageId,
      nextActionAt: null,
      nextActionNote: null,
      updatedAt: new Date(),
    })
    .where(eq(leads.id, id));

  await writeAudit(db, ctx, {
    entityType: 'lead',
    entityId: id,
    action: 'update',
    after: { convertedTo: client.id, clientCode: client.clientCode },
  });
  if (won && won.id !== lead.stageId) await announceLeadStage(lead, won.id, ctx);
  return client;
}

export async function listLeads(filters: {
  ownerId?: string;
  stageId?: string;
  openOnly?: boolean;
  limit?: number;
}) {
  const where = [];
  if (filters.ownerId) where.push(eq(leads.ownerId, filters.ownerId));
  if (filters.stageId) where.push(eq(leads.stageId, filters.stageId));
  if (filters.openOnly) where.push(eq(leadStages.kind, 'open'));
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
    .orderBy(asc(leadStages.sortOrder), desc(leads.updatedAt))
    .limit(filters.limit ?? 300);
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

export async function addActivity(input: z.infer<typeof activitySchema>, ctx: AuditContext) {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
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
    .where(
      and(
        isNotNull(leads.nextActionAt),
        lte(leads.nextActionAt, asOf),
        isNull(leads.clientId),
        ownerId ? eq(leads.ownerId, ownerId) : undefined,
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
