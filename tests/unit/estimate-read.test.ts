import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The 📊 median read keeps what it read when ONE code's read fails (R2 late
 * pass, review P1-R7).
 *
 * A failure other than the statement ceiling (57014) used to be rethrown out
 * of the per-code loop, and the pass caught it as «no estimate» — every
 * median already read thrown away, every baza-less row then refused as «no
 * baza, the VED fills it». The chooser and the statement are stood in here:
 * what is under test is the LOOP's bookkeeping, which no database fault can
 * be ordered to hit on one code and not the next.
 */
const read = vi.hoisted(() => vi.fn());
vi.mock('@/modules/wms/customs/import-median', () => ({ readCodeMedians: read }));
vi.mock('@/modules/wms/customs/import-service', () => ({
  batchesForCodes: async (codes: readonly string[]) =>
    new Map(codes.map((code) => [code, { batchId: 'b1', endDate: '2026-09-30', rows: null }])),
}));
// The ceiling's transaction, stood in: the callback runs on a dummy handle.
vi.mock('@/modules/wms/finance/price-history', () => ({
  underCeiling: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
}));

import { rowMediansFor } from '@/modules/wms/calc/estimate-read';
import type { Workspace } from '@/modules/wms/calc/workspace';

const BROKEN = '3916100000';
const FINE = '3924100000';

/** The workspace's fields the read asks — a row per code, kilos only. */
const ws = {
  groups: [BROKEN, FINE].map((code, k) => ({
    tnvedCode: code,
    dutyUnit: null,
    items: [
      {
        id: `row-${k}`,
        tnvedCode: code,
        bazaUsd: null,
        bazaBasis: null,
        quantity: null,
        weightKg: 100,
        volumeM3: null,
        measureUnit: null,
        measureQty: null,
      },
    ],
  })),
} as unknown as Workspace;

beforeEach(() => {
  read.mockReset();
  read.mockImplementation(async (_tx: unknown, input: { tnvedCode: string }) => {
    if (input.tnvedCode === BROKEN) throw new Error('connection reset');
    return [{ unit: 'kg', n: 6, p50: 2.4, bands: new Map() }];
  });
});

describe('a failed read costs its own code, never the codes already read', () => {
  it('the broken code says «not read»; the other code keeps its median', async () => {
    const out = await rowMediansFor(ws, { deadline: Date.now() + 60_000 });
    expect(read).toHaveBeenCalledTimes(2);
    expect(out.get('row-0')).toEqual({ ok: false, miss: 'timeout', n: null });
    expect(out.get('row-1')).toMatchObject({ ok: true, bazaUsd: 2.4, basis: 'kg', n: 6 });
  });

  it('…in either order: a failure AFTER a good read does not throw it away', async () => {
    const reversed = { groups: [...ws.groups].reverse() } as unknown as Workspace;
    const out = await rowMediansFor(reversed, { deadline: Date.now() + 60_000 });
    expect(out.get('row-1')).toMatchObject({ ok: true, bazaUsd: 2.4 });
    expect(out.get('row-0')).toEqual({ ok: false, miss: 'timeout', n: null });
  });
});
