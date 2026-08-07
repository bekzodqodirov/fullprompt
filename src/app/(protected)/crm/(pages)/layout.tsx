import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { SubNav, type SubNavItem } from '@/components/ui/sub-nav';

/**
 * The CRM section pages that are NOT the board (round 73).
 *
 * The owner threw the tab strip off the funnel («tepada bir qator bo'lib
 * zvonki, nastroyka — menga yoqmayabti, yo'qot») — the board's ⋯ menu
 * carries these doors now. The strip survives HERE, on the pages it names,
 * where a second row costs nothing: they scroll, the board does not.
 */
export default async function CrmPagesLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.leads')) redirect('/');
  const t = await getTranslations('crm');

  const items: SubNavItem[] = [
    { href: '/crm', label: t('funnel'), icon: 'target', exact: true },
    { href: '/crm/today', label: t('today'), icon: 'phone' },
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
