import { getTranslations } from 'next-intl/server';
import { createWarehouseAction } from '../actions';
import { WarehouseForm } from '../warehouse-form';

export default async function NewWarehousePage() {
  const t = await getTranslations('warehouses');
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('new')}</h1>
      <WarehouseForm action={createWarehouseAction} />
    </div>
  );
}
