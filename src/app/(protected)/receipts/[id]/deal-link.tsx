'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { linkReceiptAction } from '../../bitimlar/actions';

/**
 * Which job this cargo belongs to, seen and corrected FROM THE CARGO.
 *
 * Until now the link only ever existed on the deal's side: the receiving
 * wizard offered a deal, and the deal card offered the client's *unlinked*
 * receipts. That left the commonest mistake with no way back — a receipt
 * attached to the wrong job disappeared from the deal card's picker (it is no
 * longer unlinked) and the receipt card said nothing about a deal at all, so
 * the owner could see the error and not undo it.
 *
 * The picker offers the client's OPEN deals plus, always, the one this receipt
 * is on even when that deal has since been won or lost — otherwise correcting
 * a mistake would first hide what the mistake was. The empty option detaches.
 *
 * Gated on the deal-write list, the same one the action enforces: this is
 * re-filing a job's cargo, which is the sales/VED power, not a warehouse one.
 */
export function DealLink({
  receiptId,
  current,
  options,
}: {
  receiptId: string;
  current: { id: string; code: string } | null;
  options: { id: string; code: string; title: string | null }[];
}) {
  const t = useTranslations('receipts');
  const td = useTranslations('deals');
  const tc = useTranslations('common');
  const router = useRouter();
  const [dealId, setDealId] = useState(current?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="card space-y-2 !p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold">{t('deal')}: </span>
        {current ? (
          <Link
            href={`/bitimlar/${current.id}`}
            className="font-mono font-bold text-brand-700 underline"
          >
            {current.code}
          </Link>
        ) : (
          <span className="text-ink-500">{t('dealNone')}</span>
        )}
      </div>
      <div className="flex gap-2">
        <select
          value={dealId}
          onChange={(event) => setDealId(event.target.value)}
          aria-label={t('deal')}
          data-testid="receipt-deal-pick"
          className="input min-w-0 flex-1"
        >
          <option value="">— {td('unlink')}</option>
          {options.map((deal) => (
            <option key={deal.id} value={deal.id}>
              {deal.code}
              {deal.title ? ` · ${deal.title}` : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={pending || dealId === (current?.id ?? '')}
          data-testid="receipt-deal-save"
          className="btn-primary shrink-0 disabled:opacity-50"
          onClick={() =>
            startTransition(async () => {
              const result = await linkReceiptAction(receiptId, dealId || null);
              setError(result.ok ? null : (result.error ?? 'error'));
              if (result.ok) router.refresh();
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
