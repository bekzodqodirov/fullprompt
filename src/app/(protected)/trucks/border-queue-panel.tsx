import { getFormatter, getTranslations } from 'next-intl/server';
import type { Actor } from '@/modules/platform/rbac/authorize';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { borderQueueRows, mayEditBorderQueue } from '@/modules/wms/tracking/border-queue';
import { BorderQueueForm } from './border-queue-form';

/** Hours as the days a person types — «3,5», never «3.4999». */
const asDays = (hours: number) => Number((hours / 24).toFixed(2));

/**
 * «Chegara navbatlari» on /trucks (owner, 2026-09-29, answer 14): the two
 * queues of the Horgos road as the logist typed them, and what they mean.
 *
 * Everybody the page admits READS it (the page's own door, `mayReadBatches`)
 * — the VED plans papers around the same wait. The edit fold is drawn only
 * for whoever the service obeys (`mayEditBorderQueue`), because a fold that
 * answers «forbidden» to its own reader is a lie about the button.
 *
 * What the number means is printed ONCE, beside it, and not left to a
 * tooltip: a truck already queueing is counted from the moment the number is
 * typed, a truck that has crossed is not moved — and that is a rule a person
 * types against, so it must be in front of them.
 */
export async function BorderQueuePanel({ actor }: { actor: Actor }) {
  const t = await getTranslations('trucks.queue');
  const format = await getFormatter();
  const { behind, rows } = await borderQueueRows(tashkentDay());
  const editable = mayEditBorderQueue(actor) && !behind;
  const days = (hours: number) => format.number(asDays(hours), { maximumFractionDigits: 2 });
  const POST = { khorgos: t('post.khorgos'), yallama: t('post.yallama') } as const;

  return (
    <section className="card space-y-3" data-testid="border-queue">
      <h2 className="section-title">🚧 {t('title')}</h2>
      {behind && <p className="text-sm text-warn">{t('errors.server_behind')}</p>}
      <ul className="space-y-3">
        {rows.map((row) => (
          <li key={row.post} className="space-y-1" data-testid={`queue-${row.post}`}>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold">{POST[row.post]}</span>
              {row.typed ? (
                <span className="font-mono font-bold text-brand-700" data-testid={`queue-value-${row.post}`}>
                  {t('current', { min: days(row.typed.minHours), max: days(row.typed.maxHours) })}
                </span>
              ) : (
                <span className="text-sm text-ink-500" data-testid={`queue-value-${row.post}`}>
                  {t('usual', { min: days(row.usualHours[0]), max: days(row.usualHours[1]) })}
                </span>
              )}
            </div>
            {row.typed && (
              <p className="text-xs text-ink-500" data-testid={`queue-by-${row.post}`}>
                {t('typedBy', {
                  name: row.typed.byName ?? '—',
                  when: format.dateTime(row.typed.at, { dateStyle: 'short', timeStyle: 'short' }),
                })}
                {row.typed.note && ` · ${row.typed.note}`}
              </p>
            )}
            {row.typed?.warn && (
              <p className="text-xs font-semibold text-warn" data-testid={`queue-warn-${row.post}`}>
                {t('warn', { n: row.typed.ageDays })}
              </p>
            )}
            {editable && (
              <details className="rounded-lg border border-line p-2" data-testid={`queue-edit-${row.post}`}>
                <summary className="cursor-pointer text-sm font-semibold text-brand-700">✏️ {t('edit')}</summary>
                <div className="pt-2">
                  <BorderQueueForm
                    post={row.post}
                    seenAt={row.seenAt}
                    minDays={row.typed ? String(asDays(row.typed.minHours)) : ''}
                    maxDays={row.typed ? String(asDays(row.typed.maxHours)) : ''}
                    note={row.typed?.note ?? ''}
                  />
                </div>
              </details>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-ink-500" data-testid="queue-meaning">
        {t('meaning')}
      </p>
    </section>
  );
}
