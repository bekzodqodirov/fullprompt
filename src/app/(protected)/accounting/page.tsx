import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { accountBalances } from '@/modules/wms/accounting/service';
import { Icon, type IconName } from '@/components/ui/icon';
import { Section } from '@/components/ui/page';

/** Accounting hub: the money on hand first, then the reports and the books. */
export default async function AccountingPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const canReport = actor.permissions.has('finance.reports');
  const canEnter = actor.permissions.has('finance.expenses');
  const t = await getTranslations('accounting');

  const reports: { href: string; icon: IconName; label: string }[] = [
    // Balans first: it is the one number the owner reads before anything
    // else, and since round 39 it is finally a whole one.
    { href: '/accounting/balance', icon: 'wallet', label: t('balance') },
    { href: '/accounting/pnl', icon: 'chart', label: t('pnl') },
    { href: '/accounting/cashflow', icon: 'exchange', label: t('cashflow') },
    { href: '/accounting/receivables', icon: 'clock', label: t('receivables') },
    { href: '/accounting/profit?view=batch', icon: 'truck', label: t('profitBatch') },
    { href: '/accounting/profit?view=client', icon: 'user', label: t('profitClient') },
    { href: '/accounting/profit?view=route', icon: 'map', label: t('profitRoute') },
  ];
  const books: { href: string; icon: IconName; label: string }[] = [
    { href: '/accounting/expenses', icon: 'doc', label: t('expenses') },
    { href: '/accounting/accounts', icon: 'wallet', label: t('accounts') },
    { href: '/accounting/categories', icon: 'clipboard', label: t('categories') },
  ];

  const balances = canReport || canEnter ? await accountBalances() : [];

  return (
    <div className="mx-auto max-w-lg space-y-5 md:max-w-3xl">
      {balances.length > 0 && (
        <Section title={t('balance')}>
          <div className="card divide-y divide-line !py-1">
            {balances
              .filter((row) => row.active)
              .map((row) => (
                <div key={row.id} className="flex items-baseline gap-3 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate text-ink-700">{row.name}</span>
                  <span className="font-mono font-bold tabular-nums">
                    {row.balance.toLocaleString('en-US')}
                  </span>
                  <span className="w-9 text-xs font-semibold text-ink-500">{row.currency}</span>
                </div>
              ))}
          </div>
        </Section>
      )}

      {canReport && (
        <Section title={t('period')}>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {reports.map((tile) => (
              <HubTile key={tile.href} {...tile} />
            ))}
          </div>
        </Section>
      )}

      {canEnter && (
        <Section title={t('expenses')}>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {books.map((tile) => (
              <HubTile key={tile.href} {...tile} />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function HubTile({ href, icon, label }: { href: string; icon: IconName; label: string }) {
  return (
    <Link href={href} className="card-tap flex items-center gap-3 !py-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1 text-sm font-bold [overflow-wrap:anywhere]">{label}</span>
      <Icon name="chevronRight" className="h-4 w-4 text-ink-400" />
    </Link>
  );
}
