import { getTranslations } from 'next-intl/server';
import { backupStatus } from '@/modules/platform/backup/objects';

/**
 * Is the business actually being copied off this machine?
 *
 * The one subsystem whose failure is invisible from every screen: the app
 * keeps working perfectly while nothing has left the server for a month, and
 * the day anybody finds out is the day they need it. «Check the logs» is not
 * a monitoring strategy for an owner who is not a developer, so the answer
 * goes where he already looks.
 *
 * Deliberately three facts and no chart: when the database last went out,
 * how many files have gone, and how many are still waiting. The last number
 * is the one that says whether the backlog is draining.
 */
export async function BackupPanel() {
  const t = await getTranslations('backup');
  const status = await backupStatus().catch(() => null);
  if (!status) return null;

  const mb = (bytes: number) =>
    bytes >= 1024 ** 3
      ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
      : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
  const when = (at: Date | null) =>
    at ? new Date(at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : null;

  return (
    <section className="card space-y-2" data-testid="backup-panel">
      <h2 className="section-title">{t('title')}</h2>
      {status.destination === null ? (
        <p className="text-sm text-bad">{t('notConfigured')}</p>
      ) : (
        <dl className="space-y-1 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <dt className="text-ink-500">{t('database')}</dt>
            <dd className="font-mono tabular-nums" data-testid="backup-db">
              {status.lastDump
                ? `${when(status.lastDump.at)} · ${mb(status.lastDump.bytes)}`
                : t('never')}
            </dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <dt className="text-ink-500">{t('files')}</dt>
            <dd className="font-mono tabular-nums" data-testid="backup-files">
              {t('copied', { n: status.objects.copied })}
              {status.objects.remaining > 0 && (
                <span className="ml-2 text-warn">
                  {t('remaining', { n: status.objects.remaining })}
                </span>
              )}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
