import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { asc } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { warehouses } from '@/modules/platform/db/schema';
import { redirect } from 'next/navigation';
import { getActor } from '@/modules/platform/rbac/authorize';

export default async function WarehousesPage() {
  // Own gate, not just the layout's: the section is now reachable by roles
  // that only hold FX or audit rights.
  const actor = await getActor();
  if (!actor?.permissions.has('admin.warehouses.manage')) redirect('/');
  const t = await getTranslations('warehouses');
  const tc = await getTranslations('common');
  const rows = await db.select().from(warehouses).orderBy(asc(warehouses.code));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{t('title')}</h1>
        <Link href="/admin/warehouses/new" className="btn-primary">
          {t('new')}
        </Link>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((wh) => (
          <Link
            key={wh.id}
            href={`/admin/warehouses/${wh.id}`}
            className={`card block hover:bg-surface-sunken ${wh.active ? '' : 'opacity-50'}`}
          >
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-lg font-extrabold text-brand-700">{wh.code}</span>
              <span className="font-semibold">{wh.name}</span>
              <span className="ml-auto text-xs text-ink-500">
                {wh.active ? tc('active') : tc('inactive')}
              </span>
            </div>
            <div className="mt-1 text-sm text-ink-700">
              {wh.country} · {t(`types.${wh.type}`)} · {wh.timezone}
            </div>
          </Link>
        ))}
      </div>
      {rows.length === 0 && <p className="text-sm text-ink-500">{tc('empty')}</p>}
    </div>
  );
}
