'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { saveReceiptCostGridAction } from '../../costs/actions';
import { LightboxImg } from '@/components/lightbox-img';
import { codeIdentity } from '@/modules/wms/labels/code-identity';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';

export interface GridLotLine {
  letter: string | null;
  name: string;
  /** Boxes of this lot on THIS truck. */
  onBatch: number;
  /** Boxes the lot was received with; more than `onBatch` = split lot. */
  lotBoxCount: number;
}

export interface GridReceiptRow {
  receiptId: string;
  number: string | null;
  clientCode: string | null;
  marking: string | null;
  dealId: string | null;
  dealCode: string | null;
  photoId: string | null;
  boxes: number;
  kg: number;
  m3: number;
  lots: GridLotLine[];
}

export interface GridCostType {
  id: string;
  name: string;
}

/** What one cell already carries, split into this truck's part and the rest. */
export interface GridWritten {
  usd: number;
  unconverted: boolean;
  hereUsd: number;
}

type CellRead = { value: number | null; bad: boolean };

/**
 * The accountant's Excel, kept (round 29): a row per prixod, a column per
 * expense — rastamojka, usluga, yo'lkira, sertifikat, whichever types the
 * owner keeps in the dictionary — and ONE save instead of a form per cell.
 * Amounts already written are printed under each cell, so a second session
 * sees them before typing the same customs bill twice.
 *
 * 2026-09-24 (owner: «tovar nomi, karobka soni va rasmi kerak … klient kod,
 * tovar nomi va boshqa infolari bo'yicha filterlash»): each row now carries
 * the goods, and the sheet filters in the BROWSER. Not in the URL: `save`
 * posts every typed cell of every row, and a server-side filter would drop
 * the typed cells of the rows it hid. Hidden rows are still saved, and the
 * screen says how much of the sheet is typed out of sight.
 */
export function ReceiptCostGrid({
  batchId,
  rows,
  types,
  existing,
  batchScope,
  dealLinks,
  currencies,
  defaultCurrency,
  today,
  canEdit,
  partners,
}: {
  batchId: string;
  rows: GridReceiptRow[];
  types: GridCostType[];
  /** `receiptId:costTypeId` → what is already written. */
  existing: Record<string, GridWritten>;
  /** costTypeId → this truck's BATCH-scope cost, which no cell shows. */
  batchScope: Record<string, number>;
  /** Whether the deal code may link to the deal card (the deal-write door). */
  dealLinks: boolean;
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
  const [query, setQuery] = useState('');
  const [emptyType, setEmptyType] = useState('');
  const [message, setMessage] = useState<
    { kind: 'ok' } | { kind: 'error'; code: string; saved: number } | null
  >(null);
  const [pending, start] = useTransition();

  // One reader for what a person typed (`parseTypedMoney`, the calc screen's):
  // «1,200» is a thousand two hundred and «1 200» is not NaN. What it cannot
  // read is RED and stops the save — the old reader dropped it silently and
  // the success then wiped it, so the bill vanished with a ✅ on screen.
  const read = (key: string): CellRead => {
    const raw = (cells[key] ?? '').trim();
    if (!raw) return { value: null, bad: false };
    const value = parseTypedMoney(raw);
    return value !== null && value > 0 ? { value, bad: false } : { value: null, bad: true };
  };
  const valueOf = (key: string) => read(key).value ?? 0;

  const matches = (row: GridReceiptRow) => {
    if (emptyType && (existing[`${row.receiptId}:${emptyType}`]?.hereUsd ?? 0) > 0) return false;
    const needles = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (needles.length === 0) return true;
    const id = codeIdentity(row.marking, row.clientCode);
    const hay = [
      id.main,
      id.sub,
      row.clientCode,
      row.marking,
      row.number,
      row.dealCode,
      ...row.lots.flatMap((lot) => [
        lot.name,
        // The code-letter forms printed on the label and read out on the
        // loading screen: «GS777-A», and the marking's own «…-A».
        lot.letter ? `${id.main}-${lot.letter}` : null,
        lot.letter && id.sub ? `${id.sub}-${lot.letter}` : null,
      ]),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return needles.every((needle) => hay.includes(needle));
  };
  const visible = rows.filter(matches);
  const filtered = visible.length !== rows.length;
  const visibleIds = new Set(visible.map((row) => row.receiptId));

  const rowTotal = (receiptId: string) =>
    types.reduce((sum, type) => sum + valueOf(`${receiptId}:${type.id}`), 0);
  const grand = rows.reduce((sum, row) => sum + rowTotal(row.receiptId), 0);
  const colTyped = (typeId: string) =>
    rows.reduce((sum, row) => sum + valueOf(`${row.receiptId}:${typeId}`), 0);
  const colDone = (typeId: string) =>
    rows.reduce((sum, row) => sum + (existing[`${row.receiptId}:${typeId}`]?.usd ?? 0), 0);
  const doneGrand = types.reduce((sum, type) => sum + colDone(type.id), 0);

  let badCount = 0;
  let badHidden = 0;
  let hiddenTyped = 0;
  let hiddenSum = 0;
  for (const row of rows) {
    for (const type of types) {
      const cell = read(`${row.receiptId}:${type.id}`);
      const hidden = !visibleIds.has(row.receiptId);
      if (cell.bad) {
        badCount += 1;
        if (hidden) badHidden += 1;
      }
      if (hidden && cell.value !== null) {
        hiddenTyped += 1;
        hiddenSum += cell.value;
      }
    }
  }

  const save = () => {
    if (badCount > 0) return;
    const payload: { receiptId: string; costTypeId: string; amount: number }[] = [];
    for (const row of rows) {
      for (const type of types) {
        const { value } = read(`${row.receiptId}:${type.id}`);
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
      // Clear exactly what became an entry. A save that stopped part-way
      // keeps the rest typed, so the next press cannot write a landed cell
      // twice.
      const saved = new Set(result.saved ?? []);
      setCells((prev) =>
        result.ok
          ? {}
          : Object.fromEntries(Object.entries(prev).filter(([key]) => !saved.has(key))),
      );
      setMessage(
        result.ok
          ? { kind: 'ok' }
          : { kind: 'error', code: result.error ?? 'error', saved: saved.size },
      );
    });
  };

  if (rows.length === 0) return <p className="text-sm text-ink-500">{tc('empty')}</p>;

  const errorText = (code: string) => (code === 'fx_missing' ? t('fxMissing') : tc('error'));

  return (
    <div className="space-y-2" data-testid="receipt-cost-grid">
      {/* The filter. Its own row, full width on a phone (#419's cascade). */}
      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('gridSearch')}
          aria-label={t('gridSearch')}
          data-testid="grid-search"
          className="input min-w-0 flex-1"
        />
        <select
          value={emptyType}
          onChange={(event) => setEmptyType(event.target.value)}
          aria-label={t('gridEmptyCol')}
          data-testid="grid-empty-col"
          className="input w-full sm:!w-56"
        >
          <option value="">{t('gridEmptyColAll')}</option>
          {types.map((type) => (
            <option key={type.id} value={type.id}>
              {t('gridEmptyColOf', { type: type.name })}
            </option>
          ))}
        </select>
      </div>
      {filtered && (
        <p className="text-xs text-ink-500" data-testid="grid-shown">
          {t('gridShown', { shown: visible.length, total: rows.length })}
          {hiddenTyped > 0 && (
            <b className="text-warn">
              {' · '}
              {t('gridHiddenTyped', { count: hiddenTyped, amount: hiddenSum.toFixed(2), currency })}
            </b>
          )}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line-strong bg-surface-sunken text-left text-xs uppercase text-ink-500">
              {/* Sticky from md up only: on a phone a pinned 200 px column
                  leaves the cells a sliver and the grid scrolls under it. */}
              <th className="bg-surface-sunken p-2 md:sticky md:left-0 md:z-10">
                {t('gridReceipt')}
              </th>
              {types.map((type) => (
                <th key={type.id} className="border-l border-line p-2 text-right">
                  {type.name}
                  {(batchScope[type.id] ?? 0) > 0 && (
                    // The truck's own batch-wide bill of this type: in no
                    // cell, so the column read empty and invited a second
                    // entry per prixod.
                    <span
                      className="num block font-normal normal-case text-warn"
                      data-testid="grid-batch-scope"
                    >
                      {t('gridBatchScope', { amount: batchScope[type.id]!.toFixed(2) })}
                    </span>
                  )}
                </th>
              ))}
              <th className="border-l border-line-strong p-2 text-right">{t('gridRowTotal')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={types.length + 2} className="p-3 text-center text-ink-500">
                  {t('gridNoMatch')}
                </td>
              </tr>
            )}
            {visible.map((row) => {
              const id = codeIdentity(row.marking, row.clientCode);
              return (
                <tr
                  key={row.receiptId}
                  data-testid="grid-row"
                  className="border-b border-line align-top odd:bg-surface-sunken/40 last:border-0"
                >
                  <td className="min-w-52 bg-surface p-2 md:sticky md:left-0 md:z-10">
                    <div className="flex gap-2">
                      {row.photoId ? (
                        <LightboxImg
                          attachmentId={row.photoId}
                          className="h-12 w-12 rounded object-cover"
                        />
                      ) : (
                        <span className="h-12 w-12 shrink-0 rounded bg-surface-sunken" />
                      )}
                      <div className="min-w-0">
                        <span className="num font-bold text-good">{id.main}</span>
                        {id.sub && (
                          <span className="num ml-1 text-xs text-ink-500">{id.sub}</span>
                        )}{' '}
                        <Link
                          href={`/receipts/${row.receiptId}`}
                          className="num text-xs text-brand-700 underline-offset-2 hover:underline"
                        >
                          {row.number ?? '—'}
                        </Link>
                        {row.dealCode &&
                          (dealLinks && row.dealId ? (
                            <Link
                              href={`/bitimlar/${row.dealId}`}
                              className="num ml-1 text-xs text-brand-700 underline-offset-2 hover:underline"
                            >
                              {row.dealCode}
                            </Link>
                          ) : (
                            <span className="num ml-1 text-xs text-ink-500">{row.dealCode}</span>
                          ))}
                        <p className="num text-xs text-ink-500">
                          📦 {row.boxes} · {row.kg} kg · {row.m3} m³
                        </p>
                      </div>
                    </div>
                    <ul className="mt-1 space-y-0.5 text-xs text-ink-700">
                      {row.lots.map((lot, index) => (
                        <li key={`${lot.letter}-${index}`} className="line-clamp-2">
                          {lot.letter && <b className="num">{lot.letter}</b>}
                          {lot.letter && ' · '}
                          {lot.name}{' '}
                          <span
                            className="num whitespace-nowrap text-ink-500"
                            title={
                              lot.onBatch < lot.lotBoxCount
                                ? t('gridSplitLot', {
                                    onBatch: lot.onBatch,
                                    total: lot.lotBoxCount,
                                  })
                                : undefined
                            }
                          >
                            📦 {lot.onBatch}
                            {lot.onBatch < lot.lotBoxCount && `/${lot.lotBoxCount}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </td>
                  {types.map((type) => {
                    const key = `${row.receiptId}:${type.id}`;
                    const done = existing[key];
                    const cell = read(key);
                    const elsewhere = done ? Math.round((done.usd - done.hereUsd) * 100) / 100 : 0;
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
                            aria-invalid={cell.bad || undefined}
                            className={`input !min-h-8 w-full min-w-20 text-right ${
                              cell.bad ? '!border-bad !bg-bad/10' : ''
                            }`}
                          />
                        ) : null}
                        {done !== undefined && (
                          // What is ALREADY on this prixod for this expense —
                          // the guard against paying the same bill twice. A
                          // cell holding money with no FX rate yet must not
                          // wear an empty cell's face: «≈ $0» invited the very
                          // double entry this hint exists to stop.
                          <p
                            className={`num text-xs ${done.unconverted ? 'font-semibold text-warn' : 'text-ink-400'}`}
                          >
                            ≈ ${done.hereUsd}
                            {done.unconverted && ' ⚠'}
                          </p>
                        )}
                        {elsewhere > 0 && (
                          // Written on this prixod but not on this truck's
                          // grid: the other truck of a split prixod, the
                          // receipt card, the wizard. It may be this bill.
                          <p
                            className="num text-[11px] text-ink-400"
                            title={t('gridElsewhereHint')}
                          >
                            {t('gridElsewhere', { amount: elsewhere.toFixed(2) })}
                          </p>
                        )}
                      </td>
                    );
                  })}
                  <td className="num border-l border-line-strong p-2 text-right font-semibold">
                    {rowTotal(row.receiptId) > 0 ? rowTotal(row.receiptId).toFixed(2) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            {/* The Excel «jami» row: what is already written per column…
                over the WHOLE truck, filter or not — the save posts all of
                it, so the totals must describe all of it. */}
            {doneGrand > 0 && (
              <tr className="border-t border-line bg-surface-sunken text-xs text-ink-500">
                <td className="bg-surface-sunken p-2 md:sticky md:left-0 md:z-10">
                  {t('gridEntered')}
                  {filtered && <span className="block">{t('gridTotalsAll')}</span>}
                </td>
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
                <td className="bg-surface-sunken p-2 text-xs uppercase text-ink-500 md:sticky md:left-0 md:z-10">
                  {t('gridNow')}
                </td>
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

      {canEdit && badCount > 0 && (
        <p role="alert" className="text-sm font-semibold text-bad" data-testid="grid-bad">
          {t('gridBadCells', { count: badCount })}
          {badHidden > 0 && (
            <>
              {' '}
              {t('gridBadHidden', { count: badHidden })}{' '}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setQuery('');
                  setEmptyType('');
                }}
              >
                {t('gridShowAll')}
              </button>
            </>
          )}
        </p>
      )}

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
            disabled={pending || grand <= 0 || badCount > 0}
            className="btn-primary ml-auto"
          >
            {pending ? tc('loading') : tc('save')}
          </button>
        </div>
      )}
      {message?.kind === 'ok' && (
        <p className="text-sm font-semibold text-good">✅ {tc('saved')}</p>
      )}
      {message?.kind === 'error' && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {message.saved > 0
            ? t('gridPartial', { saved: message.saved, reason: errorText(message.code) })
            : errorText(message.code)}
        </p>
      )}
    </div>
  );
}
