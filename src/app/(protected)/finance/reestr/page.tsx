import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { BackLink } from '@/components/back-link';
import { PageHeader } from '@/components/ui/page';
import { paymentsRegister } from '@/modules/wms/finance/service';
import { listAccounts } from '@/modules/wms/accounting/service';
import { placePaymentAction } from '../actions';
import { moneyOwnerFilter } from '@/modules/wms/finance/scope';
import { FinanceClientSearch } from '../client-search';
import { calendarDay, tashkentDay, tashkentMonthStart } from '@/modules/platform/time/tashkent';
import { moneyHidden } from '@/modules/platform/rbac/money-sight';
import { mayPickTill } from '@/modules/wms/accounting/till-door';

/**
 * The payments register (round 29) — the accountant's «kimdan qancha pul
 * olganimni qanday yozaman» answered in both directions: the search on top
 * jumps to a client's ledger (where the payment form has always lived), and
 * the table below is every payment of the period with its cash box, the way
 * she used to keep it by hand. Same gate as the rest of /finance.
 */
export default async function PaymentsRegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; joylanmagan?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  // «Every payment with its cash box» is the register's whole shape, and the
  // VED does not see the kassa (owner's Q19) — the screen is not his.
  if (
    (!actor.permissions.has('finance.view') && !actor.permissions.has('finance.manage')) ||
    moneyHidden('kassa', actor.permissions)
  ) {
    redirect('/');
  }
  const t = await getTranslations('finance');
  const params = await searchParams;

  const today = tashkentDay();
  const monthStart = tashkentMonthStart();
  // A real calendar day or the default (U43): the bare regex let 2026-02-30
  // reach postgres and white-page the register.
  const from = calendarDay(params.from) ?? monthStart;
  const to = calendarDay(params.to) ?? today;

  // Placing a payment into a till is the kassa holders' act (Q19, the rule
  // every kassa door asks — `placePaymentAction` refuses the rest).
  const canPlace = mayPickTill(actor.permissions);
  // Every payment still in no till, whatever its date (audit A2) — the home
  // counter and the Balans line both open this view.
  const unplaced = params.joylanmagan === '1';
  const [{ rows, totalUsd, count, truncated }, accounts] = await Promise.all([
    paymentsRegister(from, to, moneyOwnerFilter(actor), { unplaced }),
    canPlace ? listAccounts() : Promise.resolve([]),
  ]);

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <BackLink href="/finance" label={t('title')} />
      <div className="flex flex-wrap items-baseline gap-2">
        <PageHeader icon="wallet" title={t('paymentsRegister')} />
        <a
          href={`/api/accounting/payments?from=${from}&to=${to}`}
          className="btn-secondary !min-h-9 ml-auto px-3 text-sm"
        >
          ⬇️ XLSX
        </a>
      </div>

      {/* Writing a payment starts from the client — the search lands on the
          ledger with the payment form already open to finance.manage. */}
      {actor.permissions.has('finance.manage') && (
        <div className="card space-y-1">
          <p className="text-sm font-semibold">➕ {t('registerAddHint')}</p>
          <FinanceClientSearch />
        </div>
      )}

      <div className="flex flex-wrap gap-1 text-sm">
        <Link
          href={`/finance/reestr?from=${from}&to=${to}`}
          className={`rounded-lg px-3 py-1.5 font-semibold ${unplaced ? 'bg-surface-sunken' : 'bg-brand-600 text-white'}`}
        >
          {t('registerAll')}
        </Link>
        <Link
          href="/finance/reestr?joylanmagan=1"
          className={`rounded-lg px-3 py-1.5 font-semibold ${unplaced ? 'bg-brand-600 text-white' : 'bg-surface-sunken'}`}
          data-testid="register-unplaced"
        >
          {t('registerUnplaced')}
        </Link>
      </div>

      <form className="card flex flex-wrap items-end gap-2" method="get">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-ink-500">{t('fromDate')}</span>
          <input type="date" name="from" defaultValue={from} className="input !w-40" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-ink-500">{t('toDate')}</span>
          <input type="date" name="to" defaultValue={to} className="input !w-40" />
        </label>
        <button type="submit" className="btn-secondary">
          {t('applyPeriod')}
        </button>
        <p className="num ml-auto text-sm font-bold">
          {count} · ${totalUsd.toFixed(2)}
        </p>
      </form>
      {truncated && (
        <p className="text-xs font-semibold text-warn" data-testid="register-truncated">
          {t('registerTruncated', { shown: rows.length, total: count })}
        </p>
      )}

      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm" data-testid="payments-register">
            <thead>
              <tr className="border-b border-line-strong bg-surface-sunken text-left text-xs uppercase text-ink-500">
                <th className="p-2">{t('date')}</th>
                <th className="p-2">{t('client')}</th>
                <th className="p-2 text-right">{t('amount')}</th>
                <th className="p-2 text-right">USD</th>
                <th className="p-2">{t('account')}</th>
                <th className="p-2">{t('enteredBy')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-0">
                  <td className="num p-2 text-xs">{row.txDate}</td>
                  <td className="p-2">
                    <Link href={`/finance/${row.clientId}`} className="hover:underline">
                      <span className="num font-bold text-good">{row.clientCode}</span>{' '}
                      <span className="text-ink-700">{row.clientName}</span>
                    </Link>
                  </td>
                  <td className="num p-2 text-right">
                    {Number(row.amount).toLocaleString('en-US')} {row.currency}
                  </td>
                  <td className="num p-2 text-right font-semibold">
                    {Number(row.amountUsd).toFixed(2)}
                  </td>
                  {/* A settlement's money went into a supplier's account, not
                      a till of ours: the row is not "unplaced", it is placed
                      somewhere else, and only the red warning was wrong. */}
                  <td className="p-2 text-xs">
                    {row.accountName ??
                      (row.partnerName ? (
                        <span className="text-ink-700">→ {row.partnerName}</span>
                      ) : canPlace ? (
                        // An unplaced payment is money that came in and sits
                        // in no till — the Balans is short by it until a person
                        // says which box (audit A2). Only boxes of its currency.
                        <form action={placePaymentAction} className="flex gap-1" data-testid="place-payment">
                          <input type="hidden" name="id" value={row.id} />
                          <select name="accountId" className="input input-sm !w-32" aria-label={t('account')} required>
                            <option value="">{t('noAccount')}</option>
                            {accounts
                              .filter((account) => account.currency === row.currency)
                              .map((account) => (
                                <option key={account.id} value={account.id}>
                                  {account.name}
                                </option>
                              ))}
                          </select>
                          <button type="submit" className="btn-secondary !min-h-8 px-2 text-xs">
                            {t('placePayment')}
                          </button>
                        </form>
                      ) : (
                        <span className="text-warn">{t('noAccount')}</span>
                      ))}
                  </td>
                  <td className="p-2 text-xs text-ink-500">{row.enteredBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <p className="p-4 text-sm text-ink-500">{t('noPayments')}</p>}
      </div>
    </div>
  );
}
