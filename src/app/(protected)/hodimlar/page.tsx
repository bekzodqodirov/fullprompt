import Link from 'next/link';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { asc, eq } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { withoutJit } from '@/modules/platform/db/no-jit';
import { currencies, users, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { getSetting } from '@/modules/platform/settings/service';
import { addDays, tashkentDay } from '@/modules/platform/time/tashkent';
import { listAccounts, listCategories } from '@/modules/wms/accounting/service';
import { listPartners } from '@/modules/wms/partners/service';
import { earnedOf, upsaleRows } from '@/modules/wms/calc/upsale-service';
import { mayEditKpiTable, mayPayCommission, maySeeStaffMoney, maySeeStaffUpsale } from '@/modules/wms/staff/door';
import { unstampedCargo } from '@/modules/wms/staff/cargo';
import { kpiMonth, kpiPayableAll, lastClosedMonth, type KpiMonthLine, type KpiPayable } from '@/modules/wms/staff/kpi-service';
import { kpiVersions, versionFor } from '@/modules/wms/staff/kpi-table';
import { addMonths, calendarMonth, monthEndDay, monthRange } from '@/modules/wms/staff/month';
import { staffTemplates } from '@/modules/wms/staff/salary';
import { PageHeader } from '@/components/ui/page';
import { StaffCard, type RecurringOptions } from './staff-card';
import { StaffCategoryForm } from './forms';
import { KpiTableForm } from './kpi-table-form';

export const dynamic = 'force-dynamic';

/**
 * «Hodimlar» — every person's pay in one place (0117, the owner's 8a: «one
 * page: per employee salary amount, currency, pay day; KPI and upsale are
 * SEPARATE lines added to it»).
 *
 * The DOOR is `maySeeStaffMoney` = `finance.expenses`, the staff account's
 * own (the accountant and the admin). Inside it, each write asks its own
 * predicate and the button is drawn only for somebody the action would admit
 * (staff/door.ts): the salary ✏️ is the recurring template's own door
 * (`finance.expenses`), «KPI to'lash» is `mayPayCommission`, the table and the
 * two categories are `admin.settings.manage`, and a colleague's upsale is
 * drawn only for the upsale's 'all' audience.
 *
 * `?oy=YYYY-MM` (default: the last CLOSED month) and `?hodim=<uuid>` are
 * forged posts until proven (#514): a month that does not exist falls back to
 * the default, an id that is not a uuid is ignored.
 */
export default async function HodimlarPage({
  searchParams,
}: {
  searchParams: Promise<{ oy?: string; hodim?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!maySeeStaffMoney(actor.permissions)) redirect('/');
  const t = await getTranslations('hodimlar');
  const params = await searchParams;
  const today = tashkentDay();
  const month = calendarMonth(params.oy) ?? lastClosedMonth(today);
  const hodim = params.hodim && /^[0-9a-f-]{36}$/i.test(params.hodim) ? params.hodim : null;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader icon="user" title={t('title')} />

      <form className="card flex flex-wrap items-end gap-2 !p-3" data-testid="hodimlar-month">
        <label className="text-2xs">
          <span className="label">{t('month')}</span>
          <input type="month" name="oy" className="input input-sm !w-40" defaultValue={month} />
        </label>
        {hodim ? <input type="hidden" name="hodim" value={hodim} /> : null}
        <button type="submit" className="btn-secondary">
          {t('show')}
        </button>
        {hodim ? (
          <Link href={`/hodimlar?oy=${month}`} className="text-xs font-semibold text-brand-700">
            {t('everyone')}
          </Link>
        ) : null}
        {/* Two notes the owner would otherwise read as bugs (fit#…): which
            clock a «month» is, and why the kub has decimals and the density
            has none. */}
        <p className="w-full text-2xs text-ink-500">{t('monthNote')}</p>
        <p className="w-full text-2xs text-ink-500">{t('roundingNote')}</p>
      </form>

      <Suspense fallback={<div aria-hidden className="card h-64 animate-pulse bg-surface-sunken" />}>
        <StaffList
          actor={actor}
          month={month}
          hodim={hodim}
          today={today}
        />
      </Suspense>
    </div>
  );
}

async function StaffList({
  actor,
  month,
  hodim,
  today,
}: {
  actor: NonNullable<Awaited<ReturnType<typeof getActor>>>;
  month: string;
  hodim: string | null;
  today: string;
}) {
  const t = await getTranslations('hodimlar');
  const range = monthRange(month);
  const mayEdit = mayEditKpiTable(actor);
  const mayPay = mayPayCommission(actor);
  const seesUpsale = maySeeStaffUpsale(actor);

  // What went wrong while reading — a record the reads write into, not two
  // reassigned locals (a server component's body is not a place for those).
  const failed = { behind: false, kpi: false };
  const safe = async <T,>(load: Promise<T>, fallback: T, where: string): Promise<T> => {
    try {
      return await load;
    } catch (err) {
      if (isServerBehind(err)) failed.behind = true;
      logger.error({ err, where }, '[hodimlar] read failed');
      return fallback;
    }
  };

  const [kpiSetting, salarySetting] = await Promise.all([
    getSetting('kpi_expense_category_id').then((v) => String(v ?? '').trim()),
    getSetting('salary_expense_category_id').then((v) => String(v ?? '').trim()),
  ]);

  // The heavy two (every covering price of every client behind a month's
  // cargo) run with JIT off and a BUDGET: past it the KPI line reads
  // «hisoblanmadi», never a $0 and never a stuck page (design §6).
  const [people, templates, kpiLines, payables, unstamped, versions, categories, accounts, warehouseRows, currencyRows, partnerRows, upsale] =
    await Promise.all([
      db.select({ id: users.id, name: users.fullName, active: users.active }).from(users).orderBy(asc(users.fullName)),
      safe(staffTemplates(db, { month, salaryCategoryId: salarySetting }), [], 'templates'),
      withoutJit((exec) => kpiMonth(exec, month, { kind: 'all' }, today), { timeoutMs: 8000 }).catch((err) => {
        failed.kpi = true;
        if (isServerBehind(err)) failed.behind = true;
        logger.error({ err }, '[hodimlar] kpi month');
        return new Map<string, KpiMonthLine>();
      }),
      withoutJit((exec) => kpiPayableAll(exec, today), { timeoutMs: 8000 }).catch((err) => {
        failed.kpi = true;
        if (isServerBehind(err)) failed.behind = true;
        logger.error({ err }, '[hodimlar] kpi payable');
        return new Map<string, KpiPayable>();
      }),
      safe(unstampedCargo(db, range), [], 'unstamped'),
      safe(kpiVersions(db), [], 'versions'),
      listCategories(),
      listAccounts(),
      db
        .select({ id: warehouses.id, code: warehouses.code })
        .from(warehouses)
        .where(eq(warehouses.active, true))
        .orderBy(asc(warehouses.code)),
      db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true)),
      listPartners({ includeStaff: true }),
      seesUpsale
        ? safe(upsaleRows('all', actor.id, { from: `${month}-01`, to: monthEndDay(month) }), { rows: [], truncated: false }, 'upsale')
        : Promise.resolve(null),
    ]);

  const upsaleBySeller = new Map<string, { earnedUsd: number; payableUsd: number }>();
  for (const row of upsale?.rows ?? []) {
    const cur = upsaleBySeller.get(row.sellerId) ?? { earnedUsd: 0, payableUsd: 0 };
    cur.earnedUsd = Math.round((cur.earnedUsd + earnedOf(row)) * 100) / 100;
    if (row.state === 'payable') cur.payableUsd = Math.round((cur.payableUsd + row.payableUsd) * 100) / 100;
    upsaleBySeller.set(row.sellerId, cur);
  }

  // Everybody active, plus a deactivated person who still has cargo this
  // month or money owed either way — a seller who left is still paid.
  const visible = people.filter(
    (p) =>
      (hodim === null || p.id === hodim) &&
      (p.active ||
        kpiLines.has(p.id) ||
        (payables.get(p.id)?.payableUsd ?? 0) > 0 ||
        (payables.get(p.id)?.overpaidUsd ?? 0) > 0),
  );
  const hasPay = (id: string) => templates.some((tpl) => tpl.employeeId === id && tpl.salary) || kpiLines.has(id);
  visible.sort((a, b) => Number(hasPay(b.id)) - Number(hasPay(a.id)) || a.name.localeCompare(b.name));

  const version = versionFor(versions, month);
  const tiers = [...new Set((version?.cells ?? []).map((c) => c.maxM3).filter((v): v is number => v !== null))].sort((a, b) => a - b);
  const bands = [...new Set((version?.cells ?? []).map((c) => c.maxDensity).filter((v): v is number => v !== null))].sort((a, b) => a - b);
  const tierLabel = (top: number | null) =>
    top === null ? t('table.tierOver', { n: tiers.at(-1) ?? 0 }) : t('table.tierUpTo', { n: top });
  const bandLabel = (top: number | null) =>
    top === null ? t('table.bandOver', { n: bands.at(-1) ?? 0 }) : t('table.bandUpTo', { n: top });
  const rateAt = (tier: number | null, band: number | null) =>
    version?.cells.find((c) => c.maxM3 === tier && c.maxDensity === band)?.rateUsd;
  const closeDay = addDays(`${addMonths(month, 1)}-01`, 7);

  const options: RecurringOptions = {
    categories: categories.map((row) => ({ id: row.id, label: row.name, cash: row.cash })),
    accounts: accounts.map((row) => ({ id: row.id, label: `${row.name} (${row.currency})` })),
    warehouses: warehouseRows.map((row) => ({ id: row.id, label: row.code })),
    employees: people.filter((p) => p.active).map((p) => ({ id: p.id, label: p.name })),
    currencies: currencyRows.map((row) => row.code),
    partners: partnerRows.map((row) => ({ id: row.id, label: row.name })),
    tills: accounts.filter((row) => row.active).map((row) => ({ id: row.id, name: row.name, currency: row.currency })),
    payPartners: partnerRows.map((row) => ({ id: row.id, name: row.name })),
  };
  const payAccounts = accounts.filter((row) => row.active).map((row) => ({ id: row.id, name: row.name, currency: row.currency }));
  const noSalaryYet = !templates.some((tpl) => tpl.salary);
  const categoryChoices = categories.map((c) => ({ id: c.id, name: c.name }));

  return (
    <>
      {failed.behind ? <p className="chip chip-warn">{t('behind')}</p> : null}

      <div className="grid gap-2 md:grid-cols-2">
        <StaffCategoryForm
          settingKey="salary_expense_category_id"
          title={t('salaryCategory')}
          unset={t('salaryCategoryUnset')}
          hint={t('salaryCategoryHint')}
          categories={categoryChoices}
          current={salarySetting}
          mayChoose={mayEdit}
        />
        <StaffCategoryForm
          settingKey="kpi_expense_category_id"
          title={t('kpiCategory')}
          unset={t('kpiCategoryUnset')}
          hint={t('kpiCategoryHint')}
          categories={categoryChoices}
          current={kpiSetting}
          mayChoose={mayEdit}
        />
      </div>

      {noSalaryYet ? (
        <p className="card !p-3 text-sm text-ink-600" data-testid="hodimlar-empty">
          {t('empty')}
        </p>
      ) : null}

      <ul className="space-y-2" data-testid="hodimlar-list">
        {visible.map((person) => {
          const mine = templates.filter((tpl) => tpl.employeeId === person.id);
          return (
            <StaffCard
              key={person.id}
              person={person}
              salary={mine.filter((tpl) => tpl.salary)}
              others={mine.filter((tpl) => !tpl.salary)}
              kpi={kpiLines.get(person.id)}
              payable={payables.get(person.id)}
              kpiUnavailable={failed.kpi && (kpiLines.has(person.id) || payables.has(person.id))}
              upsale={seesUpsale ? (upsaleBySeller.get(person.id) ?? null) : null}
              upsaleHref={`/upsale?hodim=${person.id}&dan=${month}-01&gacha=${monthEndDay(month)}`}
              mayPay={mayPay}
              payAccounts={payAccounts}
              today={today}
              salaryCategoryId={salarySetting}
              options={options}
              tierLabel={tierLabel}
              bandLabel={bandLabel}
              closesOn={`${closeDay.slice(8, 10)}.${closeDay.slice(5, 7)}`}
            />
          );
        })}
      </ul>

      {/* «Sotuvchisiz yuk»: the month's cargo nobody was named on. Naming a
          seller on the client card is what stamps it — the sentence says so. */}
      <section className="card space-y-2 !p-3" data-testid="hodimlar-unstamped">
        <h2 className="section-title">{t('unstamped')}</h2>
        {unstamped.length === 0 ? (
          <p className="text-sm text-ink-500">{t('unstampedNone')}</p>
        ) : (
          <>
            <p className="text-xs text-ink-600">{t('unstampedHint')}</p>
            <ul className="space-y-1">
              {unstamped.map((row) => (
                <li key={row.clientId} className="flex flex-wrap items-baseline gap-2 text-sm">
                  <Link href={`/admin/clients/${row.clientId}`} className="font-mono font-semibold text-brand-700">
                    {row.clientCode}
                  </Link>
                  <span className="text-ink-700">{row.clientName}</span>
                  <span className="text-2xs text-ink-500">
                    {row.receipts} · {row.m3.toFixed(2)} {t('m3')} · {Math.round(row.kg)} kg
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* The table that prices the chosen month, and its editor. */}
      <section className="card space-y-2 !p-3" data-testid="hodimlar-table">
        <h2 className="section-title">{t('table.title')}</h2>
        {version ? (
          <>
            <p className="text-2xs text-ink-500">{t('table.version', { month: version.month })}</p>
            <div className="overflow-x-auto">
              <table className="text-sm">
                <thead>
                  <tr className="text-2xs text-ink-500">
                    <th className="p-1 text-left">{t('table.corner')}</th>
                    {[...bands, null].map((band) => (
                      <th key={String(band)} className="p-1 text-right">
                        {bandLabel(band)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...tiers, null].map((tier) => (
                    <tr key={String(tier)} className="border-t border-line/60">
                      <td className="p-1 text-2xs text-ink-600">{tierLabel(tier)}</td>
                      {[...bands, null].map((band) => (
                        <td key={String(band)} className="p-1 text-right font-mono tabular-nums">
                          {rateAt(tier, band)?.toFixed(2) ?? '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="text-sm text-ink-500">{t('table.none')}</p>
        )}
        {mayEdit && version ? (
          <details>
            <summary className="cursor-pointer text-xs font-semibold text-brand-700">✏️ {t('table.edit')}</summary>
            <div className="mt-2">
              <KpiTableForm
                tiers={tiers}
                bands={bands}
                rates={[...tiers, null].map((tier) => [...bands, null].map((band) => rateAt(tier, band) ?? 0))}
                month={today.slice(0, 7)}
              />
            </div>
          </details>
        ) : null}
      </section>
    </>
  );
}
