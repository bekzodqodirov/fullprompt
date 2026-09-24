import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/panel';
import { myDay } from '@/modules/platform/tasks/service';
import {
  assignablePeople,
  endOfToday,
  taskTypeOptions,
  toTaskViews,
} from '@/modules/platform/tasks/view';
import { dayCalls } from '@/modules/wms/crm/day';
import { DayCallsView } from '@/components/day-calls-view';
import { NewTaskForm, TaskList } from '@/components/task-list';
import { tashkentDay } from '@/modules/platform/time/tashkent';

/**
 * "My day" — the screen a person opens in the morning.
 *
 * It merges two mechanisms without replacing either: TASKS, which somebody
 * assigns and somebody closes, and the CRM FOLLOW-UP, a reminder a sales
 * manager sets for themselves on a lead. The follow-up has worked since the CRM
 * shipped and the sales side lives on it; rewriting it into a task to make one
 * tidy list would have traded a working screen for a new one. So both appear,
 * labelled — and since the owner's item 4, `/crm/today` draws the call half
 * from the SAME module and the same component, because two screens with one
 * title that behave differently is what produced the complaint.
 *
 * The order is the order of urgency: late, then today, then the follow-ups,
 * then work with no deadline at all — which is last because it is the only
 * group that is never wrong to ignore.
 */
export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ hammasi?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const showOthers = (await searchParams).hammasi === '1';
  const t = await getTranslations('tasks');

  const [day, people, types] = await Promise.all([
    myDay(actor.id, endOfToday()),
    assignablePeople(),
    taskTypeOptions(),
  ]);

  /**
   * Only a sales manager has follow-ups; everyone else simply has none. The
   * list is MINE by default whatever the permission says — `crm.leads.view_all`
   * is the right to LOOK at everybody's, not an instruction to pile them onto
   * one person's morning (owner's 4.1a).
   */
  const calls = actor.permissions.has('crm.leads')
    ? await dayCalls({
        actorId: actor.id,
        seesAll: actor.permissions.has('crm.leads.view_all'),
        // Tashkent's day (R5): the call list is a `date` column the seller
        // wrote in the office's calendar. The TASK half below stays on its
        // own UTC all-day convention (round 47) until a data migration moves it.
        asOf: tashkentDay(),
        includeOthers: showOthers,
      })
    : null;

  const [overdue, today, undated] = await Promise.all([
    toTaskViews(day.overdue),
    toTaskViews(day.today),
    toTaskViews(day.undated),
  ]);

  const myCalls = (calls?.mine.length ?? 0) + (calls?.stale.length ?? 0);
  const nothing = overdue.length + today.length + undated.length + myCalls === 0;
  /**
   * The heading counts the REAL total and the list may be a slice of it — say
   * so when it is. A screen that shows forty of a hundred and eighty and
   * prints «40» is a screen somebody plans their day against.
   */
  const more = (shown: number, total: number) => (total > shown ? ` · +${total - shown}` : '');

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-3xl">
      <PageHeader icon="check" title={t('today')} />

      {nothing && (
        <div className="card text-center text-sm text-ink-500">
          <p className="text-2xl">🎉</p>
          <p>{t('allClear')}</p>
        </div>
      )}

      {overdue.length > 0 && (
        <section className="space-y-2" data-testid="day-overdue">
          <h2 className="section-title text-bad">
            🔴 {t('overdue')} · {day.counts.overdue}
            {more(overdue.length, day.counts.overdue)}
          </h2>
          <TaskList tasks={overdue} people={people} revalidate="/bugun" />
        </section>
      )}

      {today.length > 0 && (
        <section className="space-y-2" data-testid="day-today">
          <h2 className="section-title text-warn">
            🟡 {t('dueToday')} · {day.counts.today}
            {more(today.length, day.counts.today)}
          </h2>
          <TaskList tasks={today} people={people} revalidate="/bugun" />
        </section>
      )}

      {calls && (myCalls > 0 || calls.othersCount > 0) && (
        <DayCallsView calls={calls} basePath="/bugun" showOthers={showOthers} />
      )}

      {undated.length > 0 && (
        <section className="space-y-2" data-testid="day-undated">
          <h2 className="section-title">
            ⚪ {t('noDeadline')} · {day.counts.undated}
            {more(undated.length, day.counts.undated)}
          </h2>
          <TaskList tasks={undated} people={people} revalidate="/bugun" />
        </section>
      )}

      <Panel title={`➕ ${t('newTask')}`} testId="new-task-panel">
        <NewTaskForm
          people={people}
          types={types}
          revalidate="/bugun"
          defaultAssignee={actor.id}
        />
      </Panel>

      <Link href="/kalendar" className="btn-secondary block text-center">
        📅 {t('calendar')}
      </Link>
    </div>
  );
}
