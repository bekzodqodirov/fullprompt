'use client';

import imageCompression from 'browser-image-compression';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { v4 as uuidv4 } from 'uuid';
import { computeLotTotals, densityBand } from '@/modules/wms/receipts/math';
import { AttachmentsPanel } from '@/components/attachments-panel';
import { submitReceiptAction, type SubmitReceiptResult } from './actions';

/**
 * Single-window receiving (owner's request): client on top, product LINES in
 * the middle — a real spreadsheet-style table on desktop (tab through
 * cells like Excel), the original stacked-card layout on mobile — then
 * receipt-level attachments + costs + notes together (not collapsed), and a
 * sticky totals/confirm bar. Draft autosaves to localStorage after every
 * change.
 */

interface WarehouseOption {
  id: string;
  code: string;
  name: string;
  country: string;
}
interface CostTypeOption {
  id: string;
  code: string;
  name: string;
}
interface ClientHit {
  id: string;
  clientCode: string;
  name: string;
  managerName: string | null;
}

interface LotDraft {
  id: string;
  zh: string;
  ru: string;
  boxCount: string;
  dimsMode: 'uniform' | 'mixed';
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  boxWeightKg: string;
  totalWeightKg: string;
  totalVolumeM3: string;
  note: string;
  photoIds: string[];
}

interface CostDraft {
  costTypeId: string;
  amount: string;
  currency: string;
  note: string;
}

interface Draft {
  receiptId: string;
  warehouseId: string;
  clientId: string | null;
  clientLabel: string;
  unclaimed: boolean;
  unclaimedMarking: string;
  sourceNote: string;
  lots: LotDraft[];
  costs: CostDraft[];
  files: { id: string; fileName: string; contentType: string; kind: string }[];
}

const DENSITY_COLORS: Record<string, string> = {
  light: 'bg-blue-100 text-blue-800',
  green: 'bg-green-100 text-green-800',
  orange: 'bg-orange-100 text-orange-800',
  heavy: 'bg-red-100 text-red-800',
};
const THRESHOLDS = { light: 200, medium: 300, heavy: 400 };
const DRAFT_KEY = 'gsr-receipt-draft';

function newLot(): LotDraft {
  return {
    id: uuidv4(),
    zh: '',
    ru: '',
    boxCount: '',
    dimsMode: 'uniform',
    lengthCm: '',
    widthCm: '',
    heightCm: '',
    boxWeightKg: '',
    totalWeightKg: '',
    totalVolumeM3: '',
    note: '',
    photoIds: [],
  };
}

function newDraft(warehouseId: string): Draft {
  return {
    receiptId: uuidv4(),
    warehouseId,
    clientId: null,
    clientLabel: '',
    unclaimed: false,
    unclaimedMarking: '',
    sourceNote: '',
    lots: [newLot()],
    costs: [],
    files: [],
  };
}

function lotTotals(lot: LotDraft) {
  const boxCount = Number(lot.boxCount) || 0;
  if (!boxCount) return null;
  if (lot.dimsMode === 'uniform') {
    const [l, w, h, kg] = [
      Number(lot.lengthCm),
      Number(lot.widthCm),
      Number(lot.heightCm),
      Number(lot.boxWeightKg),
    ];
    if (!l || !w || !h || !kg) return null;
    return computeLotTotals(
      { dimsMode: 'uniform', boxCount, boxLengthCm: l, boxWidthCm: w, boxHeightCm: h, boxWeightKg: kg },
      167,
    );
  }
  const totalKg = Number(lot.totalWeightKg);
  const totalM3 = Number(lot.totalVolumeM3);
  if (!totalKg || !totalM3) return null;
  return computeLotTotals(
    { dimsMode: 'mixed', boxCount, totalWeightKg: totalKg, totalVolumeM3: totalM3 },
    167,
  );
}

export function ReceiveWizard({
  warehouses,
  costTypes,
  currencies,
}: {
  warehouses: WarehouseOption[];
  costTypes: CostTypeOption[];
  currencies: string[];
}) {
  const t = useTranslations('receive');
  const tc = useTranslations('common');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [clientQuery, setClientQuery] = useState('');
  const [clientHits, setClientHits] = useState<ClientHit[]>([]);
  const [letterPreview, setLetterPreview] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitReceiptResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Draft restore — localStorage is client-only, hence the mount effect.
  useEffect(() => {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Draft;
        if (parsed.receiptId && Array.isArray(parsed.lots)) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setDraft(parsed);
          return;
        }
      } catch {
        /* corrupt draft — start fresh */
      }
    }
     
    setDraft(newDraft(warehouses[0]?.id ?? ''));
  }, [warehouses]);

  useEffect(() => {
    if (draft) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }, [draft]);

  const update = useCallback((patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  }, []);

  const updateLot = useCallback((lotId: string, patch: Partial<LotDraft>) => {
    setDraft((d) =>
      d ? { ...d, lots: d.lots.map((l) => (l.id === lotId ? { ...l, ...patch } : l)) } : d,
    );
  }, []);

  // Client autocomplete
  useEffect(() => {
    if (!clientQuery.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setClientHits([]);
      return;
    }
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/clients/search?q=${encodeURIComponent(clientQuery)}`);
      if (res.ok) setClientHits(((await res.json()) as { results: ClientHit[] }).results);
    }, 250);
    return () => clearTimeout(timer);
  }, [clientQuery]);

  // Letter preview
  useEffect(() => {
    if (!draft?.warehouseId || draft.lots.length === 0) return;
    const timer = setTimeout(async () => {
      const res = await fetch(
        `/api/receive/preview?warehouseId=${draft.warehouseId}&count=${draft.lots.length}`,
      );
      if (res.ok) setLetterPreview(((await res.json()) as { letters: string[] }).letters);
    }, 300);
    return () => clearTimeout(timer);
  }, [draft?.warehouseId, draft?.lots.length]);

  if (!draft) return null;

  const warehouse = warehouses.find((w) => w.id === draft.warehouseId);
  const defaultCurrency = warehouse?.country === 'CN' ? 'CNY' : 'USD';

  async function translateLot(lot: LotDraft) {
    if (!lot.zh.trim() || lot.ru) return;
    const res = await fetch(`/api/translate?zh=${encodeURIComponent(lot.zh)}`);
    if (res.ok) {
      const hit = (await res.json()) as { ru: string | null };
      if (hit.ru) updateLot(lot.id, { ru: hit.ru });
    }
  }

  async function addPhotos(lot: LotDraft, files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    for (const file of Array.from(files)) {
      try {
        const compressed = await imageCompression(file, {
          maxSizeMB: 0.3,
          maxWidthOrHeight: 1600,
          useWebWorker: true,
        });
        const formData = new FormData();
        formData.set(
          'file',
          new File([compressed], file.name || 'photo.jpg', {
            type: compressed.type || 'image/jpeg',
          }),
        );
        formData.set('entityType', 'receipt_lot');
        formData.set('entityId', lot.id);
        const res = await fetch('/api/files/upload', { method: 'POST', body: formData });
        if (res.ok) {
          const { id } = (await res.json()) as { id: string };
          setDraft((d) =>
            d
              ? {
                  ...d,
                  lots: d.lots.map((l) =>
                    l.id === lot.id ? { ...l, photoIds: [...l.photoIds, id] } : l,
                  ),
                }
              : d,
          );
        } else {
          setError(t('photoUploadFailed'));
        }
      } catch {
        setError(t('photoUploadFailed'));
      }
    }
  }

  function lotsValid(): boolean {
    return draft!.lots.every(
      (lot) => lot.zh.trim() && Number(lot.boxCount) && lot.photoIds.length > 0 && lotTotals(lot),
    );
  }

  const clientChosen = draft.clientId !== null || (draft.unclaimed && draft.unclaimedMarking.trim());

  async function confirm() {
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        receiptId: draft!.receiptId,
        warehouseId: draft!.warehouseId,
        clientId: draft!.unclaimed ? null : draft!.clientId,
        sourceNote: draft!.sourceNote,
        unclaimedMarking: draft!.unclaimedMarking,
        lots: draft!.lots.map((lot) => ({
          id: lot.id,
          productNameZh: lot.zh.trim(),
          productNameRu: lot.ru.trim(),
          boxCount: Number(lot.boxCount),
          dimsMode: lot.dimsMode,
          note: lot.note.trim(),
          ...(lot.dimsMode === 'uniform'
            ? {
                boxLengthCm: Number(lot.lengthCm),
                boxWidthCm: Number(lot.widthCm),
                boxHeightCm: Number(lot.heightCm),
                boxWeightKg: Number(lot.boxWeightKg),
              }
            : {
                totalWeightKg: Number(lot.totalWeightKg),
                totalVolumeM3: Number(lot.totalVolumeM3),
              }),
        })),
        extraCosts: draft!.costs
          .filter((c) => c.costTypeId && Number(c.amount) > 0)
          .map((c) => ({
            costTypeId: c.costTypeId,
            amount: Number(c.amount),
            currency: c.currency,
            note: c.note,
          })),
      };
      const res = await submitReceiptAction(payload);
      if (res.ok) {
        localStorage.removeItem(DRAFT_KEY);
        setResult(res);
      } else {
        setError(res.error ?? 'error');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div className="card space-y-4 text-center">
        <p className="text-3xl">✅</p>
        <h2 className="text-lg font-bold">{result.number}</h2>
        <ul className="space-y-1 text-left">
          {result.lots?.map((lot) => (
            <li key={lot.letter} className="flex items-baseline gap-2">
              <span className="font-mono text-xl font-extrabold text-blue-800">{lot.letter}</span>
              <span>{lot.productNameZh}</span>
              <span className="ml-auto text-sm text-gray-600">{lot.boxCount} 📦</span>
            </li>
          ))}
        </ul>
        <a
          href={`/api/receipts/${result.receiptId}/labels`}
          target="_blank"
          className="btn-primary w-full"
        >
          🖨 {t('printLabels')}
        </a>
        <a href={`/receipts/${result.receiptId}`} className="btn-secondary w-full">
          {t('openReceipt')}
        </a>
        <button
          type="button"
          className="btn-secondary w-full"
          onClick={() => {
            setResult(null);
            setDraft(newDraft(draft.warehouseId));
          }}
        >
          {t('newReceipt')}
        </button>
      </div>
    );
  }

  const allTotals = draft.lots.map(lotTotals);
  const sumBoxes = draft.lots.reduce((acc, lot) => acc + (Number(lot.boxCount) || 0), 0);
  const sumKg = allTotals.reduce((acc, totals) => acc + (totals?.totalWeightKg ?? 0), 0);
  const sumM3 = allTotals.reduce((acc, totals) => acc + (totals?.totalVolumeM3 ?? 0), 0);

  // --- Shared bits rendered by both the desktop table and the mobile cards ---

  function dimsFields(lot: LotDraft, testIds: boolean) {
    return lot.dimsMode === 'uniform' ? (
      <div className="flex items-center gap-1.5">
        {(
          [
            ['lengthCm', 'L'],
            ['widthCm', 'W'],
            ['heightCm', 'H'],
          ] as const
        ).map(([field, label]) => (
          <input
            key={field}
            data-testid={testIds ? 'lot-' + label : undefined}
            aria-label={label}
            className="input !min-h-10 w-0 flex-1 !px-2 text-center"
            inputMode="decimal"
            value={lot[field]}
            onChange={(e) => updateLot(lot.id, { [field]: e.target.value })}
            placeholder={label}
          />
        ))}
        <input
          aria-label="kg"
          data-testid={testIds ? 'lot-kg' : undefined}
          className="input !min-h-10 w-0 flex-1 !px-2 text-center"
          inputMode="decimal"
          value={lot.boxWeightKg}
          onChange={(e) => updateLot(lot.id, { boxWeightKg: e.target.value })}
          placeholder="kg"
        />
      </div>
    ) : (
      <div className="flex items-center gap-1.5">
        <input
          aria-label={t('totalKg')}
          className="input !min-h-10 w-0 flex-1 !px-2 text-center"
          inputMode="decimal"
          value={lot.totalWeightKg}
          onChange={(e) => updateLot(lot.id, { totalWeightKg: e.target.value })}
          placeholder={t('totalKg')}
        />
        <input
          aria-label={t('totalM3')}
          className="input !min-h-10 w-0 flex-1 !px-2 text-center"
          inputMode="decimal"
          value={lot.totalVolumeM3}
          onChange={(e) => updateLot(lot.id, { totalVolumeM3: e.target.value })}
          placeholder={t('totalM3')}
        />
      </div>
    );
  }

  function photosField(lot: LotDraft) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <label className="btn-secondary !min-h-9 cursor-pointer !px-2 text-sm">
          📷
          <input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="hidden"
            onChange={(e) => addPhotos(lot, e.target.files)}
          />
        </label>
        {lot.photoIds.map((photoId) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={photoId}
            src={`/api/attachments/${photoId}?variant=thumb200`}
            alt=""
            className="h-9 w-9 rounded object-cover"
            onError={(e) => {
              const img = e.currentTarget;
              if (!img.dataset.retried) {
                img.dataset.retried = '1';
                img.src = `/api/attachments/${photoId}?variant=original`;
              }
            }}
          />
        ))}
        {lot.photoIds.length === 0 && (
          <span className="text-xs font-semibold text-orange-600">{t('photoRequired')}</span>
        )}
      </div>
    );
  }

  function totalsBadge(lot: LotDraft) {
    const totals = lotTotals(lot);
    if (!totals) return null;
    const band = densityBand(totals.densityKgM3, THRESHOLDS);
    return (
      <span className="flex items-center gap-1.5 whitespace-nowrap text-xs">
        <b>{totals.totalWeightKg}kg</b>
        <b>{totals.totalVolumeM3}m³</b>
        {band && totals.densityKgM3 !== null && (
          <span className={`rounded px-1.5 py-0.5 font-semibold ${DENSITY_COLORS[band]}`}>
            {Math.round(totals.densityKgM3)}
          </span>
        )}
      </span>
    );
  }

  return (
    <div className="space-y-3 pb-28">
      {/* --- Client --- */}
      <div className="card space-y-3 !p-3">
        <div className="flex gap-2">
          <select
            aria-label={t('warehouse')}
            className="input !w-28"
            value={draft.warehouseId}
            onChange={(e) => update({ warehouseId: e.target.value })}
          >
            {warehouses.map((wh) => (
              <option key={wh.id} value={wh.id}>
                {wh.code}
              </option>
            ))}
          </select>
          <div className="flex-1">
            {draft.clientId ? (
              <div className="flex min-h-12 items-center gap-2 rounded-lg bg-green-50 px-3">
                <span className="font-mono font-extrabold text-green-800">{draft.clientLabel}</span>
                <button
                  type="button"
                  aria-label={tc('cancel')}
                  className="ml-auto text-lg"
                  onClick={() => update({ clientId: null, clientLabel: '' })}
                >
                  ✕
                </button>
              </div>
            ) : (
              <input
                id="clientQuery"
                className="input font-mono uppercase"
                value={clientQuery}
                onChange={(e) => {
                  setClientQuery(e.target.value);
                  if (draft.unclaimed) update({ unclaimed: false });
                }}
                placeholder={t('clientCode')}
                autoComplete="off"
              />
            )}
            {clientHits.length > 0 && !draft.clientId && (
              <ul className="mt-1 divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
                {clientHits.map((hit) => (
                  <li key={hit.id}>
                    <button
                      type="button"
                      className="flex w-full items-baseline gap-2 p-3 text-left hover:bg-gray-50"
                      onClick={() => {
                        update({
                          clientId: hit.id,
                          clientLabel: `${hit.clientCode} — ${hit.name}`,
                          unclaimed: false,
                        });
                        setClientHits([]);
                        setClientQuery('');
                      }}
                    >
                      <span className="font-mono font-extrabold text-blue-800">{hit.clientCode}</span>
                      <span className="truncate">{hit.name}</span>
                      {hit.managerName && (
                        <span className="ml-auto whitespace-nowrap text-xs text-gray-500">
                          {hit.managerName}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {!draft.clientId && clientQuery.trim() && clientHits.length === 0 && (
          <button
            type="button"
            className={`w-full rounded-lg border-2 border-dashed p-3 text-sm font-semibold ${
              draft.unclaimed
                ? 'border-orange-500 bg-orange-50 text-orange-800'
                : 'border-gray-300 text-gray-600'
            }`}
            onClick={() =>
              update({ unclaimed: !draft.unclaimed, unclaimedMarking: clientQuery.toUpperCase() })
            }
          >
            ❓ {t('acceptUnclaimed')}
          </button>
        )}
        {draft.unclaimed && (
          <div>
            <label className="label" htmlFor="marking">
              {t('unclaimedMarking')}
            </label>
            <input
              id="marking"
              className="input font-mono uppercase"
              value={draft.unclaimedMarking}
              onChange={(e) => update({ unclaimedMarking: e.target.value.toUpperCase() })}
              placeholder="444"
            />
            <p className="mt-1 text-xs text-gray-500">{t('unclaimedMarkingHint')}</p>
          </div>
        )}
      </div>

      {/* --- Product lines: real spreadsheet table on desktop --- */}
      {letterPreview.length > 0 && (
        <p className="hidden text-sm text-gray-600 md:block">
          {t('letterPreview')}: ≈ <span className="font-mono font-bold">{letterPreview.join(', ')}</span>
        </p>
      )}
      <div className="hidden overflow-x-auto rounded-xl border border-gray-200 bg-white md:block">
        <table className="w-full min-w-[1100px] text-sm">
          <thead>
            <tr className="border-b border-gray-300 bg-gray-50 text-left">
              <th className="p-2">≈</th>
              <th className="p-2">{t('productZh')}</th>
              <th className="p-2">{t('productRu')}</th>
              <th className="p-2">📦</th>
              <th className="p-2">{t('dims')}</th>
              <th className="p-2">{t('note')}</th>
              <th className="p-2">{t('photos')}</th>
              <th className="p-2">Σ</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {draft.lots.map((lot, i) => (
              <tr key={lot.id} className="border-b border-gray-100 align-top">
                <td className="p-2 font-mono font-bold text-blue-800">{letterPreview[i] ?? `#${i + 1}`}</td>
                <td className="p-2">
                  <input
                    aria-label={t('productZh')}
                    className="input w-40"
                    value={lot.zh}
                    onChange={(e) => updateLot(lot.id, { zh: e.target.value, ru: '' })}
                    onBlur={() => translateLot(lot)}
                  />
                </td>
                <td className="p-2">
                  <input
                    aria-label={t('productRu')}
                    className="input w-40"
                    value={lot.ru}
                    onChange={(e) => updateLot(lot.id, { ru: e.target.value })}
                  />
                </td>
                <td className="p-2">
                  <div className="flex items-center gap-1">
                    <input
                      aria-label={t('boxCount')}
                      className="input !min-h-10 w-16 !px-2 text-center"
                      inputMode="numeric"
                      value={lot.boxCount}
                      onChange={(e) => updateLot(lot.id, { boxCount: e.target.value })}
                    />
                    <button
                      type="button"
                      className="rounded bg-gray-100 px-1.5 py-1 text-xs"
                      title={lot.dimsMode === 'uniform' ? t('uniform') : t('mixed')}
                      onClick={() =>
                        updateLot(lot.id, {
                          dimsMode: lot.dimsMode === 'uniform' ? 'mixed' : 'uniform',
                        })
                      }
                    >
                      ⇄
                    </button>
                  </div>
                </td>
                <td className="p-2">{dimsFields(lot, false)}</td>
                <td className="p-2">
                  <input
                    aria-label={t('note')}
                    className="input w-36"
                    value={lot.note}
                    onChange={(e) => updateLot(lot.id, { note: e.target.value })}
                    placeholder={t('notePlaceholder')}
                  />
                </td>
                <td className="p-2">{photosField(lot)}</td>
                <td className="p-2">{totalsBadge(lot)}</td>
                <td className="p-2">
                  {draft.lots.length > 1 && (
                    <button
                      type="button"
                      aria-label={tc('delete')}
                      className="text-lg"
                      onClick={() => update({ lots: draft.lots.filter((l) => l.id !== lot.id) })}
                    >
                      🗑
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          type="button"
          className="w-full border-t border-gray-200 p-2 text-sm font-semibold text-blue-800 hover:bg-gray-50"
          onClick={() => update({ lots: [...draft.lots, newLot()] })}
        >
          ＋ {t('addLot')}
        </button>
      </div>

      {/* --- Product lines: stacked cards on mobile --- */}
      <div id="mobile-product-lines" className="space-y-3 md:hidden">
        {letterPreview.length > 0 && (
          <p className="text-sm text-gray-600">
            {t('letterPreview')}: ≈{' '}
            <span className="font-mono font-bold">{letterPreview.join(', ')}</span>
          </p>
        )}
        {draft.lots.map((lot, i) => (
          <div key={lot.id} className="card space-y-2 !p-3">
            <div className="flex items-center gap-2">
              <span className="font-mono text-lg font-extrabold text-blue-800">
                {letterPreview[i] ? `≈${letterPreview[i]}` : `#${i + 1}`}
              </span>
              <input
                data-testid="lot-zh"
                aria-label={t('productZh')}
                className="input flex-1"
                value={lot.zh}
                onChange={(e) => updateLot(lot.id, { zh: e.target.value, ru: '' })}
                onBlur={() => translateLot(lot)}
                placeholder={t('productZh')}
              />
              {draft.lots.length > 1 && (
                <button
                  type="button"
                  aria-label={tc('delete')}
                  className="text-lg"
                  onClick={() => update({ lots: draft.lots.filter((l) => l.id !== lot.id) })}
                >
                  🗑
                </button>
              )}
            </div>
            <input
              aria-label={t('productRu')}
              className="input"
              value={lot.ru}
              onChange={(e) => updateLot(lot.id, { ru: e.target.value })}
              placeholder={t('productRu')}
            />
            <div className="flex items-center gap-2 text-sm">
              <span className="w-14 font-semibold">{t('boxCountShort')}</span>
              <input
                data-testid="lot-count"
                aria-label={t('boxCount')}
                className="input !min-h-10 flex-1 !px-2"
                inputMode="numeric"
                value={lot.boxCount}
                onChange={(e) => updateLot(lot.id, { boxCount: e.target.value })}
              />
              <button
                type="button"
                className="rounded-lg bg-gray-100 px-2 py-1.5 text-xs font-semibold"
                onClick={() =>
                  updateLot(lot.id, { dimsMode: lot.dimsMode === 'uniform' ? 'mixed' : 'uniform' })
                }
              >
                {lot.dimsMode === 'uniform' ? t('uniform') : t('mixed')} ⇄
              </button>
            </div>
            {dimsFields(lot, true)}
            <input
              data-testid="lot-note"
              aria-label={t('note')}
              className="input"
              value={lot.note}
              onChange={(e) => updateLot(lot.id, { note: e.target.value })}
              placeholder={t('notePlaceholder')}
            />
            <div className="flex items-center gap-2">
              {photosField(lot)}
              <span className="ml-auto">{totalsBadge(lot)}</span>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="btn-secondary w-full"
          onClick={() => update({ lots: [...draft.lots, newLot()] })}
        >
          ＋ {t('addLot')}
        </button>
      </div>

      {/* --- Attachments + costs + notes, all visible together --- */}
      <div className="card space-y-4 !p-3">
        <div>
          <label className="label" htmlFor="sourceNote">
            {t('sourceNote')}
          </label>
          <input
            id="sourceNote"
            className="input"
            value={draft.sourceNote}
            onChange={(e) => update({ sourceNote: e.target.value })}
          />
        </div>

        <div>
          <p className="label">{t('attachments')}</p>
          <AttachmentsPanel
            entityType="receipt"
            entityId={draft.receiptId}
            initial={draft.files}
            editable
            onAdd={(item) => update({ files: [...draft.files, item] })}
          />
        </div>

        <div>
          <p className="label">
            💰 {t('stepCosts')} {draft.costs.length > 0 && `(${draft.costs.length})`}
          </p>
          <div className="space-y-3">
            {draft.costs.map((cost, i) => (
              <div key={i} className="grid grid-cols-2 gap-2">
                <select
                  aria-label={t('costType')}
                  className="input col-span-2"
                  value={cost.costTypeId}
                  onChange={(e) => {
                    const costs = [...draft.costs];
                    costs[i] = { ...cost, costTypeId: e.target.value };
                    update({ costs });
                  }}
                >
                  <option value="">{t('costType')}…</option>
                  {costTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={t('amount')}
                  className="input"
                  inputMode="decimal"
                  placeholder={t('amount')}
                  value={cost.amount}
                  onChange={(e) => {
                    const costs = [...draft.costs];
                    costs[i] = { ...cost, amount: e.target.value };
                    update({ costs });
                  }}
                />
                <select
                  aria-label="currency"
                  className="input"
                  value={cost.currency}
                  onChange={(e) => {
                    const costs = [...draft.costs];
                    costs[i] = { ...cost, currency: e.target.value };
                    update({ costs });
                  }}
                >
                  {currencies.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
                <input
                  aria-label={t('note')}
                  className="input col-span-2"
                  placeholder={t('note')}
                  value={cost.note}
                  onChange={(e) => {
                    const costs = [...draft.costs];
                    costs[i] = { ...cost, note: e.target.value };
                    update({ costs });
                  }}
                />
              </div>
            ))}
            <button
              type="button"
              className="btn-secondary w-full"
              onClick={() =>
                update({
                  costs: [
                    ...draft.costs,
                    { costTypeId: '', amount: '', currency: defaultCurrency, note: '' },
                  ],
                })
              }
            >
              ＋ {t('addCost')}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm font-semibold text-red-800">
          {error === 'photo_required' ? t('photoRequired') : tc('error')} ({error})
        </p>
      )}

      {/* --- Sticky totals + confirm --- */}
      <div className="fixed inset-x-0 bottom-0 border-t border-gray-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center gap-3 p-3">
          <div className="text-sm font-bold leading-tight">
            Σ {sumBoxes} 📦
            <br />
            <span className="font-normal text-gray-600">
              {Math.round(sumKg * 1000) / 1000} kg · {Math.round(sumM3 * 10000) / 10000} m³
            </span>
          </div>
          <button
            type="button"
            data-testid="confirm-receipt"
            className="btn-primary flex-1 disabled:opacity-50"
            disabled={submitting || !clientChosen || !lotsValid()}
            onClick={confirm}
          >
            {submitting ? tc('loading') : `✅ ${t('confirm')}`}
          </button>
        </div>
      </div>
    </div>
  );
}
