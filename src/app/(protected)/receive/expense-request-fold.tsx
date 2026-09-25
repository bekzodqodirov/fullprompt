'use client';

import { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { compressPhoto, PhotoUnreadable } from '@/components/compress-photo';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';
import { requestExpenseAction } from './actions';
import { requestOwnExpenseAction } from '../profile/actions';

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
 *
 * Two doors, one fold (owner M1a): /receive, where the warehouse is the
 * screen's own and required, and /profile, for the seller, the logist and
 * the VED who spend money too and belong to no warehouse. «O'z pulimdan
 * to'ladim» is said HERE and nowhere else — it is what turns the
 * accountant's «Kiritish» into a debt to the reporter instead of cash out of
 * a kassa.
 */
export interface RecentExpenseRequest {
  id: string;
  amount: string;
  currency: string;
  note: string;
  status: string;
  rejectReason: string | null;
  paidBySelf?: boolean;
}

export function ExpenseRequestFold({
  door,
  warehouses,
  currencies,
  recent,
}: {
  /**
   * 'receive': the warehouse is required and the action authorises AT it.
   * 'profile': no warehouse is an answer, the picker offers «none» first and
   * the box starts ticked — somebody reporting from their profile is, nearly
   * always, somebody who paid out of their own pocket.
   */
  door: 'receive' | 'profile';
  warehouses: { id: string; code: string }[];
  currencies: string[];
  recent: RecentExpenseRequest[];
}) {
  const t = useTranslations('rasxod');
  const tc = useTranslations('common');
  const router = useRouter();
  const [requestId, setRequestId] = useState(() => uuidv4());
  const [warehouseId, setWarehouseId] = useState(
    door === 'profile' ? '' : (warehouses[0]?.id ?? ''),
  );
  const [paidBySelf, setPaidBySelf] = useState(door === 'profile');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(currencies[0] ?? 'UZS');
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState(0);
  const [uploading, setUploading] = useState(0);
  // A reason, not a boolean: «the upload failed» and «that file is not a
  // photograph» need different sentences, and round 111 made the second one
  // reachable by opening the file browser.
  const [photoError, setPhotoError] = useState<'failed' | 'notPhoto' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  // Literal map — the i18n tripwire cannot see a key built at runtime.
  const errors: Record<string, string> = {
    forbidden: t('errors.forbidden'),
    unauthenticated: t('errors.forbidden'),
    validation: t('errors.validation'),
    amount_too_large: tc('amountTooLarge'),
    warehouse_not_found: t('errors.validation'),
    failed: t('errors.failed'),
  };

  async function addPhotos(files: FileList | null) {
    if (!files || files.length === 0) return;
    setPhotoError(null);
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
      } catch (err) {
        setPhotoError(err instanceof PhotoUnreadable ? 'notPhoto' : 'failed');
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  async function send() {
    setBusy(true);
    setError('');
    setSent(false);
    const payload = {
      id: requestId,
      warehouseId: warehouseId || undefined,
      paidBySelf,
      // «1,200» is a thousand two hundred (U28, #979's reader) — the comma
      // used to become a decimal point, and the accountant's «Kiritish»
      // pre-filled the 1.2 the request had stored.
      amount: parseTypedMoney(amount) ?? Number.NaN,
      currency,
      note,
    };
    const result =
      door === 'profile'
        ? await requestOwnExpenseAction(payload)
        : await requestExpenseAction(payload);
    setBusy(false);
    if (!result.ok) {
      setError(errors[result.error ?? 'failed'] ?? result.error ?? '');
      return;
    }
    setSent(true);
    setAmount('');
    setNote('');
    setPhotos(0);
    setPaidBySelf(door === 'profile');
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
          {(door === 'profile' ? warehouses.length > 0 : warehouses.length > 1) && (
            <select
              className="input !w-auto"
              value={warehouseId}
              aria-label={t('warehouse')}
              data-testid="rasxod-warehouse"
              onChange={(event) => setWarehouseId(event.target.value)}
            >
              {door === 'profile' && <option value="">— {t('noWarehouse')} —</option>}
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
        {/* A checkbox, never disabled (#171): unticked is a real answer —
            the till's money, spent by a colleague. */}
        <label className="flex min-h-10 items-center gap-2 font-semibold">
          <input
            type="checkbox"
            className="h-5 w-5"
            data-testid="rasxod-self"
            checked={paidBySelf}
            onChange={(event) => setPaidBySelf(event.target.checked)}
          />
          👤 {t('paidBySelf')}
        </label>
        <div className="flex items-center gap-2">
          <label className="btn-secondary !min-h-10 cursor-pointer">
            📷 {t('photo')}
            {photos > 0 && ` (${photos})`}
            {uploading > 0 && ' ⏳'}
            {/* No `capture` (round 111): a receipt is often photographed at
                the till and picked from the gallery later. The reset was
                already here and is the model the other three copied. */}
            <input
              type="file"
              accept="image/*"
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
        {photoError && (
          <p className="text-xs font-semibold text-bad">
            {photoError === 'notPhoto' ? tc('photoOnly') : t('photoFailed')}
          </p>
        )}
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
                {row.paidBySelf ? '👤 ' : ''}
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
