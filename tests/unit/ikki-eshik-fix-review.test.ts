import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalcFacts } from '@/modules/wms/calc/intake';
import { resetReadingDrive } from '../fixtures/calc-read-drive';

/**
 * The review of the as-built FIXES of «Ikki eshik» (docs/IKKI-ESHIK.md): each
 * fix of the as-built review carried its own regression, as every fix round
 * here has (DECISIONS #1114, #1267, #1281, #1581). What the fixes' review
 * found, pinned where it bites — the typed totals beside a goods list, a
 * two-row header's units and its sub-header words, the belt's totals, a typed
 * code on its own line, a top-up's noted packing list on the card, and the
 * verbatim record of a split answer.
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
  startIntake,
  updateIntake,
  type IntakeState,
} from '@/modules/platform/telegram/calc-intake';
import { amendSubmissionOf } from '@/modules/platform/telegram/calc-amend';
import { routeCollectorText, tableEditsSettled } from '@/modules/platform/telegram/calc-dialog';
import { keptLastSettled } from '@/modules/platform/telegram/kept-last';
import type { AmendBase } from '@/modules/wms/calc/amend-types';
import { amendNoteText } from '@/modules/wms/calc/amend';
import ExcelJS from 'exceljs';
import { MAX_GOODS_ROWS, parseGoods } from '@/modules/wms/deals/goods-import';
import { readGoodsFile } from '@/modules/wms/deals/goods-file';
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
  const chatId = BigInt(-9_400_000_000) - BigInt(seq);
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

/** A request of one stored row «Ladies jacket 300 dona», on the given door. */
const addBase = (door: 'plain' | 'ai'): AmendBase => ({
  requestId: '00000000-0000-4000-8000-0000000b5b01',
  cardLabel: 'B-00778',
  entityType: 'deal',
  entityId: '00000000-0000-4000-8000-0000000b5b02',
  leadOpen: null,
  section: 'rastamojka',
  clientLabel: 'GS777',
  openedRev: 1,
  weightKg: 150,
  volumeM3: null,
  fromCity: null,
  toCity: null,
  door,
  items: [
    {
      itemId: '00000000-0000-4000-8000-0000000b5b03',
      seq: 1,
      name: 'Ladies jacket',
      quantity: 300,
      weightKg: 150,
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

describe('a typed TOTAL beside a goods list is still the shipment’s (fix review FR-REGR-1, FR-SELL-1)', () => {
  // The goods reader takes each of these for a goods line («Kurtka va shim
  // jami», «Jami /», «Karobka», «Massa») — and CHAT-3's rule made any lone
  // goods line the line's beside held rows, so the seller's own total was lost.
  const TOTALS: [string, number, number | null][] = [
    ['Kurtka va shim jami 3600 kg', 3600, null],
    ['Kurtka, xammasi karobka: 25, 3600 kg, 13 kub', 3600, 13],
    ['Faktik vazn 3600 kg', 3600, null],
    ['Обший вес 3600 кг', 3600, null],
    ['Karobka 20 ta, 3600 kg', 3600, null],
    ['Kurtka umumiy vazni 3600 kg', 3600, null],
    ['Jami: 3500 kg / 15 kub', 3500, 15],
    ['Brutto: 3500 kg / 15 kub', 3500, 15],
    ['Итого: 3500 кг / 15 м3', 3500, 15],
    ['Jami: 3500kg/15kub', 3500, 15],
    ['Jami - 3500 kg / 15 kub', 3500, 15],
    ['Hamma yuk 3500 kg', 3500, null],
    ['Barcha tovar 3500 kg 15 kub', 3500, 15],
    ['Весь груз 3500 кг', 3500, null],
    ['Hamma karobka/qop 3500 kg', 3500, null],
    ['Massa 3500 kg', 3500, null],
  ];
  it('parseManualFacts with goodsBeside: every shipment line keeps its figure; CHAT-3’s rows stay the rows’', () => {
    for (const [text, kg, m3] of TOTALS) {
      const read = parseManualFacts(text, 'podklyuch', { goodsBeside: true });
      expect([read.weightKg, read.volumeM3], text).toEqual([kg, m3]);
    }
    for (const text of ['3: 150 kg', '3-qator 150 kg', 'Sumka 80 kg', 'Shapka 50 dona 20 kg', '3: 150 kg\nrahmat']) {
      expect(parseManualFacts(text, 'podklyuch', { goodsBeside: true }).weightKg, text).toBeNull();
    }
  });

  for (const ai of [false, true]) {
    for (const [typed, kg, m3] of [['Kurtka va shim jami 3600 kg', 3600, null], ['Jami: 3600 kg / 16 kub', 3600, 16]] as const) {
      it(`${ai ? 'AI' : 'plain'} door: invoice + packing list (3500) + «${typed}» — the seller’s total outranks the file`, async () => {
        const { chatId } = collection({ stage: 'material', material: [typed] }, { section: 'podklyuch', ai });
        receive(chatId, sheet('«invoice.xlsx»', INVOICE));
        const state = receive(chatId, sheet('«packing.xlsx»', PACKING));
        expect(state.fileTotals?.weightKg).toBe(3500);
        model.analyze.mockResolvedValueOnce(reads([], { weightKg: kg }));
        const read = await analyzeCollected(state);
        expect([read.facts.weightKg, m3 === null ? null : read.facts.volumeM3], typed).toEqual([kg, m3]);
      });
    }
  }

  it('the add door: «Kurtka va shim jami 3600 kg» typed after a 3500 table answer doubts it', async () => {
    const base = addBase('plain');
    const { state } = collection(
      {
        stage: 'material',
        material: ['Kurtka va shim jami 3600 kg'],
        totalsAnswer: { weightKg: 3500, volumeM3: null, at: { material: 0, files: 0 } },
        facts: { weightKg: 3500, lineWeightsStated: true, goods: [line('Ladies jacket', { quantity: 300, seq: 1, itemId: base.items[0]!.itemId })] },
      },
      { amend: base },
    );
    model.analyze.mockResolvedValueOnce(reads([]));
    const read = await analyzeCollected(state);
    expect(read.ambiguousTotals.map((a) => a.field)).toEqual(['weightKg']);
  });
});

describe('a two-row header keeps its parent’s unit (fix review FR-REGR-2)', () => {
  type Cell = string | number | null;
  const facts = (nm: string, parent: string, a: string, b: string) => {
    const rows: Cell[][] = [
      [nm, parent, null, 'G.W. (KG)'],
      [null, a, b, null],
      ['Плитка', 12, 120, 300],
      ['Item 2', 10, 50, 200],
    ];
    return invoiceFacts(parseGoods(rows).goods).map((g) => [g.quantity ?? null, g.measureUnit ?? null, g.measureQty ?? null, g.weightKg ?? null, g.note ?? null]);
  };
  for (const [nm, parent, a, b, unit] of [
    ['Наименование', 'Кол-во, м2', 'в 1 коробке', 'всего', 'm2'],
    ['Наименование', 'Количество, пар', 'в коробке', 'всего', 'juft'],
    ['品名', '数量(双)', '每箱', '合计', 'juft'],
    ['Description', 'QTY (PAIRS)', 'PER CTN', 'TOTAL', 'juft'],
    ['Description', 'Quantity (m2)', 'per carton', 'total', 'm2'],
    ['Tovar nomi', 'Soni (juft)', 'har biri', 'jami', 'juft'],
  ] as const) {
    it(`«${parent}» over «${a} | ${b}»: the line’s ${unit} count is the TOTAL column, in the parent’s unit`, () => {
      // (The fifth figure is the seller's own unit note, «sotuvchi: 120 м2».)
      expect(facts(nm, parent, a, b).map((r) => r.slice(0, 4))).toEqual([
        [null, unit, 120, 300],
        [null, unit, 50, 200],
      ]);
    });
  }
  it('«QTY (PCS)» over «PER CTN | TOTAL» stays pieces', () => {
    expect(facts('Description', 'QTY (PCS)', 'PER CTN', 'TOTAL')).toEqual([
      [120, null, null, 300, null],
      [50, null, null, 200, null],
    ]);
  });
  it('«Кол-во, кг» over «1 места | всего»: a WEIGHT, the total column — never 120 pieces, never one place’s 12 as cartons', () => {
    expect(facts('Наименование', 'Кол-во, кг', '1 места', 'всего')).toEqual([
      [null, null, null, 120, null],
      [null, null, null, 50, null],
    ]);
  });
});

describe('a PLURAL package after the slash or «in» counts the cartons (fix review FR-REGR-6)', () => {
  const read = (h: string) =>
    invoiceFacts(parseGoods([['Description', h, 'G.W.(KG)', 'CBM'], ['Kurtka', 10, 100, 1], ['Shim', 4, 50, 0.5]]).goods).map((g) => [
      g.quantity ?? null,
      g.note ?? null,
    ]);
  for (const [h, unit] of [
    ['QTY IN CTNS', 'ctns'],
    ['Qty in cartons', 'cartons'],
    ['QTY/CTNS', 'ctns'],
    ['Total qty in cartons', 'cartons'],
    ['Quantity in boxes', 'boxes'],
    ['Кол-во/мест', 'мест'],
  ] as const) {
    it(`«${h}»: the carton column — the VED’s «sotuvchi: N ${unit}» note, as before`, () => {
      expect(read(h)).toEqual([
        [null, `sotuvchi: 10 ${unit}`],
        [null, `sotuvchi: 4 ${unit}`],
      ]);
    });
  }
  it('ONE package’s count stays nobody’s: «PCS/CTN», «QTY/CTN», «PCS IN CTN», «PCS/CTNS», «Кол-во в коробке»', () => {
    for (const h of ['PCS/CTN', 'QTY/CTN', 'PCS IN CTN', 'PCS/CTNS', 'Кол-во в коробке']) {
      expect(read(h), h).toEqual([
        [null, null],
        [null, null],
      ]);
    }
  });
});

/** A real .xlsx with real merges, read through the bot's own file reader. */
async function workbook(rows: (string | number | null)[][], merges: string[] = []) {
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet('Packing');
  ws.addRows(rows);
  for (const m of merges) ws.mergeCells(m);
  const read = await readGoodsFile(Buffer.from(await book.xlsx.writeBuffer()), null);
  if (!read || read.kind !== 'goods') throw new Error(`not read as goods: ${JSON.stringify(read)}`);
  return read;
}

describe('the commonest sub-header words compose a two-row header (fix review FR-SELL-2)', () => {
  const DATA = [
    ['Ladies jacket', 300, 10, 15, 150, 1.2],
    ['Trousers', 100, 4, 10, 40, 0.4],
  ];
  for (const [parent, a, b] of [
    ['G.W. (KG)', 'PER CTN', 'TTL'],
    ['G.W. (KG)', 'SINGLE', 'TOTAL'],
    ['G.W. (KG)', 'EACH', 'TTL'],
    ['G.W. (KG)', 'PER CTN', 'TTL.'],
    ['G.W. (KG)', 'CTN', 'TTL'],
    ['Вес брутто, кг', 'в 1 месте', 'всего'],
    ['Вес брутто, кг', 'за 1 место', 'итого'],
    ['Вес брутто, кг', '1 кор.', 'всего'],
    ['Вес брутто, кг', '1 коробки', 'всего'],
  ] as const) {
    it(`«${parent}» merged over «${a} | ${b}»: the lines are the total column, the brutto 190`, async () => {
      const read = await workbook([['Description', 'Qty', 'CTNS', parent, null, 'CBM'], [null, null, null, a, b, null], ...DATA], ['D1:E1']);
      expect(read.goods.map((g) => [g.description, g.weightKg])).toEqual([['Ladies jacket', 150], ['Trousers', 40]]);
      expect([read.grossKg, read.volumeM3]).toEqual([190, 1.6]);
    });
  }
});

describe('the belt refuses a contradiction, never a rounding or a section’s total (fix review FR-REGR-4, FR-SELL-3)', () => {
  type Cell = string | number | null;
  const H: Cell[] = ['Description', 'CTN', 'G.W.(kg)', 'CBM'];
  const totals = (rows: Cell[][]) => {
    const p = parseGoods(rows);
    return [p.grossKg, p.volumeM3];
  };
  it('a TOTAL written as text with a thousands comma or dot («1,650», «1.650») is no contradiction', () => {
    expect(totals([H, ['Kurtka', '10', '1200', '4.2'], ['Shim', '5', '450', '2.2'], ['TOTAL', '15', '1,650', '6.4']])).toEqual([1650, 6.4]);
    expect(totals([H, ['Kurtka', '10', '1200', '4.2'], ['Shim', '5', '450', '2.2'], ['TOTAL', '15', '1.650', '6.4']])).toEqual([1650, 6.4]);
  });
  it('a cube TOTAL rounded to its printed decimal agrees with the lines (0.7 over 0.726, 2.4 over 2.371, 1.3 over 1.26)', () => {
    expect(totals([H, ['Kurtka', 10, 111, 0.413], ['Shim', 5, 100, 0.313], ['TOTAL', 15, 211, 0.7]])).toEqual([211, 0.726]);
    expect(totals([H, ['Kurtka', 10, 111, 1.234], ['Shim', 5, 100, 1.137], ['TOTAL', 15, 211, 2.4]])).toEqual([211, 2.371]);
    expect(
      totals([H, ['A', 1, 10, 0.25], ['B', 1, 10, 0.33], ['C', 1, 10, 0.41], ['D', 1, 10, 0.27], ['TOTAL', 4, 40, 1.3]]),
    ).toEqual([40, 1.26]);
  });
  it('a «TOTAL» under each section and no grand total: the sections add up to the Σ', () => {
    expect(totals([H, ['Kurtka', 10, 100, 1.0], ['TOTAL', 10, 100, 1.0], ['Shim', 5, 166, 1.1], ['TOTAL', 5, 166, 1.1]])).toEqual([266, 2.1]);
    expect(
      totals([H, ['Kurtka', 10, 150, 1.2], ['Shim', 4, 61, 0.4], ['TOTAL', 14, 211, 1.6], ['Shapka', 2, 17, 0.3], ['TOTAL', 2, 17, 0.3]]),
    ).toEqual([228, 1.9]);
    // …and a last «TOTAL» that IS the grand total still is.
    expect(
      totals([H, ['Kurtka', 10, 100, 1.0], ['TOTAL', 10, 100, 1.0], ['Shim', 5, 166, 1.1], ['TOTAL', 5, 166, 1.1], ['TOTAL', 15, 266, 2.1]]),
    ).toEqual([266, 2.1]);
  });
  it('kept: a TOTAL heavier than the lines (a pallet, one carton’s column) is refused', () => {
    expect(totals([H, ['Kurtka', 10, 100, 1.0], ['Shim', 5, 166, 1.1], ['TOTAL', 15, 300, 2.1]])).toEqual([null, 2.1]);
    expect(
      totals([['Description', 'Qty', 'G.W.(kg)', 'CBM'], ['Ladies jacket', 300, 15, 1.2], ['Trousers', 100, 10, 0.4], ['TOTAL', 400, 190, 1.6]]),
    ).toEqual([null, 1.6]);
  });
});

describe('a typed code is the seller’s on HIS line only (fix review FR-REGR-3, §3.1)', () => {
  const lookups = {
    memory: async (names: readonly string[]) => new Map(names.map((n) => [n, n === 'Shim' ? '6203429000' : null])),
    book: async (names: readonly string[]) => new Map(names.map((n) => [n, null])),
  };
  it('the model copies the jacket’s typed code onto the trousers: the trousers’ code is the model’s, the memory answers', async () => {
    const { state } = collection({ stage: 'material', material: ['Kurtka 6201930000 300 dona 150 kg\nShim 200 dona 80 kg'], ai: true });
    model.analyze.mockResolvedValueOnce(
      reads([
        line('Kurtka', { quantity: 300, weightKg: 150, tnvedCode: '6201930000' }),
        line('Shim', { quantity: 200, weightKg: 80, tnvedCode: '6201930000' }),
      ]),
    );
    const read = await analyzeCollected(state);
    expect(read.facts.goods?.find((g) => g.name === 'Kurtka')?.tnvedSource).not.toBe('model');
    expect(read.facts.goods?.find((g) => g.name === 'Shim')?.tnvedSource).toBe('model');
    const coded = await codeCollectedGoods(read, { timeoutMs: 5_000, lookups });
    const shim = coded.facts.goods?.find((g) => g.name === 'Shim');
    expect(shim?.tnvedCode).toBe('6203429000');
    expect(coded.facts.goods?.find((g) => g.name === 'Kurtka')?.tnvedCode).toBe('6201930000');
  });
  it('two typed lines with the SAME count and no weights: the copied code is still the model’s (the check after the fixes’ review)', async () => {
    const { state } = collection({ stage: 'material', material: ['Kurtka 6201930000 100 dona\nShim 100 dona'], ai: true });
    model.analyze.mockResolvedValueOnce(
      reads([line('Kurtka', { quantity: 100, tnvedCode: '6201930000' }), line('Shim', { quantity: 100, tnvedCode: '6201930000' })]),
    );
    const read = await analyzeCollected(state);
    expect(read.facts.goods?.find((g) => g.name === 'Kurtka')?.tnvedSource).not.toBe('model');
    expect(read.facts.goods?.find((g) => g.name === 'Shim')?.tnvedSource).toBe('model');
  });
  it('…and a typed line the model renamed (a translation) keeps its code by its count when no other line shares it', async () => {
    const { state } = collection({ stage: 'material', material: ['Kurtka 6201930000 100 dona\nShim 200 dona'], ai: true });
    model.analyze.mockResolvedValueOnce(
      reads([line('Куртка', { quantity: 100, tnvedCode: '6201930000' }), line('Shim', { quantity: 200 })]),
    );
    const read = await analyzeCollected(state);
    expect(read.facts.goods?.find((g) => g.name === 'Куртка')?.tnvedSource).not.toBe('model');
  });
  it('a code typed on a line of its own is the seller’s for the one line the model puts it on', async () => {
    const { state } = collection({ stage: 'material', material: ['Kurtka 300 dona 150 kg\nTNVED 6201930000'], ai: true });
    model.analyze.mockResolvedValueOnce(reads([line('Kurtka', { quantity: 300, weightKg: 150, tnvedCode: '6201930000' })]));
    const read = await analyzeCollected(state);
    expect(read.facts.goods?.find((g) => g.name === 'Kurtka')?.tnvedSource).not.toBe('model');
  });
});

describe('a top-up’s noted packing list reaches the VED on the add door (fix review FR-SELL-6, §1.2.3)', () => {
  it('the submission carries the noted line, and the card note prints it', () => {
    const { chatId } = collection({ stage: 'material' }, { amend: addBase('plain') });
    receive(chatId, sheet('«new.xlsx»', [['Description', 'Qty', 'Amount'], ['Shapka', 50, 250]]));
    const state = receive(
      chatId,
      sheet('«packing.xlsx»', [
        ['Наименование', 'Кол-во', 'Мест', 'Вес нетто', 'Вес брутто', 'Объем м3'],
        ['Куртка женская', 300, 10, 150, 165, 1.2],
        ['Шапка', 50, 2, 10, 12, 0.2],
      ]),
    );
    const submission = amendSubmissionOf(state);
    const noted = '📄 «packing.xlsx» — packing list jami: brutto 177 kg, 1.4 m³ — so‘rovga yozilmadi, VED fayldan ko‘radi.';
    expect(submission.fileNotes ?? []).toContain(noted);
    const note = amendNoteText({
      section: 'rastamojka',
      card: 'B-00778',
      collectedBy: 'Ali',
      fileCount: 2,
      material: [],
      fileNotes: submission.fileNotes ?? [],
    });
    expect(note).toContain(noted);
  });
});

describe('a split answer is recorded once in the seller’s words (fix review FR-SELL-8)', () => {
  for (const ai of [false, true]) {
    it(`${ai ? 'AI' : 'plain'} door, collecting after a reading: «3: 150 kg ⏎ Shapka 20 dona» — each typed line once`, async () => {
      const { chatId } = collection(
        {
          stage: 'material',
          material: ['GS777'],
          readMark: { material: 1, files: 0 },
          facts: {
            weightKg: null,
            goods: [line('Kurtka', { quantity: 300 }), line('Sumka', { quantity: 100 }), line('Shim', { quantity: 200 })],
          },
        },
        { section: 'rastamojka', ai },
      );
      const ctx = fakeCtx();
      await routeCollectorText(ctx, chatId, activeIntake(chatId)!, '3: 150 kg\nShapka 20 dona', {
        date: 0,
        messageId: 900,
        forwarded: false,
        replyTo: null,
      });
      await tableEditsSettled();
      const live = activeIntake(chatId)!;
      const verbatim = [...live.material, ...live.answers].join('\n');
      expect(verbatim.split('\n').filter((l) => l.includes('Shapka 20 dona')), verbatim).toHaveLength(1);
      expect(verbatim, verbatim).toContain('150 kg');
    });
  }
});
