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
import { foldInvoice, packingFills, packingOfHeld, sameFileAgain } from '@/modules/platform/telegram/file-goods';
import { migrateIntakeState } from '@/modules/platform/telegram/calc-store';
import { handleCalcCallback } from '@/modules/platform/telegram/staff-handlers';
import type { AmendBase } from '@/modules/wms/calc/amend-types';
import { MAX_GOODS_ROWS, parseGoods } from '@/modules/wms/deals/goods-import';
import { invoiceFacts } from '@/modules/wms/calc/intake';
import { parseManualFacts } from '@/modules/wms/calc/intake-manual';
import { receiveGoodsSheet } from '@/modules/platform/telegram/calc-files';

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

describe('two big files are compared in milliseconds, not seconds (as-built DURABILITY-1)', () => {
  // The file rule runs SYNCHRONOUSLY inside the file's update on the one bot
  // process — the Next.js server's own — so its seconds were every chat's and
  // every web request's: 500 × 500 rows cost 3-9 s, 1000 × 500 up to 20 s
  // (measured at 91db8e6). Keyed once per name and looked up by index, the
  // same answers (pinned by the file rule's own tests) cost tens of ms.
  const ru = ['Куртка женская', 'Брюки мужские', 'Сумка кожаная', 'Кроссовки детские', 'Шапка вязаная'];
  const en = ['Ladies jacket', 'Mens trousers', 'Leather bag', 'Kids sneakers', 'Knit hat'];
  const zh = ['女士夹克', '男士裤子', '皮包', '儿童运动鞋', '针织帽'];
  const list = (n: number, kind: 'distinct' | 'bilingual' | 'zh', off = 0): Goods =>
    Array.from({ length: n }, (_, i) => {
      const k = (i + off) % 5;
      const name =
        kind === 'distinct'
          ? `Product ${i + off} model ${k}`
          : kind === 'bilingual'
            ? `${ru[k]} ${i + off} (${en[k]} ${i + off})`
            : `${zh[k]}${i + off} ${en[k]} ${i + off}`;
      return line(name, { quantity: 10 + ((i * 7) % 300), weightKg: 5 + ((i * 3) % 90), volumeM3: 0.1 });
    });
  const BUDGET_MS = 600;
  for (const kind of ['distinct', 'bilingual', 'zh'] as const) {
    it(`${kind} names, 1000 held × 500 read: another factory, the same names with other counts, a packing list`, () => {
      const held = list(1000, kind);
      const kinds = held.map(() => null);
      const other = list(500, kind, 5000);
      const restated = list(500, kind).map((g) => ({ ...g, quantity: (g.quantity ?? 0) + 1 }));
      const t0 = performance.now();
      const folded = foldInvoice(held, kinds, other, null, '«B.xlsx»');
      foldInvoice(held, kinds, restated, null, '«C.xlsx»');
      packingOfHeld(held, kinds, other.map((g) => ({ ...g, quantity: (g.quantity ?? 0) + 1000 })), 'gross');
      packingFills(held.map((g) => ({ ...g, weightKg: null })), kinds, other, 'net');
      sameFileAgain(held, restated, '', []);
      const spent = performance.now() - t0;
      expect(folded.added).toBe(500);
      expect(spent, `${kind}: ${spent.toFixed(0)} ms`).toBeLessThan(BUDGET_MS);
    });
  }

  it('the hydrate folds a 500-row waiting Excel over 500 held rows inside the budget', () => {
    const held = list(500, 'bilingual');
    // Other goods, at counts no held row states: every one of them added.
    const pending = list(500, 'bilingual', 7000).map((g) => ({ ...g, quantity: (g.quantity ?? 0) + 1000 }));
    const row = {
      ...activeIntake(collection().chatId)!,
      invoiceGoods: held,
      pendingInvoice: { goods: pending, label: '«B.xlsx»', texts: [] },
      aiGoods: 'ask' as const,
    } as unknown as IntakeState;
    const t0 = performance.now();
    const migrated = migrateIntakeState(row);
    const spent = performance.now() - t0;
    expect(migrated.invoiceGoods).toHaveLength(1000);
    expect(spent, `${spent.toFixed(0)} ms`).toBeLessThan(BUDGET_MS);
  });
});

/** A mapped sheet handed to the file rule as the reader hands it. */
const sheet = (label: string, rows: (string | number | null)[][]) => {
  const parsed = parseGoods(rows);
  return {
    goods: invoiceFacts(parsed.goods),
    label,
    text: '',
    textCut: false,
    cellsCut: false,
    where: '',
    shape: { shape: parsed.shape, weightKind: parsed.weightKind, grossKg: parsed.grossKg, grossColumn: parsed.grossColumn, volumeM3: parsed.volumeM3 },
    ...(parsed.goods.length >= MAX_GOODS_ROWS ? { capped: MAX_GOODS_ROWS } : {}),
  };
};
/** A file received into the live collection, as the bot's door writes it. */
function receive(chatId: bigint, file: ReturnType<typeof sheet>) {
  const answer = receiveGoodsSheet(activeIntake(chatId)!, file);
  return updateIntake(chatId, { ...answer.patch, fileCount: activeIntake(chatId)!.fileCount + 1 })!;
}
const INVOICE = [
  ['Description', 'Qty', 'Amount'],
  ['Kurtka', 300, 3000],
  ['Sumka', 100, 900],
  ['Shim', 200, 1600],
];
const PACKING = [
  ['Description', 'Qty (pcs)', 'CTN', 'G.W.(kg)', 'CBM'],
  ['Kurtka', 300, 10, 2000, 8],
  ['Sumka', 100, 4, 500, 3],
  ['Shim', 200, 6, 1000, 4],
];

describe('beside a goods list a typed line’s figure is the line’s (as-built CHAT-3 / CRITIC-2-NEW, §2.2, R3 §0.1(3))', () => {
  it('parseManualFacts: «3: 150 kg», «Sumka 80 kg», «Shapka 50 dona 20 kg» are no total beside goods; «jami», «brutto» and a bare total still are', () => {
    for (const text of ['3: 150 kg', '3-qator 150 kg', 'Sumka 80 kg', 'Shapka 50 dona 20 kg', '3: 150 kg\nrahmat']) {
      expect(parseManualFacts(text, 'podklyuch', { goodsBeside: true }).weightKg, text).toBeNull();
    }
    for (const text of ['jami 3500 kg', 'brutto 3500 kg', '3500 kg', 'Shapka 50 dona 20 kg\njami 3500 kg']) {
      expect(parseManualFacts(text, 'podklyuch', { goodsBeside: true }).weightKg, text).toBe(3500);
    }
    // Alone, with nothing held, a lone goods line IS the shipment, as always.
    expect(parseManualFacts('Shapka 50 dona 20 kg', 'podklyuch').weightKg).toBe(20);
  });

  for (const ai of [false, true]) {
    for (const typed of ['3: 150 kg', 'Sumka 80 kg', '3: 150 kg\nrahmat']) {
      it(`${ai ? 'AI' : 'plain'} door: invoice + packing list (brutto 3500) + «${typed.replace('\n', ' ⏎ ')}» typed before «Bo‘ldi» — the brutto stays 3500`, async () => {
        const { chatId } = collection({ stage: 'material', material: [typed] }, { section: 'podklyuch', ai });
        receive(chatId, sheet('«invoice.xlsx»', INVOICE));
        const state = receive(chatId, sheet('«packing.xlsx»', PACKING));
        expect(state.fileTotals?.weightKg).toBe(3500);
        // The model reads the typed figure as a total too — the packing list outranks it.
        model.analyze.mockResolvedValueOnce(reads([], { weightKg: 150 }));
        const read = await analyzeCollected(state);
        expect(read.facts.weightKg).toBe(3500);
      });
    }
    it(`${ai ? 'AI' : 'plain'} door: a forgotten good with its weight typed after a reading never becomes the shipment’s brutto`, async () => {
      const { chatId } = collection({ stage: 'material', material: ['GS777'] }, { section: 'podklyuch', ai });
      receive(chatId, sheet('«invoice.xlsx»', INVOICE));
      receive(chatId, sheet('«packing.xlsx»', PACKING));
      const state = updateIntake(chatId, { material: [...activeIntake(chatId)!.material, 'Shapka 50 dona 20 kg'] })!;
      model.analyze.mockResolvedValueOnce(reads([], { weightKg: 3500 }));
      const read = await analyzeCollected(state);
      expect(read.facts.weightKg).toBe(3500);
    });
  }

  it('the add door’s typed line doubts no table answer: a new good’s kilos are the line’s', async () => {
    const base = addBase('plain');
    const { state } = collection(
      {
        stage: 'material',
        material: ['Shapka 50 dona 20 kg'],
        totalsAnswer: { weightKg: 3500, volumeM3: null, at: { material: 0, files: 0 } },
        facts: { weightKg: 3500, lineWeightsStated: true, goods: [line('Kurtka', { quantity: 300, seq: 1, itemId: base.items[0]!.itemId })] },
      },
      { amend: base },
    );
    model.analyze.mockResolvedValueOnce(reads([line('Shapka', { quantity: 50, weightKg: 20 })]));
    const read = await analyzeCollected(state);
    expect(read.facts.weightKg).toBe(3500);
    expect(read.ambiguousTotals).toEqual([]);
  });
});

describe('a top-up’s packing list is a NOTED file whatever is held (as-built FILES-2, §1.2.3)', () => {
  for (const kind of ['amend', 'seed'] as const) {
    it(`${kind}: a new invoice, then the whole shipment’s packing list in Russian — no new line, one noted line`, () => {
      const { chatId } =
        kind === 'amend'
          ? collection({ stage: 'material' }, { amend: addBase('plain') })
          : collection({ stage: 'material', seed: [line('Ladies jacket', { quantity: 300, weightKg: 150 })] });
      receive(chatId, sheet('«new.xlsx»', [['Description', 'Qty', 'Amount'], ['Shapka', 50, 250]]));
      const state = receive(
        chatId,
        sheet('«packing.xlsx»', [
          ['Наименование', 'Кол-во', 'Мест', 'Вес нетто', 'Вес брутто', 'Объем м3'],
          ['Куртка женская', 300, 10, 150, 165, 1.2],
          ['Шапка', 50, 2, 10, 12, 0.2],
        ]),
      );
      expect(state.invoiceGoods?.map((g) => g.name)).toEqual(['Shapka']);
      expect(state.fileNotes.filter((n) => n.includes('«packing.xlsx» — packing list jami'))).toHaveLength(1);
      expect(state.fileNotes.some((n) => n.includes('yangi tovar qo‘shildi') && n.includes('packing'))).toBe(false);
      expect(state.fileTotals ?? null).toBeNull();
    });
  }
});

describe('a lone packing list gives its brutto and cube at the reading (as-built FILES-4, INT-10)', () => {
  it('AI podklyuch, the packing list alone: brutto and cube from its own columns — nothing asked of the file', async () => {
    const { chatId } = collection({ stage: 'material', material: ['GS777'] }, { section: 'podklyuch', ai: true });
    const state = receive(
      chatId,
      sheet('«packing.xlsx»', [
        ['Description', 'Qty (pcs)', 'CTN', 'N.W.(kg)', 'G.W.(kg)', 'CBM'],
        ['Kurtka', 300, 10, 150, 165, 1.2],
        ['Shim', 100, 4, 40, 46, 0.4],
      ]),
    );
    expect(state.fileTotals ?? null).toBeNull();
    model.analyze.mockResolvedValueOnce(reads([]));
    const read = await analyzeCollected(state);
    expect([read.facts.weightKg, read.facts.volumeM3]).toEqual([211, 1.6]);
  });

  it('a lone invoice with a G.W. column gives its gross Σ; a lone packing list then another factory’s invoice gives nothing', async () => {
    const one = collection({ stage: 'material', material: ['GS777'] }, { section: 'podklyuch', ai: true });
    const lone = receive(one.chatId, sheet('«inv.xlsx»', [['Description', 'Qty', 'G.W.(kg)', 'Amount'], ['Kurtka', 300, 165, 3000], ['Shim', 100, 46, 800]]));
    model.analyze.mockResolvedValueOnce(reads([]));
    expect((await analyzeCollected(lone)).facts.weightKg).toBe(211);

    const two = collection({ stage: 'material', material: ['GS777'] }, { section: 'podklyuch', ai: true });
    receive(two.chatId, sheet('«packing.xlsx»', [['Description', 'Qty (pcs)', 'CTN', 'G.W.(kg)', 'CBM'], ['Kurtka', 300, 10, 165, 1.2]]));
    const folded = receive(two.chatId, sheet('«zavod2.xlsx»', [['Description', 'Qty', 'Amount'], ['Choynak', 40, 200]]));
    model.analyze.mockResolvedValueOnce(reads([]));
    const read = await analyzeCollected(folded);
    expect([read.facts.weightKg ?? null, read.facts.volumeM3 ?? null]).toEqual([null, null]);
  });
});
