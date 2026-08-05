'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { saveReceiptCostGridAction } from '../../costs/actions';

export interface GridReceiptRow {
  receiptId: string;
  number: string | null;
  clientCode: string | null;
  kg: number;
  m3: number;
}

export interface GridCostType {
  id: string;
  name: string;
}

/**
 * The accountant's Excel, kept (round 29): a row per prixod, a column per
 * expense — rastamojka, usluga, yo'lkira, sertifikat, whichever types the
 * owner keeps in the dictionary — and ONE save instead of a form per cell.
 * Amounts already written are printed under each cell, so a second session
 * sees them before typing the same customs bill twice.
 */
export function ReceiptCostGrid({
  batchId,
  rows,
  types,
  existing,
  currencies,
  defaultCurrency,
  today,
  canEdit,
  partners,
}: {
  batchId: string;
  rows: GridReceiptRow[];
  types: GridCostType[];
  /** `receiptId:costTypeId` → already-entered USD sum. */
  existing: Record<string, number>;
  currencies: string[];
  defaultCurrency: string;
  today: string;
  canEdit: boolean;
  /** Active counterparties — empty when the viewer may not name a payer. */
  partners: { id: string; name: string }[];
}) {
  const t = useTranslations('costing');
  const tc = useTranslations('common');
  const [cells, setCells] = useState<Record<string, string>>({});
  const [currency, setCurrency] = useState(defaultCurrency);
  const [costDate, setCostDate] = useState(today);
  const [partnerId, setPartnerId] = useState('');
  const [message, setMessage] = useState<'ok' | string | null>(null);
  const [pending, start] = useTransition();

  const parsed = (key: string): number | null => {
    const raw = (cells[key] ?? '').trim().replace(',', '.');
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const rowTotal = (receiptId: string) =>
    types.reduce((sum, type) => sum + (parsed(`${receiptId}:${type.id}`) ?? 0), 0);
  const grand = rows.reduce((sum, row) => sum + rowTotal(row.receiptId), 0);
  const colTyped = (typeId: string) =>
    rows.reduce((sum, row) => sum + (parsed(`${row.receiptId}:${typeId}`) ?? 0), 0);
  const colDone = (typeId: string) =>
    rows.reduce((sum, row) => sum + (existing[`${row.receiptId}:${typeId}`] ?? 0), 0);
  const doneGrand = types.reduce((sum, type) => sum + colDone(type.id), 0);

  const save = () => {
    const payload: { receiptId: string; costTypeId: string; amount: number }[] = [];
    for (const row of rows) {
      for (const type of types) {
        const value = parsed(`${row.receiptId}:${type.id}`);
        if (value !== null) {
          payload.push({ receiptId: row.receiptId, costTypeId: type.id, amount: value });
        }
      }
    }
    if (payload.length === 0) return;
    start(async () => {
      const result = await saveReceiptCostGridAction({
        batchId,
        currency,
        costDate,
        partnerId,
        cells: payload,
      });
      if (result.ok) {
        setCells({});
        setMessage('ok');
      } else {
        setMessage(result.error ?? 'error');
      }
    });
  };

  if (rows.length === 0) return <p className="text-sm text-ink-500">{tc('empty')}</p>;

  return (
    <div className="space-y-2" data-testid="receipt-cost-grid">
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line-strong bg-surface-sunken text-left text-xs uppercase text-ink-500">
              <th className="p-2">{t('gridReceipt')}</th>
              {types.map((type) => (
                <th key={type.id} className="border-l border-line p-2 text-right">
                  {type.name}
                </th>
              ))}
              <th className="border-l border-line-strong p-2 text-right">{t('gridRowTotal')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.receiptId}
                className="border-b border-line align-top odd:bg-surface-sunken/40 last:border-0"
              >
                <td className="p-2">
                  <span className="num font-bold text-good">{row.clientCode ?? '—'}</span>{' '}
                  <span className="num text-xs text-ink-500">{row.number}</span>
                  <p className="num text-xs text-ink-500">
                    {row.kg} kg · {row.m3} m³
                  </p>
                </td>
                {types.map((type) => {
                  const key = `${row.receiptId}:${type.id}`;
                  const done = existing[key];
                  return (
                    <td key={type.id} className="border-l border-line p-1 text-right">
                      {canEdit ? (
                        <input
                          inputMode="decimal"
                          value={cells[key] ?? ''}
                          onChange={(event) =>
                            setCells((prev) => ({ ...prev, [key]: event.target.value }))
                          }
                          aria-label={`${row.number} ${type.name}`}
                          className="input !min-h-8 w-full min-w-20 text-right"
                        />
                      ) : null}
                      {done !== undefined && (
                        // What is ALREADY on this prixod for this expense —
                        // the guard against paying the same bill twice.
                        <p className="num text-xs text-ink-400">≈ ${done}</p>
                      )}
                    </td>
                  );
                })}
                <td className="num border-l border-line-strong p-2 text-right font-semibold">
                  {rowTotal(row.receiptId) > 0 ? rowTotal(row.receiptId).toFixed(2) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {/* The Excel «jami» row: what is already written per column… */}
            {doneGrand > 0 && (
              <tr className="border-t border-line bg-surface-sunken text-xs text-ink-500">
                <td className="p-2">{t('gridEntered')}</td>
                {types.map((type) => (
                  <td key={type.id} className="num border-l border-line p-2 text-right">
                    {colDone(type.id) > 0 ? colDone(type.id).toFixed(2) : '—'}
                  </td>
                ))}
                <td className="num border-l border-line-strong p-2 text-right font-semibold">
                  {doneGrand.toFixed(2)}
                </td>
              </tr>
            )}
            {/* …and what this save is about to add. */}
            {grand > 0 && (
              <tr className="border-t border-line-strong bg-surface-sunken font-semibold">
                <td className="p-2 text-xs uppercase text-ink-500">{t('gridNow')}</td>
                {types.map((type) => (
                  <td key={type.id} className="num border-l border-line p-2 text-right">
                    {colTyped(type.id) > 0 ? colTyped(type.id).toFixed(2) : '—'}
                  </td>
                ))}
                <td className="num border-l border-line-strong p-2 text-right">
                  {grand.toFixed(2)}
                </td>
              </tr>
            )}
          </tfoot>
        </table>
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          {/* NOT aria-label="currency": the CostPanel above owns that name,
              and m9 selects it with a strict locator. */}
          <select
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
            aria-label="grid currency"
            data-testid="grid-currency"
            className="input !w-24 shrink-0"
          >
            {currencies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={costDate}
            onChange={(event) => setCostDate(event.target.value)}
            aria-label={t('date')}
            className="input !w-40"
          />
          {/* Who settled the sheet. Its own LINE, not a squeezed neighbour —
              a picker narrower than its shortest option is the #421 shape. */}
          {partners.length > 0 && (
            <select
              value={partnerId}
              onChange={(event) => setPartnerId(event.target.value)}
              aria-label="grid payer"
              data-testid="grid-payer"
              className="input !w-full"
            >
              <option value="">{t('paidByUs')}</option>
              {partners.map((partner) => (
                <option key={partner.id} value={partner.id}>
                  {t('paidBy')}: {partner.name}
                </option>
              ))}
            </select>
          )}
          {grand > 0 && (
            <span className="num text-sm font-bold">
              Σ {grand.toFixed(2)} {currency}
            </span>
          )}
          <button
            type="button"
            data-testid="save-cost-grid"
            onClick={save}
            disabled={pending || grand <= 0}
            className="btn-primary ml-auto"
          >
            {pending ? tc('loading') : tc('save')}
          </button>
        </div>
      )}
      {message === 'ok' && <p className="text-sm font-semibold text-good">✅ {tc('saved')}</p>}
      {message && message !== 'ok' && (
        <p className="text-sm font-semibold text-bad">
          {message === 'fx_missing' ? t('noRate') : tc('error')}
        </p>
      )}
    </div>
  );
}
