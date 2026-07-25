'use client';

import { useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { DECOR_PATHS, LANDMARKS, toSvg, VIEWBOX } from '@/modules/wms/tracking/map-data';

export interface MapWarehouse {
  code: string;
  name: string;
  /** lon */
  x: number;
  /** lat */
  y: number;
  totalBoxes: number;
  stock: { clientCode: string; n: number }[];
}

export interface MapTruck {
  batchId: string;
  code: string;
  originCode: string;
  destCode: string;
  /** lon */
  x: number;
  /** lat */
  y: number;
  segKey: string;
  progress: number;
  overdue: boolean;
  remainingDays: [number, number];
  departedAt: string;
  checkpointKey: string | null;
  vehiclePlate: string | null;
  routePoints: { x: number; y: number }[];
  contents: { clientCode: string; n: number }[];
}

type Selected = { kind: 'wh'; code: string } | { kind: 'truck'; batchId: string } | null;

// Leaflet touches `window` at import time — client-only chunk.
const LeafletCorridor = dynamic(
  () => import('./leaflet-corridor').then((m) => m.LeafletCorridor),
  { ssr: false, loading: () => <div className="h-[420px] w-full animate-pulse rounded-xl bg-blue-50 md:h-[520px]" /> },
);

/**
 * Corridor map. With the self-hosted OSM basemap installed → real zoomable
 * map (Leaflet); without it → the built-in schematic SVG, same data.
 */
export function TrackingMap({
  warehouses,
  trucks,
  basemap,
}: {
  warehouses: MapWarehouse[];
  trucks: MapTruck[];
  basemap: boolean;
}) {
  const t = useTranslations('map');
  const [selected, setSelected] = useState<Selected>(null);

  const selWh = selected?.kind === 'wh' ? warehouses.find((w) => w.code === selected.code) : null;
  const selTruck =
    selected?.kind === 'truck' ? trucks.find((tr) => tr.batchId === selected.batchId) : null;

  return (
    <div className="space-y-3">
      {basemap ? (
        <div className="card !p-1.5">
          <LeafletCorridor warehouses={warehouses} trucks={trucks} onSelect={setSelected} />
        </div>
      ) : (
        <div className="card overflow-x-auto !p-2">
          <SvgCorridor warehouses={warehouses} trucks={trucks} onSelect={setSelected} label={t('title')} />
          <p className="px-1 pt-1 text-[11px] text-gray-400">{t('basemapMissing')}</p>
        </div>
      )}

      {selWh && (
        <div className="card space-y-1.5">
          <div className="flex items-baseline gap-2">
            <h2 className="text-lg font-bold">
              🏭 <span className="font-mono">{selWh.code}</span> — {selWh.name}
            </h2>
            <span className="text-sm font-semibold">{selWh.totalBoxes} 📦</span>
            <button type="button" className="ml-auto flex h-9 w-9 items-center justify-center" aria-label="close" onClick={() => setSelected(null)}>
              ✕
            </button>
          </div>
          {selWh.stock.length === 0 && <p className="text-sm text-gray-500">{t('emptyWh')}</p>}
          <div className="flex flex-wrap gap-1.5">
            {selWh.stock.map((s) => (
              <span key={s.clientCode} className="rounded-lg bg-blue-50 px-2 py-1 font-mono text-sm font-bold text-blue-800">
                {s.clientCode} · {s.n}
              </span>
            ))}
          </div>
          <Link href={`/stock?warehouse=${selWh.code}`} className="text-sm font-semibold text-blue-700 underline">
            {t('openStock')} →
          </Link>
        </div>
      )}

      {selTruck && (
        <div className="card space-y-1.5">
          <div className="flex items-baseline gap-2">
            <h2 className="text-lg font-bold">
              🚛 <span className="font-mono">{selTruck.code}</span>
            </h2>
            <span className="font-mono text-sm font-semibold">
              {selTruck.originCode} → {selTruck.destCode}
            </span>
            {selTruck.vehiclePlate && <span className="font-mono text-sm">{selTruck.vehiclePlate}</span>}
            <button type="button" className="ml-auto flex h-9 w-9 items-center justify-center" aria-label="close" onClick={() => setSelected(null)}>
              ✕
            </button>
          </div>
          <p className={`text-sm font-semibold ${selTruck.overdue ? 'text-red-700' : ''}`}>
            📍 {t(`seg_${selTruck.segKey}`)}
            {selTruck.overdue
              ? ` — ${t('overdue')}`
              : ` · ${t('eta', { min: selTruck.remainingDays[0], max: selTruck.remainingDays[1] })}`}
          </p>
          <div className="h-2 overflow-hidden rounded bg-gray-100">
            <div className="h-full rounded bg-blue-600" style={{ width: `${Math.round(selTruck.progress * 100)}%` }} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {selTruck.contents.map((c) => (
              <span key={c.clientCode} className="rounded-lg bg-amber-50 px-2 py-1 font-mono text-sm font-bold text-amber-800">
                {c.clientCode} · {c.n}
              </span>
            ))}
          </div>
          <Link href={`/batches/${selTruck.batchId}`} className="text-sm font-semibold text-blue-700 underline">
            {t('openBatch')} →
          </Link>
        </div>
      )}

      {trucks.length === 0 && <p className="text-sm text-gray-500">{t('noTrucks')}</p>}
    </div>
  );
}

/** Fallback schematic drawing (no basemap file yet) — projects lon/lat. */
function SvgCorridor({
  warehouses,
  trucks,
  onSelect,
  label,
}: {
  warehouses: MapWarehouse[];
  trucks: MapTruck[];
  onSelect: (sel: Exclude<Selected, null>) => void;
  label: string;
}) {
  return (
    <svg
      viewBox={`0 0 ${VIEWBOX.w} ${VIEWBOX.h}`}
      className="h-auto w-full min-w-[640px]"
      role="img"
      aria-label={label}
    >
      <rect width={VIEWBOX.w} height={VIEWBOX.h} fill="#eff6ff" />
      {DECOR_PATHS.map((d, i) => (
        <path key={i} d={d} fill="#dbeafe" stroke="#bfdbfe" strokeWidth={1.5} />
      ))}

      {trucks.map((tr) => (
        <polyline
          key={`route-${tr.batchId}`}
          points={tr.routePoints.map((p) => {
            const s = toSvg(p);
            return `${s.x},${s.y}`;
          }).join(' ')}
          fill="none"
          stroke="#93c5fd"
          strokeWidth={3}
          strokeDasharray="7 5"
          strokeLinecap="round"
        />
      ))}

      {LANDMARKS.map((lm) => {
        const s = toSvg(lm.p);
        return (
          <g key={lm.name}>
            <circle cx={s.x} cy={s.y} r={4} fill="#9ca3af" />
            <text x={s.x + 7} y={s.y + 4} fontSize={13} fill="#6b7280">
              {lm.name}
            </text>
          </g>
        );
      })}

      {warehouses.map((w) => {
        const s = toSvg({ x: w.x, y: w.y });
        return (
          <g key={w.code} className="cursor-pointer" onClick={() => onSelect({ kind: 'wh', code: w.code })}>
            <circle cx={s.x} cy={s.y} r={17} fill="#1d4ed8" opacity={0.12} />
            <text x={s.x} y={s.y + 7} fontSize={20} textAnchor="middle">
              🏭
            </text>
            <text x={s.x} y={s.y + 30} fontSize={14} fontWeight={800} textAnchor="middle" fill="#1e3a8a">
              {w.code}
            </text>
            {w.totalBoxes > 0 && (
              <g>
                <rect x={s.x + 8} y={s.y - 26} rx={8} width={Math.max(26, 12 + String(w.totalBoxes).length * 8)} height={17} fill="#1d4ed8" />
                <text x={s.x + 8 + Math.max(26, 12 + String(w.totalBoxes).length * 8) / 2} y={s.y - 13} fontSize={12} fontWeight={700} textAnchor="middle" fill="#fff">
                  {w.totalBoxes}
                </text>
              </g>
            )}
          </g>
        );
      })}

      {trucks.map((tr) => {
        const s = toSvg({ x: tr.x, y: tr.y });
        return (
          <g key={tr.batchId} className="cursor-pointer" onClick={() => onSelect({ kind: 'truck', batchId: tr.batchId })}>
            <circle cx={s.x} cy={s.y} r={15} fill={tr.overdue ? '#dc2626' : '#f59e0b'} opacity={0.25}>
              <animate attributeName="r" values="13;19;13" dur="2.2s" repeatCount="indefinite" />
            </circle>
            <text x={s.x} y={s.y + 7} fontSize={20} textAnchor="middle">
              🚛
            </text>
            <text x={s.x} y={s.y - 14} fontSize={12} fontWeight={800} textAnchor="middle" fill={tr.overdue ? '#b91c1c' : '#92400e'}>
              {tr.code}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
