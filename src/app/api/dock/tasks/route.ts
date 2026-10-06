import { NextResponse } from 'next/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { logger } from '@/modules/platform/logger';
import { bindingsOf, formatDue, myDay, type TaskBinding } from '@/modules/platform/tasks/service';
import { endOfToday } from '@/modules/platform/tasks/view';

/**
 * The dock's task list — the same `myDay` the home banner and /bugun read,
 * slimmed to what a side panel can show. A route rather than a server
 * component because the dock opens on top of WHATEVER page is already
 * rendered, and must not cost anything until it does.
 *
 * A task bound to an OPEN calc job carries `calc` (VED-TARIX §8) — the same
 * reader rule as the task list: no ✓ for anybody, «🧮» to the job's screen
 * for a `ved.docs` reader, a read-only chip for everyone else.
 */
export async function GET() {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const day = await myDay(actor.id, endOfToday());
  const all = [...day.overdue, ...day.today, ...day.undated];
  // One call for the three buckets; a list that cannot tell draws the plain
  // ✓, and the door behind it fails CLOSED in words.
  const bindings = await bindingsOf(all).catch((err: unknown) => {
    logger.warn({ err }, '[dock] task bindings unreadable — drawing plain rows');
    return new Map<string, TaskBinding>();
  });
  const vedReader = actor.permissions.has('ved.docs');
  const slim = (row: (typeof day.overdue)[number]) => {
    const binding = bindings.get(row.id);
    const calcOpen = binding?.kind === 'calc' && binding.open;
    return {
      id: row.id,
      title: row.title,
      // A timed deadline keeps its clock (round 28) — «Hisoblash, 30 daqiqa»
      // shown as a bare date reads as "sometime today".
      dueAt: row.dueAt ? formatDue(row.dueAt, row.allDay) : null,
      entityType: row.entityType,
      entityId: row.entityId,
      calc: calcOpen ? { href: `/hisoblash/${binding!.recordId}`, mayOpen: vedReader } : null,
    };
  };
  return NextResponse.json({
    overdue: day.overdue.map(slim),
    today: day.today.map(slim),
    undated: day.undated.map(slim),
    // The rows are capped per bucket; the BADGE is a count and must not be
    // the slice's length — `/bugun` and the home banner both read these.
    counts: day.counts,
  });
}
