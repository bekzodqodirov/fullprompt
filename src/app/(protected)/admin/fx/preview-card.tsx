'use client';

import { useTranslations } from 'next-intl';
import type { PlanView } from './actions';

const money = (value: number) =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const BALANCE_LINES = 50;

/**
 * «Bu kurs saqlansa, quyidagilar qayta hisoblanadi» (Q18, design §6.6): what
 * the confirm would move, BEFORE it moves — one line per list, the accounts
 * whose balance changes by name, the payments left alone said so, and the
 * months' net for law 4's audience. The hidden hash makes the confirm apply
 * exactly THIS plan; a different one is shown again (`changed`).
 */
export function PreviewCard({ plan, changed }: { plan: PlanView; changed?: boolean }) {
  const t = useTranslations('costing');
  const sum = (list: { oldUsd: number; newUsd: number }[]) => list.reduce((a, c) => a + c.newUsd - c.oldUsd, 0);
  const lines: [string, number, number][] = [
    ['credit', plan.costs.filter((c) => c.ownerId).length, sum(plan.costs.filter((c) => c.ownerId))],
    ['queue', plan.costs.filter((c) => !c.ownerId).length, sum(plan.costs.filter((c) => !c.ownerId))],
    ['kassa', plan.kassaCosts.length, sum(plan.kassaCosts)],
    ['partner', plan.manualCharges.length, sum(plan.manualCharges)],
    ['expenses', plan.expenses.length, sum(plan.expenses)],
    ['clients', plan.clientCharges.length, sum(plan.clientCharges)],
  ];
  const clients = new Set(plan.clientCharges.map((c) => c.ownerId)).size;
  const fxUsd = plan.fx.reduce((a, f) => a + f.amountUsd, 0);
  // Literal map (#163).
  const say = (key: string, n: number, usd: number) => {
    const signed = `${usd >= 0 ? '+' : '−'}${money(Math.abs(usd))}`;
    if (key === 'credit') return t('fxPreviewCredit', { count: n, usd: signed });
    if (key === 'queue') return t('fxPreviewQueue', { count: n, usd: signed });
    if (key === 'kassa') return t('fxPreviewKassaCosts', { count: n, usd: signed });
    if (key === 'partner') return t('fxPreviewPartnerCharges', { count: n, usd: signed });
    if (key === 'expenses') return t('fxPreviewExpenses', { count: n, usd: signed });
    return t('fxPreviewClients', { count: n, clients, usd: signed });
  };
  return (
    <div className="space-y-2 rounded-lg border border-warn/40 bg-warn/5 p-3 text-sm" data-testid="fx-preview">
      {changed && <p className="font-semibold text-warn">{t('fxPreviewChanged')}</p>}
      <p className="font-semibold">{t('fxPreviewTitle')}</p>
      <ul className="space-y-0.5 text-xs text-ink-700">
        {lines
          .filter(([, n]) => n > 0)
          .map(([key, n, usd]) => (
            <li key={key}>• {say(key, n, usd)}</li>
          ))}
        {plan.fx.length > 0 && (
          <li>• {t('fxPreviewFxDiff', { count: plan.fx.length, usd: `${fxUsd >= 0 ? '+' : '−'}${money(Math.abs(fxUsd))}` })}</li>
        )}
        {plan.settledOld > 0 && <li>• {t('fxPreviewSettledOld', { count: plan.settledOld })}</li>}
        {plan.kassaMissing > 0 && <li>• {t('fxPreviewKassaMissing', { count: plan.kassaMissing })}</li>}
        {plan.waitingCount > 0 && <li>• {t('fxPreviewWaiting', { count: plan.waitingCount })}</li>}
      </ul>
      {plan.balances.length > 0 && (
        <div className="text-xs" data-testid="fx-preview-balances">
          <p className="font-semibold">{t('fxPreviewBalances', { count: plan.balances.length })}</p>
          <ul className="space-y-0.5 font-mono">
            {plan.balances.slice(0, BALANCE_LINES).map((b) => (
              <li key={`${b.ledger}-${b.ownerId}`} className="[overflow-wrap:anywhere]">
                {t('fxPreviewBalanceLine', { name: b.label, before: money(b.before), after: money(b.after) })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {plan.frozenPayments > 0 && (
        <p className="text-xs text-ink-700">
          {t('fxPreviewFrozen', { count: plan.frozenPayments })} {t('fxPreviewFrozenHint')}
        </p>
      )}
      {plan.months && Object.keys(plan.months).length > 0 && (
        <div className="text-xs" data-testid="fx-preview-months">
          <p className="font-semibold">{t('fxPreviewMonths')}</p>
          <ul className="font-mono">
            {Object.entries(plan.months)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([month, row]) => (
                <li key={month}>
                  {month}: {row.net >= 0 ? '+' : '−'}
                  {money(Math.abs(row.net))}
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
