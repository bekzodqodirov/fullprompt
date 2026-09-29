import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cargoStage, truckStage, type StageBatch } from '@/modules/wms/client-cabinet/stages';
import { etaWindow, isGenericRoute, scheduleEstimate } from '@/modules/wms/tracking/eta';
import { routeFor } from '@/modules/wms/tracking/map-data';
import {
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
    // A generic route is now «no schedule» (eta.ts), so a truck there with a
    // phone fix reaches the popup with remainingDays [0, 0] and progress 0.
    const src = stripComments(readFileSync('src/app/(protected)/map/tracking-map.tsx', 'utf8'));
    expect(src).toContain('selTruck.remainingDays[1] > 0');
    expect(src).toMatch(/selTruck\.routePoints\.length > 0 && \(\s*<div className="h-2 overflow-hidden/);
  });
});
