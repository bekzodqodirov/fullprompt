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
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { listAccounts, listCategories } from '@/modules/wms/accounting/service';
import { listPartners } from '@/modules/wms/partners/service';
import { bySeller, upsaleRows } from '@/modules/wms/calc/upsale-service';
import { mayEditKpiTable, mayPayCommission, maySeeStaffMoney, maySeeStaffUpsale } from '@/modules/wms/staff/door';
import { unstampedCargo } from '@/modules/wms/staff/cargo';
import {
  kpiCloseDay,
  kpiMonth,
  kpiPayable,
  kpiPayableAll,
  kpiSellerIds,
  lastClosedMonth,
  type KpiMonthLine,
  type KpiPayable,
} from '@/modules/wms/staff/kpi-service';
import { kpiVersions, versionFor } from '@/modules/wms/staff/kpi-table';
import { calendarMonth, monthEndDay, monthRange } from '@/modules/wms/staff/month';
import { owedEmployeeIds, staffTemplates } from '@/modules/wms/staff/salary';
import { visibleStaff } from '@/modules/wms/staff/visible';
import { PageHeader } from '@/components/ui/page';
import { StaffCard, type RecurringOptions } from './staff-card';
import { NoLoginPersonNew, StaffCategoryForm, StampRepairButton } from './forms';
import { KpiTableForm } from './kpi-table-form';

export const dynamic = 'force-dynamic';

/** The whole KPI read's budget on this page — past it, «hisoblanmadi» (design §6). */
const KPI_BUDGET_MS = 8000;

/**
 * «Hodimlar» — every person's pay in one place (0117, the owner's 8a: «one
 * page: per employee salary amount, currency, pay day; KPI and upsale are
 * SEPARATE lines added to it») — logins AND people who never sign in (0120,
 * his 2b: a worker in a Chinese warehouse is minted, paid and let go here).
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
  const hodim =
    params.hodim && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.hodim) ? params.hodim : null;

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

      {/* Outside the slow boundary: it needs no server data, so the add fold
          is there before the budgeted KPI reads finish. */}
      <NoLoginPersonNew />

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
  const failed = { behind: false, kpi: false, salary: false };
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
  // cargo) run with JIT off and a BUDGET for the WHOLE read (`deadlineMs` —
  // a per-statement timeout lets a four-statement read hold the page four
  // times over): past it the KPI reads «hisoblanmadi», never a $0 and never
  // a stuck page (design §6). The whole company's payable is the heavy one
  // (5.6 s over twelve months on the shaped copy, and a month longer every
  // month); when it runs out, each seller's card links to their OWN pass
  // (`?hodim=`, 0.7 s), where the figure and «KPI to'lash» are.
  const [people, templates, owed, kpiLines, payables, kpiSellers, unstamped, versions, categories, accounts, warehouseRows, currencyRows, partnerRows, upsale] =
    await Promise.all([
      // Payroll lists EVERY person, logins and people who never sign in —
      // `visibleStaff` decides who shows (the fence's payroll allowlist).
      db
        .select({
          id: users.id,
          name: users.fullName,
          active: users.active,
          loginEnabled: users.loginEnabled,
          phone: users.phone,
        })
        .from(users)
        .orderBy(asc(users.fullName)),
      // The salary's state is THIS month's, whatever `?oy` the KPI is read
      // for — the chip names the month it is about. A failed read is said,
      // never an empty list that reads «nobody has a salary» (2b).
      staffTemplates(db, { today, salaryCategoryId: salarySetting }).catch((err) => {
        failed.salary = true;
        if (isServerBehind(err)) failed.behind = true;
        logger.error({ err }, '[hodimlar] templates');
        return [];
      }),
      // Who a template still owes or is owed by — the due list's own set; a
      // leaver stays listed until it is empty. null = unknown, so nobody is
      // dropped (visibleStaff).
      owedEmployeeIds(db, today).catch((err) => {
        failed.salary = true;
        if (isServerBehind(err)) failed.behind = true;
        logger.error({ err }, '[hodimlar] owed');
        return null;
      }),
      withoutJit((exec) => kpiMonth(exec, month, hodim ? { kind: 'own', userId: hodim } : { kind: 'all' }, today), {
        deadlineMs: KPI_BUDGET_MS,
      }).catch((err) => {
        failed.kpi = true;
        if (isServerBehind(err)) failed.behind = true;
        logger.error({ err }, '[hodimlar] kpi month');
        return new Map<string, KpiMonthLine>();
      }),
      // One person asked for (`?hodim=`) is ONE seller's pass — measured
      // 0.7 s against 5.6 s for the whole company over twelve months on the
      // shaped copy — the same netting either way (`payableOf`).
      withoutJit(
        (exec) =>
          hodim
            ? kpiPayable(exec, hodim, today).then((one) => new Map<string, KpiPayable>([[hodim, one]]))
            : kpiPayableAll(exec, today),
        { deadlineMs: KPI_BUDGET_MS },
      ).catch((err) => {
        failed.kpi = true;
        if (isServerBehind(err)) failed.behind = true;
        logger.error({ err }, '[hodimlar] kpi payable');
        return new Map<string, KpiPayable>();
      }),
      // Who COULD carry a KPI line — cheap, and asked beside the budgeted
      // reads so that their failure still knows whose card must say so.
      safe(kpiSellerIds(db), new Set<string>(), 'kpi sellers'),
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
      // One person asked for is ONE seller's offers — never their share of a
      // company-wide list the cap may have cut (`UPSALE_CAP`).
      seesUpsale
        ? safe(
            upsaleRows('all', actor.id, {
              from: `${month}-01`,
              to: monthEndDay(month),
              sellerId: hodim ?? undefined,
              walk: 'fifo',
            }),
            { rows: [], truncated: false },
            'upsale',
          )
        : Promise.resolve(null),
    ]);

  // The ONE per-seller fold /upsale's scoreboard reads too (#513): «to'lanadi»
  // is only what is payable NOW, and a row the walk did not reach is counted
  // apart so the card can say it instead of printing a short figure.
  const upsaleBySeller = new Map(
    bySeller(upsale?.rows ?? []).map((s) => [
      s.sellerId,
      { earnedUsd: s.earnedUsd, payableUsd: s.payableUsd, notComputed: s.notComputed },
    ]),
  );

  // Everybody active, plus a deactivated person who is still owed or still
  // owes — the due list's set, cargo this month, money either way (a seller
  // who left is still paid, and so is a warehouse worker who left before his
  // last «To'landi»). When the KPI reads ran out of time a departed SELLER
  // stays listed with «hisoblanmadi»; `?hodim=` always shows that one person.
  const visible = visibleStaff(people, {
    hodim,
    owed,
    kpiLineIds: new Set(kpiLines.keys()),
    payables,
    kpiFailed: failed.kpi,
    kpiSellers,
  });
  const mayGiveLogin = actor.permissions.has('admin.users.manage');
  const hasPay = (id: string) => templates.some((tpl) => tpl.employeeId === id && tpl.salary) || kpiLines.has(id);
  visible.sort((a, b) => Number(hasPay(b.id)) - Number(hasPay(a.id)) || a.name.localeCompare(b.name));

  // The editor edits the version a save would SUPERSEDE — the one in force
  // this month — never the one pricing the month being viewed: prefilled from
  // an old `?oy`, «Saqlash» would put an older grid back over a newer one.
  const cellTops = (v: ReturnType<typeof versionFor>) => ({
    tiers: [...new Set((v?.cells ?? []).map((c) => c.maxM3).filter((x): x is number => x !== null))].sort((a, b) => a - b),
    bands: [...new Set((v?.cells ?? []).map((c) => c.maxDensity).filter((x): x is number => x !== null))].sort(
      (a, b) => a - b,
    ),
  });
  const version = versionFor(versions, month);
  const { tiers, bands } = cellTops(version);
  const thisMonth = today.slice(0, 7);
  const editVersion = versionFor(versions, thisMonth);
  const editTops = cellTops(editVersion);
  const editRate = (tier: number | null, band: number | null) =>
    editVersion?.cells.find((c) => c.maxM3 === tier && c.maxDensity === band)?.rateUsd;
  const tierLabel = (top: number | null) =>
    top === null ? t('table.tierOver', { n: tiers.at(-1) ?? 0 }) : t('table.tierUpTo', { n: top });
  const bandLabel = (top: number | null) =>
    top === null ? t('table.bandOver', { n: bands.at(-1) ?? 0 }) : t('table.bandUpTo', { n: top });
  const rateAt = (tier: number | null, band: number | null) =>
    version?.cells.find((c) => c.maxM3 === tier && c.maxDensity === band)?.rateUsd;
  const closeDay = kpiCloseDay(month);

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
  // An empty list from a FAILED read must not say «nobody has a salary».
  const noSalaryYet = !failed.salary && !templates.some((tpl) => tpl.salary);
  const categoryChoices = categories.map((c) => ({ id: c.id, name: c.name }));

  return (
    <>
      {failed.behind ? <p className="chip chip-warn">{t('behind')}</p> : null}
      {/* The KPI reads ran out of their budget: said ONCE for the page, and
          on every seller's card below — never a silent absence. */}
      {failed.kpi ? (
        <p className="card !p-3 text-sm text-warn" data-testid="hodimlar-kpi-failed">
          ⚠ {t('kpiFailed')}
        </p>
      ) : null}
      {failed.salary ? (
        <p className="card !p-3 text-sm text-warn" data-testid="hodimlar-salary-failed">
          ⚠ {t('salaryFailed')}
        </p>
      ) : null}
      {upsale?.truncated ? (
        <p className="card !p-3 text-sm text-warn" data-testid="hodimlar-upsale-truncated">
          ⚠ {t('upsaleTruncated')}
        </p>
      ) : null}
      {/* The upsale's paid-cargo walk ran out of its budget for some jobs
          (3a): said once here, and on each seller's card below. */}
      {upsale?.rows.some((r) => r.state === 'not_computed') ? (
        <p className="card !p-3 text-sm text-warn" data-testid="hodimlar-upsale-not-computed">
          ⚠ {t('upsaleNotComputed')}
        </p>
      ) : null}

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
              kpiUnavailable={failed.kpi && kpiSellers.has(person.id)}
              ownHref={`/hodimlar?oy=${month}&hodim=${person.id}`}
              upsale={seesUpsale ? (upsaleBySeller.get(person.id) ?? null) : null}
              upsaleHref={`/upsale?hodim=${person.id}&dan=${month}-01&gacha=${monthEndDay(month)}`}
              mayPay={mayPay}
              mayGiveLogin={mayGiveLogin}
              salaryUnavailable={failed.salary}
              openSalaryForm={hodim === person.id && person.active && !failed.salary}
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
                  {/* The card names a seller now and these still carry none —
                      the form's stamp missed them; no later save will. */}
                  {row.currentSellerId ? (
                    <StampRepairButton clientId={row.clientId} sellerName={row.currentSellerName ?? '—'} />
                  ) : null}
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
        {mayEdit && editVersion ? (
          <details data-testid="kpi-table-edit">
            <summary className="cursor-pointer text-xs font-semibold text-brand-700">✏️ {t('table.edit')}</summary>
            <div className="mt-2">
              <p className="text-2xs text-ink-500">{t('table.editBase', { month: editVersion.month })}</p>
              <KpiTableForm
                tiers={editTops.tiers}
                bands={editTops.bands}
                rates={[...editTops.tiers, null].map((tier) =>
                  [...editTops.bands, null].map((band) => editRate(tier, band) ?? 0),
                )}
                month={thisMonth}
              />
            </div>
          </details>
        ) : null}
      </section>
    </>
  );
}
