import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import type { Person, TaskType, TaskView } from '@/components/task-list';
import { aboutLabels, listTaskTypes, openCounts, type TaskRow } from './service';

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
  receipt: (id) => `/receipts/${id}`,
  box: (id) => `/boxes/${id}`,
  crate: (id) => `/crates/${id}`,
  batch: (id) => `/batches/${id}`,
  plan: (id) => `/plans/${id}`,
  warehouse: (id) => `/admin/warehouses/${id}`,
  user: (id) => `/admin/users/${id}`,
};

/**
 * Turn service rows into something a client component can hold.
 *
 * Dates become ISO strings — a `Date` cannot cross the server/client boundary —
 * and each task learns the name and the address of whatever it is about, in one
 * query per entity type rather than one per task.
 */
export async function toTaskViews(rows: TaskRow[]): Promise<TaskView[]> {
  const labels = await aboutLabels(rows);
  return rows.map((row) => {
    const key = row.entityType && row.entityId ? `${row.entityType}:${row.entityId}` : null;
    const route = row.entityType ? ROUTES[row.entityType] : undefined;
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
      aboutHref: route && row.entityId ? route(row.entityId) : null,
      aboutLabel: key ? (labels.get(key) ?? null) : null,
    };
  });
}

/** Who work can be given to, with what each of them is already carrying. */
export async function assignablePeople(): Promise<Person[]> {
  const [rows, counts] = await Promise.all([
    db
      .select({ id: users.id, name: users.fullName })
      .from(users)
      .where(eq(users.active, true))
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
