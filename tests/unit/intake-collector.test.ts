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
// «Bo‘ldi» only enqueues since the reading is a pg-boss job (docs/SAKKIZ-R3.md
// §7.1); the one drive helper runs the captured job.
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);

import {
  activeIntake,
  endIntake,
  startIntake,
  updateIntake,
  type IntakeState,
} from '@/modules/platform/telegram/calc-intake';
import { parseCallback } from '@/modules/platform/telegram/staff-bot';
import { INTAKE_READ_RETRY } from '@/modules/platform/telegram/calc-read';
import { driveReading, readingsEnqueued, resetReadingDrive } from '../fixtures/calc-read-drive';
import { applyTableAnswer, deliverNextStep } from '@/modules/platform/telegram/calc-dialog';
import { migrateIntakeState } from '@/modules/platform/telegram/calc-store';
import {
  clientAnswer,
  handleCalcCallback,
  readCustomerText,
  RETIRED_FILE_STEP,
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
  startIntake(chatId, section, { staffId: 'staff-test' });
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

beforeEach(() => {
  analyse.fn.mockReset();
  resetReadingDrive();
});
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});

// Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
// second file. These pinned the question; they now pin its ABSENCE and the rule that replaced it.
describe('a second Excel no longer waits on a question — the stage it stood in stays (review c0)', () => {
  const pending = { goods: [line('Shim')], label: '«B.xlsx»', texts: [] };

  it('a collection hydrated still waiting for the customer stays waiting; the old button only says why', async () => {
    const { chatId, state } = collection({ invoiceGoods: [line('Kurtka')], pendingInvoice: pending });
    updateIntake(chatId, migrateIntakeState(state));
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'inv_add');
    expect(ctx.texts()).toEqual([RETIRED_FILE_STEP]);
    const live = activeIntake(chatId)!;
    expect(live.stage).toBe('client');
    expect(live.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim']);
    expect(live.pendingInvoice).toBeNull();
    // …so the code typed next is the customer, never material.
    expect(clientAnswer(live, 'GS777', { material: false, couldBeCustomer: true, why: null })).toMatchObject({ kind: 'customer', patch: { clientHintRaw: 'GS777' } });
  });

  it('the podklyuch door’s «qayerdan?» is kept too, and a collecting stage stays a collecting stage', () => {
    const base = { invoiceGoods: [line('Kurtka')], pendingInvoice: pending };
    const section = migrateIntakeState({ ...collection(base, 'podklyuch').state, stage: 'section' });
    expect([section.stage, section.pendingInvoice]).toEqual(['section', null]);
    const material = migrateIntakeState({ ...collection(base).state, stage: 'material' });
    expect([material.stage, material.pendingInvoice]).toEqual(['material', null]);
  });
});

describe('a third goods file is compared like the second (review c1)', () => {
  it('A, then B, then C: every file’s new rows land and each says how many — nothing waits, nothing is overwritten', () => {
    let state = collection().state;
    const take = (file: Parameters<typeof receiveGoodsSheet>[1]) => {
      const answer = receiveGoodsSheet(state, file);
      state = { ...state, ...answer.patch };
      return answer;
    };
    take({ goods: [line('Kurtka'), line('Shim')], label: '«A.xlsx»', text: '', textCut: false, cellsCut: false, where: '' });
    const second = take({ goods: [line('Choynak'), line('Piyola'), line('Lagan')], label: '«B.xlsx»', text: '', textCut: false, cellsCut: false, where: '' });
    const third = take({ goods: [line('Poyabzal')], label: '«C.xlsx»', text: '', textCut: false, cellsCut: false, where: '' });
    // One line per further file (§1.2.4; as-built review CHAT-6): the fold's
    // own head names the rows, «N ta tovar o‘qildi» above it said it twice.
    expect(second.say).toBe('📄 «B.xlsx» — 3 ta yangi tovar qo‘shildi.');
    expect(third.say).toBe('📄 «C.xlsx» — 1 ta yangi tovar qo‘shildi.');
    expect(Object.keys(third).sort()).toEqual(['patch', 'say']);
    expect(state.pendingInvoice).toBeNull();
    expect(state.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim', 'Choynak', 'Piyola', 'Lagan', 'Poyabzal']);
  });
});

describe('an answer given while the analysis ran is kept (review c2)', () => {
  it('the live per-line answer goes back onto the new reading', () => {
    const snapshot = { ...collection({ stage: 'material', analysing: 'T1', material: ['Kurtka'] }).state };
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
  it('the reading is enqueued anyway, and its own exit releases the token', async () => {
    // Re-anchored (docs/SAKKIZ-R3.md §11, P2): the press ENQUEUES the reading
    // — the notice's failure is caught as before — and the job is the
    // reading's exit; its last attempt releases the token and says so.
    analyse.fn.mockRejectedValueOnce(new Error('model down'));
    const { chatId } = collection({ stage: 'material', material: ['Kurtka 300 dona'] });
    const ctx = fakeCtx({ refuse: /^⏳/ });
    await expect(handleCalcCallback(ctx, chatId, 'done')).resolves.toBeUndefined();
    expect(readingsEnqueued(chatId)).toHaveLength(1);
    await driveReading(chatId, ctx, { retryCount: INTAKE_READ_RETRY });
    expect(activeIntake(chatId)?.analysing).toBeNull();
    expect(analyse.fn).toHaveBeenCalledTimes(1);
    expect(ctx.texts().at(-1)).toBe('Tahlil qilib bo‘lmadi. «Bo‘ldi» ni qayta bosing.');
    // …and the next «Bo'ldi» is a «Bo'ldi», not «Tahlil davom etmoqda».
    await handleCalcCallback(ctx, chatId, 'done');
    expect(readingsEnqueued(chatId)).toHaveLength(2);
    expect(ctx.texts().some((t) => t.includes('Tahlil davom etmoqda'))).toBe(false);
  });
});

// Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
// second file. These pinned the question; they now pin its ABSENCE and the rule that replaced it.
describe('a PDF or a header-less sheet beside an Excel list takes the add path, never a question (review c4, M3)', () => {
  const pdf = { attachmentId: 'a-pdf-b', name: 'B.pdf', bytes: 10 };

  it('a PDF after the Excel: no question, no keyboard, and «Bo‘ldi» reads — the old buttons only say why', async () => {
    const { chatId, state } = collection({ stage: 'material', invoiceGoods: [line('Kurtka')], fileCount: 2 });
    const answer = receivePdf(state, pdf, '«B.pdf»');
    expect(answer.patch).toMatchObject({ aiGoods: 'add' });
    expect(answer).toEqual({ patch: answer.patch, say: '📄 «B.pdf» — AI o‘qiydi.' });

    updateIntake(chatId, answer.patch);
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    expect(activeIntake(chatId)?.analysing).not.toBeNull();
    expect(readingsEnqueued(chatId)).toHaveLength(1);
    expect(ctx.texts().join('\n')).not.toContain('boshqa zavodning tovarlarimi');

    // The retired buttons stay PARSED (#939) and answer in words.
    for (const step of ['other_add', 'other_same'] as const) {
      expect(parseCallback(`c:${step}`), step).not.toBeNull();
      const press = fakeCtx();
      await handleCalcCallback(press, chatId, step);
      expect(press.texts()).toEqual([RETIRED_FILE_STEP]);
    }
    expect(activeIntake(chatId)?.aiGoods).toBe('add');
  });

  it('a header-less sheet after the Excel, and an Excel after a PDF (the other order), take the add path too', () => {
    const fit = (texts: readonly string[]) => fitSheetRows(texts, 10_000);
    const sheetAfter = receiveSheetText(collection({ invoiceGoods: [line('Kurtka')] }).state, '«B.xlsx»', { text: 'a | b', cut: false, cellsCut: false }, fit);
    expect(sheetAfter.patch).toMatchObject({ aiGoods: 'add' });
    expect(Object.keys(sheetAfter).sort()).toEqual(['patch', 'say']);
    const excelAfterPdf = receiveGoodsSheet(collection({ pdfs: [pdf] }).state, {
      goods: [line('Kurtka')],
      label: '«A.xlsx»',
      text: '',
      textCut: false,
      cellsCut: false,
      where: '',
    });
    expect(excelAfterPdf.patch).toMatchObject({ aiGoods: 'add', invoiceGoods: [line('Kurtka')] });
    expect(excelAfterPdf.say).toBe('📄 «A.xlsx» — 1 ta tovar o‘qildi.');
    // No Excel list: the model's lines ARE the goods.
    expect(receivePdf(collection().state, pdf, '«B.pdf»').patch).not.toHaveProperty('aiGoods');
  });

  it('a hydrated answer stands: «context» was the seller’s own word; «ask» becomes the add path', () => {
    expect(receivePdf(collection({ invoiceGoods: [line('Kurtka')], aiGoods: 'context' }).state, pdf, '«C.pdf»').patch).not.toHaveProperty('aiGoods');
    expect(migrateIntakeState(collection({ aiGoods: 'ask', stage: 'material' }).state).aiGoods).toBe('add');
    expect(migrateIntakeState(collection({ aiGoods: 'context', stage: 'material' }).state).aiGoods).toBe('context');
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

  it('nor while an analysis runs — the stage is unchanged', async () => {
    // R3: the per-line question stage is retired (his 1.10 c), so the claim
    // this pinned is held on the table stage: a stale ⏭ moves nothing.
    const { chatId } = collection({ stage: 'review', analysing: 'T9' });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(ctx.texts()).toEqual(['Bu tugma eskirgan.']);
    expect(activeIntake(chatId)?.stage).toBe('review');
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

  it('a second workbook keeps its totals beside the first’s — there is no «🔁» to drop them (his 1a)', () => {
    // Re-anchored by docs/IKKI-ESHIK.md §1.1/§1.3: this pinned «🔁» dropping the replaced file's
    // totals. Nothing replaces a file now; a hydrated waiting one is compared like a new one.
    const state = collection({
      invoiceGoods: [line('Kurtka')],
      invoiceTexts: [{ text: 'WRONG 9999 KGS', cut: false, cellsCut: false }],
      pendingInvoice: { goods: [line('Kurtka')], label: '«RIGHT.xlsx»', texts: [{ text: 'RIGHT 1200 KGS', cut: true, cellsCut: false }] },
      stage: 'material',
    }).state;
    const migrated = migrateIntakeState(state);
    expect(migrated.invoiceTexts).toEqual([
      { text: 'WRONG 9999 KGS', cut: false, cellsCut: false },
      { text: 'RIGHT 1200 KGS', cut: true, cellsCut: false },
    ]);
    // The same «Kurtka» with no figure to agree on is no duplicate: added, and named.
    expect(migrated.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Kurtka']);
    expect(migrated.fileNotes).toEqual([
      '📄 «RIGHT.xlsx» — 1 ta yangi tovar qo‘shildi.',
      '📄 «RIGHT.xlsx» — «Kurtka»: birinchi faylda ham «Kurtka» — ikkalasi olindi (bir xil bo‘lsa, VED bittasini o‘chiradi).',
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

describe('a line answered in the table stays answered across «➕ Yana ma’lumot» (round-2 review, C10; R3 1.10 c)', () => {
  // ⏭ is retired with the per-line question (docs/SAKKIZ-R3.md §11): the
  // defect C10 pinned — a record of a line carried by index onto another line
  // after a re-read — is held on ANSWERS, which `placeByName` places by name.
  it('row 1 answered, ➕, a re-read that moves it: the answer lands on its own line', async () => {
    const { chatId, state } = collection({
      stage: 'review',
      material: ['Kurtka, Shim, Sharf'],
      facts: { goods: [line('Kurtka'), line('Shim'), line('Sharf')] },
    });
    const ctx = fakeCtx();
    await applyTableAnswer(ctx, chatId, state, '1: 150 kg', { date: 0, messageId: 50, forwarded: false, replyTo: null });
    expect(activeIntake(chatId)?.facts.goods?.[0]).toMatchObject({ name: 'Kurtka', weightKg: 150 });
    await handleCalcCallback(ctx, chatId, 'more');
    expect(activeIntake(chatId)?.stage).toBe('material');
    analyse.fn.mockImplementationOnce(async (s: IntakeState) => ({
      ...s,
      facts: { goods: [line('Shim'), line('Kurtka'), line('Sharf')] },
      stage: 'review',
      // analyzeCollected's own shape: the job bills what it answered (§7.2.10).
      answered: [],
    }));
    // The re-read runs as the job (docs/SAKKIZ-R3.md §11, P2): «Bo‘ldi» only enqueues.
    await handleCalcCallback(ctx, chatId, 'done');
    await driveReading(chatId, ctx);
    expect(activeIntake(chatId)?.analysing).toBeNull();
    const after = activeIntake(chatId)!;
    expect(after.facts.goods?.map((g) => [g.name, g.weightKg ?? null])).toEqual([
      ['Shim', null],
      ['Kurtka', 150],
      ['Sharf', null],
    ]);
    // …and the stored answer says where it now is, so the next re-read starts there.
    expect(after.lineAnswers).toMatchObject([{ index: 1, name: 'Kurtka', patch: { weightKg: 150 } }]);
  });
});

describe('the table names the customer on ONE line (round-2 review, C9; round-3, R3-C3)', () => {
  it('«Ali aka» over the phone reads «Mijoz: Ali aka · +998 …» — one line, and the phone the landing reads', async () => {
    // The summary reached through ⏭ is retired; the table is what the reading
    // delivers (`deliverNextStep`), with the same `Mijoz:` line.
    const { chatId, state } = collection({
      stage: 'material',
      clientHintRaw: 'Ali aka\n+998 90 123 45 67',
      facts: { goods: [line('Kurtka', { weightKg: 150 })] },
    });
    const ctx = fakeCtx();
    await deliverNextStep(ctx, chatId, state);
    const table = ctx.texts().at(-1)!;
    expect(table).toContain('Mijoz: Ali aka · +998 90 123 45 67\n');
    expect(activeIntake(chatId)?.stage).toBe('review');
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
    const answer = await readIntakeFile({ isPhoto: false, body: Buffer.from(csv), attachmentId: 'a-file' }, 'PL.csv', 'text/csv', state);
    expect(answer.say).toContain('⚠️ Jadval katta');
    expect(answer.patch.sheetTexts?.[0]?.cut).toBe(true);
  });
});
