import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { PnlGaps } from '@/modules/wms/accounting/reports';

/**
 * What the report above could not count, in words (audit A11, A31, U20).
 * Renders nothing when there is nothing to say — a warning that is always
 * there is one nobody reads.
 */
export async function PnlGapsNote({ gaps }: { gaps: PnlGaps }) {
  if (gaps.manualCharges.count === 0 && gaps.unconverted.count === 0 && gaps.onNoBox.count === 0) {
    return null;
  }
  const t = await getTranslations('accounting');
  const usd = (value: number) =>
    value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <div className="card space-y-2 border-warn/40 bg-warn/5 text-sm" data-testid="pnl-gaps">
      {gaps.manualCharges.count > 0 && (
        <div data-testid="pnl-gap-manual">
          <p className="font-semibold text-warn">
            ⚠{' '}
            {t('gapManualCharges', {
              count: gaps.manualCharges.count,
              usd: `$${usd(gaps.manualCharges.usd)}`,
            })}
          </p>
          <p className="text-xs text-ink-700">
            {t('gapManualChargesHint')}{' '}
            <Link href="/kontragentlar" className="text-brand-700 underline">
              {t('gapOpenPartners')}
            </Link>
          </p>
        </div>
      )}
      {gaps.unconverted.count > 0 && (
        <div data-testid="pnl-gap-unconverted">
          <p className="font-semibold text-warn">
            ⚠{' '}
            {t('gapUnconverted', {
              count: gaps.unconverted.count,
              sums: gaps.unconverted.byCurrency
                .map((row) => `${usd(row.amount)} ${row.currency}`)
                .join(', '),
            })}
          </p>
          <p className="text-xs text-ink-700">{t('gapUnconvertedHint')}</p>
        </div>
      )}
      {gaps.onNoBox.count > 0 && (
        <div data-testid="pnl-gap-no-box">
          <p className="font-semibold text-warn">
            ⚠ {t('gapNoBox', { count: gaps.onNoBox.count, usd: `$${usd(gaps.onNoBox.usd)}` })}
          </p>
          <p className="text-xs text-ink-700">{t('gapNoBoxHint')}</p>
        </div>
      )}
    </div>
  );
}
