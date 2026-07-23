import Link from 'next/link';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { boxes, clients, crates, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';

/** W2 — crate list (spec 6.2). */
export default async function CratesPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crates.manage')) redirect('/');
  const t = await getTranslations('crates');
  const tc = await getTranslations('common');
  const format = await getFormatter();

  const rows = await db
    .select({
      crate: crates,
      clientCode: clients.clientCode,
      whCode: warehouses.code,
      boxCount: sql<number>`(SELECT count(*) FROM ${boxes} b WHERE b.crate_id = ${crates.id})`,
    })
    .from(crates)
    .innerJoin(clients, eq(crates.clientId, clients.id))
    .innerJoin(warehouses, eq(crates.warehouseId, warehouses.id))
    .where(
      and(
        eq(crates.status, 'active'),
        actor.warehouseScoped && actor.warehouseIds.length
          ? inArray(crates.warehouseId, actor.warehouseIds)
          : undefined,
      ),
    )
    .orderBy(desc(crates.createdAt))
    .limit(200);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">🧰 {t('title')}</h1>
        <Link href="/crates/new" className="btn-primary px-4">
          ＋ {t('create')}
        </Link>
      </div>
      {rows.length === 0 && <p className="text-gray-500">{tc('empty')}</p>}
      <div className="space-y-2">
        {rows.map(({ crate, clientCode, whCode, boxCount }) => (
          <Link
            key={crate.id}
            href={`/crates/${crate.id}`}
            className="card block !p-3 hover:bg-gray-50"
          >
            <div className="flex items-baseline gap-2">
              <span className="font-mono font-extrabold text-blue-800">{crate.code}</span>
              <span className="font-mono font-bold">{clientCode}</span>
              <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-semibold">
                {crate.kind === 'karkas' ? t('karkas') : t('yashik')}
              </span>
              <span className="ml-auto text-sm font-semibold">{boxCount} 📦</span>
            </div>
            <p className="text-xs text-gray-500">
              {whCode} · {format.dateTime(crate.createdAt, { dateStyle: 'short' })}
              {crate.note && ` · ${crate.note}`}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
