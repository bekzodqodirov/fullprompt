import { describe, expect, it } from 'vitest';
import { fifoOrder, settleCharges, type FifoCharge } from '@/modules/wms/finance/fifo';

/** A charge on `txDate`, created at noon that day unless told otherwise. */
const charge = (id: string, txDate: string, amountUsd: number, extra: Partial<FifoCharge> = {}): FifoCharge => ({
  id,
  txDate,
  createdAt: `${txDate}T12:00:00Z`,
  amountUsd,
  dealId: null,
  ...extra,
});

describe('settleCharges — the oldest price is paid first', () => {
  it('literals: $120 against $100 then $50 leaves the newer one $30 open', () => {
    const owed = settleCharges([charge('b', '2026-09-10', 50), charge('a', '2026-09-01', 100)], { generalUsd: 120 });
    expect(owed.get('a')).toBe(0);
    expect(owed.get('b')).toBe(30);
  });

  it('no money settles nothing; more money than charges settles everything', () => {
    const none = settleCharges([charge('a', '2026-09-01', 100)], { generalUsd: 0 });
    expect(none.get('a')).toBe(100);
    const all = settleCharges([charge('a', '2026-09-01', 100), charge('b', '2026-09-02', 40)], { generalUsd: 500 });
    expect([all.get('a'), all.get('b')]).toEqual([0, 0]);
  });
});

describe('a compensation settles ITS OWN prixod first (his example, design data#8)', () => {
  it('A $1000 unpaid, B $1000 compensated → A stays open, B is paid', () => {
    // generalUsd carries the compensation too (it is a settlesUsd row); the
    // targeting takes back what it used, so the $1000 is not spent twice.
    const owed = settleCharges(
      [
        charge('A', '2026-09-01', 1000, { coversReceipts: ['rA'] }),
        charge('B', '2026-09-05', 1000, { coversReceipts: ['rB'] }),
      ],
      { generalUsd: 1000, compensations: [{ receiptId: 'rB', amountUsd: 1000 }] },
    );
    expect(owed.get('A')).toBe(1000);
    expect(owed.get('B')).toBe(0);
  });

  it('what a compensation leaves over is ordinary money', () => {
    const owed = settleCharges(
      [
        charge('A', '2026-09-01', 300, { coversReceipts: ['rA'] }),
        charge('B', '2026-09-05', 200, { coversReceipts: ['rB'] }),
      ],
      { generalUsd: 500, compensations: [{ receiptId: 'rB', amountUsd: 500 }] },
    );
    expect(owed.get('B')).toBe(0);
    expect(owed.get('A')).toBe(0);
  });
});

describe('a deferral counts against ITS OWN deal only', () => {
  it('D2 deferred, D1 unpaid → D1 stays open', () => {
    const owed = settleCharges(
      [charge('D1', '2026-09-01', 500, { dealId: 'd1' }), charge('D2', '2026-09-05', 500, { dealId: 'd2' })],
      { generalUsd: 0, deferrals: [{ dealId: 'd2', owedUsd: 500 }] },
    );
    expect(owed.get('D1')).toBe(500);
    expect(owed.get('D2')).toBe(0);
  });

  it('the residue of a deferral is not money', () => {
    const owed = settleCharges(
      [charge('D1', '2026-09-01', 500, { dealId: 'd1' }), charge('D2', '2026-09-05', 500, { dealId: 'd2' })],
      { generalUsd: 0, deferrals: [{ dealId: 'd2', owedUsd: 800 }] },
    );
    expect(owed.get('D1')).toBe(500);
  });
});

describe('fifoOrder — two runs can never disagree', () => {
  it('tx_date, then created_at, then id', () => {
    const early = charge('z', '2026-09-01', 1, { createdAt: '2026-09-01T09:00:00Z' });
    const late = charge('a', '2026-09-01', 1, { createdAt: '2026-09-01T10:00:00Z' });
    expect([late, early].sort(fifoOrder).map((c) => c.id)).toEqual(['z', 'a']);
    const tieA = charge('a', '2026-09-01', 1);
    const tieB = charge('b', '2026-09-01', 1);
    expect([tieB, tieA].sort(fifoOrder).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('a same-day tie settles the lower id first', () => {
    const owed = settleCharges([charge('b', '2026-09-01', 50), charge('a', '2026-09-01', 50)], { generalUsd: 50 });
    expect(owed.get('a')).toBe(0);
    expect(owed.get('b')).toBe(50);
  });
});
