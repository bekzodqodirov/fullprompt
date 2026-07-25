'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  closeBatchAction,
  finishUnloadAction,
  resolveMissingAction,
  unloadRemainingAction,
} from '../batch-actions-server';

interface MissingBox {
  boxId: string;
  shortCode: string;
  label: string;
}

/** Destination-side controls: finish unload, resolve missing boxes, close. */
export function UnloadActions({
  batchId,
  status,
  missing,
  remaining,
  canUnload,
  canResolve,
  canClose,
}: {
  batchId: string;
  status: string;
  missing: MissingBox[];
  /** Manifest boxes still waiting to be accepted at the destination. */
  remaining: number;
  canUnload: boolean;
  canResolve: boolean;
  canClose: boolean;
}) {
  const t = useTranslations('unloading');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setPending(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) setError(res.error ?? 'error');
      router.refresh();
      return res;
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      {['in_transit', 'arrived'].includes(status) && (
        <p className="rounded-lg bg-gray-50 p-2 text-sm font-semibold" data-testid="unload-remaining">
          {remaining > 0 ? `📦 ${t('remaining', { n: remaining })}` : `✅ ${t('allAccepted')}`}
        </p>
      )}

      {/* The truck is standing in the yard: accepting everything must be at
          least as easy as finishing, or the operator reaches for the button
          that declares the cargo lost (owner's report). */}
      {['in_transit', 'arrived'].includes(status) && remaining > 0 && canUnload && (
        <button
          type="button"
          data-testid="accept-all"
          className="btn-primary w-full disabled:opacity-50"
          disabled={pending}
          onClick={async () => {
            if (!window.confirm(t('acceptAllConfirm', { n: remaining }))) return;
            const res = (await run(() => unloadRemainingAction(batchId))) as {
              ok: boolean;
              accepted?: number;
            };
            if (res.ok) setSummary(`✅ ${t('acceptAllDone', { n: res.accepted ?? 0 })}`);
          }}
        >
          📥 {t('acceptAll', { n: remaining })}
        </button>
      )}

      {['in_transit', 'arrived'].includes(status) && (
        <button
          type="button"
          data-testid="finish-unload"
          className={`w-full disabled:opacity-50 ${remaining > 0 ? 'btn-secondary' : 'btn-primary'}`}
          disabled={pending}
          onClick={async () => {
            // Finishing with boxes left over marks them lost — never let that
            // happen on a tap the operator read as "accept everything".
            if (remaining > 0 && !window.confirm(t('finishConfirm', { n: remaining }))) return;
            const res = (await run(() => finishUnloadAction(batchId))) as {
              ok: boolean;
              missing?: string[];
            };
            if (res.ok) {
              setSummary(
                res.missing && res.missing.length > 0
                  ? `🔍 ${t('missingSummary', { n: res.missing.length })}: ${res.missing.join(', ')}`
                  : `✅ ${t('allUnloaded')}`,
              );
            }
          }}
        >
          🏁 {t('finishUnload')}
        </button>
      )}
      {summary && <p className="rounded-lg bg-blue-50 p-2 text-sm font-semibold">{summary}</p>}

      {missing.length > 0 && (
        <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-sm font-bold">🔍 {t('missingTitle')}</p>
          {canResolve && missing.length > 1 && (
            <button
              type="button"
              data-testid="found-here-all"
              className="btn-primary w-full disabled:opacity-50"
              disabled={pending}
              onClick={async () => {
                // The whole truck arrived but was accepted without scanning —
                // one tap lands everything here instead of 13 taps.
                if (!window.confirm(t('foundHereAllConfirm', { n: missing.length }))) return;
                setPending(true);
                setError(null);
                try {
                  for (const box of missing) {
                    const res = await resolveMissingAction({ boxId: box.boxId, resolution: 'found_here' });
                    if (!res.ok) setError(res.error ?? 'error');
                  }
                  router.refresh();
                } finally {
                  setPending(false);
                }
              }}
            >
              ✅ {t('foundHereAll', { n: missing.length })}
            </button>
          )}
          {missing.map((box) => (
            <div key={box.boxId} className="space-y-1.5 rounded-lg bg-white p-2 text-sm">
              <p>
                <span className="font-mono font-bold">{box.shortCode}</span>{' '}
                <span className="font-mono font-extrabold text-blue-800">{box.label}</span>
              </p>
              {canResolve && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn-secondary flex-1 !min-h-9 px-2 text-xs"
                    disabled={pending}
                    onClick={() =>
                      run(() => resolveMissingAction({ boxId: box.boxId, resolution: 'found_at_origin' }))
                    }
                  >
                    ↩️ {t('foundAtOrigin')}
                  </button>
                  <button
                    type="button"
                    data-testid={`found-here-${box.shortCode}`}
                    className="btn-secondary flex-1 !min-h-9 px-2 text-xs"
                    disabled={pending}
                    onClick={() =>
                      run(() => resolveMissingAction({ boxId: box.boxId, resolution: 'found_here' }))
                    }
                  >
                    ✅ {t('foundHere')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {status === 'unloaded' && canClose && (
        <button
          type="button"
          data-testid="close-batch"
          className="btn-secondary w-full disabled:opacity-50"
          disabled={pending}
          onClick={() => run(() => closeBatchAction(batchId))}
        >
          🔒 {t('closeBatch')}
        </button>
      )}
      {pending && <p className="text-sm">{tc('loading')}</p>}
      {error && <p className="rounded-lg bg-red-50 p-2 text-sm font-semibold text-red-800">{error}</p>}
    </div>
  );
}
