import { describe, expect, it } from 'vitest';
import {
  gcj02ToWgs84,
  haversineKm,
  legFromOsrm,
  outOfChina,
  parseAmapGeocode,
  parseNominatim,
  parsePastedPoint,
  straightLeg,
  wgs84ToGcj02,
  type LngLat,
} from '@/modules/wms/pickups/geo';

/**
 * The factory map's pure half (owner: «adreslari bilan kiritilsin
 * xitoychada va mapda o'zi topib olsa»). No network here on purpose — this
 * container cannot reach a geocoder and the CI runner can (#278).
 */

const YIWU: LngLat = [120.07, 29.31];

describe('GCJ-02 → WGS-84', () => {
  it('moves a Chinese point by the few hundred metres the Chinese maps add', () => {
    const shifted = wgs84ToGcj02(YIWU);
    const metres = haversineKm(YIWU, shifted) * 1000;
    expect(metres).toBeGreaterThan(100);
    expect(metres).toBeLessThan(900);
  });

  it('undoes the offset to well under a metre', () => {
    const back = gcj02ToWgs84(wgs84ToGcj02(YIWU));
    expect(haversineKm(back, YIWU) * 1000).toBeLessThan(1);
  });

  it('leaves a point outside China alone (Tashkent)', () => {
    expect(outOfChina([69.24, 41.31])).toBe(true);
    expect(gcj02ToWgs84([69.24, 41.31])).toEqual([69.24, 41.31]);
  });
});

describe('geocoder answers', () => {
  it('reads Amap and converts its datum', () => {
    const gcj = wgs84ToGcj02(YIWU);
    const hit = parseAmapGeocode({
      status: '1',
      geocodes: [{ location: `${gcj[0]},${gcj[1]}`, formatted_address: '浙江省金华市义乌市' }],
    });
    expect(hit?.source).toBe('amap');
    expect(haversineKm(hit!.point, YIWU) * 1000).toBeLessThan(1);
  });

  it('refuses an Amap failure or a point outside the country', () => {
    expect(parseAmapGeocode({ status: '0', info: 'INVALID_USER_KEY' })).toBeNull();
    expect(parseAmapGeocode({ status: '1', geocodes: [{ location: '0,0' }] })).toBeNull();
  });

  it('reads Nominatim as it is (already WGS-84)', () => {
    const hit = parseNominatim([{ lat: '29.31', lon: '120.07', display_name: 'Yiwu' }]);
    expect(hit).toEqual({ point: [120.07, 29.31], source: 'osm', label: 'Yiwu' });
    expect(parseNominatim([])).toBeNull();
  });

  it('reads a pasted pair in either order, by the ranges themselves', () => {
    expect(parsePastedPoint('29.31, 120.07')).toEqual([120.07, 29.31]);
    expect(parsePastedPoint('120.07,29.31')).toEqual([120.07, 29.31]);
    // Kashgar: both numbers are «small», and still unambiguous.
    expect(parsePastedPoint('39.47,75.98')).toEqual([75.98, 39.47]);
    expect(parsePastedPoint('no numbers')).toBeNull();
  });
});

describe('a stored leg', () => {
  it('keeps the stops EXACT at both ends, whatever the router snapped to', () => {
    const from: LngLat = [120.07, 29.31];
    const to: LngLat = [120.2, 29.4];
    const leg = legFromOsrm(
      {
        code: 'Ok',
        routes: [
          {
            duration: 3600,
            geometry: { coordinates: [[120.071, 29.309], [120.13, 29.33], [120.199, 29.401]] },
          },
        ],
      },
      from,
      to,
    );
    expect(leg!.points[0]).toEqual(from);
    expect(leg!.points.at(-1)).toEqual(to);
    // A car's hour is a lorry's 1.3.
    expect(leg!.hours).toBeCloseTo(1.3, 5);
  });

  it('is a straight line with distance hours when no router answered', () => {
    const leg = straightLeg([120.07, 29.31], [113.26, 23.13]);
    expect(leg.source).toBe('line');
    expect(leg.hours).toBeGreaterThan(20);
    expect(legFromOsrm({ code: 'NoRoute' }, [1, 1], [2, 2])).toBeNull();
  });
});
