'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
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
 *
 * A member of the lot's row of actions (docs/PRIXOD-KARTA.md §7.2): a button
 * of the row's one shape and a panel UNDER the row. It was a `<details>`
 * whose summary was a line of grey text — the sixth shape an action took on
 * one lot — and a `<details>` cannot be a row member: its summary lives
 * inside it, so the opened element takes the pressed button to a new line
 * with it. The opener carries a short word; the panel says the whole one.
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
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) panel.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [open]);

  if (options.length === 0) return null;
  const KNOWN = ['box_not_here', 'reason_required', 'forbidden', 'box_not_found'];

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        data-testid="mark-lost-open"
        className={`btn-secondary btn-sm${open ? ' bg-surface-sunken' : ''}`}
        onClick={() => setOpen((was) => !was)}
      >
        ⚠️ {t('markLostShort')}
      </button>
      {open && (
        <div ref={panel} className="order-last basis-full space-y-2 rounded-lg bg-surface-sunken p-3" data-testid="mark-lost-panel">
          <p className="text-sm font-semibold text-ink-700">⚠️ {t('markLostTitle')}</p>
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
      )}
    </>
  );
}
