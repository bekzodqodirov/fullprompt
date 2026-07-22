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
        <h1 className="mb-1 text-center text-2xl font-extrabold text-blue-800">GSR LOGISTICS</h1>
        <p className="mb-6 text-center text-gray-600">{t('title')}</p>
        <LoginForm />
      </div>
    </main>
  );
}
