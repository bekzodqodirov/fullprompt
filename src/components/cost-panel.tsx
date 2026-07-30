'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { addCostEntryAction, voidCostEntryAction } from '@/app/(protected)/costs/actions';

export interface CostEntryView {
  id: string;
  typeName: string;
  amount: string;
  currency: string;
  amountUsd: string | null;
  costDate: string;
  allocationBasis: string;
  note: string | null;
  clientCode?: string | null;
}

export interface CostTypeOption {
  id: string;
  code: string;
  name: string;
}
export interface ClientOption {
  id: string;
  clientCode: string;
}

const BASES = ['weight', 'volume', 'chargeable', 'boxes', 'direct_to_client'] as const;

/**
 * W9 cost capture (spec 6.9) — shared by the batch card (freight, agent fee,
 * customs…), the receipt page (local handling) and the crate card (the yashik
 * fee, correctable since round 31). Lists entries with their USD conversion,
 * adds new ones, voids with a reason.
 */
export function CostPanel({
  scope,
  targetId,
  entries,
  costTypes,
  currencies,
  clientOptions,
  defaultCurrency,
  canEdit,
}: {
  scope: 'batch' | 'receipt' | 'crate';
  targetId: string;
  entries: CostEntryView[];
  costTypes: CostTypeOption[];
  currencies: string[];
  /** Clients aboard — needed only for direct_to_client. */
  clientOptions: ClientOption[];
  defaultCurrency: string;
  canEdit: boolean;
}) {
  const t = useTranslations('costing');
  const tc = useTranslations('common');
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typeId, setTypeId] = useState(costTypes[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [costDate, setCostDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [basis, setBasis] = useState<(typeof BASES)[number]>('weight');
  const [clientId, setClientId] = useState('');
  const [note, setNote] = useState('');

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await addCostEntryAction({
        scope,
        batchId: scope === 'batch' ? targetId : undefined,
        receiptId: scope === 'receipt' ? targetId : undefined,
        crateId: scope === 'crate' ? targetId : undefined,
        costTypeId: typeId,
        amount: Number(amount.replace(',', '.')),
        currency,
        costDate,
        allocationBasis: basis,
        clientId: basis === 'direct_to_client' ? clientId || undefined : undefined,
        note,
      });
      if (res.ok) {
        setAdding(false);
        setAmount('');
        setNote('');
        router.refresh();
      } else {
        setError(res.error === 'client_required' ? t('clientRequired') : (res.error ?? 'error'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function voidEntry(id: string) {
    const reason = window.prompt(t('voidReason'));
    if (!reason?.trim()) return;
    const res = await voidCostEntryAction({ id, reason });
    if (res.ok) router.refresh();
    else setError(res.error ?? 'error'); // a silent failed void looked like success
  }

  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <div key={entry.id} className="flex flex-wrap items-baseline gap-2 border-b border-line py-1.5 text-sm last:border-0">
          <span>{entry.typeName}</span>
          <span className="font-semibold">
            {entry.amount} {entry.currency}
          </span>
          {entry.amountUsd !== null ? (
            <span className="text-ink-500">≈ ${entry.amountUsd}</span>
          ) : (
            <span className="rounded bg-orange-100 px-1.5 text-xs font-semibold text-orange-800">
              {t('noRate')}
            </span>
          )}
          <span className="text-xs text-ink-500">
            {entry.costDate} · {t(`bases.${entry.allocationBasis}`)}
            {entry.clientCode && ` → ${entry.clientCode}`}
          </span>
          {entry.note && <span className="w-full text-xs text-ink-500">{entry.note}</span>}
          {canEdit && (
            <button
              type="button"
              aria-label={t('void')}
              className="ml-auto text-xs font-semibold text-bad"
              onClick={() => voidEntry(entry.id)}
            >
              🗑 {t('void')}
            </button>
          )}
        </div>
      ))}
      {entries.length === 0 && <p className="text-sm text-ink-500">—</p>}

      {error && !adding && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {error}
        </p>
      )}
      {canEdit && !adding && (
        <button
          type="button"
          data-testid="add-cost"
          className="btn-secondary w-full"
          onClick={() => setAdding(true)}
        >
          ＋ {t('addCost')}
        </button>
      )}
      {canEdit && adding && (
        <div className="space-y-2 rounded-lg bg-surface-sunken p-3">
          <select aria-label={t('type')} className="input" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {costTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <input
              aria-label={t('amount')}
              data-testid="cost-amount"
              className="input flex-1"
              inputMode="decimal"
              placeholder={t('amount')}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <select aria-label="currency" className="input !w-24 shrink-0" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <input
              aria-label={t('date')}
              type="date"
              className="input flex-1"
              value={costDate}
              onChange={(e) => setCostDate(e.target.value)}
            />
            <select
              aria-label={t('basis')}
              className="input flex-1"
              value={basis}
              onChange={(e) => setBasis(e.target.value as (typeof BASES)[number])}
            >
              {BASES.map((b) => (
                <option key={b} value={b}>
                  {t(`bases.${b}`)}
                </option>
              ))}
            </select>
          </div>
          {basis === 'direct_to_client' && (
            <select aria-label={t('client')} className="input" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">{t('client')}…</option>
              {clientOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.clientCode}
                </option>
              ))}
            </select>
          )}
          <input
            aria-label={t('note')}
            className="input"
            placeholder={t('note')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {error && (
            <p role="alert" className="text-sm font-semibold text-bad">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="save-cost"
              className="btn-primary flex-1 disabled:opacity-50"
              disabled={busy || !typeId || !(Number(amount.replace(',', '.')) > 0)}
              onClick={submit}
            >
              {busy ? tc('loading') : tc('save')}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setAdding(false)}>
              {tc('cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
