'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { editLotAction, type EditLotState } from './edit-actions';

export interface LotEditValues {
  lotId: string;
  dimsMode: string;
  productNameZh: string;
  productNameRu: string;
  boxCount: number;
  boxLengthCm: number | null;
  boxWidthCm: number | null;
  boxHeightCm: number | null;
  boxWeightKg: string | null;
  totalWeightKg: string;
  totalVolumeM3: string;
  note: string | null;
}

/** Inline lot editor on the receipt detail (spec 4.4 — audited edits). */
export function LotEditForm({ lot }: { lot: LotEditValues }) {
  const t = useTranslations('receipts');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<EditLotState, FormData>(editLotAction, {});

  if (!open) {
    return (
      <div>
        <button type="button" className="btn-secondary !min-h-9 px-2 text-sm" onClick={() => setOpen(true)}>
          ✏️ {tc('edit')}
        </button>
        {state.ok && state.reconciliation && (
          <span className="ml-2 text-xs font-semibold text-green-700">
            {tc('saved')}
            {state.reconciliation.labelsToPrint > 0 &&
              ` · 🖨 ${t('labelsToPrint', { n: state.reconciliation.labelsToPrint })}`}
            {state.reconciliation.labelsToDestroy.length > 0 &&
              ` · 🗑 ${t('labelsToDestroy', {
                codes: state.reconciliation.labelsToDestroy.join(', '),
              })}`}
          </span>
        )}
      </div>
    );
  }

  return (
    <form action={formAction} className="mt-2 space-y-2 rounded-lg bg-gray-50 p-3">
      <input type="hidden" name="lotId" value={lot.lotId} />
      <input
        name="productNameZh"
        className="input"
        defaultValue={lot.productNameZh}
        aria-label="zh"
        required
      />
      <input
        name="productNameRu"
        className="input"
        defaultValue={lot.productNameRu}
        aria-label="ru"
      />
      <div className="flex items-center gap-1.5">
        <input
          name="boxCount"
          className="input !min-h-10 w-0 flex-1 !px-2 text-center"
          inputMode="numeric"
          defaultValue={lot.boxCount}
          aria-label="boxes"
          required
        />
        <span className="text-xs">📦</span>
      </div>
      <input
        name="note"
        className="input"
        defaultValue={lot.note ?? ''}
        aria-label="note"
        placeholder={t('note')}
      />
      {lot.dimsMode === 'uniform' ? (
        <div className="flex items-center gap-1.5">
          <input name="boxLengthCm" className="input !min-h-10 w-0 flex-1 !px-2 text-center" inputMode="decimal" defaultValue={lot.boxLengthCm ?? ''} placeholder="L" aria-label="L" required />
          <input name="boxWidthCm" className="input !min-h-10 w-0 flex-1 !px-2 text-center" inputMode="decimal" defaultValue={lot.boxWidthCm ?? ''} placeholder="W" aria-label="W" required />
          <input name="boxHeightCm" className="input !min-h-10 w-0 flex-1 !px-2 text-center" inputMode="decimal" defaultValue={lot.boxHeightCm ?? ''} placeholder="H" aria-label="H" required />
          <input name="boxWeightKg" className="input !min-h-10 w-0 flex-1 !px-2 text-center" inputMode="decimal" defaultValue={lot.boxWeightKg ?? ''} placeholder="kg" aria-label="kg" required />
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <input name="totalWeightKg" className="input !min-h-10 w-0 flex-1 !px-2 text-center" inputMode="decimal" defaultValue={lot.totalWeightKg} placeholder="kg" aria-label="total kg" required />
          <input name="totalVolumeM3" className="input !min-h-10 w-0 flex-1 !px-2 text-center" inputMode="decimal" defaultValue={lot.totalVolumeM3} placeholder="m³" aria-label="total m3" required />
        </div>
      )}
      {state.error && (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {state.error === 'edit_window_closed'
            ? t('editWindowClosed')
            : state.error === 'structural_locked'
              ? t('structuralLocked')
              : tc('error')}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className="btn-primary flex-1 disabled:opacity-60">
          {tc('save')}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
          {tc('cancel')}
        </button>
      </div>
    </form>
  );
}
