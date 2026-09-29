import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { db } from '@/modules/platform/db/client';
import { roles, userRoles, users, userWarehouses, warehouses } from '@/modules/platform/db/schema';
import { CustomFieldsPanel } from '@/components/custom-fields-panel';
import { HistoryTab } from '@/components/history-tab';
import { maySeeStaffMoney } from '@/modules/wms/staff/door';
import { toggleUserActiveAction, updateUserAction } from '../actions';
import { EnableLoginForm } from '../enable-login-form';
import { roleOptions } from '../role-options';
import { UserForm } from '../user-form';

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // Its own gate: the /admin section gate is cosmetic and admits anyone
  // holding clients.view_own or crm.leads — every sales manager.
  const actor = await getActor();
  if (!actor?.permissions.has('admin.users.manage')) redirect('/');
  const { id } = await params;
  const user = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!user) notFound();

  const t = await getTranslations('users');
  const tc = await getTranslations('common');
  const seesPay = maySeeStaffMoney(actor.permissions);
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

  const roleList = await roleOptions();
  const update = updateUserAction.bind(null, id);
  const toggle = toggleUserActiveAction.bind(null, id);

  const toggleForm = (
    <form action={toggle}>
      <button type="submit" className={user.active ? 'btn-danger' : 'btn-primary'}>
        {user.active ? tc('deactivate') : tc('activate')}
      </button>
    </form>
  );

  // A person who never signs in (0120, the owner's 2b): no login form to edit
  // — there is nothing to edit — but the ONE door that makes them a login.
  // Their name and payroll phone are /hodimlar's (the salary page).
  if (!user.loginEnabled) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <h1 className="min-w-0 [overflow-wrap:anywhere] text-xl font-bold">{user.fullName}</h1>
            <span className="chip chip-neutral" data-testid="user-no-login">
              {t('noLogin')}
            </span>
          </div>
          {toggleForm}
        </div>

        <section className="card space-y-2 !p-3" data-testid="enable-login">
          <h2 className="section-title">{t('enableLoginTitle')}</h2>
          <p className="text-sm text-ink-600">{t('enableLoginHint')}</p>
          {user.active ? (
            <EnableLoginForm
              id={user.id}
              payrollPhone={user.phone}
              locale={user.locale}
              roles={roleList}
              warehouses={whs}
            />
          ) : (
            <p className="text-sm text-warn" data-testid="enable-login-inactive">
              {t('enableLoginInactive')}
            </p>
          )}
        </section>

        {seesPay ? (
          <Link
            href={`/hodimlar?hodim=${user.id}`}
            className="inline-block text-sm font-semibold text-brand-700"
            data-testid="user-hodimlar-link"
          >
            {t('salaryOnHodimlar')}
          </Link>
        ) : null}

        <CustomFieldsPanel
          entityType="user"
          entityId={user.id}
          revalidate={`/admin/users/${user.id}`}
        />

        <section>
          <h2 className="mb-2 text-lg font-bold">{tc('history')}</h2>
          <HistoryTab entityType="user" entityId={user.id} />
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="min-w-0 [overflow-wrap:anywhere] text-xl font-bold">{user.fullName}</h1>
        {toggleForm}
      </div>

      <UserForm
        action={update}
        warehouses={whs}
        roles={roleList}
        isNew={false}
        initial={{
          fullName: user.fullName,
          phone: user.phone ?? '',
          username: user.username ?? '',
          locale: user.locale,
          roleCodes,
          warehouseIds: whIds,
        }}
      />

      <CustomFieldsPanel
        entityType="user"
        entityId={user.id}
        revalidate={`/admin/users/${user.id}`}
      />

      <section>
        <h2 className="mb-2 text-lg font-bold">{tc('history')}</h2>
        <HistoryTab entityType="user" entityId={user.id} />
      </section>
    </div>
  );
}
