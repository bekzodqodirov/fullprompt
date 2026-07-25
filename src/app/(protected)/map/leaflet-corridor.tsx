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

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function LeafletCorridor({
  warehouses,
  trucks,
  onSelect,
}: {
  warehouses: MapWarehouse[];
  trucks: MapTruck[];
  onSelect: (sel: { kind: 'wh'; code: string } | { kind: 'truck'; batchId: string }) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);

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

    for (const tr of trucks) {
      L.polyline(
        tr.routePoints.map((p) => [p.y, p.x] as [number, number]),
        { color: '#3b82f6', weight: 3, dashArray: '7 6', opacity: 0.7 },
      ).addTo(map);
    }

    for (const w of warehouses) {
      const badge =
        w.totalBoxes > 0
          ? `<span style="position:absolute;top:-10px;left:18px;background:#1d4ed8;color:#fff;border-radius:9px;padding:0 6px;font-size:11px;font-weight:700">${w.totalBoxes}</span>`
          : '';
      const icon = L.divIcon({
        className: '',
        html: `<div style="position:relative;text-align:center;width:60px;margin-left:-14px"><div style="font-size:22px;line-height:1">🏭</div><div style="font-family:monospace;font-weight:800;font-size:12px;color:#1e3a8a;text-shadow:0 0 3px #fff">${esc(w.code)}</div>${badge}</div>`,
        iconSize: [32, 34],
        iconAnchor: [16, 17],
      });
      L.marker([w.y, w.x], { icon })
        .addTo(map)
        .on('click', () => onSelect({ kind: 'wh', code: w.code }));
    }

    for (const tr of trucks) {
      const color = tr.overdue ? '#b91c1c' : '#92400e';
      const icon = L.divIcon({
        className: '',
        html: `<div class="gsr-truck" style="position:relative;text-align:center;width:70px;margin-left:-19px"><div style="font-size:22px;line-height:1">🚛</div><div style="font-family:monospace;font-weight:800;font-size:12px;color:${color};text-shadow:0 0 3px #fff">${esc(tr.code)}</div></div>`,
        iconSize: [32, 34],
        iconAnchor: [16, 17],
      });
      L.marker([tr.y, tr.x], { icon, zIndexOffset: 1000 })
        .addTo(map)
        .on('click', () => onSelect({ kind: 'truck', batchId: tr.batchId }));
    }

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Markers are rebuilt only on remount — the data is a per-load snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-[420px] w-full rounded-xl md:h-[520px]"
      data-testid="leaflet-map"
    />
  );
}
