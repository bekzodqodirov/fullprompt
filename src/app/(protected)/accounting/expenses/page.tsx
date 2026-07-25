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
  listExpenses,
  listRecurring,
} from '@/modules/wms/accounting/service';
import { resolvePeriod } from '@/modules/wms/accounting/period';
import { PeriodForm } from '../period-form';
import { ExpenseForm } from './expense-form';
import { GenerateRecurringButton, RecurringForm } from './recurring-form';
import { VoidExpenseButton } from './void-expense-button';

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
  searchParams: Promise<{ from?: string; to?: string; categoryId?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.expenses')) redirect('/accounting');
  const t = await getTranslations('accounting');
  const tc = await getTranslations('common');
  const params = await searchParams;
  const { from, to } = resolvePeriod(params);
  const categoryId = /^[0-9a-f-]{36}$/i.test(params.categoryId ?? '') ? params.categoryId : undefined;

  const [categories, accounts, warehouseRows, employeeRows, currencyRows, rows, recurring] =
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
    ]);

  const today = new Date().toISOString().slice(0, 10);
  const options = {
    categories: categories.map((row) => ({ id: row.id, label: row.name })),
    accounts: accounts.map((row) => ({ id: row.id, label: `${row.name} (${row.currency})` })),
    warehouses: warehouseRows.map((row) => ({ id: row.id, label: row.code })),
    employees: employeeRows.map((row) => ({ id: row.id, label: row.fullName })),
    currencies: currencyRows.map((row) => row.code),
  };
  const totalUsd =
    Math.round(rows.reduce((acc, row) => acc + Number(row.expense.amountUsd), 0) * 100) / 100;

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-4xl">
      <h1 className="text-xl font-bold">🧾 {t('expenses')}</h1>

      {categories.length === 0 ? (
        <p className="card text-sm text-gray-600">{t('noCategories')}</p>
      ) : (
        <ExpenseForm {...options} today={today} />
      )}

      <Panel title={`🔁 ${t('recurring')}`} badge={recurring.length || undefined}>
        <GenerateRecurringButton month={today.slice(0, 7)} />
        <div className="space-y-1">
          {recurring.map(({ recurring: template, categoryName, employeeName }) => (
            <div
              key={template.id}
              className={`flex flex-wrap items-baseline gap-2 border-b border-gray-100 py-1.5 text-sm last:border-0 ${
                template.active ? '' : 'opacity-50'
              }`}
            >
              <span className="font-semibold">{categoryName}</span>
              {employeeName && <span className="text-gray-600">{employeeName}</span>}
              <span className="ml-auto font-mono font-bold">
                {Number(template.amount).toLocaleString('en-US')} {template.currency}
              </span>
              <span className="text-xs text-gray-500">
                {t('dayOfMonth')}: {template.dayOfMonth}
              </span>
            </div>
          ))}
          {recurring.length === 0 && <p className="text-sm text-gray-500">{tc('empty')}</p>}
        </div>
        {categories.length > 0 && <RecurringForm {...options} />}
      </Panel>

      <PeriodForm
        from={from}
        to={to}
        exportHref="/api/accounting/expenses"
        extra={
          <label className="text-sm">
            <span className="block text-xs text-gray-500">{t('category')}</span>
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

      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-gray-300 bg-gray-50 text-left text-xs uppercase text-gray-500">
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
                  <td colSpan={7} className="p-3 text-center text-gray-500">
                    {t('empty')}
                  </td>
                </tr>
              )}
              {rows.map(({ expense, categoryName, warehouseCode, employeeName, accountName }) => (
                <tr key={expense.id} className="border-b border-gray-100">
                  <td className="p-2 whitespace-nowrap font-mono">{expense.expenseDate}</td>
                  <td className="p-2">
                    {categoryName}
                    {(warehouseCode || employeeName) && (
                      <span className="ml-2 text-xs text-gray-500">
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
                  <td className="p-2 text-gray-600">{accountName ?? ''}</td>
                  <td className="p-2 text-gray-600">{expense.note ?? ''}</td>
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
