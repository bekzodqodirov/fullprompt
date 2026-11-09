import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalcFacts } from '@/modules/wms/calc/intake';

/**
 * The reading codes the rows (docs/IKKI-ESHIK.md §3.1, his 5a): ONE function
 * for the reading and for `openCalcRequest`'s INSERT, in the owner's order —
 * the row's own code, the sealed memory, the exact-key book, the model — with
 * where each code came from; the model's `known_codes` for the Excel's rows by
 * INDEX, re-checked against the row; and the seller's typed code on top of all
 * of it. The dictionaries are stand-ins here, so the ORDER is the test; the
 * INSERT's half is `tests/integration/row-coding.integration.test.ts`.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', () => ({ aiCalcBudgetLeft: async () => 100 }));

import { AI_CODE_NOTE } from '@/modules/wms/calc/code-source';
import { codedNote, codeRows, type CodingLookups } from '@/modules/wms/calc/row-coding';
import { KNOWN_GOODS_CHARS, knownCodesOf, knownGoodsText } from '@/modules/wms/calc/intake-ai';
import { landingItems } from '@/modules/wms/calc/intake';
import {
  analyzeCollected,
  codeCollectedGoods,
  endIntake,
  placeByName,
  rowPatchOf,
  startIntake,
  updateIntake,
  withKnownCodes,
  type IntakeState,
} from '@/modules/platform/telegram/calc-intake';

type Goods = NonNullable<CalcFacts['goods']>;
const line = (name: string, extra: Partial<Goods[number]> = {}): Goods[number] => ({ name, ...extra });

/** Stand-in dictionaries that record what they were asked. */
function lookups(memory: Record<string, string>, book: Record<string, string>) {
  const asked = { memory: [] as string[][], book: [] as string[][] };
  const l: CodingLookups = {
    async memory(names) {
      asked.memory.push([...names]);
      return new Map(names.map((n) => [n, memory[n] ?? null]));
    },
    async book(names) {
      asked.book.push([...names]);
      return new Map(names.map((n) => [n, book[n] ?? null]));
    },
  };
  return { l, asked };
}

describe('the one coding function: the row, the memory, the book, the model', () => {
  it('codes each row by the first source that answers, and says which', async () => {
    const { l } = lookups({ Kurtka: '6202930000' }, { Kurtka: '6202000000', Shim: '6203420000' });
    const coded = await codeRows(
      [
        { name: 'Kurtka', own: '6201930000', model: '9999999999' },
        { name: 'Kurtka', own: null, model: '9999999999' },
        { name: 'Shim', own: null, model: '9999999999' },
        { name: 'Choynak', own: null, model: '7323930000' },
        { name: 'Lak', own: null, model: null },
      ],
      l,
    );
    expect(coded).toEqual([
      { code: '6201930000', source: 'row' },
      { code: '6202930000', source: 'memory' },
      { code: '6203420000', source: 'book' },
      { code: '7323930000', source: 'model' },
      { code: null, source: null },
    ]);
  });

  it('at the INSERT a code the collection carries is the row’s own — with the source it carries', async () => {
    // The reading already ran the order: the book's later answer must not
    // replace the code whose unit the table asked.
    const { l, asked } = lookups({}, { Choynak: '7323000000' });
    const coded = await codeRows(
      [
        { name: 'Choynak', own: '7323930000', ownSource: 'model', model: null },
        { name: 'Kurtka', own: '6202930000', ownSource: 'memory', model: null },
      ],
      l,
    );
    expect(coded).toEqual([
      { code: '7323930000', source: 'model' },
      { code: '6202930000', source: 'memory' },
    ]);
    // Nothing to look up: every row had a code.
    expect(asked.memory).toEqual([]);
    expect(asked.book).toEqual([]);
  });

  it('looks up only the rows with no code, each name once, by the name the INSERT stores', async () => {
    const long = `  ${'Ж'.repeat(400)}  `;
    const { l, asked } = lookups({}, {});
    await codeRows(
      [
        { name: 'Kurtka', own: '6201930000', model: null },
        { name: 'Shim', own: null, model: null },
        { name: ' Shim ', own: null, model: null },
        { name: long, own: null, model: null },
      ],
      l,
    );
    expect(asked.memory).toEqual([['Shim', 'Ж'.repeat(300)]]);
    expect(asked.book).toEqual([['Shim', 'Ж'.repeat(300)]]);
  });
});

describe('the note a model’s code lands with', () => {
  it('appended once, joined « · », and only for the model’s code', () => {
    expect(codedNote(null, 'model')).toBe(AI_CODE_NOTE);
    expect(codedNote('sotuvchi: 20 мест', 'model')).toBe(`sotuvchi: 20 мест · ${AI_CODE_NOTE}`);
    expect(codedNote(`x · ${AI_CODE_NOTE}`, 'model')).toBe(`x · ${AI_CODE_NOTE}`);
    for (const source of ['row', 'memory', 'book', null, undefined] as const) {
      expect(codedNote('x', source)).toBe('x');
      expect(codedNote(null, source)).toBeNull();
    }
  });
});

describe('known_codes: by the number the row was SHOWN with, re-checked', () => {
  it('maps a shown number to the caller’s index, and drops what was not shown or is no code', () => {
    // The caller's knownGoods had an empty name at index 0, so the shown rows
    // are its indices 1, 2 and 4.
    const shown = [1, 2, 4];
    expect(
      knownCodesOf(
        [
          { n: 1, tnved_code: '6201.93.0000' },
          { n: 3, tnved_code: '6403990000' },
          { n: 4, tnved_code: '8528520000' }, // past the shown list
          { n: 0, tnved_code: '8528520000' },
          { n: 2.5, tnved_code: '8528520000' },
          { n: '2', tnved_code: '8528520000' },
          { n: 2, tnved_code: '640399000' }, // nine digits: which zero fell off?
          { n: 2, tnved_code: 'kurtka' },
          'nonsense',
          null,
        ],
        shown,
      ),
    ).toEqual([
      { index: 1, code: '6201930000' },
      { index: 4, code: '6403990000' },
    ]);
    expect(knownCodesOf(null, shown)).toEqual([]);
    expect(knownCodesOf([{ n: 1, tnved_code: '6201930000' }], [])).toEqual([]);
  });

  it('a row given two codes is no answer; the same code twice is one', () => {
    expect(
      knownCodesOf(
        [
          { n: 1, tnved_code: '6201930000' },
          { n: 1, tnved_code: '6202930000' },
          { n: 2, tnved_code: '6403990000' },
          { n: 2, tnved_code: '6403990000' },
        ],
        [0, 1],
      ),
    ).toEqual([{ index: 1, code: '6403990000' }]);
  });

  it('lands on the row shown at that index — never a mismatched one, a coded one or a stored one', () => {
    const goods = [
      line('Kurtka'),
      line('Shim', { tnvedCode: '6203420000' }),
      line('Sumka', { itemId: 'item-1' }),
      line('Choynak (renamed)'),
    ];
    const names = ['Kurtka', 'Shim', 'Sumka', 'Choynak'];
    const out = withKnownCodes(goods, names, [
      { index: 0, code: '6201930000' },
      { index: 1, code: '9999999999' },
      { index: 2, code: '4202920000' },
      { index: 3, code: '7323930000' },
      { index: 9, code: '7323930000' },
    ]);
    expect(out).toEqual([
      line('Kurtka', { tnvedCode: '6201930000', tnvedSource: 'model' }),
      line('Shim', { tnvedCode: '6203420000' }),
      line('Sumka', { itemId: 'item-1' }),
      line('Choynak (renamed)'),
    ]);
  });
});

describe('the numbered list the codes are asked by', () => {
  it('numbered only for the invoice’s list, with the ask; the plain list is today’s', () => {
    const numbered = knownGoodsText(['Kurtka', 'Shim'], KNOWN_GOODS_CHARS, 'invoice', { numbered: true });
    expect(numbered).toContain('1. Kurtka\n2. Shim');
    expect(numbered).toContain('known_codes');
    const plain = knownGoodsText(['Kurtka', 'Shim'], KNOWN_GOODS_CHARS);
    expect(plain).toContain('- Kurtka\n- Shim');
    expect(plain).not.toContain('known_codes');
    // The request's own rows are never coded by the model (the add door's).
    expect(knownGoodsText(['Kurtka'], KNOWN_GOODS_CHARS, 'request', { numbered: true })).not.toContain('1. Kurtka');
  });
});

describe('the seller’s typed code stays on top', () => {
  it('a placed answer’s code is the row’s own', () => {
    expect(rowPatchOf(line('Kurtka', { tnvedCode: '6201930000', tnvedSource: 'model' }), { tnvedCode: '6202930000' })).toEqual({
      tnvedCode: '6202930000',
      tnvedSource: 'row',
    });
    expect(rowPatchOf(line('Kurtka'), { weightKg: 5 })).toEqual({ weightKg: 5 });
    const placed = placeByName([line('Kurtka', { tnvedCode: '9999999999', tnvedSource: 'model' })], [
      { index: 0, name: 'Kurtka', patch: { tnvedCode: '6202930000' } },
    ] as IntakeState['lineAnswers']);
    expect(placed.goods[0]).toMatchObject({ tnvedCode: '6202930000', tnvedSource: 'row' });
  });
});

let seq = 0;
const chats: bigint[] = [];
function collection(patch: Partial<IntakeState>, ai = false): IntakeState {
  seq += 1;
  const chatId = BigInt(-9_300_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, 'rastamojka', { staffId: 'staff-test', ai });
  return updateIntake(chatId, { stage: 'material', ...patch })!;
}
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});

describe('the reading’s coding step', () => {
  const facts = (goods: Goods) => ({ ...collection({}).facts, goods });

  it('codes every row it may: own, memory, book, the model last — a stored row is the VED’s', async () => {
    const { l } = lookups({ Kurtka: '6202930000' }, { Shim: '6203420000' });
    const state = collection({
      facts: facts([
        line('Kurtka', { tnvedCode: '9999999999', tnvedSource: 'model' }),
        line('Shim'),
        line('Choynak', { tnvedCode: '7323930000', tnvedSource: 'model' }),
        line('Sumka', { tnvedCode: '4202920000' }),
        line('Lak', { itemId: 'stored-1' }),
        line('Gilam'),
      ]),
    });
    const out = await codeCollectedGoods(state, { timeoutMs: 5_000, lookups: l });
    expect(out.facts.goods).toEqual([
      line('Kurtka', { tnvedCode: '6202930000', tnvedSource: 'memory' }),
      line('Shim', { tnvedCode: '6203420000', tnvedSource: 'book' }),
      line('Choynak', { tnvedCode: '7323930000', tnvedSource: 'model' }),
      line('Sumka', { tnvedCode: '4202920000', tnvedSource: 'row' }),
      line('Lak', { itemId: 'stored-1' }),
      line('Gilam'),
    ]);
    // A retry codes identically.
    expect((await codeCollectedGoods(state, { timeoutMs: 5_000, lookups: l })).facts.goods).toEqual(out.facts.goods);
  });

  it('a typed code is never replaced by the memory', async () => {
    const { l } = lookups({ Kurtka: '6202930000' }, {});
    const state = collection({ facts: facts([line('Kurtka', { tnvedCode: '6201930000', tnvedSource: 'row' })]) });
    const out = await codeCollectedGoods(state, { timeoutMs: 5_000, lookups: l });
    expect(out.facts.goods).toEqual([line('Kurtka', { tnvedCode: '6201930000', tnvedSource: 'row' })]);
  });

  it('past its budget, or on an error, the reading keeps the codes it has — never a throw', async () => {
    const state = collection({ facts: facts([line('Kurtka', { tnvedCode: '9999999999', tnvedSource: 'model' })]) });
    const slow: CodingLookups = {
      memory: () => new Promise((resolve) => setTimeout(() => resolve(new Map([['Kurtka', '6202930000']])), 500)),
      book: async () => new Map(),
    };
    expect(await codeCollectedGoods(state, { timeoutMs: 20, lookups: slow })).toBe(state);
    const broken: CodingLookups = {
      memory: async () => {
        throw new Error('pool gone');
      },
      book: async () => new Map(),
    };
    expect(await codeCollectedGoods(state, { timeoutMs: 5_000, lookups: broken })).toBe(state);
  });
});

describe('the AI door shows the Excel’s rows to the model and takes its codes (§3.1)', () => {
  const reads = (goods: Goods, knownCodes?: { index: number; code: string }[]) => ({
    ok: true,
    facts: { fromCity: null, toCity: null, weightKg: null, volumeM3: null, goods },
    steps: [],
    ...(knownCodes ? { knownCodes } : {}),
    usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
  });
  beforeEach(() => model.analyze.mockReset());

  it('on the AI door: always shown, numbered, coded by the model as its proposal', async () => {
    model.analyze.mockResolvedValueOnce(reads([], [{ index: 1, code: '6203420000' }]));
    const out = await analyzeCollected(
      collection({ invoiceGoods: [line('Kurtka', { tnvedCode: '6201930000' }), line('Shim')], fileCount: 1 }, true),
    );
    const call = model.analyze.mock.calls[0]![0];
    expect(call.knownGoods).toEqual(['Kurtka', 'Shim']);
    expect(call.codeKnown).toBe(true);
    expect(out.facts.goods).toEqual([
      line('Kurtka', { tnvedCode: '6201930000' }),
      line('Shim', { tnvedCode: '6203420000', tnvedSource: 'model' }),
    ]);
  });

  it('a model-read line’s code is the model’s proposal, on both doors', async () => {
    for (const ai of [false, true]) {
      model.analyze.mockResolvedValueOnce(reads([line('Choynak', { tnvedCode: '7323930000' })]));
      const out = await analyzeCollected(collection({ material: ['Choynak 40 ta'] }, ai));
      expect(out.facts.goods).toEqual([line('Choynak', { tnvedCode: '7323930000', tnvedSource: 'model' })]);
    }
  });

  it('on the plain door: no codes asked, the list as today (only on «add»)', async () => {
    model.analyze.mockResolvedValueOnce(reads([], [{ index: 1, code: '6203420000' }]));
    const out = await analyzeCollected(collection({ invoiceGoods: [line('Kurtka'), line('Shim')], fileCount: 1 }));
    const call = model.analyze.mock.calls[0]![0];
    expect(call.knownGoods).toBeUndefined();
    expect(call.codeKnown).toBeUndefined();
    expect(out.facts.goods).toEqual([line('Kurtka'), line('Shim')]);
  });
});

describe('the landing carries where a code came from', () => {
  it('to the INSERT, and nothing for a row that never said', () => {
    const items = landingItems({
      fromCity: null,
      toCity: null,
      weightKg: null,
      volumeM3: null,
      goods: [line('Shim', { tnvedCode: '6203420000', tnvedSource: 'model' }), line('Kurtka', { tnvedCode: '6201930000' })],
    });
    expect(items[0]).toMatchObject({ tnvedCode: '6203420000', tnvedSource: 'model' });
    expect(items[1]).not.toHaveProperty('tnvedSource');
  });
});
