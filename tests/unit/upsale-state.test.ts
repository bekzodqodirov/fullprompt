import { describe, expect, it } from 'vitest';
import {
  bySeller,
  earnedOf,
  liabilityOf,
  upsaleStateOf,
  walkCandidates,
  walkChunks,
  type UpsaleRow,
  type UpsaleState,
} from '@/modules/wms/calc/upsale-service';
import type { DealCargoPaid } from '@/modules/wms/finance/paid-cartons';
import { isBudgetMiss, ReadDeadlineError } from '@/modules/platform/db/no-jit';
import { isQueryCanceled } from '@/modules/platform/db/errors';

/**
 * His 3a (2026-09-29): «Upsale uchun «to'langan yuk» qoidasi KPI bilan bir
 * xil bo'lsin — eng eski qarzdan boshlab yopiladi». The ladder, the walk's
 * candidates and chunks, the budget's one soft predicate, and the folds that
 * read the state — every figure typed here, never computed by the code under
 * test.
 */

const walk = (over: Partial<DealCargoPaid> = {}): DealCargoPaid => ({
  cartons: 1,
  uncovered: 0,
  uncoveredElsewhere: 0,
  unpaid: 0,
  ownChargesOwed: 0,
  toOpenUsd: 0,
  olderOwedElsewhere: false,
  ...over,
});

/** A deal offer invoiced in full on the cargo that arrived. */
const row = (over: Partial<Parameters<typeof upsaleStateOf>[0]> = {}) => ({
  payout_at: null,
  entity_type: 'deal',
  due_price_usd: '1300.00',
  cargo_receipts: 1,
  charged_usd: '1300.00',
  compensated_usd: '0',
  ...over,
});

describe('the ladder (3a)', () => {
  it('paid beats everything, even with no walk', () => {
    expect(upsaleStateOf(row({ payout_at: new Date() }), null)).toBe('paid');
  });

  it('a lead is no_deal', () => {
    expect(upsaleStateOf(row({ entity_type: 'lead' }), null)).toBe('no_deal');
  });

  it('no confirmed prixod is no_cargo before any walk', () => {
    expect(upsaleStateOf(row({ cargo_receipts: 0 }), null)).toBe('no_cargo');
  });

  it('charged below the arrived price is no_invoice before any walk', () => {
    expect(upsaleStateOf(row({ charged_usd: '1000.00' }), null)).toBe('no_invoice');
  });

  it('a whole invoice with no walk is not_computed — never payable', () => {
    expect(upsaleStateOf(row(), null)).toBe('not_computed');
  });

  it('no live carton of the deal left is no_cargo', () => {
    expect(upsaleStateOf(row(), walk({ cartons: 0 }))).toBe('no_cargo');
  });

  it('a carton no live price covers is no_invoice', () => {
    expect(upsaleStateOf(row(), walk({ uncovered: 1 }))).toBe('no_invoice');
  });

  it('a covered carton not paid for is awaiting_payment', () => {
    expect(upsaleStateOf(row(), walk({ unpaid: 1 }))).toBe('awaiting_payment');
  });

  it('a price stamped with the deal still owed holds the job, every carton paid (money-O1)', () => {
    expect(upsaleStateOf(row(), walk({ ownChargesOwed: 1 }))).toBe('awaiting_payment');
  });

  it('cargo and invoice paid is payable', () => {
    expect(upsaleStateOf(row(), walk())).toBe('payable');
  });
});

describe('the walk asks about candidates only', () => {
  it('only rows whose pre-state is not_computed, in input order', () => {
    const rows = [
      { ...row(), entity_id: 'd1', client_id: 'c1' },
      { ...row({ payout_at: new Date() }), entity_id: 'd2', client_id: 'c1' },
      { ...row({ entity_type: 'lead' }), entity_id: 'l1', client_id: null },
      { ...row({ cargo_receipts: 0 }), entity_id: 'd3', client_id: 'c2' },
      { ...row({ charged_usd: '5.00' }), entity_id: 'd4', client_id: 'c2' },
      { ...row(), entity_id: 'd5', client_id: 'c2' },
    ];
    expect(walkCandidates(rows)).toEqual([
      { dealId: 'd1', clientId: 'c1' },
      { dealId: 'd5', clientId: 'c2' },
    ]);
  });
});

describe('client-grouped chunks', () => {
  it('a client’s deals are never split between chunks', () => {
    const deals = [
      { dealId: 'c1a', clientId: 'c1' },
      { dealId: 'c2a', clientId: 'c2' },
      { dealId: 'c1b', clientId: 'c1' },
      { dealId: 'c1c', clientId: 'c1' },
      { dealId: 'c2b', clientId: 'c2' },
    ];
    expect(walkChunks(deals, 4)).toEqual([
      ['c1a', 'c1b', 'c1c'],
      ['c2a', 'c2b'],
    ]);
  });

  it('a client bigger than a chunk is a chunk alone', () => {
    const deals = [
      { dealId: 'x', clientId: 'small' },
      ...Array.from({ length: 5 }, (_, i) => ({ dealId: `big${i}`, clientId: 'big' })),
      { dealId: 'y', clientId: 'other' },
    ];
    expect(walkChunks(deals, 4)).toEqual([['x'], ['big0', 'big1', 'big2', 'big3', 'big4'], ['y']]);
  });

  it('duplicate deal ids collapse', () => {
    expect(
      walkChunks(
        [
          { dealId: 'd', clientId: 'c' },
          { dealId: 'd', clientId: 'c' },
          { dealId: 'e', clientId: 'c' },
        ],
        40,
      ),
    ).toEqual([['d', 'e']]);
  });

  it('a deal with no client is its own group', () => {
    expect(
      walkChunks(
        [
          { dealId: 'a', clientId: null },
          { dealId: 'b', clientId: null },
        ],
        1,
      ),
    ).toEqual([['a'], ['b']]);
  });
});

describe('only a budget miss is soft', () => {
  it('isBudgetMiss: the deadline refusal and postgres’ cancel, both shapes; nothing else', () => {
    expect(isBudgetMiss(new ReadDeadlineError())).toBe(true);
    expect(isBudgetMiss({ code: '57014' })).toBe(true);
    expect(isBudgetMiss({ cause: { code: '57014' } })).toBe(true);
    expect(isBudgetMiss({ code: '23505' })).toBe(false);
    expect(isBudgetMiss(new Error('boom'))).toBe(false);
    expect(isBudgetMiss(null)).toBe(false);
  });

  it('isQueryCanceled: the code or its cause', () => {
    expect(isQueryCanceled({ code: '57014' })).toBe(true);
    expect(isQueryCanceled({ cause: { code: '57014' } })).toBe(true);
    expect(isQueryCanceled({ code: '40P01' })).toBe(false);
  });
});

describe('the liability never counts an unknown as owed', () => {
  it('payable in the sum, not_computed apart with its upper bound, the rest accrued', () => {
    const rows = [
      { ...row(), entity_id: 'walked-payable', payable_usd: '300.00' },
      { ...row(), entity_id: 'walked-awaiting', payable_usd: '200.00' },
      { ...row(), entity_id: 'not-walked', payable_usd: '150.00' },
      { ...row({ payout_at: new Date() }), entity_id: 'paid', payable_usd: '0' },
    ];
    const walked = new Map<string, DealCargoPaid>([
      ['walked-payable', walk()],
      ['walked-awaiting', walk({ unpaid: 1 })],
    ]);
    expect(liabilityOf(rows, walked)).toEqual({
      payableUsd: 300,
      payableCount: 1,
      accruedUsd: 200,
      unknownCount: 1,
      unknownUsd: 150,
    });
  });
});

const upsaleRow = (state: UpsaleState, over: Partial<UpsaleRow> = {}): UpsaleRow => ({
  offerId: `o-${state}`,
  requestId: 'r',
  entityType: 'deal',
  entityId: 'd',
  sellerId: 's1',
  sellerName: 'Seller',
  clientId: 'c',
  clientCode: 'GS1',
  clientName: 'Client',
  offeredAt: new Date('2026-09-01T10:00:00Z'),
  section: 'rastamojka',
  clientPriceUsd: 1300,
  floorUsd: 1000,
  upsaleUsd: 300,
  promisedUsd: 300,
  cargoReceipts: 1,
  cargoM3: 10,
  cargoKg: 500,
  payableUsd: 300,
  paidAt: null,
  paidUsd: null,
  compensatedUsd: 0,
  cargoWalk: null,
  clientManagerId: null,
  state,
  ...over,
});

describe('the per-seller fold /upsale and /hodimlar share', () => {
  it('payableUsd sums payable rows only; notComputed counts the unknowns', () => {
    const rows = [
      upsaleRow('payable', { offerId: 'a', payableUsd: 300 }),
      upsaleRow('payable', { offerId: 'b', payableUsd: 100 }),
      upsaleRow('awaiting_payment', { offerId: 'c', payableUsd: 50 }),
      upsaleRow('not_computed', { offerId: 'd', payableUsd: 70 }),
      upsaleRow('not_computed', { offerId: 'e', payableUsd: 30 }),
      upsaleRow('paid', { offerId: 'f', payableUsd: 0, paidUsd: 40 }),
    ];
    expect(bySeller(rows)).toEqual([
      {
        sellerId: 's1',
        sellerName: 'Seller',
        jobs: 6,
        earnedUsd: 590,
        paidUsd: 40,
        waitingUsd: 550,
        payableUsd: 400,
        notComputed: 2,
      },
    ]);
  });

  it('earnedOf does not move with the state (the profile and the dashboard skip the walk)', () => {
    for (const state of ['not_computed', 'awaiting_payment', 'payable'] as const) {
      expect(earnedOf(upsaleRow(state, { payableUsd: 275 }))).toBe(275);
    }
  });
});
