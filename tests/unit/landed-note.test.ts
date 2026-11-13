import { describe, expect, it } from 'vitest';
import { applyPacking, emptyPacking, type Packing } from '@/modules/wms/calc/carton-math';
import { doorRow } from '@/modules/wms/calc/door-row';
import {
  itemFacts,
  LANDED_NOTE_BUDGET,
  LONE_WEIGHT_NOTE,
  weightFromTotalNote,
  type CalcGoodsFact,
} from '@/modules/wms/calc/intake';

/**
 * The note a row LANDS with (docs/AI-SORAYDI.md §2.3; review JB-2, JR-9,
 * JS-11): his answer 3a — a figure the bot computed is written «hisoblangan»
 * where the VED reads the row — and 2a, a name read off a picture is written
 * as the guess it is.
 *
 * `itemFacts` is the one home every door lands through
 * (`intake-items-wire.test.ts` walks the doors), so pinning its note pins
 * every door's. Every figure is multiplied by hand.
 */
const pack = (over: Partial<Packing>, from: Packing['from'] = 'ai'): Packing => ({ ...emptyPacking(from), ...over });
const box = { l: 60, w: 40, h: 50, unit: 'cm' as const, of: 'package' as const };
const read = (row: CalcGoodsFact): CalcGoodsFact => applyPacking(row).line;
const noteOf = (row: CalcGoodsFact, facts: { weightKg?: number; volumeM3?: number } = {}) =>
  itemFacts({ ...facts, goods: [row, { name: 'boshqa', weightKg: 1 }] })[0]!.note;

describe('how each figure came to be is written on the landed row', () => {
  it('a photo-named good with its cartons: the guess, the unsure code, the packing as read and each product', () => {
    // 20 × 0.6 × 0.4 × 0.5 = 2.4 m³; 20 × 15 = 300 kg, the cartons' gross.
    const row = read({
      name: 'Stul',
      nameFrom: 'photo',
      photoNo: 2,
      quantity: 40,
      tnvedCode: '9401310000',
      tnvedSure: false,
      note: 'plastik, ofis uchun',
      packing: pack({ cartons: 20, kgPerCarton: 15, kgPerCartonKind: 'gross', size: box }),
    });
    expect(noteOf(row)).toBe(
      [
        'plastik, ofis uchun',
        'nomi rasmdan (AI taxmini), 2-rasm',
        'TNVED kodi AI taxmini — aniq emas, tekshiring',
        '📦 20 karobka · 60×40×50 sm · 15 kg/karobka (brutto) — AI o‘qidi',
        'hajm hisoblangan: 20 × 60×40×50 sm = 2.4 m³',
        'og‘irlik hisoblangan: 20 × 15 kg = 300 kg',
        'og‘irlik brutto (karobka og‘irligidan)',
      ].join(' · '),
    );
  });

  it('a stated figure the bot REPLACED keeps the original in the note — the VED can undo it', () => {
    // A file's row: 0.083 m³ stood as the row's, and it is one of 30 cartons'. 30 × 0.083 = 2.49.
    const row = read({ name: 'Sumka', volumeM3: 0.083, packing: pack({ cartons: 30, m3PerCarton: 0.083 }, 'file') });
    expect(row.volumeM3).toBe(2.49);
    expect(noteOf(row)).toBe('📦 30 karobka · 0.083 m³/karobka — fayldan · hajm bitta karobkaniki edi (0.083): 30 × 0.083 m³ = 2.49 m³');
  });

  it('a row nobody computed lands with its own note, exactly as before', () => {
    expect(noteOf({ name: 'Kurtka', quantity: 300, weightKg: 150, note: 'qishki' })).toBe('qishki');
    expect(noteOf({ name: 'Kurtka', quantity: 300, weightKg: 150 })).toBeNull();
  });
});

describe('the note fits the door, and what CODE reads back is never the part that is cut', () => {
  it('a 600-character note beside a packing: the lone-weight sentence first, the seller’s words clipped, the packing whole', () => {
    const row = read({ name: 'Stul', note: 'x'.repeat(600), packing: pack({ cartons: 20, size: box }, 'file') });
    // ONE good on the job, so the shipment's weight is its weight — said by the sentence `weightFromTotalNote` reads.
    const [item] = itemFacts({ weightKg: 320, goods: [row] });
    const note = item!.note!;
    expect(note.length).toBeLessThanOrEqual(LANDED_NOTE_BUDGET);
    expect(note.startsWith(`${LONE_WEIGHT_NOTE} · xxx`)).toBe(true);
    // The arithmetic gave way first (one clause), then his words (with «…»); the packing line is whole.
    expect(note.endsWith('x… · 📦 20 karobka · 60×40×50 sm — fayldan · karobkadan hisoblangan: hajm')).toBe(true);
    expect(weightFromTotalNote(note)).toBe('brutto');
    // …and it survives the door's own cut, which keeps 500 characters from the head.
    const landed = doorRow({ name: item!.name, quantity: item!.quantity, weightKg: item!.weightKg, volumeM3: item!.volumeM3, note });
    expect(weightFromTotalNote(landed.note)).toBe('brutto');
    expect(landed.note).toContain('📦 20 karobka · 60×40×50 sm — fayldan');
  });

  it('the budget leaves room under the door’s 500', () => {
    expect(LANDED_NOTE_BUDGET).toBeLessThan(500);
  });
});
