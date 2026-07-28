'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { graticule, LANDMARKS, toSvg, VIEWBOX } from '@/modules/wms/tracking/map-data';
import { Icon } from '@/components/ui/icon';

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
  /** True when the dot is a fresh fix from the driver's phone, not the estimate. */
  live: boolean;
  fixAgeMinutes: number | null;
  fixSource: string | null;
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
  {
    ssr: false,
    loading: () => <div className="h-[420px] w-full animate-pulse rounded-xl bg-brand-50 md:h-[520px]" />,
  },
);

/**
 * Corridor map. With the self-hosted OSM basemap installed → real zoomable
 * map (Leaflet); without it → the built-in schematic SVG, same data.
 *
 * Owner's round: the map fills the whole screen on request, the drawing is in
 * true proportion (map-data.ts), and a warehouse can never be mistaken for a
 * truck — they are different shapes in different colours, not two emoji.
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
  const [full, setFull] = useState(false);

  // Escape leaves fullscreen — the button is under the map's own controls
  // once it covers the screen, and a phone's back gesture is not reliable.
  useEffect(() => {
    if (!full) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFull(false);
    };
    window.addEventListener('keydown', onKey);
    // The page behind must not scroll under a fullscreen map.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [full]);

  // The driver app reports every 2-3 hours, so a raw minute count reads as
  // "185 daqiqa oldin" — switch to hours once that is the honest unit.
  const ago = (minutes: number) =>
    minutes < 90 ? t('agoMin', { n: minutes }) : t('agoHour', { n: Math.round(minutes / 60) });

  const selWh = selected?.kind === 'wh' ? warehouses.find((w) => w.code === selected.code) : null;
  const selTruck =
    selected?.kind === 'truck' ? trucks.find((tr) => tr.batchId === selected.batchId) : null;

  const canvas = (
    <div className="relative h-full w-full">
      {basemap ? (
        <LeafletCorridor
          warehouses={warehouses}
          trucks={trucks}
          onSelect={setSelected}
          full={full}
        />
      ) : (
        <div className="h-full w-full overflow-auto">
          <SvgCorridor
            warehouses={warehouses}
            trucks={trucks}
            onSelect={setSelected}
            label={t('title')}
            full={full}
          />
        </div>
      )}

      <button
        type="button"
        data-testid="map-fullscreen"
        aria-label={full ? t('exitFull') : t('goFull')}
        onClick={() => setFull((value) => !value)}
        className="absolute right-2 top-2 z-[500] flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface-raised text-ink-700 shadow-card"
      >
        <Icon name={full ? 'x' : 'maximize'} className="h-5 w-5" />
      </button>

      {/* Which mark is which — the owner could not tell a warehouse from a
          truck at a glance, so the key says it in the same shapes. */}
      <div
        data-testid="map-legend"
        className="pointer-events-none absolute bottom-2 left-2 z-[500] flex gap-2 rounded-xl border border-line bg-surface-raised/90 px-2.5 py-1.5 text-xs font-semibold shadow-card backdrop-blur">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-[3px] bg-brand-700" />
          {t('legendWarehouse')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full bg-warn" />
          {t('legendTruck')}
        </span>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      {full ? (
        <div className="fixed inset-0 z-50 bg-surface">{canvas}</div>
      ) : (
        <div className="card h-[420px] overflow-hidden !p-0 md:h-[560px]">{canvas}</div>
      )}
      {!basemap && !full && <p className="text-[11px] text-ink-400">{t('basemapMissing')}</p>}

      {selWh && (
        <div className="card space-y-1.5">
          <div className="flex items-baseline gap-2">
            <h2 className="text-lg font-bold">
              <span className="mr-1.5 inline-block h-3 w-3 rounded-[3px] bg-brand-700 align-middle" />
              <span className="font-mono">{selWh.code}</span> — {selWh.name}
            </h2>
            <span className="text-sm font-semibold">{selWh.totalBoxes} 📦</span>
            <button
              type="button"
              className="ml-auto flex h-9 w-9 items-center justify-center"
              aria-label="close"
              onClick={() => setSelected(null)}
            >
              ✕
            </button>
          </div>
          {selWh.stock.length === 0 && <p className="text-sm text-ink-500">{t('emptyWh')}</p>}
          <div className="flex flex-wrap gap-1.5">
            {selWh.stock.map((s) => (
              <span
                key={s.clientCode}
                className="rounded-lg bg-brand-50 px-2 py-1 font-mono text-sm font-bold text-brand-700"
              >
                {s.clientCode} · {s.n}
              </span>
            ))}
          </div>
          <Link href={`/stock?warehouse=${selWh.code}`} className="text-sm font-semibold text-brand-700 underline">
            {t('openStock')} →
          </Link>
        </div>
      )}

      {selTruck && (
        <div className="card space-y-1.5">
          <div className="flex items-baseline gap-2">
            <h2 className="text-lg font-bold">
              <span className="mr-1.5 inline-block h-3 w-3 rounded-full bg-warn align-middle" />
              <span className="font-mono">{selTruck.code}</span>
            </h2>
            <span className="font-mono text-sm font-semibold">
              {selTruck.originCode} → {selTruck.destCode}
            </span>
            {selTruck.vehiclePlate && <span className="font-mono text-sm">{selTruck.vehiclePlate}</span>}
            <button
              type="button"
              className="ml-auto flex h-9 w-9 items-center justify-center"
              aria-label="close"
              onClick={() => setSelected(null)}
            >
              ✕
            </button>
          </div>
          <p className="text-sm font-semibold">
            {selTruck.live
              ? `🟢 ${t('liveFix', { ago: ago(selTruck.fixAgeMinutes ?? 0) })}`
              : `🟡 ${t('estimated')}${selTruck.fixAgeMinutes !== null ? ` · ${t('lastFix', { ago: ago(selTruck.fixAgeMinutes) })}` : ''}`}
          </p>
          <p className={`text-sm font-semibold ${selTruck.overdue ? 'text-bad' : ''}`}>
            📍 {t(`seg_${selTruck.segKey}`)}
            {selTruck.overdue
              ? ` — ${t('overdue')}`
              : ` · ${t('eta', { min: selTruck.remainingDays[0], max: selTruck.remainingDays[1] })}`}
          </p>
          <div className="h-2 overflow-hidden rounded bg-surface-sunken">
            <div
              className="h-full rounded bg-brand-600"
              style={{ width: `${Math.round(selTruck.progress * 100)}%` }}
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {selTruck.contents.map((c) => (
              <span
                key={c.clientCode}
                className="rounded-lg bg-warn/10 px-2 py-1 font-mono text-sm font-bold text-warn"
              >
                {c.clientCode} · {c.n}
              </span>
            ))}
          </div>
          <Link href={`/batches/${selTruck.batchId}`} className="text-sm font-semibold text-brand-700 underline">
            {t('openBatch')} →
          </Link>
        </div>
      )}

      {trucks.length === 0 && !full && <p className="text-sm text-ink-500">{t('noTrucks')}</p>}
    </div>
  );
}

/**
 * Fallback schematic drawing (no basemap file yet).
 *
 * Marks are SVG, not emoji: a warehouse is a blue rounded SQUARE and a truck
 * an amber CIRCLE, so the two can be told apart at a glance and at any size —
 * 🏭 and 🚛 were two similar-looking blobs, and on the Chinese phones in the
 * warehouses they were sometimes empty boxes (DECISIONS #137).
 */
function SvgCorridor({
  warehouses,
  trucks,
  onSelect,
  label,
  full,
}: {
  warehouses: MapWarehouse[];
  trucks: MapTruck[];
  onSelect: (sel: Exclude<Selected, null>) => void;
  label: string;
  full: boolean;
}) {
  const grid = graticule();
  return (
    <svg
      viewBox={`0 0 ${VIEWBOX.w} ${VIEWBOX.h}`}
      className={full ? 'h-full w-full' : 'h-full w-full min-w-[720px]'}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={label}
    >
      <rect width={VIEWBOX.w} height={VIEWBOX.h} className="fill-brand-50" />

      {/* The projection, drawn. Every 10° of longitude is the same width and
          in true ratio to every 5° of latitude. */}
      {grid.meridians.map((line) => (
        <g key={`m-${line.label}`}>
          <line {...lineProps(line)} className="stroke-line-strong" strokeWidth={1} opacity={0.5} />
          <text x={line.lx} y={line.ly} fontSize={11} className="fill-ink-400">
            {line.label}
          </text>
        </g>
      ))}
      {grid.parallels.map((line) => (
        <g key={`p-${line.label}`}>
          <line {...lineProps(line)} className="stroke-line-strong" strokeWidth={1} opacity={0.5} />
          <text x={line.lx} y={line.ly} fontSize={11} className="fill-ink-400">
            {line.label}
          </text>
        </g>
      ))}

      {trucks.map((tr) => (
        <polyline
          key={`route-${tr.batchId}`}
          points={tr.routePoints
            .map((p) => {
              const s = toSvg(p);
              return `${s.x},${s.y}`;
            })
            .join(' ')}
          fill="none"
          // brand-500, because there is no brand-400: the scale is
          // 50/100/200/500/600/700/800, and the missing shade left this
          // polyline with no stroke at all — the route line never drew.
          className="stroke-brand-500"
          strokeWidth={3}
          strokeDasharray="8 6"
          strokeLinecap="round"
        />
      ))}

      {LANDMARKS.map((lm) => {
        const s = toSvg(lm.p);
        return (
          <g key={lm.name}>
            <circle cx={s.x} cy={s.y} r={3} className="fill-ink-400" />
            <text x={s.x + 6} y={s.y + 4} fontSize={12} className="fill-ink-500">
              {lm.name}
            </text>
          </g>
        );
      })}

      {warehouses.map((w) => {
        const s = toSvg({ x: w.x, y: w.y });
        return (
          <g
            key={w.code}
            className="cursor-pointer"
            data-testid="map-warehouse"
            onClick={() => onSelect({ kind: 'wh', code: w.code })}
          >
            <rect
              x={s.x - 11}
              y={s.y - 11}
              width={22}
              height={22}
              rx={5}
              className="fill-brand-700"
              stroke="#fff"
              strokeWidth={2}
            />
            {/* A roof line — enough to read as a building at 22 px. */}
            <path
              d={`M ${s.x - 6} ${s.y + 4} L ${s.x - 6} ${s.y - 3} L ${s.x} ${s.y - 7} L ${s.x + 6} ${s.y - 3} L ${s.x + 6} ${s.y + 4} Z`}
              fill="#fff"
              opacity={0.9}
            />
            <text
              x={s.x}
              y={s.y + 26}
              fontSize={13}
              fontWeight={800}
              textAnchor="middle"
              className="fill-brand-800"
              stroke="#fff"
              strokeWidth={3}
              paintOrder="stroke"
            >
              {w.code}
            </text>
            {w.totalBoxes > 0 && (
              <>
                <circle cx={s.x + 12} cy={s.y - 12} r={9} className="fill-brand-800" stroke="#fff" strokeWidth={1.5} />
                <text
                  x={s.x + 12}
                  y={s.y - 8}
                  fontSize={10}
                  fontWeight={700}
                  textAnchor="middle"
                  fill="#fff"
                >
                  {w.totalBoxes}
                </text>
              </>
            )}
          </g>
        );
      })}

      {trucks.map((tr) => {
        const s = toSvg({ x: tr.x, y: tr.y });
        return (
          <g
            key={tr.batchId}
            className="cursor-pointer"
            data-testid="map-truck"
            onClick={() => onSelect({ kind: 'truck', batchId: tr.batchId })}
          >
            <circle cx={s.x} cy={s.y} r={13} className={tr.overdue ? 'fill-bad' : 'fill-warn'} opacity={0.25}>
              <animate attributeName="r" values="12;18;12" dur="2.2s" repeatCount="indefinite" />
            </circle>
            <circle
              cx={s.x}
              cy={s.y}
              r={10}
              className={tr.overdue ? 'fill-bad' : 'fill-warn'}
              stroke="#fff"
              strokeWidth={2}
            />
            {/* A box on wheels: two circles under a rectangle. */}
            <rect x={s.x - 5} y={s.y - 5} width={10} height={6} rx={1.5} fill="#fff" />
            <circle cx={s.x - 3} cy={s.y + 3} r={1.8} fill="#fff" />
            <circle cx={s.x + 3} cy={s.y + 3} r={1.8} fill="#fff" />
            <text
              x={s.x}
              y={s.y - 15}
              fontSize={12}
              fontWeight={800}
              textAnchor="middle"
              className={tr.overdue ? 'fill-bad' : 'fill-warn'}
              stroke="#fff"
              strokeWidth={3}
              paintOrder="stroke"
            >
              {tr.code}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const lineProps = (line: { x1: number; y1: number; x2: number; y2: number }) => ({
  x1: line.x1,
  y1: line.y1,
  x2: line.x2,
  y2: line.y2,
});
