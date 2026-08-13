'use client';

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { leafletLayer } from 'protomaps-leaflet';
import 'leaflet/dist/leaflet.css';
import { MAP_BOUNDS } from '@/modules/wms/tracking/map-data';
import type { MapTruck, MapWarehouse } from './tracking-map';

/**
 * Real zoomable map (owner's ask). The basemap is a self-hosted OSM extract
 * (PMTiles) served from OUR origin — no Yandex/Baidu/Google at runtime, so
 * it loads in China exactly as fast as the site itself.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The two marks, drawn as SVG rather than emoji.
 *
 * A warehouse is a blue rounded SQUARE with a roof; a truck is an amber
 * CIRCLE with a box on wheels. Shape carries the difference, so they are
 * still distinguishable when they sit on top of each other, when the map is
 * zoomed out, and on the Chinese phones where 🏭 and 🚛 rendered as two
 * near-identical blobs (DECISIONS #137).
 */
const warehouseSvg = `
<svg width="26" height="26" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg">
  <rect x="1" y="1" width="24" height="24" rx="6" fill="#1d4ed8" stroke="#fff" stroke-width="2"/>
  <path d="M7 18 L7 11 L13 7 L19 11 L19 18 Z" fill="#fff" opacity="0.92"/>
</svg>`;

// A clearer lorry (round 98, owner: «mapdagi mashinalar conka bo'lib partiyalar
// yaxshiroq ko'rinishi kerak»): a coloured rounded badge with a white cab-and-
// trailer silhouette, bigger than the old 26px dot so a truck on the corridor
// reads as a truck at a glance. Still a distinct SHAPE from the warehouse
// square, so the two stay apart when they overlap (DECISIONS #137).
const truckSvg = (color: string) => `
<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
  <rect x="1.5" y="1.5" width="29" height="29" rx="9" fill="${color}" stroke="#fff" stroke-width="2.5"/>
  <g fill="#fff">
    <rect x="6" y="12" width="12" height="8" rx="1"/>
    <path d="M18 14 h4.5 l3 3 v3 H18 Z"/>
    <circle cx="10" cy="21.5" r="2.3" fill="${color}" stroke="#fff" stroke-width="1.6"/>
    <circle cx="22" cy="21.5" r="2.3" fill="${color}" stroke="#fff" stroke-width="1.6"/>
  </g>
</svg>`;

export function LeafletCorridor({
  warehouses,
  trucks,
  onSelect,
  full,
}: {
  warehouses: MapWarehouse[];
  trucks: MapTruck[];
  onSelect: (sel: { kind: 'wh'; code: string } | { kind: 'truck'; batchId: string }) => void;
  /** Fullscreen changes the container size behind Leaflet's back. */
  full?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const overlayRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: true,
      minZoom: 3,
      maxZoom: 12,
    });
    mapRef.current = map;
    map.fitBounds(MAP_BOUNDS, { padding: [8, 8] });

    const basemap = leafletLayer({
      url: '/api/basemap/corridor.pmtiles',
      flavor: 'light',
      lang: 'ru',
      maxDataZoom: 8,
      attribution: '© OpenStreetMap',
    });
    basemap.addTo(map);
    // The overlays live in ONE group so the refresh effect below can clear
    // and redraw them without touching the basemap or the viewport (round
    // 100, 9a — the page refreshes itself now, and rebuilding the whole map
    // every minute would flash the tiles and reset the user's zoom).
    overlayRef.current = L.layerGroup().addTo(map);

    return () => {
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
    // The map itself mounts once; the DATA is drawn by the effect below.
  }, []);

  // Markers and route lines follow the data: the map page refreshes itself
  // every minute (AutoRefresh + force-dynamic), so a truck moves without
  // anybody reloading. The effect keys on the props — a new server render
  // hands down new arrays, and redrawing a few dozen layers is cheap.
  useEffect(() => {
    const map = mapRef.current;
    const overlay = overlayRef.current;
    if (!map || !overlay) return;
    overlay.clearLayers();

    for (const tr of trucks) {
      L.polyline(
        tr.routePoints.map((p) => [p.y, p.x] as [number, number]),
        { color: '#3b82f6', weight: 3, dashArray: '7 6', opacity: 0.7 },
      ).addTo(overlay);
    }

    for (const w of warehouses) {
      // The count sits ON the icon's shoulder, not floating in the 72px
      // label wrapper (owner, item 12: "icon va karobka sonlari birga, bir
      // butun"). The wrapper is 72px wide for the code label; the icon is a
      // centred 26px — its right shoulder is at 50% + 13px.
      const badge =
        w.totalBoxes > 0
          ? `<span style="position:absolute;top:-7px;left:calc(50% + 6px);background:#1e3a8a;color:#fff;border:1.5px solid #fff;border-radius:10px;padding:0 5px;font-size:10px;font-weight:700;line-height:15px">${w.totalBoxes}</span>`
          : '';
      const icon = L.divIcon({
        className: '',
        html: `<div style="position:relative;width:72px;margin-left:-23px;text-align:center">${warehouseSvg}${badge}<div style="font-family:monospace;font-weight:800;font-size:12px;color:#1e3a8a;-webkit-text-stroke:3px #fff;paint-order:stroke">${esc(w.code)}</div></div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
      L.marker([w.y, w.x], { icon })
        .addTo(overlay)
        .on('click', () => onSelect({ kind: 'wh', code: w.code }));
    }

    for (const tr of trucks) {
      const color = tr.overdue ? '#dc2626' : '#f59e0b';
      const text = tr.overdue ? '#b91c1c' : '#92400e';
      const icon = L.divIcon({
        className: '',
        // The label goes ABOVE a truck and BELOW a warehouse, so a truck
        // standing at a warehouse does not print its code over the other's.
        html: `<div style="position:relative;width:80px;margin-left:-24px;text-align:center"><div style="font-family:monospace;font-weight:800;font-size:12px;color:${text};-webkit-text-stroke:3px #fff;paint-order:stroke">${esc(tr.code)}</div>${truckSvg(color)}</div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      });
      L.marker([tr.y, tr.x], { icon, zIndexOffset: 1000 })
        .addTo(overlay)
        .on('click', () => onSelect({ kind: 'truck', batchId: tr.batchId }));
    }
  }, [warehouses, trucks, onSelect]);

  // Leaflet caches the container size and draws tiles for it; growing the
  // element without telling it leaves grey gaps where the old edge was.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const timer = setTimeout(() => {
      map.invalidateSize();
      map.fitBounds(MAP_BOUNDS, { padding: [8, 8] });
    }, 60);
    return () => clearTimeout(timer);
  }, [full]);

  return <div ref={containerRef} className="h-full w-full" data-testid="leaflet-map" />;
}
