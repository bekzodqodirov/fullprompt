import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalcFacts } from '@/modules/wms/calc/intake';

/**
 * The «Hisoblatish» collector after the round-3 review of docs/SAKKIZ-BAND.md
 * (R3-C1…C6). The model is a script and the spreadsheet reader can be told
 * what to answer — the question is what the COLLECTOR does with both: which
 * lines land, what the seller and the model are told about a file, who the
 * summary and the lead say the customer is, and which line is asked next.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', () => ({ aiCalcBudgetLeft: async () => 100 }));

const reader = vi.hoisted(() => ({ answer: null as unknown }));
vi.mock('@/modules/wms/deals/goods-file', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/wms/deals/goods-file')>();
  return {
    ...real,
    readGoodsFile: async (...args: Parameters<typeof real.readGoodsFile>) =>
      reader.answer ?? real.readGoodsFile(...args),
  };
});

import {
  activeIntake,
  analyzeCollected,
  endIntake,
  intakeClientLabel,
  intakeClientSummary,
  pickGoods,
  resolveLineDone,
  sameAsInvoiceNote,
  startIntake,
  updateIntake,
  type IntakeState,
} from '@/modules/platform/telegram/calc-intake';
import {
  aiStepsText,
  clientAnswer,
  handleCalcCallback,
  readCustomerText,
  readIntakeFile,
  receiveGoodsSheet,
  receiveSheetText,
} from '@/modules/platform/telegram/staff-handlers';
import { fitSheetRows, sheetRowCount, sheetsPromptText } from '@/modules/wms/calc/intake-ai';

type Goods = NonNullable<CalcFacts['goods']>;
const line = (name: string, extra: Partial<Goods[number]> = {}): Goods[number] => ({ name, ...extra });

let seq = 0;
const chats: bigint[] = [];
function collection(patch: Partial<IntakeState> = {}): { chatId: bigint; state: IntakeState } {
  seq += 1;
  const chatId = BigInt(-9_400_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, 'rastamojka');
  return { chatId, state: updateIntake(chatId, patch)! };
}

function fakeCtx() {
  const replies: string[] = [];
  return {
    replies,
    async reply(text: string) {
      replies.push(text);
      return { message_id: replies.length };
    },
    api: {
      async editMessageText(): Promise<never> {
        throw new Error('message to edit not found');
      },
    },
  };
}

const reads = (goods: Goods, steps: string[] = []) => ({
  ok: true,
  facts: { fromCity: null, toCity: null, weightKg: null, volumeM3: null, goods },
  steps,
  usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
});

beforeEach(() => {
  model.analyze.mockReset();
  reader.answer = null;
});
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});

describe('another factory’s same-named line is kept (R3-C1)', () => {
  const add = (invoice: Goods, modelLines: Goods) =>
    pickGoods({ invoice, aiGoods: 'add', model: modelLines, typed: [], typedLabelled: [] });

  it('Excel «Ladies jacket» 300 + the model’s «Куртка женская (Ladies jacket)» 200: both lines', () => {
    const picked = add([line('Ladies jacket', { quantity: 300 })], [line('Куртка женская (Ladies jacket)', { quantity: 200 })]);
    expect(picked.goods).toEqual([
      line('Ladies jacket', { quantity: 300 }),
      line('Куртка женская (Ladies jacket)', { quantity: 200 }),
    ]);
    expect(picked.sameAsInvoice).toEqual([]);
  });

  it('the reviewers’ other pairs: a name that meets, figures that differ — kept', () => {
    const pairs: [Goods[number], Goods[number]][] = [
      [line('Kurtka', { quantity: 300 }), line('Куртка (Kurtka)', { quantity: 200 })],
      [line('Shim', { quantity: 300 }), line('Shim (jinsi)', { quantity: 200 })],
      [line('Kurtka (qora)', { quantity: 300 }), line('Kurtka', { quantity: 200 })],
      [line('Kurtka', { quantity: 300 }), line('Kurtka (qora)', { quantity: 200 })],
      [line('Куртка женская', { weightKg: 150 }), line('Куртка женская (女士外套)', { weightKg: 90 })],
      [line('Shim (Jeans)', { quantity: 300 }), line('Jeans', { quantity: 200 })],
    ];
    for (const [excel, read] of pairs) {
      expect(add([excel], [read]).goods, read.name).toEqual([excel, read]);
    }
  });

  it('among the model’s OWN lines only the same whole name is one line', () => {
    const picked = add([line('Zzz')], [line('Kurtka'), line('Kurtka (qora)'), line('KURTKA')]);
    expect(picked.goods.map((g) => g.name)).toEqual(['Zzz', 'Kurtka', 'Kurtka (qora)']);
  });

  it('the Excel line READ AGAIN is still left out — the same count, a weight within rounding, or no figure', () => {
    const excel = line('Ladies jacket', { quantity: 300, weightKg: 150 });
    for (const read of [
      line('Куртка женская (Ladies jacket)', { quantity: 300 }),
      line('Куртка женская (Ladies jacket)', { weightKg: 150.4 }),
      line('Куртка женская (Ladies jacket)', { quantity: 299, weightKg: 150 }),
      line('Куртка женская (Ladies jacket)'),
    ]) {
      expect(add([excel], [read]), JSON.stringify(read)).toEqual({ goods: [excel], sameAsInvoice: [read] });
    }
    // A weight a whole kilo and more away is another line.
    expect(add([excel], [line('Ladies jacket (女士夹克)', { weightKg: 151.2 })]).goods).toHaveLength(2);
  });

  it('the same WHOLE name is the Excel’s own whatever its figures — base’s rule — and is named', () => {
    const picked = add([line('Kurtka', { quantity: 300 })], [line('KURTKA', { quantity: 200 }), line('Choynak')]);
    expect(picked.goods.map((g) => g.name)).toEqual(['Kurtka', 'Choynak']);
    expect(picked.sameAsInvoice.map((g) => g.name)).toEqual(['KURTKA']);
  });

  it('the left-out lines are SAID: first among the notes, so the summary prints them', async () => {
    model.analyze.mockResolvedValueOnce(
      reads([line('Куртка женская (Ladies jacket)', { quantity: 300 }), line('Choynak', { quantity: 40 })], ['a', 'b', 'c']),
    );
    const out = await analyzeCollected(
      collection({
        stage: 'material',
        invoiceGoods: [line('Ladies jacket', { quantity: 300 })],
        aiGoods: 'add',
        pdfs: [{ data: Buffer.from('%PDF'), name: 'B.pdf' }],
      }).state,
    );
    expect(out.facts.goods?.map((g) => g.name)).toEqual(['Ladies jacket', 'Choynak']);
    expect(out.steps[0]).toBe('⚠️ 1 ta qator Excel’dagi bilan bir xil deb qo‘shilmadi: «Куртка женская (Ladies jacket)».');
    expect(aiStepsText(out.steps)).toContain('qo‘shilmadi: «Куртка женская (Ladies jacket)»');
    expect(out.steps.slice(1)).toEqual(['a', 'b', 'c']);
  });

  it('the note names three and counts the rest, whole within the summary’s cut; nothing left out says nothing', () => {
    const many = Array.from({ length: 7 }, (_, i) => line(`Tovar ${i + 1}`));
    expect(sameAsInvoiceNote(many)).toBe(
      '⚠️ 7 ta qator Excel’dagi bilan bir xil deb qo‘shilmadi: «Tovar 1», «Tovar 2», «Tovar 3» va yana 4 ta.',
    );
    const long = Array.from({ length: 120 }, (_, i) => line(`Куртка женская зимняя с капюшоном (女士冬季连帽夹克) №${i}`));
    const note = sameAsInvoiceNote(long)!;
    expect(aiStepsText([note])).toBe(`\n\n🤖 AI:\n· ${note}`);
    expect(sameAsInvoiceNote([])).toBeNull();
  });
});

describe('rows missing vs cells shortened (R3-C2, the sheets package’s two flags)', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1} | Kurtka model ${i}`).join('\n');
  const csv = (n: number) => `[CSV]\n${rows(n)}`;

  it('a sheet’s «[name]» heading is not a row', () => {
    expect(sheetRowCount(csv(20))).toBe(20);
    expect(sheetRowCount(`[Invoice]\n${rows(2)}\n\n[Packing list]\n${rows(3)}`)).toBe(5);
    // A data row that only looks like a heading, mid-sheet, is a row.
    expect(sheetRowCount(`[S]\n1 | a\n[x]`)).toBe(2);
    expect(fitSheetRows([csv(20)], 10_000)).toEqual({ kept: [20], total: [20] });
  });

  it('the model: cells shortened is said as exactly that — no «не считай итоги»', () => {
    const text = sheetsPromptText([{ text: csv(20), cut: false, cellsCut: true }], [], 10_000);
    expect(text).toContain(`${csv(20)}\n[Длинные ячейки сокращены, все строки показаны.]`);
    expect(text).not.toContain('обрезана');
    expect(text).not.toContain('не считай итоги');
    // Rows missing still says rows — counted without the heading.
    const cut = sheetsPromptText([{ text: csv(20), cut: true, cellsCut: true }], [], 10_000);
    expect(cut).toContain('[Таблица обрезана: показаны первые 20 строк, файл длиннее.');
    expect(cut).not.toContain('Длинные ячейки');
    // The fit's own cut counts rows too: «из 60», never «из 61».
    expect(sheetsPromptText([{ text: csv(60), cut: false, cellsCut: false }], [], 400)).toMatch(
      /показаны первые \d+ из 60 строк/,
    );
  });

  it('the seller: nothing about cells; rows missing counted without the heading', () => {
    const fit = (texts: readonly string[]) => fitSheetRows(texts, 10_000);
    const cells = receiveSheetText(collection().state, '«PL.csv»', { text: csv(20), cut: false, cellsCut: true }, fit);
    expect(cells.say).toBe('📄 «PL.csv» — jadval sarlavhasini topa olmadim, AI o‘qiydi.');
    expect(cells.patch.sheetTexts).toEqual([{ text: csv(20), cut: false, cellsCut: true }]);
    const missing = receiveSheetText(collection().state, '«PL.csv»', { text: csv(20), cut: true, cellsCut: false }, fit);
    expect(missing.say).toContain('AI faqat boshini o‘qiydi (birinchi 20 qator)');
    const small = (texts: readonly string[]) => fitSheetRows(texts, 400);
    const over = receiveSheetText(collection().state, '«PL.csv»', { text: csv(60), cut: false, cellsCut: false }, small);
    expect(over.say).toMatch(/AI faqat birinchi \d+ \/ 60 qatorini o‘qiydi/);
  });

  it('a mapped workbook: its other sheets’ shortened cells ride with them and say nothing', () => {
    const answer = receiveGoodsSheet(collection().state, {
      goods: [line('Kurtka')],
      label: '«A.xlsx»',
      text: '[Packing list]\n1 | 2',
      textCut: false,
      cellsCut: true,
      where: '',
    });
    expect(answer.say).toBe('📄 «A.xlsx» — 1 ta tovar o‘qildi.');
    expect(answer.patch.invoiceTexts).toEqual([{ text: '[Packing list]\n1 | 2', cut: false, cellsCut: true }]);
  });

  it('the wire: the reader’s two words reach the collection through readIntakeFile', async () => {
    reader.answer = { kind: 'text', text: csv(20), sheets: 1, textCut: false, cellsCut: true };
    const text = await readIntakeFile({ isPhoto: false, body: Buffer.from('x') }, 'PL.csv', 'text/csv', collection().state);
    expect(text.say).not.toContain('⚠️');
    expect(text.patch.sheetTexts).toEqual([{ text: csv(20), cut: false, cellsCut: true }]);

    reader.answer = {
      kind: 'goods',
      goods: [{ description: 'Kurtka', quantity: 300, unit: null, weightKg: null, volumeM3: null, amount: null, tnvedCode: null, note: null }],
      sheet: 'Invoice',
      sheets: 2,
      text: '[Packing list]\nTOTAL | 150',
      textCut: false,
      cellsCut: true,
    };
    const goods = await readIntakeFile({ isPhoto: false, body: Buffer.from('x') }, 'A.xlsx', null, collection().state);
    expect(goods.say).not.toContain('⚠️');
    expect(goods.patch.invoiceTexts).toEqual([{ text: '[Packing list]\nTOTAL | 150', cut: false, cellsCut: true }]);
  });
});

describe('the summary prints the whole hint; the lead is named without its phone or code (R3-C3/C4)', () => {
  it('summary: every line, joined by « · »; a bare label takes its value', () => {
    expect(intakeClientSummary('Ali aka\nGS777')).toBe('Ali aka · GS777');
    expect(intakeClientSummary(' Ali aka \n +998 90 123 45 67 ')).toBe('Ali aka · +998 90 123 45 67');
    expect(intakeClientSummary('Mijoz:\nGS777\nTel: 90 123 45 67')).toBe('Mijoz: GS777 · Tel: 90 123 45 67');
    expect(intakeClientSummary('GS777')).toBe('GS777');
    expect(intakeClientSummary(' \n ')).toBeNull();
  });

  it('the summary the seller reads before «Tasdiqlash» carries the code', async () => {
    const { chatId } = collection({
      stage: 'question',
      askingIndex: 0,
      round: 1,
      clientHintRaw: 'Ali aka\nGS771',
      facts: { goods: [line('Kurtka', { weightKg: 150 })] },
    });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(ctx.replies.at(-1)).toContain('Mijoz: Ali aka · GS771\n');
  });

  it('the label drops only the lines that ARE the hint’s phone or code', () => {
    expect(intakeClientLabel('Ali aka 2\n+998 90 123 45 67', { phone: '+998 90 123 45 67' })).toBe('Ali aka 2');
    expect(intakeClientLabel('OOO "Asia Trade" 3-filial\nTel: 90 123 45 67', { phone: '90 123 45 67' })).toBe(
      'OOO "Asia Trade" 3-filial',
    );
    expect(intakeClientLabel('Ali aka\nGS777', { code: 'GS777' })).toBe('Ali aka');
    expect(intakeClientLabel('Ali aka\nMijoz kodi: gs-777', { code: 'GS777' })).toBe('Ali aka');
    expect(intakeClientLabel('Ali aka\nKod 777', { code: 'GS777' })).toBe('Ali aka');
    expect(intakeClientLabel('Ali aka\nGS777 +998 90 123 45 67', { code: 'GS777', phone: '+998 90 123 45 67' })).toBe(
      'Ali aka',
    );
    expect(intakeClientLabel('Телефон: (90) 123-45-67\nИван', { phone: '(90) 123-45-67' })).toBe('Иван');
    // A word that only starts like a label is a name.
    expect(intakeClientLabel('Telman aka\n90 123 45 67', { phone: '90 123 45 67' })).toBe('Telman aka');
  });

  it('a phone the hint did not take stays in the name — the one place it is written down', () => {
    expect(intakeClientLabel('Ali aka\n+998 90 123 45 67', null)).toBe('Ali aka +998 90 123 45 67');
    expect(intakeClientLabel('Ali aka\n+998 90 555 44 33', { phone: '+998 90 123 45 67' })).toBe(
      'Ali aka +998 90 555 44 33',
    );
    // Nothing but the contact: the whole text, on one line.
    expect(intakeClientLabel('GS777\n+998 90 123 45 67', { code: 'GS777', phone: '+998 90 123 45 67' })).toBe(
      'GS777 +998 90 123 45 67',
    );
  });
});

describe('a line passed with ⏭ stays passed across a re-read (R3-C5)', () => {
  it('the resolver: same index while the name holds, else the first unclaimed line of that name, else dropped', () => {
    const goods = [line('Shim'), line('Kurtka'), line('Kurtka')];
    expect(resolveLineDone(goods, [{ index: 0, name: 'Kurtka' }])).toEqual([{ index: 1, name: 'Kurtka' }]);
    expect(resolveLineDone(goods, [{ index: 2, name: 'kurtka ' }])).toEqual([{ index: 2, name: 'Kurtka' }]);
    expect(
      resolveLineDone(goods, [
        { index: 0, name: 'Kurtka' },
        { index: 1, name: 'Kurtka' },
      ]),
    ).toEqual([
      { index: 1, name: 'Kurtka' },
      { index: 2, name: 'Kurtka' },
    ]);
    expect(resolveLineDone(goods, [{ index: 0, name: 'Sharf' }])).toEqual([]);
    expect(resolveLineDone(undefined, [{ index: 0, name: 'Kurtka' }])).toEqual([]);
  });

  it('skip Kurtka, «Bo‘ldi» re-reads into [Shim, Kurtka]: Shim is asked, Kurtka never', async () => {
    const { chatId } = collection({
      stage: 'question',
      askingIndex: 0,
      round: 1,
      clientHintRaw: 'GS777',
      facts: { goods: [line('Kurtka')] },
    });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(activeIntake(chatId)).toMatchObject({ stage: 'review', lineDone: [{ index: 0, name: 'Kurtka' }] });

    // «➕ Yana ma’lumot»: more material, then «Bo‘ldi» — the model now lists Shim first.
    updateIntake(chatId, { stage: 'material', round: 0, material: ['Shim ham bor'] });
    model.analyze.mockResolvedValueOnce(reads([line('Shim'), line('Kurtka')]));
    await handleCalcCallback(ctx, chatId, 'done');
    await vi.waitFor(() => expect(activeIntake(chatId)?.stage).toBe('question'));
    const asked = ctx.replies.filter((r) => r.startsWith('❓')).map((r) => r.split(' — ')[0]);
    expect(asked).toEqual(['❓ 1-qator «Shim»']);
    expect(activeIntake(chatId)).toMatchObject({ askingIndex: 0, lineDone: [{ index: 1, name: 'Kurtka' }] });
  });
});

describe('the repeat refusal says the reason that is true (R3-C6)', () => {
  it('a two-line contact with no goods: «several lines», never «a goods list»', async () => {
    const text = 'Rustam\nAndijon';
    const read = await readCustomerText(text, 'GS');
    expect(read).toEqual({ material: true, couldBeCustomer: false, why: 'shape' });
    const state = collection().state;
    const first = clientAnswer(state, text, read);
    const second = clientAnswer({ ...state, ...first.patch }, text, read);
    expect(first.kind === 'material' && first.say).toContain('bu matndan mijozni o‘qib bo‘lmadi');
    expect(second.kind === 'material' && second.say).toContain('Bir necha qatorli (yoki uzun) matn mijoz bo‘la olmaydi');
    expect(first.kind === 'material' && first.say).not.toContain('tovar ro‘yxati');
    expect(second.kind === 'material' && second.say).not.toContain('Tovar ro‘yxati');
  });

  it('a goods list keeps its own sentence', async () => {
    const list = 'Kurtka 300 dona 150 kg\nShim 200 dona 80 kg';
    const read = await readCustomerText(list, 'GS');
    expect(read.why).toBe('goods');
    const state = collection().state;
    const first = clientAnswer(state, list, read);
    const second = clientAnswer({ ...state, ...first.patch }, list, read);
    expect(first.kind === 'material' && first.say).toContain('tovar ro‘yxatiga o‘xshaydi');
    expect(second.kind === 'material' && second.say).toContain('Tovar ro‘yxati mijoz bo‘la olmaydi');
  });
});
