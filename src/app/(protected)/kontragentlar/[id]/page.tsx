import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { asc, eq, or } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { clients, currencies, moneyAccounts, users } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { seesAllMoney } from '@/modules/wms/finance/scope';
import {
  listPartnerTypes,
  partnerBalanceUsd,
  partnerById,
  partnerLedger,
  partnerNativeBalances,
  raisesBalance,
} from '@/modules/wms/partners/service';
import type { PartnerTxType } from '@/modules/wms/partners/ledger-sign';
import { mayClassifyFx } from '@/modules/wms/finance/fx-door';
import { fxPnlEffect } from '@/modules/wms/finance/fx-sign';
import { hasLegacyFx } from '@/modules/wms/finance/fx-legacy';
import { ClassifyAdjust } from './classify-adjust';
import { BackLink } from '@/components/back-link';
import { HistoryTab } from '@/components/history-tab';
import { PartnerForm } from '../partner-form';
import { PartnerTxForm } from './tx-form';
import { VoidTx } from './void-tx';
import { setPartnerActiveAction } from '../actions';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { maySeeStaffMoney } from '@/modules/wms/partners/staff';
import { mayPickTill } from '@/modules/wms/accounting/till-door';
import { moneyHidden } from '@/modules/platform/rbac/money-sight';
import { termStates } from '@/modules/wms/partners/terms-service';
import { TermsStatus } from '../terms-status';
import { PartnerTermsForm } from './terms-form';

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
  // The list screen's gate, restated: a partner ledger is company money and
  // has no owner to scope it to, so it belongs to the money MANAGERS.
  if (!seesAllMoney(actor)) redirect('/');
  const { id } = await params;
  const row = await partnerById(id);
  if (!row) notFound();
  // A colleague's advance is payroll, not a supplier's bill (owner M3a): the
  // VED and the logist pass the gate above and must not read it. notFound,
  // not a redirect — the list hides these rows, so the card must not confirm
  // that the id is an account at all.
  const seesStaff = maySeeStaffMoney(actor.permissions);
  if (row.staff && !seesStaff) notFound();

  const t = await getTranslations('partners');
  const ta = await getTranslations('accounting');
  const tc = await getTranslations('common');
  const format = await getFormatter();
  const canManage = actor.permissions.has('finance.manage');
  // A till moved on this card — a payment, a receipt, and the void of one —
  // is the accountant's and the admin's (owner's answer b, 2026-09-25). The
  // VED keeps the card and the «kurs farqi» adjust; the kassas are not
  // offered, and the action refuses them anyway.
  const movesTills = canManage && mayPickTill(actor.permissions);
  // Kurs farqi (0103): who says what a correction IS (Q12's split) and who
  // reads what a kurs farqi row did to the P&L.
  const mayClassify = canManage && mayClassifyFx(actor.permissions);
  const readsPnl = actor.permissions.has('finance.reports');

  const [balance, ledger, natives, legacy, terms] = await Promise.all([
    partnerBalanceUsd(id),
    partnerLedger(id),
    partnerNativeBalances(id),
    mayClassify ? hasLegacyFx('partner', id) : Promise.resolve(false),
    termStates([id]),
  ]);
  const nativeParts = natives.filter((row) => row.native !== 0 || (row.currency !== 'USD' && row.usd !== 0));
  const accounts = movesTills
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

  // Editing was reachable from nowhere: `savePartner` branches on an `id` that
  // no form ever posted. The types offered are the live ones plus whichever
  // this account already carries — a retired type must not be offered to
  // others but must not silently reassign this one either — and the client
  // list includes the currently linked client even when inactive, or saving an
  // unrelated edit would blank the link without saying so.
  const editTypes = canManage
    ? (await listPartnerTypes(true)).filter(
        (type) =>
          type.id === row.partner.typeId ||
          (type.active && (seesStaff || type.code !== 'staff')),
      )
    : [];
  // The login picker (accountant and admin only): active people plus whoever
  // this account is ALREADY linked to, or an unrelated edit on a leaver's
  // account would silently unlink it — the client picker's rule, restated.
  const linkedUserId = row.partner.userId;
  const editUsers =
    canManage && seesStaff
      ? await db
          .select({ id: users.id, name: users.fullName })
          .from(users)
          .where(
            linkedUserId
              ? or(eq(users.active, true), eq(users.id, linkedUserId))
              : eq(users.active, true),
          )
          .orderBy(asc(users.fullName))
      : null;
  const linkedUserName = linkedUserId
    ? ((
        await db
          .select({ name: users.fullName })
          .from(users)
          .where(eq(users.id, linkedUserId))
          .limit(1)
      )[0]?.name ?? null)
    : null;
  // On a staff card the two cash kinds are said in payroll words — the same
  // rows and the same signs, only what a person calls them (owner A1c).
  // Literal maps (#163): a kind the ledger learns is a type error here.
  const KIND: Record<PartnerTxType, string> = {
    charge: t('kinds.charge'),
    receipt: row.staff ? t('staffKinds.receipt') : t('kinds.receipt'),
    payment: row.staff ? t('staffKinds.payment') : t('kinds.payment'),
    offset: t('kinds.offset'),
    adjust: t('kinds.adjust'),
    fx_diff: t('kinds.fx_diff'),
  };
  const kindLabel = (type: string) => KIND[type as PartnerTxType] ?? type;
  const ADJUST_KIND: Record<'fx' | 'correction', string> = {
    fx: t('adjustKinds.fx'),
    correction: t('adjustKinds.correction'),
  };
  const editClients = canManage
    ? await db
        .select({ id: clients.id, clientCode: clients.clientCode, name: clients.name })
        .from(clients)
        .where(
          row.partner.clientId
            ? or(eq(clients.active, true), eq(clients.id, row.partner.clientId))
            : eq(clients.active, true),
        )
        .orderBy(asc(clients.clientCode))
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
        {linkedUserName && (
          <p className="text-sm" data-testid="partner-login">
            <span className="text-ink-500">{t('login')}: </span>
            <b>{linkedUserName}</b>
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
        {nativeParts.some((part) => part.currency !== 'USD') && (
          <p className="text-xs text-ink-700" data-testid="partner-native-balances">
            <span className="text-ink-500">{t('nativeBalances')}</span>{' '}
            <span className="font-mono">
              {nativeParts
                .map((part) =>
                  part.native === 0 && part.currency !== 'USD'
                    ? `0 ${part.currency} (${part.usd > 0 ? '+' : '−'}$${Math.abs(part.usd).toFixed(2)})`
                    : `${part.native.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${part.currency}`,
                )
                .join(' · ')}
            </span>
          </p>
        )}
        <TermsStatus state={terms.get(id)} />
        {mayClassify && legacy && (
          <p className="text-xs">
            <Link href="/accounting/kurs-farqi" className="text-brand-700 underline" data-testid="partner-fx-legacy-link">
              ⚖️ {t('fxLegacyLink')}
            </Link>
          </p>
        )}
      </div>

      {canManage && (
        <PartnerTermsForm
          id={id}
          payWithinDays={terms.get(id)?.payWithinDays ?? null}
          debtLimitUsd={terms.get(id)?.debtLimitUsd ?? null}
        />
      )}

      {canManage && (
        <PartnerForm
          types={editTypes}
          clients={editClients}
          staffUsers={editUsers}
          partner={{
            id,
            name: row.partner.name,
            typeId: row.partner.typeId,
            clientId: row.partner.clientId,
            phone: row.partner.phone,
            note: row.partner.note,
            userId: row.partner.userId,
          }}
        />
      )}

      {canManage && (
        <PartnerTxForm
          partnerId={id}
          staff={row.staff}
          movesTills={movesTills}
          mayClassify={mayClassify}
          accounts={accounts}
          currencies={currencyCodes}
          today={tashkentDay()}
        />
      )}

      {/* The scroll container the other 18 wide tables in the app already use.
          Without it this table is ~430 px on a 360 px phone, and mobile Chrome
          answers an over-wide page by zooming the WHOLE screen out — the
          round-29 failure mode, where every tap coordinate then shifts. */}
      <section className="card overflow-x-auto !p-0">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase text-ink-500">
              <th className="p-2">{t('date')}</th>
              <th className="p-2">{t('kind')}</th>
              <th className="p-2 text-right">{t('amount')}</th>
              <th className="p-2 text-right">USD</th>
            </tr>
          </thead>
          <tbody data-testid="partner-ledger">
            {ledger.map(({ tx, accountName, batchCode, authorName, expenseRecurringId, expenseVoided }) => {
              const usd = Number(tx.amountUsd);
              // The same predicate the BALANCE uses, not a second opinion.
              const raises = raisesBalance(tx.type, usd);
              return (
                <tr key={tx.id} className="border-b border-line align-top last:border-0">
                  <td className="p-2 whitespace-nowrap">
                    {format.dateTime(new Date(`${tx.txDate}T00:00:00Z`), { dateStyle: 'short' })}
                  </td>
                  <td className="p-2">
                    <span className={tx.voidedAt ? 'text-ink-500 line-through' : ''}>
                      {kindLabel(tx.type)}
                    </span>
                    {batchCode && (
                      <Link
                        href={`/batches/${tx.batchId}`}
                        className="ml-1 font-mono text-xs text-brand-700 underline"
                      >
                        {batchCode}
                      </Link>
                    )}
                    {/* The firm's debt history stays his (U33 B); which of
                        our drawers paid it does not (Q19). */}
                    {accountName && !moneyHidden('kassa', actor.permissions) && (
                      <span className="ml-1 text-xs text-ink-500">· {accountName}</span>
                    )}
                    {tx.type === 'charge' && !tx.costEntryId && !tx.expenseId && !tx.voidedAt && (
                      // Typed on this card before the kind left it (audit A31):
                      // a debt with no cost behind it, so no P&L saw it.
                      <p className="text-xs font-semibold text-warn" data-testid="partner-manual-charge">
                        ⚠ {t('manualCharge')}
                      </p>
                    )}
                    {tx.type === 'adjust' && !tx.voidedAt && (
                      // What the correction IS (0103): the P&L reads the kind.
                      <p className="text-xs text-ink-500" data-testid="partner-adjust-kind">
                        {tx.adjustKind === 'fx' || tx.adjustKind === 'correction'
                          ? ADJUST_KIND[tx.adjustKind]
                          : t('adjustKinds.unset')}
                        {!tx.adjustKind && mayClassify && <ClassifyAdjust id={tx.id} />}
                      </p>
                    )}
                    {tx.type === 'fx_diff' && !tx.voidedAt && readsPnl && (
                      <p className="text-xs font-semibold text-ink-700" data-testid="partner-fx-effect">
                        {ta('fxEffect', {
                          kind: fxPnlEffect('partner', usd) >= 0 ? 'gain' : 'loss',
                          usd: `$${Math.abs(fxPnlEffect('partner', usd)).toFixed(2)}`,
                        })}
                      </p>
                    )}
                    {tx.note && <p className="text-xs text-ink-500">{tx.note}</p>}
                    {tx.voidedAt && (
                      <p className="text-xs font-semibold text-bad">
                        ✕ {tx.voidReason}
                      </p>
                    )}
                    <p className="text-xs text-ink-500">{authorName}</p>
                    {/* A debt a cost or an expense wrote is the accountant's
                        and the admin's to cancel here (the action refuses the
                        rest); the person who typed the cost takes it back
                        from the cost itself, where its own rule is asked. */}
                    {/* A recurring month paid through this firm (0106) is
                        cancelled by voiding the EXPENSE, which takes this
                        debt with it and re-opens the month; the service
                        refuses it here, and a refusal this form cannot
                        print must not be offered at all. */}
                    {tx.expenseId && !tx.voidedAt && !expenseVoided ? (
                      // Any expense's debt is cancelled on the EXPENSE (the
                      // service refuses it here): the recurring month's note
                      // says where, and so does every other expense's.
                      <p
                        className="text-xs text-ink-500"
                        data-testid={expenseRecurringId ? 'partner-recurring-charge' : 'partner-expense-charge'}
                      >
                        {t(expenseRecurringId ? 'recurringChargeNote' : 'expenseChargeNote')}
                      </p>
                    ) : (
                      canManage &&
                      !tx.voidedAt &&
                      // The system's kurs farqi row changes only with its cycle (Q14).
                      tx.type !== 'fx_diff' &&
                      (!tx.accountId || movesTills) &&
                      (!(tx.costEntryId || tx.expenseId) || movesTills) && (
                        <VoidTx id={tx.id} partnerId={id} />
                      )
                    )}
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
