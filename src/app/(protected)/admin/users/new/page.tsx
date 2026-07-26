import { redirect } from 'next/navigation';
import { asc } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { db } from '@/modules/platform/db/client';
import { warehouses } from '@/modules/platform/db/schema';
import { createUserAction } from '../actions';
import { roleOptions } from '../role-options';
import { UserForm } from '../user-form';

export default async function NewUserPage() {
  // Its own gate: the /admin section gate is cosmetic and admits anyone
  // holding clients.view_own or crm.leads — every sales manager.
  const actor = await getActor();
  if (!actor?.permissions.has('admin.users.manage')) redirect('/');
  const t = await getTranslations('users');
  const whs = await db
    .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name })
    .from(warehouses)
    .orderBy(asc(warehouses.code));
  const roles = await roleOptions();

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('new')}</h1>
      <UserForm action={createUserAction} warehouses={whs} roles={roles} isNew />
    </div>
  );
}
