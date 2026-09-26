'use client';

import { useState } from 'react';
import { graticule, toSvg } from '@/modules/wms/tracking/map-data';
import type { ClientLabels } from '@/modules/platform/telegram/client-labels';
import type { CabinetMapPlace } from '@/modules/wms/client-cabinet/map';

/**
 * «Yukim qayerda» — the client's own cargo on the corridor (item 11).
 *
 * Drawn as SVG on the corridor's own projection (`tracking/map-data.ts`), the
 * same one the staff map's schematic uses — no tiles, no third-party host,
 * so it opens in Yiwu and Kashgar the same as in Tashkent (#664's lesson: a
 * dependency that fetches itself from a CDN is unreachable exactly where the
 * cargo is). Framed on THIS client's places, not the whole corridor: at
 * 360 px the whole of China leaves a truck the size of a full stop.
 *
 * A tap on a truck or a warehouse lists what of theirs is there. Nothing on
 * this screen names another customer or the truck's code (`cabinetMap`).
 */
/**
 * The corridor's cities, for bearings only — a map of dots on a grid is not
 * a map anybody can read. Approximate, labels and nothing else, in the order
 * they win a crowded corner: the western end packs four towns into a thumb's
 * width, so a label that would sit on another label or on a marker is left
 * out rather than printed through it. No Urumqi — the road does not go there
 * (round 109), and a name on the map reads as a place the cargo passes.
 */
const CITIES: { name: string; x: number; y: number }[] = [
  { name: 'Toshkent', x: 69.24, y: 41.31 },
  { name: 'Qashg‘ar', x: 75.98, y: 39.47 },
  { name: 'Yiwu', x: 120.07, y: 29.31 },
  { name: 'Guangzhou', x: 113.26, y: 23.13 },
  { name: 'Andijon', x: 72.34, y: 40.78 },
  { name: 'Osh', x: 72.8, y: 40.53 },
  { name: 'Irkeshtam', x: 73.95, y: 39.68 },
  { name: 'Lanzhou', x: 103.83, y: 36.06 },
  { name: 'Xi’an', x: 108.94, y: 34.34 },
];

export function CabinetMap({
  places,
  t,
  goodsName,
}: {
  places: CabinetMapPlace[];
  t: ClientLabels;
  goodsName: (lot: CabinetMapPlace['lots'][number]) => string;
}) {
  const [picked, setPicked] = useState<string | null>(places[0]?.key ?? null);
  if (places.length === 0) return <p className="cab-empty">{t.mapEmpty}</p>;

  // The frame: every place and every truck's road, with air around them and
  // never tighter than a few hundred kilometres, so one warehouse alone is
  // still a place on a map and not a dot on a blank page.
  const pts = places.flatMap((p) => [toSvg({ x: p.x, y: p.y }), ...p.route.map((r) => toSvg(r))]);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const MIN = 120;
  let [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  if (x1 - x0 < MIN) [x0, x1] = [(x0 + x1) / 2 - MIN / 2, (x0 + x1) / 2 + MIN / 2];
  if (y1 - y0 < MIN * 0.75) [y0, y1] = [(y0 + y1) / 2 - MIN * 0.375, (y0 + y1) / 2 + MIN * 0.375];
  const pad = Math.max(x1 - x0, y1 - y0) * 0.15;
  const view = { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  const unit = view.w / 360; // one CSS pixel at a 360-wide phone
  const grid = graticule();
  const selected = places.find((p) => p.key === picked) ?? null;

  // Greedy placement: markers claim their room first, then each city in
  // CITIES' order takes its label box only if the box is free.
  const taken = places.map((p) => {
    const s = toSvg({ x: p.x, y: p.y });
    return { x0: s.x - unit * 20, x1: s.x + unit * 36, y0: s.y - unit * 26, y1: s.y + unit * 18 };
  });
  const cities = CITIES.flatMap((c) => {
    const s = toSvg(c);
    const box = {
      x0: s.x - unit * 3,
      x1: s.x + unit * (6 + c.name.length * 6),
      y0: s.y - unit * 14,
      y1: s.y + unit * 3,
    };
    const clash = taken.some((b) => box.x0 < b.x1 && b.x0 < box.x1 && box.y0 < b.y1 && b.y0 < box.y1);
    if (clash) return [];
    taken.push(box);
    return [{ ...c, s }];
  });
  const line = (route: { x: number; y: number }[]) =>
    route
      .map((r) => {
        const s = toSvg(r);
        return `${s.x},${s.y}`;
      })
      .join(' ');

  return (
    <div className="cab-map" data-testid="cab-map">
      <svg
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        className="cab-map-svg"
        // The drawing's own proportions, capped by the stylesheet — no grey
        // bands above and below a wide corridor on a tall phone.
        style={{ aspectRatio: `${view.w} / ${view.h}` }}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={t.mapTitle}
      >
        <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="var(--card)" />
        {[...grid.meridians, ...grid.parallels].map((g, i) => (
          <line key={i} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke="var(--line)" strokeWidth={unit} />
        ))}
        {places
          .filter((p) => p.kind === 'truck' && p.route.length > 1)
          .map((p) => (
            <polyline
              key={`r-${p.key}`}
              points={line(p.route)}
              fill="none"
              stroke="var(--st-in_transit)"
              strokeWidth={unit * 2.5}
              strokeDasharray={`${unit * 6} ${unit * 4}`}
              strokeLinecap="round"
              opacity={0.7}
            />
          ))}
        {cities.map(({ name, s }) => {
          return (
            <g key={name}>
              <circle cx={s.x} cy={s.y} r={unit * 2} fill="var(--muted)" opacity={0.7} />
              <text x={s.x + unit * 4} y={s.y - unit * 4} fontSize={unit * 10} fill="var(--muted)">
                {name}
              </text>
            </g>
          );
        })}
        {places.map((p) => {
          const s = toSvg({ x: p.x, y: p.y });
          const r = unit * 15;
          const on = p.key === picked;
          const fill = p.kind === 'truck' ? 'var(--st-in_transit)' : 'var(--accent)';
          return (
            <g
              key={p.key}
              role="button"
              tabIndex={0}
              onClick={() => setPicked(p.key)}
              // The picked marker's own ring is the focus mark; the browser's
              // rectangle around an SVG group reads as a rendering fault.
              style={{ cursor: 'pointer', outline: 'none' }}
              data-testid={`cab-map-${p.kind}`}
            >
              {/* A generous invisible target: the marker is the thumb, not the icon. */}
              <circle cx={s.x} cy={s.y} r={r * 1.8} fill="transparent" />
              <circle
                cx={s.x}
                cy={s.y}
                r={r}
                fill={fill}
                stroke={on ? 'var(--fg)' : 'var(--bg)'}
                strokeWidth={unit * (on ? 3 : 2)}
              />
              <text x={s.x} y={s.y + unit * 5} fontSize={unit * 14} textAnchor="middle">
                {p.kind === 'truck' ? '🚚' : '🏭'}
              </text>
              <g>
                <rect
                  x={s.x + r * 0.5}
                  y={s.y - r * 1.45}
                  rx={unit * 7}
                  width={unit * (10 + String(p.boxes).length * 7)}
                  height={unit * 15}
                  fill="var(--bg)"
                  stroke={fill}
                  strokeWidth={unit * 1.5}
                />
                <text
                  x={s.x + r * 0.5 + unit * (5 + String(p.boxes).length * 3.5)}
                  y={s.y - r * 1.45 + unit * 11}
                  fontSize={unit * 11}
                  fontWeight={700}
                  textAnchor="middle"
                  fill="var(--fg)"
                >
                  {p.boxes}
                </text>
              </g>
            </g>
          );
        })}
      </svg>

      <div className="cab-map-sheet" data-testid="cab-map-sheet">
        {selected ? (
          <>
            <p className="cab-map-where">
              {selected.kind === 'truck' ? `🚚 ${t.mapTruck}` : `🏭 ${t.mapWarehouse}`} · {selected.name}
            </p>
            {selected.kind === 'truck' && (
              <p className="cab-map-note">
                {selected.live ? t.mapLive : t.mapEstimated}
                {selected.remainingDays &&
                  ` · ${t.mapDays
                    .replace('{a}', String(selected.remainingDays[0]))
                    .replace('{b}', String(selected.remainingDays[1]))}`}
              </p>
            )}
            <p className="cab-map-sum">
              <b>{selected.boxes}</b> {t.totalBoxes} · <b>{selected.kg}</b> {t.kg} · <b>{selected.m3}</b> {t.m3}
            </p>
            <ul className="cab-map-lots">
              {selected.lots.map((lot) => (
                <li key={lot.lotId}>
                  <span>
                    {lot.letter ? `${lot.letter} · ` : ''}
                    {goodsName(lot)}
                  </span>
                  <span className="cab-map-lot-num">
                    {lot.boxes} · {lot.kg} {t.kg} · {lot.m3} {t.m3}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="cab-map-note">{t.mapTapHint}</p>
        )}
      </div>
    </div>
  );
}
