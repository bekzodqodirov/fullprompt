import { asc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { truckPresets } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { TruckList } from './truck-list';

/** Truck preset management (owner's request — no more hard-coded trucks). */
export default async function TrucksPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('plans.manage')) redirect('/');
  const t = await getTranslations('plans');

  const trucks = await db.select().from(truckPresets).orderBy(asc(truckPresets.name));

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="mb-3 text-xl font-bold">🚛 {t('trucksTitle')}</h1>
      <TruckList
        trucks={trucks.map((p) => ({
          id: p.id,
          name: p.name,
          maxKg: Number(p.maxKg),
          maxM3: Number(p.maxM3),
          active: p.active,
        }))}
      />
    </div>
  );
}
