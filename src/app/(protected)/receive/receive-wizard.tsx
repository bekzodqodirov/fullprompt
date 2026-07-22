'use client';

import imageCompression from 'browser-image-compression';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { computeLotTotals, densityBand } from '@/modules/wms/receipts/math';
import { submitReceiptAction, type SubmitReceiptResult } from './actions';

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
  ruSource: string;
  boxCount: string;
  dimsMode: 'uniform' | 'mixed';
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  boxWeightKg: string;
  totalWeightKg: string;
  totalVolumeM3: string;
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
  sourceNote: string;
  lots: LotDraft[];
  costs: CostDraft[];
  step: number;
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
    id: crypto.randomUUID(),
    zh: '',
    ru: '',
    ruSource: '',
    boxCount: '',
    dimsMode: 'uniform',
    lengthCm: '',
    widthCm: '',
    heightCm: '',
    boxWeightKg: '',
    totalWeightKg: '',
    totalVolumeM3: '',
    photoIds: [],
  };
}

function newDraft(warehouseId: string): Draft {
  return {
    receiptId: crypto.randomUUID(),
    warehouseId,
    clientId: null,
    clientLabel: '',
    unclaimed: false,
    sourceNote: '',
    lots: [newLot()],
    costs: [],
    step: 0,
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
  const uploadBusy = useRef(0);

  // --- Draft autosave: survives app kill / connection loss (spec 6.1).
  // localStorage is only readable on the client, hence the mount effect;
  // the single hydrating setState here is intentional.
  useEffect(() => {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved) {
      try {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setDraft(JSON.parse(saved) as Draft);
        return;
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

  // --- Client autocomplete ---
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

  // --- Letter preview ---
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
      const hit = (await res.json()) as { ru: string | null; source: string };
      if (hit.ru) updateLot(lot.id, { ru: hit.ru, ruSource: hit.source });
    }
  }

  async function addPhotos(lot: LotDraft, files: FileList | null) {
    if (!files?.length) return;
    uploadBusy.current += 1;
    try {
      for (const file of Array.from(files)) {
        const compressed = await imageCompression(file, {
          maxSizeMB: 0.3,
          maxWidthOrHeight: 1600,
          useWebWorker: true,
        });
        const formData = new FormData();
        formData.set('file', new File([compressed], file.name, { type: compressed.type }));
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
      }
    } finally {
      uploadBusy.current -= 1;
    }
  }

  function lotsValid(): boolean {
    return draft!.lots.every((lot) => {
      if (!lot.zh.trim() || !Number(lot.boxCount)) return false;
      if (lot.photoIds.length === 0) return false;
      return lotTotals(lot) !== null;
    });
  }

  async function confirm() {
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        receiptId: draft!.receiptId,
        warehouseId: draft!.warehouseId,
        clientId: draft!.unclaimed ? null : draft!.clientId,
        sourceNote: draft!.sourceNote,
        lots: draft!.lots.map((lot) => ({
          id: lot.id,
          productNameZh: lot.zh.trim(),
          productNameRu: lot.ru.trim(),
          boxCount: Number(lot.boxCount),
          dimsMode: lot.dimsMode,
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

  // --- Success screen: letters + print ---
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

  const steps = [t('stepClient'), t('stepLots'), t('stepCosts'), t('stepReview')];

  return (
    <div className="space-y-4 pb-24">
      {/* Step indicator */}
      <ol className="flex gap-1 text-xs font-semibold">
        {steps.map((label, i) => (
          <li
            key={label}
            className={`flex-1 rounded-md px-1 py-1.5 text-center ${
              i === draft.step
                ? 'bg-blue-700 text-white'
                : i < draft.step
                  ? 'bg-blue-100 text-blue-800'
                  : 'bg-gray-100 text-gray-500'
            }`}
          >
            {label}
          </li>
        ))}
      </ol>

      {/* STEP 0 — Warehouse + client */}
      {draft.step === 0 && (
        <div className="card space-y-4">
          <div>
            <label className="label" htmlFor="warehouse">
              {t('warehouse')}
            </label>
            <select
              id="warehouse"
              className="input"
              value={draft.warehouseId}
              onChange={(e) => update({ warehouseId: e.target.value })}
            >
              {warehouses.map((wh) => (
                <option key={wh.id} value={wh.id}>
                  {wh.code} — {wh.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="clientQuery">
              {t('clientCode')}
            </label>
            {draft.clientId ? (
              <div className="flex items-center gap-2 rounded-lg bg-green-50 p-3">
                <span className="font-mono text-lg font-extrabold text-green-800">
                  {draft.clientLabel}
                </span>
                <button
                  type="button"
                  className="btn-secondary !min-h-9 ml-auto px-2 text-sm"
                  onClick={() => update({ clientId: null, clientLabel: '' })}
                >
                  ✕
                </button>
              </div>
            ) : (
              <>
                <input
                  id="clientQuery"
                  className="input font-mono uppercase"
                  value={clientQuery}
                  onChange={(e) => {
                    setClientQuery(e.target.value);
                    update({ unclaimed: false });
                  }}
                  placeholder="GS777"
                  autoComplete="off"
                />
                {clientHits.length > 0 && (
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
                          <span className="font-mono font-extrabold text-blue-800">
                            {hit.clientCode}
                          </span>
                          <span>{hit.name}</span>
                          {hit.managerName && (
                            <span className="ml-auto text-xs text-gray-500">{hit.managerName}</span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {clientQuery.trim() && clientHits.length === 0 && (
                  <button
                    type="button"
                    className={`mt-2 w-full rounded-lg border-2 border-dashed p-3 text-sm font-semibold ${
                      draft.unclaimed
                        ? 'border-orange-500 bg-orange-50 text-orange-800'
                        : 'border-gray-300 text-gray-600'
                    }`}
                    onClick={() => update({ unclaimed: !draft.unclaimed })}
                  >
                    ❓ {t('acceptUnclaimed')}
                  </button>
                )}
              </>
            )}
          </div>
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
        </div>
      )}

      {/* STEP 1 — Lots */}
      {draft.step === 1 && (
        <div className="space-y-3">
          {letterPreview.length > 0 && (
            <p className="text-sm text-gray-600">
              {t('letterPreview')}: ≈{' '}
              <span className="font-mono font-bold">{letterPreview.join(', ')}</span>
            </p>
          )}
          {draft.lots.map((lot, i) => {
            const totals = lotTotals(lot);
            const band = totals ? densityBand(totals.densityKgM3, THRESHOLDS) : null;
            return (
              <div key={lot.id} className="card space-y-3">
                <div className="flex items-center">
                  <span className="font-mono text-lg font-extrabold text-blue-800">
                    {letterPreview[i] ? `≈ ${letterPreview[i]}` : `#${i + 1}`}
                  </span>
                  {draft.lots.length > 1 && (
                    <button
                      type="button"
                      className="btn-secondary !min-h-9 ml-auto px-2 text-sm"
                      onClick={() =>
                        update({ lots: draft.lots.filter((l) => l.id !== lot.id) })
                      }
                    >
                      🗑
                    </button>
                  )}
                </div>
                <div>
                  <label className="label">{t('productZh')}</label>
                  <input
                    className="input"
                    value={lot.zh}
                    onChange={(e) => updateLot(lot.id, { zh: e.target.value, ru: '', ruSource: '' })}
                    onBlur={() => translateLot(lot)}
                    placeholder="化妆品"
                  />
                  <input
                    className="input mt-1"
                    value={lot.ru}
                    onChange={(e) => updateLot(lot.id, { ru: e.target.value, ruSource: 'manual' })}
                    placeholder={t('productRu')}
                  />
                </div>
                <div>
                  <label className="label">{t('boxCount')}</label>
                  <input
                    className="input"
                    inputMode="numeric"
                    value={lot.boxCount}
                    onChange={(e) => updateLot(lot.id, { boxCount: e.target.value })}
                  />
                </div>
                <div className="flex gap-2 text-sm font-semibold">
                  <button
                    type="button"
                    className={`flex-1 rounded-lg p-2 ${lot.dimsMode === 'uniform' ? 'bg-blue-700 text-white' : 'bg-gray-100'}`}
                    onClick={() => updateLot(lot.id, { dimsMode: 'uniform' })}
                  >
                    {t('uniform')}
                  </button>
                  <button
                    type="button"
                    className={`flex-1 rounded-lg p-2 ${lot.dimsMode === 'mixed' ? 'bg-blue-700 text-white' : 'bg-gray-100'}`}
                    onClick={() => updateLot(lot.id, { dimsMode: 'mixed' })}
                  >
                    {t('mixed')}
                  </button>
                </div>
                {lot.dimsMode === 'uniform' ? (
                  <div className="grid grid-cols-4 gap-2">
                    {(
                      [
                        ['lengthCm', 'L'],
                        ['widthCm', 'W'],
                        ['heightCm', 'H'],
                        ['boxWeightKg', 'kg'],
                      ] as const
                    ).map(([field, label]) => (
                      <div key={field}>
                        <label className="label text-xs">{label}</label>
                        <input
                          className="input !px-2"
                          inputMode="decimal"
                          value={lot[field]}
                          onChange={(e) => updateLot(lot.id, { [field]: e.target.value })}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="label text-xs">{t('totalKg')}</label>
                      <input
                        className="input"
                        inputMode="decimal"
                        value={lot.totalWeightKg}
                        onChange={(e) => updateLot(lot.id, { totalWeightKg: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="label text-xs">{t('totalM3')}</label>
                      <input
                        className="input"
                        inputMode="decimal"
                        value={lot.totalVolumeM3}
                        onChange={(e) => updateLot(lot.id, { totalVolumeM3: e.target.value })}
                      />
                    </div>
                  </div>
                )}
                {totals && (
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <span>{totals.totalWeightKg} kg</span>
                    <span>{totals.totalVolumeM3} m³</span>
                    {band && totals.densityKgM3 !== null && (
                      <span className={`rounded px-2 py-0.5 font-semibold ${DENSITY_COLORS[band]}`}>
                        {Math.round(totals.densityKgM3)} kg/m³
                      </span>
                    )}
                    <span className="text-gray-500">
                      {t('chargeable')}: {totals.chargeableKg} kg
                    </span>
                  </p>
                )}
                <div>
                  <label className="label">
                    {t('photos')} ({lot.photoIds.length})
                  </label>
                  <div className="flex items-center gap-2">
                    <label className="btn-secondary cursor-pointer">
                      📷 {t('addPhoto')}
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
                        className="h-12 w-12 rounded object-cover"
                      />
                    ))}
                  </div>
                  {lot.photoIds.length === 0 && (
                    <p className="mt-1 text-xs font-semibold text-orange-600">{t('photoRequired')}</p>
                  )}
                </div>
              </div>
            );
          })}
          <button
            type="button"
            className="btn-secondary w-full"
            onClick={() => update({ lots: [...draft.lots, newLot()] })}
          >
            ＋ {t('addLot')}
          </button>
        </div>
      )}

      {/* STEP 2 — Extra costs */}
      {draft.step === 2 && (
        <div className="space-y-3">
          {draft.costs.map((cost, i) => (
            <div key={i} className="card grid grid-cols-2 gap-2">
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
          {draft.costs.length === 0 && (
            <p className="text-center text-sm text-gray-500">{t('costsOptional')}</p>
          )}
        </div>
      )}

      {/* STEP 3 — Review */}
      {draft.step === 3 && (
        <div className="card space-y-3">
          <p className="font-semibold">
            {warehouse?.code} →{' '}
            {draft.unclaimed ? `❓ ${t('unclaimedBadge')}` : draft.clientLabel || '—'}
          </p>
          {draft.lots.map((lot, i) => {
            const totals = lotTotals(lot);
            return (
              <div key={lot.id} className="border-t border-gray-100 pt-2 text-sm">
                <span className="font-mono font-bold text-blue-800">
                  {letterPreview[i] ? `≈${letterPreview[i]}` : `#${i + 1}`}
                </span>{' '}
                {lot.zh} {lot.ru && `(${lot.ru})`} — {lot.boxCount} 📦
                {totals && `, ${totals.totalWeightKg} kg, ${totals.totalVolumeM3} m³`}
                {lot.photoIds.length === 0 && (
                  <span className="ml-2 font-semibold text-red-600">⚠ {t('photoRequired')}</span>
                )}
              </div>
            );
          })}
          {(() => {
            const all = draft.lots.map(lotTotals);
            if (all.some((totals) => !totals)) return null;
            const sumKg = all.reduce((acc, totals) => acc + totals!.totalWeightKg, 0);
            const sumM3 = all.reduce((acc, totals) => acc + totals!.totalVolumeM3, 0);
            const sumBoxes = draft.lots.reduce((acc, lot) => acc + Number(lot.boxCount), 0);
            return (
              <p className="border-t border-gray-200 pt-2 font-bold">
                Σ {sumBoxes} 📦 · {Math.round(sumKg * 1000) / 1000} kg ·{' '}
                {Math.round(sumM3 * 10000) / 10000} m³
              </p>
            );
          })()}
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm font-semibold text-red-800">
          {error === 'photo_required' ? t('photoRequired') : tc('error')} ({error})
        </p>
      )}

      {/* Sticky nav buttons */}
      <div className="fixed inset-x-0 bottom-0 mx-auto flex max-w-lg gap-2 border-t border-gray-200 bg-white p-3">
        {draft.step > 0 && (
          <button
            type="button"
            className="btn-secondary flex-1"
            onClick={() => update({ step: draft.step - 1 })}
          >
            ← {tc('back')}
          </button>
        )}
        {draft.step < 3 ? (
          <button
            type="button"
            className="btn-primary flex-1 disabled:opacity-50"
            disabled={
              (draft.step === 0 && !draft.clientId && !draft.unclaimed) ||
              (draft.step === 1 && !lotsValid())
            }
            onClick={() => update({ step: draft.step + 1 })}
          >
            {t('next')} →
          </button>
        ) : (
          <button
            type="button"
            className="btn-primary flex-1 disabled:opacity-50"
            disabled={submitting || !lotsValid()}
            onClick={confirm}
          >
            {submitting ? tc('loading') : `✅ ${t('confirm')}`}
          </button>
        )}
      </div>
    </div>
  );
}
