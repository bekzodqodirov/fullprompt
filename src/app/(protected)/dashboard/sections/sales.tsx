import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { loadDecided, loadOpenDeals, loadSales, loadWindows } from '@/modules/wms/reports/dashboard';
import { compactUsd, num, pct } from '@/components/charts/format';
import { SERIES_BG } from '@/components/charts/legend';
import { stageClass } from '../../crm/stage-color';

/**
 * «Savdo» (spec «E»): is the funnel being worked, are we winning this month,
 * and how much open deal money is in hand. The funnel keeps the OWNER's stage
 * colours (the board's identity vocabulary, `stageClass`), and the win rate is
 * by the decision clock — the tahlil screen's own numbers (#513).
 */
export async function SalesSection({ ownerId, seesOutcome }: { ownerId: string; seesOutcome: boolean }) {
  const t = await getTranslations('dashboard');
  const tcrm = await getTranslations('crm');
  const w = loadWindows();
  const [sales, decided, deals] = await Promise.all([
    loadSales(ownerId),
    seesOutcome ? loadDecided() : null,
    seesOutcome ? loadOpenDeals() : null,
  ]);
  const max = Math.max(1, ...sales.byStage.map((row) => row.n));
  const month = decided?.find((row) => row.month === w.month);
  const decidedN = (month?.won ?? 0) + (month?.lost ?? 0);
  const winRate = decidedN > 0 ? ((month?.won ?? 0) / decidedN) * 100 : null;

  return (
    <section data-testid="section-salesTitle" className="space-y-3">
      <p className="section-title">🤝 {t('salesTitle')}</p>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="card min-w-0 space-y-2.5" data-testid="dash-funnel">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="font-mono text-2xl font-extrabold tabular-nums text-brand-700">{sales.open}</p>
              <p className="text-xs text-ink-500">{tcrm('leads')}</p>
            </div>
            <div>
              <p className="font-mono text-2xl font-extrabold tabular-nums text-good">{sales.wonMonth}</p>
              <p className="text-xs text-ink-500">{t('wonThisMonth')}</p>
            </div>
            <Link href="/crm/today">
              <p
                className={`font-mono text-2xl font-extrabold tabular-nums ${sales.dueToday ? 'text-warn' : 'text-ink-400'}`}
              >
                {sales.dueToday}
              </p>
              <p className="text-xs text-ink-500">{tcrm('today')}</p>
            </Link>
          </div>
          {/* One bar per open stage, widths in proportion, so a pile-up is
              visible without reading numbers. */}
          <div className="space-y-1">
            {sales.byStage.map((stage) => (
              <div key={stage.name} className="flex items-center gap-2">
                <span className="w-28 shrink-0 truncate text-xs font-semibold">{stage.name}</span>
                <div className="h-4 min-w-0 flex-1 overflow-hidden rounded bg-surface-sunken">
                  <div
                    className={`h-full rounded ${stageClass(stage.color)}`}
                    style={{ width: `${Math.max(stage.n > 0 ? 6 : 0, (stage.n / max) * 100)}%` }}
                  />
                </div>
                <span className="w-8 shrink-0 text-right font-mono text-xs font-bold tabular-nums">{stage.n}</span>
              </div>
            ))}
          </div>
          <Link href="/crm" className="text-sm font-semibold text-brand-700">
            {tcrm('funnel')} →
          </Link>
        </div>

        {seesOutcome && deals && (
          <div className="card min-w-0 space-y-2" data-testid="dash-winrate">
            <Link
              href={`/crm/tahlil?dan=${w.monthStart}&gacha=${w.today}`}
              className="flex items-baseline justify-between gap-2"
            >
              <p className="font-semibold">{t('winRateTitle')}</p>
              <span className="font-mono text-xl font-bold tabular-nums">{winRate === null ? '—' : pct(winRate)}</span>
            </Link>
            <div className="h-2 overflow-hidden rounded-full bg-surface-sunken">
              <div className={`h-full rounded-full ${SERIES_BG.in}`} style={{ width: `${winRate ?? 0}%` }} />
            </div>
            <p className="flex flex-wrap gap-x-1 text-xs text-ink-700">
              <span>
                {month?.won ?? 0} ✓ · {month?.lost ?? 0} ✗
              </span>
              <span className="font-mono tabular-nums"> · {compactUsd(month?.wonUsd ?? 0)}</span>
              {(month?.wonOtherCurrency ?? 0) > 0 && (
                <span className="text-ink-500"> · {t('otherCurrency', { n: month?.wonOtherCurrency ?? 0 })}</span>
              )}
            </p>
            <Link href="/bitimlar" className="flex flex-wrap gap-x-1 border-t border-line pt-2 text-xs">
              <span className="font-semibold">{t('openDeals', { n: num(deals.count) })}</span>
              <span className="font-mono tabular-nums"> · {compactUsd(deals.usdSum)}</span>
              {deals.otherCurrency > 0 && (
                <span className="text-ink-500"> · {t('otherCurrency', { n: deals.otherCurrency })}</span>
              )}
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}
