import { describe, expect, it } from 'vitest';
import { renderTelegramText } from '@/modules/platform/notifications/service';

/**
 * The prixod message's deal marker, and the attach-vs-price split (round 107,
 * owner's item 3: «bitim bolsa sotuvchiga biriktir deb, bitim bolmasa …
 * bitimi yo'q deb ko'rsatib ketsin, narxlatib qo'y deb ogohlantirsin»).
 *
 * Pure render tests: the recipient fan-out and the event choice are proven in
 * the integration suite; what belongs here is the words — including that YEARS
 * of already-stored events, which predate the `dealLinked` field, render
 * exactly as they always did (#688's rule about old payloads).
 */

const BASE = {
  receiptId: 'r-1',
  number: 'YW-260819-01',
  warehouseCode: 'YW',
  clientCode: 'GS777',
  clientName: 'Test mijoz',
  lots: [
    {
      letter: 'A',
      productNameZh: '货',
      productNameRu: 'Товар',
      boxCount: 10,
      totalWeightKg: 180,
      totalVolumeM3: 1.4,
    },
  ],
};

describe('ReceiptConfirmed deal marker', () => {
  it('an old event without the field renders with no marker line', () => {
    const text = renderTelegramText('ReceiptConfirmed', { ...BASE }, 'ru');
    expect(text).toContain('GS777');
    expect(text).not.toContain('сделке');
    expect(text).not.toContain('Сделки нет');
  });

  it('unlinked with an open deal says «attach it»', () => {
    const text = renderTelegramText(
      'ReceiptConfirmed',
      { ...BASE, dealLinked: false, openDealCodes: ['B-000123'] },
      'ru',
    );
    expect(text).toContain('Не привязан к сделке');
  });

  it('unlinked with NO deal says «no deal — set a price»', () => {
    const text = renderTelegramText(
      'ReceiptConfirmed',
      { ...BASE, dealLinked: false, openDealCodes: [] },
      'uz',
    );
    expect(text).toContain('Bitimi yo‘q');
  });

  it('a linked receipt carries no marker', () => {
    const text = renderTelegramText(
      'ReceiptConfirmed',
      { ...BASE, dealLinked: true, openDealCodes: [] },
      'ru',
    );
    expect(text).not.toContain('сделке');
  });
});

describe('UnlinkedCargo', () => {
  it('names the open deals and asks for the attach, with the receipt link', () => {
    const text = renderTelegramText(
      'UnlinkedCargo',
      {
        ...BASE,
        volumeM3: 1.4,
        weightKg: 180,
        boxCount: 10,
        openDealCodes: ['B-000123', 'B-000124'],
      },
      'uz',
    );
    expect(text).toContain('bitimga biriktirilmagan');
    expect(text).toContain('B-000123, B-000124');
    expect(text).toContain('biriktirib qo‘ying');
    expect(text).toContain('/receipts/r-1');
    // It never asks for a price — that is UnquotedCargo's sentence.
    expect(text).not.toContain('narx qo‘ying');
  });
});
