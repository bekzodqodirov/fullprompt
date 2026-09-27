import { describe, expect, it } from 'vitest';
import { countOnlyLotOf, type CountOnlyLot } from '@/offline/count-only';

/** The phone's own «this lot is the office's» answer (0112), offline. */
const LOTS: CountOnlyLot[] = [
  { lotId: 'lot-a', mode: 'counted', label: 'GS777-A', siblings: ['GS777-00009'] },
  { lotId: 'lot-b', mode: 'qrless', label: 'GS500-B', siblings: [] },
];
const BOXES = [
  { shortCode: 'GS777-00001', lotId: 'lot-a' },
  { shortCode: 'GS777-00002', lotId: 'lot-a', crateCode: 'CR-YW26-00001' },
  { shortCode: 'GS500-00001', lotId: 'lot-b' },
  { shortCode: 'GS123-00001', lotId: 'lot-c' },
];

describe('countOnlyLotOf', () => {
  it('a carton in the snapshot is matched through its lot', () => {
    expect(countOnlyLotOf('GS777-00001', BOXES, LOTS)?.label).toBe('GS777-A');
    expect(countOnlyLotOf('gs500-00001', BOXES, LOTS)?.mode).toBe('qrless');
    expect(countOnlyLotOf('GS123-00001', BOXES, LOTS)).toBeNull();
  });

  it('a crated carton and a crate are always the phone’s', () => {
    expect(countOnlyLotOf('GS777-00002', BOXES, LOTS)).toBeNull();
    expect(countOnlyLotOf('CR-YW26-00001', BOXES, LOTS)).toBeNull();
  });

  it('a sibling the snapshot does not carry is matched by name, case-insensitively', () => {
    expect(countOnlyLotOf(' gs777-00009 ', BOXES, LOTS)?.lotId).toBe('lot-a');
    expect(countOnlyLotOf('GS777-00010', BOXES, LOTS)).toBeNull();
  });

  it('an old cached snapshot without the field refuses nothing', () => {
    expect(countOnlyLotOf('GS777-00001', BOXES, undefined)).toBeNull();
    expect(countOnlyLotOf('GS777-00001', BOXES, [])).toBeNull();
  });
});
