import { describe, expect, it } from 'vitest';
import {
  assembleBoard,
  boardDay,
  boardRange,
  cargoLineOf,
  columnOfStop,
  measureLine,
  readBoardFilters,
  roadBands,
  roadColumnOf,
  routeFilterOf,
  stopOf,
  tabCounts,
  tabOf,
  telOf,
  toSection,
  tripRoadSection,
  warehouseSection,
  type BoardFilters,
  type CardPlacement,
} from '@/modules/wms/batches/board-view';
import { readFileSync } from 'node:fs';
import { tripSight } from '@/modules/wms/batches/board';
import { routeFor } from '@/modules/wms/tracking/map-data';
import { ROLE_MATRIX } from '@/modules/platform/rbac/catalog';
import { estimateBasis, gateWord } from '@/modules/wms/tracking/on-road-state';

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
    column: 'outbound',
    section: 'cn',
    place: 'cn',
    destName: 'Toshkent',
    destHub: false,
    transitLeg: null,
    warehouseIds: [WH_A, WH_B],
    route: null,
    internal: false,
    warnings: [],
    order: seq,
    ...over,
  };
}

/** An outbound card: its section IS its place. */
const out = (place: CardPlacement['place'], over: Partial<CardPlacement> = {}) =>
  card({ column: 'outbound', section: place, place, ...over });

/** An inland card heading for a Chinese warehouse: the section is the destination, the place is the road's. */
const inland = (destId: string, destName: string, over: Partial<CardPlacement> = {}) =>
  card({ column: 'inland', section: toSection(destId), place: 'cn', destName, ...over });

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
  it('a stop is a column, or the PLACE of a card on either road column', () => {
    expect(stopOf({ column: 'forming', place: 'cn' })).toBe('forming');
    expect(stopOf({ column: 'outbound', place: 'border' })).toBe('road_border');
    expect(stopOf({ column: 'outbound', place: 'unknown' })).toBe('road_unknown');
    expect(stopOf({ column: 'arrived', place: 'uz' })).toBe('arrived');
    // An inland card's section is its destination; the strip asks where it IS.
    expect(stopOf({ column: 'inland', place: 'cn' })).toBe('road_cn');
    expect(stopOf({ column: 'inland', place: 'border' })).toBe('road_border');
    // With nothing left at a stop: «Xitoy ichida» opens inland, the rest of the road outbound.
    expect(columnOfStop('road_cn')).toBe('inland');
    expect(columnOfStop('road_transit')).toBe('outbound');
    expect(columnOfStop('loading')).toBe('loading');
  });

  it('the road column is the DESTINATION’s country — his «xitoy ichidagi va tashqisi» (2026-10-21)', () => {
    expect(roadColumnOf('CN')).toBe('inland');
    // `warehouses.country` is free text (`countryKey`).
    expect(roadColumnOf(' cn ')).toBe('inland');
    expect(roadColumnOf('UZ')).toBe('outbound');
    // Unknown is not «inside China»: nothing is claimed about it.
    expect(roadColumnOf(null)).toBe('outbound');
    expect(roadColumnOf('')).toBe('outbound');
  });

  it('the inland column is grouped by destination, the border hubs first, then by name', () => {
    const KA = '0190a000-0000-7000-8000-0000000000ka';
    const HOR = '0190a000-0000-7000-8000-000000000hor';
    const UCH = '0190a000-0000-7000-8000-000000000uch';
    const AKS = '0190a000-0000-7000-8000-000000000aks';
    const cards = [
      inland(UCH, 'Urumqi', { order: 1 }),
      inland(KA, 'Qashqar', { destHub: true, order: 3, code: 'B' }),
      // A warehouse that is no hub and sorts before both hubs by name: the
      // hubs still come first (the review — the order was alphabetical by luck).
      inland(AKS, 'Aksu', { order: 4 }),
      inland(HOR, 'Horgos', { destHub: true, order: 2 }),
      inland(KA, 'Qashqar', { destHub: true, order: 3, code: 'A' }),
    ];
    const col = assembleBoard(cards, NONE).columns.find((c) => c.key === 'inland')!;
    expect(col.count).toBe(5);
    expect(col.sections.map((s) => [s.key, s.destName])).toEqual([
      [`to:${HOR}`, 'Horgos'],
      [`to:${KA}`, 'Qashqar'],
      [`to:${AKS}`, 'Aksu'],
      [`to:${UCH}`, 'Urumqi'],
    ]);
    // Oldest first inside a destination, ties by code.
    expect(col.sections[1]!.cards.map((c) => c.code)).toEqual(['A', 'B']);
    // A place section carries no name: the page names it.
    const outbound = assembleBoard([out('uz')], NONE).columns.find((c) => c.key === 'outbound')!;
    expect(outbound.sections[0]).toMatchObject({ key: 'uz', destName: null });
  });

  it('four phone tabs: the «Yo’lda» tab holds both road columns and counts them both', () => {
    expect(tabOf('inland')).toBe('road');
    expect(tabOf('outbound')).toBe('road');
    expect(tabOf('forming')).toBe('forming');
    const KA = '0190a000-0000-7000-8000-0000000000ka';
    const view = assembleBoard(
      [inland(KA, 'Qashqar'), inland(KA, 'Qashqar'), out('uz'), card({ column: 'arrived', section: 'uz', place: 'uz' })],
      NONE,
    );
    expect(tabCounts(view.columns)).toEqual({ forming: 0, loading: 0, road: 3, arrived: 1 });
  });

  it('a strip stop spanning both road columns opens the first one holding a card', () => {
    const KA = '0190a000-0000-7000-8000-0000000000ka';
    // «Xitoy ichida» holds a Yiwu → Kashgar truck AND a Yiwu → Tashkent one still in China.
    const both = [inland(KA, 'Qashqar'), out('cn'), out('uz')];
    const view = assembleBoard(both, { ...NONE, joy: 'road_cn' });
    expect(view.strip.find((s) => s.stop === 'road_cn')!.count).toBe(2);
    expect(view.columns.find((c) => c.key === 'inland')!.count).toBe(1);
    expect(view.columns.find((c) => c.key === 'outbound')!.count).toBe(1);
    expect(view.activeColumn).toBe('inland');
    // Only outbound trucks there: the phone opens outbound, not an empty inland tab.
    expect(assembleBoard([out('cn')], { ...NONE, joy: 'road_cn' }).activeColumn).toBe('outbound');
    // Nothing there any more: the stop's own column.
    expect(assembleBoard([], { ...NONE, joy: 'road_cn' }).activeColumn).toBe('inland');
    expect(assembleBoard([], { ...NONE, joy: 'road_border' }).activeColumn).toBe('outbound');
  });

  it('the strip counts every filter but `joy`, from the same cards the columns draw', () => {
    const cards = [
      card({ column: 'forming', section: 'cn', place: 'cn' }),
      out('cn'),
      out('transit', { transitLeg: 'kg' }),
      out('transit', { transitLeg: 'kz' }),
      out('transit', { transitLeg: 'kg', warehouseIds: [WH_B] }),
      card({ column: 'arrived', section: 'uz', place: 'uz', warnings: ['stuck'] }),
    ];
    const all = assembleBoard(cards, { ...NONE, joy: 'road_transit' });
    const at = Object.fromEntries(all.strip.map((s) => [s.stop, s]));
    // `joy` narrows the columns, never the strip — a tap must not zero the other stops.
    expect(at.forming!.count).toBe(1);
    expect(at.road_transit).toMatchObject({ count: 3, kg: 2, kz: 1 });
    expect(all.columns.find((c) => c.key === 'outbound')!.count).toBe(3);
    expect(all.columns.find((c) => c.key === 'forming')!.count).toBe(0);
    expect(all.activeColumn).toBe('outbound');
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
    const late = out('uz', { order: 5, code: 'B' });
    const early = out('uz', { order: 5, code: 'A' });
    const first = out('cn', { order: 9 });
    const lost = out('unknown', { order: 1 });
    const road = assembleBoard([late, lost, early, first], NONE).columns.find((c) => c.key === 'outbound')!;
    expect(road.sections.map((s) => s.key)).toEqual(['cn', 'uz', 'unknown']);
    expect(road.sections[1]!.cards.map((c) => c.code)).toEqual(['A', 'B']);
  });

  it('opens the phone on the first column holding a card', () => {
    expect(assembleBoard([card({ column: 'arrived', section: 'uz', place: 'uz' })], NONE).activeColumn).toBe('arrived');
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
    expect(gateWord({ status: 'arrived', kind: 'stuck', awaitingUnload: 0, atGate: false })).toBe('unloaded_open');
    expect(gateWord({ status: 'arrived', kind: 'unloading', awaitingUnload: 0, atGate: false })).toBe('unloaded_open');
    expect(gateWord({ status: 'arrived', kind: 'stuck', awaitingUnload: 12, atGate: false })).toBe('stuck');
    expect(gateWord({ status: 'arrived', kind: 'unloading', awaitingUnload: 3, atGate: false })).toBe('unloading');
    // Not asked is not zero: the words the screens printed before.
    expect(gateWord({ status: 'arrived', kind: 'stuck', awaitingUnload: null, atGate: false })).toBe('stuck');
    expect(gateWord({ status: 'in_transit', kind: 'overdue', awaitingUnload: null, atGate: false })).toBeNull();
    // At its gate by the PHONE (still in transit): «stuck» on the arrived
    // truck's own clock, nothing before it, nothing on the road.
    expect(gateWord({ status: 'in_transit', kind: 'stuck', awaitingUnload: null, atGate: true })).toBe('stuck');
    expect(gateWord({ status: 'in_transit', kind: 'on_road', awaitingUnload: null, atGate: true })).toBeNull();
    expect(gateWord({ status: 'in_transit', kind: 'stuck', awaitingUnload: null, atGate: false })).toBeNull();
  });
});

describe('the one box count a truck card prints', () => {
  const m = (boxes: number, kg = boxes * 10, m3 = boxes * 0.1) => ({ boxes, kg, m3 });
  const card = (over: Partial<Parameters<typeof cargoLineOf>[0]>) => ({
    status: 'loading',
    hasPlan: true,
    load: null,
    rode: null,
    awaitingUnload: null,
    ...over,
  });

  it('a quick truck says what was scanned — never «1 / 1 · hammasi yuklandi» from its first carton', () => {
    // `batchLoadTotals` counts the plan as everything on the pointer, and a
    // quick truck has nothing else there: planned EQUALS loaded.
    const line = cargoLineOf(card({ hasPlan: false, load: { loaded: m(1), planned: m(1) } }));
    expect(line).toEqual({ kind: 'loadedNoPlan', loaded: m(1) });
    expect(cargoLineOf(card({ hasPlan: false, load: null }))).toEqual({ kind: 'planNone' });
    expect(cargoLineOf(card({ status: 'forming', hasPlan: false, load: { loaded: m(0), planned: m(0) } }))).toEqual({
      kind: 'planNone',
    });
  });

  it('a planned truck: the plan while forming, a / b while loading, «all» only when it is all aboard', () => {
    expect(cargoLineOf(card({ status: 'forming', load: { loaded: m(0), planned: m(40) } }))).toEqual({
      kind: 'plan',
      planned: m(40),
    });
    expect(cargoLineOf(card({ load: { loaded: m(12), planned: m(40) } }))).toMatchObject({ kind: 'loaded', all: false });
    expect(cargoLineOf(card({ load: { loaded: m(40), planned: m(40) } }))).toMatchObject({ kind: 'loaded', all: true });
    expect(cargoLineOf(card({ load: { loaded: m(0), planned: m(0) } }))).toEqual({ kind: 'planNone' });
  });

  it('on the road what rode; at the gate a / b off — the whole truck’s measures, named so', () => {
    expect(cargoLineOf(card({ status: 'in_transit', rode: m(40) }))).toEqual({ kind: 'rode', rode: m(40) });
    expect(cargoLineOf(card({ status: 'arrived', rode: m(40), awaitingUnload: 30 }))).toEqual({
      kind: 'unloaded',
      off: 10,
      rode: m(40),
    });
    expect(cargoLineOf(card({ status: 'arrived', rode: m(40), awaitingUnload: 0 }))).toMatchObject({ off: 40 });
    expect(cargoLineOf(card({ status: 'in_transit', rode: null }))).toBeNull();
    // The measures beside «10 / 40» are the truck's, and the words say «jami».
    const bundles = ['uz', 'ru', 'en', 'zh-CN'].map(
      (l) => (JSON.parse(readFileSync(`messages/${l}.json`, 'utf8')) as { batches: { board: { unloaded: string } } }).batches.board.unloaded,
    );
    expect(bundles[0]).toBe('Tushirildi {a} / {b} karobka · jami {cargo}');
    for (const text of bundles) expect(text).toMatch(/· [^·{]+ \{cargo\}$/u);
  });
});

describe('the gate word fits a one-line chip, and the button is named in the sentence', () => {
  type Dash = { dashboard: { truckUnloadedOpen: string; truckUnloadedOpenHint: string; truckAtGate: string; att: { stuck: string } } };
  const read = (l: string) => (JSON.parse(readFileSync(`messages/${l}.json`, 'utf8')) as Dash).dashboard;

  it('the word is short and names no button; the hint carries it', () => {
    // The dashboard prints the word in a nowrap chip beside the meter: the
    // first version («Tushirib bo‘lindi — «Razgruzkani yakunlash»
    // bosilmagan», 51 characters) pushed the card past a phone's width.
    for (const l of ['uz', 'ru', 'en', 'zh-CN']) {
      const d = read(l);
      expect(d.truckUnloadedOpen.length).toBeLessThanOrEqual(24);
      expect(d.truckAtGate.length).toBeLessThanOrEqual(24);
      expect(d.truckUnloadedOpen).not.toContain('{button}');
      expect(d.truckUnloadedOpenHint).toContain('{button}');
    }
    expect(read('uz').truckUnloadedOpen).toBe('Tushirildi, yopilmagan');
  });

  it('the button is named once — in the sentence whatever `counts` says, and on the board’s arrived card', () => {
    const src = readFileSync('src/components/truck-road.tsx', 'utf8');
    expect(src).toContain(
      "gateWord(row) === 'unloaded_open' ? t('truckUnloadedOpenHint', { button: tu('finishUnload') }) : null;",
    );
    const line = src.split('\n').find((l) => l.includes('const hint = gateHint(row);'))!;
    expect(line).toBeDefined();
    expect(line).not.toContain('counts');
    // The board leaves the sentence out at the gate (its dates line says when
    // the truck came), so the hint has its own line there — the fixes'
    // review found the board saying «Tushirildi, yopilmagan» and nothing else.
    const card = readFileSync('src/app/(protected)/batches/board-card.tsx', 'utf8');
    expect(card).toContain("{card.status === 'arrived' && words.gateHint(card.road) && (");
    expect(card).toContain('data-testid="board-gate-hint"');
  });

  it('the attention row says what the predicate counts: arrived 2+ days, not finished — not «not unloaded»', () => {
    // `isStuckAtGate` counts a truck nobody FINISHED, all of its cartons off
    // or not (the card's own word now says «Tushirildi, yopilmagan»).
    expect(read('uz').att.stuck).toBe('2 kundan beri tushirish yakunlanmagan fura: {n}');
    for (const l of ['uz', 'ru', 'en', 'zh-CN']) expect(read(l).att.stuck).not.toMatch(/tushirilmagan|не разгруж|unloaded for|未卸车/u);
  });
});

describe('a date on the road names what it was walked from', () => {
  it('the phone, the pin, or the schedule — a pin-walked date is not a «schedule estimate»', () => {
    expect(estimateBasis('gps')).toBe('gps');
    expect(estimateBasis('manual')).toBe('gps');
    expect(estimateBasis('pin')).toBe('pin');
    expect(estimateBasis('schedule')).toBe('schedule');
    expect(estimateBasis(null)).toBe('schedule');
    const src = readFileSync('src/components/truck-road.tsx', 'utf8');
    expect(src).toContain("pin: () => t('truckEstimatePin'),");
    expect(src).toContain('BASIS[\n            estimateBasis(row.source)\n          ]()');
  });
});

describe('the phone tabs over one DOM', () => {
  const page = readFileSync('src/app/(protected)/batches/page.tsx', 'utf8');

  it('a checked tab HIDES the other columns, only where :has() exists — never shows one over hidden ones', () => {
    // An old browser without :has() must draw the columns stacked, not
    // tabs over nothing (the review's finding 8): no column carries `hidden`.
    for (const col of ['forming', 'loading', 'arrived']) {
      expect(page).toContain(
        `max-xl:[&:has(#bt-${col}:checked)_[data-col]:not([data-col=${col}])]:hidden`,
      );
    }
    // Four tabs on a phone: the «Yo'lda» tab keeps BOTH road columns.
    expect(page).toContain(
      'max-xl:[&:has(#bt-road:checked)_[data-col]:not([data-col=inland]):not([data-col=outbound])]:hidden',
    );
    expect(page).toContain('{BOARD_TABS.map((tab) => (');
    // No selector names a column key with `_`: Tailwind reads `_` in an
    // arbitrary variant as a space, and `#bt-road_cn` would select nothing.
    const start = page.indexOf('const TAB_HIDES =');
    const hides = page.slice(start, page.indexOf("';", start));
    expect(hides.length).toBeGreaterThan(100);
    expect(hides).not.toMatch(/#bt-[a-z]+_[a-z]/);
    expect(hides).not.toMatch(/data-col=[a-z]+_[a-z]/);
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

describe('a truck on the road that the map cannot draw is named, never dropped', () => {
  it('/map names both kinds under the canvas, and «no trucks» waits for both lists', () => {
    const page = readFileSync('src/app/(protected)/map/page.tsx', 'utf8');
    expect(page).toContain('if (truck?.placed) trucks.push(truck);');
    expect(page).toContain('else unplaced.push({ batchId: batch.id, code: batch.code });');
    const map = readFileSync('src/app/(protected)/map/tracking-map.tsx', 'utf8');
    expect(map).toContain("trucks.length === 0 && unplacedCount === 0 && !full");
    // The customer's map says «estimated» only about a point it drew.
    const cab = readFileSync('src/components/cabinet-map.tsx', 'utf8');
    expect(cab).toContain("{p.kind === 'truck' && p.point && (");
  });
});

describe('who may pin from the board — his answer «1 hozirgidek qolsin» (2026-10-20)', () => {
  it('the board’s ⋯ asks the Mashina tab’s own permission, and the pin service the same', () => {
    // As now: the board adds no power. Whoever may set a pin on the truck's
    // Mashina tab — the logist and the warehouse staff at either end, by the
    // card's door the service also asks — may set it from the board.
    const board = readFileSync('src/modules/wms/batches/board.ts', 'utf8');
    const mashina = readFileSync('src/app/(protected)/batches/[id]/mashina/page.tsx', 'utf8');
    const service = readFileSync('src/modules/wms/tracking/checkpoint.ts', 'utf8');
    expect(board).toContain("const mayPin = actor.permissions.has('batches.vehicle_info');");
    expect(mashina).toContain("actor.permissions.has('batches.vehicle_info')");
    expect(service).toContain("if (!actor.permissions.has('batches.vehicle_info')) throw new CheckpointError('forbidden');");
    expect(service).toContain('assertOnBatchCard(actor, batch);');
  });

  it('the seeded roles that pin are the logist and the warehouse staff — not narrowed to the logist', () => {
    const holders = (Object.keys(ROLE_MATRIX) as (keyof typeof ROLE_MATRIX)[]).filter((role) =>
      ROLE_MATRIX[role].includes('batches.vehicle_info'),
    );
    expect(holders).toEqual(expect.arrayContaining(['logist', 'warehouse_manager', 'warehouse_operator']));
    expect(holders).not.toContain('sales_manager');
    expect(holders).not.toContain('ved_manager');
  });
});
