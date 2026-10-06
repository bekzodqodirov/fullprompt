import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import {
  calcQueue,
  calcSpeed,
  recentlyClosed,
  type CalcEnding,
  type CalcQueueRow,
} from '@/modules/wms/calc/service';
import { calcCardHref, leadNameReadable } from '@/modules/wms/calc/card-door';
import { FIELD_LABELS, SECTION_LABELS } from '@/modules/wms/calc/labels';
import type { CalcField, CalcSection } from '@/modules/wms/calc/intake';
import { EmptyState, PageHeader } from '@/components/ui/page';
import { Icon } from '@/components/ui/icon';

/**
 * The VED queue (docs/VED.md, phase A).
 *
 * Deliberately NOT on the list engine: this is a handful of live rows, and
 * saved views, a column chooser and an XLSX door over ten jobs would be
 * furniture. Reversible — the engine is one screen away the day the queue is
 * long enough to need filtering.
 *
 * What a row may show is fenced by what the VIEWER could see anyway: the
 * facts of the consignment, who asked, and the card's name — a lead's too,
 * since the owner's 14a: every row here IS a calc card, and the VED opens it
 * through the calc card door (`leadNameReadable`, `calcCardHref` — the real
 * card for whoever it admits, the read-only karta otherwise, never a link the
 * destination bounces). No money: not a balance, not a quote, not a margin
 * (round 91's fence).
 */
export default async function CalcQueuePage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('ved.docs')) redirect('/');

  const t = await getTranslations('calc');
  const format = await getFormatter();
  const now = new Date();
  const [rows, speed, closed] = await Promise.all([
    calcQueue(now),
    calcSpeed(new Date(now.getTime() - 30 * 86_400_000)),
    recentlyClosed(20),
  ]);
  const mine = rows.filter((row) => row.assigneeId === actor.id).length;
  const names = leadNameReadable(actor);
  const cardHref = (row: CalcQueueRow) => calcCardHref(actor, { ...row, requestId: row.id });
  const endingLabel = (e: CalcEnding) =>
    e === 'sealed'
      ? t('endSealed')
      : e === 'answered'
        ? t('endAnswered')
        : e === 'returned'
          ? t('endReturned')
          : e === 'unpriced_lines'
            ? t('endUnpricedLines')
            : t('endUnpricedTask');

  return (
    <div className="space-y-4">
      <PageHeader
        icon="report"
        title={t('queueTitle')}
        subtitle={`${rows.length} · ${t('myQueue')}: ${mine}`}
        actions={
          <>
            <Link
              href="/hisoblash/narxlar"
              className="btn-secondary"
              data-testid="calc-history-link"
            >
              {t('historyTitle')}
            </Link>
            <Link href="/hisoblash/lugatlar" className="btn-secondary" data-testid="calc-dict-link">
              {t('dictTitle')}
            </Link>
            <Link href="/hisoblash/tarix" className="btn-secondary" data-testid="calc-registry-link">
              {t('registryTitle')}
            </Link>
            {/* Phase E1. Also linked from /hisoblash/narxlar, which is the
                only one of the three the ACCOUNTANT can open — this page
                redirects them out on `ved.docs`. */}
            <Link
              href="/hisoblash/nazorat"
              className="btn-secondary"
              data-testid="calc-control-link"
            >
              {t('controlTitle')}
            </Link>
          </>
        }
      />

      {rows.length === 0 ? (
        <EmptyState title={t('openNone')} />
      ) : (
        <ul className="space-y-2" data-testid="calc-queue">
          {rows.map((row) => (
            <li key={row.id} className="card !p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/hisoblash/${row.id}`}
                  data-testid="calc-queue-row"
                  className="font-semibold text-ink-900"
                >
                  {row.entityType === 'deal' || names ? row.label : t('title')}
                </Link>
                {row.section ? (
                  <span className="chip chip-brand">
                    {t(SECTION_LABELS[row.section as CalcSection] as 'sections.podklyuch')}
                  </span>
                ) : null}
                {row.late ? (
                  <span className="chip chip-warn" data-testid="calc-late">
                    {t('late')}
                  </span>
                ) : null}
                {row.assigneeId ? (
                  <span className="text-2xs text-ink-500">
                    {t('takenBy')}: {row.assigneeName ?? '—'}
                  </span>
                ) : (
                  <span className="chip chip-warn" data-testid="calc-unassigned">
                    {t('unassigned')}
                  </span>
                )}
              </div>

              <div className="mt-1 text-xs text-ink-600">
                {row.itemCount} {t('items')}
                {row.weightKg != null ? ` · ${row.weightKg} kg` : ''}
                {row.volumeM3 != null ? ` · ${row.volumeM3} m³` : ''}
                {row.fromCity || row.toCity
                  ? ` · ${row.fromCity ?? '—'} → ${row.toCity ?? '—'}`
                  : ''}
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-ink-500">
                <span>
                  {t('requester')}: {row.requesterName}
                </span>
                <span>
                  {t('dueBy')}: {format.dateTime(row.dueAt, { hour: '2-digit', minute: '2-digit' })}
                </span>
                {cardHref(row) ? (
                  <Link href={cardHref(row)!} className="text-brand-700" data-testid="calc-queue-card">
                    {t('openCard')}
                  </Link>
                ) : null}
              </div>

              {row.missing.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1" data-testid="calc-missing">
                  <span className="text-2xs text-warn">⚠ {t('missingLabel')}:</span>
                  {row.missing.map((field) => (
                    <span key={field} className="chip chip-warn">
                      {t(FIELD_LABELS[field as CalcField] as 'fields.goods')}
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/* «Oxirgi yakunlanganlar» (10a's door back in): every ending, who and
          when — a job answered with Готово used to have no way back at all. */}
      {closed.length > 0 ? (
        <details className="card !p-3" data-testid="calc-recent-closed">
          <summary className="cursor-pointer text-sm font-semibold">
            {t('recentClosedTitle')} · {closed.length}
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {closed.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2" data-testid="calc-recent-row">
                <Link href={`/hisoblash/${row.id}`} className="font-semibold text-ink-900" data-testid="calc-recent-link">
                  {row.entityType === 'deal' || names ? row.label : t('title')}
                </Link>
                <span className="chip chip-neutral" data-ending={row.ending}>
                  {endingLabel(row.ending)}
                </span>
                <span className="text-2xs text-ink-500">
                  {row.completedByName ?? '—'} · {format.dateTime(row.completedAt, { dateStyle: 'short', timeStyle: 'short' })}
                </span>
                {calcCardHref(actor, { ...row, requestId: row.id }) ? (
                  <Link href={calcCardHref(actor, { ...row, requestId: row.id })!} className="text-2xs text-brand-700">
                    {t('openCard')}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* The owner's «qanchada hisoblab berayotganini bilishim kerak», as three
          numbers per person: answered, average minutes, on time. Returns are
          excluded by the query — handing a job back takes ninety seconds. */}
      {speed.length > 0 ? (
        <section className="card !p-3">
          <h2 className="section-title flex items-center gap-2">
            <Icon name="report" className="h-4 w-4" />
            {t('speedTitle')}
          </h2>
          <ul className="mt-2 space-y-1 text-xs" data-testid="calc-speed">
            {speed.map((row) => (
              <li key={row.assigneeId ?? 'none'} className="flex flex-wrap gap-2">
                <span className="font-semibold">{row.assigneeName}</span>
                <span className="num">
                  {row.done} {t('doneCol')}
                </span>
                {row.avgMinutes != null ? (
                  <span className="num">{t('minutes', { n: row.avgMinutes })}</span>
                ) : null}
                <span className="num">
                  {row.onTime} {t('onTimeShort')}
                </span>
                <span className="num text-ink-500">
                  {row.open} {t('openCol')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
