import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { listCategories } from '@/modules/wms/accounting/service';
import { CategoryForm } from './category-form';

/** Expense kinds, maintained by the owner rather than baked into the code. */
export default async function CategoriesPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.expenses')) redirect('/accounting');
  const t = await getTranslations('accounting');
  const tc = await getTranslations('common');
  const rows = await listCategories(true);

  return (
    <div className="mx-auto max-w-lg space-y-3">
      <h1 className="text-xl font-bold">🗂 {t('categories')}</h1>
      <CategoryForm />
      <div className="card space-y-2">
        {rows.map((row) => (
          <CategoryForm
            key={row.id}
            category={{
              id: row.id,
              name: row.name,
              cash: row.cash,
              sortOrder: row.sortOrder,
              active: row.active,
            }}
          />
        ))}
        {rows.length === 0 && <p className="text-sm text-gray-500">{tc('empty')}</p>}
      </div>
      <p className="text-xs text-gray-500">ℹ️ {t('cashNote')}</p>
    </div>
  );
}
