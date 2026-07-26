import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { currencies } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { Panel } from '@/components/panel';
import { accountBalances, listAccounts, listTransfers } from '@/modules/wms/accounting/service';
import { AccountForm } from './account-form';
import { TransferForm, VoidTransferButton } from './transfer-form';
import { PageHeader } from '@/components/ui/page';

/**
 * Cash boxes and accounts: what is in each one, and how it got there.
 *
 * Balances stay in the account's own currency on purpose — this is the number
 * someone counts in the box, and converting it would make it impossible to
 * reconcile against the actual notes.
 */
export default async function AccountsPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.expenses')) redirect('/accounting');
  const t = await getTranslations('accounting');
  const tc = await getTranslations('common');

  const [accounts, balances, currencyRows, transfers] = await Promise.all([
    listAccounts(true),
    accountBalances(),
    db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true)),
    listTransfers(),
  ]);
  const codes = currencyRows.map((row) => row.code);
  const today = new Date().toISOString().slice(0, 10);
  const money = (value: number) => value.toLocaleString('en-US');

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-3xl">
      <PageHeader icon="wallet" title={t('accounts')} />

      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-line-strong bg-surface-sunken text-left text-xs uppercase text-ink-500">
                <th className="p-2">{t('account')}</th>
                <th className="p-2 text-right">{t('opening')}</th>
                <th className="p-2 text-right">{t('inflow')}</th>
                <th className="p-2 text-right">{t('outflow')}</th>
                <th className="p-2 text-right">{t('balance')}</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((row) => (
                <tr key={row.id} className={`border-b border-line ${row.active ? '' : 'opacity-50'}`}>
                  <td className="p-2">
                    <span className="font-semibold">{row.name}</span>
                    <span className="ml-2 text-xs text-ink-500">
                      {row.currency} · {t(row.kind)}
                    </span>
                  </td>
                  <td className="p-2 text-right font-mono text-ink-700">{money(row.opening)}</td>
                  <td className="p-2 text-right font-mono text-good">
                    +{money(Math.round((row.paidIn + row.transferredIn) * 100) / 100)}
                  </td>
                  <td className="p-2 text-right font-mono text-bad">
                    −{money(Math.round((row.spent + row.transferredOut) * 100) / 100)}
                  </td>
                  <td className="p-2 text-right font-mono font-bold">
                    {money(row.balance)} {row.currency}
                  </td>
                </tr>
              ))}
              {balances.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-3 text-center text-ink-500">
                    {tc('empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <AccountForm currencies={codes} />

      <Panel title={`✏️ ${tc('edit')}`} badge={accounts.length}>
        {accounts.map((account) => (
          <AccountForm
            key={account.id}
            currencies={codes}
            account={{
              id: account.id,
              name: account.name,
              currency: account.currency,
              kind: account.kind,
              openingBalance: account.openingBalance,
              openingDate: account.openingDate,
              sortOrder: account.sortOrder,
              active: account.active,
            }}
          />
        ))}
      </Panel>

      <Panel title={`↔️ ${t('addTransfer')}`} badge={transfers.length || undefined}>
        {accounts.length >= 2 ? (
          <TransferForm
            accounts={accounts.map((row) => ({
              id: row.id,
              label: `${row.name} (${row.currency})`,
            }))}
            today={today}
          />
        ) : (
          <p className="text-sm text-ink-500">{t('needTwoAccounts')}</p>
        )}
        <div className="space-y-1">
          {transfers.map(({ transfer, fromName, fromCurrency, toName, toCurrency }) => (
            <div
              key={transfer.id}
              className={`flex flex-wrap items-baseline gap-2 border-b border-line py-1.5 text-sm last:border-0 ${
                transfer.voidedAt ? 'opacity-50 line-through' : ''
              }`}
            >
              <span className="font-mono text-xs text-ink-500">{transfer.transferDate}</span>
              <span>
                {fromName} → {toName}
              </span>
              <span className="ml-auto font-mono font-bold">
                {money(Number(transfer.amountFrom))} {fromCurrency} →{' '}
                {money(Number(transfer.amountTo))} {toCurrency}
              </span>
              {!transfer.voidedAt && <VoidTransferButton id={transfer.id} />}
            </div>
          ))}
          {transfers.length === 0 && <p className="text-sm text-ink-500">{tc('empty')}</p>}
        </div>
      </Panel>
    </div>
  );
}
