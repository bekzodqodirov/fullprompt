'use client';

import { useCallback, useState, type ComponentProps } from 'react';
import { useTranslations } from 'next-intl';
import { truckDealErrorKey } from '@/components/truck-deal-errors';
import { PricingForm } from './pricing-form';
import { PricingTable } from './pricing-table';

/** What both bodies take from the page — the same for the client either way. */
interface SharedProps {
  clientId: string;
  batchId: string;
  currencies: string[];
  today: string;
  dealsSeen: string;
  pricesSeen: string;
  secondBill: { n: number; codes: string } | null;
}
type Own<P> = Omit<P, keyof SharedProps | 'onResult'>;

/**
 * One client card's price door — the per-deal table for a client with two or
 * more of his own deals aboard, the single form for everybody else — and the
 * LAST REFUSAL, held here (docs/NARX-VA-RAQAM.md §3.1.8). A `deals_changed`
 * that turns a table client into a single-form one (or back) remounts the
 * body, and a sentence held in the body's own action state went with it: the
 * person pressed, the page redrew a blank form, and nothing said why (judge
 * P1-UX-5). The wrapper sits at the same place on every redraw, so the
 * sentence survives the flip; the typed amounts of a flipped body do not
 * (stated — a figure typed for one shape is not a figure for the other).
 */
export function ClientPricing({
  shared,
  table,
  single,
  codes,
}: {
  shared: SharedProps;
  table: Own<ComponentProps<typeof PricingTable>> | null;
  single: Own<ComponentProps<typeof PricingForm>> | null;
  /** Deal id → code (and 'none' → «bitimsiz»), so a row's refusal names its row. */
  codes: Record<string, string>;
}) {
  const t = useTranslations('finance');
  const tc = useTranslations('common');
  const [last, setLast] = useState<{ error: string; dealId?: string } | null>(null);
  const onResult = useCallback((result: { ok?: boolean; error?: string; dealId?: string }) => {
    setLast(result.error ? { error: result.error, dealId: result.dealId } : null);
  }, []);
  const props = { ...shared, onResult };

  const code = last?.dealId ? (codes[last.dealId] ?? last.dealId) : null;
  const words = (error: string): string => {
    if (error === 'validation') return code ? t('truckTableRowUnreadable', { code }) : t('amountUnreadable');
    if (error === 'amount_too_large') return code ? `${code}: ${tc('amountTooLarge')}` : tc('amountTooLarge');
    if (error === 'fx_missing') return t('fxMissing');
    if (error === 'internal_batch') return t('internalBatchRefused');
    if (error === 'client_not_aboard') return t('clientNotAboard');
    if (error === 'batch_cancelled') return t('batchCancelledRefused');
    if (error === 'forbidden') return tc('forbidden');
    const key = truckDealErrorKey(error);
    if (key) return code ? `${code}: ${t(key)}` : t(key);
    return tc('error');
  };

  return (
    <div className="space-y-2" data-testid="pricing-door">
      {table ? <PricingTable {...props} {...table} /> : single ? <PricingForm {...props} {...single} /> : null}
      {last && (
        <p
          role="alert"
          className="w-full text-sm font-semibold text-bad [overflow-wrap:anywhere]"
          data-testid="pricing-form-error"
          data-error={last.error}
        >
          {words(last.error)}
        </p>
      )}
    </div>
  );
}
