'use client';

import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { saveTruckAction, type TruckFormState } from './actions';

export interface TruckValues {
  id: string;
  name: string;
  maxKg: number;
  maxM3: number;
}

/** Inline create/edit form for a truck preset. */
export function TruckForm({ truck, onDone }: { truck?: TruckValues; onDone?: () => void }) {
  const t = useTranslations('plans');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<TruckFormState, FormData>(
    saveTruckAction,
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
      {truck && <input type="hidden" name="id" value={truck.id} />}
      <input
        name="name"
        className="input"
        defaultValue={truck?.name ?? ''}
        placeholder={t('truckName')}
        aria-label={t('truckName')}
        required
      />
      <div className="flex gap-2">
        <input
          name="maxKg"
          className="input flex-1"
          inputMode="decimal"
          defaultValue={truck?.maxKg ?? ''}
          placeholder="max kg"
          aria-label="max kg"
          required
        />
        <input
          name="maxM3"
          className="input flex-1"
          inputMode="decimal"
          defaultValue={truck?.maxM3 ?? ''}
          placeholder="max m³"
          aria-label="max m³"
          required
        />
      </div>
      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {tc('error')}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn-primary w-full disabled:opacity-60">
        {pending ? '…' : saved && state.ok ? `✅ ${tc('saved')}` : tc('save')}
      </button>
    </form>
  );
}
