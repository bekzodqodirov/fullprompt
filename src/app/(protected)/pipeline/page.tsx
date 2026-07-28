import { asc, eq, sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { boxes, clients, receiptLots, receipts } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader } from '@/components/ui/page';

/**
 * Sales-manager pipeline (spec §10 screen 12): own clients' cargo by stage —
 * in stock (CN) → in transit → ready for pickup → issued.
 */
export default async function PipelinePage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  // The menu showed this only to sales, but the URL was open to everyone —
  // client-by-client cargo and stages included. Gated on the permission the
  // dashboard already treats as the ticket here, so the grant stays editable
  // data rather than a hard-coded role.
  if (!actor.permissions.has('reports.own_clients')) redirect('/');
  const t = await getTranslations('pipeline');
  const tc = await getTranslations('common');
  const isManagerScoped = actor.roles.includes('sales_manager') && !actor.permissions.has('admin.users.manage');

  const rows = await db
    .select({
      clientId: clients.id,
      clientCode: clients.clientCode,
      clientName: clients.name,
      inStock: sql<number>`count(*) FILTER (WHERE ${boxes.status} IN ('in_stock', 'planned', 'loading'))`,
      inTransit: sql<number>`count(*) FILTER (WHERE ${boxes.status} = 'in_transit')`,
      ready: sql<number>`count(*) FILTER (WHERE ${boxes.status} = 'ready_for_pickup')`,
      issued: sql<number>`count(*) FILTER (WHERE ${boxes.status} = 'issued')`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .innerJoin(clients, eq(receipts.clientId, clients.id))
    .where(isManagerScoped ? eq(clients.salesManagerId, actor.id) : undefined)
    .groupBy(clients.id, clients.clientCode, clients.name)
    .orderBy(asc(clients.clientCode));

  return (
    <div className="space-y-3">
      <PageHeader icon="chart" title={t('title')} />
      <div className="overflow-x-auto rounded-xl border border-line bg-surface-raised">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-line-strong bg-surface-sunken text-left">
              <th className="p-2">{t('client')}</th>
              <th className="p-2 text-right">📦 {t('inStock')}</th>
              <th className="p-2 text-right">🚚 {t('inTransit')}</th>
              <th className="p-2 text-right">✅ {t('ready')}</th>
              <th className="p-2 text-right">🤝 {t('issued')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.clientId} className="border-b border-line hover:bg-surface-sunken">
                <td className="p-2">
                  <span className="font-mono font-extrabold text-brand-700">{row.clientCode}</span>{' '}
                  <span className="text-ink-700">{row.clientName}</span>
                </td>
                <td className="p-2 text-right font-semibold">{row.inStock}</td>
                <td className="p-2 text-right">{row.inTransit}</td>
                <td className="p-2 text-right font-semibold text-good">{row.ready}</td>
                <td className="p-2 text-right text-ink-500">{row.issued}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="p-4 text-sm text-ink-500">{tc('empty')}</p>}
      </div>
    </div>
  );
}
