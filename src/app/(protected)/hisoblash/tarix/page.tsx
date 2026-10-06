import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { internalNoteSight, mayReadCalcRegistry } from '@/modules/wms/calc/control-scope';
import {
  REGISTRY_CAP,
  registryCounts,
  registryGoods,
  registryPeople,
  registryRows,
  type RegistryFilters,
  type RegistryGoods as RegistryGoodsSummary,
  type RegistryKind,
  type RegistryRow,
} from '@/modules/wms/calc/chain';
import { creditTotals, type CreditTotalsRow } from '@/modules/wms/calc/credit';
import { calcCardHref, leadNameReadable } from '@/modules/wms/calc/card-door';
import { CALC_SECTIONS, type CalcSection } from '@/modules/wms/calc/intake';
import { SECTION_LABELS } from '@/modules/wms/calc/labels';
import { PageHeader } from '@/components/ui/page';
import { ChainStateChip } from '@/components/calc-chain-chip';
import { RegistryGoods } from '@/components/registry-goods';
import { monthLabel, monthNames } from '@/components/charts/month-names';
import { calendarDay, tashkentMonth } from '@/modules/platform/time/tashkent';
import { addMonths, calendarMonth, monthRange } from '@/modules/wms/staff/month';

/**
 * «Hisob-kitoblar tarixi» — the owner's «hisoblangan narsalarning tarixi»,
 * and since 2026-10-06 his 8a: the Готово answers are on it too.
 *
 * ONE ROW PER PRICE: a sealed version (`calc-registry-row`, «V2») or a Готово
 * answer (`calc-registry-answer`, «✍️ umumiy narx», never a V number). A
 * corrected job is several rows and one job, and the counts name all three
 * numbers, because a count that does not say which it is reads as the other
 * (#913).
 *
 * His answer 2A stands: himself, the accountant and the VED — not the
 * sellers. Every figure here is a FLOOR (law 4). The internal note (9a) is
 * narrower still — the VED and leadership (`internalNoteSight`) — and the
 * accountant's query never fetches it.
 *
 * His 12a/13c: «kim qancha hisoblagan». The block on top counts every
 * credited price of the month per person (credit.ts — the ONE rule the
 * profile and the queue's speed block also ask), counts and time only.
 *
 * The filters run in SQL over the SAME predicate as the counts. A filter over
 * an already-capped fetch answers «not found» about rows it never fetched —
 * /stock's lesson, and the reason the cap is printed when it bites.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A date the URL claims, or nothing — the shared calendar reader (U43): V8
 * ROLLS «2026-02-30» to March 2nd, which is a silently shifted period. */
const isoDay = calendarDay;

/** «Turi» from the URL, validated (#514): garbage reads as «hammasi». */
const KIND_PARAM: Record<string, RegistryKind> = { muhr: 'sealed', javob: 'answer' };

type Params = {
  dan?: string;
  gacha?: string;
  bolim?: string;
  ved?: string;
  q?: string;
  turi?: string;
  oy?: string;
};

export default async function CalcRegistryPage({ searchParams }: { searchParams: Promise<Params> }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!mayReadCalcRegistry(actor)) redirect('/');

  const params = await searchParams;
  const t = await getTranslations('calc');
  const tc = await getTranslations('common');
  const format = await getFormatter();

  // The note is the VED's and leadership's (9a): minted here or not at all.
  const noteSight = internalNoteSight(actor);
  const filters: RegistryFilters = {
    from: isoDay(params.dan),
    to: isoDay(params.gacha),
    section: CALC_SECTIONS.includes(params.bolim as CalcSection)
      ? (params.bolim as CalcSection)
      : null,
    personId: params.ved && UUID.test(params.ved) ? params.ved : null,
    kind: KIND_PARAM[params.turi ?? ''] ?? null,
    q: (params.q ?? '').trim().slice(0, 80) || null,
    leadNamesReadable: leadNameReadable(actor),
  };
  // The totals' own month (13c), Tashkent's; `?oy=` validated, default now.
  const month = calendarMonth(params.oy) ?? tashkentMonth();

  let rows: RegistryRow[] = [];
  let counts = { versions: 0, answers: 0, jobs: 0 };
  let people: Awaited<ReturnType<typeof registryPeople>> = [];
  let totals: CreditTotalsRow[] = [];
  let goods = new Map<string, RegistryGoodsSummary>();
  const names = await monthNames();
  try {
    [rows, counts, people, totals] = await Promise.all([
      registryRows(filters, { noteSight }),
      registryCounts(filters),
      registryPeople(),
      creditTotals(monthRange(month)),
    ]);
    // One grouped query for the page's rows (#432).
    goods = await registryGoods(rows.map((row) => row.requestId));
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err }, '[calc-registry] server behind');
  }

  const canOpenRequest = actor.permissions.has('ved.docs');
  const monthHref = (m: string) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value && key !== 'oy') q.set(key, value);
    q.set('oy', m);
    return `/hisoblash/tarix?${q.toString()}`;
  };
  const goodsLine = (requestId: string) => {
    const g = goods.get(requestId);
    if (!g || g.count === 0) return t('registryGoodsNone');
    const more = g.count > g.first.length ? ', …' : '';
    return t('registryGoodsSummary', { n: g.count, names: `${g.first.join(', ')}${more}` });
  };
  const card = (row: RegistryRow, testId: string) => {
    const href = calcCardHref(actor, { ...row, requestId: row.requestId });
    const label =
      row.entityType === 'deal' ? (row.cardLabel ?? row.dealCode ?? '—') : (row.cardLabel ?? t('registryLead'));
    return href ? (
      <Link href={href} className="font-semibold text-ink-900" data-testid={testId}>
        {label}
      </Link>
    ) : (
      <span className="font-semibold text-ink-700" data-testid={testId}>
        {label}
      </span>
    );
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4" data-testid="calc-registry">
      <PageHeader
        icon="report"
        title={t('registryTitle')}
        subtitle={t('registryCounts', { jobs: counts.jobs, versions: counts.versions, answers: counts.answers })}
        back={{ href: '/hisoblash/narxlar', label: t('historyTitle') }}
      />
      <p className="text-2xs text-ink-500">{t('registryHint')}</p>

      {/* «Kim qancha hisobladi» (13c) — counts and time, never money: the
          answers are typed in three currencies. Its own month, said out loud:
          the filters below do not move it (review ved-correctness-22). */}
      <section className="card !p-3" data-testid="calc-totals">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="section-title">{t('totalsTitle', { month: monthLabel(names, month, true) })}</h2>
          <span className="flex gap-3 text-2xs">
            <Link href={monthHref(addMonths(month, -1))} className="text-brand-700" data-testid="totals-prev">
              {t('totalsPrev')}
            </Link>
            {month < tashkentMonth() ? (
              <Link href={monthHref(addMonths(month, 1))} className="text-brand-700" data-testid="totals-next">
                {t('totalsNext')}
              </Link>
            ) : null}
          </span>
        </div>
        <p className="text-2xs text-ink-500">{t('totalsOnlyMonth')}</p>
        {totals.length === 0 ? (
          <p className="mt-1 text-sm text-ink-500" data-testid="totals-none">
            {t('totalsNone')}
          </p>
        ) : (
          <ul className="mt-1 space-y-1 text-xs" data-testid="totals-rows">
            {totals.map((row) => (
              <li key={row.personId} className="flex flex-wrap items-baseline gap-x-3" data-testid="totals-row">
                <span className="font-semibold">{row.name}</span>
                <span className="num" data-testid="totals-sealed">
                  {t('totalsSealed', { n: row.sealed })}
                </span>
                <span className="num" data-testid="totals-answered">
                  {t('totalsAnswered', { n: row.answered })}
                </span>
                {row.avgMinutes !== null ? (
                  <span className="num text-ink-500">{t('totalsAvg', { n: row.avgMinutes })}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ONE GET form (#171): the address bar is the state, so a filtered
          list is a link the owner can send to the accountant. */}
      <form method="get" className="card !p-3" data-testid="registry-filters">
        <input type="hidden" name="oy" value={params.oy && calendarMonth(params.oy) ? params.oy : ''} />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-6">
          <label className="block">
            <span className="label">{t('regFrom')}</span>
            <input type="date" name="dan" className="input input-sm" defaultValue={filters.from ?? ''} />
          </label>
          <label className="block">
            <span className="label">{t('regTo')}</span>
            <input type="date" name="gacha" className="input input-sm" defaultValue={filters.to ?? ''} />
          </label>
          <label className="block">
            <span className="label">{t('filterSection')}</span>
            <select name="bolim" className="input input-sm" defaultValue={filters.section ?? ''}>
              <option value="">{t('regAll')}</option>
              {CALC_SECTIONS.map((s) => (
                <option key={s} value={s}>
                  {t(SECTION_LABELS[s] as 'sections.podklyuch')}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">{t('filterKind')}</span>
            <select
              name="turi"
              className="input input-sm"
              defaultValue={filters.kind === 'sealed' ? 'muhr' : filters.kind === 'answer' ? 'javob' : ''}
              data-testid="registry-kind"
            >
              <option value="">{t('kindAll')}</option>
              <option value="muhr">{t('kindSealed')}</option>
              <option value="javob">{t('kindAnswer')}</option>
            </select>
          </label>
          <label className="block">
            <span className="label">{t('filterPerson')}</span>
            <select name="ved" className="input input-sm" defaultValue={filters.personId ?? ''} data-testid="registry-sealer">
              <option value="">{t('regAll')}</option>
              {people.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block col-span-2 sm:col-span-3 md:col-span-1">
            <span className="label">{t('filterQGoods')}</span>
            <input
              name="q"
              className="input input-sm"
              defaultValue={filters.q ?? ''}
              placeholder={t('filterQGoods')}
              data-testid="registry-q"
            />
          </label>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="submit" className="btn-primary" data-testid="registry-apply">
            {tc('search')}
          </button>
          <Link href="/hisoblash/tarix" className="btn-ghost">
            {t('regClear')}
          </Link>
        </div>
      </form>

      {rows.length === 0 ? (
        <p className="text-sm text-ink-500" data-testid="registry-empty">
          {t('registryNone')}
        </p>
      ) : (
        <ul className="space-y-2" data-testid="registry-rows">
          {rows.map((row) =>
            row.kind === 'sealed' ? (
              <li key={`sealed:${row.versionId}`} className="card !p-3" data-testid="calc-registry-row">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-2xs tabular-nums text-ink-500">
                    {format.dateTime(row.sealedAt, { dateStyle: 'short' })}
                  </span>
                  {card(row, 'registry-card')}
                  <span className="chip chip-brand">
                    {t(SECTION_LABELS[row.section] as 'sections.podklyuch')}
                  </span>
                  <span className="chip chip-neutral" data-testid="registry-version">
                    V{row.quoteNo}
                  </span>
                  <ChainStateChip version={row} />
                  {row.expired && !row.superseded ? (
                    <span className="chip chip-warn">{t('expired')}</span>
                  ) : null}
                  {row.discountUsd > 0 ? (
                    <span className="chip chip-warn" data-testid="registry-discount">
                      {t('discount')} −${row.discountUsd.toFixed(2)}
                    </span>
                  ) : null}
                  {row.bandOverrideMin !== null ? (
                    <span className="chip chip-warn">{t('bandOverride')}</span>
                  ) : null}
                  {canOpenRequest ? (
                    <Link
                      href={`/hisoblash/${row.requestId}`}
                      className="font-semibold text-brand-700"
                      data-testid="registry-request-link"
                    >
                      #
                    </Link>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-mono text-lg font-semibold tabular-nums" data-testid="registry-total">
                    ${row.totalUsd.toFixed(2)}
                  </span>
                  <span className="font-mono text-2xs tabular-nums text-ink-500">
                    {row.perM3Usd === null ? '' : `$${row.perM3Usd.toFixed(2)}/m³`}
                    {row.perM3Usd !== null && row.perKgUsd !== null ? ' · ' : ''}
                    {row.perKgUsd === null ? '' : `$${row.perKgUsd.toFixed(4)}/kg`}
                  </span>
                  <span className="text-2xs text-ink-500" data-testid="registry-who">
                    {row.sealedByName ?? '—'}
                  </span>
                </div>
                <RegistryGoods requestId={row.requestId} summary={goodsLine(row.requestId)} />
              </li>
            ) : (
              <li key={`answer:${row.requestId}`} className="card !p-3" data-testid="calc-registry-answer">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-2xs tabular-nums text-ink-500">
                    {format.dateTime(row.answeredAt, { dateStyle: 'short' })}
                  </span>
                  {card(row, 'registry-card')}
                  {row.section ? (
                    <span className="chip chip-brand">
                      {t(SECTION_LABELS[row.section] as 'sections.podklyuch')}
                    </span>
                  ) : null}
                  <span className="chip chip-warn" data-testid="registry-answer-chip">
                    {t('answerChip')}
                  </span>
                  <ChainStateChip version={row} alone={!row.superseded} />
                  {canOpenRequest ? (
                    <Link
                      href={`/hisoblash/${row.requestId}`}
                      className="font-semibold text-brand-700"
                      data-testid="registry-request-link"
                    >
                      #
                    </Link>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  {/* As typed, in its own currency — no per-unit columns. */}
                  <span className="font-mono text-lg font-semibold tabular-nums" data-testid="registry-answer-amount">
                    {row.amount.toFixed(2)} {row.currency ?? ''}
                  </span>
                  <span className="text-2xs text-ink-500" data-testid="registry-who">
                    {row.answeredByName ?? '—'}
                  </span>
                </div>
                {row.sellerNote ? (
                  <p className="mt-1 whitespace-pre-wrap text-2xs text-ink-600" data-testid="registry-seller-note">
                    {t('sellerNoteShort')}: {row.sellerNote}
                  </p>
                ) : null}
                {noteSight ? (
                  <p className="mt-1 whitespace-pre-wrap text-2xs text-ink-700" data-testid="registry-internal-note">
                    {t('internalNoteShort')}: {row.internalNote ?? t('internalNoteOld')}
                  </p>
                ) : null}
                <RegistryGoods requestId={row.requestId} summary={goodsLine(row.requestId)} />
              </li>
            ),
          )}
        </ul>
      )}

      {/* The cap, said out loud only when it bites: a list that stops at
          200 with nothing to say reads as «that is all there is». Over BOTH
          kinds (review ved-correctness-17). */}
      {counts.versions + counts.answers > rows.length ? (
        <p className="text-2xs text-ink-500" data-testid="registry-capped">
          {t('registryCapped', {
            shown: Math.min(rows.length, REGISTRY_CAP),
            total: counts.versions + counts.answers,
          })}
        </p>
      ) : null}
    </div>
  );
}
