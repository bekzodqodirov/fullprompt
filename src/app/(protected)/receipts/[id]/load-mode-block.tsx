'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ReceiptLoadView } from '@/modules/wms/ftl/read';
import { setLinkedDealLoadAction, setReceiptLoadAction, type LoadActionResult } from './load-actions';

/**
 * «Yuk turi» on the prixod card (0135) — drawn only for somebody the door
 * lets act: the office (both ways), or the prixod's own seller (FTL only —
 * his 2a). Everybody else gets a chip when the prixod is FTL and nothing when
 * it is LTL, the cards' rule. The SOURCE sentence is worked out on the server
 * (`receiptLoadView`) from the stored row AND the deal as it stands now, so it
 * never claims «from the deal» about a prixod with no deal.
 */
export function LoadModeBlock({
  receiptId,
  view,
  office,
}: {
  receiptId: string;
  view: ReceiptLoadView;
  office: boolean;
}) {
  const t = useTranslations('ftl');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [refusal, setRefusal] = useState<LoadActionResult | null>(null);

  const run = (press: () => Promise<LoadActionResult>, warn?: string) => {
    if (warn && !window.confirm(warn)) return;
    setRefusal(null);
    start(async () => {
      const result = await press();
      if (result.ok) router.refresh();
      else setRefusal(result);
    });
  };

  const source =
    view.source === 'hand'
      ? t('source.hand')
      : view.source === 'deal'
        ? t('source.deal', { code: view.fromDealCode ?? '—' })
        : view.source === 'earlier_deal'
          ? t('source.earlierDeal', { code: view.fromDealCode ?? '—' })
          : view.source === 'not_reached'
            ? t('source.notReached', { code: view.deal?.code ?? '—' })
            : view.deal
              ? t('source.dealLtl', { code: view.deal.code })
              : t('source.default');

  return (
    <section className="card space-y-2 !p-3" data-testid="receipt-load">
      <p className="text-2xs uppercase text-ink-500">{t('label')}</p>
      <p className="text-sm">
        <span className={`chip ${view.mode === 'ftl' ? 'chip-neutral font-semibold' : 'chip-neutral'}`} data-testid="receipt-load-mode">
          {view.mode === 'ftl' ? `🚛 ${t('ftlLong')}` : t('ltlLong')}
        </span>
      </p>
      <p className="text-2xs text-ink-500" data-testid="receipt-load-source">
        {source}
      </p>
      {view.paid ? (
        <p className="text-2xs text-warn" data-testid="receipt-load-paid">
          🔒 {t('paidFrozen', { month: view.paid.month, seller: view.paid.sellerName ?? '—' })}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {view.mode === 'ltl' ? (
            <button
              type="button"
              className="btn-secondary"
              disabled={pending}
              data-testid="receipt-load-ftl"
              onClick={() => run(() => setReceiptLoadAction(receiptId, 'ftl'), office ? undefined : t('sellerWarn'))}
            >
              🚛 {t('makeFtl')}
            </button>
          ) : office ? (
            <button
              type="button"
              className="btn-secondary"
              disabled={pending}
              data-testid="receipt-load-ltl"
              onClick={() => run(() => setReceiptLoadAction(receiptId, 'ltl'))}
            >
              {t('makeLtl')}
            </button>
          ) : (
            <p className="text-2xs text-ink-500">{t('officeOnly')}</p>
          )}
        </div>
      )}
      {office && view.deal?.ftl ? (
        <div className="space-y-1 border-t border-line pt-2" data-testid="receipt-load-deal">
          <p className="text-2xs text-ink-600">{t('dealAlsoFtl', { code: view.deal.code })}</p>
          <button
            type="button"
            className="btn-secondary"
            disabled={pending}
            data-testid="receipt-load-deal-ltl"
            onClick={() => run(() => setLinkedDealLoadAction(receiptId, 'ltl'))}
          >
            {t('makeDealLtl', { code: view.deal.code })}
          </button>
        </div>
      ) : null}
      {refusal && !refusal.ok ? (
        <p role="alert" className="text-sm font-semibold text-bad" data-testid="receipt-load-error">
          {t(`errors.${refusal.error}` as 'errors.not_found', {
            month: refusal.month ?? '',
            seller: refusal.sellerName ?? '—',
          })}
        </p>
      ) : null}
    </section>
  );
}
