import { describe, expect, it } from 'vitest';
import { MIN_STORED_LINES, tarkibLabel } from '@/modules/wms/receipts/composition-math';
import { violatedNotNull } from '@/modules/platform/db/errors';

/**
 * The name a lot is SHOWN under while a tarkib stands (the owner's items 3-4,
 * 2026-11-10; docs/TARKIB-TUZATISH.md §3) — the pure half. The SQL half is
 * `lotRuShownSql`, held equal to this by lot-name.integration.test.ts.
 */
describe('tarkibLabel — «first +N»', () => {
  it('one line is its own name: «tarkibda 1 tovar bo‘lsa … o‘sha nom» (item 3)', () => {
    expect(tarkibLabel([{ seq: 1, name: 'Мышь' }])).toBe('Мышь');
  });

  it('several lines: the FIRST name and how many MORE — three goods read «+2» (item 4)', () => {
    expect(
      tarkibLabel([
        { seq: 1, name: 'Клавиатура' },
        { seq: 2, name: 'Мышь' },
      ]),
    ).toBe('Клавиатура +1');
    expect(
      tarkibLabel([
        { seq: 1, name: 'Клавиатура' },
        { seq: 2, name: 'Мышь' },
        { seq: 3, name: 'Наушники' },
      ]),
    ).toBe('Клавиатура +2');
  });

  it('the first line is the lowest seq, whatever order the rows came in', () => {
    expect(
      tarkibLabel([
        { seq: 3, name: 'Наушники' },
        { seq: 1, name: 'Клавиатура' },
        { seq: 2, name: 'Мышь' },
      ]),
    ).toBe('Клавиатура +2');
    // A raw fixture that starts at 2: still the lowest, never a blank.
    expect(
      tarkibLabel([
        { seq: 5, name: 'Б' + 'б' },
        { seq: 2, name: 'Аа' },
      ]),
    ).toBe('Аа +1');
  });

  it('no lines is no label — the lot’s own name shows (the readers’ torn-header guard)', () => {
    expect(MIN_STORED_LINES).toBeGreaterThanOrEqual(1);
    expect(tarkibLabel([])).toBeNull();
  });

  it('one PLAIN space before the «+»: the PDF font has no NBSP glyph (#788)', () => {
    const label = tarkibLabel([
      { seq: 1, name: 'Чай' },
      { seq: 2, name: 'Кофе' },
    ])!;
    expect(label).toBe('Чай +1');
    expect([...label].map((ch) => ch.codePointAt(0))).not.toContain(0xa0);
  });
});

/**
 * 0142 dropped a NOT NULL; one migration behind, the app writes the NULL the
 * old column still refuses. The helper names the column so a caller answers
 * «server yangilanmoqda» for THAT one and nothing else.
 */
describe('violatedNotNull', () => {
  it('names the table and the column of a 23502, the driver’s own fields (measured on postgres.js)', () => {
    expect(
      violatedNotNull({ code: '23502', table_name: 'lot_compositions', column_name: 'attachment_id' }),
    ).toEqual({ table: 'lot_compositions', column: 'attachment_id' });
  });

  it('asks drizzle’s wrapped cause too', () => {
    expect(
      violatedNotNull({ cause: { code: '23502', table_name: 'lot_compositions', column_name: 'attachment_id' } }),
    ).toEqual({ table: 'lot_compositions', column: 'attachment_id' });
  });

  it('is null for every other error — a CHECK, a unique key, a plain Error, nothing', () => {
    expect(violatedNotNull({ code: '23514', constraint_name: 'x' })).toBeNull();
    expect(violatedNotNull({ code: '23505' })).toBeNull();
    expect(violatedNotNull(new Error('boom'))).toBeNull();
    expect(violatedNotNull(null)).toBeNull();
  });
});
