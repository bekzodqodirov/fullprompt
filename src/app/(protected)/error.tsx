'use client';

import { useTranslations } from 'next-intl';

/**
 * Friendly error boundary (UX round): a server error used to surface as a
 * raw Next.js digest screen — now the user gets a plain explanation, a retry
 * and a way home. The digest stays visible in small print for support.
 */
export default function ProtectedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('common');

  return (
    <div className="mx-auto max-w-md space-y-4 p-6 text-center">
      <p className="text-4xl">😵</p>
      <h1 className="text-xl font-bold">{t('errorTitle')}</h1>
      <p className="text-sm text-gray-600">{t('errorBody')}</p>
      {error.digest && <p className="font-mono text-xs text-gray-400">#{error.digest}</p>}
      <div className="flex justify-center gap-2">
        <button type="button" className="btn-primary px-6" onClick={() => reset()}>
          🔄 {t('retry')}
        </button>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- full reload on purpose: recover from broken client state */}
        <a href="/" className="btn-secondary px-6">
          🏠 {t('goHome')}
        </a>
      </div>
    </div>
  );
}
