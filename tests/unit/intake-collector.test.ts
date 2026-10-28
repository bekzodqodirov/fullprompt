import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalcFacts } from '@/modules/wms/calc/intake';
import { fitSheetRows } from '@/modules/wms/calc/intake-ai';

/**
 * The «Hisoblatish» collector's own state machine, after the round-1 review
 * (docs/SAKKIZ-BAND.md): the presses and the files, driven through the real
 * handler with a fake `ctx` — no Telegram, no database. The analysis itself is
 * replaced (`analyzeCollected`), because what is under test is what the
 * collector does AROUND it: the lock, the stage, what each file is worth.
 */
const analyse = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/modules/platform/telegram/calc-intake', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/telegram/calc-intake')>()),
  analyzeCollected: analyse.fn,
}));

import {
  activeIntake,
  endIntake,
  startIntake,
  updateIntake,
  type IntakeState,
} from '@/modules/platform/telegram/calc-intake';
import { parseCallback } from '@/modules/platform/telegram/staff-bot';
import {
  clientAnswer,
  handleCalcCallback,
  invoiceChoice,
  otherFilesChoice,
  readCustomerText,
  readIntakeFile,
  receiveGoodsSheet,
  receivePdf,
  receiveSheetText,
  settleAnalysis,
} from '@/modules/platform/telegram/staff-handlers';

type Goods = NonNullable<CalcFacts['goods']>;
const line = (name: string, extra: Partial<Goods[number]> = {}): Goods[number] => ({ name, ...extra });

let seq = 0;
const chats: bigint[] = [];
function freshChat(): bigint {
  seq += 1;
  const id = BigInt(-9_100_000_000) - BigInt(seq);
  chats.push(id);
  return id;
}

/** A collection in a given shape, as the live handlers would hold it. */
function collection(patch: Partial<IntakeState> = {}, section: IntakeState['section'] = 'rastamojka'): {
  chatId: bigint;
  state: IntakeState;
} {
  const chatId = freshChat();
  startIntake(chatId, section);
  const state = updateIntake(chatId, patch)!;
  return { chatId, state };
}

function fakeCtx(opts: { refuse?: RegExp } = {}) {
  const replies: { text: string; extra?: Record<string, unknown> }[] = [];
  return {
    replies,
    texts: () => replies.map((r) => r.text),
    async reply(text: string, extra?: Record<string, unknown>) {
      // A 429 past `briefRetry`'s five seconds is RETURNED to the caller, and
      // grammy throws it — the shape the round-1 review measured.
      if (opts.refuse?.test(text)) throw new Error('429: Too Many Requests: retry after 30');
      replies.push({ text, extra });
      return { message_id: replies.length };
    },
    api: {
      async editMessageText(): Promise<never> {
        throw new Error('message to edit not found');
      },
    },
  };
}

const callbacksOf = (kb: { inline_keyboard: { callback_data: string }[][] } | undefined) =>
  (kb?.inline_keyboard ?? []).flat().map((b) => b.callback_data);

beforeEach(() => analyse.fn.mockReset());
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});

describe('«➕ / 🔁» keeps the question the collection is waiting on (review c0)', () => {
  const pending = { goods: [line('Shim')], label: '«B.xlsx»', texts: [] };

  it('a collection still waiting for the customer stays waiting — and is asked again', async () => {
    const { chatId } = collection({ invoiceGoods: [line('Kurtka')], pendingInvoice: pending });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'inv_add');
    const live = activeIntake(chatId)!;
    expect(live.stage).toBe('client');
    expect(live.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim']);
    expect(live.pendingInvoice).toBeNull();
    // The customer question, not «Yana yuboring yoki Bo'ldi».
    expect(ctx.texts().at(-1)).toContain('Mijozni yozing');
    // …so the code typed next is the customer, never material.
    expect(clientAnswer(live, 'GS777', { material: false, couldBeCustomer: true, why: null })).toMatchObject({ kind: 'customer', patch: { clientHintRaw: 'GS777' } });
  });

  it('the podklyuch door’s «qayerdan?» is kept too; only a collecting stage moves to material', () => {
    const base = { invoiceGoods: [line('Kurtka')], pendingInvoice: pending };
    const section = invoiceChoice({ ...collection(base, 'podklyuch').state, stage: 'section' }, 'inv_replace');
    expect(section).toMatchObject({ reask: 'section', patch: { stage: 'section' } });
    const material = invoiceChoice({ ...collection(base).state, stage: 'material' }, 'inv_add');
    expect(material).toMatchObject({ reask: null, patch: { stage: 'material' } });
    expect(invoiceChoice({ ...collection().state, pendingInvoice: null }, 'inv_add')).toBeNull();
  });
});

describe('a third goods file folds into the open question (review c1)', () => {
  it('A, then B, then C: one press lands all three — B is never overwritten', () => {
    let state = collection().state;
    const take = (file: Parameters<typeof receiveGoodsSheet>[1]) => {
      const answer = receiveGoodsSheet(state, file);
      state = { ...state, ...answer.patch };
      return answer;
    };
    take({ goods: [line('Kurtka'), line('Shim')], label: '«A.xlsx»', text: '', textCut: false, cellsCut: false, where: '' });
    take({ goods: [line('Choynak'), line('Piyola'), line('Lagan')], label: '«B.xlsx»', text: '', textCut: false, cellsCut: false, where: '' });
    const third = take({ goods: [line('Poyabzal')], label: '«C.xlsx»', text: '', textCut: false, cellsCut: false, where: '' });
    // The waiting files are named, both of them.
    expect(third.say).toContain('«B.xlsx», «C.xlsx»');
    expect(callbacksOf(third.keyboard)).toEqual(['c:inv_add', 'c:inv_replace']);
    const added = invoiceChoice(state, 'inv_add')!;
    expect(added.patch.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim', 'Choynak', 'Piyola', 'Lagan', 'Poyabzal']);
    const replaced = invoiceChoice(state, 'inv_replace')!;
    expect(replaced.patch.invoiceGoods?.map((g) => g.name)).toEqual(['Choynak', 'Piyola', 'Lagan', 'Poyabzal']);
  });
});

describe('an answer given while the analysis ran is kept (review c2)', () => {
  it('the live per-line answer goes back onto the new reading', () => {
    const snapshot = { ...collection({ stage: 'question', analysing: 'T1', material: ['Kurtka'] }).state };
    const live: IntakeState = {
      ...snapshot,
      answers: ['1-qator: 150 kg'],
      lineAnswers: [{ index: 0, name: 'Kurtka', patch: { weightKg: 150 } }],
    };
    const analysed: IntakeState = { ...snapshot, facts: { goods: [line('Kurtka'), line('Shim')] }, stage: 'review' };
    const out = settleAnalysis(live, snapshot, analysed, 'T1');
    expect(out.kind).toBe('done');
    if (out.kind === 'done') {
      expect(out.state.facts.goods?.[0]).toMatchObject({ name: 'Kurtka', weightKg: 150 });
      expect(out.state.facts.goods?.[1]).toEqual({ name: 'Shim' });
    }
  });
});

describe('a refused «⏳» notice cannot strand the lock (review c3)', () => {
  it('the analysis is dispatched anyway, and its own exit releases the token', async () => {
    analyse.fn.mockRejectedValueOnce(new Error('model down'));
    const { chatId } = collection({ stage: 'material', material: ['Kurtka 300 dona'] });
    const ctx = fakeCtx({ refuse: /^⏳/ });
    await expect(handleCalcCallback(ctx, chatId, 'done')).resolves.toBeUndefined();
    await vi.waitFor(() => expect(activeIntake(chatId)?.analysing).toBeNull());
    expect(analyse.fn).toHaveBeenCalledTimes(1);
    // …and the next «Bo'ldi» is a «Bo'ldi», not «Tahlil davom etmoqda».
    expect(ctx.texts().some((t) => t.includes('Tahlil davom etmoqda'))).toBe(false);
  });
});

describe('a PDF or a header-less sheet beside an Excel list is ASKED about (review c4)', () => {
  const pdf = { data: Buffer.from('%PDF-1.4 x'), name: 'B.pdf' };

  it('a PDF after the Excel: the question, two buttons the parser takes, and «Bo‘ldi» waits', async () => {
    const { chatId, state } = collection({ stage: 'material', invoiceGoods: [line('Kurtka')], fileCount: 2 });
    const answer = receivePdf(state, pdf, '«B.pdf»');
    expect(answer.patch).toMatchObject({ aiGoods: 'ask' });
    expect(answer.say).toContain('boshqa zavodning tovarlarimi');
    const data = callbacksOf(answer.keyboard);
    expect(data).toEqual(['c:other_add', 'c:other_same']);
    for (const d of data) expect(parseCallback(d), d).not.toBeNull();

    updateIntake(chatId, answer.patch);
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    expect(activeIntake(chatId)?.analysing).toBeNull();
    expect(analyse.fn).not.toHaveBeenCalled();
    expect(callbacksOf(ctx.replies.at(-1)?.extra?.reply_markup as never)).toEqual(['c:other_add', 'c:other_same']);

    await handleCalcCallback(ctx, chatId, 'other_add');
    expect(activeIntake(chatId)?.aiGoods).toBe('add');
  });

  it('a header-less sheet after the Excel, and an Excel after a PDF (the other order), ask too', () => {
    const fit = (texts: readonly string[]) => fitSheetRows(texts, 10_000);
    const sheetAfter = receiveSheetText(collection({ invoiceGoods: [line('Kurtka')] }).state, '«B.xlsx»', { text: 'a | b', cut: false, cellsCut: false }, fit);
    expect(sheetAfter.patch).toMatchObject({ aiGoods: 'ask' });
    const excelAfterPdf = receiveGoodsSheet(collection({ pdfs: [pdf] }).state, {
      goods: [line('Kurtka')],
      label: '«A.xlsx»',
      text: '',
      textCut: false,
      cellsCut: false,
      where: '',
    });
    expect(excelAfterPdf.patch).toMatchObject({ aiGoods: 'ask', invoiceGoods: [line('Kurtka')] });
    expect(callbacksOf(excelAfterPdf.keyboard)).toEqual(['c:other_add', 'c:other_same']);
    // No Excel list, nothing to ask: the model's lines ARE the goods.
    expect(receivePdf(collection().state, pdf, '«B.pdf»').patch).not.toHaveProperty('aiGoods');
  });

  it('the answer is the seller’s: add or context, and a stale press changes nothing', () => {
    const asked = collection({ aiGoods: 'ask', stage: 'material' }).state;
    expect(otherFilesChoice(asked, 'other_add')?.patch.aiGoods).toBe('add');
    expect(otherFilesChoice(asked, 'other_same')?.patch.aiGoods).toBe('context');
    expect(otherFilesChoice({ ...asked, aiGoods: 'add' }, 'other_same')).toBeNull();
  });
});

describe('a stale ⏭ moves nothing (review c5)', () => {
  it('outside an open question it is refused, and the collection is not «shown» a reading it never had', async () => {
    const { chatId } = collection({ stage: 'material', material: ['Kurtka 300 dona'], fileCount: 1 });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(ctx.texts()).toEqual(['Bu tugma eskirgan.']);
    expect(activeIntake(chatId)?.stage).toBe('material');
  });

  it('nor while an analysis runs', async () => {
    const { chatId } = collection({ stage: 'question', askingIndex: 0, analysing: 'T9' });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(ctx.texts()).toEqual(['Bu tugma eskirgan.']);
    expect(activeIntake(chatId)?.stage).toBe('question');
  });
});

describe('a replaced workbook takes its other sheets with it (review c7)', () => {
  it('first file: its packing list is the invoice’s context, not a separate file for the model', () => {
    const first = receiveGoodsSheet(collection().state, {
      goods: [line('Kurtka')],
      label: '«WRONG.xlsx»',
      text: '[Packing list]\nTOTAL G.W. | 9999 KGS',
      textCut: false,
      cellsCut: false,
      where: '',
    });
    expect(first.patch.invoiceTexts).toEqual([
      { text: '[Packing list]\nTOTAL G.W. | 9999 KGS', cut: false, cellsCut: false, label: '«WRONG.xlsx»' },
    ]);
    expect(first.patch).not.toHaveProperty('sheetTexts');
  });

  it('🔁 drops the replaced one’s totals; ➕ keeps both', () => {
    const state = collection({
      invoiceGoods: [line('Kurtka')],
      invoiceTexts: [{ text: 'WRONG 9999 KGS', cut: false, cellsCut: false }],
      pendingInvoice: { goods: [line('Kurtka')], label: '«RIGHT.xlsx»', texts: [{ text: 'RIGHT 1200 KGS', cut: true, cellsCut: false }] },
      stage: 'material',
    }).state;
    expect(invoiceChoice(state, 'inv_replace')?.patch.invoiceTexts).toEqual([{ text: 'RIGHT 1200 KGS', cut: true, cellsCut: false }]);
    expect(invoiceChoice(state, 'inv_add')?.patch.invoiceTexts).toEqual([
      { text: 'WRONG 9999 KGS', cut: false, cellsCut: false },
      { text: 'RIGHT 1200 KGS', cut: true, cellsCut: false },
    ]);
  });
});

describe('a header-less sheet that will not fit is SAID when it arrives (review a17)', () => {
  const rows = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${i + 1} | ${tag} model ${i}`).join('\n');
  const fit = (texts: readonly string[]) => fitSheetRows(texts, 400);

  it('a file cut part-way names how many of its lines the AI reads', () => {
    const answer = receiveSheetText(collection().state, '«PL.xlsx»', { text: rows(60, 'Kurtka'), cut: false, cellsCut: false }, fit);
    expect(answer.say).toMatch(/AI faqat birinchi \d+ \/ 60 qatorini o‘qiydi/);
  });

  it('a file that does not fit at all is said to be outside the AI’s reading', () => {
    const answer = receiveSheetText(collection({ sheetTexts: [{ text: rows(60, 'A'), cut: false, cellsCut: false }] }).state, '«B.xlsx»', {
      text: rows(10, 'B'),
      cut: false,
      cellsCut: false,
    }, fit);
    expect(answer.say).toContain('AI ga sig‘madi');
  });

  it('a file that fits says nothing more', () => {
    const answer = receiveSheetText(collection().state, '«S.xlsx»', { text: rows(3, 'Sumka'), cut: false, cellsCut: false }, fit);
    expect(answer.say).toBe('📄 «S.xlsx» — jadval sarlavhasini topa olmadim, AI o‘qiydi.');
  });
});

describe('the customer question has a way forward (review t23)', () => {
  // A short line the goods reader mistook for goods — the case t23 is for.
  const NAME_READ_AS_GOODS = { material: true, couldBeCustomer: true, why: null };
  const GOODS = { material: true, couldBeCustomer: false, why: 'goods' as const };
  it('the re-ask says why, and the SAME text again is the customer — out of the material', () => {
    const state = collection().state;
    const first = clientAnswer(state, 'Ali aka 2', NAME_READ_AS_GOODS);
    expect(first.kind).toBe('material');
    if (first.kind !== 'material') return;
    expect(first.say).toContain('tovar ro‘yxatiga o‘xshaydi');
    const after = { ...state, ...first.patch };
    expect(after.material).toEqual(['Ali aka 2']);

    const again = clientAnswer(after, ' Ali aka 2 ', NAME_READ_AS_GOODS);
    expect(again).toMatchObject({ kind: 'customer', patch: { clientHintRaw: 'Ali aka 2', stage: 'material' } });
    expect(again.patch.material).toEqual([]);
  });

  it('a different text is not «again»', () => {
    const state = { ...collection().state, clientAskedWith: 'Kurtka 300 dona' };
    expect(clientAnswer(state, 'Shim 50 dona', GOODS).kind).toBe('material');
  });
});

describe('a goods list sent twice stays goods (round-2 review, C3/C7)', () => {
  const list = 'Kurtka 300 dona 150 kg\nShim 200 dona 80 kg\nSharf 100 dona';

  it('the readers: a goods list cannot name a customer; a name and a two-line contact can', async () => {
    expect(await readCustomerText(list, 'GS')).toEqual({ material: true, couldBeCustomer: false, why: 'goods' });
    expect((await readCustomerText('Kurtka 300 dona 150 kg', 'GS')).couldBeCustomer).toBe(false);
    expect((await readCustomerText('Ali aka 2', 'GS')).couldBeCustomer).toBe(true);
    expect((await readCustomerText('Ali aka\n+998 90 123 45 67', 'GS')).couldBeCustomer).toBe(true);
  });

  it('sent twice — a double forward: ONE copy in the material, the question again, never the customer', async () => {
    const state = collection().state;
    const read = await readCustomerText(list, 'GS');
    const first = clientAnswer(state, list, read);
    expect(first.kind).toBe('material');
    const after = { ...state, ...first.patch };
    const second = clientAnswer(after, list, read);
    expect(second.kind).toBe('material');
    const end = { ...after, ...second.patch };
    expect(end.material).toEqual([list]);
    expect(end.clientHintRaw).toBe('');
    expect(end.stage).toBe('client');
    if (first.kind === 'material' && second.kind === 'material') {
      expect(second.say).toContain('Mijozni yozing');
      // Neither re-ask promises what it cannot keep.
      expect(first.say).not.toContain('mijoz deb olinadi');
      expect(second.say).not.toContain('mijoz deb olinadi');
    }
    // A third send is still one copy.
    const third = clientAnswer(end, list, read);
    expect({ ...end, ...third.patch }.material).toEqual([list]);
  });
});

describe('a line passed with ⏭ is never asked again (round-2 review, C10)', () => {
  it('⏭ on line 1, then ⏭ on line 2: line 3 is asked — the stored collection remembers both', async () => {
    const { chatId } = collection({
      stage: 'question',
      askingIndex: 0,
      round: 1,
      facts: { goods: [line('Kurtka'), line('Shim'), line('Sharf')] },
    });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(activeIntake(chatId)).toMatchObject({ stage: 'question', askingIndex: 1, lineDone: [{ index: 0, name: 'Kurtka' }] });
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(activeIntake(chatId)).toMatchObject({
      stage: 'question',
      askingIndex: 2,
      lineDone: [
        { index: 0, name: 'Kurtka' },
        { index: 1, name: 'Shim' },
      ],
    });
    expect(ctx.texts().map((t) => t.split(' — ')[0])).toEqual(['❓ 2-qator «Shim»', '❓ 3-qator «Sharf»']);
  });

  it('the summary keeps the list too, so «➕ Yana ma’lumot» cannot bring a passed line back', async () => {
    const { chatId } = collection({
      stage: 'question',
      askingIndex: 0,
      round: 1,
      facts: { goods: [line('Kurtka')] },
    });
    await handleCalcCallback(fakeCtx(), chatId, 'skip');
    expect(activeIntake(chatId)).toMatchObject({ stage: 'review', lineDone: [{ index: 0, name: 'Kurtka' }] });
  });
});

describe('the summary names the customer on ONE line (round-2 review, C9; round-3, R3-C3)', () => {
  it('«Ali aka» over the phone reads «Mijoz: Ali aka · +998 …» — one line, and the phone the landing reads', async () => {
    const { chatId } = collection({
      stage: 'question',
      askingIndex: 0,
      round: 1,
      clientHintRaw: 'Ali aka\n+998 90 123 45 67',
      facts: { goods: [line('Kurtka', { weightKg: 150 })] },
    });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    const summary = ctx.texts().at(-1)!;
    expect(summary).toContain('Mijoz: Ali aka · +998 90 123 45 67\n');
  });
});

describe('a file the READER stopped short is said, and carries its cut (round-2 review, C1/C4/C5)', () => {
  const rows = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${i + 1} | ${tag} model ${i}`).join('\n');
  const fit = (texts: readonly string[]) => fitSheetRows(texts, 10_000);

  it('a header-less sheet the reader cut: the warning, though what is left fits', () => {
    const sheet = { text: rows(20, 'Kurtka'), cut: true, cellsCut: false };
    const answer = receiveSheetText(collection().state, '«PL.csv»', sheet, fit);
    expect(answer.say).toContain('⚠️ Jadval katta: AI faqat boshini o‘qiydi');
    // The text keeps the file's label, so a later file squeezing it can name it (round-4 S-d).
    expect(answer.patch.sheetTexts).toEqual([{ ...sheet, label: '«PL.csv»' }]);
  });

  it('a mapped workbook whose other sheets the reader cut: said (the goods are whole), the cut kept with the workbook', () => {
    const answer = receiveGoodsSheet(collection().state, {
      goods: [line('Kurtka')],
      label: '«A.xlsx»',
      text: '[Packing list]\n1 | 2',
      textCut: true,
      cellsCut: false,
      where: '',
    });
    expect(answer.say).toContain('⚠️ Jadval katta: AI boshqa varaqlarning faqat boshini o‘qiydi');
    expect(answer.patch.invoiceTexts).toEqual([{ text: '[Packing list]\n1 | 2', cut: true, cellsCut: false, label: '«A.xlsx»' }]);
  });

  it('the real reader on a 300-row header-less CSV: its cut reaches the collection and the seller', async () => {
    const csv = Array.from(
      { length: 300 },
      (_, i) => `${i + 1};Куртка женская модель YW-${i} (女士夹克);${300 + i};PCS;${i}.5;${i}.9;0.${i}`,
    ).join('\n');
    const state = collection().state;
    const answer = await readIntakeFile({ isPhoto: false, body: Buffer.from(csv) }, 'PL.csv', 'text/csv', state);
    expect(answer.say).toContain('⚠️ Jadval katta');
    expect(answer.patch.sheetTexts?.[0]?.cut).toBe(true);
  });
});
