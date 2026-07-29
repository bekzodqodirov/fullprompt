import { NextResponse } from 'next/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { formatDue, myDay } from '@/modules/platform/tasks/service';
import { endOfToday } from '@/modules/platform/tasks/view';

/**
 * The dock's task list — the same `myDay` the home banner and /bugun read,
 * slimmed to what a side panel can show. A route rather than a server
 * component because the dock opens on top of WHATEVER page is already
 * rendered, and must not cost anything until it does.
 */
export async function GET() {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const day = await myDay(actor.id, endOfToday());
  const slim = (row: (typeof day.overdue)[number]) => ({
    id: row.id,
    title: row.title,
    // A timed deadline keeps its clock (round 28) — «Hisoblash, 30 daqiqa»
    // shown as a bare date reads as "sometime today".
    dueAt: row.dueAt ? formatDue(row.dueAt, row.allDay) : null,
    entityType: row.entityType,
    entityId: row.entityId,
  });
  return NextResponse.json({
    overdue: day.overdue.map(slim),
    today: day.today.map(slim),
    undated: day.undated.map(slim),
  });
}
