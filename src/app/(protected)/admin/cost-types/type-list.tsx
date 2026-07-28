'use client';

import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  saveCostTypeAction,
  setCostTypeActiveAction,
  type CostTypeFormState,
} from './actions';

export interface CostTypeRow {
  id: string;
  name: string;
  active: boolean;
}

/** Expense types the owner manages himself (were seed-only before). */
export function CostTypeList({ types }: { types: CostTypeRow[] }) {
  const t = useTranslations('costing');
  const tc = useTranslations('common');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-3">
      {types.map((type) => (
        <div key={type.id} className={`card space-y-2 !p-3 ${type.active ? '' : 'opacity-60'}`}>
          <div className="flex items-baseline gap-2">
            <span className="font-bold">💰 {type.name}</span>
            {!type.active && (
              <span className="rounded bg-surface-sunken px-1.5 text-xs">{t('typeHidden')}</span>
            )}
            <span className="ml-auto flex gap-2">
              <button
                type="button"
                className="btn-secondary !min-h-9 px-2 text-sm"
                onClick={() => setEditingId(editingId === type.id ? null : type.id)}
              >
                ✏️ {tc('edit')}
              </button>
              <form action={setCostTypeActiveAction}>
                <input type="hidden" name="id" value={type.id} />
                <input type="hidden" name="active" value={type.active ? '0' : '1'} />
                <button type="submit" className="btn-secondary !min-h-9 px-2 text-sm">
                  {type.active ? `🚫 ${t('typeHide')}` : `↩️ ${t('typeShow')}`}
                </button>
              </form>
            </span>
          </div>
          {editingId === type.id && (
            <CostTypeForm type={type} onDone={() => setEditingId(null)} />
          )}
        </div>
      ))}

      {adding ? (
        <CostTypeForm onDone={() => setAdding(false)} />
      ) : (
        <button
          type="button"
          data-testid="add-cost-type"
          className="btn-primary w-full"
          onClick={() => setAdding(true)}
        >
          ＋ {t('addType')}
        </button>
      )}
    </div>
  );
}

function CostTypeForm({ type, onDone }: { type?: CostTypeRow; onDone?: () => void }) {
  const t = useTranslations('costing');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<CostTypeFormState, FormData>(
    saveCostTypeAction,
    {},
  );
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (state.ok) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSaved(true);
      onDone?.();
    }
  }, [state, onDone]);

  return (
    <form action={formAction} className="space-y-2 rounded-lg bg-surface-sunken p-3">
      {type && <input type="hidden" name="id" value={type.id} />}
      <input
        name="name"
        className="input"
        defaultValue={type?.name ?? ''}
        placeholder={t('typeName')}
        aria-label={t('typeName')}
        required
      />
      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {tc('error')}
        </p>
      )}
      <button
        type="submit"
        data-testid="save-cost-type"
        disabled={pending}
        className="btn-primary w-full disabled:opacity-60"
      >
        {pending ? '…' : saved && state.ok ? `✅ ${tc('saved')}` : tc('save')}
      </button>
    </form>
  );
}
