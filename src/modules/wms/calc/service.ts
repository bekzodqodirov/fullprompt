import { and, asc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import {
  calcRequests,
  deals,
  leads,
  permissions,
  rolePermissions,
  roles,
  tasks,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { writeAudit, type AuditContext } from '@/modules/platform/audit/service';
import { createTask } from '@/modules/platform/tasks/service';
import { notifyStaffTelegram, userName } from '@/modules/platform/notifications/staff';
import { logger } from '@/modules/platform/logger';

/**
 * Hisoblash — a calculation handed to a VED person, with a clock on it
 * (round 28, owner: «hisoblash degan zadacha kerak va VED xodimlarim
 * qanchada hisoblab berayotganini bilishim kerak»).
 *
 * The salesperson picks WHO does it (his answer 2); the deadline scales with
 * the SIZE of the job (his ask: one TNVED line is half an hour, more lines
 * more time, never past two hours); and the clock is stopped by the WORK,
 * not by a button — saving the deal's lines closes the request. A lead has
 * no lines to save, so there the closed task is the only end there is.
 */

export class CalcError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/**
 * The owner's scale, verbatim: «1 dona TNVED kod bo'lsa yarim soat; 2, 3,
 * 10 ta — shunga moslanib, maksimum 2 soat».
 */
export function calcDueMinutes(itemCount: number): number {
  return Math.min(30 * Math.max(1, itemCount), 120);
}

/** Everyone whose CURRENT grants say they do VED work — the picker's list.
 * Resolved from the editable grants, never a compiled role name (#170). */
export async function vedPeople(): Promise<{ id: string; name: string }[]> {
  const rows = await db
    .select({ id: users.id, name: users.fullName })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .innerJoin(users, eq(userRoles.userId, users.id))
    .where(and(eq(permissions.code, 'ved.docs'), eq(users.active, true)))
    .orderBy(asc(users.fullName));
  const seen = new Map(rows.map((row) => [row.id, row]));
  return [...seen.values()];
}

async function usersWithRole(code: string): Promise<string[]> {
  const rows = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(roles.code, code));
  return [...new Set(rows.map((row) => row.userId))];
}

export interface CalcRequestInput {
  entityType: 'deal' | 'lead';
  entityId: string;
  assigneeId: string;
  itemCount: number;
}

/**
 * Hand a calculation to a VED person: one open request per card, a task with
 * an HOUR-level deadline, and the start of the clock the report reads.
 */
export async function requestCalc(input: CalcRequestInput, ctx: AuditContext): Promise<string> {
  if (!ctx.actorId) throw new CalcError('unauthenticated');
  if (!Number.isInteger(input.itemCount) || input.itemCount < 1 || input.itemCount > 500) {
    throw new CalcError('bad_items');
  }
  // The record must exist, and its NAME goes in the task title so the VED
  // person knows what to open before they open anything.
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
  // The picker offers VED people; the service refuses anyone else, so a
  // hand-crafted request cannot start a clock on somebody who cannot stop it.
  const ved = await vedPeople();
  if (!ved.some((person) => person.id === input.assigneeId)) throw new CalcError('not_ved');

  const open = await db.query.calcRequests.findFirst({
    where: and(
      eq(calcRequests.entityType, input.entityType),
      eq(calcRequests.entityId, input.entityId),
      isNull(calcRequests.completedAt),
    ),
  });
  if (open) throw new CalcError('already_open');

  const due = new Date(Date.now() + calcDueMinutes(input.itemCount) * 60_000);
  // Through the real task service: the assignee gets the same instant
  // Telegram, the same /bugun row and the same calendar entry as any other
  // piece of work — a calculation is not a second kind of task.
  const task = await createTask(
    {
      title: `Hisoblash: ${label} (${input.itemCount})`,
      note: '',
      typeId: null,
      assigneeId: input.assigneeId,
      dueAt: due.toISOString(),
      priority: 1,
      entityType: input.entityType,
      entityId: input.entityId,
      repeatUnit: null,
      repeatEvery: 1,
    },
    ctx,
  );

  const [row] = await db
    .insert(calcRequests)
    .values({
      entityType: input.entityType,
      entityId: input.entityId,
      requestedBy: ctx.actorId,
      assigneeId: input.assigneeId,
      itemCount: input.itemCount,
      taskId: task.id,
      dueAt: due,
    })
    .returning({ id: calcRequests.id });
  await writeAudit(db, ctx, {
    entityType: input.entityType,
    entityId: input.entityId,
    action: 'update',
    after: {
      calcRequested: input.assigneeId,
      items: input.itemCount,
      dueAt: due.toISOString(),
    },
  });
  return row!.id;
}

/** The open request on one card, with the names the banner prints. */
export async function openCalcFor(entityType: 'deal' | 'lead', entityId: string) {
  const [row] = await db
    .select({
      id: calcRequests.id,
      assigneeId: calcRequests.assigneeId,
      assigneeName: users.fullName,
      itemCount: calcRequests.itemCount,
      requestedAt: calcRequests.requestedAt,
      dueAt: calcRequests.dueAt,
    })
    .from(calcRequests)
    .innerJoin(users, eq(calcRequests.assigneeId, users.id))
    .where(
      and(
        eq(calcRequests.entityType, entityType),
        eq(calcRequests.entityId, entityId),
        isNull(calcRequests.completedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  // Judged here, not in the component: render functions are held to purity.
  return { ...row, late: row.dueAt.getTime() < Date.now() };
}

/** Stop the clock and close the task in one move — shared by both ends. */
async function completeRequest(
  request: { id: string; taskId: string },
  via: 'lines' | 'task',
  actorId: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(calcRequests)
    .set({ completedAt: now, completedBy: actorId, completedVia: via })
    .where(and(eq(calcRequests.id, request.id), isNull(calcRequests.completedAt)));
  if (via === 'lines') {
    // The task closes because the WORK is done — directly, not through
    // completeTask: the saver already proved the calculation exists, and
    // completeTask would ricochet back here through its own hook.
    await db
      .update(tasks)
      .set({
        status: 'done',
        doneAt: now,
        doneBy: actorId,
        result: 'Hisoblandi',
        updatedAt: now,
      })
      .where(and(eq(tasks.id, request.taskId), eq(tasks.status, 'open')));
  }
}

/**
 * The honest end of a DEAL's clock: the calculation was SAVED. Called from
 * `saveLines` — fenced there, because a stuck clock must never refuse the
 * save itself.
 */
export async function completeCalcForDeal(dealId: string, actorId: string): Promise<void> {
  const open = await db.query.calcRequests.findFirst({
    where: and(
      eq(calcRequests.entityType, 'deal'),
      eq(calcRequests.entityId, dealId),
      isNull(calcRequests.completedAt),
    ),
  });
  if (!open) return;
  await completeRequest({ id: open.id, taskId: open.taskId }, 'lines', actorId);
}

/**
 * The clock's other end: the task itself was closed by hand. For a lead this
 * is the ONLY end — there are no lines to save; for a deal it is the fallback
 * when the calculation changed nothing worth saving.
 */
export async function completeCalcForTask(taskId: string, actorId: string): Promise<void> {
  const open = await db.query.calcRequests.findFirst({
    where: and(eq(calcRequests.taskId, taskId), isNull(calcRequests.completedAt)),
  });
  if (!open) return;
  await completeRequest({ id: open.id, taskId: open.taskId }, 'task', actorId);
}

/**
 * Tell the people waiting that a calculation is LATE — once per request, the
 * moment the sweep first sees it past its deadline: the salesperson who is
 * blocked by it, and the owner, whose question this whole feature answers.
 */
export async function notifyOverdueCalcs(now = new Date()): Promise<number> {
  const late = await db
    .select({
      id: calcRequests.id,
      entityType: calcRequests.entityType,
      entityId: calcRequests.entityId,
      requestedBy: calcRequests.requestedBy,
      assigneeId: calcRequests.assigneeId,
      itemCount: calcRequests.itemCount,
      dueAt: calcRequests.dueAt,
    })
    .from(calcRequests)
    .where(
      and(
        isNull(calcRequests.completedAt),
        lt(calcRequests.dueAt, now),
        isNull(calcRequests.overdueNotifiedAt),
      ),
    )
    .limit(100);
  let sent = 0;
  for (const row of late) {
    const minutesLate = Math.max(1, Math.round((now.getTime() - row.dueAt.getTime()) / 60_000));
    const owners = await usersWithRole('super_admin');
    const label =
      row.entityType === 'deal'
        ? (await db.query.deals.findFirst({ where: eq(deals.id, row.entityId) }))?.code
        : (await db.query.leads.findFirst({ where: eq(leads.id, row.entityId) }))?.name;
    await notifyStaffTelegram({
      userIds: [...new Set([row.requestedBy, ...owners])],
      type: 'CalcOverdue',
      text:
        `🔴 Hisoblash kechikdi: ${label ?? '—'} (${row.itemCount})\n` +
        `👤 ${await userName(row.assigneeId)}\n` +
        `⏱ ${minutesLate} daqiqa kechikdi`,
      // The assignee already has the overdue task screaming on /bugun.
      exceptUserId: row.assigneeId,
    }).catch((err) => logger.error({ err, requestId: row.id }, 'calc overdue notify failed'));
    await db
      .update(calcRequests)
      .set({ overdueNotifiedAt: now })
      .where(eq(calcRequests.id, row.id));
    sent += 1;
  }
  return sent;
}

export interface CalcReportRow {
  assigneeId: string;
  assigneeName: string;
  done: number;
  avgMinutes: number | null;
  maxMinutes: number | null;
  onTime: number;
  open: number;
  oldestOpenMinutes: number | null;
}

/**
 * The owner's question as a table: per VED person over a period — how many,
 * how fast, how many met their deadline, and what is sitting unanswered
 * right now. Open requests are counted regardless of the period: work that
 * is waiting is waiting today, whenever it was asked.
 */
export async function calcReport(from: Date, to: Date, now = new Date()): Promise<CalcReportRow[]> {
  const doneRows = await db
    .select({
      assigneeId: calcRequests.assigneeId,
      assigneeName: users.fullName,
      done: sql<number>`count(*)`,
      avgMinutes: sql<number>`avg(extract(epoch FROM (${calcRequests.completedAt} - ${calcRequests.requestedAt})) / 60)`,
      maxMinutes: sql<number>`max(extract(epoch FROM (${calcRequests.completedAt} - ${calcRequests.requestedAt})) / 60)`,
      onTime: sql<number>`count(*) FILTER (WHERE ${calcRequests.completedAt} <= ${calcRequests.dueAt})`,
    })
    .from(calcRequests)
    .innerJoin(users, eq(calcRequests.assigneeId, users.id))
    .where(
      and(
        gte(calcRequests.requestedAt, from),
        lte(calcRequests.requestedAt, to),
        sql`${calcRequests.completedAt} IS NOT NULL`,
      ),
    )
    .groupBy(calcRequests.assigneeId, users.fullName);
  const openRows = await db
    .select({
      assigneeId: calcRequests.assigneeId,
      assigneeName: users.fullName,
      open: sql<number>`count(*)`,
      oldest: sql<Date>`min(${calcRequests.requestedAt})`,
    })
    .from(calcRequests)
    .innerJoin(users, eq(calcRequests.assigneeId, users.id))
    .where(isNull(calcRequests.completedAt))
    .groupBy(calcRequests.assigneeId, users.fullName);

  const byId = new Map<string, CalcReportRow>();
  for (const row of doneRows) {
    byId.set(row.assigneeId, {
      assigneeId: row.assigneeId,
      assigneeName: row.assigneeName ?? '—',
      done: Number(row.done),
      avgMinutes: row.avgMinutes === null ? null : Math.round(Number(row.avgMinutes)),
      maxMinutes: row.maxMinutes === null ? null : Math.round(Number(row.maxMinutes)),
      onTime: Number(row.onTime),
      open: 0,
      oldestOpenMinutes: null,
    });
  }
  for (const row of openRows) {
    const entry = byId.get(row.assigneeId) ?? {
      assigneeId: row.assigneeId,
      assigneeName: row.assigneeName ?? '—',
      done: 0,
      avgMinutes: null,
      maxMinutes: null,
      onTime: 0,
      open: 0,
      oldestOpenMinutes: null,
    };
    entry.open = Number(row.open);
    entry.oldestOpenMinutes = Math.round(
      (now.getTime() - new Date(row.oldest).getTime()) / 60_000,
    );
    byId.set(row.assigneeId, entry);
  }
  return [...byId.values()].sort((a, b) => b.done - a.done || b.open - a.open);
}

/** The open queue, oldest first — the report's second half. */
export async function openCalcList(now = new Date()) {
  const rows = await db
    .select({
      id: calcRequests.id,
      entityType: calcRequests.entityType,
      entityId: calcRequests.entityId,
      assigneeName: users.fullName,
      itemCount: calcRequests.itemCount,
      requestedAt: calcRequests.requestedAt,
      dueAt: calcRequests.dueAt,
    })
    .from(calcRequests)
    .innerJoin(users, eq(calcRequests.assigneeId, users.id))
    .where(isNull(calcRequests.completedAt))
    .orderBy(asc(calcRequests.requestedAt))
    .limit(200);
  // The card's name, so the queue reads as jobs rather than ids.
  const dealIds = rows.filter((r) => r.entityType === 'deal').map((r) => r.entityId);
  const leadIds = rows.filter((r) => r.entityType === 'lead').map((r) => r.entityId);
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
  return rows.map((row) => ({
    ...row,
    label:
      (row.entityType === 'deal' ? dealNames.get(row.entityId) : leadNames.get(row.entityId)) ??
      '—',
    href: row.entityType === 'deal' ? `/bitimlar/${row.entityId}` : `/crm/leads/${row.entityId}`,
    minutesLeft: Math.round((row.dueAt.getTime() - now.getTime()) / 60_000),
  }));
}

/** How many calculations each VED person is already sitting on — the picker
 * shows it so the salesperson can see who is free. */
export async function openCalcCounts(): Promise<Map<string, number>> {
  const rows = await db
    .select({ assigneeId: calcRequests.assigneeId, n: sql<number>`count(*)` })
    .from(calcRequests)
    .where(isNull(calcRequests.completedAt))
    .groupBy(calcRequests.assigneeId);
  return new Map(rows.map((row) => [row.assigneeId, Number(row.n)]));
}
