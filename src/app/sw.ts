/// <reference lib="webworker" />
import { defaultCache } from '@serwist/next/worker';
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { NetworkOnly, Serwist } from 'serwist';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope & WorkerGlobalScope;

// App-shell caching (spec §3 Offline). The scan/receipt outbox arrives in
// M1/M3 — this worker only precaches static assets and applies sane runtime
// caching defaults.
const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      /**
       * The one request that must never be cached.
       *
       * `/api/version` reports the SERVER's build so an installed app can tell
       * it is showing yesterday's screen. Serwist's defaults put every
       * `/api/*` GET behind NetworkFirst, which caches the answer — and a
       * cached answer here is the stale build being asked "are you stale?"
       * and replying "no". Then the banner never appears and the operator
       * keeps tapping a button that was fixed an hour ago.
       */
      matcher: ({ url: { pathname }, sameOrigin }) => sameOrigin && pathname === '/api/version',
      handler: new NetworkOnly(),
    },
    ...defaultCache,
  ],
});

serwist.addEventListeners();
