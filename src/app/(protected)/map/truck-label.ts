/**
 * The code above a lorry — and, held at Horgos or Yallama, the day of its
 * wait beside it (his 5a: «navbatda: 2-kun» at the post,
 * docs/XORGOS-NAVBAT.md). An hourglass and a number, so it reads in every
 * language; the popup carries the words. ONE label for both renderers
 * (tracking-map's SVG, leaflet-corridor's divIcon), because which one a
 * person sees depends on the server's basemap — and a module of its own,
 * because the Leaflet renderer is loaded lazily by the map that imports it.
 */
export function truckLabel(tr: { code: string; queue: { day: number } | null }): string {
  return tr.queue ? `${tr.code} ⏳${tr.queue.day}` : tr.code;
}
