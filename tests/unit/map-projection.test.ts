import { describe, expect, it } from 'vitest';
import { graticule, toSvg, VIEWBOX, WAREHOUSE_POINTS } from '@/modules/wms/tracking/map-data';

/**
 * The fallback map has to be in true proportion (owner: "xarita to'g'ri
 * nisbatlarda bo'lsin"). The old projection scaled longitude by 16.6 and
 * latitude by 24 — a ratio of 0.69 where the honest one at 35°N is 0.819 —
 * so the corridor was squeezed sideways by about 16 %.
 */
describe('the corridor projection', () => {
  it('scales longitude by cos(reference latitude), not by eye', () => {
    // A degree of latitude, in drawing units.
    const latDegree = toSvg({ x: 70, y: 40 }).y - toSvg({ x: 70, y: 41 }).y;
    // A degree of longitude, same units.
    const lonDegree = toSvg({ x: 71, y: 40 }).x - toSvg({ x: 70, y: 40 }).x;
    expect(lonDegree / latDegree).toBeCloseTo(Math.cos((35 * Math.PI) / 180), 3);
  });

  it('is linear, so equal distances stay equal anywhere on the drawing', () => {
    const west = toSvg({ x: 71, y: 40 }).x - toSvg({ x: 70, y: 40 }).x;
    const east = toSvg({ x: 121, y: 40 }).x - toSvg({ x: 120, y: 40 }).x;
    expect(east).toBeCloseTo(west, 6);
  });

  it('puts every warehouse inside the drawing, with room for its label', () => {
    for (const [code, point] of Object.entries(WAREHOUSE_POINTS)) {
      const s = toSvg(point);
      expect(s.x, code).toBeGreaterThan(20);
      expect(s.x, code).toBeLessThan(VIEWBOX.w - 20);
      expect(s.y, code).toBeGreaterThan(20);
      // The code is printed 26 units below the mark.
      expect(s.y, code).toBeLessThan(VIEWBOX.h - 30);
    }
  });

  it('draws a grid that spans the whole drawing', () => {
    const { meridians, parallels } = graticule();
    expect(meridians.length).toBeGreaterThan(3);
    expect(parallels.length).toBeGreaterThan(3);
    for (const line of meridians) {
      expect(line.x1).toBeCloseTo(line.x2, 6); // vertical
      expect(line.y1).toBeCloseTo(0, 6);
      expect(line.y2).toBeCloseTo(VIEWBOX.h, 6);
    }
    for (const line of parallels) {
      expect(line.y1).toBeCloseTo(line.y2, 6); // horizontal
      expect(line.x1).toBeCloseTo(0, 6);
      expect(line.x2).toBeCloseTo(VIEWBOX.w, 6);
    }
  });
});
