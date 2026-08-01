import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { currencies, moneyAccounts } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { partnerBalanceUsd, partnerById, partnerLedger } from '@/modules/wms/partners/service';
import { BackLink } from '@/components/back-link';
import { HistoryTab } from '@/components/history-tab';
import { PartnerTxForm } from './tx-form';
import { VoidTx } from './void-tx';
import { setPartnerActiveAction } from '../actions';

/**
 * One counterparty's account.
 *
 * Reads like the client ledger on purpose — same shape, opposite sign — so
 * nobody has to learn a second screen. The rows that came from a cost or an
 * expense say so and link to the truck, because the first question about a
 * debt is always "for which one".
 */
export default async function PartnerCardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.view') && !actor.permissions.has('finance.manage')) {
    redirect('/');
  }
  const { id } = await params;
  const row = await partnerById(id);
  if (!row) notFound();

  const t = await getTranslations('partners');
  const tc = await getTranslations('common');
  const format = await getFormatter();
  const canManage = actor.permissions.has('finance.manage');

  const balance = await partnerBalanceUsd(id);
  const ledger = await partnerLedger(id);
  const accounts = canManage
    ? await db
        .select({ id: moneyAccounts.id, name: moneyAccounts.name })
        .from(moneyAccounts)
        .where(eq(moneyAccounts.active, true))
        .orderBy(asc(moneyAccounts.sortOrder))
    : [];
  const currencyCodes = canManage
    ? (
        await db
          .select({ code: currencies.code })
          .from(currencies)
          .where(eq(currencies.active, true))
      ).map((c) => c.code)
    : [];

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <BackLink href="/kontragentlar" label={t('title')} />

      <div className="card space-y-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="text-xl font-bold">{row.partner.name}</h1>
          <span className="rounded bg-surface-sunken px-2 py-0.5 text-xs font-semibold">
            {row.typeName}
          </span>
          {!row.partner.active && (
            <span className="rounded bg-bad/15 px-2 py-0.5 text-xs font-bold text-bad">
              {t('inactive')}
            </span>
          )}
        </div>
        {row.clientCode && (
          <p className="text-sm">
            {/* The same person on both sides of the money — the card says so
                and links, so nobody settles one ledger unaware of the other. */}
            <span className="text-ink-500">{t('alsoClient')}: </span>
            <Link
              href={`/finance/${row.partner.clientId}`}
              className="font-mono font-bold text-brand-700 underline"
              data-testid="partner-client-link"
            >
              {row.clientCode} — {row.clientName}
            </Link>
          </p>
        )}
        {row.partner.phone && <p className="text-sm text-ink-700">{row.partner.phone}</p>}
        {canManage && (
          <form action={setPartnerActiveAction}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="active" value={row.partner.active ? '0' : '1'} />
            {/* Retired, never deleted: the account it carries is a record. */}
            <button
              type="submit"
              className="btn-secondary !py-1 px-2 text-xs"
              data-testid="partner-toggle-active"
            >
              {row.partner.active ? t('hide') : t('show')}
            </button>
          </form>
        )}
        {row.partner.note && <p className="text-sm italic text-ink-500">{row.partner.note}</p>}
        <p className="pt-1">
          <span className="text-sm text-ink-700">{t('weOwe')}: </span>
          <span
            className={`font-mono text-2xl font-extrabold ${
              balance > 0.009 ? 'text-bad' : balance < -0.009 ? 'text-good' : 'text-ink-500'
            }`}
            data-testid="partner-balance"
          >
            ${balance.toFixed(2)}
          </span>
        </p>
      </div>

      {canManage && (
        <PartnerTxForm partnerId={id} accounts={accounts} currencies={currencyCodes} />
      )}

      <section className="card !p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase text-ink-500">
              <th className="p-2">{t('date')}</th>
              <th className="p-2">{t('kind')}</th>
              <th className="p-2 text-right">{t('amount')}</th>
              <th className="p-2 text-right">USD</th>
            </tr>
          </thead>
          <tbody data-testid="partner-ledger">
            {ledger.map(({ tx, accountName, batchCode, authorName }) => {
              const raises = tx.type === 'charge' || tx.type === 'receipt';
              const usd = Number(tx.amountUsd);
              return (
                <tr key={tx.id} className="border-b border-line align-top last:border-0">
                  <td className="p-2 whitespace-nowrap">
                    {format.dateTime(new Date(`${tx.txDate}T00:00:00Z`), { dateStyle: 'short' })}
                  </td>
                  <td className="p-2">
                    <span className={tx.voidedAt ? 'text-ink-500 line-through' : ''}>
                      {t(`kinds.${tx.type}` as 'kinds.charge')}
                    </span>
                    {batchCode && (
                      <Link
                        href={`/batches/${tx.batchId}`}
                        className="ml-1 font-mono text-xs text-brand-700 underline"
                      >
                        {batchCode}
                      </Link>
                    )}
                    {accountName && (
                      <span className="ml-1 text-xs text-ink-500">· {accountName}</span>
                    )}
                    {tx.note && <p className="text-xs text-ink-500">{tx.note}</p>}
                    {tx.voidedAt && (
                      <p className="text-xs font-semibold text-bad">
                        ✕ {tx.voidReason}
                      </p>
                    )}
                    <p className="text-xs text-ink-500">{authorName}</p>
                    {canManage && !tx.voidedAt && <VoidTx id={tx.id} partnerId={id} />}
                  </td>
                  <td className="p-2 text-right font-mono whitespace-nowrap">
                    {tx.amount} {tx.currency}
                  </td>
                  <td
                    className={`p-2 text-right font-mono font-bold ${
                      tx.voidedAt ? 'text-ink-500 line-through' : raises ? 'text-bad' : 'text-good'
                    }`}
                  >
                    {raises ? '+' : '−'}${Math.abs(usd).toFixed(2)}
                  </td>
                </tr>
              );
            })}
            {ledger.length === 0 && (
              <tr>
                <td colSpan={4} className="p-4 text-center text-ink-500">
                  {t('noRows')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-bold">{tc('history')}</h2>
        <HistoryTab entityType="partner" entityId={id} />
      </section>
    </div>
  );
}
