import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { grantableBy, groupPermissions, listRoles } from '@/modules/platform/rbac/roles';
import { PERMISSION_CODES } from '@/modules/platform/rbac/catalog';
import { Panel } from '@/components/panel';
import { PageHeader } from '@/components/ui/page';
import { NewRoleForm } from './new-role-form';
import { RoleCard } from './role-card';

/**
 * Who can do what — as data (owner: "rol konstruktori").
 *
 * Until now the answer lived in `ROLE_MATRIX` in TypeScript and reached the
 * database once, through the seed, insert-only. Adding a permission to a role
 * meant a deploy; removing one was impossible.
 */
export default async function RolesPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('platform.roles.manage')) redirect('/');

  const t = await getTranslations('roles');
  const roles = await listRoles();
  const groups = groupPermissions(PERMISSION_CODES);
  const grantable = grantableBy(actor.permissions);

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <PageHeader icon="settings" title={t('title')} />
      <p className="text-sm text-ink-500">{t('intro')}</p>

      <Panel title={`➕ ${t('newRole')}`} testId="new-role-panel">
        <NewRoleForm />
      </Panel>

      <div className="space-y-2">
        {roles.map((role) => (
          <RoleCard
            key={role.id}
            {...role}
            groups={groups}
            grantable={grantable}
            // Editing the powers of a role you hold is how someone locks
            // themselves out, and how someone quietly promotes themselves.
            // The service refuses it too; this only says so earlier.
            isOwnRole={(actor.roles as string[]).includes(role.code)}
          />
        ))}
      </div>
    </div>
  );
}
