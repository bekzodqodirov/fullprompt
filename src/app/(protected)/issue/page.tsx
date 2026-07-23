import { asc, inArray } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { IssueScreen } from './issue-screen';

export default async function IssuePage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('scan.issue')) redirect('/');
  const t = await getTranslations('issue');

  const whs = await db
    .select({ id: warehouses.id, code: warehouses.code })
    .from(warehouses)
    .where(
      actor.warehouseScoped && actor.warehouseIds.length
        ? inArray(warehouses.id, actor.warehouseIds)
        : undefined,
    )
    .orderBy(asc(warehouses.code));

  return (
    <div className="mx-auto max-w-lg md:max-w-3xl">
      <h1 className="mb-3 text-xl font-bold">🤝 {t('title')}</h1>
      <IssueScreen warehouses={whs} />
    </div>
  );
}
