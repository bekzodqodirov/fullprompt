'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { saveCategoryAction, type AccountingFormState } from '../actions';

export interface CategoryRow {
  id: string;
  name: string;
  cash: boolean;
  sortOrder: number;
  active: boolean;
}

/**
 * Expense kinds, maintained by hand (owner's answer 2: "hard coded emas").
 *
 * The one flag that is not cosmetic is `cash`: an expense that never moves
 * money — depreciation — belongs in the P&L but must stay out of the cash-flow
 * report, and no code change should be needed to add such a kind.
 */
export function CategoryForm({ category }: { category?: CategoryRow }) {
  const t = useTranslations('accounting');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<AccountingFormState, FormData>(
    saveCategoryAction,
    {},
  );

  return (
    <form
      action={formAction}
      className={category ? 'space-y-2 border-t border-line pt-2' : 'card space-y-2'}
    >
      {!category && <h2 className="text-sm font-bold uppercase text-ink-500">🗂 {t('categories')}</h2>}
      {category && <input type="hidden" name="id" value={category.id} />}
      <div className="flex flex-wrap items-end gap-2">
        <input
          name="name"
          defaultValue={category?.name}
          placeholder={t('categoryName')}
          aria-label={t('categoryName')}
          className="input min-w-44 flex-1"
          data-testid="category-name"
          required
        />
        <label className="text-sm">
          <span className="block text-xs text-ink-500">#</span>
          <input
            name="sortOrder"
            type="number"
            defaultValue={category?.sortOrder ?? 100}
            aria-label="#"
            className="input !w-20"
          />
        </label>
        <label className="flex items-center gap-1 pb-2 text-sm">
          {/* Paired with the checkbox: a browser sends nothing when unchecked. */}
          <input type="hidden" name="cash" value="off" />
          <input
            type="checkbox"
            name="cash"
            value="on"
            defaultChecked={category ? category.cash : true}
            className="h-4 w-4"
          />
          {t('cash')}
        </label>
        <label className="flex items-center gap-1 pb-2 text-sm">
          <input type="hidden" name="active" value="off" />
          <input
            type="checkbox"
            name="active"
            value="on"
            defaultChecked={category ? category.active : true}
            className="h-4 w-4"
          />
          {tc('active')}
        </label>
      </div>
      <button
        type="submit"
        data-testid={category ? 'update-category' : 'save-category'}
        className={category ? 'btn-secondary w-full' : 'btn-primary w-full'}
        disabled={pending}
      >
        {pending ? tc('loading') : tc('save')}
      </button>
      {state.ok && <p className="text-sm font-semibold text-good">✅ {tc('saved')}</p>}
      {state.error && <p className="text-sm font-semibold text-bad">{tc('error')}</p>}
    </form>
  );
}
