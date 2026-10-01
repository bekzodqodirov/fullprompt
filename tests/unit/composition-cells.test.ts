import { describe, expect, it } from 'vitest';
import {
  agentContentsText,
  estimateNote,
  invoiceRowCells,
  packingBoxesCell,
  packingProductCell,
} from '@/modules/wms/documents/composition-cells';
import { DOC } from '@/modules/wms/documents/labels';
import { paperLines, type PaperLine, type StoredLine } from '@/modules/wms/receipts/composition-math';

/**
 * The words the customs papers print about a lot tarkibi
 * (docs/LOT-TARKIBI.md §4) — every figure from `paperLines`, every label
 * bilingual from `DOC`.
 */

const LOT = { boxCount: 100, kg: '1000.000', m3: '2.5000' };
const KB: StoredLine = { seq: 1, name: 'Клавиатура', pieces: 500, cartons: 50, kg: '600.000', m3: '1.5000', tnvedCode: '8471607000' };
const MS: StoredLine = { seq: 2, name: 'Мышь', pieces: 1000, cartons: 50, kg: '400.000', m3: '1.0000', tnvedCode: null };
const SEP = { seenBoxCount: 100, lines: [KB, MS] };

const pl = (over: Partial<PaperLine>): PaperLine => ({
  seq: 1,
  name: 'Клавиатура',
  tnvedCode: null,
  pieces: null,
  cartons: null,
  kg: 10,
  m3: null,
  places: null,
  ...over,
});

describe('invoiceRowCells', () => {
  it('prints pieces with «шт» when the line states pieces that land on this truck', () => {
    expect(invoiceRowCells(pl({ pieces: 170, kg: 202.8, places: 17, tnvedCode: '8471607000' }))).toEqual({
      product: 'Клавиатура',
      code: '8471607000',
      unit: 'шт',
      quantity: 170,
      places: 17,
      kg: 202.8,
    });
  });

  it('falls back to kg when the line states none — or its pieces round to 0 here (U11)', () => {
    expect(invoiceRowCells(pl({ pieces: null, kg: 12.5 }))).toMatchObject({ unit: 'кг', quantity: 12.5 });
    expect(invoiceRowCells(pl({ name: 'Принтер', pieces: 0, kg: 0.4 }))).toMatchObject({ unit: 'кг', quantity: 0.4 });
  });

  it('a line whose places come out 0 is «part of a place» — a text cell SUM(F) skips', () => {
    const cells = invoiceRowCells(pl({ places: 'part' }));
    expect(cells.places).toBe('(часть места) / (part of a place)');
    expect(cells.places).toBe(DOC.partOfPlace);
    expect(invoiceRowCells(pl({ places: null })).places).toBe('');
  });
});

/**
 * The owner's 3a (2026-10-01, «keep it as it is»): on one invoice a composed
 * line prints «шт» when the pieces it states land ≥ 1 on THIS truck, else «кг»
 * with its kg. Driven end to end — `paperLines` decides how many pieces land,
 * `invoiceRowCells` decides the unit — over an «aralash» lot whose light line
 * states ONE piece: its cumulative piece is roundHalfUp(1·x/100), 0 for the
 * first 49 positions and 1 from the 50th, so a 40 / 60 split puts it on the
 * second truck and nowhere else.
 */
describe('the «шт» boundary through paperLines (owner 3a)', () => {
  const LOT_3A = { boxCount: 100, kg: '1000.000', m3: '2.5000' };
  const HEAVY: StoredLine = { seq: 1, name: 'Клавиатура', pieces: 2000, cartons: null, kg: '999.000', m3: '2.4000', tnvedCode: null };
  const LIGHT: StoredLine = { seq: 2, name: 'Принтер', pieces: 1, cartons: null, kg: '1.000', m3: '0.1000', tnvedCode: null };
  const MIXED = { seenBoxCount: 100, lines: [HEAVY, LIGHT] };
  const printer = (portion: { before: number; cartons: number; kg: number; m3: number }) => {
    const view = paperLines(MIXED, LOT_3A, portion);
    const row = view.lines.find((l) => l.name === 'Принтер');
    expect(row, 'an aralash lot prints every line').toBeDefined();
    return invoiceRowCells(row!);
  };

  it('a line whose stated pieces land exactly 1 on this truck prints «шт» 1; on the truck where they land 0, «кг» and its kg', () => {
    const first = printer({ before: 0, cartons: 40, kg: 400, m3: 1 });
    const second = printer({ before: 40, cartons: 60, kg: 600, m3: 1.5 });
    expect([first.unit, first.quantity]).toEqual(['кг', 0.4]);
    expect([second.unit, second.quantity]).toEqual(['шт', 1]);
    // The one stated piece lands once over the lot's two trucks.
    expect([first, second].filter((c) => c.unit === 'шт').reduce((s, c) => s + c.quantity, 0)).toBe(1);
  });

  it('pinned as decided (3a): the aralash light line on a 1-carton truck stays on the paper as «кг» with quantity 0', () => {
    const one = printer({ before: 0, cartons: 1, kg: 10, m3: 0.025 });
    expect(one).toMatchObject({ product: 'Принтер', unit: 'кг', quantity: 0, kg: 0 });
  });
});

describe('the packing lists', () => {
  it('the product cell names the pieces', () => {
    expect(packingProductCell(pl({ name: 'Мышь', pieces: 1000 }))).toBe('Мышь — 1000 шт');
    expect(packingProductCell(pl({ name: 'Мышь', pieces: null }))).toBe('Мышь');
  });

  it('«alohida» prints the line’s cartons; «aralash» the lot’s on the first line and «same cartons» after', () => {
    expect(packingBoxesCell(pl({ cartons: 17 }), 'separate', true, 33)).toBe(17);
    expect(packingBoxesCell(pl({ cartons: null }), 'mixed', true, 33)).toBe(33);
    expect(packingBoxesCell(pl({ cartons: null }), 'mixed', false, 33)).toBe('(в тех же коробках) / (same cartons)');
  });
});

describe('agentContentsText', () => {
  it('U1: the whole lot, the code in brackets, no ≈', () => {
    const view = paperLines(SEP, LOT, { before: 0, cartons: 100, kg: 1000, m3: 2.5 });
    expect(agentContentsText(view.lines, view.estimate)).toBe(
      'Состав лота (весь план) / Lot contents (whole plan): ' +
        'Клавиатура [8471607000] — 50 кор. · 600.0 кг · 1.500 м³ · 500 шт; ' +
        'Мышь — 50 кор. · 400.0 кг · 1.000 м³ · 1000 шт',
    );
  });

  it('U2: a plan of 40 says ≈ before every figure', () => {
    const view = paperLines(SEP, LOT, { before: 0, cartons: 40, kg: 400, m3: 1 });
    expect(view.estimate).toBe(true);
    expect(agentContentsText(view.lines, view.estimate)).toBe(
      'Состав лота (весь план) / Lot contents (whole plan): ' +
        'Клавиатура [8471607000] — ≈20 кор. · ≈240.0 кг · ≈0.600 м³ · ≈200 шт; ' +
        'Мышь — ≈20 кор. · ≈160.0 кг · ≈0.400 м³ · ≈400 шт',
    );
  });
});

describe('estimateNote', () => {
  it('one clause per reason, RU/EN', () => {
    expect(estimateNote({ reasons: ['share'] }, 40, 100)).toBe(
      'Расчётно / Estimate: доля лота на этой машине (40 из 100 кор.) / lot share on this truck',
    );
    expect(estimateNote({ reasons: ['stale'] }, 100, 100)).toContain('лот изменён после ввода состава / lot changed');
    expect(estimateNote({ reasons: ['pallet'] }, 100, 100)).toContain('места на поддоне распределены по коробкам');
    expect(estimateNote({ reasons: ['clamped'] }, 100, 100)).toContain('коробка учтена на двух машинах');
    expect(estimateNote({ reasons: ['invalid'] }, 100, 100)).toContain('contents with carton counts on some lines only');
    expect(estimateNote({ reasons: ['share', 'pallet'] }, 40, 100).split('; ')).toHaveLength(2);
  });
});
