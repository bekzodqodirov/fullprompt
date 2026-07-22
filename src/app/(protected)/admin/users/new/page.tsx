import { asc } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { warehouses } from '@/modules/platform/db/schema';
import { createUserAction } from '../actions';
import { UserForm } from '../user-form';

export default async function NewUserPage() {
  const t = await getTranslations('users');
  const whs = await db
    .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name })
    .from(warehouses)
    .orderBy(asc(warehouses.code));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('new')}</h1>
      <UserForm action={createUserAction} warehouses={whs} isNew />
    </div>
  );
}
