import { asc, eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { roles, userRoles, users, userWarehouses, warehouses } from '@/modules/platform/db/schema';
import { HistoryTab } from '@/components/history-tab';
import { toggleUserActiveAction, updateUserAction } from '../actions';
import { UserForm } from '../user-form';

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!user) notFound();

  const tc = await getTranslations('common');
  const whs = await db
    .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name })
    .from(warehouses)
    .orderBy(asc(warehouses.code));
  const roleCodes = (
    await db
      .select({ code: roles.code })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, id))
  ).map((r) => r.code);
  const whIds = (
    await db
      .select({ warehouseId: userWarehouses.warehouseId })
      .from(userWarehouses)
      .where(eq(userWarehouses.userId, id))
  ).map((w) => w.warehouseId);

  const update = updateUserAction.bind(null, id);
  const toggle = toggleUserActiveAction.bind(null, id);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{user.fullName}</h1>
        <form action={toggle}>
          <button type="submit" className={user.active ? 'btn-danger' : 'btn-primary'}>
            {user.active ? tc('deactivate') : tc('activate')}
          </button>
        </form>
      </div>

      <UserForm
        action={update}
        warehouses={whs}
        isNew={false}
        initial={{
          fullName: user.fullName,
          phone: user.phone,
          username: user.username ?? '',
          locale: user.locale,
          roleCodes,
          warehouseIds: whIds,
        }}
      />

      <section>
        <h2 className="mb-2 text-lg font-bold">{tc('history')}</h2>
        <HistoryTab entityType="user" entityId={user.id} />
      </section>
    </div>
  );
}
