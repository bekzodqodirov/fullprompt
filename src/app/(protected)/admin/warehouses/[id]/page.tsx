import { eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { db } from '@/modules/platform/db/client';
import { warehouses } from '@/modules/platform/db/schema';
import { HistoryTab } from '@/components/history-tab';
import { toggleWarehouseActiveAction, updateWarehouseAction } from '../actions';
import { WarehouseForm } from '../warehouse-form';
import { CustomFieldsPanel } from '@/components/custom-fields-panel';

export default async function WarehouseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Its own gate: the /admin section gate is cosmetic and admits anyone
  // holding clients.view_own or crm.leads — every sales manager.
  const actor = await getActor();
  if (!actor?.permissions.has('admin.warehouses.manage')) redirect('/');
  const { id } = await params;
  const wh = await db.query.warehouses.findFirst({ where: eq(warehouses.id, id) });
  if (!wh) notFound();

  const t = await getTranslations('warehouses');
  const tc = await getTranslations('common');
  const update = updateWarehouseAction.bind(null, id);
  const toggle = toggleWarehouseActiveAction.bind(null, id);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">
          <span className="font-mono text-brand-700">{wh.code}</span> — {wh.name}
        </h1>
        <form action={toggle}>
          <button type="submit" className={wh.active ? 'btn-danger' : 'btn-primary'}>
            {wh.active ? tc('deactivate') : tc('activate')}
          </button>
        </form>
      </div>

      <p className="text-sm text-ink-700">
        {t('letterState')}: {wh.letterPosition} / cycle {wh.letterCycleNo}
      </p>

      <WarehouseForm
        action={update}
        initial={{
          code: wh.code,
          name: wh.name,
          country: wh.country,
          type: wh.type,
          timezone: wh.timezone,
          batchPrefix: wh.batchPrefix,
          address: wh.address ?? '',
          capacityM3: wh.capacityM3 ? String(Number(wh.capacityM3)) : '',
          lat: wh.lat ? String(Number(wh.lat)) : '',
          lon: wh.lon ? String(Number(wh.lon)) : '',
          issuesToClients: wh.issuesToClients,
          allowsQuickBatch: wh.allowsQuickBatch,
        }}
      />

      <CustomFieldsPanel
        entityType="warehouse"
        entityId={wh.id}
        revalidate={`/admin/warehouses/${wh.id}`}
      />

      <section>
        <h2 className="mb-2 text-lg font-bold">{tc('history')}</h2>
        <HistoryTab entityType="warehouse" entityId={wh.id} />
      </section>
    </div>
  );
}
