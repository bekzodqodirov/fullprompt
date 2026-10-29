import { describe, expect, it } from 'vitest';
import rates from '@/modules/wms/calc/pp3818-rates.json';
import { codeIn, opensRealHeading, parseGoodsLine } from '@/modules/wms/calc/units';

/**
 * The written TNVED forms open a REAL heading — the book's last heading per
 * chapter, inlined in units.ts as a table because that module ships to the
 * browser. The table is DERIVED: this file reads the book itself, so a new
 * PP-3818 export with a heading the table does not know turns it red.
 */
describe('opensRealHeading — the book’s own headings', () => {
  const headings = new Map<number, number>();
  for (const row of rates as { code: string }[]) {
    const chapter = Number(row.code.slice(0, 2));
    headings.set(chapter, Math.max(headings.get(chapter) ?? 0, Number(row.code.slice(2, 4))));
  }

  it('accepts every heading the book prices', () => {
    for (const row of rates as { code: string }[]) expect(opensRealHeading(row.code), row.code).toBe(true);
  });

  it('refuses the first heading past each chapter’s last, xx00, and a chapter with none', () => {
    for (let chapter = 1; chapter <= 97; chapter += 1) {
      const last = headings.get(chapter) ?? 0;
      const cc = String(chapter).padStart(2, '0');
      expect(opensRealHeading(`${cc}${String(last + 1).padStart(2, '0')}`), `${cc} after ${last}`).toBe(false);
      expect(opensRealHeading(`${cc}00`), `${cc}00`).toBe(false);
    }
    expect(headings.has(77)).toBe(false);
    expect(opensRealHeading('7701')).toBe(false);
    expect(opensRealHeading('9801')).toBe(false);
  });
});

describe('the written forms', () => {
  it('a date written with hyphens is no code, though a code may be', () => {
    // Hyphens print a code since round 4 («6201-93-0000»); a date's year opens
    // no heading the book has (chapter 20 ends at 2009).
    for (const text of ['Sana 2026-10-21', 'Kurtka 2025-12-31 keldi', 'Invoice 2024-01-15']) {
      expect(codeIn(text), text).toBeNull();
    }
    expect(codeIn('Kurtka 6201-93-0000')?.code).toBe('6201930000');
  });

  it('a dotted code is never a row of figures, whatever follows it', () => {
    expect(parseGoodsLine('Kurtka 6201.93.00.00 300').tnvedCode).toBe('6201930000');
    expect(parseGoodsLine('Kurtka 6201 93 00 00 300').tnvedCode).toBeNull();
  });
});
