import { WAREHOUSE_POINTS } from './map-data';

/**
 * Where a warehouse is drawn: the coordinates the OWNER typed (round 100,
 * 9B), else the built-in dictionary by code — db wins, because the whole
 * point of the column is correcting a dot the dictionary put in the wrong
 * place. ONE home (#513): the corridor map and the factory truck's last leg
 * must end at the same dot, or the lorry arrives beside its own warehouse.
 *
 * `{x: lon, y: lat}`, the corridor's own shape.
 */
export function warehousePoint(w: {
  code: string;
  lat: string | number | null;
  lon: string | number | null;
}): { x: number; y: number } | null {
  if (w.lat !== null && w.lon !== null) return { x: Number(w.lon), y: Number(w.lat) };
  return WAREHOUSE_POINTS[w.code.toUpperCase()] ?? null;
}
