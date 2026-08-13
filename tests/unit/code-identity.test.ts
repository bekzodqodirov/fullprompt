import { describe, expect, it } from 'vitest';
import { codeIdentity } from '@/modules/wms/labels/code-identity';

/**
 * The one rule for whose-cargo cells (round 100, owner's item 8): the box's
 * printed MARKING wins, and the claimed client's code appears small beneath
 * it — never the other way round, because the person reading the screen is
 * standing in front of the carton.
 */
describe('codeIdentity', () => {
  it('marking wins and the client code becomes the sub line', () => {
    expect(codeIdentity('GS500MANIKEN-AL', 'GS500')).toEqual({
      main: 'GS500MANIKEN-AL',
      sub: 'GS500',
    });
  });

  it('a receipt claimed from birth has no marking and no sub line', () => {
    expect(codeIdentity(null, 'GS777')).toEqual({ main: 'GS777', sub: null });
  });

  it('still-unclaimed cargo shows its marking alone', () => {
    expect(codeIdentity('MANIKEN', null)).toEqual({ main: 'MANIKEN', sub: null });
  });

  it('nothing known prints the honest placeholder, not an empty cell', () => {
    expect(codeIdentity(null, null)).toEqual({ main: '❓', sub: null });
    expect(codeIdentity(undefined, undefined)).toEqual({ main: '❓', sub: null });
  });
});
