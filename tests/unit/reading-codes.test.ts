import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The reading JOB codes the rows before the table reads its laws
 * (docs/IKKI-ESHIK.md §3.1): «Bo‘ldi» on the AI door, the model's answer with
 * a code for an Excel row by its number, the sealed memory answering another
 * row — and the laws the table asks its units by are read for the codes the
 * rows now carry. The model, the dictionaries, pg-boss and Telegram are
 * stand-ins; the order is the job's own.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', () => ({
  aiCalcBudgetLeft: async () => 100,
  recordAiPass: async () => {},
  aiCalcAvailable: async () => true,
}));
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);
const dict = vi.hoisted(() => ({ memory: new Map<string, string>(), book: new Map<string, string>(), lawsAsked: [] as string[][] }));
vi.mock('@/modules/wms/calc/memory', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/wms/calc/memory')>();
  return {
    ...real,
    sealedMemoryFor: async (names: string[]) =>
      new Map(
        names
          .filter((n) => dict.memory.has(real.itemNameNorm(n)))
          .map((n) => [real.itemNameNorm(n), { tnvedCode: dict.memory.get(real.itemNameNorm(n))! }]),
      ),
  };
});
vi.mock('@/modules/wms/tnved/service', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/wms/tnved/service')>();
  return {
    ...real,
    tnvedFor: async (names: string[]) =>
      new Map(
        names
          .filter((n) => dict.book.has(real.productKey(n)))
          .map((n) => [real.productKey(n), { tnvedCode: dict.book.get(real.productKey(n))! }]),
      ),
  };
});
vi.mock('@/modules/wms/calc/book-laws', () => ({
  bookLawsFor: async (codes: readonly (string | null | undefined)[]) => {
    dict.lawsAsked.push(codes.filter((c): c is string => Boolean(c)));
    return new Map();
  },
}));

import { activeIntake, endIntake, startIntake, updateIntake } from '@/modules/platform/telegram/calc-intake';
import { handleCalcCallback } from '@/modules/platform/telegram/staff-handlers';
import { driveReading, resetReadingDrive } from '../fixtures/calc-read-drive';

let seq = 0;
const chats: bigint[] = [];
function collection(ai: boolean): bigint {
  seq += 1;
  const chatId = BigInt(-9_940_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, 'rastamojka', { staffId: 'staff-test', ai });
  updateIntake(chatId, {
    stage: 'material',
    clientHintRaw: 'GS777',
    material: ['invoice ilova qilindi'],
    invoiceGoods: [
      { name: 'Kurtka', quantity: 300, weightKg: 150 },
      { name: 'Shim', quantity: 200, weightKg: 90 },
      { name: 'Sumka', quantity: 50, weightKg: 20, tnvedCode: '4202920000' },
    ],
  });
  return chatId;
}

function fakeCtx() {
  const replies: string[] = [];
  return {
    replies,
    async reply(text: string) {
      replies.push(text);
      return { message_id: 500 + replies.length };
    },
  };
}

const reads = (knownCodes: { index: number; code: string }[]) => ({
  ok: true,
  facts: { fromCity: null, toCity: null, weightKg: 260, volumeM3: 2, goods: [] },
  steps: [],
  knownCodes,
  usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
});

beforeEach(() => {
  model.analyze.mockReset();
  resetReadingDrive();
  dict.memory = new Map([['kurtka', '6201930000']]);
  dict.book = new Map([['shim', '6203420000']]);
  dict.lawsAsked.length = 0;
});
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});

describe('«Bo‘ldi» → the rows are coded → the table asks by those codes', () => {
  it('the AI door: the Excel’s own code, the memory, the book over the model, the model last', async () => {
    const chatId = collection(true);
    // The model codes rows 1 and 2 by number; the memory and the book outrank it.
    model.analyze.mockResolvedValueOnce(
      reads([
        { index: 0, code: '9999999991' },
        { index: 1, code: '9999999992' },
      ]),
    );
    dict.book = new Map();
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    await driveReading(chatId, ctx);
    expect(model.analyze.mock.calls[0]![0]).toMatchObject({ knownGoods: ['Kurtka', 'Shim', 'Sumka'], codeKnown: true });
    const goods = activeIntake(chatId)!.facts.goods!;
    expect(goods.map((g) => [g.name, g.tnvedCode, g.tnvedSource])).toEqual([
      ['Kurtka', '6201930000', 'memory'],
      ['Shim', '9999999992', 'model'],
      ['Sumka', '4202920000', 'row'],
    ]);
    // The laws were read for the codes the rows carry — never before the coding.
    expect(dict.lawsAsked.at(-1)).toEqual(['6201930000', '9999999992', '4202920000']);
  });

  it('the plain door: the memory and the book still code the rows; the model is asked no codes', async () => {
    const chatId = collection(false);
    model.analyze.mockResolvedValueOnce(reads([{ index: 1, code: '9999999992' }]));
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    await driveReading(chatId, ctx);
    expect(model.analyze.mock.calls[0]![0].codeKnown).toBeUndefined();
    const goods = activeIntake(chatId)!.facts.goods!;
    expect(goods.map((g) => [g.name, g.tnvedCode, g.tnvedSource])).toEqual([
      ['Kurtka', '6201930000', 'memory'],
      ['Shim', '6203420000', 'book'],
      ['Sumka', '4202920000', 'row'],
    ]);
    expect(dict.lawsAsked.at(-1)).toEqual(['6201930000', '6203420000', '4202920000']);
  });
});
