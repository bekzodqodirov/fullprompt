import { describe, expect, it } from 'vitest';
import { upsaleStateOf } from '@/modules/wms/calc/upsale-service';
import { compensationVoidFits, type CompensationCover } from '@/modules/wms/finance/compensation';

/**
 * C12 (0105): a seller's upsale on a job whose money was taken back WAITS
 * («Hisob-faktura yo'q») until the job's NET price is back at the quote —
 * his own rule for a lowered price, asked the same way of a compensation.
 * Both paths reach it: keep the charge and compensate above it, or lower the
 * charge through the door. The one rule both readers (/upsale and the
 * Balans's liability) call.
 */
describe('C12 — upsaleStateOf reads the job net of its compensation', () => {
  const row = (charged: number, compensated: number) => ({
    payout_at: null,
    entity_type: 'deal',
    due_price_usd: '1200.00',
    cargo_receipts: 1,
    charged_usd: charged.toFixed(2),
    compensated_usd: compensated.toFixed(2),
  });
  const settled = { balanceUsd: 0, deferredUsd: 0 };

  it('whole: payable', () => {
    expect(upsaleStateOf(row(1200, 0), settled)).toBe('payable');
  });

  it('kept the charge, compensated above it: no invoice', () => {
    expect(upsaleStateOf(row(1200, 3500), settled)).toBe('no_invoice');
  });

  it('lowered the charge to 0 and compensated the rest: no invoice', () => {
    expect(upsaleStateOf(row(0, 2500), settled)).toBe('no_invoice');
  });

  it('a compensation of a few cents does not hold a whole commission', () => {
    expect(upsaleStateOf(row(1200.01, 0.01), settled)).toBe('payable');
  });

  // The owner's 4b (2026-09-26): a share is a fact only once cargo ARRIVED.
  it('no confirmed prixod on the deal: no cargo, whatever was charged', () => {
    expect(upsaleStateOf({ ...row(1200, 0), cargo_receipts: 0 }, settled)).toBe('no_cargo');
  });

  it('the invoice is checked against the price of the cargo that came, not the whole promise', () => {
    // 20 of 30 m³ arrived: the client owes 800 of 1200, and 800 charged is whole.
    expect(upsaleStateOf({ ...row(800, 0), due_price_usd: '800.00' }, settled)).toBe('payable');
  });
});

/**
 * 5.K.3 (0105): may a compensation be voided? «Money we handed a client must
 * never silently become his debt» — so the cash handed back since
 * compensations began must stay covered by the compensations that remain
 * plus what the client paid beyond his charges. The simpler «his advance ≥
 * the amount» was refused in design: it would refuse every correction of a
 * compensation that only offset a debt (no cash left, the typo unfixable).
 *
 * The cover sums EXCLUDE the compensation being voided; `refundsSinceUsd`
 * counts refunds written since the client's earliest live compensation (this
 * one included) — an older refund cannot have been funded by one.
 * Tolerance: the FX package's own allowance (2 % or $5).
 */
const cover = (s: Partial<CompensationCover>): CompensationCover => ({
  refundsSinceUsd: 0,
  refundsBeforeUsd: 0,
  paymentsUsd: 0,
  chargesUsd: 0,
  otherCompensationsUsd: 0,
  multiCurrency: true,
  ...s,
});

describe('compensationVoidFits — the seven vectors', () => {
  it('V1 cash paid out of the compensation (C1000 P1000 K1500 R1500) — refused', () => {
    expect(compensationVoidFits(cover({ chargesUsd: 1000, paymentsUsd: 1000, refundsSinceUsd: 1500 }))).toBe(false);
  });

  it('V2 the compensation only offset a debt (C1000 K300) — allowed', () => {
    expect(compensationVoidFits(cover({ chargesUsd: 1000 }))).toBe(true);
  });

  it('V3 an old refund of a plain advance (P1000 R1000, later C500 K300) — allowed', () => {
    // The refund predates every compensation, so it is not «since».
    expect(compensationVoidFits(cover({ paymentsUsd: 1000, chargesUsd: 500, refundsSinceUsd: 0 }))).toBe(true);
  });

  it('V4 part of the cash paid (C1000 P1000 K1500 R500) — refused', () => {
    expect(compensationVoidFits(cover({ chargesUsd: 1000, paymentsUsd: 1000, refundsSinceUsd: 500 }))).toBe(false);
  });

  it('V5 a typo, the larger correct figure written first (R1500, K′1600) — allowed', () => {
    expect(
      compensationVoidFits(
        cover({ chargesUsd: 1000, paymentsUsd: 1000, refundsSinceUsd: 1500, otherCompensationsUsd: 1600 }),
      ),
    ).toBe(true);
  });

  it('V6 a typo, the smaller correct figure (R1500, K′1400) — refused; after he returns $100 — allowed', () => {
    const before = cover({ chargesUsd: 1000, paymentsUsd: 1000, refundsSinceUsd: 1500, otherCompensationsUsd: 1400 });
    expect(compensationVoidFits(before)).toBe(false);
    expect(compensationVoidFits({ ...before, paymentsUsd: 1100 })).toBe(true);
  });

  it('V7 the cargo was found and the client returned the cash (R1500, P+1500) — allowed', () => {
    expect(compensationVoidFits(cover({ chargesUsd: 1000, paymentsUsd: 2500, refundsSinceUsd: 1500 }))).toBe(true);
  });

  it('an advance an OLDER refund already returned is not counted again (review: C700 P1000 R300, then K200 paid out as R200)', () => {
    expect(
      compensationVoidFits(cover({ chargesUsd: 700, paymentsUsd: 1000, refundsBeforeUsd: 300, refundsSinceUsd: 200 })),
    ).toBe(false);
    // …the same ledger without the old refund: the advance does cover it.
    expect(compensationVoidFits(cover({ chargesUsd: 700, paymentsUsd: 1000, refundsSinceUsd: 200 }))).toBe(true);
  });

  it('an all-dollar ledger has no FX residue to forgive — not one cent over (review)', () => {
    expect(
      compensationVoidFits(cover({ refundsSinceUsd: 200, chargesUsd: 1000, paymentsUsd: 1195, multiCurrency: false })),
    ).toBe(false);
    expect(
      compensationVoidFits(cover({ refundsSinceUsd: 200, chargesUsd: 1000, paymentsUsd: 1200, multiCurrency: false })),
    ).toBe(true);
  });

  it('the allowance edge: $5 uncovered passes, $5.01 is refused', () => {
    // refundsSince 200: 2 % is $4, so the $5 floor is the allowance.
    expect(compensationVoidFits(cover({ refundsSinceUsd: 200, chargesUsd: 1000, paymentsUsd: 1195 }))).toBe(true);
    expect(compensationVoidFits(cover({ refundsSinceUsd: 200, chargesUsd: 1000, paymentsUsd: 1194.99 }))).toBe(false);
  });
});
