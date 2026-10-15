import { describe, expect, it } from 'vitest';
import { doorRow } from '@/modules/wms/calc/door-row';
import { aiGoodsLine } from '@/modules/wms/calc/intake-ai';

/**
 * ONE normalisation at the door (P1.2, judge S7/MR-18): the card form, the
 * bot, the thread and an invoice all hand `openCalcRequest` their rows, and
 * `doorRow` is where each number lands in the column its unit NAMES and each
 * code is shape-checked — with the kernel's rules, never its own. The
 * integration file reads the same rows back from the database; this one
 * pins the decisions.
 */
describe('a number lands in the column its word names', () => {
  it('«Kafel, 120, m2» is 120 m², never 120 pieces', () => {
    expect(doorRow({ name: 'Kafel', quantity: 120, unit: 'm2' })).toMatchObject({
      quantity: null,
      measureUnit: 'm2',
      measureQty: 120,
      unit: null,
      note: 'sotuvchi: 120 m2',
    });
  });

  it('«Kurtka, 500, kg» is a weight', () => {
    expect(doorRow({ name: 'Kurtka', quantity: 500, unit: 'kg' })).toMatchObject({
      quantity: null,
      weightKg: 500,
    });
  });

  it('«Futbolka, 20, karobka» clears the piece column and says so', () => {
    // The line now OWES its count; a carton count is never pieces.
    expect(doorRow({ name: 'Futbolka', quantity: 20, unit: 'karobka' })).toMatchObject({
      quantity: null,
      weightKg: null,
      measureQty: null,
      note: 'sotuvchi: 20 karobka',
    });
  });

  it('a word nobody prices clears the piece column and keeps the words', () => {
    expect(doorRow({ name: 'Mato', quantity: 300, unit: 'рулон' })).toMatchObject({
      quantity: null,
      note: 'sotuvchi: 300 рулон',
    });
  });

  it('a target already filled keeps its own figure; the other is noted (MR-5)', () => {
    expect(doorRow({ name: 'X', quantity: 5, unit: 'kg', weightKg: 7 })).toMatchObject({
      quantity: null,
      weightKg: 7,
      note: 'sotuvchi: 5 kg (qatorda 7 kg)',
    });
  });

  it('a count word stays a count', () => {
    expect(doorRow({ name: 'Stol', quantity: 40, unit: 'шт' })).toMatchObject({ quantity: 40, unit: 'шт' });
  });
});

describe('a structured pair is kept only in a unit the pair can hold', () => {
  it('m² / juft / litr are pairs', () => {
    expect(doorRow({ name: 'X', measureUnit: 'juft', measureQty: 40 })).toMatchObject({
      measureUnit: 'juft',
      measureQty: 40,
      note: null,
    });
  });

  it('anything else is said in the note, never stored under the wrong unit', () => {
    // A forged or stale post: the CHECK would refuse it as an unreadable 500.
    const row = doorRow({ name: 'X', measureUnit: 'kg' as never, measureQty: 12 });
    expect(row).toMatchObject({ measureUnit: null, measureQty: null });
    expect(row.note).toContain('12 kg');
  });
});

describe('the code is shape-checked, and a bad one never reaches tnved_code', () => {
  it('dots and spaces go; 4 to 10 digits stay', () => {
    expect(doorRow({ name: 'X', tnvedCode: '6403.99.00.00' }).tnvedCode).toBe('6403990000');
    expect(doorRow({ name: 'X', tnvedCode: '6907' }).tnvedCode).toBe('6907');
  });

  it('a typed nine-digit code is a question, never padded (MR-18)', () => {
    const row = doorRow({ name: 'X', tnvedCode: '901210000' });
    expect(row.tnvedCode).toBeNull();
    expect(row.note).toBe('TNVED «901210000» — 9 xonali: boshida 0 tushib qolganmi?');
  });

  it('a word is not a code', () => {
    const row = doorRow({ name: 'X', tnvedCode: 'abc' });
    expect(row.tnvedCode).toBeNull();
    expect(row.note).toContain('kod emas');
  });
});

describe('nothing a door said is dropped', () => {
  it('a figure no column can hold is refused into the note, not into a «server yangilanmoqda»', () => {
    // numeric(12,3) holds nine integer digits; the insert used to overflow
    // and the bot blamed the server.
    const row = doorRow({ name: 'X', quantity: 2e9 });
    expect(row.quantity).toBeNull();
    expect(row.note).toBe('sotuvchi: 2000000000 dona — juda katta son, yozilmadi');
  });

  it('a nameless line is named «(nomsiz)», never dropped', () => {
    expect(doorRow({ name: '   ', quantity: 3 })).toMatchObject({ name: '(nomsiz)', quantity: 3 });
  });

  it('the door’s note joins the line’s own', () => {
    expect(doorRow({ name: 'X', quantity: 20, unit: 'karobka', note: 'qora' }).note).toBe(
      'qora · sotuvchi: 20 karobka',
    );
  });
});

describe('the AI’s reading knows units (P1.5)', () => {
  const g = (patch: Partial<Parameters<typeof aiGoodsLine>[0]>) =>
    aiGoodsLine({
      name: 'X',
      quantity: null,
      weight_kg: null,
      volume_m3: null,
      unit: null,
      measure_qty: null,
      tnved_code: null,
      note: null,
      ...patch,
    });

  it('a pair the model read lands in the pair', () => {
    expect(g({ unit: 'm2', measure_qty: 120 })).toMatchObject({ quantity: null, measureUnit: 'm2', measureQty: 120 });
    expect(g({ unit: 'juft', measure_qty: 40 })).toMatchObject({ measureUnit: 'juft', measureQty: 40 });
  });

  it('a carton count the model read is noted, never pieces', () => {
    const line = g({ quantity: 600, unit: 'karobka', measure_qty: 20 });
    expect(line.quantity).toBe(600);
    expect(line.note).toBe('sotuvchi: 20 karobka');
  });

  it('a dotted or heading code is kept — it used to be ten bare digits or nothing', () => {
    expect(g({ tnved_code: '6907.21.00.00' }).tnvedCode).toBe('6907210000');
    expect(g({ tnved_code: '6403' }).tnvedCode).toBe('6403');
    const short = g({ tnved_code: '901210000' });
    expect(short.tnvedCode).toBeNull();
    expect(short.note).toContain('901210000');
  });

  it('a word outside the closed list is routed by the kernel, not a thrown reading', () => {
    expect(g({ unit: 'рулон', measure_qty: 3 })).toMatchObject({ quantity: null, note: 'sotuvchi: 3 рулон' });
  });
});
