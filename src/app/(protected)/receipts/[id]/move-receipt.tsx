'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { moveReceiptAction } from './actions';

/**
 * Wrong-warehouse fix (edge case 15): manager moves the whole receipt.
 * Allowed only while everything is still in stock; after the move the UI
 * prompts a label reprint (stickers keep the original WH code).
 */
export function MoveReceipt({
  receiptId,
  currentWarehouseId,
  warehouses,
}: {
  receiptId: string;
  currentWarehouseId: string;
  warehouses: { id: string; code: string }[];
}) {
  const t = useTranslations('receipts');
  const tc = useTranslations('common');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [toWarehouseId, setToWarehouseId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [movedTo, setMovedTo] = useState<string | null>(null);

  const options = warehouses.filter((wh) => wh.id !== currentWarehouseId);

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const res = await moveReceiptAction({ receiptId, toWarehouseId });
      if (res.ok) {
        setMovedTo(res.toCode ?? '');
        setOpen(false);
        router.refresh();
      } else {
        setError(res.error ?? 'error');
      }
    } finally {
      setPending(false);
    }
  }

  if (movedTo) {
    return (
      <div className="rounded-lg border border-good/30 bg-good/10 p-3 text-sm font-semibold">
        ✅ {t('movedTo', { wh: movedTo })} — 🖨 {t('movedReprintHint')}
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" className="btn-secondary w-full" onClick={() => setOpen(true)}>
        🚚 {t('moveReceipt')}
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-brand-200 bg-brand-50 p-3">
      <p className="text-sm font-semibold">{t('moveReceiptHint')}</p>
      <select
        data-testid="move-wh"
        aria-label={t('moveReceipt')}
        className="input font-mono font-bold"
        value={toWarehouseId}
        onChange={(e) => setToWarehouseId(e.target.value)}
      >
        <option value="">—</option>
        {options.map((wh) => (
          <option key={wh.id} value={wh.id}>
            {wh.code}
          </option>
        ))}
      </select>
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="move-confirm"
          className="btn-primary flex-1 disabled:opacity-50"
          disabled={pending || !toWarehouseId}
          onClick={submit}
        >
          {pending ? tc('loading') : `🚚 ${t('moveReceipt')}`}
        </button>
        <button type="button" className="btn-secondary flex-1" onClick={() => setOpen(false)}>
          {tc('cancel')}
        </button>
      </div>
      {error && <p className="text-sm font-semibold text-bad">{t(`moveErrors.${error}` as never) || error}</p>}
    </div>
  );
}
