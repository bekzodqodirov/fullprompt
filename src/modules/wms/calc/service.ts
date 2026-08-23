import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import {
  calcRequestItems,
  calcRequests,
  crmActivities,
  deals,
  leads,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { writeAudit, type AuditContext } from '@/modules/platform/audit/service';
import { createTask } from '@/modules/platform/tasks/service';
import { notifyStaffTelegram, userName } from '@/modules/platform/notifications/staff';
import { usersWithPermission, usersWithRoles } from '@/modules/platform/notifications/service';
import { cardLink } from '@/modules/platform/notifications/links';
import { logger } from '@/modules/platform/logger';
import { addActivity } from '../crm/service';
import { productKey, tnvedFor } from '../tnved/service';
import { isComplete, missingFields, type CalcFacts, type CalcSection } from './intake';

/**
 * The VED queue (docs/VED.md, phase A).
 *
 * Round 28 built a clock on «hisoblash» and rounds 46/84 deleted its doors;
 * the table survived. This is the reopening, with the request widened from
 * «price this card» into the JOB itself: a section, a route, weight, volume,
 * goods and the materials the seller sent.
 *
 * Three rules decide most of the behaviour here:
 *
 * 1. **A request is a job, not a card state.** The old partial unique index
 *    («one open request per card») was dropped in 0085: the landing rule
 *    sends every repeat client to the same open deal, so keeping it would
 *    have merged Monday's monitors with Thursday's chairs — and the freight
 *    band is computed from TOTAL kg ÷ TOTAL m³, which would silently
 *    misprice both.
 * 2. **The queue owns assignment.** The seller does not pick a VED person
 *    (round 28 made them); the request is handed to whoever is carrying the
 *    fewest open ones, so it has an owner from second zero and the clock
 *    accuses somebody. Any VED person may take it over, and that is audited.
 * 3. **Every speed figure excludes `'returned'`.** A bounce-back ends a
 *    request like any other ending, so without that filter the fastest
 *    calculator in the company is whoever hands everything back.
 */

export class CalcError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** The owner's range: «1 dan 1000 tagacha tovar». */
export const MAX_CALC_ITEMS = 1000;

/**
 * How many open requests one person may have waiting at once.
 *
 * Not a security fence — twenty trusted people — but a runaway guard: the bot
 * mints a fresh LEAD for every stranger with no phone, so a stuck loop would
 * otherwise open a request (and a lead, and a model call) per press with
 * nothing in the schema to stop it.
 */
export const MAX_OPEN_PER_REQUESTER = 20;

/**
 * The owner's scale, verbatim: «1 dona TNVED kod bo'lsa yarim soat; 2, 3, 10
 * ta — shunga moslanib, maksimum 2 soat».
 *
 * The one addition is the case round 28 never had: a request whose goods live
 * only in a PDF arrives with ZERO lines, and the floor would give it the
 * shortest deadline in the system for the job that needs the most reading.
 * Materials with no goods list get the middle of the scale.
 */
export function calcDueMinutes(itemCount: number, hasMaterials = false): number {
  if (itemCount <= 0) return hasMaterials ? 60 : 30;
  return Math.min(30 * itemCount, 120);
}

/**
 * «Still waiting» — the ONE fragment the queue, its counters and the VED home
 * all filter by, so the number on the home screen and the rows on the screen
 * cannot disagree (#513).
 */
export const openRequests = isNull(calcRequests.completedAt);

/**
 * Whose turn it is to calculate: fewest OPEN requests, longest-since breaks a
 * tie, never-had-one sorts FIRST.
 *
 * The counting rule is the taqsimot rota's (`crm/routing.ts` — round 96) and
 * the comment there explains why it is worth restating rather than sharing:
 * that one answers «whose lead is this», this one «whose calculation is
 * this», and a shared query would have to take a table name as an argument.
 */
export async function nextVedAssignee(): Promise<string | null> {
  const pool = await usersWithPermission('ved.docs');
  if (pool.length === 0) return null;
  const rows = await db
    .select({
      id: users.id,
      n: sql<number>`count(${calcRequests.id})`,
      last: sql<Date | null>`max(${calcRequests.requestedAt})`,
    })
    .from(users)
    .leftJoin(calcRequests, and(eq(calcRequests.assigneeId, users.id), openRequests))
    .where(and(eq(users.active, true), inArray(users.id, pool)))
    .groupBy(users.id)
    .orderBy(
      sql`count(${calcRequests.id}) asc, max(${calcRequests.requestedAt}) asc nulls first`,
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

export interface CalcItemInput {
  name: string;
  quantity?: number | null;
  unit?: string | null;
  weightKg?: number | null;
  volumeM3?: number | null;
  amount?: number | null;
  currency?: string | null;
  tnvedCode?: string | null;
  note?: string | null;
}

export interface CalcRequestInput {
  entityType: 'deal' | 'lead';
  entityId: string;
  section: CalcSection;
  fromCity?: string | null;
  toCity?: string | null;
  weightKg?: number | null;
  volumeM3?: number | null;
  items: CalcItemInput[];
  /** A note to WRITE — the card path, whose id the files were pre-bound to. */
  note?: { id: string; text: string } | null;
  /** A note already written — the bot path, where `landIntake` wrote it. */
  noteId?: string | null;
  source: 'card' | 'bot';
  /** Set by the bot, which acts for the staff member who collected. */
  hasMaterials?: boolean;
}

const num = (value: number | null | undefined): string | null =>
  value === null || value === undefined || !Number.isFinite(value) ? null : String(value);

/** Drizzle hands `numeric` over as a STRING; every read boundary coerces once. */
const toNum = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

/**
 * Open a calculation request and hand it to the queue.
 *
 * Everything pooled — the note, the TNVED memory, the rota — happens BEFORE
 * the transaction, and the task and its Telegram after it: a second
 * connection asked for from inside a transaction is what freezes the whole
 * app (`tests/unit/tx-pool.test.ts`).
 */
export async function openCalcRequest(
  input: CalcRequestInput,
  ctx: AuditContext,
): Promise<{ id: string; assigneeId: string | null }> {
  if (!ctx.actorId) throw new CalcError('unauthenticated');
  if (input.items.length > MAX_CALC_ITEMS) throw new CalcError('too_many_items');

  // The card must exist, and its NAME goes in the task title so the VED
  // person knows what they are opening before they open it.
  let label: string;
  if (input.entityType === 'deal') {
    const deal = await db.query.deals.findFirst({ where: eq(deals.id, input.entityId) });
    if (!deal) throw new CalcError('not_found');
    label = deal.code;
  } else {
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, input.entityId) });
    if (!lead) throw new CalcError('not_found');
    label = lead.name;
  }

  const mine = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(calcRequests)
    .where(and(eq(calcRequests.requestedBy, ctx.actorId), openRequests));
  if (Number(mine[0]?.n ?? 0) >= MAX_OPEN_PER_REQUESTER) throw new CalcError('too_many_open');

  // The materials. On the card path the note is written HERE, with the id the
  // browser already uploaded files against — and an id that is already taken
  // is refused rather than adopted, so a posted uuid cannot attach somebody
  // else's note (and its files) to this request.
  let noteId: string | null = input.noteId ?? null;
  if (input.note) {
    const existing = await db.query.crmActivities.findFirst({
      where: eq(crmActivities.id, input.note.id),
      columns: { id: true },
    });
    if (existing) throw new CalcError('note_taken');
    await addActivity(
      {
        id: input.note.id,
        entityType: input.entityType,
        entityId: input.entityId,
        kind: 'note',
        note: input.note.text,
      },
      ctx,
    );
    noteId = input.note.id;
  }
  if (noteId) {
    // Wherever it came from, the note must sit on the SAME card as the
    // request: the attachment gate widens for `ved.docs` on exactly this
    // link, so a note pointing somewhere else would widen it somewhere else.
    const note = await db.query.crmActivities.findFirst({
      where: eq(crmActivities.id, noteId),
      columns: { entityType: true, entityId: true },
    });
    if (!note || note.entityType !== input.entityType || note.entityId !== input.entityId) {
      throw new CalcError('note_foreign');
    }
  }

  // The TNVED memory before any model is asked (#1.5's rule): a product this
  // company has classified before arrives already carrying its code.
  const known = await tnvedFor(input.items.map((item) => item.name));
  const items = input.items.map((item, i) => ({
    seq: i + 1,
    name: item.name.slice(0, 300),
    quantity: num(item.quantity),
    unit: item.unit?.slice(0, 20) || null,
    weightKg: num(item.weightKg),
    volumeM3: num(item.volumeM3),
    amount: num(item.amount),
    currency: item.currency?.slice(0, 8) || null,
    tnvedCode: item.tnvedCode || known.get(productKey(item.name))?.tnvedCode || null,
    note: item.note?.slice(0, 500) || null,
  }));

  const assigneeId = await nextVedAssignee();
  const hasMaterials = Boolean(noteId) || Boolean(input.hasMaterials);
  const dueAt = new Date(Date.now() + calcDueMinutes(items.length, hasMaterials) * 60_000);

  const requestId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(calcRequests)
      .values({
        entityType: input.entityType,
        entityId: input.entityId,
        requestedBy: ctx.actorId!,
        assigneeId,
        itemCount: items.length,
        section: input.section,
        fromCity: input.fromCity?.slice(0, 120) || null,
        toCity: input.toCity?.slice(0, 120) || null,
        weightKg: num(input.weightKg),
        volumeM3: num(input.volumeM3),
        source: input.source,
        noteId,
        takenAt: assigneeId ? new Date() : null,
        dueAt,
      })
      .returning({ id: calcRequests.id });
    const id = row!.id;
    if (items.length > 0) {
      await tx.insert(calcRequestItems).values(items.map((item) => ({ ...item, requestId: id })));
    }
    await writeAudit(tx, ctx, {
      entityType: input.entityType,
      entityId: input.entityId,
      action: 'update',
      after: {
        calcRequested: id,
        section: input.section,
        items: items.length,
        dueAt: dueAt.toISOString(),
      },
    });
    return id;
  });

  // The task is what puts the job on somebody's /bugun and their phone; it
  // carries the request's own deadline, so the two clocks cannot drift.
  if (assigneeId) {
    try {
      const task = await createTask(
        {
          title: `Hisoblash: ${label} (${items.length})`,
          note: '',
          typeId: null,
          assigneeId,
          dueAt: dueAt.toISOString(),
          priority: 1,
          entityType: input.entityType,
          entityId: input.entityId,
          repeatUnit: null,
          repeatEvery: 1,
        },
        ctx,
      );
      await db
        .update(calcRequests)
        .set({ taskId: task.id, updatedAt: new Date() })
        .where(eq(calcRequests.id, requestId));
    } catch (err) {
      // A request with no task is recoverable (the detail screen still shows
      // it and «Olaman» mints one); a task with no request is a ghost on
      // somebody's day screen for ever. Claim first, task second.
      logger.error({ err, requestId }, '[calc] task creation failed');
    }
  } else {
    // Nobody holds `ved.docs`: the work is recorded and the owner is told,
    // because a queue nobody can be given is exactly the thing that would
    // otherwise sit unnoticed.
    const owners = await usersWithRoles(['super_admin']);
    await notifyStaffTelegram({
      userIds: owners,
      type: 'CalcRequested',
      text: `🧮 Hisoblash so'rovi keldi: ${label}\n⚠️ VED xodimi topilmadi — navbatda turibdi`,
      exceptUserId: ctx.actorId,
    }).catch((err) => logger.error({ err, requestId }, '[calc] unassigned notify failed'));
  }

  return { id: requestId, assigneeId };
}

/**
 * Take a request over.
 *
 * The claim IS the UPDATE: two people pressing «Olaman» in the same second
 * must not both mint a task, and a read-then-write leaves the loser holding
 * an open, timed task no request points at (`completeCalcForTask` looks it up
 * by `task_id`, which by then names the winner's).
 */
export async function takeCalcRequest(id: string, ctx: AuditContext): Promise<void> {
  if (!ctx.actorId) throw new CalcError('unauthenticated');
  const rows = await db
    .update(calcRequests)
    .set({ assigneeId: ctx.actorId, takenAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(calcRequests.id, id),
        openRequests,
        sql`${calcRequests.assigneeId} IS DISTINCT FROM ${ctx.actorId}`,
      ),
    )
    .returning({
      taskId: calcRequests.taskId,
      entityType: calcRequests.entityType,
      entityId: calcRequests.entityId,
      requestedBy: calcRequests.requestedBy,
      dueAt: calcRequests.dueAt,
      itemCount: calcRequests.itemCount,
    });
  const won = rows[0];
  if (!won) {
    const row = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    if (!row) throw new CalcError('not_found');
    if (row.completedAt) throw new CalcError('already_closed');
    throw new CalcError('already_yours');
  }

  if (won.taskId) {
    // Moved directly rather than through `reassignTask`: that door asks
    // `canActOnTask` about the PREVIOUS holder's task, and the person taking
    // a request from the queue is authorized by the queue's own gate. Nobody
    // needs telling either — the new assignee is the presser.
    await db
      .update(tasks)
      .set({ assigneeId: ctx.actorId, updatedAt: new Date() })
      .where(and(eq(tasks.id, won.taskId), eq(tasks.status, 'open')));
  } else {
    const label = await requestLabel(won.entityType, won.entityId);
    try {
      const task = await createTask(
        {
          title: `Hisoblash: ${label} (${won.itemCount})`,
          note: '',
          typeId: null,
          assigneeId: ctx.actorId,
          dueAt: won.dueAt.toISOString(),
          priority: 1,
          entityType: won.entityType,
          entityId: won.entityId,
          repeatUnit: null,
          repeatEvery: 1,
        },
        ctx,
      );
      await db
        .update(calcRequests)
        .set({ taskId: task.id, updatedAt: new Date() })
        .where(eq(calcRequests.id, id));
    } catch (err) {
      logger.error({ err, id }, '[calc] task creation on take failed');
    }
  }

  await writeAudit(db, ctx, {
    entityType: won.entityType,
    entityId: won.entityId,
    action: 'update',
    after: { calcTakenBy: ctx.actorId, calcRequest: id },
  });
  await notifyStaffTelegram({
    userIds: [won.requestedBy],
    type: 'CalcTaken',
    text:
      `🧮 Hisoblash olindi: ${await requestLabel(won.entityType, won.entityId)}\n` +
      `👤 ${await userName(ctx.actorId)}${linkLine(won.entityType, won.entityId)}`,
    exceptUserId: ctx.actorId,
  }).catch((err) => logger.error({ err, id }, '[calc] taken notify failed'));
}

/**
 * Put a request back in the queue — the honest state when the person holding
 * it cannot do it, and what a cancelled task leaves behind.
 */
export async function releaseCalcRequest(id: string, ctx: AuditContext): Promise<void> {
  if (!ctx.actorId) throw new CalcError('unauthenticated');
  const rows = await db
    .update(calcRequests)
    .set({ assigneeId: null, taskId: null, takenAt: null, updatedAt: new Date() })
    .where(and(eq(calcRequests.id, id), openRequests))
    .returning({
      entityType: calcRequests.entityType,
      entityId: calcRequests.entityId,
      // The PREVIOUS holder's task — `returning` on an UPDATE hands back the
      // new row, so this is read before the set in the same statement.
      taskId: calcRequests.taskId,
    });
  const row = rows[0];
  if (!row) throw new CalcError('already_closed');
  // The task goes with the work. Leaving it open would put a timed job on
  // somebody's /bugun for a calculation they no longer hold, pointing at a
  // request that no longer names it — the ghost the take path is careful not
  // to create, arriving through the other door.
  if (row.taskId) {
    await db
      .update(tasks)
      .set({ status: 'cancelled', result: 'Navbatga qaytarildi', updatedAt: new Date() })
      .where(and(eq(tasks.id, row.taskId), eq(tasks.status, 'open')));
  }
  await writeAudit(db, ctx, {
    entityType: row.entityType,
    entityId: row.entityId,
    action: 'update',
    after: { calcReleased: id },
  });
}

/** Shared ending: stamp the request, then close its task DIRECTLY.
 *
 * Never through `completeTask` — that would ricochet back through this
 * module's own hook and stamp `completed_via: 'task'` over the ending that is
 * actually happening, and would send `TaskDone` beside our own message. */
async function endRequest(
  id: string,
  patch: {
    via: 'task' | 'returned' | 'lines';
    actorId: string;
    returnReason?: string | null;
    answerAmount?: number | null;
    answerCurrency?: string | null;
    answerNote?: string | null;
  },
): Promise<{
  entityType: string;
  entityId: string;
  requestedBy: string;
  taskId: string | null;
} | null> {
  const now = new Date();
  const rows = await db
    .update(calcRequests)
    .set({
      completedAt: now,
      completedBy: patch.actorId,
      completedVia: patch.via,
      returnReason: patch.returnReason ?? null,
      answerAmount: num(patch.answerAmount ?? null),
      answerCurrency: patch.answerCurrency ?? null,
      answerNote: patch.answerNote ?? null,
      updatedAt: now,
    })
    .where(and(eq(calcRequests.id, id), openRequests))
    .returning({
      entityType: calcRequests.entityType,
      entityId: calcRequests.entityId,
      requestedBy: calcRequests.requestedBy,
      taskId: calcRequests.taskId,
    });
  const row = rows[0];
  if (!row) return null;
  // A request nobody took has no task, and `eq(tasks.id, null)` would match
  // nothing anyway — the branch says so out loud.
  if (row.taskId) {
    await db
      .update(tasks)
      .set({
        status: 'done',
        doneAt: now,
        doneBy: patch.actorId,
        result: patch.via === 'returned' ? 'Qaytarildi' : 'Hisoblandi',
        updatedAt: now,
      })
      .where(and(eq(tasks.id, row.taskId), eq(tasks.status, 'open')));
  }
  return row;
}

/** Hand it back: the information is not enough to price the job. */
export async function returnCalcRequest(
  id: string,
  reason: string,
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId) throw new CalcError('unauthenticated');
  const trimmed = reason.trim();
  if (trimmed.length < 3) throw new CalcError('reason_required');
  const row = await endRequest(id, {
    via: 'returned',
    actorId: ctx.actorId,
    returnReason: trimmed.slice(0, 500),
  });
  if (!row) throw new CalcError('already_closed');
  await writeAudit(db, ctx, {
    entityType: row.entityType,
    entityId: row.entityId,
    action: 'update',
    after: { calcReturned: id, reason: trimmed.slice(0, 500) },
  });
  await notifyStaffTelegram({
    userIds: [row.requestedBy],
    type: 'CalcReturned',
    text:
      `↩️ Hisoblash qaytarildi: ${await requestLabel(row.entityType, row.entityId)}\n` +
      `📝 ${trimmed.slice(0, 300)}${linkLine(row.entityType, row.entityId)}`,
    exceptUserId: ctx.actorId,
  }).catch((err) => logger.error({ err, id }, '[calc] returned notify failed'));
}

/** Done — with the figure the seller is waiting for. */
export async function finishCalcRequest(
  id: string,
  answer: { amount?: number | null; currency?: string | null; note?: string | null },
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId) throw new CalcError('unauthenticated');
  const row = await endRequest(id, {
    via: 'task',
    actorId: ctx.actorId,
    answerAmount: answer.amount ?? null,
    answerCurrency: answer.amount != null ? answer.currency || 'USD' : null,
    answerNote: answer.note?.trim().slice(0, 2000) || null,
  });
  if (!row) throw new CalcError('already_closed');
  const label = await requestLabel(row.entityType, row.entityId);
  const money =
    answer.amount != null ? `\n💵 ${answer.amount} ${answer.currency || 'USD'}` : '';
  await writeAudit(db, ctx, {
    entityType: row.entityType,
    entityId: row.entityId,
    action: 'update',
    after: { calcDone: id, amount: answer.amount ?? null },
  });
  await notifyStaffTelegram({
    userIds: [row.requestedBy],
    type: 'CalcDone',
    text:
      `✅ Hisoblash tayyor: ${label}${money}` +
      `${answer.note ? `\n📝 ${answer.note.slice(0, 300)}` : ''}` +
      linkLine(row.entityType, row.entityId),
    exceptUserId: ctx.actorId,
  }).catch((err) => logger.error({ err, id }, '[calc] done notify failed'));
}

/**
 * The honest end of a DEAL's clock: the calculation was SAVED.
 *
 * Called from `saveLines` AFTER its transaction — a hook inside it would ask
 * the pool for a second connection while one is held, which is what freezes
 * every screen in the app. Guarded on a non-empty save: wiping a deal's lines
 * is not a calculation.
 */
export async function completeCalcForDeal(dealId: string, actorId: string): Promise<void> {
  const open = await db.query.calcRequests.findFirst({
    where: and(
      eq(calcRequests.entityType, 'deal'),
      eq(calcRequests.entityId, dealId),
      openRequests,
    ),
    orderBy: asc(calcRequests.requestedAt),
  });
  if (!open) return;
  await endRequest(open.id, { via: 'lines', actorId });
}

/** The clock's other end: the task itself was closed by hand. */
export async function completeCalcForTask(taskId: string, actorId: string): Promise<void> {
  const open = await db.query.calcRequests.findFirst({
    where: and(eq(calcRequests.taskId, taskId), openRequests),
  });
  if (!open) return;
  await endRequest(open.id, { via: 'task', actorId });
}

/**
 * A cancelled task must not park its request for ever: the request goes back
 * to the queue, which is the honest state — the work still needs doing and
 * nobody is holding it.
 */
export async function releaseCalcForTask(taskId: string, actorId: string): Promise<void> {
  const open = await db.query.calcRequests.findFirst({
    where: and(eq(calcRequests.taskId, taskId), openRequests),
  });
  if (!open) return;
  await db
    .update(calcRequests)
    .set({ assigneeId: null, taskId: null, takenAt: null, updatedAt: new Date() })
    .where(eq(calcRequests.id, open.id));
  logger.info({ requestId: open.id, actorId }, '[calc] request released by task cancel');
}

/**
 * A won lead's open requests follow the cargo onto the new deal.
 *
 * Without this the request stays keyed to the lead: the seller then saves the
 * deal's lines and `completeCalcForDeal` finds nothing, so that clock can
 * never stop. The same door `rekeyLeadCalls`/`rekeyLeadChats` already use.
 */
export async function rekeyLeadCalcRequests(leadId: string, dealId: string): Promise<number> {
  const rows = await db
    .update(calcRequests)
    .set({ entityType: 'deal', entityId: dealId, updatedAt: new Date() })
    // EVERY request, not just the open ones.
    //
    // It filtered `openRequests` while a closed request was only history. A
    // SEALED request is closed and carries a PRICE, and `currentSealFor` finds
    // a version by the card its request points at — so leaving sealed ones on
    // the lead handed the new deal the number with none of the lock, and the
    // quote became freely editable at exactly the moment it becomes the
    // invoice. The won lead keeps its own copy as history; the deal is the
    // live record, and it is the one that must stay locked.
    .where(and(eq(calcRequests.entityType, 'lead'), eq(calcRequests.entityId, leadId)))
    .returning({ id: calcRequests.id });
  return rows.length;
}

/**
 * The card's own address, for a message read on a phone.
 *
 * Through `cardLink` rather than a template literal: where a deal or a lead
 * lives is already answered in one place, and a third copy is the thing #381
 * records (remembered in one place, forgotten in the other).
 */
function linkLine(entityType: string, entityId: string): string {
  const href = cardLink(entityType, entityId);
  return href ? `\n${href}` : '';
}

async function requestLabel(entityType: string, entityId: string): Promise<string> {
  if (entityType === 'deal') {
    const deal = await db.query.deals.findFirst({ where: eq(deals.id, entityId) });
    return deal?.code ?? '—';
  }
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, entityId) });
  return lead?.name ?? '—';
}

/**
 * Tell people a calculation is late — once per request, the moment the sweep
 * first sees it.
 *
 * The claim IS the UPDATE (0082's lesson, three rounds old): a sweep that
 * selects, sends and only then stamps delivers everything twice the day two
 * drains overlap. Everything after the claim is bookkeeping over a set that
 * is already ours.
 */
export async function notifyOverdueCalcs(now = new Date()): Promise<number> {
  const late = (await db
    .update(calcRequests)
    .set({ overdueNotifiedAt: now })
    .where(
      and(
        openRequests,
        lt(calcRequests.dueAt, now),
        isNull(calcRequests.overdueNotifiedAt),
      ),
    )
    .returning({
      id: calcRequests.id,
      entityType: calcRequests.entityType,
      entityId: calcRequests.entityId,
      requestedBy: calcRequests.requestedBy,
      assigneeId: calcRequests.assigneeId,
      itemCount: calcRequests.itemCount,
      dueAt: calcRequests.dueAt,
    })) as {
    id: string;
    entityType: string;
    entityId: string;
    requestedBy: string;
    assigneeId: string | null;
    itemCount: number;
    dueAt: Date;
  }[];
  if (late.length === 0) return 0;

  // Loop-invariant work, hoisted: the same answer on the first row and the
  // hundredth (#432 — count round trips, do not time them).
  const owners = await usersWithRoles(['super_admin']);
  const vedIds = late.some((row) => !row.assigneeId) ? await usersWithPermission('ved.docs') : [];
  const dealIds = late.filter((r) => r.entityType === 'deal').map((r) => r.entityId);
  const leadIds = late.filter((r) => r.entityType === 'lead').map((r) => r.entityId);
  const dealNames = dealIds.length
    ? new Map(
        (
          await db
            .select({ id: deals.id, code: deals.code })
            .from(deals)
            .where(inArray(deals.id, dealIds))
        ).map((r) => [r.id, r.code]),
      )
    : new Map<string, string>();
  const leadNames = leadIds.length
    ? new Map(
        (
          await db
            .select({ id: leads.id, name: leads.name })
            .from(leads)
            .where(inArray(leads.id, leadIds))
        ).map((r) => [r.id, r.name]),
      )
    : new Map<string, string>();

  let sent = 0;
  for (const row of late) {
    const minutesLate = Math.max(1, Math.round((now.getTime() - row.dueAt.getTime()) / 60_000));
    const label =
      (row.entityType === 'deal' ? dealNames.get(row.entityId) : leadNames.get(row.entityId)) ??
      '—';
    // An untaken late request is a TEAM failure, so it reaches the people who
    // could take it. A taken one does not: that person's own task is already
    // red on their day screen.
    const to = [...new Set([row.requestedBy, ...owners, ...(row.assigneeId ? [] : vedIds)])];
    await notifyStaffTelegram({
      userIds: to,
      type: 'CalcOverdue',
      text:
        `🔴 Hisoblash kechikdi: ${label} (${row.itemCount})\n` +
        (row.assigneeId ? `👤 ${await userName(row.assigneeId)}\n` : `⚠️ Hech kim olmagan\n`) +
        `⏱ ${minutesLate} daqiqa kechikdi`,
      exceptUserId: row.assigneeId,
    }).catch((err) => logger.error({ err, requestId: row.id }, '[calc] overdue notify failed'));
    sent += 1;
  }
  return sent;
}

export interface CalcQueueRow {
  id: string;
  entityType: string;
  entityId: string;
  label: string;
  section: string | null;
  fromCity: string | null;
  toCity: string | null;
  weightKg: number | null;
  volumeM3: number | null;
  itemCount: number;
  requestedAt: Date;
  dueAt: Date;
  requesterName: string;
  assigneeId: string | null;
  assigneeName: string | null;
  missing: string[];
  late: boolean;
}

/**
 * The open queue, oldest first.
 *
 * Every join onto a person is a LEFT join: a request nobody has taken is
 * exactly the row this screen exists for, and an inner join would drop it.
 */
export async function calcQueue(now = new Date()): Promise<CalcQueueRow[]> {
  const rows = await db.execute<{
    id: string;
    entity_type: string;
    entity_id: string;
    section: string | null;
    from_city: string | null;
    to_city: string | null;
    weight_kg: string | null;
    volume_m3: string | null;
    item_count: number;
    requested_at: string;
    due_at: string;
    requester_name: string | null;
    assignee_id: string | null;
    assignee_name: string | null;
    label: string | null;
  }>(sql`
    SELECT r.id, r.entity_type, r.entity_id, r.section, r.from_city, r.to_city,
           r.weight_kg, r.volume_m3, r.item_count, r.requested_at, r.due_at,
           requester.full_name AS requester_name,
           r.assignee_id, assignee.full_name AS assignee_name,
           coalesce(d.code, l.name) AS label
    FROM calc_requests r
    -- Every join onto a person is LEFT: a request nobody has taken is
    -- exactly the row this screen exists for, and an inner join drops it.
    LEFT JOIN users requester ON requester.id = r.requested_by
    LEFT JOIN users assignee ON assignee.id = r.assignee_id
    LEFT JOIN deals d ON r.entity_type = 'deal' AND d.id = r.entity_id
    LEFT JOIN leads l ON r.entity_type = 'lead' AND l.id = r.entity_id
    WHERE r.completed_at IS NULL
    -- Unclaimed first, then oldest: ordered in SQL, never over the array.
    ORDER BY (r.assignee_id IS NOT NULL), r.requested_at ASC
    LIMIT 200
  `);
  const ids = rows.map((row) => row.id);
  const goods = await goodsByRequest(ids);
  return rows.map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    label: row.label ?? '—',
    section: row.section,
    fromCity: row.from_city,
    toCity: row.to_city,
    weightKg: toNum(row.weight_kg),
    volumeM3: toNum(row.volume_m3),
    itemCount: Number(row.item_count),
    // A raw `db.execute` hands timestamps over as STRINGS — the typed query
    // builder is what returns Dates — so every one is coerced here rather
    // than crashing the first time somebody asks whether it is late.
    requestedAt: new Date(row.requested_at),
    dueAt: new Date(row.due_at),
    requesterName: row.requester_name ?? '—',
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name,
    missing: missingFor(row.section, {
      fromCity: row.from_city,
      toCity: row.to_city,
      weightKg: toNum(row.weight_kg),
      volumeM3: toNum(row.volume_m3),
      goods: goods.get(row.id) ?? [],
    }),
    late: new Date(row.due_at).getTime() < now.getTime(),
  }));
}

/**
 * The two numbers the VED home shows, over the SAME fragment the queue reads
 * — a home that advertises a count the screen does not show is worse than a
 * home with no count (#513).
 */
export async function calcQueueCounts(
  now = new Date(),
): Promise<{ open: number; late: number }> {
  const [row] = await db
    .select({
      open: sql<number>`count(*)::int`,
      late: sql<number>`count(*) FILTER (WHERE ${calcRequests.dueAt} < ${now.toISOString()}::timestamptz)::int`,
    })
    .from(calcRequests)
    .where(openRequests);
  return { open: Number(row?.open ?? 0), late: Number(row?.late ?? 0) };
}

async function goodsByRequest(ids: string[]): Promise<Map<string, { name: string }[]>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ requestId: calcRequestItems.requestId, name: calcRequestItems.name })
    .from(calcRequestItems)
    .where(inArray(calcRequestItems.requestId, ids));
  const out = new Map<string, { name: string }[]>();
  for (const row of rows) {
    const list = out.get(row.requestId) ?? [];
    list.push({ name: row.name });
    out.set(row.requestId, list);
  }
  return out;
}

/**
 * What is still missing, in the bot's own vocabulary.
 *
 * The checklist is `missingFields` — the pure function the Telegram intake
 * has used since round 37 — so the screen and the bot ask the card the same
 * question. A row written before 0085 has no section and therefore no
 * checklist: nobody ever said what kind of job it was.
 */
export function missingFor(section: string | null, facts: CalcFacts): string[] {
  if (!section) return [];
  return missingFields(section as CalcSection, facts);
}

export { isComplete };

export interface CalcRequestDetail extends CalcQueueRow {
  noteId: string | null;
  source: string | null;
  completedAt: Date | null;
  completedVia: string | null;
  returnReason: string | null;
  answerAmount: number | null;
  answerCurrency: string | null;
  answerNote: string | null;
  items: {
    seq: number;
    name: string;
    quantity: number | null;
    unit: string | null;
    weightKg: number | null;
    volumeM3: number | null;
    amount: number | null;
    currency: string | null;
    tnvedCode: string | null;
    note: string | null;
  }[];
}

/** One request, with its goods — the VED person's whole screen. */
export async function calcRequestDetail(
  id: string,
  now = new Date(),
): Promise<CalcRequestDetail | null> {
  const row = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
  if (!row) return null;
  const itemRows = await db
    .select()
    .from(calcRequestItems)
    .where(eq(calcRequestItems.requestId, id))
    .orderBy(asc(calcRequestItems.seq));
  const items = itemRows.map((item) => ({
    seq: item.seq,
    name: item.name,
    quantity: toNum(item.quantity),
    unit: item.unit,
    weightKg: toNum(item.weightKg),
    volumeM3: toNum(item.volumeM3),
    amount: toNum(item.amount),
    currency: item.currency,
    tnvedCode: item.tnvedCode,
    note: item.note,
  }));
  const [requester, assignee] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, row.requestedBy), columns: { fullName: true } }),
    row.assigneeId
      ? db.query.users.findFirst({
          where: eq(users.id, row.assigneeId),
          columns: { fullName: true },
        })
      : Promise.resolve(null),
  ]);
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    label: await requestLabel(row.entityType, row.entityId),
    section: row.section,
    fromCity: row.fromCity,
    toCity: row.toCity,
    weightKg: toNum(row.weightKg),
    volumeM3: toNum(row.volumeM3),
    itemCount: row.itemCount,
    requestedAt: row.requestedAt,
    dueAt: row.dueAt,
    requesterName: requester?.fullName ?? '—',
    assigneeId: row.assigneeId,
    assigneeName: assignee?.fullName ?? null,
    missing: missingFor(row.section, {
      fromCity: row.fromCity,
      toCity: row.toCity,
      weightKg: toNum(row.weightKg),
      volumeM3: toNum(row.volumeM3),
      goods: items.map((item) => ({ name: item.name })),
    }),
    late: !row.completedAt && row.dueAt.getTime() < now.getTime(),
    noteId: row.noteId,
    source: row.source,
    completedAt: row.completedAt,
    completedVia: row.completedVia,
    returnReason: row.returnReason,
    answerAmount: toNum(row.answerAmount),
    answerCurrency: row.answerCurrency,
    answerNote: row.answerNote,
    items,
  };
}

/** The open request(s) on one card — what the seller's panel shows. */
export async function openCalcFor(
  entityType: 'deal' | 'lead',
  entityId: string,
  now = new Date(),
): Promise<CalcQueueRow[]> {
  const rows = await db
    .select({
      id: calcRequests.id,
      section: calcRequests.section,
      itemCount: calcRequests.itemCount,
      requestedAt: calcRequests.requestedAt,
      dueAt: calcRequests.dueAt,
      assigneeId: calcRequests.assigneeId,
      assigneeName: users.fullName,
      fromCity: calcRequests.fromCity,
      toCity: calcRequests.toCity,
      weightKg: calcRequests.weightKg,
      volumeM3: calcRequests.volumeM3,
    })
    .from(calcRequests)
    // LEFT: a request nobody has taken must still appear on the card, or the
    // panel says «no request» and the seller sends the same job twice.
    .leftJoin(users, eq(calcRequests.assigneeId, users.id))
    .where(
      and(
        eq(calcRequests.entityType, entityType),
        eq(calcRequests.entityId, entityId),
        openRequests,
      ),
    )
    .orderBy(asc(calcRequests.requestedAt));
  return rows.map((row) => ({
    id: row.id,
    entityType,
    entityId,
    label: '',
    section: row.section,
    fromCity: row.fromCity,
    toCity: row.toCity,
    weightKg: toNum(row.weightKg),
    volumeM3: toNum(row.volumeM3),
    itemCount: row.itemCount,
    requestedAt: row.requestedAt,
    dueAt: row.dueAt,
    requesterName: '',
    assigneeId: row.assigneeId,
    assigneeName: row.assigneeName,
    missing: [],
    late: row.dueAt.getTime() < now.getTime(),
  }));
}

/** The last answer this card was given — the seller's «what did we quote?». */
export async function lastCalcAnswerFor(
  entityType: 'deal' | 'lead',
  entityId: string,
): Promise<{ amount: number | null; currency: string | null; note: string | null; at: Date } | null> {
  const row = await db.query.calcRequests.findFirst({
    where: and(
      eq(calcRequests.entityType, entityType),
      eq(calcRequests.entityId, entityId),
      eq(calcRequests.completedVia, 'task'),
    ),
    orderBy: desc(calcRequests.completedAt),
  });
  if (!row?.completedAt) return null;
  return {
    amount: toNum(row.answerAmount),
    currency: row.answerCurrency,
    note: row.answerNote,
    at: row.completedAt,
  };
}

export interface CalcSpeedRow {
  assigneeId: string | null;
  assigneeName: string;
  done: number;
  avgMinutes: number | null;
  onTime: number;
  open: number;
}

/**
 * How fast the answers come, per person.
 *
 * `completed_via <> 'returned'` is not an optimisation: a bounce-back takes
 * ninety seconds, and counting it as an answer would make the person who
 * bounces everything the fastest calculator in the company.
 */
export async function calcSpeed(since: Date): Promise<CalcSpeedRow[]> {
  const rows = await db.execute<{
    assignee_id: string | null;
    assignee_name: string | null;
    done: number;
    avg_minutes: number | null;
    on_time: number;
    open: number;
  }>(sql`
    SELECT r.assignee_id,
           u.full_name AS assignee_name,
           count(*) FILTER (WHERE r.completed_at IS NOT NULL AND r.completed_via <> 'returned')::int AS done,
           avg(extract(epoch FROM (r.completed_at - r.requested_at)) / 60)
             FILTER (WHERE r.completed_at IS NOT NULL AND r.completed_via <> 'returned') AS avg_minutes,
           count(*) FILTER (WHERE r.completed_at IS NOT NULL AND r.completed_via <> 'returned'
                              AND r.completed_at <= r.due_at)::int AS on_time,
           count(*) FILTER (WHERE r.completed_at IS NULL)::int AS open
    FROM calc_requests r
    LEFT JOIN users u ON u.id = r.assignee_id
    WHERE r.requested_at >= ${since.toISOString()}::timestamptz OR r.completed_at IS NULL
    GROUP BY r.assignee_id, u.full_name
    ORDER BY count(*) FILTER (WHERE r.completed_at IS NOT NULL) DESC
  `);
  return rows.map((row) => ({
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name ?? '—',
    done: Number(row.done),
    avgMinutes: row.avg_minutes === null ? null : Math.round(Number(row.avg_minutes)),
    onTime: Number(row.on_time),
    open: Number(row.open),
  }));
}
