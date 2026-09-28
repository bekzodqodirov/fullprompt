import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  capRows,
  foldCargoNow,
  SECTION_ROW_CAP,
  waitingDays,
  type FoldArrival,
  type FoldRow,
  type FoldTruck,
} from '@/modules/wms/inventory/client-cargo-fold';
import { foldPairArrivals } from '@/modules/wms/documents/arrivals';
import { readHistoryDays } from '@/modules/wms/client-card/history-window';
import { CLIENT_ACTIVE_STATUSES } from '@/modules/wms/boxes/active';
import { daysSince } from '@/modules/wms/reports/dashboard-math';

/**
 * The client card's «Yuklar» tab, folded with no database and no clock of
 * its own (#166). Every expectation is written down as the owner reads it —
 * a literal section, a literal count, a literal kilo — and never recomputed
 * with the function under test.
 */

const TODAY = '2026-09-28';
const CN = { whCountry: 'CN', whType: 'origin' };
const HUB = { whCountry: 'CN', whType: 'hub' };
const UZ = { whCountry: 'UZ', whType: 'distribution' };

function row(over: Partial<FoldRow>): FoldRow {
  return {
    clientId: 'c1',
    lotId: 'lot-1',
    letter: 'A',
    productZh: '玩具',
    productRu: 'Oyinchoq',
    lotBoxes: 10,
    lotKg: '100',
    lotM3: '1',
    receiptId: 'r1',
    receiptNumber: 'YW-IN-1',
    receivedAt: new Date('2026-08-19T06:00:00Z'),
    receiptWarehouseId: 'wh-yw',
    marking: null,
    status: 'in_stock',
    warehouseId: 'wh-yw',
    whCode: 'YW',
    whName: 'Yiwu',
    whCountry: 'CN',
    whType: 'origin',
    batchId: null,
    n: 1,
    missing: 0,
    ...over,
  };
}

function truck(id: string, code: string, stage: Partial<FoldTruck['stage']>): FoldTruck {
  return {
    id,
    code,
    stage: {
      originCountry: 'CN',
      destCountry: 'UZ',
      status: 'in_transit',
      checkpointKey: null,
      customsCleared: false,
      ...stage,
    },
  };
}

const TRUCKS = new Map<string, FoldTruck>([
  ['t-cn', truck('t-cn', 'YW-001', { destCountry: 'CN' })],
  ['t-export', truck('t-export', 'KA-001', {})],
  ['t-pinned', truck('t-pinned', 'KA-002', { checkpointKey: 'in_uz' })],
  ['t-arrived', truck('t-arrived', 'KA-003', { status: 'arrived' })],
  ['t-unloaded', truck('t-unloaded', 'KA-004', { status: 'unloaded' })],
  ['t-forming', truck('t-forming', 'YW-002', { status: 'forming' })],
]);

describe('each carton lands in the customer’s own step — the whole ladder', () => {
  // Written from the owner's ladder and the Mini App's five steps, not from
  // `milestoneOf`: the office and the phone the client holds must agree.
  const CASES: [string, Partial<FoldRow>, string][] = [
    ['on a Chinese shelf', { status: 'in_stock', ...CN }, 'china'],
    ['planned onto a truck in China', { status: 'planned', batchId: 't-forming', ...CN }, 'china'],
    ['being loaded in China', { status: 'loading', batchId: 't-forming', ...CN }, 'china'],
    ['at the Kashgar hub', { status: 'in_stock', ...HUB, whCode: 'KA' }, 'transit'],
    ['planned out of the hub', { status: 'planned', batchId: 't-forming', ...HUB, whCode: 'KA' }, 'transit'],
    ['on the road inside China', { status: 'in_transit', batchId: 't-cn', warehouseId: null }, 'transit'],
    ['on the export road', { status: 'in_transit', batchId: 't-export', warehouseId: null }, 'transit'],
    ['on a truck the logist pinned in Uzbekistan', { status: 'in_transit', batchId: 't-pinned', warehouseId: null }, 'uz'],
    ['on a truck standing at its Uzbek gate', { status: 'in_transit', batchId: 't-arrived', warehouseId: null }, 'uz'],
    ['landed in Uzbekistan, not yet released', { status: 'in_stock', ...UZ, warehouseId: 'wh-tas', whCode: 'TAS1' }, 'uz'],
    ['at the door, ready', { status: 'ready_for_pickup', ...UZ, warehouseId: 'wh-tas', whCode: 'TAS1' }, 'ready'],
  ];
  for (const [what, over, section] of CASES) {
    it(`${what} → ${section}`, () => {
      const now = foldCargoNow([row(over)], TRUCKS, null, TODAY);
      expect(now.sections[section as 'china'].rows.map((r) => r.n)).toEqual([1]);
      expect(now.total.boxes).toBe(1);
    });
  }
});

describe('one row per lot and place, with the status split named', () => {
  it('«omborda 3 · rejada 2 → YW-002» is ONE row of five', () => {
    const now = foldCargoNow(
      [row({ status: 'in_stock', n: 3 }), row({ status: 'planned', batchId: 't-forming', n: 2 })],
      TRUCKS,
      null,
      TODAY,
    );
    const [only, ...rest] = now.sections.china.rows;
    expect(rest).toEqual([]);
    expect(only!.n).toBe(5);
    expect(only!.parts).toEqual([
      { status: 'in_stock', truckId: null, n: 3 },
      { status: 'planned', truckId: 't-forming', n: 2 },
    ]);
  });

  it('the same lot in two warehouses is two rows', () => {
    const now = foldCargoNow(
      [row({ n: 1 }), row({ n: 1, ...UZ, warehouseId: 'wh-tas', whCode: 'TAS1' })],
      TRUCKS,
      null,
      TODAY,
    );
    expect(now.sections.china.rows).toHaveLength(1);
    expect(now.sections.uz.rows).toHaveLength(1);
  });
});

describe('kilos are the lot’s share, and a Σ is the lines as printed', () => {
  it('7 of 20 boxes of a 10.1 kg lot read 3.54 — the Mini App’s figure', () => {
    const now = foldCargoNow(
      [row({ status: 'ready_for_pickup', ...UZ, warehouseId: 'wh-tas', whCode: 'TAS1', lotBoxes: 20, lotKg: '10.1', n: 7 })],
      TRUCKS,
      null,
      TODAY,
    );
    expect(now.sections.ready.rows[0]!.kg).toBe(3.54);
  });

  it('two such rows sum to 7.08 — never the 7.07 of the raw shares', () => {
    const lot = { lotBoxes: 20, lotKg: '10.1', n: 7 };
    const now = foldCargoNow(
      [
        row({ ...lot, lotId: 'lot-a' }),
        row({ ...lot, lotId: 'lot-b', ...UZ, warehouseId: 'wh-tas', whCode: 'TAS1' }),
      ],
      TRUCKS,
      null,
      TODAY,
    );
    expect(now.total.kg).toBe(7.08);
    expect(now.sections.china.total.kg + now.sections.uz.total.kg).toBe(7.08);
  });

  it('a lot nobody weighed prints no kilos — never a 0 that was not measured', () => {
    const now = foldCargoNow([row({ lotKg: null, lotM3: null })], TRUCKS, null, TODAY);
    expect(now.sections.china.rows[0]!.kg).toBeNull();
    expect(now.sections.china.rows[0]!.m3).toBeNull();
  });
});

describe('cartons an unload declared missing are said apart, never «O‘zbekistonda»', () => {
  it('two of three on an unloaded truck are counted; the third is its own line, out of the Σ', () => {
    const now = foldCargoNow(
      [row({ status: 'in_transit', batchId: 't-unloaded', warehouseId: null, n: 3, missing: 1 })],
      TRUCKS,
      null,
      TODAY,
    );
    expect(now.sections.uz.total.boxes).toBe(2);
    expect(now.total.boxes).toBe(2);
    expect(now.missing).toEqual([{ truckId: 't-unloaded', n: 1 }]);
  });
});

describe('days here are counted from the day the cargo reached THIS warehouse', () => {
  const arrival: FoldArrival = { codes: ['KA-003'], batchIds: ['t-arrived'], since: new Date('2026-09-23T05:00:00Z') };
  const tas = { ...UZ, warehouseId: 'wh-tas', whCode: 'TAS1' };

  it('a lot forty days out of Yiwu and five in Tashkent has waited five', () => {
    const arrivals = new Map([['lot-1|wh-tas', arrival]]);
    const now = foldCargoNow([row(tas)], TRUCKS, arrivals, TODAY);
    expect(now.sections.uz.rows[0]!.days).toBe(5);
    expect(now.sections.uz.rows[0]!.arrivedOn).toEqual([{ id: 't-arrived', code: 'KA-003' }]);
  });

  it('cargo that never moved is dated by its prixod; an unknown arrival is unknown', () => {
    // Received in Yiwu on 2026-08-19, still there.
    expect(waitingDays(undefined, row({}), TODAY)).toBe(40);
    // Standing somewhere it was not received, with no arrival found.
    expect(waitingDays(undefined, row({ warehouseId: 'wh-tas' }), TODAY)).toBeNull();
  });

  it('with no arrivals read at all (the summary line) nothing is dated', () => {
    const now = foldCargoNow([row(tas)], TRUCKS, null, TODAY);
    expect(now.sections.uz.rows[0]!.days).toBeNull();
  });

  it('the longest wait comes first within a place', () => {
    const arrivals = new Map([
      ['lot-a|wh-tas', { ...arrival, since: new Date('2026-09-26T05:00:00Z') }],
      ['lot-b|wh-tas', { ...arrival, since: new Date('2026-09-10T05:00:00Z') }],
    ]);
    const now = foldCargoNow(
      [row({ ...tas, lotId: 'lot-a', letter: 'A' }), row({ ...tas, lotId: 'lot-b', letter: 'B' })],
      TRUCKS,
      arrivals,
      TODAY,
    );
    expect(now.sections.uz.rows.map((r) => [r.letter, r.days])).toEqual([
      ['B', 18],
      ['A', 2],
    ]);
  });
});

describe('the arrival of what stands, folded', () => {
  it('`since` is the earliest landing of ANY kind; the trucks line up with their codes', () => {
    const folded = foldPairArrivals([
      { lotId: 'l', batchCode: 'KA-020', batchId: 'b20', arrivedAt: new Date('2026-09-20T00:00:00Z'), boxes: 2 },
      { lotId: 'l', batchCode: null, batchId: null, arrivedAt: new Date('2026-09-02T00:00:00Z'), boxes: 1 },
      { lotId: 'l', batchCode: 'KA-012', batchId: 'b12', arrivedAt: new Date('2026-09-12T00:00:00Z'), boxes: 3 },
    ]).get('l')!;
    expect(folded.codes).toEqual(['KA-012', 'KA-020']);
    expect(folded.batchIds).toEqual(['b12', 'b20']);
    expect(folded.since.toISOString()).toBe('2026-09-02T00:00:00.000Z');
    // The document's date stays the earliest TRUCKED landing (#645).
    expect(folded.arrivedAt.toISOString()).toBe('2026-09-12T00:00:00.000Z');
  });

  it('rows of several lots, interleaved, fold each lot from its own rows alone', () => {
    const folded = foldPairArrivals([
      { lotId: 'a', batchCode: 'KA-020', batchId: 'b20', arrivedAt: new Date('2026-09-20T00:00:00Z'), boxes: 2 },
      { lotId: 'b', batchCode: null, batchId: null, arrivedAt: new Date('2026-09-01T00:00:00Z'), boxes: 4 },
      { lotId: 'a', batchCode: 'KA-012', batchId: 'b12', arrivedAt: new Date('2026-09-12T00:00:00Z'), boxes: 3 },
      { lotId: 'b', batchCode: 'KA-030', batchId: 'b30', arrivedAt: new Date('2026-09-25T00:00:00Z'), boxes: 1 },
    ]);
    expect([...folded.keys()].sort()).toEqual(['a', 'b']);
    expect(folded.get('a')).toMatchObject({ codes: ['KA-012', 'KA-020'], batchIds: ['b12', 'b20'] });
    expect(folded.get('a')!.since.toISOString()).toBe('2026-09-12T00:00:00.000Z');
    expect(folded.get('b')).toMatchObject({ codes: ['KA-030'], batchIds: ['b30'] });
    expect(folded.get('b')!.since.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(folded.get('b')!.arrivedAt.toISOString()).toBe('2026-09-25T00:00:00.000Z');
  });
});

describe('a big client is drawn in slices', () => {
  it(`a section draws ${SECTION_ROW_CAP} rows and counts the rest; «toliq» draws them all`, () => {
    const many = Array.from({ length: 55 }, (_, i) => i);
    expect(capRows(many, false)).toEqual({ drawn: many.slice(0, 40), more: 15 });
    expect(capRows(many, true)).toEqual({ drawn: many, more: 0 });
    expect(SECTION_ROW_CAP).toBe(40);
  });
});

describe('the history window is exactly one of two', () => {
  it('90 by default, 365 when asked, and nothing else a URL can type', () => {
    expect(readHistoryDays(undefined)).toBe(90);
    expect(readHistoryDays('365')).toBe(365);
    expect(readHistoryDays(['365', '90'])).toBe(365);
    expect(readHistoryDays('100000')).toBe(90);
    expect(readHistoryDays('-1')).toBe(90);
    expect(readHistoryDays('abc')).toBe(90);
  });
});

/** Comments out, so a fence cannot match the sentence explaining it (#725). */
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('wiring no render test can see', () => {
  it('the truck sentence under ONE client’s row leaves out the truck-wide counts', () => {
    // «5 📦 … · 180 karobka jo'nadi» on one line reads as the client's number
    // (the tab's judge, finding 3).
    expect(code('src/components/client-cargo-now.tsx')).toContain('truckRoadWords({ counts: false })');
    const road = code('src/components/truck-road.tsx');
    expect(road).toMatch(/if \(counts\) parts\.push\(t\('truckDeparted'/);
    expect(road).toMatch(/if \(counts && \(row\.awaitingUnload \?\? 0\) > 0\)/);
  });

  it('the rows read carries no photograph — it is also the bot’s, on the sequential poller', () => {
    expect(code('src/modules/wms/inventory/client-cargo-now.ts')).not.toMatch(/attachments/);
    expect(code('src/modules/wms/bot/lookup.ts')).toContain('await clientCargoRows([client.id])');
  });

  it('the «still ours» statuses are written down in ONE place, in any order', () => {
    // Every literal list of quoted statuses is read as a SET: the dashboard's
    // pipeline held the same five as `…'ready_for_pickup', 'in_transit')`,
    // and an order-bound pattern walked past it. A list that goes on to name
    // `issued` (the schema's CHECK, the unpriced rule) is a different set.
    const want = [...CLIENT_ACTIVE_STATUSES].sort().join();
    const LIST = /[[(]\s*((?:(['"])[a-z_]+\2\s*,\s*)+(['"])[a-z_]+\3)\s*,?\s*[\])]/g;
    const holders = globSync('src/**/*.{ts,tsx}').filter((file) =>
      [...code(file).matchAll(LIST)].some(
        (m) => [...new Set([...m[1]!.matchAll(/['"]([a-z_]+)['"]/g)].map((x) => x[1]))].sort().join() === want,
      ),
    );
    expect(holders).toEqual(['src/modules/wms/boxes/active.ts']);
  });

  it('«declared missing on the road» is one fragment, asked by the tab and the dashboard’s risk card', () => {
    for (const file of ['src/modules/wms/inventory/client-cargo-now.ts', 'src/modules/wms/reports/business.ts']) {
      expect(code(file), file).toContain('declaredMissingSql(');
      expect(code(file), file).not.toContain('["missing_in_transit"]');
    }
  });
});

/**
 * «How many days has this carton waited here» — two halves, each with one
 * home, and the fences walk `src/` rather than trusting a path (the tab's
 * reviewer: a parallel package minted a second clock the same week).
 *
 * - The INSTANT: the newest landing, a walk-in dated by its prixod's day —
 *   the CASE in `documents/arrivals.ts` and nowhere else.
 * - The DAYS: whole Tashkent calendar days, `daysSince` (dashboard-math);
 *   `waitingDays` is that and a fallback, never arithmetic of its own.
 *
 * The day-difference idiom — two `YYYY-MM-DD` strings pinned to one clock
 * time, subtracted, divided by a day — is what a second clock looks like when
 * it is written; the two files that already carry it answer other questions
 * (a due date, a merge window) and are named. Anything else that needs a
 * whole-day count calls `daysSince`, which takes a day string as well as an
 * instant.
 */
describe('the wait-here clock has one home', () => {
  const files = globSync('src/**/*.{ts,tsx}');

  it('the walk-in landing instant is written in documents/arrivals.ts alone', () => {
    const CASE = /'receipt'\s+THEN\s+coalesce\(\(\s*SELECT\s+\w+\.received_at/;
    expect(files.filter((f) => CASE.test(code(f)))).toEqual(['src/modules/wms/documents/arrivals.ts']);
  });

  it('the whole-day count is `daysSince`, defined once, and `waitingDays` does no arithmetic of its own', () => {
    expect(files.filter((f) => /(?:function|const)\s+daysSince\b/.test(code(f)))).toEqual([
      'src/modules/wms/reports/dashboard-math.ts',
    ]);
    const fold = code('src/modules/wms/inventory/client-cargo-fold.ts');
    const body = fold.slice(fold.indexOf('export function waitingDays'), fold.indexOf('export function foldCargoNow'));
    expect(body).toMatch(/return daysSince\(arrival\.since, today\)/);
    expect(body).not.toMatch(/86_?400_?000|getTime\(\)|Date\.parse/);
  });

  it('no second calendar-day difference is written beside it', () => {
    const DAY = /`\$\{[^}`]+\}T\d{2}:\d{2}:\d{2}Z`/g;
    const KNOWN = [
      // Days until a partner's due date — a promise's calendar, not a wait.
      'src/modules/wms/partners/terms.ts',
      // How far apart two expenses' dates are, for the merge window.
      'src/modules/wms/accounting/cost-merge.ts',
    ];
    const writers = files.filter((f) =>
      code(f)
        .split(';')
        .some((statement) => (statement.match(DAY) ?? []).length >= 2 && /86_?400_?000|864e5/.test(statement)),
    );
    expect(writers.sort()).toEqual([...KNOWN].sort());
  });

  it('`daysSince` reads a day string the way it reads the instant that day began in Tashkent', () => {
    expect(daysSince('2026-09-20', TODAY)).toBe(8);
    expect(daysSince(new Date('2026-09-19T19:00:00Z'), TODAY)).toBe(8);
    expect(daysSince(TODAY, TODAY)).toBe(0);
  });
});
