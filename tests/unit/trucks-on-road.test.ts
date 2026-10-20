import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cargoStage, truckStage, type StageBatch } from '@/modules/wms/client-cabinet/stages';
import { etaWindow, isGenericRoute, scheduleEstimate } from '@/modules/wms/tracking/eta';
import { routeFor, WAREHOUSE_POINTS } from '@/modules/wms/tracking/map-data';
import {
  gateWord,
  isStuckAtGate,
  rankTrucks,
  STUCK_AT_GATE_DAYS,
  truckRow,
  type TruckInput,
} from '@/modules/wms/tracking/on-road-state';
import { tashkentDay } from '@/modules/platform/time/tashkent';

/**
 * The trucks card's sentences, decided without a database (round B). The
 * oracle is always the assembler the map and the cabinet already read
 * (`scheduleEstimate`/`etaWindow`, `cargoStage`), never a number restated
 * here — a restated number would agree with a wrong rule (#166).
 */

const HOUR = 3_600_000;
// 09:00 in Tashkent on the 27th — the office's morning.
const NOW = new Date('2026-08-27T04:00:00.000Z');
const TODAY = tashkentDay(NOW);
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

const input = (over: Partial<TruckInput> = {}): TruckInput => ({
  id: 'b-1',
  code: 'B-001',
  originCode: 'YW',
  originName: 'Yiwu',
  originCountry: 'CN',
  destCode: 'TAS1',
  destName: 'Toshkent',
  destCountry: 'UZ',
  status: 'in_transit',
  departedAt: ago(72),
  arrivedAt: null,
  trackingCheckpoint: null,
  customsClearedAt: null,
  boxCount: 40,
  ...over,
});

describe('truckRow — one truck, one honest row', () => {
  it('a truck on the road reads the ONE assembler: the same % and the same window', () => {
    const row = truckRow(input(), NOW, TODAY, {});
    const s = scheduleEstimate('YW', 'TAS1', ago(72), null, {}, NOW)!;
    expect(row.kind).toBe('on_road');
    expect(row.stage).toBe('export_transit');
    expect(row.roadPct).toBe(Math.round(s.est.progress * 100));
    expect(row.eta).toEqual(etaWindow(s.est, NOW));
    expect(row.days).toBe(3);
    expect(row.departedBoxes).toBe(40);
    // Not asked yet — «not asked» is null, never a zero.
    expect(row.awaitingUnload).toBeNull();
    expect(row.lastPositionAt).toBeNull();
  });

  it('a generic straight-line route is NO schedule: no %, no date', () => {
    // YW → GZ is two mapped warehouses nobody wrote timings for: routeFor
    // hands back a straight line at a placeholder 120-168 h. It is a MOVING
    // rung (cn_transit), so only the generic-route refusal keeps a date off it.
    expect(isGenericRoute(routeFor('YW', 'GZ')!)).toBe(true);
    const row = truckRow(
      input({ destCode: 'GZ', destName: 'Guangzhou', destCountry: 'CN', departedAt: ago(24) }),
      NOW,
      TODAY,
      {},
    );
    expect(row.stage).toBe('cn_transit');
    expect(row.kind).toBe('no_schedule');
    expect(row.roadPct).toBeNull();
    expect(row.eta).toBeNull();
    expect(row.arrivalOrder).toBeNull();
  });

  it('an unmapped pair and a missing departure are no schedule too — null, never 0', () => {
    expect(truckRow(input({ originCode: 'QOQ', destCode: 'NAM' }), NOW, TODAY, {})).toMatchObject({
      kind: 'no_schedule',
      roadPct: null,
      eta: null,
    });
    expect(truckRow(input({ departedAt: null }), NOW, TODAY, {})).toMatchObject({
      kind: 'no_schedule',
      roadPct: null,
      days: 0,
    });
  });

  it('past its schedule: overdue, and then it says nothing about a date', () => {
    const row = truckRow(input({ destCode: 'KA', destName: 'Qashqar', destCountry: 'CN', departedAt: ago(400) }), NOW, TODAY, {});
    expect(scheduleEstimate('YW', 'KA', ago(400), null, {}, NOW)!.est.overdue).toBe(true);
    expect(row.kind).toBe('overdue');
    expect(row.eta).toBeNull();
    expect(row.roadPct).toBeNull();
    // 400 h before 09:00 on the 27th is 17:00 on the 10th, Tashkent time.
    expect(row.days).toBe(17);
  });

  it('a truck pinned in Uzbekistan has a bar but no date — the customer is shown none', () => {
    const row = truckRow(
      input({
        originCode: 'KA',
        originName: 'Qashqar',
        departedAt: ago(200),
        trackingCheckpoint: { key: 'in_uz', at: ago(3).toISOString() },
      }),
      NOW,
      TODAY,
      {},
    );
    expect(row.stage).toBe('in_uz');
    expect(row.kind).toBe('on_road');
    expect(row.roadPct).not.toBeNull();
    expect(row.eta).toBeNull();
    // Ordered by the hidden schedule all the same.
    expect(row.arrivalOrder).toBe(
      scheduleEstimate('KA', 'TAS1', ago(200), { key: 'in_uz', at: ago(3).toISOString() }, {}, NOW)!.est
        .remainingHours[0],
    );
    // The customs stamp moves the rung, as it does in the cabinet.
    const cleared = truckRow(
      input({
        originCode: 'KA',
        departedAt: ago(200),
        trackingCheckpoint: { key: 'in_uz', at: ago(3).toISOString() },
        customsClearedAt: ago(1),
      }),
      NOW,
      TODAY,
      {},
    );
    expect(cleared.stage).toBe('customs_done');
    expect(cleared.eta).toBeNull();
  });

  it('a pin is dated in TASHKENT days: 25th 20:30Z seen on the 27th 04:00Z is one day', () => {
    // 20:30Z on the 25th is 01:30 on the 26th in Tashkent — a UTC slice of the
    // pin would say two days and put the border wait a day early.
    const row = truckRow(
      input({
        originCode: 'KA',
        departedAt: ago(100),
        trackingCheckpoint: { key: 'at_border', at: '2026-08-25T20:30:00.000Z' },
      }),
      NOW,
      TODAY,
      {},
    );
    expect(row.checkpoint).toEqual({ key: 'at_border', at: '2026-08-25T20:30:00.000Z' });
    expect(row.pinDays).toBe(1);
  });

  it('a Horgos truck is on the road with a date, and its Kazakh pin survives', () => {
    // Before the Horgos round HOR → TAS1 was a generic straight line
    // («no_schedule»), and the card's three-key list dropped every `in_kz`.
    const row = truckRow(
      input({
        originCode: 'HOR',
        originName: 'Horgos',
        departedAt: ago(100),
        trackingCheckpoint: { key: 'in_kz', at: ago(5).toISOString() },
      }),
      NOW,
      TODAY,
      {},
    );
    expect(row.kind).toBe('on_road');
    expect(row.checkpoint).toEqual({ key: 'in_kz', at: ago(5).toISOString() });
    expect(row.eta).not.toBeNull();
    // …while a Kyrgyz pin left on the same Kazakh road is no position.
    const stray = truckRow(
      input({ originCode: 'HOR', departedAt: ago(100), trackingCheckpoint: { key: 'in_kg', at: ago(5).toISOString() } }),
      NOW,
      TODAY,
      {},
    );
    expect(stray.checkpoint).toBeNull();
  });

  it('a pin with a key the batch card never writes is not a checkpoint', () => {
    const row = truckRow(input({ trackingCheckpoint: { key: 'somewhere', at: ago(5).toISOString() } }), NOW, TODAY, {});
    expect(row.checkpoint).toBeNull();
    expect(row.pinDays).toBeNull();
  });

  it('at the gate: days count from ARRIVAL, stuck from STUCK_AT_GATE_DAYS, no stage', () => {
    const arrived = (hoursAgo: number) =>
      input({ status: 'arrived', departedAt: ago(400), arrivedAt: ago(hoursAgo), awaitingUnload: 7 });
    const fresh = truckRow(arrived(20), NOW, TODAY, {});
    expect(fresh).toMatchObject({ kind: 'unloading', status: 'arrived', stage: null, days: 1, awaitingUnload: 7 });
    expect(fresh.roadPct).toBeNull();
    expect(fresh.eta).toBeNull();
    const stuck = truckRow(arrived(STUCK_AT_GATE_DAYS * 24 + 2), NOW, TODAY, {});
    expect(stuck.kind).toBe('stuck');
    expect(stuck.days).toBe(STUCK_AT_GATE_DAYS);
    // The attention list's predicate and the card's chip are one rule.
    expect(isStuckAtGate({ status: 'arrived', arrivedAt: ago(20) }, TODAY)).toBe(false);
    expect(isStuckAtGate({ status: 'arrived', arrivedAt: ago(STUCK_AT_GATE_DAYS * 24 + 2) }, TODAY)).toBe(true);
    expect(isStuckAtGate({ status: 'in_transit', arrivedAt: ago(200) }, TODAY)).toBe(false);
  });

  it('an unload count on a truck still on the road is not carried', () => {
    expect(truckRow(input({ awaitingUnload: 5 }), NOW, TODAY, {}).awaitingUnload).toBeNull();
  });
});

describe('truckStage — the cabinet ladder, extracted, not restated', () => {
  const batches: StageBatch[] = [
    { originCountry: 'CN', destCountry: 'CN', status: 'in_transit', checkpointKey: null, customsCleared: false },
    { originCountry: 'CN', destCountry: 'UZ', status: 'in_transit', checkpointKey: null, customsCleared: false },
    { originCountry: 'CN', destCountry: 'UZ', status: 'in_transit', checkpointKey: 'in_uz', customsCleared: false },
    { originCountry: 'CN', destCountry: 'UZ', status: 'arrived', checkpointKey: null, customsCleared: true },
    { originCountry: 'UZ', destCountry: 'UZ', status: 'in_transit', checkpointKey: null, customsCleared: false },
    { originCountry: 'UZ', destCountry: 'CN', status: 'in_transit', checkpointKey: null, customsCleared: false },
    { originCountry: 'CN', destCountry: 'UZ', status: 'in_transit', checkpointKey: 'at_border', customsCleared: false },
  ];
  it('says of the truck what cargoStage says of every box riding it', () => {
    for (const b of batches) {
      expect(truckStage(b)).toBe(cargoStage('in_transit', { country: null, type: null }, b));
    }
  });
});

describe('rankTrucks — what needs a person first', () => {
  it('stuck, overdue, unloading, the road by soonest arrival, then the unplaceable', () => {
    const rows = [
      truckRow(input({ id: 'ns', code: 'B-NS', destCode: 'GZ', destCountry: 'CN', departedAt: ago(30) }), NOW, TODAY, {}),
      truckRow(input({ id: 'far', code: 'B-FAR', departedAt: ago(10) }), NOW, TODAY, {}),
      truckRow(input({ id: 'near', code: 'B-NEAR', originCode: 'KA', departedAt: ago(100) }), NOW, TODAY, {}),
      truckRow(input({ id: 'unl', code: 'B-UNL', status: 'arrived', arrivedAt: ago(5) }), NOW, TODAY, {}),
      truckRow(input({ id: 'late', code: 'B-LATE', destCode: 'KA', destCountry: 'CN', departedAt: ago(400) }), NOW, TODAY, {}),
      truckRow(input({ id: 'stuck2', code: 'B-S2', status: 'arrived', arrivedAt: ago(50) }), NOW, TODAY, {}),
      truckRow(input({ id: 'stuck5', code: 'B-S5', status: 'arrived', arrivedAt: ago(122) }), NOW, TODAY, {}),
    ];
    expect(rankTrucks(rows).map((r) => r.id)).toEqual([
      'stuck5',
      'stuck2',
      'late',
      'unl',
      'near',
      'far',
      'ns',
    ]);
    // It sorts a copy; the caller's list keeps its order.
    expect(rows[0]!.id).toBe('ns');
  });

  it('breaks a tie by code, so a re-render never shuffles two equal rows', () => {
    const a = truckRow(input({ id: 'x', code: 'B-002', status: 'arrived', arrivedAt: ago(5) }), NOW, TODAY, {});
    const b = truckRow(input({ id: 'y', code: 'B-001', status: 'arrived', arrivedAt: ago(6) }), NOW, TODAY, {});
    expect(rankTrucks([a, b]).map((r) => r.code)).toEqual(['B-001', 'B-002']);
  });
});

describe('the trucks card estimates nothing of its own', () => {
  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('on-road.ts goes through eta.ts and never through truckFor or routeFor', () => {
    const src = stripComments(readFileSync('src/modules/wms/tracking/on-road.ts', 'utf8'));
    expect(src).not.toContain('truckFor(');
    expect(src).not.toContain('routeFor(');
    expect(src).not.toContain('estimateTransit(');
    expect(src).not.toContain('scheduleEstimate(');
    expect(src).toContain('truckRow(');
    const state = stripComments(readFileSync('src/modules/wms/tracking/on-road-state.ts', 'utf8'));
    expect(state).toContain("from './eta'");
    expect(state).not.toContain('routeFor(');
    expect(state).not.toContain('estimateTransit(');
  });

  it('cargoStage asks truckStage — the ladder is written once', () => {
    const src = stripComments(readFileSync('src/modules/wms/client-cabinet/stages.ts', 'utf8'));
    expect(src).toMatch(/if \(status === 'in_transit'\) return batch \? truckStage\(batch\)/);
    expect(src.match(/checkpointKey === 'in_uz'/g)).toHaveLength(1);
  });

  it('the map popup says no «~0–0 kun» and draws no bar for a truck with no schedule', () => {
    // A generic route is «no schedule» (eta.ts), so a truck there with a
    // phone fix reaches the popup with no % and no date — and a truck pinned
    // in Uzbekistan has a % but no date (O15). The marker says both
    // (`progress: null`, `dated`), and the popup asks exactly that.
    const src = stripComments(readFileSync('src/app/(protected)/map/tracking-map.tsx', 'utf8'));
    expect(src).toMatch(/: selTruck\.dated\s*\?/);
    expect(src).toMatch(/selTruck\.progress !== null && \(\s*<div className="h-2 overflow-hidden/);
  });
});

describe('a truck at its gate, and a truck due now, read alike on every screen', () => {
  const ka = routeFor('KA', 'TAS1')!;
  const gate = ka.points[ka.points.length - 1]!;
  const fix = (p: { x: number; y: number }, hoursAgo: number, gateSinceH: number | null = null) => ({
    lat: p.y,
    lon: p.x,
    recordedAt: ago(hoursAgo),
    source: 'device',
    gateSince: gateSinceH === null ? null : ago(gateSinceH),
  });
  const kaInput = (over: Partial<TruckInput>) =>
    input({ originCode: 'KA', originName: 'Kashgar', ...over });

  it('the phone at the yard: on the road, first in the list, no date — and the word says so', () => {
    const row = truckRow(kaInput({ departedAt: ago(75), fix: fix(gate, 2) }), NOW, TODAY, {});
    expect(row.kind).toBe('on_road');
    expect(row.atGate).toBe(true);
    expect(row.eta).toBeNull();
    expect(row.arrivalOrder).toBe(0);
    const src = readFileSync('src/components/truck-road.tsx', 'utf8');
    expect(src).toContain("? t('truckAtGate')");
  });

  it('stuck on the arrived truck’s own clock: STUCK_AT_GATE_DAYS Tashkent days since the phone first put it there', () => {
    // 300 h out — far past his slowest schedule — and in the yard 3 minutes:
    // on time, first in the list (the fourth recheck: «overdue» on arrival).
    const pulledIn = truckRow(kaInput({ departedAt: ago(300), fix: fix(gate, 0.05, 0.05) }), NOW, TODAY, {});
    expect(pulledIn).toMatchObject({ kind: 'on_road', atGate: true, arrivalOrder: 0, gateDays: 0 });
    const dayOne = truckRow(kaInput({ departedAt: ago(300), fix: fix(gate, 1, 30) }), NOW, TODAY, {});
    expect(dayOne).toMatchObject({ kind: 'on_road', gateDays: 1 });
    const stood = truckRow(kaInput({ departedAt: ago(300), fix: fix(gate, 1, 50) }), NOW, TODAY, {});
    expect(stood).toMatchObject({ kind: 'stuck', atGate: true, gateDays: 2, eta: null, arrivalOrder: null });
    expect(gateWord(stood)).toBe('stuck');
    // A road nobody modelled has a yard too: stuck there, not «no schedule».
    const internal = input({ originCode: 'TAS1', destCode: 'AND', originCountry: 'UZ', destCountry: 'UZ', departedAt: ago(80) });
    const and = WAREHOUSE_POINTS.AND!;
    expect(truckRow({ ...internal, fix: fix(and, 1, 50) }, NOW, TODAY, {})).toMatchObject({ kind: 'stuck', atGate: true });
    expect(truckRow({ ...internal, fix: fix(and, 1, 1) }, NOW, TODAY, {})).toMatchObject({ kind: 'on_road', atGate: true });
    // «O'zbekistonda» pressed after the phone reached that Uzbek yard agrees
    // with it: still at the gate, still stuck (the fifth recheck — it read
    // «no schedule» and left the count).
    const pressed = { trackingCheckpoint: { key: 'in_uz', at: ago(2).toISOString() } };
    expect(truckRow({ ...internal, ...pressed, fix: fix(and, 20, 80) }, NOW, TODAY, {})).toMatchObject({
      kind: 'stuck',
      atGate: true,
      gateDays: 3,
    });
    // The same days by the scan: the attention row's own predicate agrees.
    expect(isStuckAtGate({ status: 'arrived', arrivedAt: ago(50) }, TODAY)).toBe(true);
    expect(isStuckAtGate({ status: 'arrived', arrivedAt: ago(30) }, TODAY)).toBe(false);
    // The sentence says how long it has stood, and the unloading to check.
    const src = readFileSync('src/components/truck-road.tsx', 'utf8');
    expect(src).toContain("parts.push(t('truckAtGateDays', { n: row.gateDays }));");
    expect(src).toMatch(/if \(row\.kind === 'stuck'\) \{\s*parts\.push\(\s*<span key="stuck" className="font-semibold text-warn">\s*\{t\('truckAtGateStuck'\)\}/);
  });

  it('the first unload scan does not restart the clock: an arrived truck stood since the phone had it in the yard', () => {
    // Four days in the yard by the phone, then one carton scanned this minute.
    const scanned = kaInput({
      status: 'arrived',
      departedAt: ago(300),
      arrivedAt: NOW,
      awaitingUnload: 299,
      yardSince: ago(96),
    });
    // Stuck by the yard time; «Keldi» is still the scan (`days`), and the
    // yard days are their own fact — never a date that moves (the seventh
    // recheck: every printed arrival date contradicted another once it did).
    expect(truckRow(scanned, NOW, TODAY, {})).toMatchObject({ kind: 'stuck', days: 0, yardFrom: ago(96), stoodSince: ago(96) });
    // A past fact: days later, unloaded or gone, it still names the same day.
    const later = new Date(NOW.getTime() + 7 * 24 * 3_600_000);
    expect(truckRow({ ...scanned, awaitingUnload: 0 }, later, tashkentDay(later), {}).yardFrom).toEqual(ago(96));
    // With no phone the scan is the clock, as it always was.
    expect(truckRow({ ...scanned, yardSince: null }, NOW, TODAY, {})).toMatchObject({
      kind: 'unloading',
      days: 0,
      yardFrom: null,
    });
    // The arrived truck's newest fix is not its clock — only the yard time is.
    expect(truckRow({ ...scanned, yardSince: null, fix: fix(gate, 1, 96) }, NOW, TODAY, {})).toMatchObject({
      days: 0,
      yardFrom: null,
    });
    // A phone reading later than the scan never shortens it, and says nothing.
    expect(truckRow({ ...scanned, arrivedAt: ago(72), yardSince: ago(1) }, NOW, TODAY, {})).toMatchObject({
      kind: 'stuck',
      days: 3,
      yardFrom: null,
    });
    // An hour before the scan, the same day: nothing to say apart.
    expect(truckRow({ ...scanned, yardSince: new Date(NOW.getTime() - 3_600_000) }, NOW, TODAY, {})).toMatchObject({
      yardFrom: null,
    });
    // The words: «Keldi» from the scan, the yard days beside it.
    const src = readFileSync('src/components/truck-road.tsx', 'utf8');
    expect(src).toContain(
      "row.status === 'arrived' && row.yardFrom ? t('truckYardFrom', { date: etaDay(row.yardFrom.toISOString()) }) : null",
    );
    expect(src).toMatch(/parts\.push\(t\('arrivedDays', \{ n: row\.days \}\)\);\s*const stood = yard\(row\);\s*if \(stood\) parts\.push\(stood\);/);
  });

  it('stuck trucks rank by how long they have STOOD, not by days on the road', () => {
    const byScan = truckRow(kaInput({ id: 'a', code: 'A', status: 'arrived', departedAt: ago(216), arrivedAt: ago(120) }), NOW, TODAY, {});
    expect(byScan.stoodSince).toEqual(ago(120));
    const byPhone = truckRow(kaInput({ id: 'b', code: 'B', departedAt: ago(216), fix: fix(gate, 1, 50) }), NOW, TODAY, {});
    expect([byScan.kind, byPhone.kind]).toEqual(['stuck', 'stuck']);
    expect(rankTrucks([byPhone, byScan]).map((r) => r.code)).toEqual(['A', 'B']);
    // Waiting to be unloaded, not yet stuck: by how long each has stood, the
    // board's own order — a phone's yard fix yesterday morning beats a scan
    // yesterday afternoon though its scan came this morning (the eighth recheck).
    const scannedYesterday = truckRow(
      kaInput({ id: 'c', code: 'C', status: 'arrived', departedAt: ago(216), arrivedAt: ago(14) }),
      NOW,
      TODAY,
      {},
    );
    const yardYesterday = truckRow(
      kaInput({ id: 'd', code: 'D', status: 'arrived', departedAt: ago(216), arrivedAt: ago(1), yardSince: ago(22) }),
      NOW,
      TODAY,
      {},
    );
    expect([scannedYesterday.kind, yardYesterday.kind]).toEqual(['unloading', 'unloading']);
    expect(rankTrucks([scannedYesterday, yardYesterday]).map((r) => r.code)).toEqual(['D', 'C']);
    // Two at their gates by the phone, not yet stuck: by how long each has
    // stood, never by the plate code (the ninth recheck).
    const longer = truckRow(kaInput({ id: 'z', code: 'Z-99', departedAt: ago(216), fix: fix(gate, 1, 30) }), NOW, TODAY, {});
    const fresh = truckRow(kaInput({ id: 'y', code: 'A-00', departedAt: ago(216), fix: fix(gate, 0.1, 0.2) }), NOW, TODAY, {});
    expect([longer.kind, fresh.kind]).toEqual(['on_road', 'on_road']);
    expect(rankTrucks([fresh, longer]).map((r) => r.code)).toEqual(['Z-99', 'A-00']);
    // The yard line is a past event in every language — never «in the yard
    // since», which the phone no longer reads once the truck is scanned.
    for (const locale of ['uz', 'ru', 'en', 'zh-CN']) {
      const text = (JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as { dashboard: Record<string, string> })
        .dashboard.truckYardFrom!;
      expect(text, locale).toContain('{date}');
      expect(text, locale).not.toMatch(/во дворе с|in the yard (from|since)|hovlida .* beri/);
    }
  });

  it('due NOW ([0, 0]) prints no date: the board, the cabinet and the map ask one rule', () => {
    // 12 km out, two hours ago: its slowest pace is spent, one reporting
    // window is not. A date here would be «today», renewed every morning.
    const prev = ka.points[ka.points.length - 2]!;
    const len = Math.hypot(prev.x - gate.x, prev.y - gate.y);
    const before = { x: gate.x + ((prev.x - gate.x) / len) * 0.11, y: gate.y + ((prev.y - gate.y) / len) * 0.11 };
    const row = truckRow(kaInput({ departedAt: ago(70), fix: fix(before, 2) }), NOW, TODAY, {});
    expect(row.kind).toBe('on_road');
    expect(row.atGate).toBe(false);
    expect(row.eta).toBeNull();
    for (const file of [
      'src/modules/wms/tracking/on-road-state.ts',
      'src/modules/wms/client-cabinet/service.ts',
      'src/modules/wms/tracking/truck.ts',
    ]) {
      expect(readFileSync(file, 'utf8')).toContain('placeDated(place)');
    }
  });
});
