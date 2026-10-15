/**
 * «Is this screen older than the server?» and the one way out of it.
 *
 * Every deploy salts the server-action ids afresh, so an action pressed from
 * a tab opened before the deploy THROWS — on the calculation that read «check
 * the connection», which is false and sends a VED to blame his phone. The
 * honest sentence is «the app was updated — reload», and the reload has to be
 * the WHOLE cleanup (the workers, the caches, then the page from the
 * network), or a service worker serves him the same old shell again.
 *
 * ONE home for both halves: `UpdateBanner` asks the same question and offers
 * the same reload, so the bar and a refused save can never disagree about
 * what «updated» means.
 */

/** True only when BOTH stamps exist and differ; offline is «not stale» — the
 * phone is on the right build until proven otherwise. */
export async function isBuildStale(): Promise<boolean> {
  const mine = process.env.NEXT_PUBLIC_BUILD_AT ?? '';
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    if (!res.ok) return false;
    const { build } = (await res.json()) as { build?: string };
    // Never trust an empty stamp on either side, or a dev build with no
    // stamp would nag on every page.
    return Boolean(build && mine && build !== mine);
  } catch {
    return false;
  }
}

/** Everything a person would otherwise be walked through by phone: every
 * worker unregistered, every cache deleted (each step on its own — a reload
 * without the cleanup is still better than staying stale), then the page
 * from the network under a query string a cache cannot answer. */
export async function reloadFresh(): Promise<void> {
  try {
    const workers = await navigator.serviceWorker?.getRegistrations?.();
    await Promise.all((workers ?? []).map((worker) => worker.unregister()));
  } catch {
    /* no workers to let go of */
  }
  try {
    const keys = await caches?.keys?.();
    await Promise.all((keys ?? []).map((key) => caches.delete(key)));
  } catch {
    /* no caches to empty */
  }
  window.location.href = `${window.location.pathname}?v=${Date.now()}`;
}
