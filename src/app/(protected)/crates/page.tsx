import Link from 'next/link';
import { and, desc, eq, sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { boxes, clients, crates, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader } from '@/components/ui/page';
import { warehouseScope } from '@/modules/platform/rbac/scope';

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
        warehouseScope(actor, crates.warehouseId),
      ),
    )
    .orderBy(desc(crates.createdAt))
    .limit(200);

  return (
    <div className="space-y-4">
      <PageHeader icon="crate" title={t('title')}
        actions={
          <Link href="/crates/new" className="btn-primary px-4">
          ＋ {t('create')}
        </Link>
        }
      />
      {rows.length === 0 && <p className="text-ink-500">{tc('empty')}</p>}
      <div className="space-y-2">
        {rows.map(({ crate, clientCode, whCode, boxCount }) => (
          <Link
            key={crate.id}
            href={`/crates/${crate.id}`}
            className="card block !p-3 hover:bg-surface-sunken"
          >
            <div className="flex items-baseline gap-2">
              <span className="font-mono font-extrabold text-brand-700">{crate.code}</span>
              <span className="font-mono font-bold">{clientCode}</span>
              <span className="rounded bg-surface-sunken px-2 py-0.5 text-xs font-semibold">
                {crate.kind === 'karkas' ? t('karkas') : t('yashik')}
              </span>
              <span className="ml-auto text-sm font-semibold">{boxCount} 📦</span>
            </div>
            <p className="text-xs text-ink-500">
              {whCode} · {format.dateTime(crate.createdAt, { dateStyle: 'short' })}
              {crate.note && ` · ${crate.note}`}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
