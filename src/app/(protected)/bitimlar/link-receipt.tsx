'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { linkReceiptAction } from './actions';

/**
 * Attach cargo that arrived without being told which job it belonged to.
 *
 * This is the retro-fix for the common case: the warehouse confirmed a receipt
 * before anyone linked it, or the deal was raised afterwards. The picker only
 * offers THIS client's unlinked confirmed receipts — the service refuses a
 * cross-client link outright, because a receipt filed under the wrong client's
 * deal makes two clients' money wrong and is invisible afterwards.
 */
export function LinkReceipt({
  dealId,
  receipts,
}: {
  dealId: string;
  receipts: { id: string; number: string | null; receivedAt: Date }[];
}) {
  const t = useTranslations('deals');
  const tc = useTranslations('common');
  const [receiptId, setReceiptId] = useState('');
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <div className="card space-y-2 !p-2.5">
      <p className="section-title">{t('linkReceipt')}</p>
      <div className="flex gap-2">
        <select
          value={receiptId}
          onChange={(event) => setReceiptId(event.target.value)}
          aria-label={t('linkReceipt')}
          data-testid="link-receipt-pick"
          className="input min-w-0 flex-1"
        >
          <option value="">—</option>
          {receipts.map((receipt) => (
            <option key={receipt.id} value={receipt.id}>
              {receipt.number} · {receipt.receivedAt.toISOString().slice(0, 10)}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!receiptId || pending}
          data-testid="link-receipt-save"
          className="btn-primary shrink-0"
          onClick={() =>
            startTransition(async () => {
              const result = await linkReceiptAction(receiptId, dealId);
              setError(!result.ok);
              if (result.ok) setReceiptId('');
            })
          }
        >
          {pending ? tc('loading') : tc('save')}
        </button>
      </div>
      {error && <p className="text-sm font-semibold text-bad">{tc('error')}</p>}
    </div>
  );
}
