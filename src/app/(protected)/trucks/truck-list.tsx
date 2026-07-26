'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { setTruckActiveAction } from './actions';
import { TruckForm, type TruckValues } from './truck-form';

/** Truck presets the owner manages himself (were seed-only before). */
export function TruckList({ trucks }: { trucks: (TruckValues & { active: boolean })[] }) {
  const t = useTranslations('plans');
  const tc = useTranslations('common');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-3">
      {trucks.map((truck) => (
        <div key={truck.id} className={`card space-y-2 !p-3 ${truck.active ? '' : 'opacity-60'}`}>
          <div className="flex items-baseline gap-2">
            <span className="font-bold">🚛 {truck.name}</span>
            <span className="font-mono text-sm text-ink-700">
              {truck.maxKg} kg · {truck.maxM3} m³
            </span>
            {!truck.active && (
              <span className="rounded bg-surface-sunken px-1.5 text-xs">{t('truckHidden')}</span>
            )}
            <span className="ml-auto flex gap-2">
              <button
                type="button"
                className="btn-secondary !min-h-9 px-2 text-sm"
                onClick={() => setEditingId(editingId === truck.id ? null : truck.id)}
              >
                ✏️ {tc('edit')}
              </button>
              <form action={setTruckActiveAction}>
                <input type="hidden" name="id" value={truck.id} />
                <input type="hidden" name="active" value={truck.active ? '0' : '1'} />
                <button type="submit" className="btn-secondary !min-h-9 px-2 text-sm">
                  {truck.active ? `🚫 ${t('truckHide')}` : `↩️ ${t('truckShow')}`}
                </button>
              </form>
            </span>
          </div>
          {editingId === truck.id && (
            <TruckForm truck={truck} onDone={() => setEditingId(null)} />
          )}
        </div>
      ))}

      {adding ? (
        <TruckForm onDone={() => setAdding(false)} />
      ) : (
        <button type="button" className="btn-primary w-full" onClick={() => setAdding(true)}>
          ＋ {t('addTruck')}
        </button>
      )}
    </div>
  );
}
