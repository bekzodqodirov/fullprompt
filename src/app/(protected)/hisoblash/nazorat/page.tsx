import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { getSetting } from '@/modules/platform/settings/service';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { calcControlReadScopeFor, calcControlScopeFor } from '@/modules/wms/calc/control-scope';
import {
  calcActuals,
  calcCoverage,
  linkSuggestionCount,
  linkSuggestions,
  warnedGroups,
  type CalcActualRow,
  type LinkSuggestion,
} from '@/modules/wms/calc/actuals';
import {
  BAND_REFUSAL_LABELS,
  REFUSAL_LABELS,
  SECTION_LABELS,
  WARNING_LABELS,
} from '@/modules/wms/calc/labels';
import { PageHeader } from '@/components/ui/page';
import { CalcLinkRow } from '@/components/calc-link-row';
import { tashkentDayStart, tashkentMonthStart } from '@/modules/platform/time/tashkent';

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
 *
 * TWO SCOPES (the owner's 12a, review access-money-6, ved-correctness-3): the
 * VED READS everybody's measurements (`calcControlReadScopeFor`), and WRITES
 * only his own (`calcControlScopeFor`, unchanged for all six of its callers),
 * because confirming a link scores the colleague it measures. So the link
 * queue is two lists from one predicate: «Meniki (N)» — the write scope, with
 * the buttons, N the VED home's own count — and «Hamkasblarniki», read-only
 * rows naming the sealer, with no ✅/❌ at all.
 */
export default async function CalcControlPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const readScope = calcControlReadScopeFor(actor);
  const scope = calcControlScopeFor(actor);
  if (readScope === 'none' || scope === 'none') redirect('/');

  const t = await getTranslations('calc');
  const format = await getFormatter();

  // This month's first instant in Tashkent (R5), not UTC's 05:00.
  const monthStart = tashkentDayStart(tashkentMonthStart());
  // The lists read company-wide; the link queue's BUTTONS stay the writer's.
  const who = { scope: readScope, actorId: actor.id } as const;
  const writer = { scope, actorId: actor.id } as const;

  let coverage = { sealed: 0, linked: 0, suggested: 0 };
  let queue: Awaited<ReturnType<typeof linkSuggestions>> = [];
  let warned: Awaited<ReturnType<typeof warnedGroups>> = [];
  let rows: CalcActualRow[] = [];
  let settleDays = 7;
  // The queue's true length (0119): the list is capped at 50, and the VED
  // home's «Tasdiqlash kerak: N» counts all of them — the same predicate.
  let queueTotal = 0;
  // «Hamkasblarniki»: only a writer scoped to their own has colleagues here.
  let colleagues: LinkSuggestion[] = [];
  let colleaguesTotal = 0;
  try {
    [coverage, queue, queueTotal, warned, rows, settleDays] = await Promise.all([
      calcCoverage(who, monthStart),
      linkSuggestions(writer),
      linkSuggestionCount(writer),
      warnedGroups(who, monthStart),
      // Settled only, filtered in SQL: see `settledFilter` — a JS filter after
      // the LIMIT empties this table exactly when the month is busiest.
      calcActuals(who, { settledOnly: true }),
      getSetting('calc_actual_settle_days').then((v) => Number(v ?? 7)),
    ]);
    if (scope === 'own') {
      const allCount = await linkSuggestionCount(who);
      colleagues = await linkSuggestions(who, 50, { notSealedBy: actor.id });
      colleaguesTotal = Math.max(0, allCount - queueTotal);
    }
  } catch (err) {
    // 0089 is this release's migration; the machine whose schema is behind is
    // production on deploy morning (#472).
    if (!isServerBehind(err)) throw err;
    logger.error({ err }, '[calc-control] server behind');
  }

  // Already settled by the query itself; named here because the section below
  // reads as «what is scoreable», not «what was fetched».
  const settled = rows;

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
        {/* «Meniki (N)» — N is the VED home's «Tasdiqlash kerak: N», the same
            predicate (#513), so the home number is one this screen prints.
            Only for a writer scoped to their OWN (review ved-money-6): for the
            accountant, the admins and the owner the write scope is 'all', the
            list is the whole company's and N the company's count — «Mine»
            above it would be a false word. */}
        {scope === 'own' ? (
          <h3 className="text-xs font-semibold" data-testid="link-mine-title">
            {t('linkMine', { n: queueTotal })}
          </h3>
        ) : (
          <h3 className="text-xs font-semibold" data-testid="link-all-title">
            {t('linkAll', { n: queueTotal })}
          </h3>
        )}
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
        {queueTotal > queue.length ? (
          <p className="text-2xs text-ink-500" data-testid="link-shown-of">
            {t('linksShownOf', { shown: queue.length, total: queueTotal })}
          </p>
        ) : null}

        {/* «Hamkasblarniki» (12a) — read, never confirmed by anyone but the
            sealer: no CalcLinkRow, so no button the write scope would refuse
            with a raw «not_mine». */}
        {scope === 'own' ? (
          <div className="space-y-2" data-testid="link-colleagues">
            <h3 className="text-xs font-semibold" data-testid="link-colleagues-title">
              {t('linkColleagues', { n: colleaguesTotal })}
            </h3>
            {colleagues.length === 0 ? (
              <p className="text-sm text-ink-500">{t('linkNone')}</p>
            ) : (
              <ul className="space-y-2">
                {colleagues.map((row) => (
                  <li key={row.receiptId} className="card !p-3" data-testid="link-row-colleague">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-mono text-sm font-semibold">{row.receiptNumber ?? '—'}</span>
                      {row.clientCode ? <span className="chip">{row.clientCode}</span> : null}
                      <span className="chip chip-brand">
                        {t(SECTION_LABELS[row.section] as 'sections.podklyuch')}
                      </span>
                      <span className="text-2xs text-ink-500" data-testid="link-row-sealer">
                        {row.sealedByName ?? '—'}
                      </span>
                    </div>
                    <p className="text-2xs text-ink-600">
                      {t('quoted')}: {measure(row.quotedVolumeM3, row.quotedWeightKg)} ·{' '}
                      {t('measured')}: {measure(row.actualVolumeM3, row.actualWeightKg)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
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
                      // Colour on the owner's own threshold, not on the sign:
                      // a 0.4 % overrun is not news and looked exactly as
                      // alarming as a 60 % one.
                      <span
                        className={
                          !row.customsOffThreshold
                            ? ' text-ink-500'
                            : row.customsPct > 0
                              ? ' text-bad'
                              : ' text-good'
                        }
                      >
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
                ) : row.band.refusal !== null ? (
                  // A hole or an overlap in the owner's own table — a fact
                  // about the TARIFF, and the one band case somebody has to
                  // act on. Never silence (phase B's rule).
                  <p className="text-2xs text-warn" data-testid="accuracy-band-refusal">
                    ⚠ {t(BAND_REFUSAL_LABELS[row.band.refusal] as 'bandRefusal.missing')}
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
