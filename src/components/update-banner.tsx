'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * "The server has a newer version than this screen."
 *
 * Three times in one week the answer to "it does not work" was "your phone is
 * showing yesterday's app". Installed to a home screen, this app keeps its
 * shell in a service-worker cache; a deploy replaces the server and the phone
 * goes on rendering the old page, so a button fixed an hour ago is simply not
 * there — and nobody, including the person who deployed it, can tell whether
 * the deploy landed or the cache is stale.
 *
 * So the app answers that question itself. The build stamp is baked into the
 * bundle at compile time; `/api/version` reports the server's. When they
 * differ, this bar appears and one tap does the whole cleanup a person would
 * otherwise be talked through on the phone: unregister the workers, delete
 * every cache, reload from the network.
 *
 * Polled rather than pushed, and on focus rather than on a timer alone,
 * because a warehouse phone spends its day in somebody's pocket: the check
 * that matters is the one that runs when the screen comes back on.
 */
const POLL_MS = 120_000;

export function UpdateBanner() {
  const t = useTranslations('common');
  const mine = process.env.NEXT_PUBLIC_BUILD_AT ?? '';
  const [serverBuild, setServerBuild] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    try {
      const res = await fetch('/api/version', { cache: 'no-store' });
      if (!res.ok) return;
      const { build } = (await res.json()) as { build: string };
      // Only ever compare — never trust an empty stamp on either side, or a
      // dev build with no stamp would nag on every page.
      if (build && mine && build !== mine) setServerBuild(build);
    } catch {
      /* offline: the phone is on the right build until proven otherwise */
    }
  }, [mine]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void check();
    const timer = setInterval(() => void check(), POLL_MS);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [check]);

  if (!serverBuild) return null;

  async function update() {
    setBusy(true);
    try {
      // Everything a person would otherwise be walked through by phone.
      const workers = await navigator.serviceWorker?.getRegistrations?.();
      await Promise.all((workers ?? []).map((worker) => worker.unregister()));
      const keys = await caches?.keys?.();
      await Promise.all((keys ?? []).map((key) => caches.delete(key)));
    } catch {
      /* a reload without the cleanup is still better than staying stale */
    }
    // A query string, because a plain reload can be served from the very
    // cache we are trying to escape.
    window.location.href = `${window.location.pathname}?v=${Date.now()}`;
  }

  return (
    <div
      data-testid="update-banner"
      className="sticky top-14 z-40 flex items-center gap-2 border-b border-warn/30 bg-warn/15 px-3 py-2 text-sm"
    >
      <span className="min-w-0 flex-1 font-semibold text-warn">🔄 {t('updateAvailable')}</span>
      <button
        type="button"
        onClick={() => void update()}
        disabled={busy}
        data-testid="update-now"
        className="btn-primary !min-h-9 shrink-0 px-3"
      >
        {busy ? t('loading') : t('updateNow')}
      </button>
    </div>
  );
}
