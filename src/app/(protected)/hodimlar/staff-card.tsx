import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { KpiMonthLine, KpiPayable } from '@/modules/wms/staff/kpi-service';
import type { StaffTemplate } from '@/modules/wms/staff/salary';
import { RecurringForm, RecurringRowEdit } from '../accounting/expenses/recurring-form';
import type { CategoryOption } from '../accounting/expenses/expense-form';
import type { PayPartner, PayTill } from '../accounting/expenses/recurring-due';
import { KpiPayForm, NoLoginPersonActive, NoLoginPersonTools } from './forms';

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
  ownHref,
  upsale,
  upsaleHref,
  mayPay,
  mayGiveLogin,
  salaryUnavailable,
  openSalaryForm,
  payAccounts,
  today,
  salaryCategoryId,
  options,
  tierLabel,
  bandLabel,
  closesOn,
}: {
  person: { id: string; name: string; active: boolean; loginEnabled: boolean; phone: string | null };
  salary: StaffTemplate[];
  others: StaffTemplate[];
  kpi: KpiMonthLine | undefined;
  payable: KpiPayable | undefined;
  /**
   * The KPI reads ran out of their budget and this person carries cargo —
   * «hisoblanmadi», never a $0 and never a missing section: the block is
   * drawn on this flag ALONE, because the failed reads' answers are empty.
   */
  kpiUnavailable: boolean;
  /** This person's own pass (`?hodim=`) — the fast one, where «KPI to'lash» still is. */
  ownHref: string;
  /** null = this viewer is not shown a colleague's upsale (`maySeeStaffUpsale`). */
  upsale: { earnedUsd: number; payableUsd: number; notComputed: number } | null;
  upsaleHref: string;
  mayPay: boolean;
  /** `admin.users.manage` — the «Tizimga kirish ochish» link to /admin/users is drawn only for them (0120). */
  mayGiveLogin: boolean;
  /**
   * The salary reads failed: the card says so and offers NO «Oylik kiritish»
   * — nobody mints a duplicate template while the page cannot see the first.
   */
  salaryUnavailable: boolean;
  /** Land here open: the person was just added, or `?hodim=` asked for them (2b). */
  openSalaryForm: boolean;
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
  const stateText = {
    paid: t('salaryPaid'),
    skipped: t('salarySkipped'),
    waiting: t('salaryWaiting'),
    not_due: t('salaryNotDue'),
  };
  const stateClass = {
    paid: 'chip chip-good',
    skipped: 'chip chip-neutral',
    waiting: 'chip chip-warn',
    not_due: 'chip chip-neutral',
  };
  const showKpi =
    kpiUnavailable ||
    kpi !== undefined ||
    (payable !== undefined && (payable.payableUsd > 0 || payable.overpaidUsd > 0));

  return (
    <li className="card space-y-2 !p-3" data-testid="staff-card">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="min-w-0 [overflow-wrap:anywhere] font-semibold">{person.name}</span>
        {!person.active ? <span className="chip chip-neutral">{t('inactive')}</span> : null}
        {/* A person who never signs in (0120, his 2b): paid here, a colleague
            nowhere else. The way to a login is the admin's, on /admin/users. */}
        {!person.loginEnabled ? (
          <span className="chip chip-neutral" data-testid="staff-no-login">
            {t('noLogin')}
          </span>
        ) : null}
        {!person.loginEnabled && person.active && mayGiveLogin ? (
          <Link
            href={`/admin/users/${person.id}`}
            className="text-xs font-semibold text-brand-700"
            data-testid="staff-enable-login"
          >
            {t('enableLogin')}
          </Link>
        ) : null}
        {!person.loginEnabled ? (
          <NoLoginPersonActive person={{ id: person.id, name: person.name, active: person.active }} />
        ) : null}
      </div>

      {/* Oylik */}
      <div className="space-y-1" data-testid="staff-salary">
        <p className="text-2xs uppercase text-ink-500">{t('salary')}</p>
        {salaryUnavailable ? (
          <p className="text-sm text-warn" data-testid="staff-salary-unknown">
            {t('salaryUnknown')}
          </p>
        ) : salary.length === 0 ? (
          <p className="text-sm text-ink-500">{t('salaryNone')}</p>
        ) : null}
        {salary.map((tpl) => (
          <div key={tpl.id} className="flex flex-wrap items-baseline gap-2 text-sm">
            <span className="font-mono font-bold tabular-nums">
              {Number(tpl.amount).toLocaleString('en-US')} {tpl.currency}
            </span>
            <span className="text-2xs text-ink-500">{t('payDay', { day: tpl.dayOfMonth })}</span>
            {/* The state is THIS month's (whatever `?oy` the KPI shows) — named. */}
            <span className={stateClass[tpl.state]} data-testid="staff-salary-state">
              {t('salaryMonth', { month: tpl.month })} {stateText[tpl.state]}
            </span>
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
        {/* A leaver gets no NEW template (the review's F1 — the service
            refuses it too): the way back is «Qayta faollashtirish», the
            header's button for a person who never signs in, the admin's for a
            login. An existing template still shows and still stops above. */}
        {!salaryUnavailable && salary.length === 0 && !person.active ? (
          <p className="text-2xs text-ink-600" data-testid="staff-salary-inactive">
            {person.loginEnabled ? t('salaryInactiveLogin') : t('salaryInactive')}
          </p>
        ) : null}
        {!salaryUnavailable && salary.length === 0 && person.active && options.categories.length > 0 ? (
          <details data-testid="staff-salary-new" open={openSalaryForm}>
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

      {!person.loginEnabled ? (
        <NoLoginPersonTools person={{ id: person.id, name: person.name, phone: person.phone }} />
      ) : null}

      {/* KPI */}
      {showKpi ? (
        <div className="space-y-1 border-t border-line pt-2" data-testid="staff-kpi">
          <p className="text-2xs uppercase text-ink-500">{t('kpi')}</p>
          {kpiUnavailable ? (
            <p className="text-sm text-warn" data-testid="staff-kpi-unavailable">
              ⚠ {t('notComputed')}{' '}
              <Link href={ownHref} className="font-semibold text-brand-700">
                {t('computeOne')} →
              </Link>
            </p>
          ) : null}
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
      {upsale && (upsale.earnedUsd > 0 || upsale.payableUsd > 0 || upsale.notComputed > 0) ? (
        <div className="flex flex-wrap items-baseline gap-2 border-t border-line pt-2 text-sm" data-testid="staff-upsale">
          <span className="text-2xs uppercase text-ink-500">{t('upsale')}</span>
          <span>
            {t('upsaleEarned')}: <span className="font-mono tabular-nums">{money(upsale.earnedUsd)}</span>
          </span>
          <span>
            {t('upsalePayable')}: <span className="font-mono tabular-nums">{money(upsale.payableUsd)}</span>
          </span>
          {/* The KPI's own per-card pattern: a figure the walk could not
              finish is said on the card it is short on (3a). */}
          {upsale.notComputed > 0 ? (
            <span className="text-warn" data-testid="staff-upsale-unknown">
              ⚠ {t('notComputed')}
            </span>
          ) : null}
          <Link href={upsaleHref} className="text-xs font-semibold text-brand-700">
            {t('upsaleLink')} →
          </Link>
        </div>
      ) : null}
    </li>
  );
}
