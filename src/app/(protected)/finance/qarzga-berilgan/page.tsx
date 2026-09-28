import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { calendarDay, OFFICE_TZ } from '@/modules/platform/time/tashkent';
import { BackLink } from '@/components/back-link';
import { PageHeader } from '@/components/ui/page';
import { companyMoneySight } from '@/modules/wms/finance/scope';
import { debtReleases, releaseApprovers, type ReleaseKind } from '@/modules/wms/debt/releases';
import { mayReadHandoverAct } from '@/modules/wms/documents/handover-act-door';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Literal map (#163): a kind added to the register is a type error here. */
const KIND: Record<ReleaseKind, { key: string; tone: string }> = {
  tick: { key: 'releases.kindTick', tone: 'bg-warn/10 text-warn' },
  approval: { key: 'releases.kindApproval', tone: 'bg-brand-50 text-brand-700' },
  deferral: { key: 'releases.kindDeferral', tone: 'bg-line text-ink-700' },
};

function day(value: string): string {
  const [y, m, d] = value.split('-');
  return `${d}.${m}.${y}`;
}

/**
 * «Qarzga berilgan yuklar» (0114, the owner's debt control): the owner's and
 * the accountant's list of every release on debt, who allowed it, and what
 * came back. The door is `companyMoneySight` — the company's receivable is
 * law 4's and round 91's together, so neither a seller (his own book only)
 * nor the VED (Q19) nor the logist reads it.
 *
 * A LIST at every width (#599's lesson at 360 px: a six-column table hid the
 * one column that matters off the right edge). Every URL value is validated
 * or dropped (#514). The default is every release whose money has not come
 * back, whatever its date (the judge's #6) — the period is a filter.
 */
export default async function DebtReleasesPage({
  searchParams,
}: {
  searchParams: Promise<{ dan?: string; gacha?: string; kim?: string; hammasi?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const sight = companyMoneySight(actor);
  if (!sight) redirect('/');
  const t = await getTranslations('qarz');
  const tf = await getTranslations('finance');
  const format = await getFormatter();
  const params = await searchParams;
  const filter = {
    from: calendarDay(params.dan),
    to: calendarDay(params.gacha),
    approverId: params.kim && UUID.test(params.kim) ? params.kim : null,
    includeReturned: params.hammasi === '1',
  };
  const [{ rows, total, totals }, approvers] = await Promise.all([
    debtReleases(sight, filter),
    releaseApprovers(sight),
  ]);
  const usd = (n: number) => `$${n.toFixed(2)}`;

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <BackLink href="/finance" label={tf('title')} />
      <PageHeader icon="wallet" title={t('releases.title')} />
      <p className="text-sm text-ink-500">{t('releases.note')}</p>

      <form className="flex flex-wrap items-end gap-2" method="get" data-testid="releases-filter">
        <label className="text-sm">
          <span className="label">{t('releases.from')}</span>
          <input type="date" name="dan" defaultValue={filter.from ?? ''} className="input" />
        </label>
        <label className="text-sm">
          <span className="label">{t('releases.to')}</span>
          <input type="date" name="gacha" defaultValue={filter.to ?? ''} className="input" />
        </label>
        <label className="min-w-0 text-sm">
          <span className="label">{t('releases.who')}</span>
          <select name="kim" defaultValue={filter.approverId ?? ''} className="input">
            <option value="">{t('releases.everyone')}</option>
            {approvers.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-h-12 items-center gap-2 text-sm">
          <input type="checkbox" name="hammasi" value="1" defaultChecked={filter.includeReturned} />
          {t('releases.showAll')}
        </label>
        <button type="submit" className="btn-secondary">
          {t('releases.apply')}
        </button>
      </form>

      {totals.length > 0 && (
        <section className="card space-y-2" data-testid="releases-totals">
          <h2 className="text-sm font-bold uppercase text-ink-500">{t('releases.perApprover')}</h2>
          <ul className="divide-y divide-line">
            {totals.map((row) => (
              <li key={row.approverId ?? 'none'} className="space-y-0.5 py-2 text-sm" data-testid="releases-total">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold">{row.approverName ?? t('releases.unknownApprover')}</span>
                  <span className="text-xs text-ink-500">
                    {t('releases.releasesN', { n: row.releases })} · {t('releases.clientsN', { n: row.clients })}
                    {row.unknown > 0 && <> · {t('releases.unknownN', { n: row.unknown })}</>}
                  </span>
                </p>
                <p className="num flex flex-wrap gap-x-3 text-xs">
                  <span>{t('releases.debtAt', { usd: usd(row.debtUsd) })}</span>
                  <span className="text-good">{t('releases.returned', { usd: usd(row.returnedUsd) })}</span>
                  <span className="font-bold text-bad" data-testid="releases-total-left">
                    {t('releases.left', { usd: usd(row.leftUsd) })}
                  </span>
                </p>
              </li>
            ))}
          </ul>
          <p className="text-xs text-ink-500">{t('releases.totalsNote')}</p>
        </section>
      )}

      {rows.length === 0 ? (
        <p className="card text-sm text-ink-500" data-testid="releases-empty">
          {t('releases.empty')}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={`${row.handoverId}-${row.ord}`} className="card space-y-1 text-sm" data-testid="release-row">
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <Link href={`/finance/${row.clientId}`} className="font-mono text-lg font-extrabold text-brand-700">
                  {row.clientCode}
                </Link>
                <span className="min-w-0 flex-1 truncate text-ink-700">{row.clientName}</span>
                <span className={`chip text-xs ${KIND[row.kind].tone}`} data-testid="release-kind">
                  {t(KIND[row.kind].key)}
                </span>
              </p>
              <p className="text-xs text-ink-500">
                {format.dateTime(row.createdAt, { timeZone: OFFICE_TZ, dateStyle: 'short', timeStyle: 'short' })} ·{' '}
                {row.warehouseCode}
                {mayReadHandoverAct(actor, row.warehouseId) && (
                  <>
                    {' · '}
                    <a
                      href={`/api/handovers/${row.handoverId}/act`}
                      className="text-brand-700 underline"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t('releases.act')}
                    </a>
                  </>
                )}
              </p>
              <p className="text-xs text-ink-700">
                {t('releases.allowedBy', { name: row.approverName ?? t('releases.unknownApprover') })}
                {row.gaveByName && <> · {t('releases.gaveBy', { name: row.gaveByName })}</>}
                {row.dealCode && <> · {t('releases.deal', { code: row.dealCode })}</>}
              </p>
              <p className="num flex flex-wrap gap-x-3 text-xs" data-testid="release-money">
                <span className="font-semibold">
                  {row.debtUsd === null ? t('releases.unknownDebt') : t('releases.debtAt', { usd: usd(row.debtUsd) })}
                  {row.legacy && <span className="font-normal text-ink-500"> {t('releases.legacyDebt')}</span>}
                </span>
                {row.deferredUsd !== null && row.deferredUsd > 0.009 && (
                  <span className="text-ink-500">{t('releases.deferredPart', { usd: usd(row.deferredUsd) })}</span>
                )}
                {/* «qaytdi» is THIS part's share of the money since — debt − qaytdi
                    = qaytmagan on the same line. All the money since, whole, would
                    sit beside a part it does not belong to on a two-part release
                    ($600 · $500 · $500). An older release stored no figure, so
                    there is nothing to share and the plain «keyin to‘landi» says
                    what is known. */}
                {row.returnedUsd !== null ? (
                  <span className="text-good" data-testid="release-returned">
                    {t('releases.returned', { usd: usd(row.returnedUsd) })}
                  </span>
                ) : (
                  <span className="text-good">{t('releases.paidSince', { usd: usd(row.paidSinceUsd) })}</span>
                )}
                {row.leftUsd !== null && (
                  <span className="font-bold text-bad" data-testid="release-left">
                    {t('releases.left', { usd: usd(row.leftUsd) })}
                  </span>
                )}
                <span className="text-ink-600">{t('releases.currentDebt', { usd: usd(row.currentDebtUsd) })}</span>
              </p>
              {row.promise && row.promise.status === 'open' && (
                <p className="text-xs font-semibold text-warn" data-testid="release-promise">
                  {t('releases.promiseOpen', { usd: usd(row.promise.amountUsd), date: day(row.promise.dueOn) })}
                </p>
              )}
              {row.promise && row.promise.status === 'broken' && (
                <p className="text-xs font-semibold text-bad" data-testid="release-promise">
                  {t('releases.promiseBroken', { date: day(row.promise.dueOn) })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {total > rows.length && (
        <p className="text-xs text-ink-500" data-testid="releases-cap">
          {t('releases.cap', { shown: rows.length, total })}
        </p>
      )}
    </div>
  );
}
