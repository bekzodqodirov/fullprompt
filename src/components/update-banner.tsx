'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { isBuildStale, reloadFresh } from './build-check';

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
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);

  // The question and the cleanup live in build-check.ts — the calculation's
  // refused save asks the same one and offers the same reload.
  const check = useCallback(async () => {
    if (await isBuildStale()) setStale(true);
  }, []);

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

  if (!stale) return null;

  async function update() {
    setBusy(true);
    await reloadFresh();
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
