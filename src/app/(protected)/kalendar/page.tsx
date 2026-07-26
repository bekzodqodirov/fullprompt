import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader } from '@/components/ui/page';
import { calendarTasks } from '@/modules/platform/tasks/service';
import { assignablePeople, toTaskViews } from '@/modules/platform/tasks/view';
import { TaskList } from '@/components/task-list';

/**
 * The month, as a grid of days with what is due on each.
 *
 * Server-rendered rather than a JavaScript calendar: a month is 42 cells and
 * the data for all of them is one query, so shipping a date library to a phone
 * in a Chinese warehouse to draw a table would be paying for nothing. Moving
 * between months is a link, which also means a month can be bookmarked and
 * sent to somebody.
 *
 * A day cell shows at most three tasks and then a count — a busy Tuesday must
 * not push the rest of the month off the screen. Tapping a day lists it in
 * full underneath.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string; who?: string; day?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('tasks');
  const params = await searchParams;

  // Everyone sees their own month; the owner and anyone who may read the whole
  // funnel can look at a colleague's, or at everybody at once.
  const canSeeAll =
    actor.permissions.has('crm.leads.view_all') || actor.permissions.has('reports.all_warehouses');
  const who = canSeeAll ? (params.who ?? actor.id) : actor.id;
  const assignee = who === 'all' ? undefined : who;

  const month = /^\d{4}-\d{2}$/.test(params.m ?? '')
    ? params.m!
    : new Date().toISOString().slice(0, 7);
  const [year, mon] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year!, mon! - 1, 1));
  const last = new Date(Date.UTC(year!, mon!, 0));

  const rows = await calendarTasks(first, last, assignee);
  const tasks = await toTaskViews(rows);
  const people = await assignablePeople();

  const byDay = new Map<string, typeof tasks>();
  for (const task of tasks) {
    if (!task.dueAt) continue;
    const key = task.dueAt.slice(0, 10);
    byDay.set(key, [...(byDay.get(key) ?? []), task]);
  }

  // Monday-first, which is how the week is counted here.
  const lead = (first.getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: last.getUTCDate() }, (_, index) =>
      new Date(Date.UTC(year!, mon! - 1, index + 1)).toISOString().slice(0, 10),
    ),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const shift = (delta: number) => {
    const moved = new Date(Date.UTC(year!, mon! - 1 + delta, 1));
    return `?m=${moved.toISOString().slice(0, 7)}${who !== actor.id ? `&who=${who}` : ''}`;
  };
  const today = new Date().toISOString().slice(0, 10);
  const selected = params.day && byDay.has(params.day) ? params.day : null;
  const weekdays = ['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'];

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-3xl">
      <PageHeader icon="calendar" title={t('calendar')} />

      <div className="flex flex-wrap items-center gap-2">
        <Link href={shift(-1)} className="btn-secondary !min-h-9 px-3" data-testid="prev-month">
          ‹
        </Link>
        <span className="num font-bold" data-testid="calendar-month">
          {month}
        </span>
        <Link href={shift(1)} className="btn-secondary !min-h-9 px-3" data-testid="next-month">
          ›
        </Link>
        {canSeeAll && (
          <form method="get" className="ml-auto flex gap-2">
            <input type="hidden" name="m" value={month} />
            <select name="who" defaultValue={who} className="input !min-h-9 !w-44">
              <option value="all">{t('everyone')}</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
            <button type="submit" className="btn-secondary !min-h-9 px-3">
              🔍
            </button>
          </form>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-xs" data-testid="calendar-grid">
          <thead>
            <tr className="text-ink-500">
              {weekdays.map((day) => (
                <th key={day} className="p-1 font-semibold">
                  {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: cells.length / 7 }, (_, week) => (
              <tr key={week}>
                {cells.slice(week * 7, week * 7 + 7).map((date, index) => {
                  const items = date ? (byDay.get(date) ?? []) : [];
                  const late = items.some(
                    (task) => task.status === 'open' && date! < today,
                  );
                  return (
                    <td
                      key={date ?? `empty-${index}`}
                      className={`h-20 border border-line align-top ${
                        date === today ? 'bg-brand-50' : ''
                      }`}
                    >
                      {date && (
                        <Link
                          href={`?m=${month}&day=${date}${who !== actor.id ? `&who=${who}` : ''}`}
                          className="block h-full p-1"
                        >
                          <span
                            className={`num ${date === today ? 'font-extrabold text-brand-700' : 'text-ink-500'}`}
                          >
                            {Number(date.slice(8))}
                          </span>
                          {items.slice(0, 3).map((task) => (
                            <span
                              key={task.id}
                              className={`mt-0.5 block truncate rounded px-0.5 ${
                                task.status !== 'open'
                                  ? 'text-ink-400 line-through'
                                  : late
                                    ? 'bg-bad/10 text-bad'
                                    : 'bg-surface-sunken'
                              }`}
                            >
                              {task.typeIcon ?? '•'} {task.title}
                            </span>
                          ))}
                          {items.length > 3 && (
                            <span className="block text-ink-500">+{items.length - 3}</span>
                          )}
                        </Link>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <section className="space-y-2" data-testid="calendar-day">
          <h2 className="section-title">{selected}</h2>
          <TaskList
            tasks={byDay.get(selected)!}
            people={people}
            revalidate={`/kalendar?m=${month}`}
          />
        </section>
      )}

      {tasks.length === 0 && <p className="text-sm text-ink-500">{t('noneThisMonth')}</p>}

      <Link href="/bugun" className="btn-secondary block text-center">
        ✅ {t('today')}
      </Link>
    </div>
  );
}
