'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { setBoxStatusAction } from './actions';

/**
 * Manager-only box status flows (spec 5.5, edge case 11): mark lost/void with
 * a mandatory reason; a lost box can be marked found (back to stock).
 *
 * `landingOptions` is set only for a lost box that stands in NO warehouse — a
 * carton written off as lost on the road — because restoring it has to say
 * where it turned up; a box written off on a shelf comes back to that shelf.
 */
export function BoxStatusActions({
  boxId,
  status,
  inCrate,
  landingOptions,
}: {
  boxId: string;
  status: string;
  inCrate: boolean;
  landingOptions: { id: string; label: string }[] | null;
}) {
  const t = useTranslations('stock');
  const tc = useTranslations('common');
  const router = useRouter();
  const [mode, setMode] = useState<'lost' | 'void' | 'in_stock' | null>(null);
  const [reason, setReason] = useState('');
  const [landing, setLanding] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ code: string; detail?: string } | null>(null);

  const options: { to: 'lost' | 'void' | 'in_stock'; label: string; danger: boolean }[] = [];
  if (status === 'in_stock' && !inCrate) {
    options.push({ to: 'lost', label: `⚠️ ${t('markLost')}`, danger: true });
    options.push({ to: 'void', label: `🗑 ${t('markVoid')}`, danger: true });
  }
  if (status === 'lost') {
    options.push({ to: 'in_stock', label: `✅ ${t('markFound')}`, danger: false });
  }
  if (options.length === 0) return null;

  const needsLanding = mode === 'in_stock' && landingOptions !== null;

  // A refusal is a sentence (a literal map, #163) — the codes are the
  // service's words for the machine, not for the manager holding the carton.
  function errorText(code: string, detail?: string): string {
    switch (code) {
      case 'transition_not_allowed':
        return t('statusErrors.transition_not_allowed');
      case 'box_in_crate':
        return t('statusErrors.box_in_crate');
      case 'box_has_no_warehouse':
        return t('statusErrors.box_has_no_warehouse');
      case 'receipt_voided':
        return t('statusErrors.receipt_voided');
      case 'receipt_has_costs':
        return t('statusErrors.receipt_has_costs');
      case 'shared_cost_orphaned':
        return t('statusErrors.shared_cost_orphaned', { code: detail ?? '—' });
      case 'box_not_found':
        return t('statusErrors.box_not_found');
      case 'forbidden':
        return tc('forbidden');
      default:
        return t('statusErrors.failed');
    }
  }

  async function submit() {
    if (!mode) return;
    setPending(true);
    setError(null);
    try {
      const res = await setBoxStatusAction({
        boxId,
        to: mode,
        reason,
        ...(needsLanding && landing ? { foundAtWarehouseId: landing } : {}),
      });
      if (res.ok) {
        setMode(null);
        setReason('');
        setLanding('');
        router.refresh();
      } else {
        setError({ code: res.error ?? 'error', detail: res.detail });
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="card space-y-2 !p-3">
      {mode === null ? (
        <div className="flex flex-wrap gap-2">
          {options.map((opt) => (
            <button
              key={opt.to}
              type="button"
              className={`${opt.danger ? 'btn-danger' : 'btn-primary'} flex-1 whitespace-nowrap px-3 text-sm`}
              onClick={() => setMode(opt.to)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      ) : (
        <>
          <p className="text-sm font-semibold">
            {mode === 'lost' ? t('markLost') : mode === 'void' ? t('markVoid') : t('markFound')}
          </p>
          {needsLanding && (
            <select
              data-testid="status-landing"
              className="input"
              aria-label={t('foundAtWarehouse')}
              value={landing}
              onChange={(e) => setLanding(e.target.value)}
            >
              <option value="">{t('foundAtWarehouse')}</option>
              {landingOptions!.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          <input
            data-testid="status-reason"
            className="input"
            placeholder={t('reasonRequired')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="status-confirm"
              className="btn-primary flex-1 disabled:opacity-50"
              disabled={pending || reason.trim().length < 3 || (needsLanding && !landing)}
              onClick={submit}
            >
              {pending ? tc('loading') : tc('save')}
            </button>
            <button type="button" className="btn-secondary flex-1" onClick={() => setMode(null)}>
              {tc('cancel')}
            </button>
          </div>
        </>
      )}
      {error && (
        <p data-testid="status-error" className="text-sm font-semibold text-bad">
          {errorText(error.code, error.detail)}
        </p>
      )}
    </div>
  );
}
