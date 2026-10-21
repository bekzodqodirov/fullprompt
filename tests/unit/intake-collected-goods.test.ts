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
    await analyzeCollected(collection({ sheetTexts: ['[S] headerless'], invoiceTexts: ['[Packing list] RIGHT 1200 KGS'] }));
    expect(model.analyze.mock.calls[0]![0].sheetText).toBe('[S] headerless\n\n[Packing list] RIGHT 1200 KGS');
  });
});

describe('the order of the sources (pickGoods)', () => {
  const typed = [line('Salom', { weightKg: 3500 }), line('Tovar Kurtka', { quantity: 300 })];
  const typedLabelled = [line('Kurtka', { quantity: 300 })];

  it('a model that READ and found no goods is not overruled by an unlabelled typed line (review t22)', () => {
    expect(pickGoods({ invoice: [], aiGoods: null, model: [], typed, typedLabelled })).toEqual(typedLabelled);
  });

  it('no reading at all: every typed line answers; a reading with goods answers itself', () => {
    expect(pickGoods({ invoice: [], aiGoods: null, model: null, typed, typedLabelled })).toEqual(typed);
    expect(pickGoods({ invoice: [], aiGoods: null, model: [line('Choynak')], typed, typedLabelled })).toEqual([line('Choynak')]);
  });

  it('a name is compared without its case, spacing or punctuation', () => {
    expect(goodsNameKey('  Куртка, женская ')).toBe(goodsNameKey('куртка женская'));
    expect(goodsNameKey('Shim')).not.toBe(goodsNameKey('Shimlar'));
  });
});
