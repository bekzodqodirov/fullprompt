import { NextResponse } from 'next/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { logger } from '@/modules/platform/logger';
import { bindingsOf, formatDue, myDay, type TaskBinding } from '@/modules/platform/tasks/service';
import { endOfToday, readerTaskLinks } from '@/modules/platform/tasks/view';

/**
 * The dock's task list — the same `myDay` the home banner and /bugun read,
 * slimmed to what a side panel can show. A route rather than a server
 * component because the dock opens on top of WHATEVER page is already
 * rendered, and must not cost anything until it does.
 *
 * A task bound to an OPEN calc job carries `calc` (VED-TARIX §8), and every
 * row its title's `aboutHref` — the task list's own rule (`readerTaskLinks`),
 * so the two lists cannot drift: no ✓ for anybody, «🧮» to the job's screen
 * for a `ved.docs` reader as both the action and the title, a read-only chip
 * and the card link for everyone else (review access-3).
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
  const slim = (row: (typeof day.overdue)[number]) => ({
    id: row.id,
    title: row.title,
    // A timed deadline keeps its clock (round 28) — «Hisoblash, 30 daqiqa»
    // shown as a bare date reads as "sometime today".
    dueAt: row.dueAt ? formatDue(row.dueAt, row.allDay) : null,
    ...readerTaskLinks(row, bindings.get(row.id), actor),
  });
  return NextResponse.json({
    overdue: day.overdue.map(slim),
    today: day.today.map(slim),
    undated: day.undated.map(slim),
    // The rows are capped per bucket; the BADGE is a count and must not be
    // the slice's length — `/bugun` and the home banner both read these.
    counts: day.counts,
  });
}
