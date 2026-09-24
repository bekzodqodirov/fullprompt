import { describe, expect, it } from 'vitest';
import type { BatchLot } from '@/modules/wms/batches/lots';
import { pricingView, soleDealOf } from '@/modules/wms/finance/pricing-view';

/**
 * «Partiya moliyasi» by goods (owner, 2026-09-24, answer 1c: the price stays
 * one per client, the screen opens the client into its goods). What the
 * header prints is arithmetic over three inputs, so it is tested as that.
 */

const lot = (over: Partial<BatchLot>): BatchLot => ({
  lotId: 'L',
  letter: 'A',
  productNameZh: '货',
  productNameRu: null,
  receiptId: 'R',
  receiptNumber: 'YW-1',
  clientId: 'C1',
  clientCode: 'GS1',
  clientName: 'Bir',
  marking: null,
  dealId: null,
  dealCode: null,
  dealTitle: null,
  onBatch: 1,
  lotBoxCount: 1,
  kg: 10,
  m3: 0.1,
  goodsPhotoId: null,
  boxPhotoId: null,
  ...over,
});

const LOTS = [
  // Client 1: two goods on the truck.
  lot({ lotId: 'a1', clientId: 'C1', onBatch: 6, lotBoxCount: 10, kg: 60, m3: 0.6 }),
  lot({ lotId: 'a2', clientId: 'C1', letter: 'B', onBatch: 2, lotBoxCount: 2, kg: 20, m3: 0.2 }),
  // Client 2: nothing priced yet.
  lot({ lotId: 'b1', clientId: 'C2', clientCode: 'GS2', clientName: 'Ikki', kg: 5, m3: 0.05 }),
  // Cargo nobody has claimed.
  lot({ lotId: 'u1', clientId: null, clientCode: null, clientName: null, marking: 'MK1' }),
];
const COST = new Map([
  ['a1', { lotId: 'a1', totalUsd: 100, batchUsd: 80 }],
  ['a2', { lotId: 'a2', totalUsd: 50, batchUsd: 50 }],
  ['b1', { lotId: 'b1', totalUsd: 30, batchUsd: 30 }],
  ['u1', { lotId: 'u1', totalUsd: 7, batchUsd: 7 }],
]);
const CHARGES = [
  { clientId: 'C1', clientCode: 'GS1', clientName: 'Bir', type: 'charge', amountUsd: 200 },
  // A payment tagged with the truck is money RECEIVED — not a price.
  { clientId: 'C1', clientCode: 'GS1', clientName: 'Bir', type: 'payment', amountUsd: 999 },
  // A client whose cargo has left this truck, still charged on it.
  { clientId: 'C9', clientCode: 'GS9', clientName: 'Toqqiz', type: 'charge', amountUsd: 40 },
];

describe('pricingView', () => {
  const view = pricingView(LOTS, COST, CHARGES);

  it('keeps the price on the client and opens the client into its goods', () => {
    const c1 = view.clients.find((group) => group.clientId === 'C1')!;
    expect(c1.lots.map((row) => row.lotId)).toEqual(['a1', 'a2']);
    expect(c1).toMatchObject({ costUsd: 150, prevUsd: 20, chargedUsd: 200, marginUsd: 50, boxes: 8, kg: 80 });
  });

  it('prints no margin for a client without a price', () => {
    expect(view.clients.find((group) => group.clientId === 'C2')!.marginUsd).toBeNull();
  });

  it('keeps unclaimed cargo out of every client and inside the truck’s cost', () => {
    expect(view.unclaimed).toMatchObject({ costUsd: 7 });
    expect(view.unclaimed.lots.map((row) => row.lotId)).toEqual(['u1']);
    expect(view.totals.costUsd).toBe(187);
  });

  it('counts every charge on the truck and names the ones with no cargo under them', () => {
    expect(view.orphans).toEqual([{ clientId: 'C9', code: 'GS9', name: 'Toqqiz', chargedUsd: 40 }]);
    expect(view.totals).toMatchObject({ chargedUsd: 240, marginUsd: 53, prevUsd: 20, priced: 1 });
  });
});

/**
 * R3a (owner, 2026-09-24: «mashinada qo'yilgan narx bitimga ham yozilsin»):
 * a truck price is also the deal's money only when the client's cargo aboard
 * is ONE deal's and nothing else. The server writes it through the same
 * function, so the screen's announcement and the ledger cannot disagree.
 */
describe('soleDealOf', () => {
  it('names the deal when every lot aboard is that one deal', () => {
    expect(soleDealOf([{ dealId: 'D1' }, { dealId: 'D1' }])).toBe('D1');
  });

  it('names nothing for two deals — one price split between them is an allocation nobody made', () => {
    expect(soleDealOf([{ dealId: 'D1' }, { dealId: 'D2' }])).toBeNull();
  });

  it('names nothing for deal cargo beside deal-less cargo — that price would ride onto the deal', () => {
    expect(soleDealOf([{ dealId: 'D1' }, { dealId: null }])).toBeNull();
    expect(soleDealOf([{ dealId: null }, { dealId: 'D1' }])).toBeNull();
  });

  it('names nothing with no cargo, or no deal at all', () => {
    expect(soleDealOf([])).toBeNull();
    expect(soleDealOf([{ dealId: null }])).toBeNull();
  });

  it('puts the deal on the client group, so the screen says where the price goes', () => {
    const view = pricingView(
      [
        lot({ lotId: 'd1', clientId: 'C1', dealId: 'D1', dealCode: 'B-00001' }),
        lot({ lotId: 'd2', clientId: 'C1', letter: 'B', dealId: 'D1', dealCode: 'B-00001' }),
        lot({ lotId: 'e1', clientId: 'C2', clientCode: 'GS2', dealId: 'D2', dealCode: 'B-00002' }),
        lot({ lotId: 'e2', clientId: 'C2', clientCode: 'GS2', letter: 'B', dealId: null }),
      ],
      new Map(),
      [],
    );
    expect(view.clients.find((group) => group.clientId === 'C1')).toMatchObject({
      dealId: 'D1',
      dealCode: 'B-00001',
    });
    expect(view.clients.find((group) => group.clientId === 'C2')).toMatchObject({
      dealId: null,
      dealCode: null,
    });
  });
});
