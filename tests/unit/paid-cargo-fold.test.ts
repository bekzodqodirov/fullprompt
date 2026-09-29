import { describe, expect, it } from 'vitest';
import {
  foldDealCargo,
  type PaidCargo,
  type PaidCarton,
  type SettledCharge,
} from '@/modules/wms/finance/paid-cartons';

/**
 * The upsale's fold of the paid-cargo walk (his 3a) — pure, over a
 * hand-built `PaidCargo`. The FIFO itself is fifo.test's and the SQL is the
 * integration file's; this pins what a deal waits on and how much money
 * opens it, on literals.
 */

let seq = 0;
const carton = (over: Partial<PaidCarton> & { dealId: string; covering?: string[] }): PaidCarton => {
  const covering = over.covering ?? [];
  seq += 1;
  return {
    boxId: `box-${seq}`,
    receiptId: `r-${over.dealId}`,
    clientId: 'C',
    sellerId: null,
    month: '2026-09',
    m3: 10,
    covered: covering.length > 0,
    paid: false,
    elsewhere: false,
    ...over,
    covering,
  };
};

const charge = (
  id: string,
  txDate: string,
  amountUsd: number,
  owedUsd: number,
  dealId: string | null,
  clientId = 'C',
): SettledCharge => ({
  id,
  txDate,
  createdAt: `${txDate}T10:00:00Z`,
  amountUsd,
  dealId,
  clientId,
  owedUsd,
});

const cargo = (cartons: PaidCarton[], charges: SettledCharge[]): PaidCargo => ({
  cartons,
  charges: new Map(charges.map((c) => [c.id, c])),
});

describe('the owner’s example: A paid by the oldest money, B still owed', () => {
  it('A opens, B waits $1300 with nothing older in the way', () => {
    const out = foldDealCargo(
      ['A', 'B'],
      cargo(
        [
          carton({ dealId: 'A', covering: ['cA'], paid: true }),
          carton({ dealId: 'B', covering: ['cB'], paid: false }),
        ],
        [charge('cA', '2026-08-30', 1300, 0, 'A'), charge('cB', '2026-09-29', 1300, 1300, 'B')],
      ),
    );
    expect(out.get('A')).toMatchObject({ cartons: 1, unpaid: 0, ownChargesOwed: 0, toOpenUsd: 0 });
    expect(out.get('B')).toMatchObject({
      cartons: 1,
      unpaid: 1,
      ownChargesOwed: 1,
      toOpenUsd: 1300,
      olderOwedElsewhere: false,
    });
  });
});

describe('an older debt on another deal is settled first', () => {
  it('X owed 500 older than A: A needs 1800, and says the money goes to the old debt first', () => {
    const out = foldDealCargo(
      ['A'],
      cargo(
        [carton({ dealId: 'A', covering: ['cA'] })],
        [charge('cX', '2026-07-31', 500, 500, 'X'), charge('cA', '2026-08-30', 1300, 1300, 'A')],
      ),
    );
    expect(out.get('A')).toMatchObject({ toOpenUsd: 1800, olderOwedElsewhere: true });
  });

  it('X settled: A needs its own 1300 and nothing older is in the way', () => {
    const out = foldDealCargo(
      ['A'],
      cargo(
        [carton({ dealId: 'A', covering: ['cA'] })],
        [charge('cX', '2026-07-31', 500, 0, 'X'), charge('cA', '2026-08-30', 1300, 1300, 'A')],
      ),
    );
    expect(out.get('A')).toMatchObject({ toOpenUsd: 1300, olderOwedElsewhere: false });
  });
});

describe('the job’s own invoice (money-O1)', () => {
  it('a deal-stamped price that covers no carton holds the job and names its money', () => {
    const out = foldDealCargo(
      ['A'],
      cargo(
        [carton({ dealId: 'A', covering: ['c1000'], paid: true })],
        [charge('c1000', '2026-09-19', 1000, 0, 'A'), charge('c300', '2026-09-29', 300, 300, 'A')],
      ),
    );
    expect(out.get('A')).toMatchObject({ cartons: 1, unpaid: 0, ownChargesOwed: 1, toOpenUsd: 300 });
  });
});

describe('uncovered cartons', () => {
  it('counts the uncovered, and apart those whose price sits on a truck they touched', () => {
    const out = foldDealCargo(
      ['A'],
      cargo(
        [
          carton({ dealId: 'A', elsewhere: true }),
          carton({ dealId: 'A', elsewhere: false }),
          carton({ dealId: 'A', covering: ['cA'], paid: true }),
        ],
        [charge('cA', '2026-09-01', 100, 0, 'A')],
      ),
    );
    expect(out.get('A')).toMatchObject({ cartons: 3, uncovered: 2, uncoveredElsewhere: 1, unpaid: 0 });
  });
});

describe('what cannot be said is not guessed', () => {
  it('a waiting price missing from the ledger read: toOpenUsd is null (fail closed)', () => {
    const out = foldDealCargo(['A'], cargo([carton({ dealId: 'A', covering: ['ghost'] })], []));
    expect(out.get('A')).toMatchObject({ unpaid: 1, toOpenUsd: null });
  });
});

describe('the sum stops at the newest price the job waits on', () => {
  it('a NEWER owed charge of the same client is not counted in toOpenUsd', () => {
    const out = foldDealCargo(
      ['A'],
      cargo(
        [carton({ dealId: 'A', covering: ['cA'] })],
        [charge('cA', '2026-09-01', 1300, 1300, 'A'), charge('cB', '2026-09-20', 900, 900, 'B')],
      ),
    );
    expect(out.get('A')).toMatchObject({ toOpenUsd: 1300, olderOwedElsewhere: false });
  });
});

describe('two clients’ money never mixes', () => {
  it('another client’s older owed charge is not in this job’s sum', () => {
    const out = foldDealCargo(
      ['A'],
      cargo(
        [carton({ dealId: 'A', covering: ['cA'] })],
        [charge('cOther', '2026-01-01', 5000, 5000, 'Z', 'OTHER'), charge('cA', '2026-09-01', 1300, 1300, 'A')],
      ),
    );
    expect(out.get('A')).toMatchObject({ toOpenUsd: 1300, olderOwedElsewhere: false });
  });
});

describe('every asked id is answered', () => {
  it('an asked deal with no cartons is all zeros; one not asked is absent', () => {
    const out = foldDealCargo(['A', 'EMPTY'], cargo([carton({ dealId: 'NOT-ASKED', covering: [] })], []));
    expect(out.get('EMPTY')).toEqual({
      cartons: 0,
      uncovered: 0,
      uncoveredElsewhere: 0,
      unpaid: 0,
      ownChargesOwed: 0,
      toOpenUsd: 0,
      olderOwedElsewhere: false,
    });
    expect(out.get('A')?.cartons).toBe(0);
    expect(out.has('NOT-ASKED')).toBe(false);
  });
});
