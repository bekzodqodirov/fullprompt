import { desc, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { currencies, fxRates, users } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { FxForm } from './fx-form';

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

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-xl font-bold">💱 {t('fxTitle')}</h1>
      <FxForm
        currencies={currencyRows.map((c) => c.code)}
        today={new Date().toISOString().slice(0, 10)}
      />
      <div className="card space-y-1">
        {rates.map(({ rate, enteredBy }) => (
          <div key={rate.id} className="flex items-baseline gap-2 border-b border-gray-100 py-1.5 text-sm last:border-0">
            <span className="font-mono font-bold">{rate.currency}</span>
            <span className="font-semibold">{Number(rate.rateToUsd)}</span>
            <span className="text-gray-500">{rate.effectiveDate}</span>
            {enteredBy && <span className="ml-auto text-xs text-gray-500">{enteredBy}</span>}
          </div>
        ))}
        {rates.length === 0 && <p className="text-sm text-gray-500">{t('noRates')}</p>}
      </div>
    </div>
  );
}
