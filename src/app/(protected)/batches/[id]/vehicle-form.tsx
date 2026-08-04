'use client';

import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { saveVehicleAction, type VehicleFormState } from '../../plans/actions';

/**
 * Vehicle/driver info for a batch. Once filled it collapses to a one-line
 * summary with an ✏️ (owner's request — the big form was eating the screen);
 * saving shows an explicit ✅ and collapses again.
 */
export function VehicleForm({
  batchId,
  vehiclePlate,
  driverName,
  driverPhone,
}: {
  batchId: string;
  vehiclePlate: string;
  driverName: string;
  driverPhone: string;
}) {
  const t = useTranslations('batches');
  const tc = useTranslations('common');
  const hasInfo = Boolean(vehiclePlate || driverName || driverPhone);
  const [open, setOpen] = useState(!hasInfo);
  const [state, formAction, pending] = useActionState<VehicleFormState, FormData>(
    saveVehicleAction,
    {},
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (state.ok) setOpen(false);
  }, [state]);

  if (!open) {
    return (
      <div className="card flex items-center gap-2 !p-2.5 text-sm">
        <span>🚛</span>
        <span className="min-w-0 flex-1 truncate">
          <span className="font-mono font-bold">{vehiclePlate || '—'}</span>
          {driverName && ` · ${driverName}`}
          {driverPhone && ` · ${driverPhone}`}
        </span>
        {state.ok && <span className="text-xs font-semibold text-good">✅ {tc('saved')}</span>}
        <button
          type="button"
          aria-label={tc('edit')}
          className="btn-secondary !min-h-9 shrink-0 px-2 text-sm"
          onClick={() => setOpen(true)}
        >
          ✏️
        </button>
      </div>
    );
  }

  return (
    <form action={formAction} className="card space-y-2">
      <h2 className="text-lg font-bold">🚛 {t('vehicle')}</h2>
      <input type="hidden" name="batchId" value={batchId} />
      <input name="vehiclePlate" className="input font-mono" placeholder={t('plate')} defaultValue={vehiclePlate} />
      <div className="flex gap-2">
        <input name="driverName" className="input flex-1" placeholder={t('driver')} defaultValue={driverName} />
        <input name="driverPhone" className="input flex-1" inputMode="tel" placeholder={t('driverPhone')} defaultValue={driverPhone} />
      </div>
      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {tc('error')}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className="btn-primary flex-1 disabled:opacity-60">
          {pending ? '…' : tc('save')}
        </button>
        {hasInfo && (
          <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
            {tc('cancel')}
          </button>
        )}
      </div>
    </form>
  );
}
