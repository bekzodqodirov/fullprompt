import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { readPeriod } from '@/modules/wms/crm/analytics';
import { sellerReportScopeFor } from '@/modules/wms/crm/seller-report-scope';
import {
  sellerPerformanceAll,
  sellerPerformanceOwn,
  type SellerAllRow,
  type SellerOwnRow,
} from '@/modules/wms/crm/seller-report';
import { PageHeader } from '@/components/ui/page';

/**
 * Sotuvchi samaradorligi (owner, 2026-08-25: «ha qur»). Two shapes from two
 * FUNCTIONS: the accountant's table carries profit, the seller's own card
 * structurally cannot («tannarx korinmasin sotuvchiga» — his words; the own
 * return type has no cost-derived property, so this page could not print one
 * even by mistake).
 *
 * A different clock from /crm/tahlil's sellers table on purpose: tahlil is
 * the funnel's promise (leads won by owner, QUOTED money), this is the
 * ledger's fact (a manager's clients, CHARGED money and received cargo).
 * The subtitle names the attribution so the owner comparing the two tables
 * reads a difference, not a bug.
 */
export default async function SellerReportPage({
  searchParams,
}: {
  searchParams: Promise<{ dan?: string; gacha?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const scope = sellerReportScopeFor(actor);
  // Law 4's shape: not filtered — not reachable. The VED reads costs all day
  // and client money never; this screen is client money.
  if (scope === 'none') redirect('/');

  const t = await getTranslations('sellerReport');
  const period = readPeriod(await searchParams);

  let all: Awaited<ReturnType<typeof sellerPerformanceAll>> | null = null;
  let own: SellerOwnRow | null = null;
  let behind = false;
  try {
    if (scope === 'all') all = await sellerPerformanceAll(period);
    else own = await sellerPerformanceOwn(actor.id, period);
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err }, '[seller-report] server behind');
    behind = true;
  }

  const money = (n: number) => `$${n.toFixed(2)}`;
  const size = (r: SellerOwnRow | SellerAllRow) =>
    `${r.volumeM3.toFixed(3)} m³ · ${r.weightKg.toFixed(1)} kg`;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader icon="report" title={t('title')} />
      <p className="text-xs text-ink-500">{t('subtitle')}</p>

      <form className="card flex flex-wrap items-end gap-2 !p-3" data-testid="seller-period">
        <label className="text-2xs">
          <span className="label">{t('period')}</span>
          <input type="date" name="dan" className="input input-sm !w-36" defaultValue={period.dan} />
        </label>
        <label className="text-2xs">
          <span className="label">—</span>
          <input
            type="date"
            name="gacha"
            className="input input-sm !w-36"
            defaultValue={period.gacha}
          />
        </label>
        <button type="submit" className="btn-secondary">
          {t('show')}
        </button>
      </form>

      {behind ? <p className="chip chip-warn">{t('empty')}</p> : null}

      {own ? (
        <section className="card space-y-2 !p-3" data-testid="seller-own">
          <h2 className="section-title">{t('ownTitle')}</h2>
          <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
            <div>
              <dt className="text-2xs uppercase text-ink-500">{t('clients')}</dt>
              <dd className="font-mono text-lg font-bold tabular-nums">{own.clients}</dd>
            </div>
            <div>
              <dt className="text-2xs uppercase text-ink-500">{t('receipts')}</dt>
              <dd className="font-mono text-lg font-bold tabular-nums">{own.receipts}</dd>
            </div>
            <div>
              <dt className="text-2xs uppercase text-ink-500">{t('cargo')}</dt>
              <dd className="font-mono tabular-nums">{size(own)}</dd>
            </div>
            <div>
              <dt className="text-2xs uppercase text-ink-500">{t('revenue')}</dt>
              <dd className="font-mono text-lg font-bold tabular-nums">{money(own.revenueUsd)}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      {all ? (
        <section className="card !p-0" data-testid="seller-table">
          {all.unassignedClients > 0 ? (
            <p className="px-3 pt-3 text-xs text-ink-500">
              {t('unassigned', { n: all.unassignedClients })}{' '}
              <Link href="/admin/clients" className="underline">
                {t('clientBook')} →
              </Link>
            </p>
          ) : null}
          <div className="overflow-x-auto p-3">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-2xs uppercase text-ink-500">
                  <th className="p-2">{t('seller')}</th>
                  <th className="p-2 text-right">{t('clients')}</th>
                  <th className="p-2 text-right">{t('receipts')}</th>
                  <th className="p-2 text-right">{t('cargo')}</th>
                  <th className="p-2 text-right">{t('revenue')}</th>
                  <th className="p-2 text-right">{t('profit')}</th>
                  <th className="p-2 text-right">%</th>
                </tr>
              </thead>
              <tbody>
                {all.rows.map((row) => (
                  <tr key={row.managerId ?? '—'} className="border-b border-line/60">
                    <td className="p-2">{row.managerName ?? t('nobody')}</td>
                    <td className="p-2 text-right font-mono tabular-nums">{row.clients}</td>
                    <td className="p-2 text-right font-mono tabular-nums">{row.receipts}</td>
                    <td className="p-2 text-right font-mono tabular-nums">{size(row)}</td>
                    <td className="p-2 text-right font-mono tabular-nums">{money(row.revenueUsd)}</td>
                    <td
                      className={`p-2 text-right font-mono font-semibold tabular-nums ${row.profitUsd < 0 ? 'text-bad' : ''}`}
                    >
                      {money(row.profitUsd)}
                    </td>
                    <td className="p-2 text-right font-mono tabular-nums">{row.marginPct}</td>
                  </tr>
                ))}
                <tr data-testid="seller-totals" className="font-semibold">
                  <td className="p-2">{t('total')}</td>
                  <td className="p-2 text-right font-mono tabular-nums">{all.totals.clients}</td>
                  <td className="p-2 text-right font-mono tabular-nums">{all.totals.receipts}</td>
                  <td className="p-2 text-right font-mono tabular-nums">{size(all.totals)}</td>
                  <td className="p-2 text-right font-mono tabular-nums">
                    {money(all.totals.revenueUsd)}
                  </td>
                  <td className="p-2 text-right font-mono tabular-nums">
                    {money(all.totals.profitUsd)}
                  </td>
                  <td className="p-2 text-right font-mono tabular-nums">{all.totals.marginPct}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {all.rows.length === 0 ? <p className="px-3 pb-3 text-sm text-ink-500">{t('empty')}</p> : null}
          <p className="px-3 pb-3 text-2xs text-ink-500">
            <Link href="/crm/tahlil" className="underline">
              {t('funnelLink')} →
            </Link>
          </p>
        </section>
      ) : null}
    </div>
  );
}
