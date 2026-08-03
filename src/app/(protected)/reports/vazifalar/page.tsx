import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { taskAnalytics } from '@/modules/platform/tasks/analytics';
import { aboutHref } from '@/modules/platform/tasks/view';
import { BackLink } from '@/components/back-link';
import { PageHeader } from '@/components/ui/page';

/**
 * «Ishlar qanday ketyapti» — the day, across everybody (round 47, item 12).
 *
 * Read top-down as a question and its answer: is today closing more than it
 * opened, who is buried, and which specific late task should be picked up
 * first. Every number is a link or a name, because a workload screen that
 * only counts is a screen somebody reads once.
 *
 * Gated `reports.all_warehouses`: this shows every person's work, and that is
 * a management view, not a personal one. `/bugun` is the personal one.
 */
export default async function TaskAnalyticsPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('reports.all_warehouses')) redirect('/');
  const t = await getTranslations('tasks');
  const tc = await getTranslations('common');
  const tr = await getTranslations('reports');
  const format = await getFormatter();

  // UTC days, the same ones `/bugun` measures «overdue» against — see the
  // note in analytics.ts for why this screen must not invent its own.
  const { pulse, people, stale, undated, trend } = await taskAnalytics(new Date());
  const peak = Math.max(1, ...trend.map((day) => Math.max(day.created, day.done)));

  return (
    <div className="space-y-4">
      <BackLink href="/reports" label={tr('title')} />
      <PageHeader icon="chart" title={tr('taskAnalytics')} />

      {/* The day in one line. Late is red because late is the only one of
          these that is a problem rather than a fact. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="task-pulse">
        {[
          { key: 'overdue', value: pulse.overdue, bad: pulse.overdue > 0, label: t('overdue') },
          { key: 'dueToday', value: pulse.dueToday, bad: false, label: t('dueToday') },
          { key: 'doneToday', value: pulse.doneToday, bad: false, label: tr('taskDoneToday') },
          { key: 'open', value: pulse.open, bad: false, label: tr('taskOpen') },
        ].map((cell) => (
          <div
            key={cell.key}
            data-testid={`pulse-${cell.key}`}
            className={`card !p-3 ${cell.bad ? 'border-bad/30 bg-bad/10' : ''}`}
          >
            <p className={`text-2xl font-extrabold ${cell.bad ? 'text-bad' : ''}`}>{cell.value}</p>
            <p className="text-xs text-ink-500">{cell.label}</p>
          </div>
        ))}
      </div>

      {/* Growing or shrinking. Two bars a day: what was opened, what was
          closed. Drawn with plain divs — a charting library for 28 numbers
          would be more bytes on the wire than the whole page. */}
      <section className="card space-y-2">
        <h2 className="text-sm font-bold">{tr('taskTrend')}</h2>
        <div className="flex items-end gap-1" data-testid="task-trend">
          {trend.map((day) => (
            <div key={day.day} className="flex flex-1 flex-col items-center gap-0.5">
              <div className="flex h-20 w-full items-end justify-center gap-0.5">
                <div
                  title={`${day.day} · +${day.created}`}
                  className="w-1.5 rounded-t bg-warn/70"
                  style={{ height: `${(day.created / peak) * 100}%` }}
                />
                <div
                  title={`${day.day} · ✓${day.done}`}
                  className="w-1.5 rounded-t bg-good/70"
                  style={{ height: `${(day.done / peak) * 100}%` }}
                />
              </div>
              <span className="text-[10px] text-ink-400">{day.day.slice(8)}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-ink-500">
          <span className="text-warn">▮</span> {tr('taskOpened')} ·{' '}
          <span className="text-good">▮</span> {tr('taskClosed')}
        </p>
      </section>

      {/* Who is carrying what. Late first — that is the order somebody acts in. */}
      <section className="card space-y-2">
        <h2 className="text-sm font-bold">{tr('taskByPerson')}</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-sm">
            <thead>
              <tr className="border-b border-line-strong text-left text-xs text-ink-500">
                <th className="whitespace-nowrap p-2">{tr('taskPerson')}</th>
                <th className="whitespace-nowrap p-2 text-right">{t('overdue')}</th>
                <th className="whitespace-nowrap p-2 text-right">{t('dueToday')}</th>
                <th className="p-2 text-right">{tr('taskOpen')}</th>
                <th className="p-2 text-right">{tr('taskDoneWeek')}</th>
                <th className="p-2 text-right">{tr('taskMedian')}</th>
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <tr
                  key={person.userId}
                  data-testid="task-person-row"
                  className="border-b border-line last:border-0"
                >
                  <td className="whitespace-nowrap p-2 font-semibold">{person.fullName}</td>
                  <td
                    className={`p-2 text-right font-bold ${person.overdue > 0 ? 'text-bad' : 'text-ink-400'}`}
                  >
                    {person.overdue || '—'}
                  </td>
                  <td className="p-2 text-right">{person.dueToday || '—'}</td>
                  <td className="p-2 text-right font-semibold">{person.open}</td>
                  <td className="p-2 text-right text-good">{person.doneWeek || '—'}</td>
                  <td className="p-2 text-right text-ink-500">
                    {person.medianHours === null ? '—' : `${person.medianHours} ${tr('taskHours')}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {people.length === 0 && <p className="text-sm text-ink-500">{tc('empty')}</p>}
        {undated > 0 && (
          <p className="text-xs text-ink-500" data-testid="task-undated">
            {tr('taskUndated', { n: undated })}
          </p>
        )}
      </section>

      {/* The specific ones. A count starts a conversation; a name ends it. */}
      {stale.length > 0 && (
        <section className="card space-y-1">
          <h2 className="text-sm font-bold">{tr('taskStalest')}</h2>
          {stale.map((task) => {
            const href = aboutHref(task.entityType, task.entityId);
            const row = (
              <>
                <span className="min-w-0 flex-1 truncate">{task.title}</span>
                <span className="whitespace-nowrap text-xs text-ink-500">{task.assigneeName}</span>
                <span className="whitespace-nowrap text-xs font-bold text-bad">
                  {tr('taskLateDays', { n: task.lateDays })}
                </span>
              </>
            );
            return (
              <div
                key={task.id}
                data-testid="task-stale-row"
                className="flex items-baseline gap-2 border-b border-line py-1.5 text-sm last:border-0"
              >
                {href ? (
                  <Link href={href} className="flex min-w-0 flex-1 items-baseline gap-2">
                    {row}
                  </Link>
                ) : (
                  row
                )}
              </div>
            );
          })}
          <p className="pt-1 text-xs text-ink-400">
            {format.dateTime(new Date(), { dateStyle: 'short', timeStyle: 'short' })}
          </p>
        </section>
      )}
    </div>
  );
}
