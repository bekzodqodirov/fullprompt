import { eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { clients, currencies } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { clientBalanceUsd, clientLedger } from '@/modules/wms/finance/service';
import { listAccounts } from '@/modules/wms/accounting/service';
import { openDealsForClient } from '@/modules/wms/deals/service';
import { BackLink } from '@/components/back-link';
import { CargoSummary } from '@/components/cargo-summary';
import { TxForm } from './tx-form';
import { VoidButton } from './void-button';

/** One client's money ledger: balance, add charge/payment, full history. */
export default async function ClientLedgerPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  const canManage = actor.permissions.has('finance.manage');
  if (!actor.permissions.has('finance.view') && !canManage) redirect('/');
  const t = await getTranslations('finance');
  const tcargo = await getTranslations('cargo');
  const format = await getFormatter();

  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client) notFound();

  const [balance, ledger, currencyRows, accounts, openDeals] = await Promise.all([
    clientBalanceUsd(clientId),
    clientLedger(clientId),
    db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true)),
    listAccounts(),
    canManage ? openDealsForClient(clientId) : Promise.resolve([]),
  ]);

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-2xl">
      <BackLink href="/finance" label={t('title')} />
      <h1 className="text-xl font-bold">
        💰 <span className="font-mono text-brand-700">{client.clientCode}</span> — {client.name}
      </h1>

      <div className="card flex items-baseline gap-2">
        <span className="text-sm text-ink-700">{t('balance')}:</span>
        <span
          className={`font-mono text-2xl font-extrabold ${balance > 0.009 ? 'text-bad' : 'text-good'}`}
        >
          ${balance.toFixed(2)}
        </span>
        {balance > 0.009 && <span className="text-sm font-semibold text-bad">{t('debtor')}</span>}
      </div>

      {canManage && (
        <TxForm
          clientId={clientId}
          currencies={currencyRows.map((c) => c.code)}
          accounts={accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
          deals={openDeals.map((d) => ({ id: d.id, code: d.code, title: d.title }))}
          today={new Date().toISOString().slice(0, 10)}
        />
      )}

      {/* Owner: a balance alone never settles an argument — "which cargo is
          this debt from and how much of it" is the question a client asks on
          the phone, so the trips and their outstanding amounts sit above the
          transaction list. Payments settle the oldest charge first, the same
          rule the receivables ageing report uses. */}
      <div className="card space-y-2">
        <h2 className="text-sm font-bold uppercase text-ink-500">📦 {tcargo('title')}</h2>
        <CargoSummary clientId={clientId} />
      </div>

      <div className="card space-y-1 !p-3">
        <h2 className="text-sm font-bold uppercase text-ink-500">{t('history')}</h2>
        {ledger.length === 0 && <p className="text-sm text-ink-500">{t('empty')}</p>}
        {ledger.map(({ tx, createdByName, batchCode }) => (
          <div
            key={tx.id}
            className={`border-b border-line py-2 text-sm last:border-0 ${tx.voidedAt ? 'opacity-50' : ''}`}
          >
            <div className="flex items-baseline gap-2">
              <span className={`font-bold ${tx.type === 'charge' ? 'text-bad' : 'text-good'}`}>
                {tx.type === 'charge' ? '🧾' : '➕'} {tx.type === 'charge' ? t('charge') : t('payment')}
              </span>
              <span className={`font-mono font-extrabold ${tx.voidedAt ? 'line-through' : ''}`}>
                {Number(tx.amount)} {tx.currency}
              </span>
              {tx.currency !== 'USD' && (
                <span className="font-mono text-xs text-ink-500">≈ ${Number(tx.amountUsd).toFixed(2)}</span>
              )}
              {tx.method && (
                <span className="text-xs text-ink-500">
                  {tx.method === 'cash' ? `💵 ${t('methodCash')}` : tx.method === 'card' ? `💳 ${t('methodCard')}` : `🏦 ${t('methodTransfer')}`}
                </span>
              )}
              <span className="ml-auto whitespace-nowrap text-xs text-ink-500">
                {format.dateTime(new Date(tx.createdAt), { dateStyle: 'short' })}
              </span>
            </div>
            <div className="mt-0.5 flex items-baseline gap-2 text-xs text-ink-500">
              {batchCode && <span className="font-mono font-semibold">{batchCode}</span>}
              {tx.note && <span className="truncate">{tx.note}</span>}
              <span>{createdByName}</span>
              {tx.voidedAt ? (
                <span className="text-bad">✖ {t('voided')}: {tx.voidReason}</span>
              ) : (
                canManage && (
                  <span className="ml-auto">
                    <VoidButton id={tx.id} clientId={clientId} />
                  </span>
                )
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
