import { describe, expect, it } from 'vitest';
import { applyPacking, emptyPacking, type Packing } from '@/modules/wms/calc/carton-math';
import { answeredRow, answersStated, unansweredRow } from '@/modules/wms/calc/row-answer';
import type { CalcGoodsFact } from '@/modules/wms/calc/intake';

/**
 * A seller's ANSWER on a row the bot computes (docs/AI-SORAYDI.md §2.3;
 * review JN-15, JB-1). Every figure here is multiplied by hand.
 *
 * The judge's own evidence, verbatim: «the read row = {volumeM3: 2.4,
 * derived.volumeM3: «20 × 60×40×50 sm»}; the answer {volumeM3: 2.6} → {2.6,
 * the same derived mark}; applyPacking again → {volumeM3: 2.4, doubts: []}» —
 * a wrong number under ✅ with nothing on the screen saying so.
 */
const pack = (over: Partial<Packing>, from: Packing['from'] = 'ai'): Packing => ({ ...emptyPacking(from), ...over });
const box = { l: 60, w: 40, h: 50, unit: 'cm' as const, of: 'package' as const };
/** A row as a reading leaves it: the packing applied. */
const read = (row: CalcGoodsFact): CalcGoodsFact => applyPacking(row).line;
/** The answer written the way both writers write it: the patch over the row, then `answeredRow`. */
const answer = (row: CalcGoodsFact, patch: Partial<CalcGoodsFact>) => answeredRow({ ...row, ...patch }, patch);

describe('a figure the seller typed is HIS', () => {
  it('«1: 2.6 kub» over a computed 2.4 m³ stays 2.6 — on every later pass, with no doubt raised', () => {
    // 20 cartons × 0.6 × 0.4 × 0.5 m = 20 × 0.12 = 2.4 m³.
    const row = read({ name: 'Stul', packing: pack({ cartons: 20, size: box }) });
    expect(row.volumeM3).toBe(2.4);
    expect(row.derived?.volumeM3).toBe('20 × 60×40×50 sm');

    const his = answer(row, { volumeM3: 2.6 });
    expect(his.volumeM3).toBe(2.6);
    expect(his.derived?.volumeM3).toBeUndefined(); // no longer «hisoblangan»
    expect(his.derived?.person).toEqual(['volumeM3']);
    // The pass the judge ran: the row goes through the arithmetic again.
    const again = applyPacking(his);
    expect(again.line.volumeM3).toBe(2.6);
    expect(again.doubts).toEqual([]);
  });

  it('«bitta karobkanikimi yoki hammasinikimi?» is ANSWERED by either figure — the question does not come back', () => {
    // The model gave 0.083 m³ on the row AND 0.083 m³ per carton × 30: its own contradiction.
    const row = read({ name: 'Sumka', volumeM3: 0.083, packing: pack({ cartons: 30, m3PerCarton: 0.083 }) });
    expect(applyPacking(row).doubts.map((d) => d.kind)).toEqual(['one_or_all']);

    // «It is the whole row's»: the same figure, typed.
    const whole = answer(row, { volumeM3: 0.083 });
    expect(whole.volumeM3).toBe(0.083);
    expect(applyPacking(whole).doubts).toEqual([]);
    // «It was one carton's»: 30 × 0.083 = 2.49.
    const one = answer(row, { volumeM3: 2.49 });
    expect(one.volumeM3).toBe(2.49);
    expect(applyPacking(one).doubts).toEqual([]);
  });

  it('a COUNT answered is what one piece’s weight was waiting for: 200 × 4.5 kg = 900 kg, computed', () => {
    const row = read({ name: 'Dvigatel', packing: pack({ kgPerPiece: 4.5 }) });
    expect(row.weightKg ?? null).toBeNull();
    const his = answer(row, { quantity: 200 });
    expect(his).toMatchObject({ quantity: 200, weightKg: 900 });
    expect(his.derived?.weightKg).toBe('200 × 4.5 kg');
    expect(his.derived?.person).toEqual(['quantity']);
  });

  it('a row the arithmetic cannot touch is returned AS IT IS — the same object, no mark added', () => {
    const plain: CalcGoodsFact = { name: 'Kurtka', quantity: 300 };
    const written = { ...plain, weightKg: 150 };
    expect(answeredRow(written, { weightKg: 150 })).toBe(written);
    expect(written).toEqual({ name: 'Kurtka', quantity: 300, weightKg: 150 });
    // …and an answer that is not a figure (a code) changes nothing on a packed row either.
    const packed = read({ name: 'Stul', packing: pack({ cartons: 20, size: box }) });
    const coded = { ...packed, tnvedCode: '9401310000' };
    expect(answeredRow(coded, { tnvedCode: '9401310000' })).toBe(coded);
  });

  it('the answers put back on a RE-READ list are his there too (the placement’s write-back)', () => {
    // The re-read computed 2.4 again; `placeByName` wrote his 2.6 over it by index.
    const fresh = read({ name: 'Stul', packing: pack({ cartons: 20, size: box }) });
    const placed: CalcGoodsFact[] = [{ ...fresh, volumeM3: 2.6 }, { name: 'Shim', quantity: 5 }];
    const out = answersStated(placed, [
      { index: 0, patch: { volumeM3: 2.6 } },
      { index: -1, patch: { quantity: 9 } }, // placed nowhere this reading
      { index: 7, patch: { quantity: 9 } }, // past the list
    ]);
    expect(out[0]!.volumeM3).toBe(2.6);
    expect(applyPacking(out[0]!).line.volumeM3).toBe(2.6);
    expect(applyPacking(out[0]!).doubts).toEqual([]);
    expect(out[1]).toBe(placed[1]);
  });
});

describe('an answer TAKEN BACK («↩️»)', () => {
  it('the bot’s own figure is its own again — 2.4 m³ with its mark, as before he answered', () => {
    const row = read({ name: 'Stul', packing: pack({ cartons: 20, size: box }) });
    const his = answer(row, { volumeM3: 2.6 });
    // The undo wrote `before` back onto the row.
    const undone = unansweredRow({ ...his, volumeM3: 2.4 }, { volumeM3: 2.4 });
    expect(undone.volumeM3).toBe(2.4);
    expect(undone.derived?.volumeM3).toBe('20 × 60×40×50 sm');
    expect(undone.derived?.person).toBeUndefined();
  });

  it('a count taken back takes the weight it computed with it', () => {
    const row = read({ name: 'Dvigatel', packing: pack({ kgPerPiece: 4.5 }) });
    const his = answer(row, { quantity: 200 });
    const undone = unansweredRow({ ...his, quantity: null }, { quantity: null });
    expect(undone.quantity ?? null).toBeNull();
    expect(undone.weightKg ?? null).toBeNull();
    expect(undone.derived).toBeUndefined();
  });

  it('a STATED figure that stood before the answer stands again as stated — and its doubt with it', () => {
    // 3 m³ typed in the material against 20 × 0.12 = 2.4: a doubt. He answers 2.4, then takes it back.
    const row = read({ name: 'Stul', volumeM3: 3, packing: pack({ cartons: 20, size: box }, 'typed') });
    expect(applyPacking(row).doubts.map((d) => d.kind)).toEqual(['differs']);
    const his = answer(row, { volumeM3: 2.4 });
    expect(applyPacking(his).doubts).toEqual([]);
    const undone = unansweredRow({ ...his, volumeM3: 3 }, { volumeM3: 3 });
    expect(undone.volumeM3).toBe(3);
    expect(applyPacking(undone).doubts.map((d) => d.kind)).toEqual(['differs']);
  });
});

describe('the collection’s row stays small enough to be written behind every message (review JR-19)', () => {
  it('500 rows with a packing, its arithmetic and a seller’s mark: two copies fit well inside the store’s measured room', () => {
    // docs/SAKKIZ-R3.md §20.3 measured the durable write at 2.58 MiB in 98 ms,
    // inside the 2 s confirm. A collection holds its rows twice (the file's
    // list and the table's), so the new fields are counted twice here.
    const rows = Array.from({ length: 500 }, (_, i) =>
      answer(
        read({
          name: `Tovar nomi ${i} — uzunroq nom bilan, qirq belgidan oshiq`,
          quantity: 40,
          tnvedCode: '9401310000',
          note: 'plastik, ofis uchun',
          packing: pack({ cartons: 20, pcsPerCarton: 2, kgPerCarton: 15, kgPerCartonKind: 'gross', size: box }),
        }),
        { volumeM3: 2.6 },
      ),
    );
    const bytes = Buffer.byteLength(JSON.stringify({ invoiceGoods: rows, facts: { goods: rows } }), 'utf8');
    expect(bytes).toBeLessThan(1.5 * 1024 * 1024);
  });
});
