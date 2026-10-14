import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { createWarehouseAction } from '../actions';
import { WarehouseForm } from '../warehouse-form';
import { freightTablesReady } from '@/modules/wms/costing/freight-ready';
import { mappableZones } from '@/modules/wms/costing/tariff-column';

export default async function NewWarehousePage() {
  // Its own gate: the /admin section gate is cosmetic and admits anyone
  // holding clients.view_own or crm.leads — every sales manager.
  const actor = await getActor();
  if (!actor?.permissions.has('admin.warehouses.manage')) redirect('/');
  const t = await getTranslations('warehouses');
  const zones = (await freightTablesReady()) ? await mappableZones(null) : null;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('new')}</h1>
      <WarehouseForm action={createWarehouseAction} zones={zones} />
    </div>
  );
}
