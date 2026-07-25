import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { SubNav, type SubNavItem } from '@/components/ui/sub-nav';

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

  const items: SubNavItem[] = [
    { href: '/crm', label: t('today'), icon: 'phone', exact: true },
    { href: '/crm/leads', label: t('funnel'), icon: 'target' },
    { href: '/crm/dormant', label: t('dormant'), icon: 'sleep' },
    ...(actor.permissions.has('crm.manage')
      ? ([
          { href: '/crm/people', label: t('people'), icon: 'users' },
          { href: '/crm/settings', label: t('settings'), icon: 'settings' },
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
