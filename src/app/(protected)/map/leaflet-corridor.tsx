'use client';

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { leafletLayer } from 'protomaps-leaflet';
import 'leaflet/dist/leaflet.css';
import { MAP_BOUNDS } from '@/modules/wms/tracking/map-data';
import type { MapPickup, MapTruck, MapWarehouse } from './tracking-map';
import type { PickupPosition } from '@/modules/wms/tracking/pickup-route';

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

/**
 * The lorry itself, not a badge with a lorry drawn inside it (owner, round
 * 109 after seeing the deploy: «mashinalar iconkasini ozgartirmabsan» — the
 * round-98 marker was a coloured rounded SQUARE holding a 12px white
 * silhouette, and at map scale the square is what the eye reads: a button,
 * a warehouse's twin). A silhouette is also the stronger answer to #137,
 * because nothing about it can be confused with the warehouse's square.
 *
 * It faces LEFT, the way every loaded truck on this corridor travels:
 * China → Uzbekistan is right-to-left on every screen this app draws.
 * The white stroke is a HALO (`paint-order: stroke`), so the shape stays
 * legible over a dark road or a green field on the real basemap.
 */
const truckSvg = (color: string) => `
<svg width="38" height="28" viewBox="0 0 38 28" xmlns="http://www.w3.org/2000/svg">
  <path d="M35 5 H17 V11 H12 L6 17 V22 H35 Z" fill="${color}" stroke="#fff" stroke-width="3"
        paint-order="stroke" stroke-linejoin="round"/>
  <circle cx="13" cy="22" r="3.6" fill="#1f2937" stroke="#fff" stroke-width="1.6"/>
  <circle cx="29" cy="22" r="3.6" fill="#1f2937" stroke="#fff" stroke-width="1.6"/>
</svg>`;

/** A factory, in the pickup's violet: a DIAMOND, the third shape (#137). */
const factorySvg = (filled: boolean) => `
<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
  <rect x="4" y="4" width="10" height="10" transform="rotate(45 9 9)" fill="${filled ? '#7c3aed' : '#fff'}" stroke="#7c3aed" stroke-width="2.5"/>
</svg>`;

export function LeafletCorridor({
  warehouses,
  trucks,
  pickups = [],
  positions = new Map(),
  focusPickupId = null,
  onSelect,
  full,
}: {
  warehouses: MapWarehouse[];
  trucks: MapTruck[];
  pickups?: MapPickup[];
  positions?: Map<string, PickupPosition>;
  focusPickupId?: string | null;
  onSelect: (
    sel: { kind: 'wh'; code: string } | { kind: 'truck'; batchId: string } | { kind: 'pickup'; id: string },
  ) => void;
  /** Fullscreen changes the container size behind Leaflet's back. */
  full?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const overlayRef = useRef<L.LayerGroup | null>(null);
  // One marker per factory truck, MOVED every five seconds — never rebuilt:
  // redrawing the layers on every tick would flash every mark on the map.
  const lorryRefs = useRef(new Map<string, L.Marker>());
  const focusedRef = useRef(false);

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

    // Factory trucks (0100): the road behind them solid, ahead dashed.
    const violet = '#7c3aed';
    lorryRefs.current = new Map();
    const focusPoints: [number, number][] = [];
    for (const p of pickups) {
      for (const pts of p.timeline?.done ?? []) {
        L.polyline(pts.map(([x, y]) => [y, x] as [number, number]), { color: violet, weight: 4, opacity: 0.85 }).addTo(overlay);
      }
      for (const hop of p.timeline?.hops ?? []) {
        L.polyline(hop.points.map(([x, y]) => [y, x] as [number, number]), {
          color: violet,
          weight: 3,
          dashArray: '6 6',
          opacity: 0.75,
        }).addTo(overlay);
        if (p.id === focusPickupId) focusPoints.push(...hop.points.map(([x, y]) => [y, x] as [number, number]));
      }
      for (const f of p.factories) {
        if (p.id === focusPickupId) focusPoints.push([f.y, f.x]);
        L.marker([f.y, f.x], {
          icon: L.divIcon({ className: '', html: factorySvg(f.collected), iconSize: [18, 18], iconAnchor: [9, 9] }),
          title: f.name,
        })
          .addTo(overlay)
          .on('click', () => onSelect({ kind: 'pickup', id: p.id }));
      }
      const at = positions.get(p.id);
      if (at) {
        const icon = L.divIcon({
          className: '',
          html: `<div data-testid="map-pickup" style="position:relative;width:38px;height:28px;line-height:0"><div style="position:absolute;bottom:100%;left:50%;transform:translateX(-50%);white-space:nowrap;font-family:monospace;font-weight:800;font-size:12px;line-height:14px;color:#6d28d9;-webkit-text-stroke:3px #fff;paint-order:stroke">${esc(p.code)}</div>${truckSvg(violet)}</div>`,
          iconSize: [38, 28],
          iconAnchor: [19, 14],
        });
        const marker = L.marker([at.point[1], at.point[0]], { icon, zIndexOffset: 900 })
          .addTo(overlay)
          .on('click', () => onSelect({ kind: 'pickup', id: p.id }));
        lorryRefs.current.set(p.id, marker);
      }
    }
    // From a pickup card's «Xaritada ko'rish»: at the corridor's zoom a
    // city-sized trip is a few pixels long, so the view FITS it, once.
    if (!focusedRef.current && focusPoints.length) {
      focusedRef.current = true;
      map.fitBounds(L.latLngBounds(focusPoints), { padding: [40, 40], maxZoom: 11 });
    }

    for (const w of warehouses) {
      // The count sits ON the icon's shoulder, not floating in the 72px
      // label wrapper (owner, item 12: "icon va karobka sonlari birga, bir
      // butun"). The wrapper is 72px wide for the code label; the icon is a
      // centred 26px — its right shoulder is at 50% + 13px.
      // The count sits ON the icon's own corner (owner, round 109: «iconlarni
      // yonidagi soni icondan uzoq bolib ketgan»). It used to be positioned
      // against the 72px LABEL box — `left: calc(50% + 6px)` inside a wrapper
      // nearly three times the icon's width put it 13px clear of the square,
      // floating in the map with nothing under it. It is anchored to the
      // 26px icon below, so no wrapper width can move it again.
      const badge =
        w.totalBoxes > 0
          ? `<span style="position:absolute;top:-6px;right:-9px;background:#1e3a8a;color:#fff;border:1.5px solid #fff;border-radius:10px;padding:0 5px;font-size:10px;font-weight:700;line-height:15px">${w.totalBoxes}</span>`
          : '';
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:72px;margin-left:-23px;text-align:center"><span style="position:relative;display:inline-block;line-height:0">${warehouseSvg}${badge}</span><div style="font-family:monospace;font-weight:800;font-size:12px;color:#1e3a8a;-webkit-text-stroke:3px #fff;paint-order:stroke">${esc(w.code)}</div></div>`,
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
      // MEASURED, and the reason he saw the code floating away from the
      // lorry: the label was a BLOCK above the svg inside an 80px wrapper,
      // and Tailwind's preflight makes every `svg` display:block — so
      // `text-align:center` moved the TEXT and left the icon pinned to the
      // wrapper's left edge. The lorry was drawn 24px left and 18px BELOW
      // its own coordinate, with the code centred over open map. The label
      // is absolute now (it cannot push the icon anywhere) and the svg sits
      // in an inline-block box like the warehouse's, so the marker lands
      // exactly on the road it is driving. The label still goes ABOVE a
      // truck and BELOW a warehouse, so a truck standing at a warehouse
      // does not print its code over the other's.
      const icon = L.divIcon({
        className: '',
        html: `<div style="position:relative;width:38px;height:28px;line-height:0"><div style="position:absolute;bottom:100%;left:50%;transform:translateX(-50%);white-space:nowrap;font-family:monospace;font-weight:800;font-size:12px;line-height:14px;color:${text};-webkit-text-stroke:3px #fff;paint-order:stroke">${esc(tr.code)}</div>${truckSvg(color)}</div>`,
        iconSize: [38, 28],
        iconAnchor: [19, 14],
      });
      L.marker([tr.y, tr.x], { icon, zIndexOffset: 1000 })
        .addTo(overlay)
        .on('click', () => onSelect({ kind: 'truck', batchId: tr.batchId }));
    }
    // `positions` is read for the FIRST placement only; the effect below
    // moves the markers, so a tick does not rebuild the layers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouses, trucks, pickups, focusPickupId, onSelect]);

  useEffect(() => {
    for (const [id, marker] of lorryRefs.current) {
      const at = positions.get(id);
      if (at) marker.setLatLng([at.point[1], at.point[0]]);
    }
  }, [positions]);

  // Leaflet caches the container size and draws tiles for it; growing the
  // element without telling it leaves grey gaps where the old edge was.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const timer = setTimeout(() => {
      map.invalidateSize();
      // A trip the page was opened FOR keeps its fitted view on mount.
      if (!(focusedRef.current && !full)) map.fitBounds(MAP_BOUNDS, { padding: [8, 8] });
    }, 60);
    return () => clearTimeout(timer);
  }, [full]);

  return <div ref={containerRef} className="h-full w-full" data-testid="leaflet-map" />;
}
