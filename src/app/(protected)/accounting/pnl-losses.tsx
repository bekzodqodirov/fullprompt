import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { LossSummary } from '@/modules/wms/reports/business';

/**
 * «Yo'qotishlar» under the P&L (owner 6a: «yoqotishlar ham korinsin umumiy
 * hisobotda»). INFORMATION beside the table, never a row of it: the money
 * spent carrying a lost carton is already inside the cargo costs, so a line
 * here that the net profit subtracted would count it twice. Hence no figure
 * in the table's columns. But «inside the table ABOVE» was only true when
 * the period held the costs' dates (review): a carton lost in March rode on
 * freight typed in November, and «missing» is today's state with no date at
 * all — so the words name the month the cost was typed, and «missing» says
 * it is not the period's.
 *
 * Renders nothing when nothing was lost and nothing is missing — like the
 * gaps note above the table.
 */
export async function PnlLossesNote({ losses }: { losses: LossSummary }) {
  if (losses.lost.boxes === 0 && losses.missing.boxes === 0) return null;
  const t = await getTranslations('accounting');
  const usd = (value: number) =>
    value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const m3 = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 3 });
  return (
    <div className="card space-y-2 text-sm" data-testid="pnl-losses">
      <p className="font-semibold">{t('lossesTitle')}</p>
      {losses.lost.boxes > 0 && (
        <p className="text-bad" data-testid="pnl-losses-lost">
          ❌{' '}
          {t('lossesLost', {
            boxes: losses.lost.boxes,
            m3: m3(losses.lost.m3),
            usd: `$${usd(losses.lost.usd)}`,
          })}
        </p>
      )}
      {losses.missing.boxes > 0 && (
        <p className="text-warn" data-testid="pnl-losses-missing">
          ⚠{' '}
          {t('lossesMissing', {
            boxes: losses.missing.boxes,
            m3: m3(losses.missing.m3),
            usd: `$${usd(losses.missing.usd)}`,
          })}
        </p>
      )}
      <p className="text-xs text-ink-500">
        {t('lossesHint')}{' '}
        <Link href="/reports/yuk-xavfi" className="text-brand-700 underline">
          {t('lossesOpen')}
        </Link>
      </p>
    </div>
  );
}
