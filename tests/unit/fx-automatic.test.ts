import { describe, expect, it } from 'vitest';
import { isAutomatic, legacyState, type FxCycle } from '@/modules/wms/finance/fx-residue';

/**
 * U1 (0103, design §5.5.2): which closed cycles the SYSTEM closes, and what
 * «Kurs qoldiqlari» says about the rest — over every flag that decides it.
 * The two ledgers differ on history on purpose: a client's is the system's,
 * a firm's was closed by hand (#415) and is a person's.
 */
type Flags = Pick<
  FxCycle,
  'closed' | 'residueCents' | 'managed' | 'allFresh' | 'ledger' | 'usdOffset' | 'usdAdjustOpen' | 'usdAdjustFx'
>;
const cycle = (over: Partial<Flags> = {}): Flags => ({
  closed: true,
  residueCents: 2344,
  managed: false,
  allFresh: false,
  ledger: 'client',
  usdOffset: false,
  usdAdjustOpen: false,
  usdAdjustFx: false,
  ...over,
});

describe('isAutomatic', () => {
  it('never an open cycle, never a zero residue', () => {
    expect(isAutomatic(cycle({ closed: false, allFresh: true }), true)).toBe(false);
    expect(isAutomatic(cycle({ residueCents: 0, allFresh: true }), true)).toBe(false);
  });

  it('a managed cycle is maintained even with the switch off', () => {
    expect(isAutomatic(cycle({ managed: true, ledger: 'partner' }), false)).toBe(true);
  });

  it('the switch stops everything NEW', () => {
    expect(isAutomatic(cycle({ allFresh: true }), false)).toBe(false);
    expect(isAutomatic(cycle(), false)).toBe(false);
  });

  it('fresh rows close on either ledger', () => {
    expect(isAutomatic(cycle({ allFresh: true }), true)).toBe(true);
    expect(isAutomatic(cycle({ allFresh: true, ledger: 'partner' }), true)).toBe(true);
  });

  it('client history is the system’s unless a same-size dollar row cancelled it; a firm’s never', () => {
    expect(isAutomatic(cycle(), true)).toBe(true);
    expect(isAutomatic(cycle({ usdOffset: true }), true)).toBe(false);
    expect(isAutomatic(cycle({ ledger: 'partner' }), true)).toBe(false);
  });
});

describe('legacyState', () => {
  it('auto / hand / check / closable', () => {
    expect(legacyState(cycle(), true)).toBe('auto');
    expect(legacyState(cycle({ ledger: 'partner', usdAdjustFx: true }), true)).toBe('hand');
    expect(legacyState(cycle({ ledger: 'partner', usdAdjustOpen: true }), true)).toBe('check');
    expect(legacyState(cycle({ usdOffset: true }), true)).toBe('check');
    expect(legacyState(cycle({ ledger: 'partner' }), true)).toBe('closable');
    // With the switch off a client's history waits for a person too.
    expect(legacyState(cycle(), false)).toBe('closable');
  });
});
