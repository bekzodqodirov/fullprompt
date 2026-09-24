import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader } from '@/components/ui/page';
import { listFactories, PICKUP_WRITE } from '@/modules/wms/pickups/service';
import { CreatePickupForm } from '../pickup-forms';

export default async function NewPickupPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has(PICKUP_WRITE)) redirect('/zavod');
  const t = await getTranslations('pickups');
  const whs = await db
    .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name })
    .from(warehouses)
    .where(eq(warehouses.active, true))
    .orderBy(asc(warehouses.code));
  const factories = await listFactories();
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <PageHeader icon="truck" title={t('new')} back={{ href: '/zavod', label: t('title') }} />
      {factories.length === 0 ? (
        <p className="card text-sm">
          {t('noFactories')}{' '}
          <Link href="/zavod/zavodlar" className="text-brand-700 underline">
            {t('factories')} →
          </Link>
        </p>
      ) : (
        <CreatePickupForm
          warehouses={whs.map((w) => ({ id: w.id, label: `${w.code} — ${w.name}` }))}
          factories={factories.map((f) => ({ id: f.id, label: f.name }))}
        />
      )}
      <p className="text-xs text-ink-500">{t('ownerHint')}</p>
    </div>
  );
}
