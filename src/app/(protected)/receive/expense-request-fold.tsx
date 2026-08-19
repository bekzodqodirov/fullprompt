'use client';

import { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { compressPhoto } from '@/components/compress-photo';
import { requestExpenseAction } from './actions';

/**
 * «💸 Rasxod xabari» — one folded line on the receive screen (round 107,
 * owner: «prixod oynasida katta joy egallamasin»). The operator reports
 * money spent — summa, izoh, chek photos — and whoever holds
 * finance.expenses enters the real expense with the right kontragent.
 *
 * The photos are pre-bound to a client-minted request id (#180's pattern),
 * uploaded as they are picked; a refusal keeps every typed value (#377's
 * rule — no form action, controlled state, verdict read first). The fold
 * also shows the operator's own recent reports, so «kiritildi» and «rad»
 * come back to the person who spent the money.
 */
export interface RecentExpenseRequest {
  id: string;
  amount: string;
  currency: string;
  note: string;
  status: string;
  rejectReason: string | null;
}

export function ExpenseRequestFold({
  warehouses,
  currencies,
  recent,
}: {
  warehouses: { id: string; code: string }[];
  currencies: string[];
  recent: RecentExpenseRequest[];
}) {
  const t = useTranslations('rasxod');
  const router = useRouter();
  const [requestId, setRequestId] = useState(() => uuidv4());
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(currencies[0] ?? 'UZS');
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState(0);
  const [uploading, setUploading] = useState(0);
  const [photoError, setPhotoError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  // Literal map — the i18n tripwire cannot see a key built at runtime.
  const errors: Record<string, string> = {
    forbidden: t('errors.forbidden'),
    validation: t('errors.validation'),
    warehouse_not_found: t('errors.validation'),
    failed: t('errors.failed'),
  };

  async function addPhotos(files: FileList | null) {
    if (!files || files.length === 0) return;
    setPhotoError(false);
    for (const file of Array.from(files)) {
      setUploading((n) => n + 1);
      try {
        const compressed = await compressPhoto(file);
        const body = new FormData();
        body.append('file', compressed);
        body.append('entityType', 'expense_request');
        body.append('entityId', requestId);
        // A stuck upload must say so, not spin for ever (round 97's rule).
        const res = await fetch('/api/files/upload', {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) throw new Error(String(res.status));
        setPhotos((n) => n + 1);
      } catch {
        setPhotoError(true);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  async function send() {
    setBusy(true);
    setError('');
    setSent(false);
    const result = await requestExpenseAction({
      id: requestId,
      warehouseId,
      amount: Number(amount.replace(/\s/g, '').replace(',', '.')),
      currency,
      note,
    });
    setBusy(false);
    if (!result.ok) {
      setError(errors[result.error ?? 'failed'] ?? result.error ?? '');
      return;
    }
    setSent(true);
    setAmount('');
    setNote('');
    setPhotos(0);
    // The next report is a NEW request — its photos must not join this one.
    setRequestId(uuidv4());
    router.refresh();
  }

  return (
    <details className="mb-3 rounded-lg border border-line bg-surface-sunken" data-testid="rasxod-fold">
      <summary className="cursor-pointer list-none px-3 py-2 text-sm font-semibold marker:content-none">
        💸 {t('title')}
      </summary>
      <div className="space-y-2 p-3 pt-0 text-sm">
        <div className="flex flex-wrap gap-2">
          {warehouses.length > 1 && (
            <select
              className="input !w-auto"
              value={warehouseId}
              aria-label={t('warehouse')}
              onChange={(event) => setWarehouseId(event.target.value)}
            >
              {warehouses.map((wh) => (
                <option key={wh.id} value={wh.id}>
                  {wh.code}
                </option>
              ))}
            </select>
          )}
          <input
            className="input !w-28"
            inputMode="decimal"
            value={amount}
            data-testid="rasxod-amount"
            aria-label={t('amount')}
            placeholder={t('amount')}
            onChange={(event) => setAmount(event.target.value)}
          />
          <select
            className="input !w-auto"
            value={currency}
            aria-label="request currency"
            onChange={(event) => setCurrency(event.target.value)}
          >
            {currencies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>
        <input
          className="input"
          value={note}
          data-testid="rasxod-note"
          aria-label={t('note')}
          placeholder={t('note')}
          onChange={(event) => setNote(event.target.value)}
        />
        <div className="flex items-center gap-2">
          <label className="btn-secondary !min-h-10 cursor-pointer">
            📷 {t('photo')}
            {photos > 0 && ` (${photos})`}
            {uploading > 0 && ' ⏳'}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              className="hidden"
              onChange={(event) => {
                void addPhotos(event.target.files);
                event.target.value = '';
              }}
            />
          </label>
          <button
            type="button"
            data-testid="rasxod-send"
            disabled={busy || uploading > 0 || note.trim().length < 2 || !(Number(amount.replace(',', '.')) > 0)}
            onClick={() => void send()}
            className="btn-primary !min-h-10 flex-1"
          >
            {t('send')}
          </button>
        </div>
        {photoError && <p className="text-xs font-semibold text-bad">{t('photoFailed')}</p>}
        {error && (
          <p className="text-sm font-semibold text-bad" data-testid="rasxod-error">
            {error}
          </p>
        )}
        {sent && (
          <p className="text-sm font-semibold text-good" data-testid="rasxod-sent">
            ✅ {t('sent')}
          </p>
        )}

        {recent.length > 0 && (
          <ul className="space-y-0.5 border-t border-line pt-2 text-xs text-ink-500">
            {recent.map((row) => (
              <li key={row.id} className="[overflow-wrap:anywhere]">
                {row.status === 'done' ? '✅' : row.status === 'rejected' ? '⛔' : '⏳'}{' '}
                {Number(row.amount).toLocaleString('ru-RU')} {row.currency} — {row.note}
                {row.status === 'rejected' && row.rejectReason ? ` (${row.rejectReason})` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
