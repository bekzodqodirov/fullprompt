import { getTranslations } from 'next-intl/server';
import type { MyMonth } from '@/modules/wms/staff/my-month';

/**
 * «Bu oy» — the person's own month (0117, his 9 / 10a): salary, KPI and upsale
 * as their own lines and their sum as «Daromad», plus the work they did. The
 * advance lives in the staff-account panel right beside it and is not
 * repeated here.
 *
 * Every line names its clock, because three different ones meet here: the
 * salary is the template's month, the KPI the cargo's receipt month (and it
 * is «taxminiy» until the month closes on the 8th), the upsale the offer's day.
 */
export async function MyMonthPanel({ data, showAdvance }: { data: MyMonth; showAdvance: boolean }) {
  const t = await getTranslations('profile.month');
  const tp = await getTranslations('profile');
  const money = (n: number) => `$${n.toFixed(2)}`;
  const stateText = {
    paid: t('salaryPaid'),
    skipped: t('salarySkipped'),
    waiting: t('salaryWaiting'),
    not_due: t('salaryNotDue'),
  };

  return (
    <section className="card space-y-2 !p-3" data-testid="profile-month">
      <h2 className="text-lg font-bold">{t('title')}</h2>

      <div className="space-y-1 text-sm" data-testid="profile-month-salary">
        <p className="text-2xs uppercase text-ink-500">{t('salary')}</p>
        {data.salary.length === 0 ? <p className="text-ink-500">{t('salaryNone')}</p> : null}
        {data.salary.map((line, i) => (
          <p key={i} className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono font-bold tabular-nums">
              {line.amount.toLocaleString('en-US')} {line.currency}
            </span>
            <span className="text-2xs text-ink-500">{t('payDay', { day: line.dayOfMonth })}</span>
            <span className="text-2xs">{stateText[line.state]}</span>
          </p>
        ))}
      </div>

      {data.kpi ? (
        <div className="space-y-1 border-t border-line pt-2 text-sm" data-testid="profile-month-kpi">
          <p className="text-2xs uppercase text-ink-500">{t('kpi')}</p>
          <p>
            <span className="font-mono tabular-nums">{data.kpi.m3.toFixed(2)}</span> {t('m3')} ·{' '}
            <span className="font-mono tabular-nums">{Math.round(data.kpi.kg)}</span> kg
            {data.kpi.density !== null ? (
              <>
                {' '}
                · {t('density')} <span className="font-mono tabular-nums">{data.kpi.density}</span> kg/m³
              </>
            ) : null}
            {data.kpi.rate !== null ? (
              <>
                {' '}
                · <span className="font-mono tabular-nums">{money(data.kpi.rate)}</span>/{t('m3')}
              </>
            ) : null}
          </p>
          {data.kpi.outside ? <p className="text-ink-500">{t('kpiOutside')}</p> : null}
          {data.kpi.earnedUsd !== null ? (
            <p>
              {t('kpiEarned')}: <span className="font-mono font-bold tabular-nums">{money(data.kpi.earnedUsd)}</span>
              {data.kpi.earnedPaidUsd !== null ? (
                <>
                  {' · '}
                  {t('kpiPaidPart')}:{' '}
                  <span className="font-mono tabular-nums">{money(data.kpi.earnedPaidUsd)}</span>
                </>
              ) : (
                <span className="text-warn"> · {t('notComputed')}</span>
              )}
            </p>
          ) : null}
          {data.kpi.refusal && data.kpi.refusal !== 'no_cargo' && !data.kpi.outside ? (
            <p className="text-warn">⚠ {t('kpiRefused')}</p>
          ) : null}
          <p className="text-2xs text-ink-500">{t('kpiEstimate')}</p>
        </div>
      ) : null}

      {data.upsale ? (
        <div className="space-y-1 border-t border-line pt-2 text-sm" data-testid="profile-month-upsale">
          <p className="text-2xs uppercase text-ink-500">{t('upsale')}</p>
          <p>
            <span className="font-mono font-bold tabular-nums">{money(data.upsale.earnedUsd)}</span>{' '}
            <span className="text-2xs text-ink-500">{t('upsaleOffers', { n: data.upsale.offers })}</span>
          </p>
        </div>
      ) : null}

      <div className="border-t border-line pt-2 text-sm" data-testid="profile-month-income">
        <p className="text-2xs uppercase text-ink-500">{t('income')}</p>
        {data.incomeUsd !== null ? (
          <p className="font-mono text-lg font-bold tabular-nums">{money(data.incomeUsd)}</p>
        ) : (
          <p className="text-warn">⚠ {t('incomeNoRate')}</p>
        )}
        {data.salaryConverted && data.incomeUsd !== null ? (
          <p className="text-2xs text-ink-500">{t('converted')}</p>
        ) : null}
      </div>

      <div className="border-t border-line pt-2 text-sm" data-testid="profile-month-work">
        <p className="text-2xs uppercase text-ink-500">{t('work')}</p>
        <p className="text-ink-700">
          {t('workLine', { receipts: data.work.receipts, sealed: data.work.sealed, answered: data.work.answered })}
        </p>
      </div>
      {/* Points at the staff-account panel by its OWN title, and only when
          that panel is drawn — a person with no staff account has none. */}
      {showAdvance ? (
        <p className="text-2xs text-ink-500">{t('advanceHint', { panel: tp('staffAccountTitle') })}</p>
      ) : null}
    </section>
  );
}
