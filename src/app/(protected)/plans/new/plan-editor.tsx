'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { LightboxImg } from '@/components/lightbox-img';
import { DensityBadge } from '@/components/density-badge';
import { submitPlanAction } from '../actions';
import { codeIdentity } from '@/modules/wms/labels/code-identity';
import { QrlessChip } from '@/components/qrless-chip';
import { LotCheckChip } from '@/components/lot-check-chip';
import { chipFace, inCheckFilter, type CheckFilter, type LotCheckState } from '@/modules/wms/receipts/lot-check-face';

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
  /** Null for a lot only on the road: it has stood here no days at all. */
  daysInStock: number | null;
  photoId: string | null;
  /** Which truck(s) brought it here, as printed (`arrivalLabel`: a batch's code, a factory trip's «ZR-… · factory · plate») — '' for a walk-in. */
  arrival: string;
  /** Of `available`, the QR-siz cartons (0112); absent in a snapshot cached before it. */
  qrless?: number;
  /**
   * «Yuk ma'lumoti tekshirildi» (0123). Optional: a snapshot the service
   * worker cached before it lacks it, and absent draws no chip — never ❓.
   */
  check?: LotCheckState;
  receiptId?: string;
  /**
   * Yo'ldagi yuk (docs/YOLDAGI-YUK.md §4): cartons of this lot on a truck bound
   * here, less what approved plans already owe — present only when the box is
   * ticked and the lot has any. A lot ONLY on the road has `available: 0`.
   */
  road?: { free: number; trucks: RoadTruckView[] };
}
interface RoadTruckView {
  code: string;
  state: 'gate' | 'road' | 'unknown';
  eta: string | null;
}
interface FactoryTripView {
  code: string;
  status: string;
  lines: { owner: string; goods: string; boxes: number }[];
}

/** What a row may take: the shelf, and the road's free part while the box is ticked. */
export function takeMax(lot: Pick<StockLot, 'available' | 'road'>, road: boolean): number {
  return lot.available + (road ? (lot.road?.free ?? 0) : 0);
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
  arrival: string;
  /** Its member lots and how many are checked / asked (0123); absent = no badge. */
  lotsTotal?: number;
  lotsChecked?: number;
  lotsAsked?: number;
}

/** A crate is ✅ only when every lot inside is; ❓ when one is asked here. */
function crateCheck(crate: StockCrate, askable: boolean): LotCheckState | undefined {
  if (crate.lotsTotal === undefined || crate.lotsChecked === undefined) return undefined;
  if (crate.lotsTotal > 0 && crate.lotsChecked === crate.lotsTotal) return 'checked';
  if (askable && (crate.lotsAsked ?? 0) > 0) return 'none';
  return undefined;
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
  initialRoad = false,
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
    /** The version has a road part — it reopens with the box ticked. */
    road?: boolean;
  };
  /** «🚚 Yo'ldagi yuklar ham» on at first: `?yol=1`, or a resubmit with a road part. */
  initialRoad?: boolean;
}) {
  const t = useTranslations('plans');
  const tc = useTranslations('common');
  const tq = useTranslations('qrsiz');
  const tlc = useTranslations('lotCheck');
  const chipLabels = { checked: tlc('chipChecked'), stale: tlc('chipStale'), none: tlc('chipNone') };
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
  /** The ❓ is asked at this origin (a Chinese warehouse). */
  const [askable, setAskable] = useState(false);
  /**
   * The check filter (docs/YUK-TEKSHIRUV.md §6) — RENDER-ONLY: it narrows
   * what the table and the crate list draw, never `lots`, the selection or
   * the Σ, so a ticked row that the filter hides is still counted and still
   * sent.
   */
  const [tek, setTek] = useState<CheckFilter | 'all'>('all');
  /** The list did not load — said, never drawn as an empty warehouse. */
  const [stockFailed, setStockFailed] = useState(false);
  /** The first answer for this origin has arrived (ok or failed) — before it, «loading», never «empty». */
  const [loaded, setLoaded] = useState(false);
  /** The check is on this server (0123 landed); its filter is drawn only then. */
  const [checksOn, setChecksOn] = useState(false);
  /** Picks a re-read found gone from the warehouse and took out — said once. */
  const [pruned, setPruned] = useState(0);
  /**
   * «🚚 Yo'ldagi yuklar ham» (docs/YOLDAGI-YUK.md §4): the road half is asked
   * for, merged into `lots`, and a row may take its free road part. `roadOn`
   * = this server has the road at all; the box is drawn only then.
   */
  const [road, setRoad] = useState(initialRoad);
  const [roadOn, setRoadOn] = useState(initialRoad);
  const [roadFailed, setRoadFailed] = useState(false);
  const [factoryTrips, setFactoryTrips] = useState<FactoryTripView[]>([]);
  /** Road picks the person's own untick took back — said, never silent. */
  const [roadDropped, setRoadDropped] = useState(0);
  /**
   * An untick waiting for the road-less answer: the picks are clamped against
   * THAT answer's shelf, never against the list on screen — which is empty
   * while a read is in flight and shelf-only when the road half failed, so the
   * untick used to take every pick with it (review editor#6).
   */
  const pendingUntick = useRef(false);
  /** «Qayta yuklash»: a read again with nothing changed. */
  const [reloadKey, setReloadKey] = useState(0);
  const [selection, setSelection] = useState<Map<string, number>>(
    () => new Map(resubmit?.lines.map((l) => [l.lotId, l.boxCount]) ?? []),
  );
  const [selectedCrates, setSelectedCrates] = useState<Set<string>>(
    () => new Set(resubmit?.crateIds ?? []),
  );
  // The picks as they stand NOW, for the re-read that fires from an event
  // listener (its closure holds the picks of the render that attached it).
  const picksRef = useRef({ selection, selectedCrates });
  useEffect(() => {
    picksRef.current = { selection, selectedCrates };
  }, [selection, selectedCrates]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorLot, setErrorLot] = useState<string | null>(null);

  useEffect(() => {
    // Origin changed: empty the table immediately (leaving the old origin's
    // rows visible invited counts typed into rows that were about to vanish)
    // and abort any in-flight fetch so a stale response can't overwrite.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLots([]);
    setStockCrates([]);
    setAskable(false);
    setStockFailed(false);
    setLoaded(false);
    setPruned(0);
    setRoadFailed(false);
    setFactoryTrips([]);
    const controller = new AbortController();
    /**
     * One read of this origin's list. `quiet` is the re-read when the tab
     * comes back into view (the ❓ chip opens the lot's card in a NEW tab,
     * so the tick happens elsewhere): the rows are replaced in place — the
     * selection is keyed by lot and stays — and a failed quiet read keeps
     * what is on screen rather than calling it a failure.
     */
    const load = async (quiet: boolean) => {
      // A deadline on the first read: a request that hangs (a Chinese
      // warehouse's network) is a list that did not load, said in words.
      // A plain timer and a per-call controller, not `AbortSignal.any` —
      // older iPhones have no such function and would never load the list.
      const call = new AbortController();
      const follow = () => call.abort();
      controller.signal.addEventListener('abort', follow);
      const timer = quiet ? null : setTimeout(() => call.abort(), 20_000);
      try {
        const res = await fetch(`/api/plans/stock?warehouseId=${originId}${road ? '&road=1' : ''}`, {
          signal: call.signal,
          // The re-read on return must not answer from before the tick.
          ...(quiet ? { cache: 'no-store' as const } : {}),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            lots: StockLot[];
            crates?: StockCrate[];
            askable?: boolean;
            checks?: boolean;
            roadOn?: boolean;
            roadFailed?: boolean;
            factoryTrips?: FactoryTripView[];
          };
          setLots(data.lots);
          setStockCrates(data.crates ?? []);
          setAskable(Boolean(data.askable));
          setChecksOn(Boolean(data.checks));
          setRoadOn(Boolean(data.roadOn));
          setRoadFailed(Boolean(data.roadFailed));
          setFactoryTrips(data.factoryTrips ?? []);
          setStockFailed(false);
          if (!road && pendingUntick.current) {
            // The person's untick, against the answer it asked for: every pick
            // back to its shelf part, road-only picks out — said in one line.
            pendingUntick.current = false;
            const shelf = new Map(data.lots.map((lot) => [lot.lotId, lot.available]));
            const kept = new Map<string, number>();
            let dropped = 0;
            for (const [lotId, count] of picksRef.current.selection) {
              const max = shelf.get(lotId) ?? 0;
              if (max <= 0) dropped += 1;
              else {
                if (count > max) dropped += 1;
                kept.set(lotId, Math.min(count, max));
              }
            }
            if (dropped > 0) setSelection(kept);
            setRoadDropped(dropped);
          }
          // A road half that did not come prunes nothing: a road pick is not
          // «gone» because its half of the answer failed.
          if (quiet && !data.roadFailed) {
            // A pick the warehouse no longer has (another plan reserved it,
            // it went into a crate) would be invisible, uncountable and
            // refused at submit — take it out and say so.
            const available = new Map(data.lots.map((lot) => [lot.lotId, takeMax(lot, road)]));
            const crateIds = new Set((data.crates ?? []).map((crate) => crate.crateId));
            const picks = picksRef.current;
            let gone = 0;
            let clamped = false;
            const nextSelection = new Map<string, number>();
            for (const [lotId, count] of picks.selection) {
              const max = available.get(lotId) ?? 0;
              if (max <= 0) gone += 1;
              else {
                if (count > max) clamped = true;
                nextSelection.set(lotId, Math.min(count, max));
              }
            }
            const nextCrates = new Set<string>();
            for (const crateId of picks.selectedCrates) {
              if (crateIds.has(crateId)) nextCrates.add(crateId);
              else gone += 1;
            }
            if (gone > 0 || clamped) setSelection(nextSelection);
            if (nextCrates.size !== picks.selectedCrates.size) setSelectedCrates(nextCrates);
            // A clamp is said like a prune (objection editor#0): a pick that
            // shrank by itself is a plan the person did not send.
            if (gone > 0 || clamped) setPruned((n) => n + gone + (clamped ? 1 : 0));
          }
        } else if (!quiet) {
          setStockFailed(true);
        }
      } catch {
        // An abort is the origin changing; anything else (offline, a body
        // that did not parse, the deadline) is a list that did not load —
        // said, never drawn as an empty warehouse.
        if (!controller.signal.aborted && !quiet) setStockFailed(true);
      } finally {
        if (timer) clearTimeout(timer);
        controller.signal.removeEventListener('abort', follow);
        if (!quiet && !controller.signal.aborted) setLoaded(true);
      }
    };
    void load(false);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      controller.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [originId, road, reloadKey]);

  /**
   * The person's own untick (never the initial state of a resubmit): the list
   * is read again without the road, and its answer clamps the picks (above).
   */
  function toggleRoad(next: boolean) {
    pendingUntick.current = !next;
    setRoadDropped(0);
    setRoad(next);
  }

  const preset = presets.find((p) => p.id === presetId);
  const shownLots = tek === 'all' ? lots : lots.filter((lot) => inCheckFilter(tek, lot.check, askable));
  const shownCrates =
    tek === 'all' ? stockCrates : stockCrates.filter((crate) => inCheckFilter(tek, crateCheck(crate, askable), askable));
  const checkCount = (value: CheckFilter) =>
    lots.filter((lot) => inCheckFilter(value, lot.check, askable)).length +
    stockCrates.filter((crate) => inCheckFilter(value, crateCheck(crate, askable), askable)).length;
  /** Ticked rows the filter is hiding — said, so nobody plans them twice. */
  const hiddenPicked =
    tek === 'all'
      ? 0
      : lots.filter((lot) => (selection.get(lot.lotId) ?? 0) > 0 && !shownLots.includes(lot)).length +
        stockCrates.filter((crate) => selectedCrates.has(crate.crateId) && !shownCrates.includes(crate)).length;
  /**
   * Picks the list on screen does not hold — a road pick whose half of the
   * answer failed, a lot that left the shelf before a resubmit opened. They
   * are in no row, no Σ and no gauge, yet the submit would send them: the
   * agent would get a heavier truck than anyone saw (review editor#7). Named,
   * and the submit waits until they are reloaded or taken out.
   */
  const unseen =
    loaded && !stockFailed
      ? [...selection.keys()].filter((lotId) => !lots.some((lot) => lot.lotId === lotId))
      : [];
  const totals = useMemo(() => {
    let boxes = 0;
    let kg = 0;
    let m3 = 0;
    let fromRoad = 0;
    for (const lot of lots) {
      const count = selection.get(lot.lotId) ?? 0;
      boxes += count;
      kg += count * lot.perBoxKg;
      m3 += count * lot.perBoxM3;
      fromRoad += Math.max(0, count - lot.available);
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
      fromRoad,
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
        road,
      });
      if (res.ok) router.push(`/plans/${res.planId}`);
      else {
        setError(res.error ?? 'error');
        // «Not enough» names the lot and what IS there (`lotId:free`).
        const [lotId, free] = (res.detail ?? '').split(':');
        const lot = lots.find((l) => l.lotId === lotId);
        setErrorLot(
          lot && free !== undefined
            ? `${codeIdentity(lot.marking, lot.clientCode).main}-${lot.letter} · ${free}`
            : null,
        );
      }
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

      {/* «Yuk ma'lumoti tekshirildi»: three filters, each naming how many
          rows it would show, on a line that wraps. Shown only when there is
          anything to choose between. */}
      {pruned > 0 && (
        <p role="status" className="text-xs font-semibold text-warn" data-testid="plan-picks-pruned">
          ⚠ {tlc('pruned', { n: pruned })}
        </p>
      )}

      {roadOn && (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm font-semibold" data-testid="plan-road-toggle">
            <input
              type="checkbox"
              data-testid="plan-road"
              className="h-5 w-5"
              checked={road}
              onChange={(e) => toggleRoad(e.target.checked)}
            />
            🚚 {t('roadToggle')}
          </label>
          {road && <p className="text-xs text-ink-500">{t('roadHint')}</p>}
          {roadDropped > 0 && (
            <p role="status" className="text-xs font-semibold text-warn" data-testid="plan-road-dropped">
              ⚠ {t('roadDropped', { n: roadDropped })}
            </p>
          )}
          {road && roadFailed && (
            <p role="alert" className="text-xs font-semibold text-bad" data-testid="plan-road-failed">
              {t('roadFailed')}
            </p>
          )}
        </div>
      )}

      {checksOn && lots.length + stockCrates.length > 0 && (
        <div className="space-y-1" data-testid="plan-check-filter">
          <div className="flex flex-wrap gap-2 text-sm">
            {(
              [
                { value: 'all' as const, testid: 'plan-check-filter-all', text: `${tlc('filterAll')} · ${lots.length + stockCrates.length}` },
                { value: 'ha' as const, testid: 'plan-check-filter-yes', text: `✅ ${tlc('filterChecked')} · ${checkCount('ha')}` },
                { value: 'yoq' as const, testid: 'plan-check-filter-no', text: `❓ ${tlc('filterUnchecked')} · ${checkCount('yoq')}` },
              ] as const
            ).map((door) => (
              <button
                key={door.value}
                type="button"
                data-testid={door.testid}
                aria-pressed={tek === door.value}
                onClick={() => setTek(door.value)}
                className={`rounded-lg border px-3 py-1.5 ${
                  tek === door.value
                    ? 'border-brand-500 bg-brand-50 font-semibold text-brand-700'
                    : 'border-line text-ink-700'
                }`}
              >
                {door.text}
              </button>
            ))}
          </div>
          {hiddenPicked > 0 && (
            <p className="text-xs font-semibold text-warn" data-testid="plan-check-hidden">
              ⚠ {tlc('hiddenPicked', { n: hiddenPicked })}
            </p>
          )}
        </div>
      )}

      {shownCrates.length > 0 && (
        <div className="card space-y-1 !p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            🧰 {t('cratesOnePlace')}
          </p>
          {shownCrates.map((crate) => {
            const on = selectedCrates.has(crate.crateId);
            const crateState = crateCheck(crate, askable);
            return (
              <button
                key={crate.crateId}
                type="button"
                data-testid={`crate-${crate.code}`}
                className={`flex w-full flex-wrap items-baseline gap-2 rounded-lg border-2 p-2 text-left text-sm ${
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
                <span className="font-mono font-extrabold text-brand-700">
                  {crate.code}
                  {crate.arrival && (
                    <span className="block font-sans text-2xs font-normal text-ink-500">
                      🚚 {crate.arrival}
                    </span>
                  )}
                </span>
                <span className="font-mono font-bold">{crate.clientCode ?? '?'}</span>
                <span className="text-ink-700">{crate.boxCount} 📦</span>
                {/* Plain text, never a link: the row is a <button>. */}
                {crateState === 'checked' && (
                  <span className="chip-good whitespace-nowrap" data-testid="crate-check" data-state="checked">
                    ✅
                  </span>
                )}
                {crateState === 'none' && (
                  <span className="chip-neutral whitespace-nowrap" data-testid="crate-check" data-state="none">
                    ❓ {crate.lotsAsked}/{crate.lotsTotal}
                  </span>
                )}
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
              {shownLots.map((lot) => {
                const count = selection.get(lot.lotId) ?? 0;
                // Yo'ldagi yuk: the road's free part, while the box is ticked.
                const roadFree = road ? (lot.road?.free ?? 0) : 0;
                const max = takeMax(lot, road);
                // Once boxes are ticked the row shows what you are TAKING,
                // not what is on the shelf: on a partial take the shelf
                // figure answers a question nobody asked. A lot only on the
                // road shows what the road holds, not «0».
                const shown = count > 0 ? count : lot.available > 0 ? lot.available : roadFree;
                const kg = lot.perBoxKg * shown;
                const m3 = lot.perBoxM3 * shown;
                const density = lot.perBoxM3 > 0 ? lot.perBoxKg / lot.perBoxM3 : null;
                const id = codeIdentity(lot.marking, lot.clientCode);
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
                      {id.main}-{lot.letter}
                      {id.sub && (
                        <span className="block font-sans text-2xs font-normal text-ink-500">
                          {id.sub}
                        </span>
                      )}
                      {/* The cell is nowrap for the code; a factory trip's
                          «ZR-… · factory · plate» wraps instead of widening
                          the table past a phone. */}
                      {lot.arrival && (
                        <span
                          className="block whitespace-normal font-sans text-2xs font-normal text-ink-500"
                          data-testid="lot-arrival"
                        >
                          🚚 {lot.arrival}
                        </span>
                      )}
                      {/* The road part, worded so it is never read as the
                          arrival line above: how many, on which truck, when. */}
                      {road && lot.road && lot.road.trucks.length > 0 && (
                        <span
                          className="block whitespace-normal font-sans text-2xs font-semibold text-brand-700"
                          data-testid="lot-road"
                        >
                          🚚 {t('roadLine', { n: lot.road.free })}{' '}
                          {lot.road.trucks
                            .map((truck) =>
                              truck.state === 'gate'
                                ? `${truck.code} · ${t('roadAtGate')}`
                                : truck.eta
                                  ? `${truck.code} · ${truck.eta}`
                                  : truck.code,
                            )
                            .join('; ')}
                        </span>
                      )}
                      {(lot.qrless ?? 0) > 0 && (
                        <span className="block">
                          <QrlessChip n={lot.qrless!} total={lot.available} label={tq('chip')} />
                        </span>
                      )}
                      {/* AFTER the code (the specs read the cell's first
                          token). A ❓ / ⚠ opens the lot's card in a NEW tab:
                          the ticks of this plan live only in this page. */}
                      {chipFace(lot.check, askable) && (
                        <span className="block">
                          <LotCheckChip
                            face={chipFace(lot.check, askable)}
                            labels={chipLabels}
                            href={
                              chipFace(lot.check, askable) !== 'checked' && lot.receiptId
                                ? `/receipts/${lot.receiptId}#lot-${lot.lotId}`
                                : undefined
                            }
                            newTab
                          />
                        </span>
                      )}
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
                          {/* «6/0» about a lot only on the road reads as an error. */}
                          {lot.available > 0 && <span className="text-ink-500">/{lot.available}</span>}
                        </span>
                      ) : (
                        lot.available
                      )}
                      {roadFree > 0 && (
                        <span className="block whitespace-nowrap text-2xs text-brand-700" data-testid="lot-road-free">
                          +{roadFree}🚚
                        </span>
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
                    <td className="p-2 text-right text-ink-500">{lot.daysInStock ?? '—'}</td>
                    <td className="p-1.5 text-center">
                      <div className="inline-flex items-center gap-1">
                        {/* ✓ keeps its meaning — the SHELF — so ticking the
                            box never quietly adds a road part to a lot taken
                            whole as before; «🚚» adds the road on purpose. */}
                        {lot.available > 0 && (
                          <button
                            type="button"
                            aria-label={`all-${lot.letter}`}
                            className={`rounded-md px-2 py-1.5 text-xs font-bold ${
                              count === lot.available
                                ? 'bg-brand-600 text-white'
                                : 'bg-surface-sunken text-ink-700'
                            }`}
                            onClick={() =>
                              setCount(lot.lotId, count === lot.available ? '0' : String(lot.available), max)
                            }
                          >
                            ✓
                          </button>
                        )}
                        {roadFree > 0 && (
                          <button
                            type="button"
                            aria-label={`road-${lot.letter}`}
                            data-testid={`take-road-${lot.letter}`}
                            className={`rounded-md px-2 py-1.5 text-xs font-bold ${
                              count === max ? 'bg-brand-600 text-white' : 'bg-surface-sunken text-ink-700'
                            }`}
                            onClick={() => setCount(lot.lotId, count === max ? String(lot.available) : String(max), max)}
                          >
                            🚚
                          </button>
                        )}
                        <input
                          data-testid={`take-${lot.letter}`}
                          aria-label={`take-${lot.letter}`}
                          className="input-cell !w-16 text-center"
                          inputMode="numeric"
                          value={count || ''}
                          placeholder="0"
                          onChange={(e) => setCount(lot.lotId, e.target.value, max)}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {stockFailed ? (
          <p role="alert" className="p-4 text-sm font-semibold text-bad" data-testid="plan-stock-failed">
            {t('stockFailed')}
          </p>
        ) : !loaded ? (
          <p className="p-4 text-sm text-ink-500" data-testid="plan-stock-loading">
            {tc('loading')}
          </p>
        ) : lots.length + stockCrates.length > 0 && shownLots.length + shownCrates.length === 0 ? (
          // An empty FILTER is not an empty warehouse — said in its own
          // words, counting the crates as well as the loose lots.
          <p className="p-4 text-sm text-ink-500" data-testid="plan-check-nomatch">
            {tlc('noMatch')}
          </p>
        ) : (
          // An empty warehouse is one with neither loose lots nor crates.
          lots.length === 0 &&
          stockCrates.length === 0 && <p className="p-4 text-sm text-ink-500">{t('noStock')}</p>
        )}
      </div>

      {/* Factory trips heading here (his 2a): shown, never planned — their
          cargo has no prixod and no carton until it is received here. */}
      {road && factoryTrips.length > 0 && (
        <details className="card !p-3 text-sm" data-testid="plan-factory-trips">
          <summary className="cursor-pointer font-semibold">
            🏭 {t('factoryTrips', { n: factoryTrips.length })}
          </summary>
          <ul className="mt-2 space-y-2">
            {factoryTrips.map((trip) => (
              <li key={trip.code}>
                <p className="font-mono font-bold">{trip.code}</p>
                {trip.lines.map((line, i) => (
                  <p key={i} className="text-xs text-ink-700">
                    {line.owner} · {line.goods} · {line.boxes} 📦
                  </p>
                ))}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-500">{t('factoryTripsHint')}</p>
        </details>
      )}

      {unseen.length > 0 && (
        <div role="alert" className="space-y-2 rounded-lg bg-warn/10 p-3 text-sm" data-testid="plan-unseen">
          <p className="font-semibold text-warn">⚠ {t('unseenPicks', { n: unseen.length })}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" onClick={() => setReloadKey((k) => k + 1)}>
              {tc('retry')}
            </button>
            <button
              type="button"
              className="btn-secondary"
              data-testid="plan-unseen-drop"
              onClick={() =>
                setSelection((prev) => {
                  const next = new Map(prev);
                  for (const lotId of unseen) next.delete(lotId);
                  return next;
                })
              }
            >
              {t('unseenDrop')}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-lg bg-bad/10 p-3 text-sm font-semibold text-bad">
          {t(`errors.${error}` as never) || tc('error')}
          {errorLot && <span className="block font-mono text-xs">{errorLot}</span>}
        </p>
      )}

      <div className="pb-safe fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface-raised shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
        <div className="mx-auto max-w-4xl space-y-2 px-4 py-2.5">
          <div className="flex items-center gap-4">
            <span className="whitespace-nowrap text-sm font-bold">
              Σ {totals.boxes} 📦
              {/* On its own line: at 360 px a wider Σ squeezes both gauges
                  until «60 kg / 24000 kg» breaks inside its number. */}
              {totals.fromRoad > 0 && (
                <span className="block text-2xs text-brand-700" data-testid="plan-total-road">
                  🚚 {totals.fromRoad}
                </span>
              )}
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
            disabled={submitting || totals.boxes === 0 || !destId || unseen.length > 0}
            onClick={submit}
          >
            {submitting ? tc('loading') : `📤 ${t('submitToAgent')}`}
          </button>
        </div>
      </div>
    </div>
  );
}
