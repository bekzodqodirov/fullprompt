import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export default async function ProtectedNotFound() {
  const t = await getTranslations('common');
  return (
    <div className="mx-auto max-w-md space-y-4 p-6 text-center">
      <p className="text-4xl">🔍</p>
      <h1 className="text-xl font-bold">{t('notFoundTitle')}</h1>
      <p className="text-sm text-ink-700">{t('notFoundBody')}</p>
      <Link href="/" className="btn-primary inline-block px-6">
        🏠 {t('goHome')}
      </Link>
    </div>
  );
}
