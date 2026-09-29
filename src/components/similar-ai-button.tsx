'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

/**
 * «AI bilan qidirish» — drawn ONLY inside an empty «📈 Oldingi narx» body
 * (owner's 18a: the model is asked when the free search found nothing). A
 * press, never a render: the route asks the model, stores which past lots it
 * named, and the page is refreshed to read their prices from the ledger.
 *
 * Every refusal is a sentence (#163: a LITERAL map, so the i18n tripwire sees
 * each key); a code the map does not know reads as «failed», never as a key.
 */
const ERRORS = {
  not_configured: 'priceHistoryAiError.not_configured',
  budget: 'priceHistoryAiError.budget',
  found_free: 'priceHistoryAiError.found_free',
  failed: 'priceHistoryAiError.failed',
  forbidden: 'priceHistoryAiError.forbidden',
  already: 'priceHistoryAiError.already',
} as const;

type ErrorCode = keyof typeof ERRORS;

export function SimilarAiButton({ lotId, batchId }: { lotId: string; batchId: string }) {
  const t = useTranslations('finance');
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);

  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pricing/similar/${lotId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ batchId }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && body.ok) {
        router.refresh();
        return;
      }
      // Only the door's 404 means «not yours»; a 500 is a blip, not a refusal.
      const code = res.status === 404 ? 'forbidden' : !res.ok ? 'failed' : (body.error ?? 'failed');
      setError(code in ERRORS ? (code as ErrorCode) : 'failed');
    } catch {
      setError('failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <button
        type="button"
        className="btn-secondary !min-h-11"
        disabled={busy}
        onClick={ask}
        data-testid="price-history-ai"
      >
        {busy ? t('priceHistoryAiBusy') : `🤖 ${t('priceHistoryAiAsk')}`}
      </button>
      {error ? (
        <p className="text-xs text-warn" data-testid="price-history-ai-error">
          {t(ERRORS[error])}
        </p>
      ) : null}
    </div>
  );
}
