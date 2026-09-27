import { describe, expect, it } from 'vitest';
import { dayIn, noonIn } from '@/modules/platform/time/tashkent';
import {
  RECEIPT_BACKDATE_DAYS,
  isBackdated,
  receivedAtFor,
  receivedDayBounds,
  receivedDayRefusal,
} from '@/modules/wms/receipts/received-day';

/**
 * The office receipt's day (0112, the owner's Q9 b): one rule, shared by the
 * wizard, the service and the correction door — [entry − 7, entry] in the
 * WAREHOUSE's zone, filed at its local noon.
 */

// 2026-09-25 23:30 in Tashkent = 18:30 UTC = 02:30 on the 26th in Yiwu.
const LATE_TASHKENT = new Date('2026-09-25T18:30:00Z');

describe('the received day', () => {
  it('is bounded by the entry day in the warehouse zone, seven days back', () => {
    expect(RECEIPT_BACKDATE_DAYS).toBe(7);
    // Yiwu's day, not Tashkent's: at 23:30 Tashkent it is already the 26th there.
    expect(receivedDayBounds(LATE_TASHKENT, 'Asia/Shanghai')).toEqual({
      min: '2026-09-19',
      max: '2026-09-26',
    });
    expect(receivedDayBounds(LATE_TASHKENT, 'Asia/Tashkent')).toEqual({
      min: '2026-09-18',
      max: '2026-09-25',
    });
  });

  it('refuses in words: a day that does not exist, the future, older than seven days', () => {
    const entry = new Date('2026-09-25T06:00:00Z');
    expect(receivedDayRefusal('2026-02-30', entry, 'Asia/Shanghai')).toBe('received_day_invalid');
    expect(receivedDayRefusal('26-09-25', entry, 'Asia/Shanghai')).toBe('received_day_invalid');
    expect(receivedDayRefusal('2026-09-26', entry, 'Asia/Shanghai')).toBe('received_in_future');
    // Entry − 8 is refused; both ends of [entry − 7, entry] are allowed.
    expect(receivedDayRefusal('2026-09-17', entry, 'Asia/Shanghai')).toBe('received_too_old');
    expect(receivedDayRefusal('2026-09-18', entry, 'Asia/Shanghai')).toBeNull();
    expect(receivedDayRefusal('2026-09-25', entry, 'Asia/Shanghai')).toBeNull();
  });

  it('uses the warehouse zone at the day boundary, not Tashkent', () => {
    // Tashkent still says the 25th; Yiwu says the 26th — the 26th is allowed there.
    expect(receivedDayRefusal('2026-09-26', LATE_TASHKENT, 'Asia/Shanghai')).toBeNull();
    expect(receivedDayRefusal('2026-09-26', LATE_TASHKENT, 'Asia/Tashkent')).toBe('received_in_future');
  });

  it('writes nothing for the entry day, and local noon for a past one', () => {
    const entry = new Date('2026-09-25T06:00:00Z');
    expect(receivedAtFor('2026-09-25', entry, 'Asia/Shanghai')).toBeNull();
    expect(receivedAtFor('2026-09-22', entry, 'Asia/Shanghai')!.toISOString()).toBe(
      '2026-09-22T04:00:00.000Z',
    );
  });

  it('files noon on the wall clock of each zone the business runs in', () => {
    expect(noonIn('2026-09-25', 'Asia/Shanghai').toISOString()).toBe('2026-09-25T04:00:00.000Z');
    expect(noonIn('2026-09-25', 'Asia/Kashgar').toISOString()).toBe('2026-09-25T06:00:00.000Z');
    expect(noonIn('2026-09-25', 'Asia/Tashkent').toISOString()).toBe('2026-09-25T07:00:00.000Z');
    // An unknown zone reads as UTC rather than throwing, like dayIn.
    expect(noonIn('2026-09-25', 'Mars/Olympus').toISOString()).toBe('2026-09-25T12:00:00.000Z');
  });

  it('lands noon on the same calendar day in Tashkent as in the warehouse', () => {
    for (const zone of ['Asia/Shanghai', 'Asia/Kashgar', 'Asia/Tashkent']) {
      for (const day of ['2026-01-01', '2026-09-25', '2026-12-31']) {
        expect(dayIn(noonIn(day, zone), 'Asia/Tashkent')).toBe(day);
        expect(dayIn(noonIn(day, zone), zone)).toBe(day);
      }
    }
  });

  it('calls a prixod back-dated only when the two columns differ', () => {
    const at = new Date('2026-09-25T06:00:00Z');
    expect(isBackdated({ receivedAt: at, createdAt: new Date(at) })).toBe(false);
    expect(isBackdated({ receivedAt: new Date('2026-09-22T04:00:00Z'), createdAt: at })).toBe(true);
  });
});
