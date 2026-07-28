'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { LightboxImg } from '@/components/lightbox-img';
import { DensityBadge } from '@/components/density-badge';
import { submitPlanAction } from '../actions';

interface WarehouseOption {
  id: string;
  code: string;
}
interface PresetOption {
  id: string;
  name: string;
  maxKg: number;
  maxM3: number;
}
interface StockLot {
  lotId: string;
  letter: string | null;
  productNameZh: string;
  productNameRu: string | null;
  clientCode: string | null;
  marking: string | null;
  available: number;
  perBoxKg: number;
  perBoxM3: number;
  daysInStock: number;
  photoId: string | null;
}
interface StockCrate {
  crateId: string;
  code: string;
  kind: string;
  clientCode: string | null;
  boxCount: number;
  kg: number;
  m3: number;
  daysInStock: number;
}

/**
 * W3 plan editor: pick origin/dest + truck, tick lots (partial counts OK),
 * watch the live kg/m³ gauges — over capacity turns red but never blocks
 * (spec 6.3). Submit → version to the agent.
 */
export function PlanEditor({
  warehouses,
  destinations,
  presets,
  densityThresholds,
  resubmit,
}: {
  /** Where this planner may load FROM — their own warehouses. */
  warehouses: WarehouseOption[];
  /** Where cargo may be sent — everywhere. */
  destinations: WarehouseOption[];
  presets: PresetOption[];
  /** From admin settings — the owner's numbers, not a constant of ours. */
  densityThresholds: { light: number; medium: number; heavy: number };
  resubmit?: {
    planId: string;
    originWarehouseId: string;
    destWarehouseId: string;
    truckPresetId: string | null;
    lines: { lotId: string; boxCount: number }[];
    crateIds: string[];
  };
}) {
  const t = useTranslations('plans');
  const tc = useTranslations('common');
  const router = useRouter();
  const [originId, setOriginId] = useState(resubmit?.originWarehouseId ?? warehouses[0]?.id ?? '');
  const [destId, setDestId] = useState(
    resubmit?.destWarehouseId ??
      destinations.find((wh) => wh.id !== (resubmit?.originWarehouseId ?? warehouses[0]?.id))?.id ??
      '',
  );
  const [presetId, setPresetId] = useState(resubmit?.truckPresetId ?? presets[0]?.id ?? '');
  const [lots, setLots] = useState<StockLot[]>([]);
  const [stockCrates, setStockCrates] = useState<StockCrate[]>([]);
  const [selection, setSelection] = useState<Map<string, number>>(
    () => new Map(resubmit?.lines.map((l) => [l.lotId, l.boxCount]) ?? []),
  );
  const [selectedCrates, setSelectedCrates] = useState<Set<string>>(
    () => new Set(resubmit?.crateIds ?? []),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Origin changed: empty the table immediately (leaving the old origin's
    // rows visible invited counts typed into rows that were about to vanish)
    // and abort any in-flight fetch so a stale response can't overwrite.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLots([]);
    setStockCrates([]);
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`/api/plans/stock?warehouseId=${originId}`, {
          signal: controller.signal,
        });
        if (res.ok) {
          const data = (await res.json()) as { lots: StockLot[]; crates?: StockCrate[] };
          setLots(data.lots);
          setStockCrates(data.crates ?? []);
        }
      } catch {
        /* aborted */
      }
    })();
    return () => controller.abort();
  }, [originId]);

  const preset = presets.find((p) => p.id === presetId);
  const totals = useMemo(() => {
    let boxes = 0;
    let kg = 0;
    let m3 = 0;
    for (const lot of lots) {
      const count = selection.get(lot.lotId) ?? 0;
      boxes += count;
      kg += count * lot.perBoxKg;
      m3 += count * lot.perBoxM3;
    }
    // A crate is ONE place: its boxes ride inside, so places = loose boxes
    // + selected crates while boxes/kg/m³ still count everything.
    let places = boxes;
    for (const crate of stockCrates) {
      if (!selectedCrates.has(crate.crateId)) continue;
      boxes += crate.boxCount;
      kg += crate.kg;
      m3 += crate.m3;
      places += 1;
    }
    return {
      boxes,
      places,
      kg: Math.round(kg * 10) / 10,
      m3: Math.round(m3 * 1000) / 1000,
      density: m3 > 0 ? Math.round(kg / m3) : null,
    };
  }, [lots, stockCrates, selection, selectedCrates]);

  function setCount(lotId: string, raw: string, max: number) {
    const n = Math.max(0, Math.min(max, Number(raw) || 0));
    setSelection((prev) => {
      const next = new Map(prev);
      if (n === 0) next.delete(lotId);
      else next.set(lotId, n);
      return next;
    });
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await submitPlanAction({
        planId: resubmit?.planId,
        originWarehouseId: originId,
        destWarehouseId: destId,
        truckPresetId: presetId || undefined,
        lines: [...selection.entries()].map(([lotId, boxCount]) => ({ lotId, boxCount })),
        crateIds: [...selectedCrates],
      });
      if (res.ok) router.push(`/plans/${res.planId}`);
      else setError(res.error ?? 'error');
    } finally {
      setSubmitting(false);
    }
  }

  const gauge = (value: number, max: number | undefined, unit: string) => {
    const pct = max ? Math.min(150, (value / max) * 100) : 0;
    const over = max ? value > max : false;
    return (
      <div className="min-w-0 flex-1">
        <div className="flex justify-between text-[11px] font-semibold">
          <span>
            {value} {unit}
          </span>
          {max ? (
            <span className={over ? 'text-bad' : 'text-ink-500'}>
              / {max} {unit}
            </span>
          ) : null}
        </div>
        {max ? (
          <div className="h-2 overflow-hidden rounded bg-surface-sunken">
            <div
              className={`h-full ${over ? 'bg-red-600' : 'bg-brand-600'}`}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-3 pb-28">
      <div className="card flex flex-wrap items-center gap-2 !p-3">
        <select
          data-testid="plan-origin"
          aria-label={t('origin')}
          className="input !w-24 shrink-0 font-mono font-bold"
          value={originId}
          onChange={(e) => setOriginId(e.target.value)}
          disabled={!!resubmit}
        >
          {warehouses.map((wh) => (
            <option key={wh.id} value={wh.id}>
              {wh.code}
            </option>
          ))}
        </select>
        <span className="font-bold">→</span>
        <select
          data-testid="plan-dest"
          aria-label={t('dest')}
          className="input !w-24 shrink-0 font-mono font-bold"
          value={destId}
          onChange={(e) => setDestId(e.target.value)}
          disabled={!!resubmit}
        >
          {destinations
            .filter((wh) => wh.id !== originId)
            .map((wh) => (
              <option key={wh.id} value={wh.id}>
                {wh.code}
              </option>
            ))}
        </select>
        <select
          aria-label={t('truck')}
          className="input min-w-0 flex-1"
          value={presetId}
          onChange={(e) => setPresetId(e.target.value)}
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <a
          href="/admin/trucks"
          aria-label={t('manageTrucks')}
          title={t('manageTrucks')}
          className="btn-secondary !min-h-10 shrink-0 px-3"
        >
          ⚙️
        </a>
      </div>

      {stockCrates.length > 0 && (
        <div className="card space-y-1 !p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            🧰 {t('cratesOnePlace')}
          </p>
          {stockCrates.map((crate) => {
            const on = selectedCrates.has(crate.crateId);
            return (
              <button
                key={crate.crateId}
                type="button"
                data-testid={`crate-${crate.code}`}
                className={`flex w-full items-baseline gap-2 rounded-lg border-2 p-2 text-left text-sm ${
                  on ? 'border-brand-500 bg-brand-50' : 'border-line'
                }`}
                onClick={() =>
                  setSelectedCrates((prev) => {
                    const next = new Set(prev);
                    if (next.has(crate.crateId)) next.delete(crate.crateId);
                    else next.add(crate.crateId);
                    return next;
                  })
                }
              >
                <span className="font-bold">{on ? '☑' : '☐'}</span>
                <span className="font-mono font-extrabold text-brand-700">{crate.code}</span>
                <span className="font-mono font-bold">{crate.clientCode ?? '?'}</span>
                <span className="text-ink-700">{crate.boxCount} 📦</span>
                <span className="ml-auto whitespace-nowrap font-mono text-xs">
                  {crate.kg}kg {crate.m3}m³
                </span>
                <span className="whitespace-nowrap text-xs text-ink-500">
                  = 1 {t('place')}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm" id="plan-stock-table">
            <thead>
              <tr className="border-b border-line-strong bg-surface-sunken text-left text-xs uppercase tracking-wide text-ink-500">
                <th className="p-2">📷</th>
                <th className="p-2">{t('code')}</th>
                <th className="p-2">{t('product')}</th>
                <th className="p-2 text-right">📦</th>
                {/* The same numbers, in the same order, as the stock table
                    (owner: "plan berayotganda kg/m³ ko'rinib tursin, sklad
                    ostatkaga o'xshab") — you plan by weight and volume, so
                    the figures have to be on the row you are ticking. */}
                <th className="p-2 text-right">kg/📦</th>
                <th className="p-2 text-right">Σ kg</th>
                <th className="p-2 text-right">m³</th>
                <th className="p-2 text-right">kg/m³</th>
                <th className="p-2 text-right">{t('days')}</th>
                <th className="p-2 text-center">{t('take')}</th>
              </tr>
            </thead>
            <tbody>
              {lots.map((lot) => {
                const count = selection.get(lot.lotId) ?? 0;
                // Once boxes are ticked the row shows what you are TAKING,
                // not what is on the shelf: on a partial take the shelf
                // figure answers a question nobody asked.
                const shown = count > 0 ? count : lot.available;
                const kg = lot.perBoxKg * shown;
                const m3 = lot.perBoxM3 * shown;
                const density = lot.perBoxM3 > 0 ? lot.perBoxKg / lot.perBoxM3 : null;
                return (
                  <tr
                    key={lot.lotId}
                    className={`border-b border-line ${count > 0 ? 'bg-brand-50' : ''}`}
                  >
                    <td className="p-1.5">
                      {lot.photoId ? (
                        <LightboxImg attachmentId={lot.photoId} className="h-10 w-10 rounded object-cover" />
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap p-2 font-mono font-extrabold text-brand-700">
                      {lot.clientCode ?? lot.marking ?? '?'}-{lot.letter}
                    </td>
                    <td className="max-w-44 truncate p-2">
                      {lot.productNameZh}
                      {lot.productNameRu && (
                        <span className="text-ink-500"> ({lot.productNameRu})</span>
                      )}
                    </td>
                    <td className="p-2 text-right font-semibold">
                      {count > 0 ? (
                        <span className="text-brand-700">
                          {count}
                          <span className="text-ink-500">/{lot.available}</span>
                        </span>
                      ) : (
                        lot.available
                      )}
                    </td>
                    <td className="p-2 text-right">{Math.round(lot.perBoxKg * 10) / 10}</td>
                    <td
                      className={`p-2 text-right font-semibold ${count > 0 ? 'text-brand-700' : ''}`}
                    >
                      {Math.round(kg)}
                    </td>
                    <td className={`p-2 text-right ${count > 0 ? 'text-brand-700' : ''}`}>
                      {Math.round(m3 * 100) / 100}
                    </td>
                    <td className="p-2 text-right">
                      <DensityBadge density={density} thresholds={densityThresholds} />
                    </td>
                    <td className="p-2 text-right text-ink-500">{lot.daysInStock}</td>
                    <td className="p-1.5 text-center">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          aria-label={`all-${lot.letter}`}
                          className={`rounded-md px-2 py-1.5 text-xs font-bold ${
                            count === lot.available
                              ? 'bg-brand-600 text-white'
                              : 'bg-surface-sunken text-ink-700'
                          }`}
                          onClick={() =>
                            setCount(lot.lotId, count === lot.available ? '0' : String(lot.available), lot.available)
                          }
                        >
                          ✓
                        </button>
                        <input
                          data-testid={`take-${lot.letter}`}
                          aria-label={`take-${lot.letter}`}
                          className="input-cell !w-16 text-center"
                          inputMode="numeric"
                          value={count || ''}
                          placeholder="0"
                          onChange={(e) => setCount(lot.lotId, e.target.value, lot.available)}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {lots.length === 0 && <p className="p-4 text-sm text-ink-500">{t('noStock')}</p>}
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-bad/10 p-3 text-sm font-semibold text-bad">
          {t(`errors.${error}` as never) || tc('error')}
        </p>
      )}

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface-raised shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
        <div className="mx-auto max-w-4xl space-y-2 px-4 py-2.5">
          <div className="flex items-center gap-4">
            <span className="whitespace-nowrap text-sm font-bold">
              Σ {totals.boxes} 📦
              {totals.places !== totals.boxes && (
                <span className="text-ink-700"> · {totals.places} {t('place')}</span>
              )}
            </span>
            {gauge(totals.kg, preset ? preset.maxKg : undefined, 'kg')}
            {gauge(totals.m3, preset ? preset.maxM3 : undefined, 'm³')}
            {totals.density !== null && (
              <span
                className="whitespace-nowrap font-mono text-xs font-bold text-ink-700"
                title={t('avgDensity')}
              >
                Ø {totals.density} kg/m³
              </span>
            )}
          </div>
          <button
            type="button"
            data-testid="submit-plan"
            className="btn-primary w-full disabled:opacity-50"
            disabled={submitting || totals.boxes === 0 || !destId}
            onClick={submit}
          >
            {submitting ? tc('loading') : `📤 ${t('submitToAgent')}`}
          </button>
        </div>
      </div>
    </div>
  );
}
