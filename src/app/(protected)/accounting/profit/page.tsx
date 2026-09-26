import { marginPct } from '@/modules/wms/accounting/margin';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import {
  clientProfitGaps,
  pnlGaps,
  profitByBatch,
  profitByClient,
  profitByRoute,
  untrackedTrips,
  unbatchedMoney,
} from '@/modules/wms/accounting/reports';
import { resolvePeriod } from '@/modules/wms/accounting/period';
import { tripTotals } from '@/modules/wms/reports/dashboard-math';
import { PeriodForm } from '../period-form';
import { PnlGapsNote } from '../pnl-gaps';

type View = 'batch' | 'client' | 'route';

/**
 * Profitability: revenue against cost, per batch, client or corridor.
 *
 * This is the report that answers "did that trip earn money?" — both sides of
 * a batch belong to the batch whatever month they were entered, so unlike the
 * monthly P&L nothing here is distorted by a price agreed after the costs
 * were booked.
 */
export default async function ProfitPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; view?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.reports')) redirect('/accounting');
  const t = await getTranslations('accounting');
  const tf = await getTranslations('finance');
  const params = await searchParams;
  const { from, to } = resolvePeriod(params);
  const view: View = params.view === 'client' || params.view === 'route' ? params.view : 'batch';

  const usd = (value: number) =>
    value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const profitClass = (value: number) => (value >= 0 ? 'text-good' : 'text-bad');

  const tabs: { key: View; label: string }[] = [
    { key: 'batch', label: t('profitBatch') },
    { key: 'client', label: t('profitClient') },
    { key: 'route', label: t('profitRoute') },
  ];

  // One truck read for both truck tabs; the table shows only the trucks a
  // person marked «Partiya» (0107), and what it left out is said below it.
  const trips = view === 'client' ? null : await profitByBatch(from, to);
  const untracked = trips ? untrackedTrips(trips) : null;
  const rows =
    view === 'batch'
      ? trips!.filter((row) => row.tracked)
      : view === 'client'
        ? await profitByClient(from, to)
        : await profitByRoute(from, to, trips!);

  const [gaps, unbatched, clientGaps] = await Promise.all([
    pnlGaps(from, to),
    view === 'client' ? Promise.resolve(null) : unbatchedMoney(from, to),
    view === 'client' ? clientProfitGaps(from, to) : Promise.resolve(null),
  ]);

  // An internal leg is a cost row with no profit (R2a), and its cost is
  // already inside the cross-border truck's figure as «shu reysgacha» — so it
  // stays out of the totals, or that money would be counted twice. Every
  // other truck row is disjoint (U16), so summing them counts money once.
  const isInternal = (row: (typeof rows)[number]) => 'internal' in row && row.internal;
  // Unclaimed cargo cost us money too (#980/#1010): on the client tab it is a
  // row of its own inside the Jami, so the tab reconciles to the P&L (U19).
  // Never a row of `profitByClient` — the seller report would file it under
  // the «—» cohort of unassigned clients.
  const unclaimedUsd = clientGaps && clientGaps.unclaimed.usd > 0.009 ? clientGaps.unclaimed.usd : 0;
  const totals = tripTotals(
    unclaimedUsd > 0
      ? [...rows, { revenueUsd: 0, costUsd: unclaimedUsd, profitUsd: -unclaimedUsd }]
      : rows,
  );
  const unbatchedCost = unbatched?.noTruckCost;
  const unbatchedCostUsd = unbatchedCost
    ? unbatchedCost.lostUsd + unbatchedCost.issuedUsd + unbatchedCost.waitingUsd
    : 0;
  // A literal map — a runtime key is a key no bundle test can see (#163).
  const gapScope: Record<string, string> = {
    batch: t('gapScope.batch'),
    pickup: t('gapScope.pickup'),
    receipt: t('gapScope.receipt'),
    crate: t('gapScope.crate'),
  };
  const anyInternal = rows.some(isInternal);
  const unallocated = rows.filter((row) => 'unallocatedUsd' in row && row.unallocatedUsd > 0.009);
  const unallocatedUsd = unallocated.reduce(
    (sum, row) => sum + ('unallocatedUsd' in row ? row.unallocatedUsd : 0),
    0,
  );
  // Revenue owed by clients whose cargo did not ride (0104). The note counts
  // TRUCKS, so it speaks on the batch tab only (a corridor is not a truck);
  // every row and the JAMI carry the part on both tabs. Internal rows stay
  // out, as they do of the totals.
  const noCargoRows = rows.filter(
    (row) =>
      view === 'batch' && 'noCargoChargeUsd' in row && row.noCargoChargeUsd > 0.009 && !isInternal(row),
  );
  const noCargoUsd = noCargoRows.reduce(
    (sum, row) => sum + ('noCargoChargeUsd' in row ? row.noCargoChargeUsd : 0),
    0,
  );

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-5xl">
      <h1 className="text-xl font-bold">
        🚛 {tabs.find((tab) => tab.key === view)!.label}
      </h1>

      <div className="flex flex-wrap gap-1">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={`/accounting/profit?view=${tab.key}&from=${from}&to=${to}`}
            className={`rounded-lg px-3 py-2 text-sm font-semibold ${
              tab.key === view ? 'bg-brand-600 text-white' : 'bg-surface-sunken hover:bg-surface-sunken'
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      <PeriodForm from={from} to={to} exportHref={`/api/accounting/profit?view=${view}`} />
      <PnlGapsNote gaps={gaps} />

      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-line-strong bg-surface-sunken text-left text-xs uppercase text-ink-500">
                <th className="p-2">
                  {view === 'batch' ? t('batch') : view === 'client' ? t('client') : t('route')}
                </th>
                {view === 'batch' && <th className="p-2">{t('route')}</th>}
                {view !== 'client' && <th className="p-2 text-right">{t('boxes')}</th>}
                <th className="p-2 text-right">{t('revenue')} $</th>
                <th className="p-2 text-right">{t('cost')} $</th>
                <th className="p-2 text-right">{t('profit')} $</th>
                <th className="p-2 text-right">{t('margin')}</th>
                {view !== 'client' && <th className="p-2 text-right">{t('perKg')}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && unclaimedUsd === 0 && (
                <tr>
                  <td colSpan={8} className="p-3 text-center text-ink-500">
                    {t('empty')}
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr
                  key={'batchId' in row ? row.batchId : 'clientId' in row ? row.clientId : row.route}
                  className="border-b border-line"
                >
                  <td className="p-2 font-mono font-bold">
                    {'code' in row ? (
                      <Link href={`/batches/${row.batchId}`} className="text-brand-700">
                        {row.code}
                      </Link>
                    ) : 'clientCode' in row ? (
                      <>
                        <span className="text-brand-700">{row.clientCode}</span>
                        <span className="ml-2 font-sans font-normal text-ink-700">
                          {row.clientName}
                        </span>
                      </>
                    ) : (
                      row.route
                    )}
                  </td>
                  {view === 'batch' && 'route' in row && <td className="p-2 font-mono">{row.route}</td>}
                  {view !== 'client' && 'boxCount' in row && (
                    <td className="p-2 text-right">{row.boxCount}</td>
                  )}
                  <td className="p-2 text-right font-mono">
                    {usd(row.revenueUsd)}
                    {/* 0104 under his (a): a PART of the revenue, never taken out. */}
                    {'noCargoChargeUsd' in row && row.noCargoChargeUsd > 0.009 && (
                      <span className="block text-xs font-semibold text-warn" data-testid="profit-no-cargo">
                        ⚠ {tf('noCargoPart', { usd: `$${usd(row.noCargoChargeUsd)}` })}
                      </span>
                    )}
                  </td>
                  <td className="p-2 text-right font-mono" data-testid="profit-cost">
                    {usd(row.costUsd)}
                    {'prevUsd' in row && row.prevUsd > 0.009 && (
                      <span className="block text-xs text-ink-500" title={tf('prevLegs')}>
                        ↩ {usd(row.prevUsd)}
                      </span>
                    )}
                    {'unallocatedUsd' in row && row.unallocatedUsd > 0.009 && (
                      <span className="block text-xs font-semibold text-warn">
                        ⚠ {usd(row.unallocatedUsd)}
                      </span>
                    )}
                  </td>
                  {row.profitUsd === null ? (
                    <td className="p-2 text-right text-ink-500" data-testid="profit-internal">
                      —
                    </td>
                  ) : (
                    <td className={`p-2 text-right font-mono font-bold ${profitClass(row.profitUsd)}`}>
                      {usd(row.profitUsd)}
                    </td>
                  )}
                  <td className="p-2 text-right">{row.marginPct === null ? '—' : `${row.marginPct}%`}</td>
                  {view !== 'client' && 'profitPerKg' in row && (
                    <td className="p-2 text-right font-mono">{row.profitPerKg ?? '—'}</td>
                  )}
                </tr>
              ))}
              {unclaimedUsd > 0 && clientGaps && (
                <tr className="border-b border-line" data-testid="profit-unclaimed">
                  <td className="p-2">
                    <span className="font-semibold">{t('unclaimedRow')}</span>
                    <span className="block text-xs text-ink-500">
                      {t('unclaimedRowHint', { receipts: clientGaps.unclaimed.receipts })}
                    </span>
                  </td>
                  <td className="p-2 text-right font-mono">{usd(0)}</td>
                  <td className="p-2 text-right font-mono">{usd(unclaimedUsd)}</td>
                  <td className={`p-2 text-right font-mono font-bold ${profitClass(-unclaimedUsd)}`}>
                    {usd(-unclaimedUsd)}
                  </td>
                  <td className="p-2 text-right">—</td>
                </tr>
              )}
              {(rows.length > 0 || unclaimedUsd > 0) && (
                <tr className="border-t-2 border-line-strong font-bold">
                  <td className="p-2" colSpan={view === 'batch' ? 3 : view === 'route' ? 2 : 1}>
                    {t('total')}
                  </td>
                  <td className="p-2 text-right font-mono">
                    {usd(totals.revenue)}
                    {totals.noCargo > 0.009 && (
                      <span className="block text-xs font-semibold text-warn">
                        {tf('noCargoPart', { usd: `$${usd(totals.noCargo)}` })}
                      </span>
                    )}
                  </td>
                  <td className="p-2 text-right font-mono">{usd(totals.cost)}</td>
                  <td className={`p-2 text-right font-mono ${profitClass(totals.profit)}`}>
                    {usd(totals.profit)}
                  </td>
                  <td className="p-2 text-right">
                    {marginPct(totals.profit, totals.revenue) === null ? '—' : `${marginPct(totals.profit, totals.revenue)}%`}
                  </td>
                  {view !== 'client' && <td />}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {untracked && untracked.count > 0 && (
        <details className="card !p-3 text-sm text-ink-700" data-testid="profit-untracked">
          <summary className="cursor-pointer">
            ℹ️{' '}
            {t('untrackedNote', {
              count: untracked.count,
              revenue: `$${usd(untracked.revenueUsd)}`,
              cost: `$${usd(untracked.costUsd)}`,
            })}
          </summary>
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs">
            {untracked.rows.map((row) => (
              <Link key={row.batchId} href={`/batches/${row.batchId}`} className="text-brand-700">
                {row.code}
              </Link>
            ))}
          </p>
        </details>
      )}
      {anyInternal && (
        <p className="text-xs text-ink-500" data-testid="profit-internal-note">
          {t('internalRowsNote')}
        </p>
      )}
      {noCargoRows.length > 0 && (
        <p className="card !p-3 text-sm font-semibold text-warn" data-testid="profit-no-cargo-note">
          ⚠ {t('noCargoNote', { count: noCargoRows.length, usd: `$${usd(noCargoUsd)}` })}
        </p>
      )}
      {unallocated.length > 0 && (
        <p className="card !p-3 text-sm font-semibold text-warn" data-testid="profit-unallocated">
          ⚠{' '}
          {t('unallocatedNote', { usd: `$${usd(unallocatedUsd)}`, count: unallocated.length })}
        </p>
      )}
      {clientGaps && clientGaps.unallocated.usd > 0.009 && (
        <p className="card !p-3 text-sm font-semibold text-warn" data-testid="profit-client-unallocated">
          ⚠{' '}
          {t('clientUnallocatedNote', {
            usd: `$${usd(clientGaps.unallocated.usd)}`,
            count: clientGaps.unallocated.count,
            scopes: clientGaps.unallocated.byScope
              .map((row) => gapScope[row.scope] ?? row.scope)
              .join(', '),
          })}
        </p>
      )}
      {/* Said when EITHER half has money (U37): the cost half — cargo that
          rode no priced truck — used to be silent whenever the revenue half
          was zero. */}
      {unbatched && (unbatched.revenueUsd > 0.009 || unbatchedCostUsd > 0.009 || unbatched.compensationUsd > 0.009) && (
        <div className="card space-y-1 !p-3 text-sm text-ink-700" data-testid="profit-unbatched">
          {unbatched.revenueUsd > 0.009 && (
            <p>ℹ️ {t('unbatchedNote', { revenue: `$${usd(unbatched.revenueUsd)}` })}</p>
          )}
          {/* Compensation for lost cargo (0105): on no truck and taken off the
              P&L's revenue, so the tables and the P&L still reconcile. */}
          {unbatched.compensationUsd > 0.009 && (
            <p data-testid="profit-unbatched-compensation">
              ℹ️ {t('unbatchedCompensation', { amount: `$${usd(unbatched.compensationUsd)}` })}
            </p>
          )}
          {unbatchedCost && unbatchedCostUsd > 0.009 && (
            <p data-testid="profit-unbatched-cost">
              ℹ️{' '}
              {t('unbatchedCostNote', {
                lost: `$${usd(unbatchedCost.lostUsd)}`,
                issued: `$${usd(unbatchedCost.issuedUsd)}`,
                waiting: `$${usd(unbatchedCost.waitingUsd)}`,
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
