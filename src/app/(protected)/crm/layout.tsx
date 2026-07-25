import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';

/**
 * CRM section. A sales manager works their own leads; the owner and the
 * logist hold `crm.leads.view_all` and see everyone's; only `crm.manage`
 * reaches the settings that reshape the funnel for the whole company.
 */
export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.leads')) redirect('/');
  const t = await getTranslations('crm');

  const links = [
    { href: '/crm', label: `📞 ${t('today')}` },
    { href: '/crm/leads', label: `🎯 ${t('funnel')}` },
    { href: '/crm/dormant', label: `😴 ${t('dormant')}` },
    ...(actor.permissions.has('crm.manage')
      ? [
          { href: '/crm/people', label: `👥 ${t('people')}` },
          { href: '/crm/settings', label: `⚙️ ${t('settings')}` },
        ]
      : []),
  ];

  return (
    <>
      <nav className="-mx-4 -mt-4 mb-4 flex gap-1 overflow-x-auto border-b border-gray-200 bg-white px-4 py-2 text-sm font-semibold">
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
