import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { listCategories } from '@/modules/wms/accounting/service';
import { CategoryForm } from './category-form';
import { PageHeader } from '@/components/ui/page';

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
      <PageHeader icon="clipboard" title={t('categories')} />
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
        {rows.length === 0 && <p className="text-sm text-ink-500">{tc('empty')}</p>}
      </div>
      <p className="text-xs text-ink-500">ℹ️ {t('cashNote')}</p>
    </div>
  );
}
