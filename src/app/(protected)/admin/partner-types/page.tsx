import { asc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { partnerTypes } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PartnerTypeList } from './type-list';

/** Counterparty types — his list, not ours (owner: «hardcoded bolmasligi kerak»). */
export default async function PartnerTypesPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('admin.dictionaries.manage')) redirect('/');
  const t = await getTranslations('partners');

  const types = await db
    .select()
    .from(partnerTypes)
    .orderBy(asc(partnerTypes.sortOrder), asc(partnerTypes.createdAt));

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="mb-3 text-xl font-bold">🤝 {t('typesTitle')}</h1>
      <PartnerTypeList
        types={types.map((row) => ({ id: row.id, name: row.name, active: row.active }))}
      />
    </div>
  );
}
