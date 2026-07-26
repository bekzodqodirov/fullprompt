import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { clientBalances } from '@/modules/wms/finance/service';
import { FinanceClientSearch } from './client-search';
import { PageHeader } from '@/components/ui/page';

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

  const rows = await clientBalances();
  const totalDebt = rows.filter((r) => r.balanceUsd > 0).reduce((a, r) => a + r.balanceUsd, 0);

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <PageHeader icon="wallet" title={t('title')} />
      {actor.permissions.has('finance.manage') && <FinanceClientSearch />}
      <div className="card flex items-baseline gap-2">
        <span className="text-sm text-ink-700">{t('totalDebt')}:</span>
        <span className="font-mono text-lg font-extrabold text-bad">
          ${totalDebt.toFixed(2)}
        </span>
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
