import { describe, expect, it } from 'vitest';
import {
  assembleBoard,
  boardDay,
  boardRange,
  columnOfStop,
  measureLine,
  readBoardFilters,
  roadBands,
  routeFilterOf,
  stopOf,
  telOf,
  tripRoadSection,
  warehouseSection,
  type BoardFilters,
  type CardPlacement,
} from '@/modules/wms/batches/board-view';
import { readFileSync } from 'node:fs';
import { tripSight } from '@/modules/wms/batches/board';
import { routeFor } from '@/modules/wms/tracking/map-data';
import { gateWord } from '@/modules/wms/tracking/on-road-state';

/**
 * The batch board's arithmetic (docs/PARTIYA-DOSKASI.md §3-§4) — pure, so
 * every judgement the page draws is a table here.
 */

const NONE: BoardFilters = { sklad: null, yonalish: null, ogoh: false, joy: null };
const WH_A = '0190a000-0000-7000-8000-00000000000a';
const WH_B = '0190a000-0000-7000-8000-00000000000b';

let seq = 0;
function card(over: Partial<CardPlacement>): CardPlacement {
  seq += 1;
  return {
    key: `k${seq}`,
    code: `T${String(seq).padStart(3, '0')}`,
    column: 'road',
    section: 'cn',
    transitLeg: null,
    warehouseIds: [WH_A, WH_B],
    route: null,
    internal: false,
    warnings: [],
    order: seq,
    ...over,
  };
}

describe('readBoardFilters — every value validated (#514)', () => {
  it('a warehouse only from the viewer’s own options, first value of a repeated key', () => {
    const own = [WH_A];
    expect(readBoardFilters({ sklad: WH_A }, own).sklad).toBe(WH_A);
    // A real warehouse the viewer may not see is dropped, never echoed back.
    expect(readBoardFilters({ sklad: WH_B }, own).sklad).toBeNull();
    expect(readBoardFilters({ sklad: [WH_A, WH_B] }, own).sklad).toBe(WH_A);
    expect(readBoardFilters({ sklad: "' OR 1=1" }, own).sklad).toBeNull();
  });

  it('route, warning and place from their closed lists', () => {
    expect(readBoardFilters({ yonalish: 'horgos', ogoh: '1', joy: 'road_transit' }, [])).toEqual({
      sklad: null,
      yonalish: 'horgos',
      ogoh: true,
      joy: 'road_transit',
    });
    expect(readBoardFilters({ yonalish: 'tibet', ogoh: 'yes', joy: 'road_moon' }, [])).toEqual(NONE);
    expect(readBoardFilters({ joy: ['loading', 'arrived'] }, []).joy).toBe('loading');
  });
});

describe('the strip and the columns', () => {
  it('a stop is a column, or the road column’s place', () => {
    expect(stopOf({ column: 'forming', section: 'cn' })).toBe('forming');
    expect(stopOf({ column: 'road', section: 'border' })).toBe('road_border');
    expect(stopOf({ column: 'road', section: 'unknown' })).toBe('road_unknown');
    expect(stopOf({ column: 'arrived', section: 'uz' })).toBe('arrived');
    expect(columnOfStop('road_transit')).toBe('road');
    expect(columnOfStop('loading')).toBe('loading');
  });

  it('the strip counts every filter but `joy`, from the same cards the columns draw', () => {
    const cards = [
      card({ column: 'forming', section: 'cn' }),
      card({ column: 'road', section: 'cn' }),
      card({ column: 'road', section: 'transit', transitLeg: 'kg' }),
      card({ column: 'road', section: 'transit', transitLeg: 'kz' }),
      card({ column: 'road', section: 'transit', transitLeg: 'kg', warehouseIds: [WH_B] }),
      card({ column: 'arrived', section: 'uz', warnings: ['stuck'] }),
    ];
    const all = assembleBoard(cards, { ...NONE, joy: 'road_transit' });
    const at = Object.fromEntries(all.strip.map((s) => [s.stop, s]));
    // `joy` narrows the columns, never the strip — a tap must not zero the other stops.
    expect(at.forming!.count).toBe(1);
    expect(at.road_transit).toMatchObject({ count: 3, kg: 2, kz: 1 });
    expect(all.columns.find((c) => c.key === 'road')!.count).toBe(3);
    expect(all.columns.find((c) => c.key === 'forming')!.count).toBe(0);
    expect(all.activeColumn).toBe('road');
    // Every other filter narrows both, so a stop's number is the cards it opens.
    const byWh = assembleBoard(cards, { ...NONE, sklad: WH_A });
    expect(byWh.strip.find((s) => s.stop === 'road_transit')!.count).toBe(2);
    expect(byWh.total).toBe(5);
    const warned = assembleBoard(cards, { ...NONE, ogoh: true });
    expect(warned.total).toBe(1);
    expect(warned.activeColumn).toBe('arrived');
  });

  it('`ichki` keeps the trips that cross no border; a corridor keeps its own road', () => {
    const cards = [
      card({ route: 'irkeshtam' }),
      card({ route: 'horgos' }),
      card({ route: null, internal: true }),
      card({ route: null }),
    ];
    expect(assembleBoard(cards, { ...NONE, yonalish: 'ichki' }).total).toBe(1);
    expect(assembleBoard(cards, { ...NONE, yonalish: 'horgos' }).total).toBe(1);
    expect(assembleBoard(cards, NONE).total).toBe(4);
  });

  it('sections in road order, empty ones left out, oldest first, ties by code', () => {
    const late = card({ column: 'road', section: 'uz', order: 5, code: 'B' });
    const early = card({ column: 'road', section: 'uz', order: 5, code: 'A' });
    const first = card({ column: 'road', section: 'cn', order: 9 });
    const lost = card({ column: 'road', section: 'unknown', order: 1 });
    const road = assembleBoard([late, lost, early, first], NONE).columns.find((c) => c.key === 'road')!;
    expect(road.sections.map((s) => s.key)).toEqual(['cn', 'uz', 'unknown']);
    expect(road.sections[1]!.cards.map((c) => c.code)).toEqual(['A', 'B']);
  });

  it('opens the phone on the first column holding a card', () => {
    expect(assembleBoard([card({ column: 'arrived', section: 'uz' })], NONE).activeColumn).toBe('arrived');
    expect(assembleBoard([], NONE).activeColumn).toBe('forming');
  });
});

describe('places', () => {
  it('a warehouse’s place by its type and country; anything else is «joyi aniq emas»', () => {
    expect(warehouseSection('CN', 'origin')).toBe('cn');
    expect(warehouseSection(' cn ', 'hub')).toBe('border');
    expect(warehouseSection('UZ', 'distribution')).toBe('uz');
    expect(warehouseSection('KZ', 'hub')).toBe('unknown');
    expect(warehouseSection(null, null)).toBe('unknown');
  });

  it('a factory truck on the road is inside its destination’s country, never in a queue (D12)', () => {
    expect(tripRoadSection('CN')).toBe('cn');
    expect(tripRoadSection('uz')).toBe('uz');
    expect(tripRoadSection('')).toBe('unknown');
  });

  it('the corridor is named by the legs a road drives', () => {
    expect(routeFilterOf(routeFor('KA', 'TAS1'))).toBe('irkeshtam');
    expect(routeFilterOf(routeFor('YW', 'TAS1'))).toBe('irkeshtam');
    expect(routeFilterOf(routeFor('HOR', 'TAS1'))).toBe('horgos');
    // A road inside China crosses no corridor.
    expect(routeFilterOf(routeFor('YW', 'KA'))).toBeNull();
    expect(routeFilterOf(null)).toBeNull();
  });
});

describe('the road bar — places by distance (4a)', () => {
  it('bands cover the road end to end, a queue is a notch, neighbours in one place merge', () => {
    const route = routeFor('KA', 'TAS1')!;
    const { bands, notches } = roadBands(route);
    expect(bands[0]!.from).toBe(0);
    expect(bands[bands.length - 1]!.to).toBeCloseTo(1, 9);
    for (let i = 1; i < bands.length; i += 1) {
      expect(bands[i]!.from).toBeCloseTo(bands[i - 1]!.to, 9);
      expect(bands[i]!.zone).not.toBe(bands[i - 1]!.zone);
    }
    // The border wait has no length: a notch where the post is, never a band.
    const stationary = route.segments.filter((s) => s.span[0] === s.span[1]).length;
    expect(notches).toHaveLength(stationary);
    expect(stationary).toBeGreaterThan(0);
    expect(bands.map((b) => b.zone)).toEqual(['border', 'transit', 'uz']);
  });

  it('a road inside one place is one band', () => {
    expect(roadBands(routeFor('YW', 'KA')!).bands.map((b) => b.zone)).toEqual(['cn']);
  });
});

describe('dates — Tashkent, locale-free (6c)', () => {
  it('a day is the office’s day', () => {
    expect(boardDay('2026-10-14T18:59:00Z')).toBe('14.10');
    // 19:00 UTC is midnight in Tashkent: the next day (R5's window).
    expect(boardDay('2026-10-14T19:00:00Z')).toBe('15.10');
  });

  it('a range prints its month once, both months across a month end, one day alone', () => {
    expect(boardRange('2026-10-12T05:00:00Z', '2026-10-14T05:00:00Z')).toBe('12–14.10');
    expect(boardRange('2026-09-30T05:00:00Z', '2026-10-02T05:00:00Z')).toBe('30.09–02.10');
    expect(boardRange('2026-10-14T01:00:00Z', '2026-10-14T17:00:00Z')).toBe('14.10');
  });
});

describe('the driver’s number', () => {
  it('dials digits and the leading plus; a note is not a number', () => {
    expect(telOf('+998 90 123-45-67 (Akmal)')).toBe('+998901234567');
    expect(telOf('90 123 45 67')).toBe('901234567');
    expect(telOf('Akmal')).toBeNull();
    expect(telOf('12-34')).toBeNull();
    expect(telOf(null)).toBeNull();
  });
});

describe('which factory trips the board shows (§4)', () => {
  const actor = (codes: string[], scoped = false, ids: string[] = []) => ({
    permissions: new Set(codes),
    warehouseScoped: scoped,
    warehouseIds: ids,
  });

  it('the list’s door reads every trip — a scoped holder only their own destinations', () => {
    expect(tripSight(actor(['plans.manage']))).toEqual({ warehouseIds: null, fresh: false });
    expect(tripSight(actor(['plans.manage'], true, [WH_A]))).toEqual({ warehouseIds: [WH_A], fresh: false });
  });

  it('a receiver reads the trips coming to their warehouses, without the stale ones', () => {
    expect(tripSight(actor(['receipts.create'], true, [WH_B]))).toEqual({ warehouseIds: [WH_B], fresh: true });
  });

  it('anyone else reads no trip', () => {
    expect(tripSight(actor(['scan.load'], true, [WH_A]))).toBeNull();
    expect(tripSight(actor(['ved.docs']))).toBeNull();
  });
});

describe('one spelling for a card’s cubes and kilos', () => {
  it('m³ first, two places; whole kilos — on every column (the review: they swapped between columns)', () => {
    expect(measureLine(0.128, 14)).toBe('0.13 m³ · 14 kg');
    expect(measureLine(12, 2150.6)).toBe('12 m³ · 2151 kg');
    expect(measureLine(0, 0)).toBe('0 m³ · 0 kg');
  });
});

describe('the word for a truck at its gate', () => {
  it('nothing left to scan off is «unloaded, not finished» — never «standing, not unloaded»', () => {
    expect(gateWord({ status: 'arrived', kind: 'stuck', awaitingUnload: 0 })).toBe('unloaded_open');
    expect(gateWord({ status: 'arrived', kind: 'unloading', awaitingUnload: 0 })).toBe('unloaded_open');
    expect(gateWord({ status: 'arrived', kind: 'stuck', awaitingUnload: 12 })).toBe('stuck');
    expect(gateWord({ status: 'arrived', kind: 'unloading', awaitingUnload: 3 })).toBe('unloading');
    // Not asked is not zero: the words the screens printed before.
    expect(gateWord({ status: 'arrived', kind: 'stuck', awaitingUnload: null })).toBe('stuck');
    expect(gateWord({ status: 'in_transit', kind: 'overdue', awaitingUnload: null })).toBeNull();
  });
});

describe('the phone tabs over one DOM', () => {
  const page = readFileSync('src/app/(protected)/batches/page.tsx', 'utf8');

  it('a checked tab HIDES the other columns, only where :has() exists — never shows one over hidden ones', () => {
    // An old browser without :has() must draw the four columns stacked, not
    // tabs over nothing (the review's finding 8): no column carries `hidden`.
    for (const col of ['forming', 'loading', 'road', 'arrived']) {
      expect(page).toContain(
        `max-xl:[&:has(#bt-${col}:checked)_[data-col]:not([data-col=${col}])]:hidden`,
      );
    }
    const section = page.slice(page.indexOf('data-col={column.key}'), page.indexOf('data-col={column.key}') + 200);
    expect(section).not.toMatch(/\bhidden\b/);
    // The tab row and the headings swap only where :has() can drive the tabs.
    expect(page).toContain('max-xl:supports-[selector(:has(*))]:grid');
    expect(page).toContain('max-xl:supports-[selector(:has(*))]:hidden');
  });

  it('a strip tap remounts the radios even when the default column is unchanged', () => {
    expect(page).toMatch(/key=\{`tabs:\$\{filters\.joy \?\? '-'\}:\$\{view\.activeColumn\}`\}/);
  });

  it('the active «Joyi aniq emas» stop stays while it filters the board', () => {
    expect(page).toContain("stop.stop !== 'road_unknown' || stop.count > 0 || filters.joy === stop.stop");
  });
});
