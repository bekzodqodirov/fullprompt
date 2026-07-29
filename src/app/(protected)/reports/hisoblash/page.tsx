import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { BackLink } from '@/components/back-link';
import { PageHeader } from '@/components/ui/page';
import { formatDue } from '@/modules/platform/tasks/service';
import { calcReport, openCalcList } from '@/modules/wms/calc/service';

/**
 * The owner's question as a screen (round 28): «VED xodimlarim qanchada
 * hisoblab berayotganini bilishim kerak». Per VED person over a period —
 * how many calculations, how fast, how many inside their deadline — and
 * below it the queue that is waiting RIGHT NOW, red where it is already
 * late. Same shelf and same gate as the staff-activity report: this is
 * the boss reading the company, not a tool of the trade.
 */
export default async function CalcReportPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('reports.all_warehouses')) redirect('/reports');
  const t = await getTranslations('calc');
  const params = await searchParams;

  const days = [7, 30, 90].includes(Number(params.days)) ? Number(params.days) : 7;
  const now = new Date();
  const from = new Date(now.getTime() - days * 86_400_000);
  const [rows, queue] = await Promise.all([calcReport(from, now), openCalcList(now)]);

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <BackLink href="/reports" label={t('reports')} />
      <PageHeader icon="report" title={t('reportTitle')} />

      <div className="flex gap-2">
        {[7, 30, 90].map((n) => (
          <Link
            key={n}
            href={`/reports/hisoblash?days=${n}`}
            className={n === days ? 'btn-primary flex-1' : 'btn-secondary flex-1'}
          >
            {t('lastDays', { n })}
          </Link>
        ))}
      </div>

      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm" data-testid="calc-report">
            <thead>
              <tr className="border-b border-line-strong bg-surface-sunken text-left text-xs uppercase text-ink-500">
                <th className="p-2">{t('employee')}</th>
                <th className="p-2 text-right">{t('doneCol')}</th>
                <th className="p-2 text-right">{t('avgCol')}</th>
                <th className="p-2 text-right">{t('maxCol')}</th>
                <th className="p-2 text-right">{t('onTimeCol')}</th>
                <th className="p-2 text-right">{t('openCol')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.assigneeId} className="border-b border-line last:border-0">
                  <td className="p-2 font-semibold">{row.assigneeName}</td>
                  <td className="num p-2 text-right">{row.done || '—'}</td>
                  <td className="num p-2 text-right">
                    {row.avgMinutes === null ? '—' : t('minutes', { n: row.avgMinutes })}
                  </td>
                  <td className="num p-2 text-right">
                    {row.maxMinutes === null ? '—' : t('minutes', { n: row.maxMinutes })}
                  </td>
                  <td className="num p-2 text-right">
                    {row.done ? `${row.onTime}/${row.done}` : '—'}
                  </td>
                  <td className={`num p-2 text-right ${row.open > 0 ? 'font-bold' : ''}`}>
                    {row.open || '—'}
                    {row.oldestOpenMinutes !== null && (
                      <span className="ml-1 text-xs text-ink-500">
                        ({t('minutes', { n: row.oldestOpenMinutes })})
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <p className="p-4 text-sm text-ink-500">{t('noData')}</p>}
      </div>

      {queue.length > 0 && (
        <section className="space-y-1" data-testid="calc-queue">
          <h2 className="section-title">⏱ {t('queueTitle')} · {queue.length}</h2>
          {queue.map((row) => (
            <Link
              key={row.id}
              href={row.href}
              className={`card block !p-2.5 hover:bg-surface-sunken ${
                row.minutesLeft < 0 ? 'border-bad/40' : ''
              }`}
            >
              <div className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="num font-bold">{row.label}</span>
                <span className="text-xs text-ink-500">({row.itemCount})</span>
                <span className="min-w-0 flex-1 truncate">{row.assigneeName}</span>
                <span className="text-xs text-ink-500">{formatDue(row.requestedAt, false)}</span>
                <span
                  className={`num text-xs font-bold ${
                    row.minutesLeft < 0 ? 'text-bad' : 'text-ink-500'
                  }`}
                >
                  {row.minutesLeft < 0
                    ? t('lateBy', { n: -row.minutesLeft })
                    : t('leftMin', { n: row.minutesLeft })}
                </span>
              </div>
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
