import { describe, expect, it } from 'vitest';
import { doorRow } from '@/modules/wms/calc/door-row';
import { aiGoodsLine } from '@/modules/wms/calc/intake-ai';
import { provenanceNote } from '@/modules/wms/calc/intake';

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

  /** One packing object of the answer, every key present as the schema requires («not stated» = 0 / "unknown"). */
  const pack = (over: Record<string, unknown> = {}) => ({
    cartons: 0,
    pieces_per_carton: 0,
    carton_weight_kg: 0,
    carton_weight_kind: 'unknown',
    carton_volume_m3: 0,
    l: 0,
    w: 0,
    h: 0,
    size_unit: 'unknown',
    size_of: 'unknown',
    piece_weight_kg: 0,
    ...over,
  });

  it('a pair the model read lands in the pair', () => {
    expect(g({ unit: 'm2', measure_qty: 120 })).toMatchObject({ quantity: null, measureUnit: 'm2', measureQty: 120 });
    expect(g({ unit: 'juft', measure_qty: 40 })).toMatchObject({ measureUnit: 'juft', measureQty: 40 });
  });

  it('a carton count the model read is the row’s packing — never pieces, and never the SELLER’s words', () => {
    // docs/AI-SORAYDI.md §2.2 (dg2-12): it used to land as the note
    // «sotuvchi: 20 karobka» — the seller's unit-word rule wording a figure
    // nobody typed, in a note the table does not draw.
    const line = g({ quantity: 600, unit: 'karobka', measure_qty: 20 });
    expect(line.quantity).toBe(600);
    expect(line.note).toBeNull();
    expect(line.packing).toMatchObject({ cartons: 20, from: 'ai' });
    expect(provenanceNote(line)).toBe('📦 20 karobka — AI o‘qidi');
  });

  it('the packing keys are copied and the BOT multiplies (§2.3): a carton’s size, weight and pieces', () => {
    const line = g({
      name_source: 'picture',
      photo: 2,
      packing: [
        pack({ cartons: 20, pieces_per_carton: 24, carton_weight_kg: 15, carton_weight_kind: 'gross', l: 60, w: 40, h: 50, size_unit: 'cm', size_of: 'package' }),
      ],
      tnved_code: '9401310000',
      code_sure: false,
    });
    // 20 × 60×40×50 sm = 2.4 m³; 20 × 15 = 300 kg; 20 × 24 = 480 — by hand.
    expect(line).toMatchObject({ quantity: 480, weightKg: 300, volumeM3: 2.4, nameFrom: 'photo', photoNo: 2, tnvedSure: false });
    expect(line.derived).toMatchObject({ volumeM3: '20 × 60×40×50 sm', weightKg: '20 × 15 kg', quantity: '20 × 24' });
    expect(provenanceNote(line)).toBe(
      'nomi rasmdan (AI taxmini), 2-rasm · TNVED kodi AI taxmini — aniq emas, tekshiring · ' +
        '📦 20 karobka · 60×40×50 sm · 15 kg/karobka (brutto) · 24 dona/karobka — AI o‘qidi · ' +
        'hajm hisoblangan: 20 × 60×40×50 sm = 2.4 m³ · og‘irlik hisoblangan: 20 × 15 kg = 300 kg · ' +
        'soni hisoblangan: 20 × 24 = 480 dona · og‘irlik brutto (karobka og‘irligidan)',
    );
  });

  it('«not stated» is 0 / "unknown" in the answer and NOTHING on the row — and a stated total is not overwritten', () => {
    // «"packing":[]» is the commonest answer; an object of zeros says the same.
    for (const packing of [[], [pack()]]) {
      const none = g({ packing, name_source: 'document', photo: 0, weight_kind: 'unknown', code_sure: true });
      expect(none.packing).toBeUndefined();
      expect(none.derived).toBeUndefined();
    }
    const bare = g({ packing: [], name_source: 'document', photo: 0, weight_kind: 'unknown', code_sure: true });
    expect(bare.packing).toBeUndefined();
    expect(bare.photoNo).toBeUndefined();
    expect(bare.weightKind).toBeUndefined();
    expect(bare.derived).toBeUndefined();
    expect(bare.nameFrom).toBeUndefined();
    expect(bare.tnvedSure).toBeUndefined();
    const total = g({ volume_m3: 2.48, packing: [pack({ cartons: 30, carton_volume_m3: 0.0827 })] });
    expect(total.volumeM3).toBe(2.48);
    expect(total.derived).toBeUndefined();
  });

  it('ONE piece’s weight (a marketplace card’s «4.5 kg/шт», MP-11) is copied and the bot multiplies by the pieces', () => {
    const line = g({ quantity: 200, weight_kg: null, packing: [pack({ piece_weight_kg: 4.5 })] });
    expect(line.packing).toMatchObject({ kgPerPiece: 4.5, from: 'ai' });
    expect(line.weightKg).toBe(900);
    expect(provenanceNote(line)).toBe('📦 4.5 kg/dona — AI o‘qidi · og‘irlik hisoblangan: 200 × 4.5 kg = 900 kg');
    // No count yet — no weight: the count is asked, and the answer computes it.
    expect(g({ quantity: null, weight_kg: null, packing: [pack({ piece_weight_kg: 4.5 })] }).weightKg).toBeNull();
  });

  it('ONE carton’s cube written into the row’s volume is replaced by the product (dg2-5)', () => {
    const line = g({ volume_m3: 0.083, packing: [pack({ cartons: 30, carton_volume_m3: 0.083 })] });
    expect(line.volumeM3).toBe(2.49);
    expect(line.derived).toEqual({ volumeM3: '30 × 0.083 m³', replaced: { volumeM3: 0.083 } });
  });

  it('WHOSE size it is decides the arithmetic (PR-12): a product’s own size and an unknown owner multiply nothing', () => {
    const table = g({ name: 'Стол', quantity: 10, packing: [pack({ cartons: 10, l: 120, w: 80, h: 75, size_unit: 'cm', size_of: 'product' })] });
    expect(table.volumeM3).toBeNull();
    expect(table.packing?.size).toEqual({ l: 120, w: 80, h: 75, unit: 'cm', of: 'product' });
    expect(provenanceNote(table)).toBe('📦 10 karobka · tovar o‘lchami 120×80×75 sm — AI o‘qidi');
    const unknown = g({ packing: [pack({ cartons: 20, l: 60, w: 40, h: 50, size_unit: 'cm', size_of: 'unknown' })] });
    expect(unknown.volumeM3).toBeNull();
    expect(unknown.packing?.size?.of).toBeNull();
    // The enum words are folded: «Package», " GROSS " are the words (PR-14).
    const loud = g({ packing: [pack({ cartons: 20, carton_weight_kg: 15, carton_weight_kind: ' GROSS ', l: 60, w: 40, h: 50, size_unit: 'CM', size_of: 'Package' })] });
    expect(loud).toMatchObject({ volumeM3: 2.4, weightKg: 300 });
  });

  it('cartons of SEVERAL sizes: the bot multiplies nothing and says so on the row', () => {
    const line = g({
      quantity: 500,
      packing: [pack({ cartons: 10, l: 60, w: 40, h: 50, size_unit: 'cm', size_of: 'package' }), pack({ cartons: 5, l: 80, w: 60, h: 40, size_unit: 'cm', size_of: 'package' })],
    });
    expect(line.packing).toBeUndefined();
    expect(line.volumeM3).toBeNull();
    expect(line.note).toBe('karobkalar har xil o‘lchamda — hajm va og‘irlik hisoblanmadi');
  });

  it('the row weight’s kind is a field, and «brutto» is said by code — only about a weight that is there', () => {
    const gross = g({ weight_kg: 150, weight_kind: 'gross' });
    expect(gross.weightKind).toBe('gross');
    expect(provenanceNote(gross)).toBe('og‘irlik brutto (netto yozilmagan)');
    expect(g({ weight_kg: 150, weight_kind: 'net' }).weightKind).toBe('net');
    expect(provenanceNote(g({ weight_kg: 150, weight_kind: 'net' }))).toBeNull();
    expect(g({ weight_kg: null, weight_kind: 'gross' }).weightKind).toBeUndefined();
    expect(g({ weight_kg: 150, weight_kind: 'unknown' }).weightKind).toBeUndefined();
  });

  it('a doubt about a code is recorded only where there is a code', () => {
    expect(g({ tnved_code: null, code_sure: false }).tnvedSure).toBeUndefined();
    expect(g({ tnved_code: '6403', code_sure: true }).tnvedSure).toBeUndefined();
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
