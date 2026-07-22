import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { roles, userRoles, users } from '@/modules/platform/db/schema';

export default async function UsersPage() {
  const t = await getTranslations('users');
  const tc = await getTranslations('common');

  const rows = await db.select().from(users).orderBy(asc(users.fullName));
  const roleRows = await db
    .select({ userId: userRoles.userId, code: roles.code })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id));
  const rolesByUser = new Map<string, string[]>();
  for (const { userId, code } of roleRows) {
    rolesByUser.set(userId, [...(rolesByUser.get(userId) ?? []), code]);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{t('title')}</h1>
        <Link href="/admin/users/new" className="btn-primary">
          {t('new')}
        </Link>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((user) => (
          <Link
            key={user.id}
            href={`/admin/users/${user.id}`}
            className={`card block hover:bg-gray-50 ${user.active ? '' : 'opacity-50'}`}
          >
            <div className="flex items-baseline gap-2">
              <span className="font-semibold">{user.fullName}</span>
              <span className="ml-auto text-xs text-gray-500">
                {user.active ? tc('active') : tc('inactive')}
              </span>
            </div>
            <div className="mt-1 text-sm text-gray-600">
              {user.phone} ·{' '}
              {(rolesByUser.get(user.id) ?? [])
                .map((code) => t(`roleNames.${code}`))
                .join(', ') || '—'}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
