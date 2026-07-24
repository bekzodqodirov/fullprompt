import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { logoutAction } from '@/modules/platform/auth/actions';
import { LocaleSwitcher } from '@/components/locale-switcher';

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('nav');

  const isAdmin = actor.permissions.has('admin.warehouses.manage');

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col">
      <header className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-gray-200 bg-white px-3 py-2">
        <Link href="/" className="text-lg font-extrabold text-blue-800">
          GSR
        </Link>
        <div className="min-w-0 flex-1" />
        <LocaleSwitcher current={actor.locale} />
        <Link
          href="/profile"
          aria-label={t('profile')}
          className="btn-secondary !min-h-10 !px-2.5 text-sm"
        >
          👤
        </Link>
        <form action={logoutAction}>
          <button
            type="submit"
            aria-label={t('logout')}
            className="btn-secondary !min-h-10 !px-2.5 text-sm"
          >
            ⏻
          </button>
        </form>
      </header>
      {isAdmin && (
        <nav className="flex gap-1 overflow-x-auto border-b border-gray-200 bg-white px-4 py-2 text-sm font-semibold">
          <Link href="/admin/warehouses" className="rounded-md px-3 py-2 hover:bg-gray-100">
            {t('warehouses')}
          </Link>
          <Link href="/admin/clients" className="rounded-md px-3 py-2 hover:bg-gray-100">
            {t('clients')}
          </Link>
          <Link href="/admin/users" className="rounded-md px-3 py-2 hover:bg-gray-100">
            {t('users')}
          </Link>
          <Link href="/admin/settings" className="rounded-md px-3 py-2 hover:bg-gray-100">
            {t('settings')}
          </Link>
          <Link href="/admin/audit" className="rounded-md px-3 py-2 hover:bg-gray-100">
            {t('audit')}
          </Link>
          <Link href="/admin/notifications" className="rounded-md px-3 py-2 hover:bg-gray-100">
            {t('notifications')}
          </Link>
        </nav>
      )}
      <main className="flex-1 p-4">{children}</main>
    </div>
  );
}
