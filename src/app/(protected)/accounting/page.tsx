import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { accountBalances } from '@/modules/wms/accounting/service';

/** Accounting hub: the reports on one side, the books on the other. */
export default async function AccountingPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const canReport = actor.permissions.has('finance.reports');
  const canEnter = actor.permissions.has('finance.expenses');
  const t = await getTranslations('accounting');

  const reports = [
    { href: '/accounting/pnl', icon: '📈', label: t('pnl') },
    { href: '/accounting/cashflow', icon: '💵', label: t('cashflow') },
    { href: '/accounting/receivables', icon: '⏳', label: t('receivables') },
    { href: '/accounting/profit?view=batch', icon: '🚛', label: t('profitBatch') },
    { href: '/accounting/profit?view=client', icon: '👤', label: t('profitClient') },
    { href: '/accounting/profit?view=route', icon: '🗺', label: t('profitRoute') },
  ];
  const books = [
    { href: '/accounting/expenses', icon: '🧾', label: t('expenses') },
    { href: '/accounting/accounts', icon: '🏦', label: t('accounts') },
    { href: '/accounting/categories', icon: '🗂', label: t('categories') },
  ];

  const balances = canReport || canEnter ? await accountBalances() : [];

  return (
    <div className="mx-auto max-w-lg space-y-5 md:max-w-3xl">
      <h1 className="text-xl font-bold">💼 {t('title')}</h1>

      {balances.length > 0 && (
        <div className="card space-y-1">
          <h2 className="text-sm font-bold uppercase text-gray-500">🏦 {t('balance')}</h2>
          {balances
            .filter((row) => row.active)
            .map((row) => (
              <div key={row.id} className="flex items-baseline gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                <span className="font-mono font-bold">
                  {row.balance.toLocaleString('en-US')} {row.currency}
                </span>
              </div>
            ))}
        </div>
      )}

      {canReport && (
        <section>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            {t('period')}
          </p>
          <div className="grid grid-cols-2 gap-3">
            {reports.map((tile) => (
              <Link
                key={tile.href}
                href={tile.href}
                className="card flex min-h-24 items-center justify-center text-center font-bold [overflow-wrap:anywhere] hover:bg-gray-100"
              >
                {tile.icon} {tile.label}
              </Link>
            ))}
          </div>
        </section>
      )}

      {canEnter && (
        <section>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            {t('expenses')}
          </p>
          <div className="grid grid-cols-2 gap-3">
            {books.map((tile) => (
              <Link
                key={tile.href}
                href={tile.href}
                className="card flex min-h-24 items-center justify-center text-center font-bold [overflow-wrap:anywhere] hover:bg-gray-100"
              >
                {tile.icon} {tile.label}
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
