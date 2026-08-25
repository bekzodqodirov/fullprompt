'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { markBoxLostAction } from './actions';

export interface LostBoxOption {
  boxId: string;
  shortCode: string;
  status: string;
}

/**
 * Write off ONE carton — crushed, soaked, thrown out (owner, 2026-08-25:
 * «yuk sklatda shikaslanib musorga chiqib ketsa nima qilaman»). A fold per
 * lot, manager-only (the page renders it behind `receipts.void`), reason
 * mandatory. The MONEY stays untouched by design — the client's bill is the
 * damage-discount conversation on the deal, a person's decision.
 */
export function MarkLostForm({
  receiptId,
  options,
}: {
  receiptId: string;
  options: LostBoxOption[];
}) {
  const t = useTranslations('receipts');
  const tc = useTranslations('common');
  const [boxId, setBoxId] = useState('');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<{ ok: boolean; error?: string; shortCode?: string } | null>(
    null,
  );
  const [pending, start] = useTransition();

  if (options.length === 0) return null;
  const KNOWN = ['box_not_here', 'reason_required', 'forbidden', 'box_not_found'];

  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-sm font-semibold text-ink-500">
        ⚠️ {t('markLostTitle')}
      </summary>
      <div className="mt-2 space-y-2">
        <select
          aria-label={t('markLostBox')}
          data-testid="mark-lost-box"
          className="input"
          value={boxId}
          onChange={(e) => setBoxId(e.target.value)}
        >
          <option value="">{t('markLostBox')}</option>
          {options.map((o) => (
            <option key={o.boxId} value={o.boxId}>
              {o.shortCode}
            </option>
          ))}
        </select>
        <input
          data-testid="mark-lost-reason"
          className="input"
          placeholder={t('markLostReason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          type="button"
          data-testid="mark-lost-submit"
          className="btn-danger disabled:opacity-50"
          disabled={pending || !boxId || reason.trim().length < 3}
          onClick={() =>
            start(async () => {
              const res = await markBoxLostAction({ boxId, receiptId, reason });
              setResult(res);
              if (res.ok) {
                setBoxId('');
                setReason('');
              }
            })
          }
        >
          {pending ? tc('loading') : `❌ ${t('markLostBtn')}`}
        </button>
        {result?.ok && (
          <p className="text-sm font-semibold text-good" data-testid="mark-lost-done">
            ✅ {t('markLostDone', { code: result.shortCode ?? '' })}
          </p>
        )}
        {result && !result.ok && (
          <p role="alert" className="text-sm font-semibold text-bad">
            {KNOWN.includes(result.error ?? '')
              ? t(`markLostErrors.${result.error}` as 'markLostErrors.box_not_here')
              : (result.error ?? '')}
          </p>
        )}
      </div>
    </details>
  );
}
