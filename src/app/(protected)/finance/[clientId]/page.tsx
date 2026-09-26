import { eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { clients, currencies, deals } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { moneyOwnerFilter } from '@/modules/wms/finance/scope';
import { clientBalanceUsd, clientLedger, clientNativeBalances } from '@/modules/wms/finance/service';
import Link from 'next/link';
import type { ClientKind } from '@/modules/wms/finance/ledger-kinds';
import { mayClassifyFx } from '@/modules/wms/finance/fx-door';
import { fxPnlEffect } from '@/modules/wms/finance/fx-sign';
import { hasLegacyFx } from '@/modules/wms/finance/fx-legacy';
import { crossCloseOffer } from '@/modules/wms/finance/fx-close';
import { listAccounts } from '@/modules/wms/accounting/service';
import { ledgerDealsForClient } from '@/modules/wms/deals/service';
import { bothFiguresForDeals } from '@/modules/wms/calc/upsale-service';
import { upsaleScopeFor } from '@/modules/wms/calc/upsale-scope';
import { BackLink } from '@/components/back-link';
import { CargoSummary } from '@/components/cargo-summary';
import { clientCargo } from '@/modules/wms/finance/client-cargo';
import { MoveChargeForm } from '../move-charge-form';
import { TxForm } from './tx-form';
import { VoidButton } from './void-button';
import { FxCloseButton, FxCloseUndo } from './fx-close-button';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { mayPickTill } from '@/modules/wms/accounting/till-door';
import { mayVoidLedgerRow } from '@/modules/wms/finance/void-rule';
import { lostCargoChargesOn, lostCargoForClient } from '@/modules/wms/finance/compensation';

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
  // The kassa holders' grant (finance.expenses): hands a refund out AND takes
  // one back (U33) — one predicate for the button, the create door and the
  // void door.
  const canRefund = mayPickTill(actor.permissions);
  if (!actor.permissions.has('finance.view') && !canManage) redirect('/');
  const t = await getTranslations('finance');
  const ta = await getTranslations('accounting');
  const tcargo = await getTranslations('cargo');
  // Kurs farqi (0103): who may SAY money is FX (the close, the links) and who
  // reads what it did to the P&L («bizga foyda/zarar», law 4's audience).
  const mayClassify = mayClassifyFx(actor.permissions);
  const readsPnl = actor.permissions.has('finance.reports');
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
  const [balance, ledger, currencyRows, accounts, openDeals, figures, cargo, natives, legacy, closeOffer] = await Promise.all([
    clientBalanceUsd(clientId),
    clientLedger(clientId),
    db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true)),
    // The drawers are the kassa holders' to name (Q19): nobody else's form
    // offers them, so nobody else's page fetches them.
    canRefund ? listAccounts() : Promise.resolve([]),
    canManage ? ledgerDealsForClient(clientId) : Promise.resolve([]),
    bothFiguresForDeals(clientDeals.map((d) => d.id)),
    // Read once for the cargo block AND the card form's trucks (0104).
    clientCargo(clientId),
    clientNativeBalances(clientId),
    mayClassify ? hasLegacyFx('client', clientId) : Promise.resolve(false),
    canManage && mayClassify ? crossCloseOffer(clientId) : Promise.resolve(null),
  ]);
  // The lost-cargo door's list and the prices of that cargo (0105) — for the
  // kassa holders only, who alone may write a compensation. Two queries.
  const lostReceipts = canManage && canRefund ? await lostCargoForClient(clientId) : null;
  const lostCharges = lostReceipts
    ? await lostCargoChargesOn(db, clientId, lostReceipts.rows.map((row) => row.receiptId))
    : [];
  // The trucks a charge may name, and «🚚 Ko'chirish»'s targets: the
  // client's own ride trucks (never an internal leg — never priced, C1a) and
  // a truck its cargo is loading on now. Cross-border first, unpriced first
  // within each, then newest (a loading truck is the newest of all).
  const chargeTrucks = [
    ...cargo.offTrip
      .filter((off) => off.reason === 'loading')
      .map((off) => ({ batchId: off.batchId, code: off.batchCode, unpriced: false, crossesBorder: off.crossesBorder, at: Infinity })),
    ...cargo.trips
      .filter((trip) => !trip.internal)
      .map((trip) => ({
        batchId: trip.batchId,
        code: trip.batchCode,
        unpriced: trip.unpriced,
        crossesBorder: trip.crossesBorder,
        at: trip.departedAt ? new Date(trip.departedAt).getTime() : 0,
      })),
  ]
    .sort(
      (a, b) =>
        Number(b.crossesBorder) - Number(a.crossesBorder) || Number(b.unpriced) - Number(a.unpriced) || b.at - a.at,
    )
    .map(({ at: _at, ...truck }) => truck);
  // A price moved off the card or off a truck its cargo never rode (0104).
  const noCargoTrucks = new Set(cargo.offTrip.filter((off) => off.reason === 'no_cargo').map((off) => off.batchId));
  // The account in its OWN money (0103, Q14): «12 500 000 UZS · 150 USD». A
  // currency at 0 natively with dollars left is a pre-deploy residue.
  const foreign = natives.some((row) => row.currency !== 'USD');
  const nativeParts = natives.filter((row) => row.native !== 0 || (row.currency !== 'USD' && row.usd !== 0));
  // Literal map (#163): a kind added to the ledger is a type error here, not
  // a «➕ payment» drawn in the ELSE (the pre-0103 reading of a kurs farqi row).
  const KIND: Record<ClientKind, { label: string; tone: string }> = {
    charge: { label: `🧾 ${t('charge')}`, tone: 'text-bad' },
    payment: { label: `➕ ${t('payment')}`, tone: 'text-good' },
    refund: { label: `↩️ ${t('refund')}`, tone: 'text-warn' },
    fx_diff: { label: t('fxDiff'), tone: 'text-ink-700' },
    // It LOWERS what the client owes — the good colour; the brand red read as a debt.
    compensation: { label: `🤝 ${t('compensation')}`, tone: 'text-good' },
  };
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
      {foreign && nativeParts.length > 0 && (
        <p className="text-xs text-ink-700" data-testid="finance-native-balances">
          <span className="text-ink-500">{t('nativeBalances')}</span>{' '}
          {nativeParts.map((row, index) => (
            <span key={row.currency} className="font-mono">
              {index > 0 ? ' · ' : ''}
              {row.native.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} {row.currency}
              {row.native === 0 && row.currency !== 'USD' ? (
                <>
                  {' '}
                  ({row.usd > 0 ? '+' : '−'}${Math.abs(row.usd).toFixed(2)}, {t('fxResidueOld')})
                </>
              ) : null}
            </span>
          ))}
        </p>
      )}
      {mayClassify && legacy && (
        <p className="text-xs">
          <Link href="/accounting/kurs-farqi" className="text-brand-700 underline" data-testid="finance-fx-legacy-link">
            ⚖️ {t('fxLegacyLink')}
          </Link>
        </p>
      )}
      {closeOffer && closeOffer.refusal === null && (
        <FxCloseButton clientId={clientId} amountUsd={closeOffer.balanceUsd} />
      )}

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
          canRefund={canRefund}
          canPickTill={canRefund}
          advanceUsd={balance < -0.009 ? -balance : 0}
          clientId={clientId}
          currencies={currencyRows.map((c) => c.code)}
          accounts={accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
          deals={openDeals.map((d) => ({ id: d.id, code: d.code, title: d.title, cargo: d.cargo }))}
          today={tashkentDay()}
          trips={chargeTrucks}
          lost={
            lostReceipts
              ? {
                  receipts: lostReceipts.rows,
                  charges: lostCharges.map((charge) => ({
                    id: charge.id,
                    receiptId: charge.receiptId,
                    batchCode: charge.batchCode,
                    dealCode: charge.dealCode,
                    amount: charge.amount,
                    currency: charge.currency,
                    txDate: charge.txDate,
                  })),
                  truncated: lostReceipts.truncated,
                }
              : undefined
          }
        />
      )}

      {/* Owner: a balance alone never settles an argument — "which cargo is
          this debt from and how much of it" is the question a client asks on
          the phone, so the trips and their outstanding amounts sit above the
          transaction list. Payments settle the oldest charge first, the same
          rule the receivables ageing report uses. */}
      <div className="card space-y-2">
        <h2 className="text-sm font-bold uppercase text-ink-500">📦 {tcargo('title')}</h2>
        <CargoSummary clientId={clientId} data={cargo} />
      </div>

      <div className="card space-y-1 !p-3">
        <h2 className="text-sm font-bold uppercase text-ink-500">{t('history')}</h2>
        {ledger.length === 0 && <p className="text-sm text-ink-500">{t('empty')}</p>}
        {ledger.map(({ tx, createdByName, batchCode, dealCode, receiptNumber, lostNow, boxesTotal, foundSince, partnerStaff }) => (
          <div
            key={tx.id}
            className={`border-b border-line py-2 text-sm last:border-0 ${tx.voidedAt ? 'opacity-50' : ''}`}
          >
            <div className="flex items-baseline gap-2">
              <span className={`font-bold ${KIND[tx.type as ClientKind]?.tone ?? 'text-ink-700'}`}>
                {KIND[tx.type as ClientKind]?.label ?? tx.type}
              </span>
              {tx.type === 'fx_diff' ? (
                // Native 0 by CHECK: the dollars ARE the row, signed as the
                // ledger adds them.
                <span className={`font-mono font-extrabold ${tx.voidedAt ? 'line-through' : ''}`}>
                  {Number(tx.amountUsd) > 0 ? '+' : '−'}${Math.abs(Number(tx.amountUsd)).toFixed(2)}
                </span>
              ) : (
                <span className={`font-mono font-extrabold ${tx.voidedAt ? 'line-through' : ''}`}>
                  {Number(tx.amount)} {tx.currency}
                </span>
              )}
              {tx.type === 'fx_diff' && readsPnl && !tx.voidedAt && (
                <span className="text-xs font-semibold text-ink-700" data-testid="tx-fx-effect">
                  {ta('fxEffect', {
                    kind: fxPnlEffect('client', Number(tx.amountUsd)) >= 0 ? 'gain' : 'loss',
                    usd: `$${Math.abs(fxPnlEffect('client', Number(tx.amountUsd))).toFixed(2)}`,
                  })}
                </span>
              )}
              {tx.type !== 'fx_diff' && tx.currency !== 'USD' && (
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
            <div className="mt-0.5 flex flex-wrap items-baseline gap-2 text-xs text-ink-500">
              {batchCode && <span className="font-mono font-semibold">{batchCode}</span>}
              {tx.type === 'compensation' && tx.receiptId && (
                <span data-testid="tx-compensation-receipt">
                  <Link href={`/receipts/${tx.receiptId}`} className="font-mono font-semibold text-brand-700 underline">
                    {receiptNumber ?? '—'}
                  </Link>{' '}
                  {t('compensationLostCount', { count: lostNow ?? 0, total: boxesTotal ?? 0 })}
                </span>
              )}
              {dealCode && (
                <span className="font-mono font-semibold text-brand-700" data-testid="tx-deal-code">
                  {dealCode}
                </span>
              )}
              {tx.type === 'fx_diff' && (
                <span>{tx.currency === 'USD' ? t('fxCloseNote') : t('fxDiffNote', { currency: tx.currency })}</span>
              )}
              {tx.note && <span className="truncate">{tx.note}</span>}
              <span>{createdByName}</span>
              {tx.voidedAt ? (
                <span className="text-bad">✖ {t('voided')}: {tx.voidReason}</span>
              ) : tx.type === 'fx_diff' ? (
                // The system's row changes only with its cycle; the hand close
                // (a DOLLAR row) has its own undo, for its own audience.
                canManage &&
                mayClassify &&
                tx.currency === 'USD' && (
                  <span className="ml-auto">
                    <FxCloseUndo id={tx.id} clientId={clientId} />
                  </span>
                )
              ) : (
                // The ✖ is drawn exactly where the void's own claim would
                // let it through (Q19: a placed payment and a refund are the
                // kassa holders'; a non-holder keeps prices, settlement
                // halves and his own not-yet-placed payment).
                canManage &&
                mayVoidLedgerRow(
                  { type: tx.type, accountId: tx.accountId, partnerId: tx.partnerId, partnerStaff: partnerStaff === true, createdBy: tx.createdBy },
                  { mayMoveTill: canRefund, actorId: actor.id },
                ) && (
                  <span className="ml-auto">
                    <VoidButton id={tx.id} clientId={clientId} kind={tx.type} />
                  </span>
                )
              )}
            </div>
            {/* A carton of the compensated prixod came back from «yo'qolgan»
                (0105, Q6): said on the row, on its own line. */}
            {tx.type === 'compensation' && !tx.voidedAt && (foundSince ?? 0) > 0 && (
              <p className="mt-0.5 w-full text-xs font-semibold text-warn" data-testid="tx-compensation-found">
                {t('compensationFound', { count: foundSince ?? 0 })}
              </p>
            )}
            {/* A price on the card, or on a truck the cargo never rode (0104):
                one press onto the truck it did. */}
            {!tx.voidedAt &&
              canManage &&
              tx.type === 'charge' &&
              !tx.partnerId &&
              (!tx.batchId || noCargoTrucks.has(tx.batchId)) && (
                <MoveChargeForm
                  txId={tx.id}
                  clientId={clientId}
                  amount={Number(tx.amount)}
                  currency={tx.currency}
                  fromBatchId={null}
                  targets={chargeTrucks.filter((truck) => truck.batchId !== tx.batchId)}
                />
              )}
          </div>
        ))}
      </div>
    </div>
  );
}
