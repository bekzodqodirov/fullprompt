import { asc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { costTypes } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { CostTypeList } from './type-list';

/**
 * Expense types (owner, 2026-07-28: "har bir furadagi rasxodlar … shuni men
 * yana o'zim qo'sha olamanmi"). They were data all along — this is the door
 * that was missing.
 */
export default async function CostTypesPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('admin.dictionaries.manage')) redirect('/');
  const t = await getTranslations('costing');

  const types = await db.select().from(costTypes).orderBy(asc(costTypes.createdAt));

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="mb-3 text-xl font-bold">💰 {t('typesTitle')}</h1>
      <CostTypeList
        types={types.map((row) => ({ id: row.id, name: row.name, active: row.active }))}
      />
    </div>
  );
}
