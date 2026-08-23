import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { getSetting } from '@/modules/platform/settings/service';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { calcControlScopeFor } from '@/modules/wms/calc/control-scope';
import {
  calcActuals,
  calcCoverage,
  linkSuggestions,
  warnedGroups,
  type CalcActualRow,
} from '@/modules/wms/calc/actuals';
import { REFUSAL_LABELS, SECTION_LABELS, WARNING_LABELS } from '@/modules/wms/calc/labels';
import { PageHeader } from '@/components/ui/page';
import { CalcLinkRow } from '@/components/calc-link-row';

/**
 * «Hisob va haqiqat» — the owner's phase E question, on one screen.
 *
 * THREE THINGS THAT DECIDE HOW THIS READS, all of them said out loud on the
 * screen rather than hidden in the arithmetic:
 *
 * 1. **Customs only.** The road is our own price list and what a truck costs
 *    is a different number; the gap between them is profit, not a VED's
 *    mistake. Comparing them would flag every correct calculation for ever.
 * 2. **Two clocks.** Coverage and the warnings run on SEALED-AT; the accuracy
 *    table runs on ARRIVED-AT plus a settle window, because the road is a
 *    ten-day floor and one clock would leave the table empty until the 18th
 *    of every month.
 * 3. **Coverage first.** With nothing linked, every number below is about
 *    nothing — and a screen that hides that reads «we have no errors» when it
 *    means «we have no data».
 *
 * Reached from `/hisoblash/narxlar` (which the accountant can open) and from
 * `/hisoblash`'s header (which the VED can), with no nav entry: the accountant
 * is redirected out of `/hisoblash` itself, so a link from there alone would
 * hide the screen from half its audience.
 */
export default async function CalcControlPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const scope = calcControlScopeFor(actor);
  if (scope === 'none') redirect('/');

  const t = await getTranslations('calc');
  const format = await getFormatter();

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const who = { scope, actorId: actor.id } as const;

  let coverage = { sealed: 0, linked: 0, suggested: 0 };
  let queue: Awaited<ReturnType<typeof linkSuggestions>> = [];
  let warned: Awaited<ReturnType<typeof warnedGroups>> = [];
  let rows: CalcActualRow[] = [];
  let settleDays = 7;
  try {
    [coverage, queue, warned, rows, settleDays] = await Promise.all([
      calcCoverage(who, monthStart),
      linkSuggestions(who),
      warnedGroups(who, monthStart),
      calcActuals(who),
      getSetting('calc_actual_settle_days').then((v) => Number(v ?? 7)),
    ]);
  } catch (err) {
    // 0089 is this release's migration; the machine whose schema is behind is
    // production on deploy morning (#472).
    if (!isServerBehind(err)) throw err;
    logger.error({ err }, '[calc-control] server behind');
  }

  // Only settled cargo is scored. Everything else is a wait, not a number.
  const settled = rows.filter((r) => r.settled);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        icon="report"
        title={t('controlTitle')}
        back={{ href: '/hisoblash/narxlar', label: t('historyTitle') }}
      />
      <p className="text-2xs text-ink-500">{t('controlHint')}</p>

      {/* 1 — COVERAGE. First, because it is the honest headline. */}
      <section className="card !p-3" data-testid="control-coverage">
        <h2 className="section-title">
          {t('coverage')} <span className="text-2xs font-normal text-ink-500">· {t('clockSealed')}</span>
        </h2>
        {coverage.sealed === 0 ? (
          <p className="text-sm text-ink-500" data-testid="coverage-empty">{t('coverageEmpty')}</p>
        ) : (
          <p className="font-mono text-sm tabular-nums" data-testid="coverage-line">
            {t('coverageLine', { sealed: coverage.sealed, linked: coverage.linked })}
          </p>
        )}
      </section>

      {/* 2 — THE QUEUE. Nothing below can say anything until this is worked. */}
      <section className="space-y-2" data-testid="control-queue">
        <h2 className="section-title">{t('linkQueue')}</h2>
        <p className="text-2xs text-ink-500">{t('linkQueueHint')}</p>
        {queue.length === 0 ? (
          <p className="text-sm text-ink-500" data-testid="link-none">{t('linkNone')}</p>
        ) : (
          <ul className="space-y-2">
            {queue.map((row) => (
              <CalcLinkRow key={row.receiptId} receiptId={row.receiptId}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-sm font-semibold">{row.receiptNumber ?? '—'}</span>
                  {row.clientCode ? (
                    <span className="chip">{row.clientCode}</span>
                  ) : null}
                  <span className="chip chip-brand">
                    {t(SECTION_LABELS[row.section] as 'sections.podklyuch')}
                  </span>
                  {row.confirmedAt ? (
                    <span className="text-2xs text-ink-500">
                      {format.dateTime(row.confirmedAt, { dateStyle: 'short' })}
                    </span>
                  ) : null}
                </div>
                {/* The two pairs of numbers ARE the question. */}
                <p className="text-2xs text-ink-600">
                  {t('quoted')}: {measure(row.quotedVolumeM3, row.quotedWeightKg)} ·{' '}
                  {t('measured')}: {measure(row.actualVolumeM3, row.actualWeightKg)}
                </p>
              </CalcLinkRow>
            ))}
          </ul>
        )}
      </section>

      {/* 3 — CONFIRMED OVER A WARNING. The owner's «ko'rmasdan tasdiqlagan». */}
      <section className="space-y-2" data-testid="control-warned">
        <h2 className="section-title">
          {t('attention')}{' '}
          <span className="text-2xs font-normal text-ink-500">· {t('clockSealed')}</span>
        </h2>
        {warned.length === 0 ? (
          <p className="text-sm text-ink-500" data-testid="warned-none">{t('attentionEmpty')}</p>
        ) : (
          <ul className="space-y-2">
            {warned.map((row, i) => (
              <li key={`${row.requestId}-${i}`} className="card !p-3" data-testid="warned-row">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-semibold">{row.groupLabel}</span>
                  {row.tnvedCode ? (
                    <span className="font-mono text-2xs">{row.tnvedCode}</span>
                  ) : null}
                  <span className="text-2xs text-ink-500">
                    {row.sealedByName ?? '—'} ·{' '}
                    {format.dateTime(row.sealedAt, { dateStyle: 'short' })}
                  </span>
                  {row.confirmVia === 'bulk' ? (
                    <span className="chip chip-warn">{t('confirmedBulk')}</span>
                  ) : null}
                </div>
                <p className="mt-1 flex flex-wrap gap-1">
                  {row.warnings.map((kind) => (
                    <span key={kind} className="chip chip-warn" data-testid="warned-kind">
                      {WARNING_LABELS[kind]
                        ? t(WARNING_LABELS[kind] as 'warnings.aiRateTaken')
                        : kind}
                    </span>
                  ))}
                </p>
                {/* The VED's own answer, written on the group since 0086 and
                    rendered nowhere until now. */}
                {row.note ? (
                  <p className="text-2xs text-ink-600" data-testid="warned-note">
                    {t('groupNote')}: {row.note}
                  </p>
                ) : null}
                <p className="mt-1 flex flex-wrap gap-3 text-2xs">
                  <Link className="text-brand-700" href={`/hisoblash/${row.requestId}`}>
                    {t('openCard')} →
                  </Link>
                  {/* The list is meant to empty by being WORKED. */}
                  {row.tnvedCode ? (
                    <Link
                      className="text-brand-700"
                      href={`/hisoblash/lugatlar?kod=${encodeURIComponent(row.tnvedCode)}`}
                      data-testid="warned-dict"
                    >
                      {t('addToDictionary')} →
                    </Link>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 4 — THE ARITHMETIC, on the settled clock. */}
      <section className="space-y-2" data-testid="control-accuracy">
        <h2 className="section-title">
          {t('accuracy')}{' '}
          <span className="text-2xs font-normal text-ink-500">· {t('clockSettled')}</span>
        </h2>
        <p className="text-2xs text-ink-500">{t('accuracyHint', { days: settleDays })}</p>
        {settled.length === 0 ? (
          <p className="text-sm text-ink-500" data-testid="accuracy-empty">{t('accuracyEmpty')}</p>
        ) : (
          <ul className="space-y-2">
            {settled.map((row) => (
              <li key={row.versionId} className="card !p-3" data-testid="accuracy-row">
                <div className="flex flex-wrap items-baseline gap-2">
                  {row.clientCode ? <span className="chip">{row.clientCode}</span> : null}
                  <span className="chip chip-brand">
                    {t(SECTION_LABELS[row.section] as 'sections.podklyuch')}
                  </span>
                  <span className="text-2xs text-ink-500">
                    {row.sealedByName ?? '—'} ·{' '}
                    {format.dateTime(row.sealedAt, { dateStyle: 'short' })}
                  </span>
                </div>

                {/* ⚠ and the reason, never a $0 — phase B's own rule. */}
                {row.refusal ? (
                  <p className="text-2xs text-warn" data-testid="accuracy-refusal">
                    ⚠ {t('notComparable')}:{' '}
                    {REFUSAL_LABELS[row.refusal]
                      ? t(REFUSAL_LABELS[row.refusal] as 'refusal.notLinked')
                      : row.refusal}
                    {row.foundCostTypes.length > 0
                      ? ` · ${t('foundTypes')}: ${row.foundCostTypes.join(', ')}`
                      : ''}
                  </p>
                ) : (
                  <p className="font-mono text-sm tabular-nums" data-testid="accuracy-money">
                    {t('quoted')}: ${row.quotedCustomsUsd.toFixed(2)} · {t('measured')}: $
                    {(row.actualCustomsUsd ?? 0).toFixed(2)}
                    {row.customsPct !== null ? (
                      <span className={row.customsPct > 0 ? ' text-bad' : ' text-good'}>
                        {' '}
                        {row.customsPct > 0 ? '+' : ''}
                        {row.customsPct}%
                      </span>
                    ) : null}
                  </p>
                )}

                {/* The freight half is a BAND check and never a money figure. */}
                {row.band.arrivedMin !== null && row.band.quotedMin !== null ? (
                  <p className="text-2xs text-ink-600" data-testid="accuracy-band">
                    {row.band.ok ? '✓ ' : '⚠ '}
                    {t('bandQuoted')}: {row.band.quotedMin}
                    {row.band.quotedRate !== null ? ` ($${row.band.quotedRate})` : ''} ·{' '}
                    {t('bandArrived')}: {row.band.arrivedMin}
                    {row.band.arrivedDensity !== null
                      ? ` (${row.band.arrivedDensity.toFixed(1)} kg/m³)`
                      : ''}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const measure = (m3: number | null, kg: number | null) =>
  `${m3 === null ? '—' : m3.toFixed(2)} m³ / ${kg === null ? '—' : kg.toFixed(0)} kg`;
