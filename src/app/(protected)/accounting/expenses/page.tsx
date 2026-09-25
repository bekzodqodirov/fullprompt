import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { currencies, users, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { Panel } from '@/components/panel';
import {
  listAccounts,
  listCategories,
  expenseTotals,
  listExpenses,
  listRecurring,
} from '@/modules/wms/accounting/service';
import { resolvePeriod } from '@/modules/wms/accounting/period';
import { listPartners } from '@/modules/wms/partners/service';
import { PeriodForm } from '../period-form';
import { ExpenseForm } from './expense-form';
import { RecurringForm, RecurringRowEdit } from './recurring-form';
import {
  RecurringLinkForm,
  RecurringPayFold,
  RecurringSkipFold,
  UnskipButton,
} from './recurring-due';
import {
  advancePostedRecurring,
  recurringDue,
  recurringSkipsListed,
  type DueOccurrence,
} from '@/modules/wms/accounting/recurring';
import { paidSoFar } from '@/modules/wms/accounting/recurring-math';
import { VoidExpenseButton } from './void-expense-button';
import { RejectRequestButton } from './reject-request-button';
import { PageHeader } from '@/components/ui/page';
import { LightboxImg } from '@/components/lightbox-img';
import { openExpenseRequests } from '@/modules/wms/accounting/expense-requests';
import { spendDateOf } from '@/modules/wms/accounting/spend-date';
import { maySeeStaffMoney, staffPartnerOfUser } from '@/modules/wms/partners/staff';
import { OpenStaffPartnerButton } from './open-staff-partner-button';
import { tashkentDay } from '@/modules/platform/time/tashkent';

/**
 * The expense book: what the company spent that is not cargo cost.
 *
 * Cargo costs already have their own home (M6 cost entries, allocated down to
 * every box). What lives here is the overhead — rent, salaries, phones — which
 * the P&L needs and nothing else was collecting.
 */
export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; categoryId?: string; request?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.expenses')) redirect('/accounting');
  const t = await getTranslations('accounting');
  const tc = await getTranslations('common');
  const params = await searchParams;
  const { from, to } = resolvePeriod(params);
  const categoryId = /^[0-9a-f-]{36}$/i.test(params.categoryId ?? '') ? params.categoryId : undefined;

  const [categories, accounts, warehouseRows, employeeRows, currencyRows, rows, recurring, totals] =
    await Promise.all([
      listCategories(),
      listAccounts(),
      db
        .select({ id: warehouses.id, code: warehouses.code })
        .from(warehouses)
        .where(eq(warehouses.active, true))
        .orderBy(asc(warehouses.code)),
      db
        .select({ id: users.id, fullName: users.fullName })
        .from(users)
        .where(eq(users.active, true))
        .orderBy(asc(users.fullName)),
      db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true)),
      listExpenses({ from, to, categoryId }),
      listRecurring(),
      expenseTotals({ from, to, categoryId }),
    ]);

  // Tashkent's day (R5), the same `tashkentDay()` the accountant's home
  // counter (`moneyFlowCounts`) is fed: the list must call «due» exactly
  // what the counter counts, or at every month's turn one of them is a day
  // off for five hours.
  const today = tashkentDay();
  // The recurring months (owner's Q6). Each reader answers empty on a
  // half-applied deploy by itself (#472), so the book still renders.
  const [due, skips, advance] = await Promise.all([
    recurringDue(today),
    recurringSkipsListed(today),
    advancePostedRecurring(),
  ]);
  const dueNow = due.filter((row) => row.dueNow);
  const upcoming = due.filter((row) => !row.dueNow && !row.nextMonth);
  const nextMonth = due.filter((row) => row.nextMonth);
  const options = {
    // The cash flag rides along so both forms can drop the kassa and the payer
    // for a book entry (U06) — the service refuses them anyway.
    categories: categories.map((row) => ({ id: row.id, label: row.name, cash: row.cash })),
    accounts: accounts.map((row) => ({ id: row.id, label: `${row.name} (${row.currency})` })),
    warehouses: warehouseRows.map((row) => ({ id: row.id, label: row.code })),
    employees: employeeRows.map((row) => ({ id: row.id, label: row.fullName })),
    currencies: currencyRows.map((row) => row.code),
    // Round 39: rent and Chinese salaries are settled through the transport
    // company, so the expense book has to be able to say who paid.
    partners: (await listPartners({ includeStaff: maySeeStaffMoney(actor.permissions) })).map((row) => ({ id: row.id, label: row.name })),
  };
  // What «To'landi» offers: the ACTIVE kassas with their currency (the
  // payment speaks the kassa's), and the same payers the expense form has.
  const tills = accounts
    .filter((row) => row.active)
    .map((row) => ({ id: row.id, name: row.name, currency: row.currency }));
  const payPartners = options.partners.map((row) => ({ id: row.id, name: row.label }));
  const payerFor = (row: DueOccurrence) => {
    if (row.partnerId && payPartners.some((p) => p.id === row.partnerId)) return `partner:${row.partnerId}`;
    if (row.accountId && tills.some((till) => till.id === row.accountId)) return `till:${row.accountId}`;
    return '';
  };
  const day = (value: string) => `${value.slice(8, 10)}.${value.slice(5, 7)}.${value.slice(0, 4)}`;
  const monthOf = (value: string) => `${value.slice(5, 7)}.${value.slice(0, 4)}`;
  const dueRow = (row: DueOccurrence) => {
    const month = row.month.slice(0, 7);
    const payerName = row.partnerName ?? row.accountName;
    return (
      <div
        key={`${row.recurringId}:${row.month}`}
        className="space-y-1 border-b border-line py-2 text-sm last:border-0"
        data-testid="recurring-due-row"
        data-recurring-id={row.recurringId}
        data-month={month}
      >
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-semibold">{row.categoryName}</span>
          {(row.employeeName || row.warehouseCode) && (
            <span className="text-xs text-ink-500">
              {[row.employeeName, row.warehouseCode].filter(Boolean).join(' · ')}
            </span>
          )}
          {!row.templateActive && <span className="chip">{t('recurringStopped')}</span>}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className={`font-mono text-xs ${row.overdue ? 'font-semibold text-bad' : 'text-ink-500'}`}>
            {day(row.dueDate)}
            {row.overdue && ` · ${t('recurringOverdue')}`}
          </span>
          <span className="font-mono font-bold">
            {row.amount.toLocaleString('en-US')} {row.currency}
          </span>
          {payerName && <span className="text-xs text-ink-700">{payerName}</span>}
          {row.paidParts.length > 0 && (
            <span className="text-xs font-semibold text-warn" data-testid="recurring-paid-so-far">
              {t('recurringPaidSoFar', {
                paid: paidSoFar(row.paidParts, row.currency),
                total: `${row.amount.toLocaleString('en-US')} ${row.currency}`,
              })}
            </span>
          )}
        </div>
        {row.candidates.map((candidate) => (
          <div
            key={candidate.id}
            className="flex flex-wrap items-center gap-2 rounded bg-warn/10 p-1.5 text-xs"
            data-testid="recurring-candidate"
          >
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              {t('recurringCandidate', {
                amount: `${candidate.amount.toLocaleString('en-US')} ${candidate.currency}`,
                date: day(candidate.date),
              })}
              {(candidate.accountName ?? candidate.partnerName) && ` · ${candidate.accountName ?? candidate.partnerName}`}
            </span>
            <RecurringLinkForm
              recurringId={row.recurringId}
              month={month}
              expenseId={candidate.id}
              cash={row.cash}
              template={{ amount: row.amount, currency: row.currency }}
              paidParts={row.paidParts}
              candidate={{ amount: candidate.amount, currency: candidate.currency }}
            />
          </div>
        ))}
        {/* A book entry is dated on its own day (M6), so it is recorded only
            once that day has come; a cash payment may be made in advance. */}
        {(row.cash || row.dueNow) && (
          <RecurringPayFold
            key={`${row.recurringId}:${month}:${row.paidParts.length}`}
            recurringId={row.recurringId}
            month={month}
            dueDate={row.dueDate}
            cash={row.cash}
            template={{ amount: row.amount, currency: row.currency, note: row.note }}
            paidParts={row.paidParts}
            defaultPayer={payerFor(row)}
            defaultPayerClosed={Boolean(row.accountId || row.partnerId) && payerFor(row) === ''}
            tills={tills}
            partners={payPartners}
            currencies={options.currencies}
            hasCandidates={row.candidates.length > 0}
            today={today}
          />
        )}
        <RecurringSkipFold recurringId={row.recurringId} month={month} />
      </div>
    );
  };
  // The whole period's total, never the sum of the rows drawn: the list stops
  // at its newest 500 (audit A14).
  const totalUsd = totals.totalUsd;

  // The rasxod xabari queue (round 107). Caught: the table is minted this
  // release, and a half-applied deploy must not white-page the expense book
  // (#472's morning).
  const requests = await openExpenseRequests().catch(() => []);
  // «Kiritish» = the SAME form, prefilled from the REQUEST ROW loaded here by
  // id — never amounts from the URL, which would be a forged sum under the
  // accountant's rubber stamp (#514).
  const requestParam = /^[0-9a-f-]{36}$/i.test(params.request ?? '') ? params.request : undefined;
  const prefillRow = requestParam
    ? requests.find((row) => row.id === requestParam && row.status === 'open')
    : undefined;
  // «O'z pulimdan to'ladim» (owner M1a): the payer is the REPORTER's staff
  // account, looked up by the request row's own author — so «Kiritish» books a
  // debt to them, and no kassa moves. The accountant may still switch the
  // payer to a kassa; this is a default, not a lock. A retired account is not
  // offered (the list is active-only) and is said so rather than silently
  // dropped back to «we paid».
  const reporterStaff = prefillRow?.paidBySelf
    ? await staffPartnerOfUser(prefillRow.createdBy).catch(() => null)
    : null;
  const prefillPartnerId = reporterStaff?.active ? reporterStaff.id : undefined;

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-4xl">
      <PageHeader icon="doc" title={t('expenses')} />

      {/* The emoji lives in the bundle's value; no controls here (G3). */}
      {dueNow.length > 0 && (
        <a
          href="#recurring"
          className="card block text-sm font-semibold text-warn underline"
          data-testid="recurring-due-banner"
        >
          {t('recurringDueBanner', { n: dueNow.length })}
        </a>
      )}

      {requests.length > 0 && (
        <div className="card space-y-2" data-testid="expense-requests">
          <h2 className="text-sm font-bold uppercase text-ink-500">
            💸 {t('requestsTitle')} ({requests.length})
          </h2>
          {requests.map((request) => (
            <div
              key={request.id}
              className="flex flex-wrap items-center gap-2 border-b border-line py-1.5 text-sm last:border-0"
              data-testid="expense-request-row"
            >
              {/* A report from /profile names no warehouse (0101) — nothing
                  printed rather than a dash that reads like a code. */}
              {request.warehouseCode && (
                <span className="font-mono text-xs text-ink-500">{request.warehouseCode}</span>
              )}
              {/* When the money was spent, in the warehouse's clock — the
                  date «Kiritish» will file it under (audit A29). */}
              <span className="font-mono text-xs text-ink-500" data-testid="expense-request-date">
                {spendDateOf(new Date(request.createdAt), request.warehouseTimezone)}
              </span>
              <span className="text-ink-700">{request.requesterName}</span>
              {request.paidBySelf && (
                <span
                  className="rounded bg-warn/10 px-1.5 py-0.5 text-xs font-semibold"
                  data-testid="expense-request-self"
                >
                  👤 {t('requestOwnPocket')}
                </span>
              )}
              <span className="font-mono font-bold">
                {Number(request.amount).toLocaleString('ru-RU')} {request.currency}
              </span>
              <span className="min-w-0 flex-1 text-ink-700 [overflow-wrap:anywhere]">
                {request.note}
              </span>
              {request.photoIds.map((photoId) => (
                <LightboxImg key={photoId} attachmentId={photoId} className="h-10 w-10 rounded object-cover" />
              ))}
              {request.status === 'open' ? (
                <span className="ml-auto flex shrink-0 items-center gap-3">
                  <a
                    href={`/accounting/expenses?request=${request.id}`}
                    className="text-xs font-bold text-brand-700 underline"
                    data-testid="enter-request"
                  >
                    ✍️ {t('enterRequest')}
                  </a>
                  <RejectRequestButton id={request.id} />
                </span>
              ) : (
                // The claim landed and the expense never did (a crash between
                // the two): visible, never silently re-enterable.
                <span className="ml-auto text-xs font-semibold text-warn">⚠ {t('requestStuck')}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {prefillRow?.paidBySelf && !reporterStaff && (
        <OpenStaffPartnerButton requestId={prefillRow.id} />
      )}
      {prefillRow?.paidBySelf && reporterStaff && !reporterStaff.active && (
        <p className="rounded-lg bg-warn/10 p-2 text-xs font-semibold" data-testid="staff-partner-inactive">
          ⚠ {t('staffPartnerInactive', { name: reporterStaff.name })}
        </p>
      )}

      {categories.length === 0 ? (
        <p className="card text-sm text-ink-700">{t('noCategories')}</p>
      ) : (
        <ExpenseForm
          // The payer joins the key: minting the reporter's account re-renders
          // the SAME request, and `useState` would keep the old «we paid».
          key={prefillRow ? `${prefillRow.id}:${prefillPartnerId ?? ''}` : 'plain'}
          {...options}
          today={today}
          prefill={
            prefillRow
              ? {
                  requestId: prefillRow.id,
                  amount: prefillRow.amount,
                  currency: prefillRow.currency,
                  note: prefillRow.note,
                  warehouseId: prefillRow.warehouseId,
                  paidBySelf: prefillRow.paidBySelf,
                  partnerId: prefillPartnerId,
                  expenseDate: spendDateOf(new Date(prefillRow.createdAt), prefillRow.warehouseTimezone),
                }
              : undefined
          }
        />
      )}

      {/* AFTER the expense form in DOM order on purpose: m7-accounting picks
          the page's `select[name="categoryId"]` with `.first()`, and a closed
          <details> still holds its selects. */}
      <div id="recurring">
      <Panel
        title={`🔁 ${t('recurring')}`}
        badge={dueNow.length || undefined}
        open={dueNow.length > 0 || advance.count > 0}
        testId="recurring-panel"
      >
        <p className="text-xs text-ink-500">{t('recurringHowItWorks')}</p>
        {advance.count > 0 && (
          <div className="space-y-1 rounded-lg bg-warn/10 p-2" data-testid="recurring-advance">
            <p className="text-xs font-semibold text-warn">
              ⚠ {t('recurringAdvancePosted', { n: advance.count })}
            </p>
            {advance.rows.map((row) => (
              <div key={row.id} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold">{row.categoryName}</span>
                <span className="text-ink-500">🔁 {monthOf(row.month)}</span>
                <span className="font-mono">{day(row.date)}</span>
                <span className="font-mono font-bold">
                  {row.amount.toLocaleString('en-US')} {row.currency}
                </span>
                {(row.accountName ?? row.partnerName) && (
                  <span className="text-ink-700">{row.accountName ?? row.partnerName}</span>
                )}
                <span className="ml-auto">
                  <VoidExpenseButton id={row.id} />
                </span>
              </div>
            ))}
            {advance.count > advance.rows.length && (
              <p className="text-xs text-ink-500">+{advance.count - advance.rows.length}</p>
            )}
          </div>
        )}
        <section className="space-y-1" data-testid="recurring-due-now">
          <p className="section-title">{t('recurringDueTitle')}</p>
          {dueNow.length === 0 ? (
            <p className="text-sm text-ink-500">{t('recurringNothingDue')}</p>
          ) : (
            dueNow.map(dueRow)
          )}
        </section>
        {upcoming.length > 0 && (
          <details className="rounded-lg border border-line p-2" data-testid="recurring-upcoming">
            <summary className="cursor-pointer text-sm font-semibold text-ink-700">
              {t('recurringUpcomingTitle')} ({upcoming.length})
            </summary>
            {upcoming.map(dueRow)}
          </details>
        )}
        {nextMonth.length > 0 && (
          <details className="rounded-lg border border-line p-2" data-testid="recurring-next">
            <summary className="cursor-pointer text-sm font-semibold text-ink-700">
              {t('recurringNextTitle')} ({nextMonth.length})
            </summary>
            {nextMonth.map(dueRow)}
          </details>
        )}
        {skips.map((skip) => (
          <div
            key={skip.id}
            className="flex flex-wrap items-center gap-2 border-b border-line py-1.5 text-xs last:border-0"
            data-testid="recurring-skipped-row"
          >
            <span className="font-semibold">{skip.categoryName}</span>
            {skip.employeeName && <span className="text-ink-500">{skip.employeeName}</span>}
            <span className="font-mono text-ink-500">{monthOf(skip.month)}</span>
            <span className="min-w-0 flex-1 text-ink-700 [overflow-wrap:anywhere]">
              {t('recurringSkippedLine', { reason: skip.reason })}
            </span>
            <UnskipButton id={skip.id} />
          </div>
        ))}
        <div className="space-y-1">
          {recurring.map(({ recurring: template, categoryName, categoryCash, employeeName, partnerName, accountName, accountCurrency, accountActive, partnerActive }) => (
            <div
              key={template.id}
              className={`flex flex-wrap items-baseline gap-2 border-b border-line py-1.5 text-sm last:border-0 ${
                template.active ? '' : 'opacity-50'
              }`}
            >
              <span className="font-semibold">{categoryName}</span>
              {employeeName && <span className="text-ink-700">{employeeName}</span>}
              <span className="ml-auto font-mono font-bold">
                {Number(template.amount).toLocaleString('en-US')} {template.currency}
              </span>
              <span className="text-xs text-ink-500">
                {t('dayOfMonth')}: {template.dayOfMonth}
              </span>
              {partnerName && (
                <span className="w-full text-xs text-ink-700">
                  {t('paidBy')}: {partnerName}
                </span>
              )}
              <RecurringRowEdit
                id={template.id}
                amount={template.amount}
                dayOfMonth={template.dayOfMonth}
                active={template.active}
                cash={categoryCash}
                currency={template.currency}
                currencies={options.currencies}
                stored={{
                  accountId: template.accountId,
                  accountName,
                  accountCurrency,
                  accountActive,
                  partnerId: template.partnerId,
                  partnerName,
                  partnerActive,
                }}
                tills={tills}
                partners={payPartners}
              />
            </div>
          ))}
          {recurring.length === 0 && <p className="text-sm text-ink-500">{tc('empty')}</p>}
        </div>
        {categories.length > 0 && <RecurringForm {...options} today={today} />}
      </Panel>
      </div>

      <PeriodForm
        from={from}
        to={to}
        // The file carries the screen's category too: without it a filtered
        // screen downloaded every category under the same title (audit A15).
        exportHref={
          categoryId ? `/api/accounting/expenses?categoryId=${categoryId}` : '/api/accounting/expenses'
        }
        extra={
          <label className="text-sm">
            <span className="block text-xs text-ink-500">{t('category')}</span>
            <select name="categoryId" defaultValue={categoryId ?? ''} className="input !w-44">
              <option value="">— {t('category')} —</option>
              {categories.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
        }
      />

      <p className="text-sm font-semibold" data-testid="expenses-total">
        {t('total')}: {totalUsd.toLocaleString('en-US')} $
      </p>
      {totals.count > rows.length && (
        <p className="text-xs font-semibold text-warn" data-testid="expenses-truncated">
          ⚠ {t('expensesTruncated', { shown: rows.length, total: totals.count })}
        </p>
      )}

      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-line-strong bg-surface-sunken text-left text-xs uppercase text-ink-500">
                <th className="p-2">{t('date')}</th>
                <th className="p-2">{t('category')}</th>
                <th className="p-2 text-right">{t('amount')}</th>
                <th className="p-2 text-right">USD</th>
                <th className="p-2">{t('account')}</th>
                <th className="p-2">{t('note')}</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-3 text-center text-ink-500">
                    {t('empty')}
                  </td>
                </tr>
              )}
              {rows.map(({
                expense,
                categoryName,
                warehouseCode,
                employeeName,
                accountName,
                partnerName,
              }) => (
                <tr key={expense.id} className="border-b border-line">
                  <td className="p-2 whitespace-nowrap font-mono">{expense.expenseDate}</td>
                  <td className="p-2">
                    {categoryName}
                    {/* The month a recurring payment answers — its date is the
                        day the money left, which may be another month (0106). */}
                    {expense.recurringMonth && (
                      <span className="ml-2 text-xs text-ink-500">
                        🔁 {expense.recurringMonth.slice(5, 7)}.{expense.recurringMonth.slice(0, 4)}
                      </span>
                    )}
                    {(warehouseCode || employeeName) && (
                      <span className="ml-2 text-xs text-ink-500">
                        {[warehouseCode, employeeName].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </td>
                  <td className="p-2 whitespace-nowrap text-right font-mono">
                    {Number(expense.amount).toLocaleString('en-US')} {expense.currency}
                  </td>
                  <td className="p-2 text-right font-mono font-bold">
                    {Number(expense.amountUsd).toLocaleString('en-US')}
                  </td>
                  {/* Cash box, or the firm that settled it instead. A blank
                      cell used to mean both "no till named" and "a partner
                      paid", which are different facts about the same money. */}
                  <td className="p-2 text-ink-700">
                    {accountName ?? (partnerName ? `${t('paidBy')}: ${partnerName}` : '')}
                  </td>
                  <td className="p-2 text-ink-700">{expense.note ?? ''}</td>
                  <td className="p-2 text-right">
                    <VoidExpenseButton id={expense.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
