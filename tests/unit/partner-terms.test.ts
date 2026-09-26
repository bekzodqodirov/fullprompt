import { describe, expect, it } from 'vitest';
import { dueStateOf, termAlerts } from '@/modules/wms/partners/terms';

/** The owner's 8a (2026-09-26): due N days after each debt, paid oldest first. */
describe('a counterparty’s due date', () => {
  const moves = [
    { date: '2026-09-01', usd: 1000 },
    { date: '2026-09-10', usd: 500 },
    { date: '2026-09-12', usd: -700 },
  ];

  it('payments close the OLDEST debt first', () => {
    // 700 paid: the 1 Sep debt has 300 open, due 1 Sep + 20 = 21 Sep.
    expect(dueStateOf(moves, 20, '2026-09-15')).toEqual({ dueDate: '2026-09-21', dueUsd: 300, overdueUsd: 0 });
  });

  it('counts what is past its day as overdue', () => {
    expect(dueStateOf(moves, 20, '2026-10-05')).toEqual({ dueDate: '2026-09-21', dueUsd: 300, overdueUsd: 800 });
  });

  it('nothing owed is no due date', () => {
    expect(dueStateOf([...moves, { date: '2026-09-20', usd: -800 }], 20, '2026-10-05').dueDate).toBeNull();
  });
});

describe('the reminders', () => {
  const base = {
    balanceUsd: 800,
    payWithinDays: 20,
    debtLimitUsd: null,
    dueSoonAlertedFor: null,
    overdueAlertedFor: null,
    limitAlerted: false,
  };
  const due = { dueDate: '2026-09-21', dueUsd: 300, overdueUsd: 0 };

  it('three days ahead, once per due date', () => {
    expect(termAlerts({ ...base, due, today: '2026-09-17' })).toEqual([]);
    expect(termAlerts({ ...base, due, today: '2026-09-18' })).toEqual([
      { kind: 'due_soon', dueDate: '2026-09-21', dueUsd: 300, days: 3 },
    ]);
    expect(termAlerts({ ...base, due, today: '2026-09-19', dueSoonAlertedFor: '2026-09-21' })).toEqual([]);
  });

  it('again when it passes, once', () => {
    const late = { ...due, overdueUsd: 300 };
    expect(termAlerts({ ...base, due: late, today: '2026-09-22', dueSoonAlertedFor: '2026-09-21' })).toEqual([
      { kind: 'overdue', dueDate: '2026-09-21', overdueUsd: 300 },
    ]);
    expect(termAlerts({ ...base, due: late, today: '2026-09-23', overdueAlertedFor: '2026-09-21' })).toEqual([]);
  });

  it('the limit at 80 %, once per crossing', () => {
    const none = { dueDate: null, dueUsd: 0, overdueUsd: 0 };
    expect(termAlerts({ ...base, due: none, today: '2026-09-22', debtLimitUsd: 1000, balanceUsd: 799 })).toEqual([]);
    expect(termAlerts({ ...base, due: none, today: '2026-09-22', debtLimitUsd: 1000, balanceUsd: 800 })).toEqual([
      { kind: 'limit', balanceUsd: 800, limitUsd: 1000, pct: 80 },
    ]);
    expect(
      termAlerts({ ...base, due: none, today: '2026-09-22', debtLimitUsd: 1000, balanceUsd: 950, limitAlerted: true }),
    ).toEqual([]);
  });
});
