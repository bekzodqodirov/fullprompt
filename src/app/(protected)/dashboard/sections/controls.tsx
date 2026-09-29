import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { hrefWith } from '@/components/list/board-filter';
import { DASH_PERIODS, type DashPeriodKey } from '@/modules/wms/reports/dashboard-math';

/**
 * The page's two questions — «over which days» and «which warehouse» — as a
 * row of LINKS and a GET form, so the dashboard stays a server page with one
 * client island (the chart tooltip). A link carries the other choice with it
 * (`hrefWith`, #514): picking «7 kun» must not drop the chosen warehouse.
 *
 * Six cells: two rows of three on a phone (one row of six would leave ~50 px a
 * cell, and «Прошлая неделя» is wider than that), one row from `md`. The
 * labels may still wrap onto two lines inside a 44 px cell rather than push
 * the page wider (#400).
 */
export async function DashControls({
  period,
  ombor,
  options,
}: {
  period: DashPeriodKey;
  ombor: string | null;
  /** The viewer's warehouses; the picker is drawn only when there is a choice. */
  options: { id: string; code: string; name: string }[];
}) {
  const t = await getTranslations('dashboard');
  // Literal — a key built from the period's name escapes the i18n tripwire (#163).
  const LABEL: Record<DashPeriodKey, string> = {
    bugun: t('period.bugun'),
    '7': t('period.d7'),
    hafta: t('period.hafta'),
    '30': t('period.d30'),
    oy: t('period.oy'),
    otgan: t('period.otgan'),
  };
  const current: Record<string, string> = ombor ? { ombor } : {};

  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3" data-testid="dash-controls">
      <nav aria-label={t('period.label')} className="grid grid-cols-3 gap-1 rounded-xl bg-surface-sunken p-1 md:w-[32rem] md:grid-cols-6">
        {DASH_PERIODS.map((key) => {
          const active = key === period;
          return (
            <Link
              key={key}
              href={hrefWith(current, { davr: key === 'oy' ? undefined : key })}
              aria-current={active ? 'page' : undefined}
              data-testid={`dash-period-${key}`}
              className={`flex min-h-11 items-center justify-center rounded-lg px-1 text-center text-xs font-semibold leading-tight ${
                active ? 'bg-surface-raised text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-900'
              }`}
            >
              {LABEL[key]}
            </Link>
          );
        })}
      </nav>
      {options.length > 1 && (
        <form method="get" className="flex min-w-0 items-center gap-2" data-testid="dash-ombor">
          {period !== 'oy' && <input type="hidden" name="davr" value={period} />}
          <label htmlFor="dash-ombor-select" className="shrink-0 text-xs font-semibold text-ink-500">
            {t('ombor.label')}
          </label>
          {/* A native select sizes to its longest option: the wrapper is what
              lets it shrink on a phone instead of widening the page (O22). */}
          <div className="min-w-0 flex-1 md:w-56 md:flex-none">
            <select id="dash-ombor-select" name="ombor" defaultValue={ombor ?? ''} className="input">
              <option value="">{t('ombor.all')}</option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.code} · {option.name}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn-secondary shrink-0">
            {t('ombor.apply')}
          </button>
        </form>
      )}
    </div>
  );
}
