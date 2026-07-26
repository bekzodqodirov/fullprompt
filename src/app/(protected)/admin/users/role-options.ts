import { getTranslations } from 'next-intl/server';
import { ROLE_CODES } from '@/modules/platform/rbac/catalog';
import { assignableRoles } from '@/modules/platform/rbac/roles';

export interface RoleOption {
  code: string;
  label: string;
}

/**
 * The roles the user form may offer.
 *
 * Read from the database rather than from `ROLE_CODES`, because otherwise a
 * role the owner invents on /admin/roles can never be given to anybody — the
 * role constructor would build roles nobody can hold.
 *
 * Only the nine shipped codes have a translation, and next-intl throws at
 * RENDER time on a missing key, so a custom role is labelled with the name the
 * owner typed.
 */
export async function roleOptions(): Promise<RoleOption[]> {
  const t = await getTranslations('users');
  const rows = await assignableRoles();
  return rows.map((row) => ({
    code: row.code,
    label: (ROLE_CODES as readonly string[]).includes(row.code)
      ? t(`roleNames.${row.code}` as 'roleNames.super_admin')
      : row.name,
  }));
}
