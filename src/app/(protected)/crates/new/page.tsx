import { asc, eq, inArray } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { currencies, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { CrateBuilder } from './crate-builder';

export default async function NewCratePage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crates.manage')) redirect('/');
  const t = await getTranslations('crates');

  const whs = await db
    .select({ id: warehouses.id, code: warehouses.code, country: warehouses.country })
    .from(warehouses)
    .where(
      actor.warehouseScoped && actor.warehouseIds.length
        ? inArray(warehouses.id, actor.warehouseIds)
        : undefined,
    )
    .orderBy(asc(warehouses.code));
  const currencyRows = await db
    .select({ code: currencies.code })
    .from(currencies)
    .where(eq(currencies.active, true));

  return (
    <div className="mx-auto max-w-lg md:max-w-3xl">
      <h1 className="mb-3 text-xl font-bold">🧰 {t('createTitle')}</h1>
      <CrateBuilder warehouses={whs} currencies={currencyRows.map((c) => c.code)} />
    </div>
  );
}
