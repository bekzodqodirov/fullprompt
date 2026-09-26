import { describe, expect, it } from 'vitest';
import { priorPeriod } from '@/modules/wms/accounting/period';

describe('the period a report compares itself with', () => {
  it('year to date → the same days a year earlier', () => {
    expect(priorPeriod('2026-01-01', '2026-09-26')).toEqual({ from: '2025-01-01', to: '2025-09-26' });
  });
  it('month to date → the same days of the month before, clamped', () => {
    expect(priorPeriod('2026-09-01', '2026-09-26')).toEqual({ from: '2026-08-01', to: '2026-08-26' });
    expect(priorPeriod('2026-03-01', '2026-03-31')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(priorPeriod('2026-01-01', '2026-01-15')).toEqual({ from: '2025-01-01', to: '2025-01-15' });
  });
  it('anything else → the equal span just before', () => {
    expect(priorPeriod('2026-09-10', '2026-09-19')).toEqual({ from: '2026-08-31', to: '2026-09-09' });
    expect(priorPeriod('2026-06-01', '2026-09-30')).toEqual({ from: '2026-01-30', to: '2026-05-31' });
  });
});
