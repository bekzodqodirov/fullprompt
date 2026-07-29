import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { pendingApprovals } from '@/modules/wms/issue/approvals';
import { decideIssueApprovalAction } from '../issue/actions';
import { PageHeader } from '@/components/ui/page';

/**
 * The deciders' small screen (phase 6): every open "may I issue to this
 * debtor" question, answerable in two taps. Reached from the Telegram ping;
 * gated on the same permission the direct checkbox needs — deciding IS the
 * override.
 */
export default async function ApprovalsPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.debt_override')) redirect('/');
  const t = await getTranslations('issue');
  const tc = await getTranslations('common');
  const format = await getFormatter();

  const rows = await pendingApprovals();

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-2xl">
      <PageHeader icon="handshake" title={t('approvalsTitle')} />
      {rows.length === 0 && <p className="card text-sm text-ink-500">{tc('empty')}</p>}
      {rows.map((row) => (
        <div key={row.id} className="card space-y-2" data-testid="approval-row">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono font-extrabold text-brand-700">{row.clientCode}</span>
            <span className="min-w-0 flex-1 truncate">{row.clientName}</span>
            <span className="font-mono text-lg font-extrabold text-bad">
              ${Number(row.blockingDebtUsd).toFixed(2)}
            </span>
          </div>
          <p className="text-xs text-ink-500">
            {row.warehouseCode} · {row.requestedByName} ·{' '}
            {format.dateTime(row.requestedAt, { dateStyle: 'short', timeStyle: 'short' })}
            {row.requestNote && <span className="block">{row.requestNote}</span>}
          </p>
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
