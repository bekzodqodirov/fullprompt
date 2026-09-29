import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { KpiMonthLine, KpiPayable } from '@/modules/wms/staff/kpi-service';
import type { StaffTemplate } from '@/modules/wms/staff/salary';
import { RecurringForm, RecurringRowEdit } from '../accounting/expenses/recurring-form';
import type { CategoryOption } from '../accounting/expenses/expense-form';
import type { PayPartner, PayTill } from '../accounting/expenses/recurring-due';
import { KpiPayForm } from './forms';

/**
 * One person on /hodimlar (0117, his 8a): the salary, then the KPI and the
 * upsale as SEPARATE lines — never folded into one «daromad» here, because
 * they are paid by three different presses on three different clocks (the
 * template's month, the cargo's receipt month, the offer's day), and each line
 * says which.
 *
 * Every figure is the service's; this file formats and nothing else. Phone
 * first: every line wraps, nothing is a table.
 */

export interface RecurringOptions {
  categories: CategoryOption[];
  accounts: { id: string; label: string }[];
  warehouses: { id: string; label: string }[];
  employees: { id: string; label: string }[];
  currencies: string[];
  partners: { id: string; label: string }[];
  tills: PayTill[];
  payPartners: PayPartner[];
}

const money = (n: number) => `$${n.toFixed(2)}`;

export async function StaffCard({
  person,
  salary,
  others,
  kpi,
  payable,
  kpiUnavailable,
  upsale,
  upsaleHref,
  mayPay,
  payAccounts,
  today,
  salaryCategoryId,
  options,
  tierLabel,
  bandLabel,
  closesOn,
}: {
  person: { id: string; name: string; active: boolean };
  salary: StaffTemplate[];
  others: StaffTemplate[];
  kpi: KpiMonthLine | undefined;
  payable: KpiPayable | undefined;
  /** The KPI reads ran out of their budget — «hisoblanmadi», never a $0. */
  kpiUnavailable: boolean;
  /** null = this viewer is not shown a colleague's upsale (`maySeeStaffUpsale`). */
  upsale: { earnedUsd: number; payableUsd: number } | null;
  upsaleHref: string;
  mayPay: boolean;
  payAccounts: { id: string; name: string; currency: string }[];
  today: string;
  salaryCategoryId: string;
  options: RecurringOptions;
  tierLabel: (top: number | null) => string;
  bandLabel: (top: number | null) => string;
  /** `DD.MM` the chosen month closes on. */
  closesOn: string;
}) {
  const t = await getTranslations('hodimlar');
  const stateText = { paid: t('salaryPaid'), skipped: t('salarySkipped'), waiting: t('salaryWaiting') };
  const stateClass = { paid: 'chip chip-good', skipped: 'chip chip-neutral', waiting: 'chip chip-warn' };
  const showKpi = kpi !== undefined || (payable !== undefined && (payable.payableUsd > 0 || payable.overpaidUsd > 0));

  return (
    <li className="card space-y-2 !p-3" data-testid="staff-card">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold">{person.name}</span>
        {!person.active ? <span className="chip chip-neutral">{t('inactive')}</span> : null}
      </div>

      {/* Oylik */}
      <div className="space-y-1" data-testid="staff-salary">
        <p className="text-2xs uppercase text-ink-500">{t('salary')}</p>
        {salary.length === 0 ? <p className="text-sm text-ink-500">{t('salaryNone')}</p> : null}
        {salary.map((tpl) => (
          <div key={tpl.id} className="flex flex-wrap items-baseline gap-2 text-sm">
            <span className="font-mono font-bold tabular-nums">
              {Number(tpl.amount).toLocaleString('en-US')} {tpl.currency}
            </span>
            <span className="text-2xs text-ink-500">{t('payDay', { day: tpl.dayOfMonth })}</span>
            <span className={stateClass[tpl.state]}>{stateText[tpl.state]}</span>
            <RecurringRowEdit
              id={tpl.id}
              amount={tpl.amount}
              dayOfMonth={tpl.dayOfMonth}
              active={tpl.active}
              cash={tpl.categoryCash}
              currency={tpl.currency}
              currencies={options.currencies}
              stored={{
                accountId: tpl.accountId,
                accountName: tpl.accountName,
                accountCurrency: tpl.accountCurrency,
                accountActive: tpl.accountActive,
                partnerId: tpl.partnerId,
                partnerName: tpl.partnerName,
                partnerActive: tpl.partnerActive,
              }}
              tills={options.tills}
              partners={options.payPartners}
            />
          </div>
        ))}
        {salary.length === 0 && options.categories.length > 0 ? (
          <details data-testid="staff-salary-new">
            <summary className="cursor-pointer text-xs font-semibold text-brand-700">✏️ {t('salarySet')}</summary>
            <div className="mt-2">
              <RecurringForm
                categories={options.categories}
                accounts={options.accounts}
                warehouses={options.warehouses}
                employees={options.employees}
                currencies={options.currencies}
                partners={options.partners}
                today={today}
                lockedEmployeeId={person.id}
                defaultCategoryId={salaryCategoryId || undefined}
              />
            </div>
          </details>
        ) : null}
        {others.length > 0 ? (
          <p className="text-2xs text-ink-600" data-testid="staff-other-templates">
            {t('otherRecurring')}:{' '}
            {others
              .map((tpl) => `${tpl.categoryName} ${Number(tpl.amount).toLocaleString('en-US')} ${tpl.currency}`)
              .join(' · ')}
          </p>
        ) : null}
      </div>

      {/* KPI */}
      {showKpi ? (
        <div className="space-y-1 border-t border-line pt-2" data-testid="staff-kpi">
          <p className="text-2xs uppercase text-ink-500">{t('kpi')}</p>
          {kpiUnavailable ? <p className="text-sm text-warn">⚠ {t('notComputed')}</p> : null}
          {kpi ? (
            kpi.outside ? (
              <p className="text-sm text-ink-500">{t('kpiOutside')}</p>
            ) : kpi.result.ok ? (
              <>
                <p className="text-sm" data-testid="staff-kpi-line">
                  <span className="font-mono tabular-nums">{kpi.result.m3.toFixed(2)}</span> {t('m3')} ·{' '}
                  <span className="font-mono tabular-nums">{Math.round(kpi.result.kg)}</span> kg · {t('density')}{' '}
                  <span className="font-mono tabular-nums">{kpi.result.density}</span> kg/m³ ·{' '}
                  {tierLabel(kpi.result.tierMaxM3)} / {bandLabel(kpi.result.bandMaxDensity)} ·{' '}
                  <span className="font-mono tabular-nums">{money(kpi.result.rate)}</span>/{t('m3')}
                </p>
                <p className="text-sm">
                  {t('earned')}: <span className="font-mono font-bold tabular-nums">{money(kpi.result.earnedUsd)}</span>
                  {' · '}
                  {t('earnedPaid')}:{' '}
                  <span className="font-mono font-bold tabular-nums" data-testid="staff-kpi-paid">
                    {money(kpi.earnedPaidUsd)}
                  </span>
                </p>
              </>
            ) : kpi.result.reason === 'no_cargo' ? (
              <p className="text-sm text-ink-500">{t('noCargo')}</p>
            ) : (
              <p className="text-sm text-warn">
                ⚠ {t(`refusal.${kpi.result.reason}`)}
                {kpi.result.receipts?.length ? ` (${kpi.result.receipts.join(', ')})` : ''}
              </p>
            )
          ) : null}
          {kpi && !kpi.closed ? <p className="text-2xs text-ink-500">{t('monthOpen', { day: closesOn })}</p> : null}
          {payable ? (
            <>
              {payable.overpaidUsd > 0 ? (
                <p className="text-sm text-warn" data-testid="staff-kpi-overpaid">
                  {t('overpaid', { amount: money(payable.overpaidUsd) })}
                </p>
              ) : (
                <p className="text-sm" data-testid="staff-kpi-payable">
                  {t('payable')}:{' '}
                  <span className="font-mono font-bold tabular-nums">{money(payable.payableUsd)}</span>
                </p>
              )}
              {payable.refusals.map((r) => (
                <p key={r.month} className="text-xs text-warn">
                  ⚠ {r.month}: {t(`refusal.${r.reason}`)}
                  {r.receipts?.length ? ` (${r.receipts.join(', ')})` : ''}
                </p>
              ))}
              {mayPay && payable.payableUsd > 0.009 && payable.refusals.length === 0 && payAccounts.length > 0 ? (
                <KpiPayForm sellerId={person.id} payableUsd={payable.payableUsd} accounts={payAccounts} today={today} />
              ) : null}
            </>
          ) : null}
          <p className="text-2xs text-ink-500">{t('reopenHint')}</p>
        </div>
      ) : null}

      {/* Upsale */}
      {upsale && (upsale.earnedUsd > 0 || upsale.payableUsd > 0) ? (
        <div className="flex flex-wrap items-baseline gap-2 border-t border-line pt-2 text-sm" data-testid="staff-upsale">
          <span className="text-2xs uppercase text-ink-500">{t('upsale')}</span>
          <span>
            {t('upsaleEarned')}: <span className="font-mono tabular-nums">{money(upsale.earnedUsd)}</span>
          </span>
          <span>
            {t('upsalePayable')}: <span className="font-mono tabular-nums">{money(upsale.payableUsd)}</span>
          </span>
          <Link href={upsaleHref} className="text-xs font-semibold text-brand-700">
            {t('upsaleLink')} →
          </Link>
        </div>
      ) : null}
    </li>
  );
}
