import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader } from '@/components/ui/page';
import {
  digestQuery,
  failedJobs,
  listSystemErrors,
  mayReadSystemErrors,
  recentErrorCount,
  type FailedJobRow,
  type SystemErrorRow,
} from '@/modules/platform/diagnostics/errors';

export const dynamic = 'force-dynamic';

/**
 * «Tizim xatolari» (B9) — the number in a staff screenshot, answered.
 *
 * The owner types the «#2832070603» he was sent; the page finds that row in
 * the retained month. Without a search it lists what the home row counted
 * (seen in the last 24 hours), with a second tab for the month. Below, the
 * background jobs that gave up in the last week — pg-boss's own record.
 *
 * A LIST, not a table: at 360 px a five-column table pushes the message —
 * the one thing worth reading — off the right edge. Every long token wraps
 * (`[overflow-wrap:anywhere]`, #570: a path or a message with no break
 * opportunity rescales the whole phone page, #400) and the stack scrolls
 * inside its own fold.
 *
 * The super admin's alone (`mayReadSystemErrors`): a message can carry a
 * client's phone («Key (phone)=…»), and the hub door asks the same role.
 */
export default async function SystemErrorsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; davr?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!mayReadSystemErrors(actor)) redirect('/');
  const t = await getTranslations('kuzatuv');
  const format = await getFormatter();
  const { q, davr } = await searchParams;
  const searching = typeof q === 'string' && q.trim() !== '';
  const month = davr === '30';

  const [rows, recent, jobs] = await Promise.all([
    searching
      ? listSystemErrors({ q })
      : listSystemErrors({ recent: !month, limit: 50 }),
    recentErrorCount(),
    failedJobs(7).catch((): FailedJobRow[] => []),
  ]);
  const needle = searching ? digestQuery(q) : null;

  const when = (at: Date) => format.dateTime(new Date(at), { dateStyle: 'short', timeStyle: 'short' });
  const tab = (active: boolean) =>
    `rounded px-2 py-0.5 font-semibold ${active ? 'bg-brand-600 text-white' : 'bg-surface-sunken'}`;

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl" data-testid="system-errors">
      <PageHeader icon="alert" title={t('errorsTitle')} subtitle={t('errorsSubtitle', { n: recent })} />

      <form action="/admin/xatolar" method="get" className="flex gap-2" role="search">
        <input
          name="q"
          defaultValue={q ?? ''}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchPlaceholder')}
          className="input min-w-0 flex-1 font-mono"
          data-testid="xatolar-q"
          inputMode="search"
          autoComplete="off"
        />
        <button type="submit" className="btn-primary shrink-0" data-testid="xatolar-search">
          {t('searchButton')}
        </button>
      </form>

      {!searching && (
        <div className="flex flex-wrap gap-1 text-sm">
          <Link href="/admin/xatolar" className={tab(!month)}>
            {t('tabRecent')}
          </Link>
          <Link href="/admin/xatolar?davr=30" className={tab(month)}>
            {t('tabMonth')}
          </Link>
        </div>
      )}

      {searching && needle === null && <p className="text-sm text-warn">{t('badQuery')}</p>}
      {rows.length === 0 ? (
        <p className="card text-sm text-ink-500" data-testid="xatolar-empty">
          {searching ? t('noMatch') : t('empty')}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <ErrorItem key={row.key} row={row} when={when} t={t} />
          ))}
        </ul>
      )}

      <section className="space-y-2">
        <h2 className="section-title">{t('jobsTitle')}</h2>
        {jobs.length === 0 ? (
          <p className="card text-sm text-ink-500">{t('jobsEmpty')}</p>
        ) : (
          <ul className="space-y-2" data-testid="xatolar-jobs">
            {jobs.map((job) => (
              <li key={job.name} className="card space-y-1 !p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-mono font-semibold [overflow-wrap:anywhere]">{job.name}</span>
                  <span className="text-ink-500">
                    {t('count', { n: job.count })} · {when(job.lastAt)}
                  </span>
                </div>
                {job.lastMessage && (
                  <p className="text-ink-700 [overflow-wrap:anywhere]">
                    <span className="text-ink-500">{t('jobLast')}: </span>
                    {job.lastMessage}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-xs text-ink-400">{t('clientSideNote')}</p>
    </div>
  );
}

function ErrorItem({
  row,
  when,
  t,
}: {
  row: SystemErrorRow;
  when: (at: Date) => string;
  t: Awaited<ReturnType<typeof getTranslations<'kuzatuv'>>>;
}) {
  return (
    <li className="card space-y-1.5 !p-3 text-sm" data-testid="xatolar-row" data-key={row.key}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-mono font-bold [overflow-wrap:anywhere]">#{row.key}</span>
        <span className="rounded bg-bad/15 px-2 py-0.5 text-xs font-semibold text-bad">
          {t('count', { n: row.count })}
        </span>
      </div>
      <p className="font-semibold text-ink-900 [overflow-wrap:anywhere]">{row.message}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-ink-500">{t('kindLabel')}</dt>
        <dd>{t(`kind.${row.kind as 'render'}`)}</dd>
        {row.path && (
          <>
            <dt className="text-ink-500">{t('path')}</dt>
            <dd className="font-mono [overflow-wrap:anywhere]">{row.path}</dd>
          </>
        )}
        <dt className="text-ink-500">{t('user')}</dt>
        <dd>{row.userName ?? '—'}</dd>
        <dt className="text-ink-500">{t('firstSeen')}</dt>
        <dd>{when(row.firstSeenAt)}</dd>
        <dt className="text-ink-500">{t('lastSeen')}</dt>
        <dd>{when(row.lastSeenAt)}</dd>
      </dl>
      {row.stack && (
        <details>
          <summary className="cursor-pointer text-xs font-semibold text-brand-700">{t('stack')}</summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded bg-surface-sunken p-2 text-2xs leading-snug">
            {row.stack}
          </pre>
        </details>
      )}
    </li>
  );
}
