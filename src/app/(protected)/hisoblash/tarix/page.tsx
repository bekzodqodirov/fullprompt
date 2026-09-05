import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { mayReadCalcRegistry } from '@/modules/wms/calc/control-scope';
import {
  REGISTRY_CAP,
  registryCounts,
  registryRows,
  registrySealers,
  type RegistryFilters,
  type RegistryRow,
} from '@/modules/wms/calc/chain';
import { CALC_SECTIONS, type CalcSection } from '@/modules/wms/calc/intake';
import { SECTION_LABELS } from '@/modules/wms/calc/labels';
import { PageHeader } from '@/components/ui/page';
import { ChainStateChip } from '@/components/calc-chain-chip';

/**
 * «Muhrlangan hisob-kitoblar» — the owner's «hisoblangan narsalarning tarixi».
 *
 * ONE ROW PER SEALED VERSION. A corrected job is two rows and one job, and
 * both numbers are printed and named, because his sentence was about jobs
 * («raschotlar spiskasi») and the list is of versions — a count that does not
 * say which it is reads as the other (#913).
 *
 * His answer 1A: SEALED only. The bot's typed «Готово» answers are not here
 * and the hint says so, because a person who priced a job that way and cannot
 * find it would otherwise read this as «my work was lost».
 *
 * His answer 2A: himself, the accountant and the VED — not the sellers. Every
 * figure on this screen is a FLOOR, and law 4 keeps floors off a seller's
 * screens. The door is `mayReadCalcRegistry`, a boolean and not the control
 * screen's own/all scope: a VED pricing a route wants the company's last
 * answer on it, not their own.
 *
 * The filters run in SQL over the SAME predicate as the counts. A filter
 * over an already-capped fetch answers «not found» about rows it never
 * fetched — /stock's lesson, and the reason the cap is printed when it bites.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A date the URL claims, or nothing — `readPeriod`'s own round-trip: V8
 * ROLLS «2026-02-30» to March 2nd, which is a silently shifted period. */
function isoDay(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

export default async function CalcRegistryPage({
  searchParams,
}: {
  searchParams: Promise<{ dan?: string; gacha?: string; bolim?: string; ved?: string; q?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!mayReadCalcRegistry(actor)) redirect('/');

  const params = await searchParams;
  const t = await getTranslations('calc');
  const tc = await getTranslations('common');
  const format = await getFormatter();

  // A lead's NAME is a funnel fact: the queue prints none for a reader
  // without `crm.leads`, and a filter the reader may not see must not be
  // searchable either — or the search box becomes the back door (#514).
  const leadsReadable = actor.permissions.has('crm.leads');
  const filters: RegistryFilters = {
    from: isoDay(params.dan),
    to: isoDay(params.gacha),
    section: CALC_SECTIONS.includes(params.bolim as CalcSection)
      ? (params.bolim as CalcSection)
      : null,
    sealerId: params.ved && UUID.test(params.ved) ? params.ved : null,
    q: (params.q ?? '').trim().slice(0, 80) || null,
    leadsReadable,
  };

  let rows: RegistryRow[] = [];
  let counts = { versions: 0, jobs: 0 };
  let sealers: Awaited<ReturnType<typeof registrySealers>> = [];
  try {
    [rows, counts, sealers] = await Promise.all([
      registryRows(filters),
      registryCounts(filters),
      registrySealers(),
    ]);
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err }, '[calc-registry] server behind');
  }

  const canOpenRequest = actor.permissions.has('ved.docs');
  const cardHref = (row: RegistryRow) =>
    row.entityType === 'deal' ? `/bitimlar/${row.entityId}` : `/crm/leads/${row.entityId}`;

  return (
    <div className="mx-auto max-w-4xl space-y-4" data-testid="calc-registry">
      <PageHeader
        icon="report"
        title={t('registryTitle')}
        subtitle={t('registryCounts', { jobs: counts.jobs, versions: counts.versions })}
        back={{ href: '/hisoblash/narxlar', label: t('historyTitle') }}
      />
      <p className="text-2xs text-ink-500">{t('registryHint')}</p>

      {/* ONE GET form (#171): the address bar is the state, so a filtered
          list is a link the owner can send to the accountant. */}
      <form method="get" className="card !p-3" data-testid="registry-filters">
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
            <span className="label">{t('filterSealer')}</span>
            <select name="ved" className="input input-sm" defaultValue={filters.sealerId ?? ''} data-testid="registry-sealer">
              <option value="">{t('regAll')}</option>
              {sealers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block col-span-2 sm:col-span-3 md:col-span-2">
            <span className="label">{t('filterQ')}</span>
            <input
              name="q"
              className="input input-sm"
              defaultValue={filters.q ?? ''}
              placeholder={t('filterQ')}
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
          {rows.map((row) => (
            <li key={row.versionId} className="card !p-3" data-testid="calc-registry-row">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-2xs tabular-nums text-ink-500">
                  {format.dateTime(row.sealedAt, { dateStyle: 'short' })}
                </span>
                {/* The card: a deal by code and client, a lead by name only
                    when the reader may open it — a `ved.docs` holder cannot
                    open a lead card at all, and a list must not become the
                    back door into the funnel. */}
                {row.entityType === 'deal' ? (
                  <Link href={cardHref(row)} className="font-semibold text-ink-900" data-testid="registry-card">
                    {row.cardLabel ?? row.dealCode ?? '—'}
                  </Link>
                ) : row.cardLabel ? (
                  <Link href={cardHref(row)} className="font-semibold text-ink-900" data-testid="registry-card">
                    {row.cardLabel}
                  </Link>
                ) : (
                  <span className="font-semibold text-ink-700" data-testid="registry-card">
                    {t('registryLead')}
                  </span>
                )}
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
                <span className="text-2xs text-ink-500">{row.sealedByName ?? '—'}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* The cap, said out loud only when it bites: a list that stops at
          200 with nothing to say reads as «that is all there is». */}
      {counts.versions > rows.length ? (
        <p className="text-2xs text-ink-500" data-testid="registry-capped">
          {t('registryCapped', { shown: Math.min(rows.length, REGISTRY_CAP), total: counts.versions })}
        </p>
      ) : null}
    </div>
  );
}
