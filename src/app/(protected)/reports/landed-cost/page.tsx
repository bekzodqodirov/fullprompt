import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { moneyHidden } from '@/modules/platform/rbac/money-sight';
import {
  landedCostByClient,
  landedCostByLot,
  UNCLAIMED_KEY,
  unconvertedCosts,
} from '@/modules/wms/reports/queries';
import { BackLink } from '@/components/back-link';
import { PageHeader } from '@/components/ui/page';

/**
 * Report §13.7 (owner's #1 priority): landed cost by client — every client's
 * Σ USD across all allocated costs; drill into a client for the per-lot
 * breakdown. XLSX mirrors the current view.
 */
export default async function LandedCostReportPage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  // The whole report is the tannarx, which the VED does not see (Q19).
  if (!actor.permissions.has('reports.all_warehouses') || moneyHidden('results', actor.permissions)) {
    redirect('/reports');
  }
  const t = await getTranslations('reports');
  const ta = await getTranslations('accounting');
  const { clientId } = await searchParams;

  const [clientRows, unconverted] = await Promise.all([landedCostByClient(), unconvertedCosts()]);
  const unconvertedCount = unconverted.reduce((sum, row) => sum + row.count, 0);
  // Unclaimed cargo's row carries no client id: it is addressed by its own
  // key, never by an empty one (audit U19).
  const keyOf = (row: { clientId: string | null }) => row.clientId ?? UNCLAIMED_KEY;
  const selected = clientId ? clientRows.find((c) => keyOf(c) === clientId) : null;
  const lots = selected ? await landedCostByLot(selected.clientId) : [];
  const unclaimedLabel = ta('unclaimedRow');

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <BackLink href="/reports" label={t('title')} />
      <div className="flex flex-wrap items-baseline gap-2">
        <PageHeader icon="wallet" title={t('landedCost')} />
        <a
          href={`/api/reports/landed-cost${selected ? `?clientId=${keyOf(selected)}` : ''}`}
          className="btn-secondary !min-h-9 ml-auto px-3 text-sm"
        >
          ⬇️ XLSX
        </a>
      </div>

      {unconvertedCount > 0 && (
        <p className="card !p-3 text-sm font-semibold text-warn" data-testid="landed-unconverted">
          ⚠{' '}
          {t('landedUnconverted', {
            count: unconvertedCount,
            sums: unconverted.map((row) => `${row.amount} ${row.currency}`).join(', '),
          })}
        </p>
      )}

      {selected ? (
        <>
          <Link href="/reports/landed-cost" className="text-sm font-semibold text-brand-700">
            ← {t('allClients')}
          </Link>
          <div className="card !p-3">
            <p className="mb-2 text-lg">
              {selected.clientId ? (
                <>
                  <span className="font-mono font-extrabold text-brand-700">{selected.clientCode}</span>{' '}
                  {selected.clientName}
                </>
              ) : (
                <span className="font-semibold text-warn">{unclaimedLabel}</span>
              )}{' '}
              — <b className="font-mono">${selected.totalUsd}</b>
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line-strong text-left text-xs uppercase text-ink-500">
                    <th className="p-1.5">{t('lot')}</th>
                    <th className="p-1.5">{t('product')}</th>
                    <th className="p-1.5 text-right">📦</th>
                    <th className="p-1.5 text-right">kg</th>
                    <th className="p-1.5 text-right">$</th>
                    <th className="p-1.5 text-right">$/📦</th>
                  </tr>
                </thead>
                <tbody>
                  {lots.map((lot) => (
                    <tr key={lot.lotId} className="border-b border-line last:border-0">
                      <td className="p-1.5 font-mono font-extrabold text-brand-700">
                        {selected.clientId ? lot.letter : `${lot.marking ?? '?'}-${lot.letter ?? ''}`}
                      </td>
                      <td className="max-w-52 truncate p-1.5">
                        {lot.productNameZh}
                        {lot.productNameRu && <span className="text-ink-500"> ({lot.productNameRu})</span>}
                      </td>
                      <td className="p-1.5 text-right">{lot.boxCount}</td>
                      <td className="p-1.5 text-right">{lot.kg}</td>
                      <td className="p-1.5 text-right font-mono font-semibold">${lot.totalUsd}</td>
                      <td className="p-1.5 text-right font-mono">${lot.usdPerBox}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className="card !p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line-strong bg-surface-sunken text-left text-xs uppercase text-ink-500">
                <th className="p-2">{t('client')}</th>
                <th className="p-2 text-right">📦</th>
                <th className="p-2 text-right">{t('landedCostUsd')}</th>
              </tr>
            </thead>
            <tbody>
              {clientRows.map((row) => (
                <tr key={keyOf(row)} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="p-2">
                    <Link href={`/reports/landed-cost?clientId=${keyOf(row)}`} className="flex items-baseline gap-2">
                      {row.clientId ? (
                        <>
                          <span className="font-mono font-extrabold text-brand-700">{row.clientCode}</span>
                          <span className="truncate text-ink-700">{row.clientName}</span>
                        </>
                      ) : (
                        <span className="font-semibold text-warn" data-testid="landed-unclaimed">
                          {unclaimedLabel}
                        </span>
                      )}
                    </Link>
                  </td>
                  <td className="p-2 text-right">{row.boxCount}</td>
                  <td className="p-2 text-right font-mono font-bold">${row.totalUsd}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {clientRows.length === 0 && <p className="p-4 text-sm text-ink-500">{t('noData')}</p>}
        </div>
      )}
    </div>
  );
}
