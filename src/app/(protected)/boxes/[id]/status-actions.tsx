'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { setBoxStatusAction } from './actions';

/**
 * Manager-only box status flows (spec 5.5, edge case 11): mark lost/void with
 * a mandatory reason; a lost box can be marked found (back to stock).
 */
export function BoxStatusActions({ boxId, status, inCrate }: { boxId: string; status: string; inCrate: boolean }) {
  const t = useTranslations('stock');
  const tc = useTranslations('common');
  const router = useRouter();
  const [mode, setMode] = useState<'lost' | 'void' | 'in_stock' | null>(null);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options: { to: 'lost' | 'void' | 'in_stock'; label: string; danger: boolean }[] = [];
  if (status === 'in_stock' && !inCrate) {
    options.push({ to: 'lost', label: `⚠️ ${t('markLost')}`, danger: true });
    options.push({ to: 'void', label: `🗑 ${t('markVoid')}`, danger: true });
  }
  if (status === 'lost') {
    options.push({ to: 'in_stock', label: `✅ ${t('markFound')}`, danger: false });
  }
  if (options.length === 0) return null;

  async function submit() {
    if (!mode) return;
    setPending(true);
    setError(null);
    try {
      const res = await setBoxStatusAction({ boxId, to: mode, reason });
      if (res.ok) {
        setMode(null);
        setReason('');
        router.refresh();
      } else {
        setError(res.error ?? 'error');
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
              disabled={pending || reason.trim().length < 3}
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
      {error && <p className="text-sm font-semibold text-bad">{error}</p>}
    </div>
  );
}
