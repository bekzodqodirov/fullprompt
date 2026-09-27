'use client';

import { useEffect, useRef, useState } from 'react';
import type * as Leaflet from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { boxWord, type ClientLabels } from '@/modules/platform/telegram/client-labels';
import { groupDigits } from '@/modules/platform/telegram/format';
import type { CabinetMapPlace } from '@/modules/wms/client-cabinet/map';

/**
 * «Yukim qayerda» — the client's own cargo on a REAL map (item 11, rebuilt
 * after his first look: «scrol qilganda map katta kichik bolish orniga pastga
 * scrol bolib ketyabti va mapni ozi ham korinmadi yukni ustiga bosganda
 * malumotlar korinmadi»).
 *
 * The first version was an SVG on the corridor's projection: a picture, not a
 * map. A pinch scrolled the page, there was no land under the dots, and a tap
 * on a 30-px circle in a 300-px drawing missed as often as it hit. This is
 * Leaflet — the staff map's engine — so a pinch zooms and a drag pans, over
 * the SAME self-hosted OSM extract (`/api/basemap`, our own origin, so it
 * loads in Kashgar as fast as the page does, #664). Without that file on the
 * server the map still zooms and pans, over a plain field with the corridor's
 * cities named.
 *
 * Under the map is the LIST of every place, and it is the answer: a tap on a
 * marker opens that place's row, and a place with no coordinates is still a
 * row — the first version dropped it, and cargo in an unplotted warehouse
 * vanished from the screen that exists to show where it is. Nothing here
 * names another customer or a truck's code (`cabinetMap`).
 */

/** Bearings for the no-basemap field. No Urumqi: the road does not go there. */
const CITIES: { name: string; x: number; y: number }[] = [
  { name: 'Toshkent', x: 69.24, y: 41.31 },
  { name: 'Andijon', x: 72.34, y: 40.78 },
  { name: 'Osh', x: 72.8, y: 40.53 },
  { name: 'Qashg‘ar', x: 75.98, y: 39.47 },
  { name: 'Lanzhou', x: 103.83, y: 36.06 },
  { name: 'Xi’an', x: 108.94, y: 34.34 },
  { name: 'Yiwu', x: 120.07, y: 29.31 },
  { name: 'Guangzhou', x: 113.26, y: 23.13 },
];

const WAREHOUSE = '#1d4ed8';
const TRUCK = '#f59e0b';

/** The staff map's two shapes (#137): a warehouse is a square, a truck a lorry. */
function markerHtml(p: CabinetMapPlace, on: boolean): string {
  const ring = on ? 'box-shadow:0 0 0 3px #fff,0 0 0 6px #111827;border-radius:8px;' : '';
  const shape =
    p.kind === 'warehouse'
      ? `<svg width="30" height="30" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="24" height="24" rx="6" fill="${WAREHOUSE}" stroke="#fff" stroke-width="2"/><path d="M7 18 L7 11 L13 7 L19 11 L19 18 Z" fill="#fff" opacity="0.92"/></svg>`
      : `<svg width="40" height="30" viewBox="0 0 38 28" xmlns="http://www.w3.org/2000/svg"><path d="M35 5 H17 V11 H12 L6 17 V22 H35 Z" fill="${TRUCK}" stroke="#fff" stroke-width="3" paint-order="stroke" stroke-linejoin="round"/><circle cx="13" cy="22" r="3.6" fill="#1f2937" stroke="#fff" stroke-width="1.6"/><circle cx="29" cy="22" r="3.6" fill="#1f2937" stroke="#fff" stroke-width="1.6"/></svg>`;
  const badge = `<span style="position:absolute;top:-8px;right:-10px;background:#111827;color:#fff;border:1.5px solid #fff;border-radius:10px;padding:0 5px;font:700 11px/16px system-ui,sans-serif">${p.boxes}</span>`;
  return `<div data-testid="cab-map-marker-${p.kind}" style="position:relative;display:inline-block;line-height:0;${ring}">${shape}${badge}</div>`;
}

export function CabinetMap({
  places,
  t,
  locale = null,
  goodsName,
  basemap = false,
  dark = false,
}: {
  places: CabinetMapPlace[];
  t: ClientLabels;
  /** For counting boxes in the customer's own grammar (`boxWord`). */
  locale?: string | null;
  goodsName: (lot: CabinetMapPlace['lots'][number]) => string;
  basemap?: boolean;
  /** Telegram's night theme: a white street map in a dark app is a torch in the face. */
  dark?: boolean;
}) {
  const [picked, setPicked] = useState<string | null>(places[0]?.key ?? null);
  const canvas = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const markers = useRef(new Map<string, Leaflet.Marker>());
  const rows = useRef(new Map<string, HTMLLIElement>());
  const libRef = useRef<typeof Leaflet | null>(null);

  // The map mounts once per data set. Leaflet touches `window` at import, so
  // it is loaded here and never on the server.
  useEffect(() => {
    let cancelled = false;
    let map: Leaflet.Map | null = null;
    void (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled || !canvas.current) return;
      libRef.current = L;
      // One finger pans, two fingers zoom — Leaflet owns every touch on the
      // canvas (`touch-action: none`), so the page underneath never moves.
      map = L.map(canvas.current, {
        zoomControl: true,
        attributionControl: basemap,
        minZoom: 3,
        maxZoom: 12,
      });
      mapRef.current = map;

      if (basemap) {
        const { leafletLayer } = await import('protomaps-leaflet');
        if (cancelled) return;
        leafletLayer({
          url: '/api/basemap/corridor.pmtiles',
          // The installed basemaps package ships a `dark` flavour; the rest of
          // the screen already follows Telegram's theme through its variables.
          flavor: dark ? 'dark' : 'light',
          lang: 'ru',
          maxDataZoom: 8,
          attribution: '© OpenStreetMap',
        }).addTo(map);
      } else {
        // The city names live in their own pane UNDER the markers and take no
        // taps: the first draft used Leaflet tooltips, whose pane is above the
        // markers, and three names in the western corner buried the truck.
        const pane = map.createPane('cities');
        pane.style.zIndex = '350';
        pane.style.pointerEvents = 'none';
        for (const c of CITIES) {
          L.marker([c.y, c.x], {
            pane: 'cities',
            interactive: false,
            keyboard: false,
            icon: L.divIcon({
              className: '',
              html: `<span class="cab-map-city"><i></i>${c.name}</span>`,
              iconSize: [0, 0],
              iconAnchor: [3, 3],
            }),
          }).addTo(map);
        }
      }

      const bounds: [number, number][] = [];
      for (const p of places) {
        if (p.kind === 'truck' && p.route.length > 1) {
          L.polyline(
            p.route.map((r) => [r.y, r.x] as [number, number]),
            { color: '#3b82f6', weight: 3, dashArray: '7 6', opacity: 0.7 },
          ).addTo(map);
          for (const r of p.route) bounds.push([r.y, r.x]);
        }
        if (!p.point) continue;
        bounds.push([p.point.y, p.point.x]);
        const marker = L.marker([p.point.y, p.point.x], {
          icon: L.divIcon({
            className: '',
            html: markerHtml(p, p.key === places[0]?.key),
            iconSize: p.kind === 'truck' ? [40, 30] : [30, 30],
            iconAnchor: p.kind === 'truck' ? [20, 15] : [15, 15],
          }),
          zIndexOffset: p.kind === 'truck' ? 1000 : 0,
          keyboard: true,
        })
          .addTo(map)
          .on('click', () => {
            setPicked(p.key);
            rows.current.get(p.key)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          });
        markers.current.set(p.key, marker);
      }
      if (bounds.length) {
        map.fitBounds(L.latLngBounds(bounds), { padding: [36, 36], maxZoom: 9 });
      } else {
        map.fitBounds([[20, 60], [47, 125]]);
      }
    })();
    return () => {
      cancelled = true;
      markers.current = new Map();
      map?.remove();
      mapRef.current = null;
    };
  }, [places, basemap, dark]);

  // The picked place wears a ring; every other marker is redrawn plain.
  useEffect(() => {
    const L = libRef.current;
    if (!L) return;
    for (const p of places) {
      const m = markers.current.get(p.key);
      if (!m) continue;
      m.setIcon(
        L.divIcon({
          className: '',
          html: markerHtml(p, p.key === picked),
          iconSize: p.kind === 'truck' ? [40, 30] : [30, 30],
          iconAnchor: p.kind === 'truck' ? [20, 15] : [15, 15],
        }),
      );
    }
  }, [picked, places]);

  if (places.length === 0) return <p className="cab-empty">{t.mapEmpty}</p>;

  const pick = (p: CabinetMapPlace) => {
    setPicked(p.key === picked ? null : p.key);
    if (p.point && mapRef.current) {
      mapRef.current.setView([p.point.y, p.point.x], Math.max(mapRef.current.getZoom(), 6), { animate: true });
    }
  };

  return (
    <div className="cab-map" data-testid="cab-map">
      <div ref={canvas} className="cab-map-canvas" data-testid="cab-map-canvas" />
      <div className="cab-map-sheet" data-testid="cab-map-sheet">
        <p className="cab-map-note">{t.mapTapHint}</p>
        <ul className="cab-map-places">
          {places.map((p) => {
            const on = p.key === picked;
            return (
              <li
                key={p.key}
                ref={(el) => {
                  if (el) rows.current.set(p.key, el);
                  else rows.current.delete(p.key);
                }}
              >
                <button
                  type="button"
                  className={`cab-map-place${on ? ' on' : ''}`}
                  data-testid={`cab-map-${p.kind}`}
                  aria-expanded={on}
                  onClick={() => pick(p)}
                >
                  <span className="cab-map-place-icon" aria-hidden>
                    {p.kind === 'truck' ? '🚚' : '🏭'}
                  </span>
                  <span className="cab-map-place-body">
                    <b>
                      {p.kind === 'truck' ? t.mapTruck : t.mapWarehouse} · {p.name}
                    </b>
                    <span className="cab-map-place-sum">
                      {groupDigits(p.boxes)} {boxWord(p.boxes, locale)} · {groupDigits(p.kg)} {t.kg} ·{' '}
                      {groupDigits(p.m3)} {t.m3}
                    </span>
                  </span>
                  <span className="cab-map-chevron" aria-hidden>
                    {on ? '▾' : '▸'}
                  </span>
                </button>
                {on && (
                  <div className="cab-map-detail">
                    {p.kind === 'truck' && (
                      <p className="cab-map-note">
                        {p.live ? t.mapLive : t.mapEstimated}
                        {p.remainingDays &&
                          ` · ${t.mapDays
                            .replace('{a}', String(p.remainingDays[0]))
                            .replace('{b}', String(p.remainingDays[1]))}`}
                      </p>
                    )}
                    {!p.point && <p className="cab-map-note">⚠ {t.mapNoPoint}</p>}
                    <ul className="cab-map-lots">
                      {p.lots.map((lot) => (
                        <li key={lot.lotId}>
                          <span>
                            {lot.letter ? `${lot.letter} · ` : ''}
                            {goodsName(lot)}
                          </span>
                          <span className="cab-map-lot-num">
                            {groupDigits(lot.boxes)} · {groupDigits(lot.kg)} {t.kg} · {groupDigits(lot.m3)} {t.m3}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
