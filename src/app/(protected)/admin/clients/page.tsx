import Link from 'next/link';
import { asc, eq, sql, type SQL } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { clients, users } from '@/modules/platform/db/schema';
import { redirect } from 'next/navigation';
import { getActor } from '@/modules/platform/rbac/authorize';

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  // Own gate, not just the layout's: the section is now reachable by roles
  // that only hold FX or audit rights.
  const actor = await getActor();
  if (!actor?.permissions.has('admin.warehouses.manage')) redirect('/');
  const t = await getTranslations('clients');
  const tc = await getTranslations('common');
  const { q } = await searchParams;

  let where: SQL | undefined;
  if (q) {
    // Trigram-accelerated fuzzy match on code and name (spec §12 groundwork).
    where = sql`(${clients.clientCode} ILIKE ${'%' + q + '%'} OR ${clients.name} ILIKE ${'%' + q + '%'})`;
  }

  const rows = await db
    .select({ client: clients, managerName: users.fullName })
    .from(clients)
    .leftJoin(users, eq(clients.salesManagerId, users.id))
    .where(where)
    .orderBy(asc(clients.clientCode))
    .limit(200);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold">{t('title')}</h1>
        <Link href="/admin/clients/new" className="btn-primary">
          {t('new')}
        </Link>
      </div>
      <form method="get">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder={tc('search')}
          className="input max-w-md"
        />
      </form>
      <div className="grid gap-3 md:grid-cols-2">
        {rows.map(({ client, managerName }) => (
          <Link
            key={client.id}
            href={`/admin/clients/${client.id}`}
            className={`card block hover:bg-surface-sunken ${client.active ? '' : 'opacity-50'}`}
          >
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-lg font-extrabold text-brand-700">
                {client.clientCode}
              </span>
              <span className="font-semibold">{client.name}</span>
            </div>
            <div className="mt-1 text-sm text-ink-700">
              {t('salesManager')}: {managerName ?? t('noManager')}
            </div>
          </Link>
        ))}
      </div>
      {rows.length === 0 && <p className="text-sm text-ink-500">{tc('empty')}</p>}
    </div>
  );
}
