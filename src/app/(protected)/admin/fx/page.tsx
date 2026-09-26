import { desc, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { currencies, fxRates, users } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { perUsd } from '@/modules/wms/costing/fx-display';
import { FxForm } from './fx-form';
import { PageHeader } from '@/components/ui/page';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { unplacedCostSince } from '@/modules/wms/costing/service';
import { staleDebtSummary, stalePayments } from '@/modules/wms/costing/fx-reprice';
import { StaleReview } from './stale-review';

/** Dated manual FX rates (W9) — USD is the costing base. */
export default async function FxPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('costs.fx.manage')) redirect('/');
  const t = await getTranslations('costing');

  const currencyRows = await db
    .select({ code: currencies.code })
    .from(currencies)
    .where(eq(currencies.active, true));
  const rates = await db
    .select({ rate: fxRates, enteredBy: users.fullName })
    .from(fxRates)
    .leftJoin(users, eq(fxRates.enteredBy, users.id))
    .orderBy(desc(fxRates.effectiveDate), desc(fxRates.createdAt))
    .limit(100);

  // Q18 (0103): debts still off their day's rate, per (currency, month) —
  // a rate saved before the re-price existed, or a race with a save — and the
  // payments that are, which are listed and never re-priced (regression-6).
  const since = await unplacedCostSince();
  const [stale, frozen] = await Promise.all([staleDebtSummary(since), stalePayments(null, 200)]);
  const frozenByCurrency = new Map<string, typeof frozen>();
  for (const row of frozen) frozenByCurrency.set(row.currency, [...(frozenByCurrency.get(row.currency) ?? []), row]);
  const money = (value: number) =>
    `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // Literal map (#163): the kinds `frozenPaymentsSql` can answer.
  const KIND: Record<string, string> = {
    payment: t('fxStaleKinds.payment'),
    refund: t('fxStaleKinds.refund'),
    receipt: t('fxStaleKinds.receipt'),
    adjust: t('fxStaleKinds.adjust'),
    expense: t('fxStaleKinds.expense'),
    cost_kassa: t('fxStaleKinds.cost_kassa'),
    cost_legacy: t('fxStaleKinds.cost_legacy'),
  };

  // The newest rate per currency, from the list already fetched (newest
  // first), as the form's «standing» figure (audit A1).
  const standing: Record<string, number> = {};
  for (const { rate } of rates) {
    if (standing[rate.currency] !== undefined) continue;
    const value = perUsd(Number(rate.rateToUsd));
    if (value !== null) standing[rate.currency] = value;
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <PageHeader icon="exchange" title={t('fxTitle')} />
      <FxForm
        currencies={currencyRows.map((c) => c.code)}
        today={tashkentDay()}
        standing={standing}
      />
      {stale.length > 0 && (
        <section className="card space-y-1" data-testid="fx-stale">
          <h2 className="section-title">{t('fxStaleTitle')}</h2>
          {stale.map((row) => (
            <StaleReview
              key={`${row.currency}-${row.month}`}
              currency={row.currency}
              month={row.month}
              line={t('fxStaleLine', { currency: row.currency, month: row.month, count: row.count, usd: money(row.usd) })}
            />
          ))}
        </section>
      )}
      {frozenByCurrency.size > 0 && (
        <section className="card space-y-1" data-testid="fx-stale-payments">
          <h2 className="section-title">{t('fxStalePaymentsTitle')}</h2>
          <p className="text-xs text-ink-500">{t('fxStalePaymentsHint')}</p>
          {[...frozenByCurrency.entries()].map(([currency, list]) => (
            <details key={currency} className="text-sm">
              <summary className="cursor-pointer">{t('fxStalePaymentsLine', { currency, count: list.length })}</summary>
              <ul className="mt-1 space-y-0.5 font-mono text-xs">
                {list.map((row) => (
                  <li key={row.id} className="[overflow-wrap:anywhere]">
                    {row.day} · {KIND[row.kind] ?? row.kind} · {row.amount.toLocaleString('en-US')} {currency} ·{' '}
                    {perUsd(row.storedRate)?.toLocaleString('en-US') ?? '—'} →{' '}
                    {row.dayRate === null ? '—' : (perUsd(row.dayRate)?.toLocaleString('en-US') ?? '—')}
                    {row.label ? ` · ${row.label}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </section>
      )}
      <div className="card space-y-1">
        {rates.map(({ rate, enteredBy }) => (
          <div key={rate.id} className="flex items-baseline gap-2 border-b border-line py-1.5 text-sm last:border-0">
            {/* Read the way it was entered: 1 USD = N units. */}
            <span className="font-semibold">1 USD =</span>
            <span className="font-mono font-bold tabular-nums">
              {perUsd(Number(rate.rateToUsd))?.toLocaleString('en-US') ?? '—'}
            </span>
            <span className="font-mono font-bold">{rate.currency}</span>
            <span className="text-ink-500">{rate.effectiveDate}</span>
            {enteredBy && <span className="ml-auto text-xs text-ink-500">{enteredBy}</span>}
          </div>
        ))}
        {rates.length === 0 && <p className="text-sm text-ink-500">{t('noRates')}</p>}
      </div>
    </div>
  );
}
