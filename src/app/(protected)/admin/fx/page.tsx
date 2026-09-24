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
