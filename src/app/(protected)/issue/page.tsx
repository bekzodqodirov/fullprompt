import { asc, eq, inArray, and } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { EmptyState } from '@/components/ui/page';
import { IssueScreen } from './issue-screen';

export default async function IssuePage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('scan.issue')) redirect('/');
  const t = await getTranslations('issue');

  // Only some warehouses hand cargo to a client (owner: TAS and AND). The
  // permission alone used to offer this screen at every warehouse, including
  // the Chinese ones where no client has ever collected anything.
  const whs = await db
    .select({ id: warehouses.id, code: warehouses.code })
    .from(warehouses)
    .where(
      and(
        eq(warehouses.issuesToClients, true),
        eq(warehouses.active, true),
        actor.warehouseScoped && actor.warehouseIds.length
          ? inArray(warehouses.id, actor.warehouseIds)
          : undefined,
      ),
    )
    .orderBy(asc(warehouses.code));

  return (
    <div className="mx-auto max-w-lg md:max-w-3xl">
      <h1 className="mb-3 text-xl font-bold">🤝 {t('title')}</h1>
      {whs.length === 0 ? (
        <EmptyState icon="handshake" title={t('noIssuingWarehouse')} />
      ) : (
        <IssueScreen warehouses={whs} />
      )}
    </div>
  );
}
