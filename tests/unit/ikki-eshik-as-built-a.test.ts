import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalcFacts } from '@/modules/wms/calc/intake';
import { driveReading, resetReadingDrive } from '../fixtures/calc-read-drive';

/**
 * The as-built review of «Ikki eshik» (docs/IKKI-ESHIK.md), the files, the
 * codes and the reading: what the merged tree did with an add collection's
 * restated row, typed figures beside a packing list, typed codes, a lone
 * packing list and a top-up's packing list. Through the real handlers and the
 * real reading job; the model and the budget are stand-ins and Telegram a fake
 * that records what was said and edited.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', () => ({
  aiCalcBudgetLeft: async () => 100,
  aiCalcAvailable: async () => true,
  aiCalcStanding: async () => ({ hasKey: true, budgetLeft: 100 }),
  recordAiPass: async () => {},
}));
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);

import {
  activeIntake,
  analyzeCollected,
  codeCollectedGoods,
  endIntake,
  pickGoods,
  startIntake,
  updateIntake,
  type IntakeState,
} from '@/modules/platform/telegram/calc-intake';
import { tableEditsSettled } from '@/modules/platform/telegram/calc-dialog';
import { keptLastSettled } from '@/modules/platform/telegram/kept-last';
import { handleCalcCallback } from '@/modules/platform/telegram/staff-handlers';
import type { AmendBase } from '@/modules/wms/calc/amend-types';

type Goods = NonNullable<CalcFacts['goods']>;
const line = (name: string, extra: Partial<Goods[number]> = {}): Goods[number] => ({ name, ...extra });

let seq = 0;
const chats: bigint[] = [];
function collection(
  patch: Partial<IntakeState> = {},
  opts: { section?: IntakeState['section']; ai?: boolean; amend?: AmendBase | null } = {},
) {
  seq += 1;
  const chatId = BigInt(-9_300_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, opts.section ?? 'rastamojka', { staffId: 'staff-test', ai: opts.ai ?? false, amend: opts.amend ?? null });
  return { chatId, state: updateIntake(chatId, patch)! };
}

type Sent = { id: number; text: string };
function fakeCtx() {
  let next = 100;
  const replies: Sent[] = [];
  const edits: Sent[] = [];
  return {
    replies,
    edits,
    texts: () => replies.map((r) => r.text),
    async reply(text: string) {
      next += 1;
      replies.push({ id: next, text });
      return { message_id: next };
    },
    async answerCallbackQuery() {
      return true;
    },
    api: {
      async editMessageText(_chat: string, id: number, text: string) {
        edits.push({ id, text });
        return true;
      },
      async deleteMessage() {
        return true;
      },
      async setMessageReaction() {
        return true;
      },
    },
  };
}

const reads = (goods: Goods, facts: Partial<CalcFacts> = {}) => ({
  ok: true,
  facts: { fromCity: null, toCity: null, weightKg: null, volumeM3: null, goods, ...facts },
  steps: [],
  usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
  answered: [{ model: 'm', inputTokens: 1, outputTokens: 1 }],
});

/** A request of one stored row «Kurtka 300 dona», on the given door. */
const addBase = (door: 'plain' | 'ai'): AmendBase => ({
  requestId: '00000000-0000-4000-8000-0000000a5b01',
  cardLabel: 'B-00777',
  entityType: 'deal',
  entityId: '00000000-0000-4000-8000-0000000a5b02',
  leadOpen: null,
  section: 'rastamojka',
  clientLabel: 'GS777',
  openedRev: 1,
  weightKg: 3500,
  volumeM3: 12,
  fromCity: null,
  toCity: null,
  door,
  items: [
    {
      itemId: '00000000-0000-4000-8000-0000000a5b03',
      seq: 1,
      name: 'Kurtka',
      quantity: 300,
      weightKg: null,
      volumeM3: null,
      measureUnit: null,
      measureQty: null,
      tnvedCode: null,
      law: null,
      confirmed: false,
    },
  ],
});

beforeEach(() => {
  model.analyze.mockReset();
  resetReadingDrive();
});
afterEach(async () => {
  await tableEditsSettled();
  await keptLastSettled();
  for (const id of chats.splice(0)) endIntake(id);
});

describe('an add reading’s restated row reaches the summary and the save (as-built CHAT-1, his 1a §1.1)', () => {
  it('the reading JOB keeps what the add reading found: «↳ faylda 200 dona, so‘rovda 300 — VED hal qiladi», on both doors', async () => {
    for (const door of ['plain', 'ai'] as const) {
      const base = addBase(door);
      const { chatId } = collection(
        {
          stage: 'material',
          standingAtOpen: 'open',
          material: ['qoshimcha'],
          fileCount: 1,
          facts: { weightKg: 3500, volumeM3: 12, lineWeightsStated: true, goods: [line('Kurtka', { quantity: 300, seq: 1, itemId: base.items[0]!.itemId })] },
        },
        { ai: door === 'ai', amend: base },
      );
      // The top-up file restates the stored row with another count, and adds one.
      model.analyze.mockResolvedValueOnce(reads([line('Kurtka', { quantity: 200 }), line('Ryukzak', { quantity: 40 })]));
      const ctx = fakeCtx();
      await handleCalcCallback(ctx, chatId, 'done');
      await driveReading(chatId, ctx);
      const live = activeIntake(chatId)!;
      expect(live.conflicts.map((c) => [c.field, c.stored, c.read, c.choice]), door).toEqual([['quantity', 300, 200, 'ved']]);
      expect(ctx.texts().at(-1), door).toContain('↳ faylda 200 dona, so‘rovda 300 — VED hal qiladi');
    }
  });
});

describe('typed text beside an Excel when the model did not read (as-built FILES-3, §1.2.2)', () => {
  it('the add path names a typed line the Excel does not carry — never a second product', async () => {
    for (const failure of ['network', 'budget', 'not_configured'] as const) {
      model.analyze.mockReset();
      const { state } = collection({
        stage: 'material',
        material: ['Kurtka 300 dona'],
        fileCount: 2,
        aiGoods: 'add',
        invoiceGoods: [line('Ladies jacket', { quantity: 300 })],
        pdfs: [{ attachmentId: 'a-pdf', name: 'inv.pdf', bytes: 10 }],
      });
      model.analyze.mockResolvedValueOnce({ ok: false, failure });
      const read = await analyzeCollected(state);
      expect(read.facts.goods?.map((g) => g.name), failure).toEqual(['Ladies jacket']);
      expect(read.notes, failure).toContain('Rasmda/yozuvda Excel’da yo‘q tovar: «Kurtka» — VED tekshiradi');
    }
  });

  it('a REAL reading on the add path still adds what the model read (the rule is the model’s documents)', () => {
    const picked = pickGoods({
      invoice: [line('Ladies jacket', { quantity: 300 })],
      aiGoods: 'add',
      model: [line('Shapka', { quantity: 50 })],
      typed: [line('Kurtka', { quantity: 300 })],
      typedLabelled: [],
    });
    expect(picked.goods.map((g) => g.name)).toEqual(['Ladies jacket', 'Shapka']);
    const none = pickGoods({
      invoice: [line('Ladies jacket', { quantity: 300 })],
      aiGoods: 'add',
      model: null,
      typed: [line('Kurtka', { quantity: 300 })],
      typedLabelled: [],
    });
    expect(none.goods.map((g) => g.name)).toEqual(['Ladies jacket']);
    expect(none.sameAsInvoice.map((g) => [g.name, g.why])).toEqual([['Kurtka', 'typed']]);
  });
});

describe('a code the seller typed is his, even when the model reads it back (as-built FILES-6, §3.1)', () => {
  // The memory says another code for «Kurtka»; the book says nothing.
  const lookups = {
    memory: async (names: readonly string[]) => new Map(names.map((n) => [n, n === 'Kurtka' ? '6202930000' : null])),
    book: async (names: readonly string[]) => new Map(names.map((n) => [n, null])),
  };
  for (const typed of ['Kurtka 6201930000 300 dona 150 kg', 'Kurtka 6201.93.0000 300 dona 150 kg']) {
    it(`«${typed}»: the row keeps 6201930000 as its own — no «AI taklifi», never the memory’s`, async () => {
      const { state } = collection({ stage: 'material', material: [typed], ai: true });
      model.analyze.mockResolvedValueOnce(
        reads([line('Kurtka', { quantity: 300, weightKg: 150, tnvedCode: '6201930000' }), line('Shapka', { quantity: 50, tnvedCode: '6505009000' })]),
      );
      const read = await analyzeCollected(state);
      const kurtka = read.facts.goods?.find((g) => g.name === 'Kurtka');
      expect(kurtka?.tnvedSource).not.toBe('model');
      // A code nobody wrote stays the model's proposal.
      expect(read.facts.goods?.find((g) => g.name === 'Shapka')?.tnvedSource).toBe('model');
      const coded = await codeCollectedGoods(read, { timeoutMs: 5_000, lookups });
      const row = coded.facts.goods?.find((g) => g.name === 'Kurtka');
      expect([row?.tnvedCode, row?.tnvedSource ?? 'row']).toEqual(['6201930000', 'row']);
    });
  }
});
