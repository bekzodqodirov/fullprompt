import { asc, eq, inArray } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { costTypes, currencies, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { ReceiveWizard } from './receive-wizard';

export default async function ReceivePage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('receipts.create')) redirect('/');
  const t = await getTranslations('receive');

  const whs = await db
    .select({
      id: warehouses.id,
      code: warehouses.code,
      name: warehouses.name,
      country: warehouses.country,
    })
    .from(warehouses)
    .where(
      actor.warehouseScoped && actor.warehouseIds.length
        ? inArray(warehouses.id, actor.warehouseIds)
        : eq(warehouses.active, true),
    )
    .orderBy(asc(warehouses.code));

  const types = await db
    .select({ id: costTypes.id, code: costTypes.code, name: costTypes.name })
    .from(costTypes)
    .where(eq(costTypes.active, true));
  const currencyRows = await db
    .select({ code: currencies.code })
    .from(currencies)
    .where(eq(currencies.active, true));

  return (
    <div className="mx-auto max-w-lg md:max-w-none">
      <h1 className="mb-3 text-xl font-bold">{t('title')}</h1>
      <ReceiveWizard
        warehouses={whs}
        costTypes={types}
        currencies={currencyRows.map((c) => c.code)}
      />
    </div>
  );
}
