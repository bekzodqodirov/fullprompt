import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { CompanyMoneySight } from '@/modules/wms/finance/scope';
import type { DashPeriod } from '@/modules/wms/reports/dashboard-math';
import { staffProfit } from '@/modules/wms/staff/seller-profit';
import { ScopeTag } from '@/components/charts/scope-tag';
import { usd } from '@/components/charts/format';
import { logger } from '@/modules/platform/logger';

/**
 * «Hodimlar keltirgan foyda» (0117, his 9): per seller, for the dashboard's
 * period, what their clients' cargo earned the firm and what they added by
 * upsale — /reports/sotuvchilar's profit and /upsale's «earned», read through
 * their own exported functions (`staffProfit`) and never re-derived here.
 *
 * The upsale is INSIDE the cargo profit, so the card never adds the two, and
 * it says so under the rows. The money half follows the client's CURRENT
 * seller (open point 4, stated), and it is company-wide whatever warehouse is
 * picked — a profit has no warehouse, and the tag says «Butun kompaniya».
 *
 * A soft-fail card: a read that throws renders the sentence, never the page's
 * error boundary. Phone first — each seller is a card of wrapping lines.
 */
export async function StaffProfitCard({ sight, period }: { sight: CompanyMoneySight; period: DashPeriod }) {
  const t = await getTranslations('dashboard');
  let data: Awaited<ReturnType<typeof staffProfit>> | null = null;
  try {
    data = await staffProfit({ from: period.from, to: period.to }, sight);
  } catch (err) {
    logger.error({ err }, '[dashboard] staff profit');
  }

  return (
    <div className="card min-w-0 space-y-2" data-testid="dash-staff-profit">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="font-semibold">{t('staffProfit.title')}</p>
        <ScopeTag label={t('scope.company')} />
        <Link href="/reports/sotuvchilar" className="ml-auto shrink-0 text-xs font-semibold text-brand-700">
          {t('staffProfit.report')} →
        </Link>
      </div>
      {data === null ? (
        <p className="text-sm text-warn">⚠ {t('staffProfit.failed')}</p>
      ) : data.rows.length === 0 ? (
        <p className="text-sm text-ink-500">{t('staffProfit.none')}</p>
      ) : (
        <ul className="space-y-1.5">
          {data.rows.map((row) => (
            <li
              key={row.sellerId ?? 'none'}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line/60 pb-1.5 text-sm last:border-0"
              data-testid="dash-staff-profit-row"
            >
              <span className="min-w-0 font-semibold">{row.sellerName ?? t('staffProfit.nobody')}</span>
              <span className="text-2xs text-ink-500">
                {t('staffProfit.cargo')}{' '}
                <span className={`font-mono text-sm font-bold tabular-nums ${row.cargoProfitUsd < 0 ? 'text-bad' : 'text-ink-900'}`}>
                  {usd(row.cargoProfitUsd)}
                </span>
              </span>
              <span className="text-2xs text-ink-500">
                {t('staffProfit.upsale')}{' '}
                <span className="font-mono text-sm tabular-nums text-ink-900">{usd(row.upsaleUsd)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-2xs text-ink-500">{t('staffProfit.note')}</p>
      {data?.upsaleTruncated ? <p className="text-2xs text-warn">{t('staffProfit.truncated')}</p> : null}
    </div>
  );
}
