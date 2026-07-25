import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';

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

  const links = [
    ...(canReport
      ? [
          { href: '/accounting/pnl', label: `📈 ${t('pnl')}` },
          { href: '/accounting/cashflow', label: `💵 ${t('cashflow')}` },
          { href: '/accounting/receivables', label: `⏳ ${t('receivables')}` },
          { href: '/accounting/profit', label: `🚛 ${t('profitBatch')}` },
        ]
      : []),
    ...(canEnter
      ? [
          { href: '/accounting/expenses', label: `🧾 ${t('expenses')}` },
          { href: '/accounting/accounts', label: `🏦 ${t('accounts')}` },
          { href: '/accounting/categories', label: `🗂 ${t('categories')}` },
        ]
      : []),
  ];

  return (
    <>
      <nav className="-mx-4 -mt-4 mb-4 flex gap-1 overflow-x-auto border-b border-gray-200 bg-white px-4 py-2 text-sm font-semibold">
        <Link href="/accounting" className="whitespace-nowrap rounded-md px-3 py-2 hover:bg-gray-100">
          💼 {t('title')}
        </Link>
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="whitespace-nowrap rounded-md px-3 py-2 hover:bg-gray-100"
          >
            {link.label}
          </Link>
        ))}
      </nav>
      {children}
    </>
  );
}
