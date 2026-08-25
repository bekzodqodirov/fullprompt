import { eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { clients, currencies, deals } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { moneyOwnerFilter } from '@/modules/wms/finance/scope';
import { clientBalanceUsd, clientLedger } from '@/modules/wms/finance/service';
import { listAccounts } from '@/modules/wms/accounting/service';
import { ledgerDealsForClient } from '@/modules/wms/deals/service';
import { bothFiguresForDeals } from '@/modules/wms/calc/upsale-service';
import { upsaleScopeFor } from '@/modules/wms/calc/upsale-scope';
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
  // Scoping a LIST and leaving the address bar open is not scoping: the row
  // is gone from /finance and the ledger is one typed uuid away. `notFound`
  // rather than a refusal, so the URL cannot be used to ask whether a client
  // exists at all.
  const ownerFilter = moneyOwnerFilter(actor);
  if (ownerFilter && client.salesManagerId !== ownerFilter) notFound();

  // Law 4's accountant half: at cash INTAKE the person taking the money sees
  // the sealed floor and the client price side by side. Gated on the upsale
  // scope and not on finance.view — the difference between the two numbers IS
  // the upsale, and the VED (finance.manage, no finance.reports) must not
  // read it here any more than on /upsale.
  const seesBothFigures = upsaleScopeFor(actor) === 'all';
  const clientDeals = seesBothFigures
    ? await db
        .select({ id: deals.id, code: deals.code, title: deals.title })
        .from(deals)
        .where(eq(deals.clientId, clientId))
    : [];
  const [balance, ledger, currencyRows, accounts, openDeals, figures] = await Promise.all([
    clientBalanceUsd(clientId),
    clientLedger(clientId),
    db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true)),
    listAccounts(),
    canManage ? ledgerDealsForClient(clientId) : Promise.resolve([]),
    bothFiguresForDeals(clientDeals.map((d) => d.id)),
  ]);
  const quoted = clientDeals
    .map((d) => ({ ...d, fig: figures.get(d.id) }))
    .filter((d): d is typeof d & { fig: { floorUsd: number; clientPriceUsd: number } } => Boolean(d.fig));

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

      {quoted.length > 0 ? (
        <section className="card !p-3" data-testid="both-figures">
          <p className="text-2xs uppercase text-ink-500">{t('bothFigures')}</p>
          <ul className="mt-1 space-y-1">
            {quoted.map((d) => (
              <li key={d.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="font-mono text-xs text-ink-500">{d.code}</span>
                {d.title ? <span className="truncate text-xs text-ink-700">{d.title}</span> : null}
                <span className="ml-auto font-mono tabular-nums">
                  <span className="text-ink-500">{t('floorShort')}</span> ${d.fig.floorUsd.toFixed(2)}
                  <span className="mx-1 text-ink-300">·</span>
                  <span className="text-ink-500">{t('clientPriceShort')}</span>{' '}
                  <span className="font-semibold">${d.fig.clientPriceUsd.toFixed(2)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
