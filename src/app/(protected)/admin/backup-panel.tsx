import { getTranslations } from 'next-intl/server';
import { backupStatus } from '@/modules/platform/backup/objects';
import { diskLines, formatBytes, type DiskLine } from '@/modules/platform/backup/disk';

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
  const tk = await getTranslations('kuzatuv');
  // The disk the backup lands on, read live (B9) — beside the question «did
  // it leave the machine», the question «is there room for tonight's». Its own
  // catch: a disk we could not read prints «noma'lum», never a missing panel.
  const [status, disks] = await Promise.all([
    backupStatus().catch(() => null),
    diskLines().catch((): DiskLine[] => []),
  ]);
  if (!status && disks.length === 0) return null;

  const mb = (bytes: number) =>
    bytes >= 1024 ** 3
      ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
      : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
  const when = (at: Date | null) =>
    at ? new Date(at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : null;

  return (
    <section className="card space-y-2" data-testid="backup-panel">
      <h2 className="section-title">{t('title')}</h2>
      {!status ? null : status.destination === null ? (
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
      {disks.length > 0 && (
        <dl className="space-y-1 border-t border-line pt-2 text-sm" data-testid="disk-lines">
          {disks.map((line) => (
            <div key={line.key} className="flex flex-wrap items-baseline justify-between gap-x-3">
              <dt className="text-ink-500">
                {tk(line.key === 'one' ? 'diskOne' : line.key === 'db' ? 'diskDb' : 'diskPhotos')}
              </dt>
              <dd
                className={`font-mono tabular-nums ${
                  line.reading && line.reading.usedPct >= 90
                    ? 'font-bold text-bad'
                    : line.reading && line.reading.usedPct >= 80
                      ? 'font-bold text-warn'
                      : ''
                }`}
              >
                {line.reading
                  ? tk('diskUsage', { pct: line.reading.usedPct, free: formatBytes(line.reading.freeBytes) })
                  : tk('diskUnknown')}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
