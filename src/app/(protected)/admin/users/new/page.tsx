import Link from 'next/link';
import { redirect } from 'next/navigation';
import { asc } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { db } from '@/modules/platform/db/client';
import { warehouses } from '@/modules/platform/db/schema';
import { activeNoLoginPeople } from '@/modules/platform/users/service';
import { maySeeStaffMoney } from '@/modules/wms/staff/door';
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
  // A person who is only PAID here is minted on /hodimlar, never here (0120);
  // and one of them who now needs a login is CONVERTED on their own card —
  // a second row would put the salary on one record and the work on another.
  const noLogin = await activeNoLoginPeople();
  const seesPay = maySeeStaffMoney(actor.permissions);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('new')}</h1>
      <p className="card !p-3 text-sm" data-testid="users-new-hodimlar-line">
        {t('newNoLoginLine')}{' '}
        {seesPay ? (
          <Link href="/hodimlar" className="font-semibold text-brand-700">
            {t('newNoLoginGo')}
          </Link>
        ) : null}
      </p>
      {noLogin.length > 0 ? (
        <details className="card !p-3 text-sm" data-testid="users-new-no-login">
          <summary className="cursor-pointer font-semibold">
            {t('newNoLoginList', { count: noLogin.length })}
          </summary>
          <p className="mt-1 text-2xs text-ink-500">{t('newNoLoginListHint')}</p>
          <ul className="mt-2 space-y-1">
            {noLogin.map((p) => (
              <li key={p.id}>
                <Link href={`/admin/users/${p.id}`} className="text-brand-700 [overflow-wrap:anywhere]">
                  {p.fullName}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <UserForm action={createUserAction} warehouses={whs} roles={roles} isNew />
    </div>
  );
}
