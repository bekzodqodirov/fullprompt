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
import { followUps } from '@/modules/wms/crm/service';
import { NewTaskForm, TaskList } from '@/components/task-list';

/**
 * "My day" — the screen a person opens in the morning.
 *
 * It merges two mechanisms without replacing either: TASKS, which somebody
 * assigns and somebody closes, and the CRM FOLLOW-UP, a reminder a sales
 * manager sets for themselves on a lead. The follow-up has worked since the CRM
 * shipped and the sales side lives on it; rewriting it into a task to make one
 * tidy list would have traded a working screen for a new one. So both appear,
 * labelled, and `/crm/today` keeps answering exactly as before.
 *
 * The order is the order of urgency: late, then today, then the follow-ups,
 * then work with no deadline at all — which is last because it is the only
 * group that is never wrong to ignore.
 */
export default async function TodayPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('tasks');
  const tcrm = await getTranslations('crm');

  const [day, people, types] = await Promise.all([
    myDay(actor.id, endOfToday()),
    assignablePeople(),
    taskTypeOptions(),
  ]);

  // Only a sales manager has follow-ups; everyone else simply has none.
  const follows = actor.permissions.has('crm.leads')
    ? await followUps(
        new Date().toISOString().slice(0, 10),
        actor.permissions.has('crm.leads.view_all') ? undefined : actor.id,
      )
    : [];

  const [overdue, today, undated] = await Promise.all([
    toTaskViews(day.overdue),
    toTaskViews(day.today),
    toTaskViews(day.undated),
  ]);

  const nothing =
    overdue.length + today.length + undated.length + follows.length === 0;

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
          <h2 className="section-title text-bad">🔴 {t('overdue')} · {overdue.length}</h2>
          <TaskList tasks={overdue} people={people} revalidate="/bugun" />
        </section>
      )}

      {today.length > 0 && (
        <section className="space-y-2" data-testid="day-today">
          <h2 className="section-title text-warn">🟡 {t('dueToday')} · {today.length}</h2>
          <TaskList tasks={today} people={people} revalidate="/bugun" />
        </section>
      )}

      {follows.length > 0 && (
        <section className="space-y-2" data-testid="day-followups">
          <h2 className="section-title">📞 {tcrm('today')} · {follows.length}</h2>
          {follows.map((row) => (
            <Link
              key={`${row.kind}-${row.id}`}
              href={row.kind === 'lead' ? `/crm/leads/${row.id}` : `/admin/clients/${row.id}`}
              className="card block !p-3 hover:bg-surface-sunken"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="min-w-0 flex-1 font-semibold">{row.title}</span>
                <span className="num text-xs text-ink-500">{row.dueOn}</span>
              </div>
              {row.note && <p className="text-sm text-ink-700">{row.note}</p>}
            </Link>
          ))}
        </section>
      )}

      {undated.length > 0 && (
        <section className="space-y-2" data-testid="day-undated">
          <h2 className="section-title">⚪ {t('noDeadline')} · {undated.length}</h2>
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
