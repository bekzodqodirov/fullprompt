import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalcFacts } from '@/modules/wms/calc/intake';
import { fitSheetTexts } from '@/modules/wms/calc/intake-ai';

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
    expect(clientAnswer(live, 'GS777', false)).toMatchObject({ kind: 'customer', patch: { clientHintRaw: 'GS777' } });
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
    take({ goods: [line('Kurtka'), line('Shim')], label: '«A.xlsx»', text: '', where: '' });
    take({ goods: [line('Choynak'), line('Piyola'), line('Lagan')], label: '«B.xlsx»', text: '', where: '' });
    const third = take({ goods: [line('Poyabzal')], label: '«C.xlsx»', text: '', where: '' });
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
    const fit = (texts: readonly string[]) => fitSheetTexts(texts, 10_000);
    const sheetAfter = receiveSheetText(collection({ invoiceGoods: [line('Kurtka')] }).state, '«B.xlsx»', 'a | b', fit);
    expect(sheetAfter.patch).toMatchObject({ aiGoods: 'ask' });
    const excelAfterPdf = receiveGoodsSheet(collection({ pdfs: [pdf] }).state, {
      goods: [line('Kurtka')],
      label: '«A.xlsx»',
      text: '',
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
      where: '',
    });
    expect(first.patch.invoiceTexts).toEqual(['[Packing list]\nTOTAL G.W. | 9999 KGS']);
    expect(first.patch).not.toHaveProperty('sheetTexts');
  });

  it('🔁 drops the replaced one’s totals; ➕ keeps both', () => {
    const state = collection({
      invoiceGoods: [line('Kurtka')],
      invoiceTexts: ['WRONG 9999 KGS'],
      pendingInvoice: { goods: [line('Kurtka')], label: '«RIGHT.xlsx»', texts: ['RIGHT 1200 KGS'] },
      stage: 'material',
    }).state;
    expect(invoiceChoice(state, 'inv_replace')?.patch.invoiceTexts).toEqual(['RIGHT 1200 KGS']);
    expect(invoiceChoice(state, 'inv_add')?.patch.invoiceTexts).toEqual(['WRONG 9999 KGS', 'RIGHT 1200 KGS']);
  });
});

describe('a header-less sheet that will not fit is SAID when it arrives (review a17)', () => {
  const rows = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${i + 1} | ${tag} model ${i}`).join('\n');
  const fit = (texts: readonly string[]) => fitSheetTexts(texts, 400);

  it('a file cut part-way names how many of its lines the AI reads', () => {
    const answer = receiveSheetText(collection().state, '«PL.xlsx»', rows(60, 'Kurtka'), fit);
    expect(answer.say).toMatch(/AI faqat birinchi \d+ \/ 60 qatorini o‘qiydi/);
  });

  it('a file that does not fit at all is said to be outside the AI’s reading', () => {
    const answer = receiveSheetText(collection({ sheetTexts: [rows(60, 'A')] }).state, '«B.xlsx»', rows(10, 'B'), fit);
    expect(answer.say).toContain('AI ga sig‘madi');
  });

  it('a file that fits says nothing more', () => {
    const answer = receiveSheetText(collection().state, '«S.xlsx»', rows(3, 'Sumka'), fit);
    expect(answer.say).toBe('📄 «S.xlsx» — jadval sarlavhasini topa olmadim, AI o‘qiydi.');
  });
});

describe('the customer question has a way forward (review t23)', () => {
  it('the re-ask says why, and the SAME text again is the customer — out of the material', () => {
    const state = collection().state;
    const first = clientAnswer(state, 'Ali aka 2', true);
    expect(first.kind).toBe('material');
    if (first.kind !== 'material') return;
    expect(first.say).toContain('tovar ro‘yxatiga o‘xshaydi');
    const after = { ...state, ...first.patch };
    expect(after.material).toEqual(['Ali aka 2']);

    const again = clientAnswer(after, ' Ali aka 2 ', true);
    expect(again).toMatchObject({ kind: 'customer', patch: { clientHintRaw: 'Ali aka 2', stage: 'material' } });
    expect(again.patch.material).toEqual([]);
  });

  it('a different text is not «again»', () => {
    const state = { ...collection().state, clientAskedWith: 'Kurtka 300 dona' };
    expect(clientAnswer(state, 'Shim 50 dona', true).kind).toBe('material');
  });
});
