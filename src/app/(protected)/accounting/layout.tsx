import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { SubNav, type SubNavItem } from '@/components/ui/sub-nav';
import { isAnalyst } from '@/modules/platform/ai/tools';

/**
 * Management accounting section.
 *
 * Gated hard: profit and overheads are the owner's and the accountant's
 * business (owner's answer 7). A sales manager holds `finance.view` and sees
 * client balances — they must never reach the company's margin from here.
 */
export default async function AccountingLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const canReport = actor.permissions.has('finance.reports');
  const canEnter = actor.permissions.has('finance.expenses');
  if (!canReport && !canEnter) redirect('/');
  const t = await getTranslations('accounting');

  const items: SubNavItem[] = [
    { href: '/accounting', label: t('title'), icon: 'briefcase', exact: true },
    ...(canReport
      ? ([
          { href: '/accounting/pnl', label: t('pnl'), icon: 'chart' },
          { href: '/accounting/cashflow', label: t('cashflow'), icon: 'exchange' },
          { href: '/accounting/receivables', label: t('receivables'), icon: 'clock' },
          { href: '/accounting/profit', label: t('profitBatch'), icon: 'truck' },
        ] as SubNavItem[])
      : []),
    // The owner's monthly plan (0102, 5a) — his and the admin's alone (4a).
    ...(canReport && isAnalyst(actor)
      ? ([{ href: '/accounting/reja', label: t('reja'), icon: 'calendar' }] as SubNavItem[])
      : []),
    ...(canEnter
      ? ([
          { href: '/accounting/expenses', label: t('expenses'), icon: 'doc' },
          { href: '/accounting/accounts', label: t('accounts'), icon: 'wallet' },
          // 0101: the cargo costs whose kassa only the accountant can name.
          { href: '/accounting/xarajat-kassa', label: t('costKassa'), icon: 'exchange' },
          { href: '/accounting/categories', label: t('categories'), icon: 'clipboard' },
        ] as SubNavItem[])
      : []),
  ];

  return (
    <>
      <SubNav items={items} />
      {children}
    </>
  );
}
