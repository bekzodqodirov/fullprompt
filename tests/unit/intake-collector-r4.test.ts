import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalcFacts } from '@/modules/wms/calc/intake';

/**
 * The «Hisoblatish» collector after the round-4 review (the regression
 * corpus's collector cases, tests/unit/intake-corpus.test.ts): what those
 * rules reach PAST the corpus — the contact words beside a cut, a line the
 * hint did not take, the halves of a bilingual cell never split out of a
 * bracket, the typed lines an Excel kept out, what the summary says when the
 * model did not read beside an Excel, and the seller's word on a file the
 * reader capped or a later file squeezed. The model is a script here.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', () => ({ aiCalcBudgetLeft: async () => 100 }));

import {
  activeIntake,
  analyzeCollected,
  carryLineDone,
  endIntake,
  intakeClientLabel,
  pickGoods,
  resolveLineDone,
  sameAsInvoiceNote,
  startIntake,
  typedLeftOutNote,
  updateIntake,
  type IntakeState,
} from '@/modules/platform/telegram/calc-intake';
import {
  handleCalcCallback,
  readCustomerText,
  receiveGoodsSheet,
  receiveSheetText,
} from '@/modules/platform/telegram/staff-handlers';
import { parseClientHint } from '@/modules/wms/calc/intake';
import { fitSheetRows } from '@/modules/wms/calc/intake-ai';

type Goods = NonNullable<CalcFacts['goods']>;
const line = (name: string, extra: Partial<Goods[number]> = {}): Goods[number] => ({ name, ...extra });

let seq = 0;
const chats: bigint[] = [];
function collection(patch: Partial<IntakeState> = {}): { chatId: bigint; state: IntakeState } {
  seq += 1;
  const chatId = BigInt(-9_300_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, 'rastamojka', { staffId: 'staff-test' });
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

beforeEach(() => model.analyze.mockReset());
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});

/** The lead's name as the landing makes it: the hint the parser really returns. */
const leadName = (raw: string) => intakeClientLabel(raw, parseClientHint(raw, { prefix: 'GS' }));

describe('the lead’s name: the hint cut out of one line, contact lines dropped (round 4)', () => {
  it('a contact word beside the cut goes with it — and a second phone on that line', () => {
    expect(leadName('Ali aka tel: 90 123 45 67')).toBe('Ali aka');
    expect(leadName('Ali aka, Tel: 90 123 45 67, 91 234 56 78')).toBe('Ali aka');
  });

  it('what is not beside a cut stays: a joining word inside the name, a bracket that still holds a word', () => {
    expect(intakeClientLabel('Ali va Vali GS777', { code: 'GS777' })).toBe('Ali va Vali');
    expect(intakeClientLabel('Rustam (aka GS777)', { code: 'GS777' })).toBe('Rustam (aka)');
  });

  it('a line of its own the hint did NOT take stays in the name — the one place it is written down', () => {
    expect(leadName('Murod\n+998 90 123 45 67\n@murod_uz')).toBe('Murod @murod_uz');
    // On the hint's own line the handle is contact, and goes with the phone.
    expect(leadName('Murod @murod_uz +998 90 123 45 67')).toBe('Murod');
  });

  it('nothing name-like left: one line or several, the lead is named by the code or by nobody', () => {
    expect(leadName('Kod GS777 tel 90 123 45 67')).toBe('GS777');
    expect(intakeClientLabel('+998 90 123 45 67', { phone: '+998 90 123 45 67' })).toBeNull();
    expect(intakeClientLabel('GS777\n+998 90 123 45 67', { code: 'GS777', phone: '+998 90 123 45 67' })).toBe('GS777');
  });
});

describe('a ⏭ survives a reading without the goods (round 4, C-r2)', () => {
  it('stored: placed where the reading has the line, kept as it was where it has not', () => {
    expect(carryLineDone([], [{ index: 0, name: 'Kurtka' }])).toEqual([{ index: 0, name: 'Kurtka' }]);
    expect(
      carryLineDone([line('Shim'), line('Kurtka')], [
        { index: 0, name: 'Kurtka' },
        { index: 3, name: 'Sharf' },
      ]),
    ).toEqual([
      { index: 1, name: 'Kurtka' },
      { index: 3, name: 'Sharf' },
    ]);
  });

  it('the question is still chosen by the placed ones only', () => {
    expect(resolveLineDone([line('Shim'), line('Kurtka')], [{ index: 3, name: 'Sharf' }])).toEqual([]);
  });
});

describe('which lines land beside an Excel (round 4)', () => {
  const add = (invoice: Goods, extra: Goods | null, typed: Goods = []) =>
    pickGoods({ invoice, aiGoods: 'add', model: extra, typed, typedLabelled: [] });

  it('a bracket is never split by script: «Kurtka (黑色)» is not «Kurtka (qora)»', () => {
    // No figure on the reading: met, it would be the Excel's line whatever it holds.
    const picked = add([line('Kurtka (qora)', { quantity: 300 })], [line('Kurtka (黑色)')]);
    expect(picked.goods.map((g) => g.name)).toEqual(['Kurtka (qora)', 'Kurtka (黑色)']);
  });

  it('a bilingual Excel cell is met by its plain original too', () => {
    const picked = add([line('女士夹克 Ladies jacket', { quantity: 300 })], [line('Ladies jacket', { quantity: 300 })]);
    expect(picked.goods.map((g) => g.name)).toEqual(['女士夹克 Ladies jacket']);
    expect(picked.sameAsInvoice).toEqual([{ name: 'Ladies jacket', quantity: 300, why: 'same' }]);
  });

  it('«add» with no reading: the typed lines take the model’s place, the Excel’s own named', () => {
    const picked = add([line('Kurtka', { quantity: 300 })], null, [line('Kurtka', { quantity: 300 }), line('Shim', { quantity: 200 })]);
    expect(picked.goods.map((g) => g.name)).toEqual(['Kurtka', 'Shim']);
    expect(picked.sameAsInvoice).toEqual([{ name: 'Kurtka', quantity: 300, why: 'same' }]);
  });

  it('one reading is named once, two readings of one name with different figures both', () => {
    const picked = add(
      [line('Kurtka', { quantity: 300 })],
      [line('Kurtka', { quantity: 300 }), line('KURTKA', { quantity: 300 }), line('Kurtka', { quantity: 200 })],
    );
    expect(picked.sameAsInvoice.map((g) => g.quantity)).toEqual([300, 200]);
  });

  it('nobody asked: a typed line the model read too is named; a reading of one alone is not', () => {
    const picked = pickGoods({
      invoice: [line('Kurtka', { quantity: 300 })],
      aiGoods: null,
      model: [line('Shim', { quantity: 200 }), line('Sharf')],
      typed: [line('Shim', { quantity: 200 }), line('Choynak', { quantity: 5 }), line('Kurtka', { quantity: 300 })],
      typedLabelled: [],
    });
    expect(picked.goods.map((g) => g.name)).toEqual(['Kurtka']);
    expect(picked.sameAsInvoice).toEqual([{ name: 'Shim', quantity: 200, why: 'typed' }]);
    // The seller answered about the other files: the Excel answers and nothing is named.
    for (const aiGoods of ['context', 'ask'] as const) {
      expect(
        pickGoods({ invoice: [line('Kurtka')], aiGoods, model: [line('Shim')], typed: [line('Shim')], typedLabelled: [] })
          .sameAsInvoice,
      ).toEqual([]);
    }
  });

  it('each kind of left-out line has its own sentence — «bir xil» is never said of a typed one', () => {
    const lines = [
      { ...line('Куртка женская (Ladies jacket)'), why: 'same' as const },
      { ...line('Shim'), why: 'typed' as const },
    ];
    expect(sameAsInvoiceNote(lines)).toBe('⚠️ 1 ta qator Excel’dagi bilan bir xil deb qo‘shilmadi: «Куртка женская (Ladies jacket)».');
    expect(typedLeftOutNote(lines)).toBe(
      '⚠️ 1 ta yozilgan qator Excel’da yo‘q, ro‘yxatga qo‘shilmadi (tovarlar Excel’dan olindi): «Shim».',
    );
    expect(typedLeftOutNote([lines[0]!])).toBeNull();
  });
});

describe('the summary beside an Excel (round 4)', () => {
  it('both notes are the bot’s own, the model’s steps untouched', async () => {
    model.analyze.mockResolvedValueOnce({
      ok: true,
      facts: { goods: [line('Shim', { quantity: 200 })] },
      steps: ['a', 'b', 'c'],
      usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
    });
    const out = await analyzeCollected(
      collection({ stage: 'material', material: ['Shim 200 dona'], invoiceGoods: [line('Kurtka', { quantity: 300 })] }).state,
    );
    expect(out.notes).toEqual(['⚠️ 1 ta yozilgan qator Excel’da yo‘q, ro‘yxatga qo‘shilmadi (tovarlar Excel’dan olindi): «Shim».']);
    expect(out.steps).toEqual(['a', 'b', 'c']);
  });

  it('the model did not read: the Excel is said to be what was read, and the left-out line on its own line', async () => {
    const { chatId } = collection({
      stage: 'material',
      material: ['Kurtka 300 dona'],
      aiGoods: 'add',
      invoiceGoods: [line('Kurtka', { quantity: 300, weightKg: 150 })],
      pdfs: [{ attachmentId: 'a-pdf-b', name: 'B.pdf', bytes: 10 }],
    });
    model.analyze.mockResolvedValueOnce({ ok: false, failure: 'not_configured' });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    await vi.waitFor(() => expect(activeIntake(chatId)?.stage).toBe('review'));
    const summary = ctx.replies.at(-1)!;
    expect(summary).toContain('Faqat Excel va yozilganidan o‘qildi.');
    expect(summary).toContain('\n\n⚠️ 1 ta qator Excel’dagi bilan bir xil deb qo‘shilmadi: «Kurtka».');
  });
});

describe('what the seller is told about a file (round 4)', () => {
  const mapped = (extra: Partial<Parameters<typeof receiveGoodsSheet>[1]>) => ({
    goods: [line('Kurtka')],
    label: '«A.xlsx»',
    text: '',
    textCut: false,
    cellsCut: false,
    where: '',
    ...extra,
  });

  it('a list that reached the reader’s ceiling says so — and never «the goods list was read in full»', () => {
    const capped = receiveGoodsSheet(collection().state, mapped({ capped: 500, text: '[Packing list]\n1 | 2', textCut: true }));
    expect(capped.say).toContain('⚠️ Bitta fayldan ko‘pi bilan 500 ta tovar qatori o‘qiladi');
    expect(capped.say).not.toContain('to‘liq olindi');
    expect(receiveGoodsSheet(collection().state, mapped({})).say).toBe('📄 «A.xlsx» — 1 ta tovar o‘qildi.');
  });

  it('a later file that pushes a workbook’s other sheets out of the model’s budget names it, or the workbook it can', () => {
    const rows = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${i + 1} | ${tag} ${i}`).join('\n');
    const fit = (texts: readonly string[]) => fitSheetRows(texts, 600);
    const state = (label?: string) =>
      collection({ invoiceTexts: [{ text: rows(20, 'Packing'), cut: false, cellsCut: false, ...(label ? { label } : {}) }] })
        .state;
    const all = receiveSheetText(state('«A.xlsx»'), '«B.csv»', { text: rows(80, 'Shim erkaklar'), cut: false, cellsCut: false }, fit);
    expect(all.say).toContain('⚠️ Shu jadval tufayli «A.xlsx» ning boshqa varaqlari AI ga sig‘madi');
    const some = receiveSheetText(state(), '«B.csv»', { text: rows(20, 'Shim erkaklar'), cut: false, cellsCut: false }, fit);
    expect(some.say).toMatch(/⚠️ Shu jadval tufayli AI oldingi Excel faylning boshqa varaqlaridan endi faqat \d+ \/ 20 qatorini o‘qiydi\./);
    // A file that leaves them room says nothing about them.
    const none = receiveSheetText(state('«A.xlsx»'), '«B.csv»', { text: rows(2, 'Shim'), cut: false, cellsCut: false }, fit);
    expect(none.say).not.toContain('Shu jadval tufayli');
  });
});

describe('the customer question: a row of bare figures (round 4, integration defect 1)', () => {
  it('is goods, never a customer on the repeat — and a phone in the same shape still is one', async () => {
    expect(await readCustomerText('Kurtka 1200 50 3000', 'GS')).toEqual({ material: true, couldBeCustomer: false, why: 'goods' });
    expect((await readCustomerText('Ali 90 123 45 67', 'GS')).couldBeCustomer).toBe(true);
  });
});
