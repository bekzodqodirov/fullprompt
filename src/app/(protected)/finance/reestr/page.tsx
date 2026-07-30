import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { BackLink } from '@/components/back-link';
import { PageHeader } from '@/components/ui/page';
import { paymentsRegister } from '@/modules/wms/finance/service';
import { FinanceClientSearch } from '../client-search';

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
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.view') && !actor.permissions.has('finance.manage')) {
    redirect('/');
  }
  const t = await getTranslations('finance');
  const params = await searchParams;

  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 8)}01`;
  const valid = (value?: string) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
  const from = valid(params.from) ?? monthStart;
  const to = valid(params.to) ?? today;

  const { rows, totalUsd, count } = await paymentsRegister(from, to);

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
                  <td className="p-2 text-xs">
                    {row.accountName ?? <span className="text-warn">{t('noAccount')}</span>}
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
