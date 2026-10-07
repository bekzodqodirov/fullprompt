import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { approvalUnpricedDetail, pendingApprovals } from '@/modules/wms/issue/approvals';
import { debtGrantScope } from '@/modules/wms/finance/scope';
import { mayOpenPricing } from '@/modules/wms/finance/pricing-door';
import { decideIssueApprovalAction } from '../issue/actions';
import { PageHeader } from '@/components/ui/page';

/**
 * The deciders' small screen (phase 6): every open "may I issue to this
 * debtor" question, answerable in two taps. Reached from the Telegram ping;
 * gated on the same permission the direct checkbox needs — deciding IS the
 * override.
 *
 * Since 0104 a request may also ask about cargo with NO PRICE (the owner's
 * Q3b), so each row says which question it asks: the debt only when there is
 * one, and the prixods whose cartons have no price — re-read now, so a prixod
 * the accountant priced meanwhile reads «✅ narx qo'yildi», because pricing is
 * often the better answer than approving.
 *
 * Since 0114 (the owner's 2a) the list is the requests THIS person may decide
 * — `pendingApprovals(actor)` asks `debtGrantScope`, the predicate the
 * decision itself asks — so a seller reads his own clients' debts and nobody
 * else's. The door stays the grant (the menu and the workspace strip promise
 * it), and a holder who may decide nothing — the warehouse manager, who reads
 * no ledger — gets one sentence saying where his requests go, not an empty
 * screen that reads as «nothing is waiting».
 */
export default async function ApprovalsPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.debt_override')) redirect('/');
  const t = await getTranslations('issue');
  const tc = await getTranslations('common');
  const format = await getFormatter();

  const decidesNothing = debtGrantScope(actor) === 'none';
  const tq = await getTranslations('qarz');
  const tqi = await getTranslations('qarzIzoh');
  const rows = await pendingApprovals(actor);
  const unpriced = await approvalUnpricedDetail(rows);
  const pricingLinks = mayOpenPricing(actor.permissions);

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-2xl">
      <PageHeader icon="handshake" title={t('approvalsTitle')} />
      {decidesNothing ? (
        <p className="card text-sm text-ink-700" data-testid="approvals-none-yours">
          {tq('approvalsNoneYours')}
        </p>
      ) : (
        rows.length === 0 && <p className="card text-sm text-ink-500">{tc('empty')}</p>
      )}
      {rows.map((row) => (
        <div key={row.id} className="card space-y-2" data-testid="approval-row">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono font-extrabold text-brand-700">{row.clientCode}</span>
            <span className="min-w-0 flex-1 truncate">{row.clientName}</span>
            {Number(row.blockingDebtUsd) > 0.009 && (
              <span className="font-mono text-lg font-extrabold text-bad" data-testid="approval-debt">
                {t('approvalDebt', { amount: Number(row.blockingDebtUsd).toFixed(2) })}
              </span>
            )}
          </div>
          {(unpriced.get(row.id) ?? []).length > 0 && (
            <div className="rounded-lg bg-bad/5 p-2 text-sm" data-testid="approval-unpriced">
              <p className="font-semibold text-bad">
                💰{' '}
                {t('approvalUnpriced', {
                  receipts: unpriced.get(row.id)!.length,
                  boxes: unpriced.get(row.id)!.reduce((sum, line) => sum + line.snapshotBoxes, 0),
                })}
              </p>
              <ul className="mt-1 space-y-0.5 text-xs">
                {unpriced.get(row.id)!.map((line) => (
                  <li key={line.receiptId} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono">{line.number ?? '—'}</span>
                    {line.stillBoxes === 0 ? (
                      <span className="text-good">{t('approvalPriced')}</span>
                    ) : (
                      <>
                        <span className="text-ink-600">
                          {line.arrivalTrucks.map((truck) => truck.code).join(', ')} · {line.stillBoxes} 📦
                        </span>
                        {pricingLinks &&
                          line.arrivalTrucks.map((truck) => (
                            <Link
                              key={truck.batchId}
                              href={`/batches/${truck.batchId}/pricing`}
                              className="text-brand-700 underline"
                            >
                              {t('approvalPriceLink')}
                            </Link>
                          ))}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-ink-500">
            {row.warehouseCode} · {row.requestedByName} ·{' '}
            {format.dateTime(row.requestedAt, { dateStyle: 'short', timeStyle: 'short' })}
          </p>
          {/* WHY the counter asks (the owner's D5a — mandatory since
              2026-10-07, so every new request carries one; an older row may
              not). Its own wrapping line: a pasted unbroken token must not
              widen the card past the phone (#400). */}
          {row.requestNote && (
            <p
              className="whitespace-pre-wrap break-words text-sm font-semibold text-ink-700"
              data-testid="approval-request-note"
            >
              💬 {tqi('approvalReason')}: {row.requestNote}
            </p>
          )}
          <form action={decideIssueApprovalAction} className="space-y-2">
            <input type="hidden" name="approvalId" value={row.id} />
            <input
              name="note"
              className="input"
              placeholder={t('approvalNote')}
              maxLength={500}
            />
            <div className="flex gap-2">
              <button
                type="submit"
                name="verdict"
                value="approved"
                data-testid="approve-issue"
                className="btn-primary flex-1"
              >
                ✅ {t('approve')}
              </button>
              <button
                type="submit"
                name="verdict"
                value="refused"
                data-testid="refuse-issue"
                className="btn-danger flex-1"
              >
                ⛔ {t('refuse')}
              </button>
            </div>
          </form>
        </div>
      ))}
    </div>
  );
}
