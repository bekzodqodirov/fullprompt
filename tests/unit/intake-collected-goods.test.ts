import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalcFacts } from '@/modules/wms/calc/intake';

/**
 * Which goods a collection lands, and what the model is shown to read them
 * (the round-1 review of docs/SAKKIZ-BAND.md). The model is replaced by a
 * script — the question here is what the COLLECTOR does with its answer, so
 * the order of the sources is a test and not a reading of the code.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', () => ({ analyzeIntake: model.analyze }));
vi.mock('@/modules/wms/calc/ai-cost', () => ({ aiCalcBudgetLeft: async () => 100 }));

import {
  analyzeCollected,
  endIntake,
  goodsNameKey,
  goodsNameKeys,
  intakeClientLabel,
  pickGoods,
  startIntake,
  updateIntake,
  type IntakeState,
} from '@/modules/platform/telegram/calc-intake';

type Goods = NonNullable<CalcFacts['goods']>;
const line = (name: string, extra: Partial<Goods[number]> = {}): Goods[number] => ({ name, ...extra });

let seq = 0;
const chats: bigint[] = [];
function collection(patch: Partial<IntakeState>): IntakeState {
  seq += 1;
  const chatId = BigInt(-9_200_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, 'rastamojka');
  return updateIntake(chatId, { stage: 'material', fileCount: 2, ...patch })!;
}

const reads = (goods: Goods) => ({
  ok: true,
  facts: { fromCity: null, toCity: null, weightKg: null, volumeM3: null, goods },
  steps: [],
  usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
});

beforeEach(() => model.analyze.mockReset());
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});

describe('another factory’s goods, beside an Excel list (review c4)', () => {
  it('«boshqa zavod»: the model’s lines are appended — those the Excel does not already carry', async () => {
    model.analyze.mockResolvedValueOnce(reads([line('KURTKA'), line('Choynak', { quantity: 40 })]));
    const out = await analyzeCollected(
      collection({ invoiceGoods: [line('Kurtka', { quantity: 300 })], aiGoods: 'add', pdfs: [{ data: Buffer.from('%PDF'), name: 'B.pdf' }] }),
    );
    expect(out.facts.goods).toEqual([line('Kurtka', { quantity: 300 }), line('Choynak', { quantity: 40 })]);
    // …and the model was told what not to repeat.
    expect(model.analyze.mock.calls[0]![0].knownGoods).toEqual(['Kurtka']);
  });

  it('«o‘sha tovarlar», or no such pair: the Excel answers alone, and the model is told nothing extra', async () => {
    for (const aiGoods of ['context', null] as const) {
      model.analyze.mockResolvedValueOnce(reads([line('Choynak')]));
      const out = await analyzeCollected(collection({ invoiceGoods: [line('Kurtka')], aiGoods }));
      expect(out.facts.goods).toEqual([line('Kurtka')]);
      expect(model.analyze.mock.calls.at(-1)![0].knownGoods).toBeUndefined();
    }
  });
});

describe('what the model is shown of the spreadsheets (review c7)', () => {
  it('the separate files first, then the accepted workbooks’ other sheets — and nothing a replace dropped', async () => {
    model.analyze.mockResolvedValueOnce(reads([]));
    const sheet = { text: '[S] headerless', cut: true, cellsCut: false };
    const packing = { text: '[Packing list] RIGHT 1200 KGS', cut: false, cellsCut: false };
    await analyzeCollected(collection({ sheetTexts: [sheet], invoiceTexts: [packing] }));
    // Two inputs, never one block (round-2 review, C2/C6): the separate file
    // is goods material, the workbook's own packing list is totals only —
    // each with the reader's cut flag (C1).
    expect(model.analyze.mock.calls[0]![0].sheets).toEqual([sheet]);
    expect(model.analyze.mock.calls[0]![0].contextSheets).toEqual([packing]);
  });
});

describe('the order of the sources (pickGoods)', () => {
  const typed = [line('Salom', { weightKg: 3500 }), line('Tovar Kurtka', { quantity: 300 })];
  const typedLabelled = [line('Kurtka', { quantity: 300 })];

  it('a model that READ and found no goods is not overruled by an unlabelled typed line (review t22)', () => {
    expect(pickGoods({ invoice: [], aiGoods: null, model: [], typed, typedLabelled }).goods).toEqual(typedLabelled);
  });

  it('no reading at all: every typed line answers; a reading with goods answers itself', () => {
    expect(pickGoods({ invoice: [], aiGoods: null, model: null, typed, typedLabelled }).goods).toEqual(typed);
    expect(pickGoods({ invoice: [], aiGoods: null, model: [line('Choynak')], typed, typedLabelled }).goods).toEqual([line('Choynak')]);
  });

  it('a name is compared without its case, spacing or punctuation', () => {
    expect(goodsNameKey('  Куртка, женская ')).toBe(goodsNameKey('куртка женская'));
    expect(goodsNameKey('Shim')).not.toBe(goodsNameKey('Shimlar'));
  });
});

describe('a line the Excel already lists is not added again under the model’s name for it (round-2 review, C2/C6)', () => {
  it('«Russian (original)» is its original, «X (原文)» is X — and a colour in brackets is not a duplicate', () => {
    const invoice = [line('Ladies jacket', { quantity: 300 }), line('Куртка мужская'), line('Kurtka (qora)')];
    const model = [
      line('Куртка женская (Ladies jacket)'),
      line('Куртка мужская（男士夹克）'),
      line('Kurtka (oq)'),
      line('Choynak (茶壶)'),
      line('Choynak'),
      line('choynak (茶壶)'),
    ];
    const picked = pickGoods({ invoice, aiGoods: 'add', model, typed: [], typedLabelled: [] });
    // A model line stating no figure is the Excel's own when a name meets.
    // Among the model's OWN lines only the same whole name is one line
    // (round-3 review, R3-C1): «Choynak» and «Choynak (茶壶)» are two it read.
    expect(picked.goods.map((g) => g.name)).toEqual([
      'Ladies jacket',
      'Куртка мужская',
      'Kurtka (qora)',
      'Kurtka (oq)',
      'Choynak (茶壶)',
      'Choynak',
    ]);
    expect(picked.sameAsInvoice.map((g) => g.name)).toEqual(['Куртка женская (Ladies jacket)', 'Куртка мужская（男士夹克）']);
  });

  it('the names a line answers to: whole, outside the brackets, inside each', () => {
    expect(goodsNameKeys('Куртка женская (Ladies jacket)')).toEqual({
      whole: 'куртка женская ladies jacket',
      keys: ['куртка женская ladies jacket', 'куртка женская', 'ladies jacket'],
    });
    expect(goodsNameKeys('Shim').keys).toEqual(['shim']);
  });

  it('every Excel name reaches the model — the renderer budgets them, a 100-name cut does not', async () => {
    model.analyze.mockResolvedValueOnce(reads([]));
    const invoice = Array.from({ length: 150 }, (_, i) => line(`Tovar ${i + 1}`));
    await analyzeCollected(collection({ invoiceGoods: invoice, aiGoods: 'add' }));
    expect(model.analyze.mock.calls[0]![0].knownGoods).toHaveLength(150);
  });
});

describe('the customer as one line (round-2 review, C8/C9)', () => {
  it('the lines that ARE the hint’s phone or code leave the name; a bare label too; else the text on one line', () => {
    const phone = { phone: '+998 90 123 45 67' };
    expect(intakeClientLabel('Ali aka\n+998 90 123 45 67', phone)).toBe('Ali aka');
    expect(intakeClientLabel('Ism: Ali aka\nTel: +998 90 123 45 67', phone)).toBe('Ism: Ali aka');
    expect(intakeClientLabel('Mijoz:\nGS777', { code: 'GS777' })).toBe('Mijoz: GS777');
    expect(intakeClientLabel('  GS777  Bobur ', { code: 'GS777' })).toBe('GS777 Bobur');
    expect(intakeClientLabel('OOO  Asia\nTrade', null)).toBe('OOO Asia Trade');
    expect(intakeClientLabel(' \n ', null)).toBeNull();
  });
});
