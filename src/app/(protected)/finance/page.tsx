import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { clientBalances, clientTotals } from '@/modules/wms/finance/service';
import { moneyOwnerFilter } from '@/modules/wms/finance/scope';
import { FinanceClientSearch } from './client-search';
import { PageHeader } from '@/components/ui/page';
import { moneyHidden } from '@/modules/platform/rbac/money-sight';

/**
 * Finance home (Phase 2.1): every client with ledger activity and their USD
 * balance. Positive balance = the client owes us (debtor, red).
 */
export default async function FinancePage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.view') && !actor.permissions.has('finance.manage')) {
    redirect('/');
  }
  const t = await getTranslations('finance');

  // A seller reads their own book: `finance.view` is a door, not a licence
  // over every client's money (see finance/scope.ts). The total below sums
  // these rows, so it narrows with them and cannot contradict the table.
  const rows = await clientBalances(moneyOwnerFilter(actor));
  // The Balans's own arithmetic over these rows (U15): «Jami qarzdorlik» is
  // its «Mijozlar qarzi» line and the advances its «Mijozlar avansi» — that
  // line links here, and a figure that can be checked nowhere is not checked.
  const { receivable: totalDebt, advances: totalAdvances } = clientTotals(rows);

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <PageHeader
        icon="wallet"
        title={t('title')}
        actions={
          <>
            {/* 0104: landed cargo with no price — the list the counter's ban
                reads, same door and same money scope as this page. It names
                debts and cargo and never a till or a cost, so the VED keeps
                it (his «19 a»). */}
            <Link href="/finance/narxsiz" className="btn-secondary px-3 text-sm" data-testid="finance-unbilled-link">
              💰 {t('unbilledLink')}
            </Link>
            {/* The register is closed to a reader the kassa is hidden from
                (Q19) — a door that bounces is worse than none (#420). */}
            {moneyHidden('kassa', actor.permissions) ? undefined : (
              <Link href="/finance/reestr" className="btn-secondary px-3 text-sm">
                📒 {t('paymentsRegister')}
              </Link>
            )}
          </>
        }
      />
      {actor.permissions.has('finance.manage') && <FinanceClientSearch />}
      <div className="card flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="flex items-baseline gap-2">
          <span className="text-sm text-ink-700">{t('totalDebt')}:</span>
          <span className="font-mono text-lg font-extrabold text-bad">
            ${totalDebt.toFixed(2)}
          </span>
        </span>
        {totalAdvances > 0 && (
          <span className="flex items-baseline gap-2" data-testid="finance-total-advances">
            <span className="text-sm text-ink-700">{t('totalAdvances')}:</span>
            <span className="font-mono text-lg font-extrabold text-bad">
              ${totalAdvances.toFixed(2)}
            </span>
          </span>
        )}
      </div>
      <div className="card overflow-x-auto !p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase text-ink-500">
              <th className="p-3">{t('client')}</th>
              <th className="p-3 text-right">{t('charges')}</th>
              <th className="p-3 text-right">{t('payments')}</th>
              <th className="p-3 text-right">{t('balance')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.clientId} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                <td className="p-0">
                  <Link href={`/finance/${r.clientId}`} className="block p-3">
                    <span className="font-mono font-extrabold text-brand-700">{r.clientCode}</span>{' '}
                    <span className="text-ink-700">{r.clientName}</span>
                  </Link>
                </td>
                <td className="p-3 text-right font-mono">${r.chargesUsd.toFixed(2)}</td>
                <td className="p-3 text-right font-mono">${r.paymentsUsd.toFixed(2)}</td>
                <td
                  className={`p-3 text-right font-mono font-bold ${
                    r.balanceUsd > 0.009 ? 'text-bad' : 'text-good'
                  }`}
                >
                  ${r.balanceUsd.toFixed(2)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="p-4 text-center text-ink-500">
                  {t('empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-500">{t('balanceHint')}</p>
    </div>
  );
}
