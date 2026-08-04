import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSessionUser } from '@/modules/platform/auth/session';
import { LoginForm } from './login-form';

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect('/');
  const t = await getTranslations('login');

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="card w-full max-w-sm">
        {/* The lockup, not a typed-out name — this is the first screen
            anyone sees, on a phone handed over in a warehouse. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo-full.png"
          alt="GSR GROUP"
          width={344}
          height={93}
          className="mx-auto mb-4 h-16 w-auto"
        />
        <p className="mb-6 text-center text-ink-700">{t('title')}</p>
        <LoginForm />
      </div>
    </main>
  );
}
