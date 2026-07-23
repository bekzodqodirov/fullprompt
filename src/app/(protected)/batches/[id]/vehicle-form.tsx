'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { saveVehicleAction, type VehicleFormState } from '../../plans/actions';

/**
 * Vehicle/driver info for a batch. A plain server-action form gave no sign
 * the save happened (owner's bug report) — this wraps it in useActionState
 * so the button shows progress and a ✅ appears on success.
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
  const [state, formAction, pending] = useActionState<VehicleFormState, FormData>(
    saveVehicleAction,
    {},
  );

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
        <p role="alert" className="text-sm font-semibold text-red-700">
          {tc('error')}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn-secondary w-full disabled:opacity-60">
        {pending ? '…' : state.ok ? `✅ ${tc('saved')}` : tc('save')}
      </button>
    </form>
  );
}
