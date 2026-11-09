import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Several files, no question (his 1a, docs/IKKI-ESHIK.md §1.2): the bot
 * compares the files itself — a packing list is read for its totals and the
 * weights the goods list lacks, the same row again is taken once, anything
 * else is added and named — and every decision is a note for the card. The
 * model, the budget and the hydrate's table are stand-ins: what is under test
 * is what the collector does with the files.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', () => ({ aiCalcBudgetLeft: async () => 100, recordAiPass: async () => {} }));
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);
// The hydrate reads the durable table; here it is three stored rows.
const stored = vi.hoisted(() => ({ rows: [] as { chat_id: string; note_id: string; state: unknown }[] }));
vi.mock('@/modules/platform/db/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/platform/db/client')>();
  return {
    ...real,
    db: new Proxy(real.db, {
      get(target, prop, receiver) {
        if (prop === 'execute') {
          return async (query: unknown) => {
            const text = JSON.stringify(query);
            return text.includes('FROM telegram_calc_intakes') && text.includes('SELECT') ? stored.rows : [];
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});
vi.mock('@/modules/wms/calc/intake-ended', () => ({ endedCollections: async () => ({ ended: new Set(), untold: [] }) }));

import { parseGoods } from '@/modules/wms/deals/goods-import';
import { readGoodsFile } from '@/modules/wms/deals/goods-file';
import { invoiceFacts, type CalcFacts } from '@/modules/wms/calc/intake';
import { activeIntake, analyzeCollected, endIntake, startIntake, updateIntake, type IntakeState } from '@/modules/platform/telegram/calc-intake';
import {
  __setIntakeTableProbe,
  hydrateIntakes,
  migrateIntakeState,
  setDurableIntakes,
} from '@/modules/platform/telegram/calc-store';
import { namesContradict, packingFills, packingTotals, sameFigures, sameRowAgain } from '@/modules/platform/telegram/file-goods';
import { handleCalcCallback, readIntakeFile, receiveGoodsSheet, RETIRED_FILE_STEP } from '@/modules/platform/telegram/staff-handlers';
import { readingsEnqueued, resetReadingDrive } from '../fixtures/calc-read-drive';

type Goods = NonNullable<CalcFacts['goods']>;
const line = (name: string, extra: Partial<Goods[number]> = {}): Goods[number] => ({ name, ...extra });

let seq = 0;
const chats: bigint[] = [];
function collection(patch: Partial<IntakeState> = {}, section: IntakeState['section'] = 'rastamojka') {
  seq += 1;
  const chatId = BigInt(-9_300_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, section, { staffId: 'staff-test' });
  return { chatId, state: updateIntake(chatId, { stage: 'material', material: ['x'], ...patch })! };
}

function fakeCtx() {
  const replies: { text: string; extra?: Record<string, unknown> }[] = [];
  return {
    replies,
    texts: () => replies.map((r) => r.text),
    async reply(text: string, extra?: Record<string, unknown>) {
      replies.push({ text, extra });
      return { message_id: 100 + replies.length };
    },
    api: {
      async editMessageText(): Promise<never> {
        throw new Error('message to edit not found');
      },
    },
  };
}

async function xlsx(rows: (string | number | null)[][]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Sheet1').addRows(rows);
  return Buffer.from(await book.xlsx.writeBuffer());
}

/** A file forwarded into the collection, through the bot's own door. */
async function forward(chatId: bigint, rows: (string | number | null)[][], name: string) {
  const body = await xlsx(rows);
  const answer = await readIntakeFile({ isPhoto: false, body, attachmentId: 'a-file' }, name, null, activeIntake(chatId)!);
  updateIntake(chatId, { ...answer.patch, fileCount: activeIntake(chatId)!.fileCount + 1 });
  return answer;
}

const PACKING_HEAD = ['Description', 'Qty (pcs)', 'CTN', 'N.W.(kg)', 'G.W.(kg)', 'CBM'];
const reads = (goods: Goods = []) => ({
  ok: true,
  facts: { fromCity: null, toCity: null, weightKg: null, volumeM3: null, goods },
  steps: [],
  usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
});

beforeEach(() => {
  resetReadingDrive();
  model.analyze.mockReset();
});
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});

describe('a mapped sheet is classified by its COLUMNS (§1.2.1)', () => {
  it('a carton or gross column with no money is a packing list; its gross Σ and m³ Σ are read over every row', () => {
    const packing = parseGoods([PACKING_HEAD, ['Kurtka', 300, 10, 150, 165, 1.2], ['Shim', 100, 4, 40, 46, 0.4]]);
    expect(packing).toMatchObject({ shape: 'packing', weightKind: 'net', grossKg: 211, grossColumn: true, volumeM3: 1.6 });
    // The line weights are the NET column's; the gross Σ is still the brutto.
    expect(packing.goods.map((g) => g.weightKg)).toEqual([150, 40]);
  });

  it('a money column makes it an invoice, whatever else stands', () => {
    expect(parseGoods([['Description', 'Qty', 'CTN', 'G.W.', 'Amount'], ['Kurtka', 300, 10, 165, 3750]]).shape).toBe('invoice');
    expect(parseGoods([['Description', 'Qty', 'Weight, kg'], ['Kurtka', 300, 150]])).toMatchObject({ shape: 'invoice', weightKind: 'plain', grossKg: null, grossColumn: false });
  });

  it('a gross Σ is null when one row lacks it — a Σ one line short wears the shipment’s name', () => {
    const holed = parseGoods([PACKING_HEAD, ['Kurtka', 300, 10, 150, 165, 1.2], ['Shim', 100, 4, 40, null, 0.4]]);
    expect([holed.grossKg, holed.grossColumn, holed.volumeM3]).toEqual([null, true, 1.6]);
  });

  it('the reader carries the shape and a packing list’s own rows as text', async () => {
    const read = await readGoodsFile(await xlsx([PACKING_HEAD, ['Kurtka', 300, 10, 150, 165, 1.2]]), null);
    expect(read).toMatchObject({ kind: 'goods', shape: 'packing', grossKg: 165, volumeM3: 1.2 });
    expect(read && read.kind === 'goods' ? read.ownText : null).toContain('G.W.(kg)');
    const invoice = await readGoodsFile(await xlsx([['Description', 'Qty', 'Amount'], ['Kurtka', 300, 3750]]), null);
    expect(invoice && invoice.kind === 'goods' ? invoice.ownText : 'x').toBeNull();
  });
});

describe('a packing-shaped further Excel gives totals and gaps, never a row (§1.2.2)', () => {
  it('no row is added and no count set; the brutto is the gross Σ; the note names what was read', async () => {
    const { chatId } = collection();
    await forward(chatId, [['Description', 'Qty', 'Amount'], ['Kurtka', 300, 3750], ['Shim', 100, 500]], 'invoice.xlsx');
    const answer = await forward(chatId, [PACKING_HEAD, ['Kurtka', 300, 10, 150, 165, 1.2], ['Shim', 100, 4, 40, 46, 0.4]], 'packing.xlsx');
    const s = activeIntake(chatId)!;
    expect(s.invoiceGoods?.map((g) => [g.name, g.quantity])).toEqual([
      ['Kurtka', 300],
      ['Shim', 100],
    ]);
    expect(s.fileTotals).toEqual({ weightKg: 211, volumeM3: 1.6, weightNetto: false, label: '«packing.xlsx»', at: { material: 1, files: 2 } });
    expect(answer.say).toContain('📄 «packing.xlsx» — o‘sha tovarlar: qatorlar oldingi fayldan, bundan faqat umumiy brutto va kub olindi.');
    // The fills: netto from the NET column, never over a stated figure.
    expect(s.invoiceGoods?.map((g) => g.weightKg)).toEqual([150, 40]);
    expect(answer.say).toContain('2 ta qatorga netto og‘irlik shu fayldan yozildi (yozilgan og‘irlikka tegilmadi).');
    // Its whole text joins the model's totals-only sheets.
    expect(s.invoiceTexts.map((t) => t.text).join('\n')).toContain('G.W.(kg)');
    // The decisions are receipt-time notes, in the same patch as the file.
    expect(answer.patch.fileNotes).toEqual(expect.arrayContaining([expect.stringContaining('o‘sha tovarlar')]));
  });

  it('brutto ONLY from a gross column: a net Σ is offered as a netto, and the note says there is no brutto column (M2)', () => {
    const { state } = collection({ invoiceGoods: [line('Kurtka', { quantity: 300 })] });
    const answer = receiveGoodsSheet(state, {
      goods: [line('Kurtka', { quantity: 300, weightKg: 150, volumeM3: 1.2 })],
      label: '«p.xlsx»',
      text: '',
      textCut: false,
      cellsCut: false,
      where: '',
      shape: { shape: 'packing', weightKind: 'net', grossKg: null, grossColumn: false, volumeM3: 1.2 },
    });
    expect(answer.patch.fileTotals).toMatchObject({ weightKg: 150, weightNetto: true, volumeM3: 1.2 });
    expect(answer.say).toContain('bundan faqat umumiy netto va kub olindi; brutto ustuni yo‘q.');
    // A plain weight column is neither a brutto nor a netto.
    expect(packingTotals({ weightKind: 'plain', grossKg: null, volumeM3: null }, [line('Kurtka', { weightKg: 150 })])).toEqual({
      weightKg: null,
      weightNetto: false,
      volumeM3: null,
    });
  });

  it('a held row takes a weight only from a NET column, and never over its own figure (INT-10)', () => {
    const held = [line('Kurtka', { quantity: 300 }), line('Shim', { quantity: 100, weightKg: 35 })];
    const packing = [line('Kurtka', { quantity: 300, weightKg: 150 }), line('Shim', { quantity: 100, weightKg: 40 })];
    expect(packingFills(held, [null, null], packing, 'net').goods.map((g) => g.weightKg)).toEqual([150, 35]);
    expect(packingFills(held, [null, null], packing, 'gross')).toEqual({ goods: held, filled: 0 });
    expect(packingFills(held, [null, null], packing, 'plain')).toEqual({ goods: held, filled: 0 });
  });

  it('a top-up writes no totals from a packing list: they go on the note for the VED (§1.2.3)', () => {
    const { state } = collection({ invoiceGoods: [line('Kurtka', { quantity: 300 })], seed: [line('Kurtka', { quantity: 300 })] });
    const answer = receiveGoodsSheet(state, {
      goods: [line('Kurtka', { quantity: 300, weightKg: 150 })],
      label: '«p.xlsx»',
      text: '',
      textCut: false,
      cellsCut: false,
      where: '',
      shape: { shape: 'packing', weightKind: 'net', grossKg: 165, grossColumn: true, volumeM3: 1.2 },
    });
    expect(answer.patch).not.toHaveProperty('fileTotals');
    expect(answer.say).toContain('📄 «p.xlsx» — packing list jami: brutto 165 kg, 1.2 m³ — so‘rovga yozilmadi, VED fayldan ko‘radi.');
  });
});

describe('the same row again: names meet AND every shared figure agrees (§1.2.2, M1, F3)', () => {
  it('one shared figure agreeing is not enough when another disagrees', () => {
    expect(sameRowAgain(line('Kurtka', { quantity: 300, weightKg: 150 }), line('Kurtka', { quantity: 300, weightKg: 150 }))).toBe(true);
    expect(sameRowAgain(line('Kurtka', { quantity: 300, weightKg: 150 }), line('Kurtka', { quantity: 300, weightKg: 90 }))).toBe(false);
    // Nothing shared says nothing: two factories' «Kurtka» with no figure to agree on.
    expect(sameRowAgain(line('Kurtka', { quantity: 300 }), line('Kurtka', { weightKg: 150 }))).toBe(false);
    expect(sameRowAgain(line('Kurtka', { quantity: 300 }), line('Shim', { quantity: 300 }))).toBe(false);
  });

  it('a gross weight is never compared with a netto', () => {
    const net = line('Kurtka', { quantity: 300, weightKg: 150 });
    const gross = line('Kurtka', { quantity: 300, weightKg: 165 });
    expect(sameRowAgain(net, gross, { held: 'net', read: 'gross' })).toBe(true);
    expect(sameRowAgain(net, gross, { held: 'net', read: 'net' })).toBe(false);
  });

  it('two factories’ same-named rows with other figures are both kept and named (INT-4)', () => {
    let state = collection().state;
    for (const [label, goods] of [
      ['«A.xlsx»', [line('Kurtka', { quantity: 300 })]],
      ['«B.xlsx»', [line('Kurtka', { quantity: 200 })]],
    ] as const) {
      const answer = receiveGoodsSheet(state, { goods: [...goods], label, text: '', textCut: false, cellsCut: false, where: '' });
      state = { ...state, ...answer.patch };
    }
    expect(state.invoiceGoods?.map((g) => g.quantity)).toEqual([300, 200]);
    expect(state.fileNotes).toContain(
      '📄 «B.xlsx» — «Kurtka» 200 dona: birinchi faylda ham «Kurtka» 300 dona — ikkalasi olindi (bir xil bo‘lsa, VED bittasini o‘chiradi).',
    );
  });

  it('another name with the same count AND weight is that row — unless the names contradict (M1 c)', () => {
    const excel = line('Ladies jacket', { quantity: 300, weightKg: 150 });
    expect(sameFigures(excel, line('Куртка женская', { quantity: 300, weightKg: 150 }))).toBe(true);
    expect(sameFigures(excel, line('Куртка женская', { quantity: 300 }))).toBe(false);
    expect(namesContradict('Phone case iPhone 16 Pro', 'Чехол iPhone 16 Plus')).toBe(true);
    expect(namesContradict('Nails 2.5*50mm', 'Гвозди 3×70 мм')).toBe(true);
    expect(namesContradict('Ceramic tile 60x60cm', 'Плитка 600×600 мм')).toBe(false);
    let state = collection().state;
    for (const [label, goods] of [
      ['«A.xlsx»', [excel]],
      ['«B.xlsx»', [line('Куртка женская', { quantity: 300, weightKg: 150 })]],
    ] as const) {
      const answer = receiveGoodsSheet(state, { goods: [...goods], label, text: '', textCut: false, cellsCut: false, where: '' });
      state = { ...state, ...answer.patch };
    }
    expect(state.invoiceGoods).toHaveLength(1);
    expect(state.fileNotes).toContain('📄 «B.xlsx» — «Куртка женская» va «Ladies jacket»: nomi boshqacha, raqamlari bir xil — bitta deb olindi.');
  });
});

describe('the totals in their rank: typed > answer > a packing list > the model (§1.2.5)', () => {
  const ft = (files: number): IntakeState['fileTotals'] => ({ weightKg: 3500, volumeM3: 28, weightNetto: false, label: '«p.xlsx»', at: { material: 1, files } });
  const modelSays = () =>
    model.analyze.mockResolvedValueOnce({ ...reads(), facts: { fromCity: null, toCity: null, weightKg: 9999, volumeM3: 99, goods: [] } });

  it('a packing list outranks the model; what the seller typed outranks the packing list', async () => {
    modelSays();
    const fromFile = await analyzeCollected(collection({ fileTotals: ft(1), fileCount: 1 }).state);
    expect([fromFile.facts.weightKg, fromFile.facts.volumeM3]).toEqual([3500, 28]);
    modelSays();
    const typed = await analyzeCollected(collection({ material: ['jami 4000 kg 30 kub'], fileTotals: ft(1), fileCount: 1 }).state);
    expect([typed.facts.weightKg, typed.facts.volumeM3]).toEqual([4000, 30]);
  });

  it('the table answer outranks the packing list — and one given BEFORE it is doubted, never one given after', async () => {
    // The model states no totals here: its own figure doubting an answer is R2's CONC-2, not this.
    model.analyze.mockResolvedValueOnce(reads());
    const after = await analyzeCollected(
      collection({ fileTotals: ft(1), fileCount: 2, totalsAnswer: { weightKg: 3600, volumeM3: null, at: { material: 1, files: 1 } } }).state,
    );
    expect(after.facts.weightKg).toBe(3600);
    expect(after.ambiguousTotals).toEqual([]);
    model.analyze.mockResolvedValueOnce(reads());
    const before = await analyzeCollected(
      collection({ fileTotals: ft(2), fileCount: 2, totalsAnswer: { weightKg: 3600, volumeM3: null, at: { material: 1, files: 1 } } }).state,
    );
    expect(before.ambiguousTotals).toEqual([{ field: 'weightKg', answered: 3600, stated: 3500 }]);
  });

  it('a netto from a packing list never stands for a freight section’s brutto', async () => {
    model.analyze.mockResolvedValueOnce(reads());
    const netto = await analyzeCollected(
      collection({ fileTotals: { ...ft(1)!, weightNetto: true }, fileCount: 1 }, 'yolkira').state,
    );
    expect(netto.facts.weightKg ?? null).toBeNull();
  });
});

describe('a collection hydrated holding a retired question (§1.3)', () => {
  it('the hydrate resolves it: «Bo‘ldi» is refused for no file, nothing is pending', async () => {
    const rows = (['pending', 'ask', 'context'] as const).map((kind, i) => {
      const chatId = BigInt(-9_399_000_000) - BigInt(i);
      chats.push(chatId);
      const state = startIntake(chatId, 'rastamojka', { staffId: 'staff-test' });
      endIntake(chatId);
      return {
        chat_id: String(chatId),
        note_id: state.noteId,
        state: {
          ...state,
          stage: 'material',
          material: ['Kurtka 300 dona'],
          invoiceGoods: [line('Kurtka', { quantity: 300 })],
          ...(kind === 'pending' ? { pendingInvoice: { goods: [line('Shim', { quantity: 100 })], label: '«B.xlsx»', texts: [] } } : {}),
          ...(kind === 'ask' ? { aiGoods: 'ask' } : {}),
          ...(kind === 'context' ? { aiGoods: 'context' } : {}),
        },
      };
    });
    stored.rows = rows;
    setDurableIntakes(true);
    __setIntakeTableProbe(async () => true);
    try {
      expect(await hydrateIntakes()).toBe(3);
    } finally {
      setDurableIntakes(false);
      __setIntakeTableProbe(null);
      stored.rows = [];
    }
    const [pending, ask, context] = rows.map((r) => activeIntake(BigInt(r.chat_id))!);
    expect(pending!.pendingInvoice).toBeNull();
    expect(pending!.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim']);
    expect(pending!.fileNotes).toEqual(['📄 «B.xlsx» — 1 ta yangi tovar qo‘shildi.']);
    expect(ask!.aiGoods).toBe('add');
    expect(context!.aiGoods).toBe('context');
    for (const r of rows) {
      const ctx = fakeCtx();
      await handleCalcCallback(ctx, BigInt(r.chat_id), 'done');
      expect(ctx.texts()).toEqual(['⏳ AI o‘qiyapti… (3 daqiqagacha)']);
      expect(readingsEnqueued(BigInt(r.chat_id))).toHaveLength(1);
    }
  });

  it('an unanswered conflict becomes the VED’s; an answered one stands', () => {
    const { state } = collection({
      conflicts: [
        { itemId: 'i1', seq: 1, field: 'quantity', unit: 'dona', stored: 300, read: 200, choice: null },
        { itemId: 'i2', seq: 2, field: 'quantity', unit: 'dona', stored: 10, read: 20, choice: 'rep' },
      ],
    });
    expect(migrateIntakeState(state).conflicts.map((c) => c.choice)).toEqual(['ved', 'rep']);
  });

  it('every retired file button answers in words, under any collection or none', async () => {
    const { chatId } = collection();
    for (const step of ['inv_add', 'inv_replace', 'other_add', 'other_same', 'conf_0_add', 'conf_1_rep', 'conf_2_ved'] as const) {
      const ctx = fakeCtx();
      await handleCalcCallback(ctx, chatId, step);
      expect(ctx.texts(), step).toEqual([RETIRED_FILE_STEP]);
      const none = fakeCtx();
      await handleCalcCallback(none, BigInt(-9_398_999_999), step);
      expect(none.texts(), step).toEqual([RETIRED_FILE_STEP]);
    }
    expect(RETIRED_FILE_STEP).toBe('Bu tugma eskirgan — fayllar o‘zi solishtirildi.');
  });
});

describe('one unit rule at the reader (§1.7, M10)', () => {
  it('«120 пар» is 120 juft, an m² is the pair, a carton count is a note — before any reader draws the row', () => {
    const rows = parseGoods([
      ['Наименование', 'Кол-во', 'Ед. изм.'],
      ['Кроссовки', 120, 'пар'],
      ['Плитка', 40, 'м2'],
      ['Сумка', 20, 'мест'],
      ['Куртка', 300, 'шт'],
    ]).goods;
    expect(invoiceFacts(rows).map((g) => [g.name, g.quantity ?? null, g.measureUnit ?? null, g.measureQty ?? null])).toEqual([
      ['Кроссовки', null, 'juft', 120],
      ['Плитка', null, 'm2', 40],
      ['Сумка', null, null, null],
      ['Куртка', 300, null, null],
    ]);
    expect(invoiceFacts(rows)[2]!.note).toContain('sotuvchi: 20 мест');
  });
});

describe('the card carries the receipt-time notes first (§1.2.5)', () => {
  it('landCollectedIntake puts fileNotes ahead of the reading’s notes and the model’s steps', () => {
    const src = readFileSync('src/modules/platform/telegram/staff-bot.ts', 'utf8');
    expect(src).toContain('steps: [...(state.fileNotes ?? []), ...state.notes, ...state.steps],');
  });

  it('a picture sent as a file is said, and noted', async () => {
    const { chatId } = collection();
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const answer = await readIntakeFile({ isPhoto: false, body: png, attachmentId: 'a-png' }, 'scan.png', 'image/png', activeIntake(chatId)!);
    expect(answer.say).toBe('🖼 «scan.png» — rasm sifatida o‘qiladi.');
    expect(answer.patch.fileNotes).toEqual(['🖼 «scan.png» — rasm sifatida o‘qiladi.']);
  });
});
