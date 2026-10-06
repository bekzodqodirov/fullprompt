import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { attachments, users } from '../db/schema';
import type { Person, TaskFileView, TaskType, TaskView } from '@/components/task-list';
import { aboutLabels, bindingsOf, listTaskTypes, openCounts, type TaskBinding, type TaskRow } from './service';
import { TASK_ENTITY_TYPE } from './files-job';
import { logger } from '../logger';
import { canLogInSql } from '../users/login';

/**
 * The route a record of each kind lives at.
 *
 * Kept here rather than in the registry because it is a UI fact: the registry
 * says what a client IS, this says where the client CARD is. A type with no
 * entry simply renders without a link — better than a dead one.
 */
const ROUTES: Record<string, (id: string) => string> = {
  client: (id) => `/admin/clients/${id}`,
  lead: (id) => `/crm/leads/${id}`,
  deal: (id) => `/bitimlar/${id}`,
  receipt: (id) => `/receipts/${id}`,
  box: (id) => `/boxes/${id}`,
  crate: (id) => `/crates/${id}`,
  batch: (id) => `/batches/${id}`,
  plan: (id) => `/plans/${id}`,
  warehouse: (id) => `/admin/warehouses/${id}`,
  user: (id) => `/admin/users/${id}`,
};

/**
 * Where a task's subject lives, or null when it is about nothing.
 *
 * Exported so the analytics screen links the same way the task lists do —
 * a second copy of this map would be the phase-8 `x_` rule remembered in one
 * place and forgotten in the other (#381).
 */
export function aboutHref(entityType: string | null, entityId: string | null): string | null {
  if (!entityType || !entityId) return null;
  const route =
    ROUTES[entityType] ??
    (entityType.startsWith('x_') ? (id: string) => `/o/${entityType}/${id}` : undefined);
  return route ? route(entityId) : null;
}

/** Who is READING the list — a calc job draws differently for the VED and for everyone else. */
export interface TaskViewer {
  id: string;
  permissions: Set<string>;
}

/**
 * The files the staff bot stored on these tasks (his 3a), in ONE query for
 * the whole list (#432), never one per task.
 */
export async function taskFiles(taskIds: string[]): Promise<Map<string, TaskFileView[]>> {
  const out = new Map<string, TaskFileView[]>();
  if (taskIds.length === 0) return out;
  const rows = await db
    .select({
      id: attachments.id,
      entityId: attachments.entityId,
      fileName: attachments.fileName,
      contentType: attachments.contentType,
    })
    .from(attachments)
    .where(and(eq(attachments.entityType, TASK_ENTITY_TYPE), inArray(attachments.entityId, taskIds)))
    .orderBy(asc(attachments.createdAt));
  for (const row of rows) {
    const kind: TaskFileView['kind'] = row.contentType.startsWith('image/')
      ? 'image'
      : row.contentType.startsWith('audio/')
        ? 'audio'
        : row.contentType.startsWith('video/')
          ? 'video'
          : 'file';
    out.set(row.entityId, [...(out.get(row.entityId) ?? []), { id: row.id, name: row.fileName, kind }]);
  }
  return out;
}

/**
 * Where a task's title takes its READER, and the calc job's own door — ONE
 * rule for every surface that lists tasks: the task list here and the dock's
 * route (review access-3: the dock linked an open calc job's title to the
 * LEAD card, and the CRM layout sends a VED without `crm.leads` home from it
 * — the dead door this rule exists to remove, surviving on the third
 * surface). A `ved.docs` reader of an open calc job gets the job's screen as
 * both the action and the about-link; anybody else keeps the card link and
 * reads the job as a chip.
 */
export function readerTaskLinks(
  row: { entityType: string | null; entityId: string | null; status: string },
  binding: TaskBinding | undefined,
  viewer: { permissions: { has(code: string): boolean } },
): { aboutHref: string | null; calc: { href: string; mayOpen: boolean } | null } {
  const calcOpen = binding?.kind === 'calc' && binding.open && row.status === 'open';
  const about = aboutHref(row.entityType, row.entityId);
  if (!calcOpen) return { aboutHref: about, calc: null };
  const calcHref = `/hisoblash/${binding.recordId}`;
  const mayOpen = viewer.permissions.has('ved.docs');
  return { aboutHref: mayOpen ? calcHref : about, calc: { href: calcHref, mayOpen } };
}

/**
 * Turn service rows into something a client component can hold.
 *
 * Dates become ISO strings — a `Date` cannot cross the server/client boundary —
 * and each task learns the name and the address of whatever it is about, in one
 * query per entity type rather than one per task.
 *
 * The READER decides how a calc job draws (docs/VED-TARIX.md §8, §13): a task
 * bound to an OPEN calc request has no ✅ for anybody — the job ends on its
 * own screen — and a `ved.docs` reader gets «🧮 Hisobni ochish» there as both
 * the action and the about-link (the lead card the old link named sends a VED
 * without `crm.leads` home); anybody else keeps the card link and reads a
 * «VED hisoblamoqda» chip. An unbound or closed-request calc task keeps its
 * ordinary ✅, or nobody could ever close it.
 */
export async function toTaskViews(rows: TaskRow[], viewer: TaskViewer): Promise<TaskView[]> {
  const [labels, bindings, files] = await Promise.all([
    aboutLabels(rows),
    // A list that cannot tell draws the ordinary ✅; the door behind it fails
    // CLOSED and says so in words.
    bindingsOf(rows).catch((err: unknown) => {
      logger.warn({ err }, '[tasks] list bindings unreadable — drawing plain rows');
      return new Map<string, TaskBinding>();
    }),
    taskFiles(rows.map((row) => row.id)),
  ]);
  return rows.map((row) => {
    const key = row.entityType && row.entityId ? `${row.entityType}:${row.entityId}` : null;
    const links = readerTaskLinks(row, bindings.get(row.id), viewer);

    return {
      id: row.id,
      title: row.title,
      note: row.note,
      typeName: row.typeName,
      typeIcon: row.typeIcon,
      assigneeId: row.assigneeId,
      assigneeName: row.assigneeName,
      authorName: row.authorName,
      dueAt: row.dueAt ? row.dueAt.toISOString() : null,
      allDay: row.allDay,
      status: row.status,
      result: row.result,
      priority: row.priority,
      repeatUnit: row.repeatUnit,
      aboutHref: links.aboutHref,
      aboutLabel: key ? (labels.get(key) ?? null) : null,
      calc: links.calc,
      // The holder of an open calc job moves through the queue's «Olaman /
      // Bo'shatish», never a task's select (telegram-mechanics-12).
      canReassign: links.calc === null,
      files: files.get(row.id) ?? [],
    };
  });
}

/** Who work can be given to, with what each of them is already carrying. */
export async function assignablePeople(): Promise<Person[]> {
  const [rows, counts] = await Promise.all([
    db
      .select({ id: users.id, name: users.fullName })
      .from(users)
      // A colleague NOW (`canLogIn`, 0120): a person who never signs in would
      // never see the task.
      .where(canLogInSql())
      .orderBy(asc(users.fullName)),
    openCounts(),
  ]);
  return rows.map((row) => ({ ...row, openCount: counts.get(row.id) ?? 0 }));
}

export async function taskTypeOptions(): Promise<TaskType[]> {
  const rows = await listTaskTypes();
  return rows.map((row) => ({ id: row.id, name: row.name, icon: row.icon }));
}

/** End of the viewer's today, in UTC — the boundary "overdue" is measured from. */
export function endOfToday(): Date {
  const value = new Date();
  value.setUTCHours(23, 59, 59, 999);
  return value;
}
