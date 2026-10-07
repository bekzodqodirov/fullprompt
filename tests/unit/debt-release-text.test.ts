import { describe, expect, it } from 'vitest';
import { debtOpenedBy, debtReleasedText, type DebtReleasedInput } from '@/modules/wms/issue/debt-release';

/**
 * «🔓 Qarzga yuk berildi» (0126, the owner's D6a): who, which client, how
 * much debt, and the comment — for a tick and for an approval. Literal
 * fragments (#166), never a second reading of the template.
 */

const tick: DebtReleasedInput = {
  clientCode: 'GS123',
  clientName: 'Sardor aka',
  warehouseCode: 'TAS1',
  boxes: 2,
  blockingUsd: 77.77,
  deferredUsd: 0,
  how: 'tick',
  right: 'warehouse',
  actorName: 'Jasur Mudir',
  deciderName: null,
  note: 'ertaga to‘laydi',
  decisionNote: null,
  appUrl: 'https://gsrwms.uz',
};

describe('debtReleasedText', () => {
  it('a tick: the code, the name, the counter, the debt, who ticked and why, and the register', () => {
    const text = debtReleasedText(tick);
    expect(text.split('\n')).toEqual([
      '🔓 Qarzga yuk berildi — GS123 (Sardor aka) · TAS1',
      '2 karobka · qarz $77.77',
      'Ruxsat: Jasur Mudir (belgi, o‘z skladi)',
      'Izoh: ertaga to‘laydi',
      'https://gsrwms.uz/finance/qarzga-berilgan',
    ]);
  });

  it('a seller’s or the accountant’s tick says «belgi» alone; the muddat part shows only when there is one', () => {
    const text = debtReleasedText({ ...tick, right: 'ledger', deferredUsd: 30 });
    expect(text).toContain('Ruxsat: Jasur Mudir (belgi)\n');
    expect(text).toContain('2 karobka · qarz $77.77 · muddatli $30.00\n');
    expect(debtReleasedText({ ...tick, deferredUsd: 0.009 })).not.toContain('muddatli');
  });

  it('an approval: the decider, who handed it over, the REQUEST’s reason, and the decider’s note on its own line', () => {
    const text = debtReleasedText({
      ...tick,
      how: 'approval',
      right: null,
      actorName: 'Ombor Operator',
      deciderName: 'Buxgalter Aziza',
      note: 'mijoz kafil',
      decisionNote: 'Telegram bot orqali',
    });
    expect(text.split('\n')).toEqual([
      '🔓 Qarzga yuk berildi — GS123 (Sardor aka) · TAS1',
      '2 karobka · qarz $77.77',
      'Ruxsat: Buxgalter Aziza (so‘rov) · berdi: Ombor Operator',
      'Sabab: mijoz kafil',
      'Qaror izohi: Telegram bot orqali',
      'https://gsrwms.uz/finance/qarzga-berilgan',
    ]);
    expect(debtReleasedText({ ...tick, how: 'approval', decisionNote: null, deciderName: 'X' })).not.toContain('Qaror izohi');
  });

  it('a legacy row with no reason prints a dash, never «null»', () => {
    expect(debtReleasedText({ ...tick, note: null })).toContain('Izoh: —');
    expect(debtReleasedText({ ...tick, note: '   ' })).toContain('Izoh: —');
  });

  it('never prints «qarz $0.00»: a figure at or under a cent is the caller’s mistake and THROWS (the logged catch)', () => {
    expect(() => debtReleasedText({ ...tick, blockingUsd: 0.009 })).toThrow();
    expect(() => debtReleasedText({ ...tick, blockingUsd: 0 })).toThrow();
    expect(() => debtReleasedText({ ...tick, blockingUsd: Number.NaN })).toThrow();
    expect(() => debtReleasedText({ ...tick, blockingUsd: 0.01 })).not.toThrow();
  });
});

describe('debtOpenedBy — who opened the DEBT gate at this press (D6a, the review’s DEBT-3)', () => {
  // Literal cells: the integration test’s «tells nobody» cannot see this
  // decision, because a wrongly opened gate throws in the text builder and
  // writes no row either way.
  it('a USED tick is the tick’s', () => {
    expect(debtOpenedBy({ debtTickUsed: true, approvalId: null, needDebt: false })).toBe('tick');
    // A tick that cleared the debt while an approval answered the PRICE: still the tick’s.
    expect(debtOpenedBy({ debtTickUsed: true, approvalId: 'a1', needDebt: false })).toBe('tick');
  });

  it('an approval spent while the DEBT was the question is the approval’s', () => {
    expect(debtOpenedBy({ debtTickUsed: false, approvalId: 'a1', needDebt: true })).toBe('approval');
  });

  it('an approval spent for a PRICE alone opened no debt', () => {
    expect(debtOpenedBy({ debtTickUsed: false, approvalId: 'a1', needDebt: false })).toBe(null);
  });

  it('nothing pressed — a paid-up client, a stale tick, a release a deal «muddat» excused', () => {
    expect(debtOpenedBy({ debtTickUsed: false, approvalId: null, needDebt: false })).toBe(null);
  });
});
