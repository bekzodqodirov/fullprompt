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
      {/* The admin nav lives in the admin layout — it used to sit here and
          followed the user onto every operational screen (owner). */}
      <main className="flex-1 p-4">{children}</main>
    </div>
  );
}
