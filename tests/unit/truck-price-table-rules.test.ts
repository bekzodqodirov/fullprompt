import { describe, expect, it } from 'vitest';
import {
  cardSeenOf,
  pressTotalOf,
  refusalCodeOf,
  rowSaysUnreadable,
  wrapperWords,
} from '@/app/(protected)/batches/[id]/pricing/table-rules';

/**
 * The «Narx» table's small decisions (docs/NARX-VA-RAQAM.md §3.1, the review
 * of the round as built): which rows a press counts as deals, which row a
 * refusal marks and where its sentence is said, which code a held refusal
 * names, and which drawn facts a press posts. Pure, so the components and
 * these tests are the same arithmetic; the components' use of each is fenced
 * in truck-deal-wire.test.ts.
 */

describe('pressTotalOf — «Jami: N ta bitim» counts deals (review B3)', () => {
  it('two deals and «bitimsiz» are two deals, with the «bitimsiz» part said beside them', () => {
    expect(
      pressTotalOf([
        { key: 'A', amount: 1000 },
        { key: 'none', amount: 300.5 },
        { key: 'B', amount: 199.5 },
      ]),
    ).toEqual({ n: 2, none: true, total: 1500 });
  });

  it('only deals: no «bitimsiz» part; only «bitimsiz»: no deal', () => {
    expect(pressTotalOf([{ key: 'A', amount: 10 }])).toEqual({ n: 1, none: false, total: 10 });
    expect(pressTotalOf([{ key: 'none', amount: 10 }])).toEqual({ n: 0, none: true, total: 10 });
  });
});

describe('where a refusal is said (review B2)', () => {
  it('a row prints «summani o‘qib bo‘lmadi» for an unreadable amount, and for nothing else', () => {
    expect(rowSaysUnreadable({ key: 'A', error: 'validation' }, 'A')).toBe(true);
    expect(rowSaysUnreadable({ key: 'A', error: 'validation' }, 'B')).toBe(false);
    // A well-formed $1.5 billion is too large, not unreadable; a forged or
    // stale post's deal is not aboard — the row is outlined, the wrapper speaks.
    expect(rowSaysUnreadable({ key: 'A', error: 'amount_too_large' }, 'A')).toBe(false);
    expect(rowSaysUnreadable({ key: 'none', error: 'deal_choice_invalid' }, 'none')).toBe(false);
    expect(rowSaysUnreadable(null, 'A')).toBe(false);
  });

  it('the wrapper says what no row says — never the same sentence twice', () => {
    // Unreadable, its row drawn: the row says it, the wrapper does not.
    expect(wrapperWords({ error: 'validation', dealId: 'A' }, ['A', 'B'])).toBe(false);
    // Its row gone (redrawn, or the body flipped to the single form): the wrapper.
    expect(wrapperWords({ error: 'validation', dealId: 'A' }, ['B'])).toBe(true);
    expect(wrapperWords({ error: 'validation', dealId: 'A' }, null)).toBe(true);
    // No row named: the wrapper.
    expect(wrapperWords({ error: 'validation' }, ['A'])).toBe(true);
    // Every other refusal, row or no row: the wrapper.
    expect(wrapperWords({ error: 'amount_too_large', dealId: 'A' }, ['A'])).toBe(true);
    expect(wrapperWords({ error: 'prices_changed' }, ['A'])).toBe(true);
    expect(wrapperWords(null, ['A'])).toBe(false);
  });
});

describe('refusalCodeOf — the code a held refusal names (review B4)', () => {
  it('is the row’s code as drawn, and null — never the raw id, never «none» — for a row it cannot name', () => {
    const codes = { 'd1-uuid': 'B-00123', none: 'bitimsiz' };
    expect(refusalCodeOf('d1-uuid', codes)).toBe('B-00123');
    expect(refusalCodeOf('none', codes)).toBe('bitimsiz');
    expect(refusalCodeOf('3f2a9c1e-gone', codes)).toBeNull();
    // The single form names no rows at all.
    expect(refusalCodeOf('none', {})).toBeNull();
    expect(refusalCodeOf(undefined, codes)).toBeNull();
  });
});

describe('cardSeenOf — the posted deals card-priced as drawn (review A4)', () => {
  const rows = [
    { key: 'B', card: true, typed: '10' },
    { key: 'A', card: true, typed: '20' },
    { key: 'C', card: true, typed: '' },
    { key: 'D', card: false, typed: '5' },
    { key: 'none', card: true, typed: '7' },
  ];

  it('names the FILLED card-priced deal rows, sorted — a blank row bills nothing, «bitimsiz» is no deal', () => {
    expect(cardSeenOf(rows, (row) => row.typed.trim() !== '')).toBe('A,B');
  });

  it('is empty when no posted deal had a card price — an answer, checked like any other', () => {
    expect(cardSeenOf(rows, (row) => row.key === 'D')).toBe('');
  });
});
