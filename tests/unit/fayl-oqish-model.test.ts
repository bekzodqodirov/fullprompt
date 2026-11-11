import Anthropic from '@anthropic-ai/sdk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { goodJson, readingJson, startSseStandIn, type SseStandIn } from '../fixtures/sse-anthropic';
import { aiFailureOf, analyzeIntake, readIntakeResponse, salvageCut } from '@/modules/wms/calc/intake-ai';
import {
  pdfMayBeEncrypted,
  permanentRefusal,
  readIntakeFile,
  receivePdf,
  TOO_BIG_SAY,
} from '@/modules/platform/telegram/calc-files';
import { analyzeCollected, endIntake, MAX_INTAKE_IMAGES, startIntake, updateIntake } from '@/modules/platform/telegram/calc-intake';

/**
 * Package P-model of docs/FAYL-OQISH.md (§3): the reading finishes, or keeps
 * what it read — and what the API or Telegram would not take is NAMED.
 *
 * The pure pieces are called directly (#166); everything about the call runs
 * the REAL SDK against the shared streaming stand-in (tests/fixtures/
 * sse-anthropic.ts), never a stub of `stream()`.
 */
let api: SseStandIn;
beforeAll(async () => {
  api = await startSseStandIn();
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  api.script.length = 0;
  api.bodies.length = 0;
  api.raws.length = 0;
});
const chats: bigint[] = [];
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});
const promptOf = (call: number): string =>
  api.bodies[call]!.messages[0]!.content.filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
const blocksOf = (call: number): string[] => api.bodies[call]!.messages[0]!.content.map((b) => b.type);

describe('salvageCut — only what the stream COMPLETED (§3.3, judge model-salvage-scanner)', () => {
  // Names and notes that hold the characters a naive brace counter trips on.
  const full = readingJson({
    from_city: 'Yiwu',
    weight_kg: 1250.5,
    volume_m3: 7.25,
    goods: [
      goodJson('Куртка {женская} \\"Lux\\"', { quantity: 300, weight_kg: 150, note: 'a } b { c' }),
      // A brace BETWEEN escaped quotes: read as outside the string, it
      // would close the element early.
      goodJson('Сумка "кожа }" {', { quantity: 120, volume_m3: 1.5, tnved_code: '4202210000' }),
    ],
    steps: ['o‘qildi'],
  });
  const whole = JSON.parse(full) as { goods: Record<string, unknown>[]; weight_kg: number; volume_m3: number };

  it('a cut at EVERY byte never returns a third good, a figure the whole answer lacks, or a half good', () => {
    const figures = new Set(JSON.stringify(whole).match(/-?\d+(?:\.\d+)?/g));
    let seenOne = false;
    for (let at = 0; at <= full.length; at += 1) {
      const cut = salvageCut(full.slice(0, at));
      expect(cut.goods.length, `at ${at}`).toBeLessThanOrEqual(2);
      cut.goods.forEach((g, i) => expect(g, `good ${i} at ${at}`).toEqual(whole.goods[i]));
      for (const value of Object.values(cut.totals)) {
        if (typeof value === 'number') expect(figures.has(String(value)), `total ${value} at ${at}`).toBe(true);
      }
      // A number is kept only once something follows it: «1250» of «1250.5» never.
      if (cut.totals.weight_kg !== undefined) expect(cut.totals.weight_kg).toBe(1250.5);
      if (cut.goods.length === 1) seenOne = true;
    }
    expect(seenOne).toBe(true);
    expect(salvageCut(full).goods).toHaveLength(2);
    expect(salvageCut(full).steps).toEqual(['o‘qildi']);
    // The codes never come out of a cut answer.
    expect(Object.keys(salvageCut(full))).toEqual(['totals', 'goods', 'steps', 'goodsClosed']);
  });

  it('a good missing a key — the stream cut inside it and a model closed it short — is not a good', () => {
    expect(salvageCut('{"goods":[{"name":"Kurtka","quantity":3}').goods).toEqual([]);
    expect(salvageCut('{"goods":[{"name":"Kurtka","quantity":3},').goods).toEqual([]);
  });
});

describe('aiFailureOf — what the stream throws (§3.3, judge model-midstream-errors)', () => {
  it('a status-less APIError (a mid-stream `event: error`) is read by its type', () => {
    const midStream = (type: string) => new Anthropic.APIError(undefined, { type: 'error', error: { type } }, undefined, undefined, type as never);
    expect(aiFailureOf(midStream('overloaded_error'))).toBe('overloaded');
    expect(aiFailureOf(midStream('api_error'))).toBe('overloaded');
    expect(aiFailureOf(midStream('rate_limit_error'))).toBe('rate_limited');
    expect(aiFailureOf(midStream('invalid_request_error'))).toBe('rejected');
    // A socket dropped mid-body: undici's «terminated», no response class.
    expect(aiFailureOf(new Anthropic.AnthropicError('terminated'))).toBe('network');
    // The caller's own abort — the leash.
    expect(aiFailureOf(new Anthropic.APIUserAbortError())).toBe('timeout');
  });
});

describe('the lone Excel on the AI door is coded by the model (§3.7, known-3)', () => {
  it('a list of rows whose codes are asked is something to read — ONE call, told what to do with no other material', async () => {
    api.script.push({ text: readingJson({ known_codes: [{ n: 1, tnved_code: '6201930000' }] }) });
    const out = await analyzeIntake({ section: 'rastamojka', text: '', fileCount: 1, knownGoods: ['Kurtka'], codeKnown: true, salvage: true });
    expect(api.bodies).toHaveLength(1);
    expect(out.ok && out.knownCodes).toEqual([{ index: 0, code: '6201930000' }]);
    expect(promptOf(0)).toContain('Других материалов нет: goods оставь пустым, дай только known_codes для строк списка.');
    expect(promptOf(0)).not.toContain('читай фото и документы');
  });

  it('every row coded already, or the codes not asked (the plain door): nothing to read, no call', async () => {
    const coded = await analyzeIntake({ section: 'rastamojka', text: '', fileCount: 1, knownGoods: ['Kurtka'], codeKnown: true, knownCoded: [true], salvage: true });
    const plain = await analyzeIntake({ section: 'rastamojka', text: '', fileCount: 1, knownGoods: ['Kurtka'], salvage: true });
    expect(coded).toEqual({ ok: false, failure: 'nothing_to_read' });
    expect(plain).toEqual({ ok: false, failure: 'nothing_to_read' });
    expect(api.bodies).toHaveLength(0);
  });

  it('through analyzeCollected: the AI door’s lone Excel makes one call, an all-coded one none, the plain door none', async () => {
    const collection = (ai: boolean, coded: boolean) => {
      const chatId = BigInt(-9_931_000_000) - BigInt(chats.length + 1);
      chats.push(chatId);
      startIntake(chatId, 'rastamojka', { ai, staffId: 'staff-test' });
      return updateIntake(chatId, {
        stage: 'material',
        fileCount: 1,
        invoiceGoods: [{ name: 'Kurtka', quantity: 300, weightKg: null, volumeM3: null, tnvedCode: coded ? '6201930000' : null, note: null }],
      })!;
    };
    api.script.push({ text: readingJson({}) });
    await analyzeCollected(collection(true, false));
    expect(api.bodies).toHaveLength(1);
    await analyzeCollected(collection(true, true));
    await analyzeCollected(collection(false, false));
    expect(api.bodies).toHaveLength(1);
  });

  it('the closing line names what was SENT (xlsxN-14)', async () => {
    api.script.push({ text: readingJson({}) }, { text: readingJson({}) });
    await analyzeIntake({ section: 'rastamojka', text: '', fileCount: 1, sheets: [{ text: 'A | 1', cut: false, cellsCut: false }], salvage: true });
    expect(promptOf(0)).toContain('Текста нет — читай таблицу выше.');
    await analyzeIntake({
      section: 'rastamojka',
      text: '',
      fileCount: 1,
      images: [{ data: Buffer.from('x'), mediaType: 'image/jpeg' }],
      salvage: true,
    });
    expect(promptOf(1)).toContain('Текста нет — читай фото и документы.');
    // …and what it was SHOWN of the attached (pdfimg-12).
    expect(promptOf(1)).toContain('Прикреплено файлов: 1; из них тебе показано: 1 фото, 0 PDF');
  });

  it('a packing list’s own rows beside the asked codes are totals-only — the closing never sends the model to list them', async () => {
    api.script.push({ text: readingJson({}) });
    await analyzeIntake({
      section: 'rastamojka',
      text: '',
      fileCount: 1,
      knownGoods: ['Kurtka'],
      codeKnown: true,
      goodsSheetText: { text: '[PL]\n1 | Kurtka | 300 | 150', cut: false, cellsCut: false },
      salvage: true,
    });
    const prompt = promptOf(0);
    expect(prompt).toContain('Товары отсюда НЕ перечисляй в goods:\n[PL]\n1 | Kurtka | 300 | 150');
    expect(prompt).toContain('Других материалов нет: goods оставь пустым, дай только known_codes для строк списка.');
    expect(prompt).not.toContain('читай таблицу выше');
  });

  it('beside a workbook’s OTHER sheets the closing keeps the totals asked — never «codes only» (review model-break-closing-context-sheets)', async () => {
    // A mapped workbook's other sheets carry the brutto and the cube, and
    // only the model reads them there: «Других материалов нет … только
    // known_codes» denied they were shown and dropped both.
    api.script.push({ text: readingJson({}) });
    await analyzeIntake({
      section: 'rastamojka',
      text: '',
      fileCount: 1,
      contextSheets: [{ text: '[Packing list]\nItem | CTNS | G.W.\nKurtka | 30 | 1200\nTOTAL | 30 | 1200', cut: false, cellsCut: false }],
      knownGoods: ['Kurtka'],
      codeKnown: true,
      salvage: true,
    });
    const prompt = promptOf(0);
    expect(prompt).toContain('только для итогов (общий вес/объём)');
    expect(prompt).toContain('Текста нет: goods оставь пустым (товары уже взяты); общий вес и объём возьми из листов выше; коды — в known_codes.');
    expect(prompt).not.toContain('Других материалов нет');
    // A header-only neighbour shows nothing, so it keeps nothing asked.
    api.script.push({ text: readingJson({}) });
    await analyzeIntake({
      section: 'rastamojka',
      text: '',
      fileCount: 1,
      contextSheets: [{ text: '[Cover]', cut: false, cellsCut: false }],
      knownGoods: ['Kurtka'],
      codeKnown: true,
      salvage: true,
    });
    expect(promptOf(1)).toContain('Других материалов нет: goods оставь пустым, дай только known_codes для строк списка.');
  });

  it('the goods sheet’s own rows are never something to read by themselves: every row coded → no call', async () => {
    const out = await analyzeIntake({
      section: 'rastamojka',
      text: '',
      fileCount: 1,
      knownGoods: ['Kurtka'],
      codeKnown: true,
      knownCoded: [true],
      goodsSheetText: { text: '[PL]\n1 | Kurtka | 300 | 150', cut: false, cellsCut: false },
      salvage: true,
    });
    expect(out).toEqual({ ok: false, failure: 'nothing_to_read' });
    expect(api.bodies).toHaveLength(0);
    // …and beside other material, rows with no code asked show none of it.
    api.script.push({ text: readingJson({}) });
    await analyzeIntake({
      section: 'rastamojka',
      text: 'brutto 300 kg',
      fileCount: 1,
      knownGoods: ['Kurtka'],
      codeKnown: true,
      knownCoded: [true],
      goodsSheetText: { text: '[PL]\n1 | Kurtka | 300 | 150', cut: false, cellsCut: false },
      salvage: true,
    });
    expect(promptOf(0)).not.toContain('[PL]');
  });
});

describe('a request the API refused WITH a PDF is read again without it (§3.4, pdfimg-9)', () => {
  const pdf = (id: string) => ({ data: Buffer.from('%PDF-1.4 x'), name: `${id}.pdf`, attachmentId: id });

  it('refused, then read without the PDF: the photos and the text answer, the PDF is named — the 400 billed nothing', async () => {
    api.script.push({ status: 400 }, { text: readingJson({ goods: [goodJson('Kurtka', { quantity: 300 })] }), usage: { input_tokens: 9, output_tokens: 8 } });
    const out = await analyzeIntake({
      section: 'rastamojka',
      text: 'Kurtka 300 dona',
      fileCount: 2,
      images: [{ data: Buffer.from('x'), mediaType: 'image/jpeg' }],
      pdf: pdf('a1'),
      salvage: true,
    });
    expect(blocksOf(0)).toContain('document');
    expect(blocksOf(1)).not.toContain('document');
    expect(blocksOf(1)).toContain('image');
    expect(out).toMatchObject({ ok: true, unreadPdfs: ['a1'] });
    expect(out.answered).toHaveLength(1);
  });

  // Re-anchored (review model-spec-pdf-only-named-unconfirmed): a lone PDF
  // was named on ANY refusal, with no second call — a retired model's 404 or a
  // parameter the model refused named the commonest invoice «AI bu faylni
  // qabul qilmadi», and every later reading skipped it for good.
  it('a PDF alone, refused: asked once more WITHOUT it — answered, so the PDF was what it refused: named, the answer billed, no reading', async () => {
    api.script.push({ status: 400 }, { text: readingJson({}), usage: { input_tokens: 3, output_tokens: 2 } });
    const out = await analyzeIntake({ section: 'rastamojka', text: '', fileCount: 1, pdf: pdf('a2'), salvage: true });
    expect(api.bodies).toHaveLength(2);
    expect(blocksOf(1)).not.toContain('document');
    expect(out).toMatchObject({ ok: false, failure: 'rejected', unreadPdfs: ['a2'] });
    expect(out.answered).toEqual([expect.objectContaining({ inputTokens: 3, outputTokens: 2 })]);
  });

  it('a PDF alone, refused the same way without it (a retired model’s 404): the REQUEST was refused, and no PDF is named', async () => {
    api.script.push({ status: 404 }, { status: 404 });
    const out = await analyzeIntake({ section: 'rastamojka', text: '', fileCount: 1, pdf: pdf('a4'), salvage: true });
    expect(api.bodies).toHaveLength(2);
    expect(out).toEqual({ ok: false, failure: 'rejected' });
  });

  it('refused WITHOUT the PDF as well: the PDF was not the cause, and is not named', async () => {
    api.script.push({ status: 400 }, { status: 400 });
    const out = await analyzeIntake({ section: 'rastamojka', text: 'Kurtka', fileCount: 1, pdf: pdf('a3'), salvage: true });
    expect(api.bodies).toHaveLength(2);
    expect(out).toEqual({ ok: false, failure: 'rejected' });
  });
});

describe('a reading the CONTEXT WINDOW stopped is a size cut (review model-break-window-exceeded)', () => {
  const two = readingJson({ goods: [goodJson('Kurtka', { quantity: 3 }), goodJson('Shim', { quantity: 2 })] });
  const cut = `${two.slice(0, two.indexOf(']'))},{"name":"Sumka","quantity":4`;

  it('read as `truncated` — never «unreadable» — and the goods it completed are kept', async () => {
    expect(readIntakeResponse({ stop_reason: 'model_context_window_exceeded', content: [{ type: 'text', text: cut }] })).toMatchObject({
      ok: false,
      failure: 'truncated',
    });
    api.script.push({ text: cut, stop: 'model_context_window_exceeded' });
    const out = await analyzeIntake({ section: 'rastamojka', text: 'Kurtka 3 dona', fileCount: 0, salvage: true });
    expect(out).toMatchObject({ ok: true, cut: { goods: 2, why: 'size' } });
    expect(api.bodies).toHaveLength(1);
  });
});

describe('no lone surrogate reaches the request (§3.8, apireq-1)', () => {
  const LONE = /(?<!\\)(?:\\\\)*\\ud[89a-f][0-9a-f]{2}/i;

  it('an emoji at every cut — a known name at 120 units, the material at 20 000 — is left out whole', async () => {
    api.script.push({ text: readingJson({}) });
    await analyzeIntake({
      section: 'rastamojka',
      text: `${'я'.repeat(19_999)}😀 tail`,
      fileCount: 1,
      knownGoods: [`${'Ж'.repeat(119)}😀`],
      codeKnown: true,
      salvage: true,
    });
    expect(LONE.test(api.raws[0]!)).toBe(false);
    expect(promptOf(0)).toContain(`1. ${'Ж'.repeat(119)}\n`);
    // Left out WHOLE by the cut — not mended into «�» by the boundary's fence.
    expect(promptOf(0)).not.toContain('\uFFFD');
  });

  it('a lone half INSIDE a file’s own text is mended at the boundary (the fence, not a cut)', async () => {
    api.script.push({ text: readingJson({}) });
    await analyzeIntake({ section: 'rastamojka', text: '', fileCount: 1, sheets: [{ text: 'Kurtka \ud83d | 3', cut: false, cellsCut: false }], salvage: true });
    expect(LONE.test(api.raws[0]!)).toBe(false);
  });
});

describe('what is refused at arrival is named (§1.1, §3.4)', () => {
  const state = () => {
    const chatId = BigInt(-9_932_000_000) - BigInt(chats.length + 1);
    chats.push(chatId);
    return startIntake(chatId, 'rastamojka', { ai: true, staffId: 'staff-test' });
  };

  it('the PDF caps: two sentences, each named on the table (pdfimg-8)', () => {
    const s = state();
    const three = { ...s, pdfs: [1, 2, 3].map((i) => ({ attachmentId: `p${i}`, name: `p${i}.pdf`, bytes: 1 })) };
    const count = receivePdf(three, { attachmentId: 'p4', name: 'p4.pdf', bytes: 1 }, '«p4.pdf»');
    expect(count.say).toBe('📄 «p4.pdf» — bitta so‘rovga 3 tadan ortiq PDF o‘qilmaydi. Kartada saqlandi.');
    expect(count.patch.refusedFiles).toEqual([{ name: 'p4.pdf', why: '3 tadan ortiq PDF' }]);
    const heavy = { ...s, pdfs: [1, 2].map((i) => ({ attachmentId: `p${i}`, name: `p${i}.pdf`, bytes: 5 * 1024 * 1024 })) };
    const bytes = receivePdf(heavy, { attachmentId: 'p3', name: 'big.pdf', bytes: 5 * 1024 * 1024 }, '«big.pdf»');
    expect(bytes.say).toContain('PDFlar jami 12 MB dan oshdi');
    expect(bytes.say).not.toContain('tadan ortiq');
    expect(bytes.patch.refusedFiles).toEqual([{ name: 'big.pdf', why: 'PDFlar jami 12 MB dan oshdi' }]);
    const huge = receivePdf(s, { attachmentId: 'h', name: 'h.pdf', bytes: 11 * 1024 * 1024 }, '«h.pdf»');
    expect(huge.patch.refusedFiles).toEqual([{ name: 'h.pdf', why: 'PDF 10 MB dan katta' }]);
  });

  it('Word, video, an archive, an unknown file, the 13th photo — each refused once and named', async () => {
    const s = state();
    const saved = (body: Buffer) => ({ isPhoto: false, body, attachmentId: '00000000-0000-4000-8000-000000000001' });
    const docx = await readIntakeFile(saved(Buffer.from('PK\u0003\u0004')), 'shartnoma.docx', null, s);
    expect(docx.patch.refusedFiles).toEqual([{ name: 'shartnoma.docx', why: 'Word fayl' }]);
    const video = await readIntakeFile(saved(Buffer.from('\u0000\u0000\u0000\u0018ftypmp42')), 'v.mp4', null, s);
    expect(video.patch.refusedFiles).toEqual([{ name: 'v.mp4', why: 'video' }]);
    const zip = await readIntakeFile(saved(Buffer.from('PK\u0003\u0004')), 'a.zip', null, s);
    expect(zip.patch.refusedFiles).toEqual([{ name: 'a.zip', why: 'arxiv' }]);
    const full = { ...s, images: Array.from({ length: MAX_INTAKE_IMAGES }, (_, i) => ({ attachmentId: `i${i}`, mediaType: 'image/jpeg' as const })) };
    const photo = await readIntakeFile({ ...saved(Buffer.from([0xff, 0xd8, 0xff, 0])), isPhoto: true }, '', null, full);
    expect(photo.say).toBeNull();
    expect(photo.patch).toMatchObject({ imagesSkipped: 1, refusedFiles: [{ name: 'rasm', why: '12 tadan ortiq rasm' }] });
  });

  it('an encrypted PDF is WARNED about and still read; only its trailer is looked at (judge model-encrypt-sniff)', async () => {
    const s = state();
    const tail = Buffer.from(`%PDF-1.7\n${'x'.repeat(9000)}\ntrailer\n<< /Size 9 /Root 1 0 R /Encrypt 7 0 R >>\n%%EOF\n`);
    const mention = Buffer.from(`%PDF-1.4\n${'y'.repeat(3000)}(See the /Encrypt 3 0 R dictionary)${'y'.repeat(6000)}\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);
    const linearized = Buffer.from(`%PDF-1.5\n<< /Linearized 1 >>\ntrailer\n<< /Encrypt 4 0 R >>\n${'z'.repeat(9000)}\n%%EOF\n`);
    expect(pdfMayBeEncrypted(tail)).toBe(true);
    expect(pdfMayBeEncrypted(mention)).toBe(false);
    expect(pdfMayBeEncrypted(linearized)).toBe(true);
    const read = await readIntakeFile({ isPhoto: false, body: tail, attachmentId: 'e1' }, 'bank.pdf', 'application/pdf', s);
    expect(read.patch.pdfs?.map((p) => p.name)).toEqual(['bank.pdf']);
    expect(read.patch.fileNotes).toEqual(['⚠️ «bank.pdf» parol bilan himoyalangan bo‘lishi mumkin — AI o‘qiy olmasa, parolsiz saqlab yuboring.']);
    const plain = await readIntakeFile({ isPhoto: false, body: mention, attachmentId: 'e2' }, 'ok.pdf', 'application/pdf', s);
    expect(plain.patch.fileNotes).toBeUndefined();
  });

  it('the 20 MB words are the spec’s', () => {
    expect(TOO_BIG_SAY).toBe('Fayl 20 MB dan katta — Telegram uni botga bermaydi. Kichikroq qilib (yoki Excel) yuboring.');
  });

  it('a PDF the API refused counts against neither cap — the password-free copy its warning asked for is taken (review model-break-pdf-caps-count-refused)', () => {
    const s = state();
    const MB7 = 7 * 1024 * 1024;
    const heavy = { ...s, pdfs: [{ attachmentId: 'enc', name: 'enc.pdf', bytes: MB7 }], unreadPdfs: ['enc'] };
    const copy = receivePdf(heavy, { attachmentId: 'ok', name: 'CI-ochiq.pdf', bytes: MB7 }, '«CI-ochiq.pdf»');
    expect(copy.say).toBe('📄 «CI-ochiq.pdf» — AI o‘qiydi.');
    expect(copy.patch.pdfs?.map((p) => p.attachmentId)).toEqual(['enc', 'ok']);
    expect(copy.patch.refusedFiles).toBeUndefined();
    const three = { ...s, pdfs: [1, 2, 3].map((i) => ({ attachmentId: `p${i}`, name: `p${i}.pdf`, bytes: 1 })), unreadPdfs: ['p3'] };
    const fourth = receivePdf(three, { attachmentId: 'p4', name: 'p4.pdf', bytes: 1 }, '«p4.pdf»');
    expect(fourth.say).toBe('📄 «p4.pdf» — AI o‘qiydi.');
  });

  it('the photos past the twelve are ONE entry, counted — never one «rasm» each (review model-break-photo-cap-names)', async () => {
    const s = state();
    const photo = { isPhoto: true, body: Buffer.from([0xff, 0xd8, 0xff, 0]), attachmentId: '00000000-0000-4000-8000-000000000002' };
    let live = {
      ...s,
      images: Array.from({ length: MAX_INTAKE_IMAGES }, (_, i) => ({ attachmentId: `i${i}`, mediaType: 'image/jpeg' as const })),
      refusedFiles: [{ name: 'a.docx', why: 'Word fayl' }],
    };
    for (let i = 0; i < 3; i += 1) live = { ...live, ...(await readIntakeFile(photo, '', null, live)).patch };
    expect(live.refusedFiles).toEqual([
      { name: 'a.docx', why: 'Word fayl' },
      { name: '3 ta rasm', why: '12 tadan ortiq rasm' },
    ]);
    expect(live.imagesSkipped).toBe(3);
  });

  it('every reason reads inside «X o‘qilmadi (…)» and «X — …»: a noun phrase, never «not read» again (review model-spec-refused-why-doubles-verb)', async () => {
    const s = state();
    const saved = (body: Buffer) => ({ isPhoto: false, body, attachmentId: '00000000-0000-4000-8000-000000000003' });
    const heic = await readIntakeFile(saved(Buffer.concat([Buffer.from('\u0000\u0000\u0000\u0018ftypheic'), Buffer.alloc(32)])), 'a.heic', null, s);
    // A drawing's binary header: neither a picture, a PDF nor a sheet.
    const unknown = await readIntakeFile(saved(Buffer.from([0x41, 0x43, 0x31, 0x30, 0, 0, 0xff, 0xfe, 1, 2])), 'chizma.dwg', 'application/octet-stream', s);
    const whys = [
      ...(heic.patch.refusedFiles ?? []),
      ...(unknown.patch.refusedFiles ?? []),
      ...(await readIntakeFile(saved(Buffer.from('PK\u0003\u0004')), 'b.docx', null, s)).patch.refusedFiles!,
      permanentRefusal(s, 'too_big', { name: 'big.pdf', isPhoto: false })!.patch.refusedFiles![0]!,
      permanentRefusal(s, 'unsupported', { name: 'c.dwg', isPhoto: false })!.patch.refusedFiles![0]!,
    ].map((f) => f.why);
    expect(heic.patch.refusedFiles).toEqual([{ name: 'a.heic', why: 'HEIC rasm' }]);
    expect(unknown.patch.refusedFiles).toEqual([{ name: 'chizma.dwg', why: 'noma’lum fayl turi' }]);
    for (const why of whys) expect(why, why).not.toMatch(/o‘qil|o‘qib/u);
  });

  it('what a door says of a file no re-send stores — and that a failed download is none of them (review model-break-unknown-type-unnamed)', () => {
    const s = state();
    expect(permanentRefusal(s, 'unsupported', { name: 'chizma.dwg', isPhoto: false })).toEqual({
      patch: { refusedFiles: [{ name: 'chizma.dwg', why: 'noma’lum fayl turi' }] },
      say: '📎 «chizma.dwg» kartada saqlanmadi: faylning bu turi o‘qilmaydi — rasm, PDF va Excel/CSV yuboring.',
    });
    expect(permanentRefusal(s, 'too_big', { name: '', isPhoto: true })).toEqual({
      patch: { refusedFiles: [{ name: 'rasm', why: '20 MB dan katta' }] },
      say: TOO_BIG_SAY,
    });
    // Re-sent, the same message brings the file AND its caption: nothing is taken now.
    expect(permanentRefusal(s, 'download_failed', { name: 'a.pdf', isPhoto: false })).toBeNull();
  });
});

describe('the thread door keeps no cut (§3.6, judge model-thread-door-cut)', () => {
  it('its call says `salvage: false` — the preview has no word for a partial list', async () => {
    const { readFileSync } = await import('node:fs');
    const code = readFileSync('src/modules/wms/calc/from-thread.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const call = code.slice(code.indexOf('await analyzeIntake({'), code.indexOf('});', code.indexOf('await analyzeIntake({')));
    expect(call).toContain('salvage: false');
  });
});

describe('a cut AFTER the goods array closed is a whole reading (as-built review MODEL-2)', () => {
  // The AI door's commonest answer: every good the Excel's (goods []), the
  // totals the photo carries, the steps — and the longest tail, the codes.
  const codes = Array.from({ length: 40 }, (_, i) => ({ n: i + 1, tnved_code: '6201930000' }));
  const empty = readingJson({ weight_kg: 1592, volume_m3: 13.58, goods: [], steps: ['o‘qildi'], known_codes: codes });
  const two = readingJson({
    weight_kg: 900,
    goods: [goodJson('Kurtka', { quantity: 300 }), goodJson('Shim', { quantity: 200 })],
    steps: ['o‘qildi'],
    known_codes: codes,
  });
  /** Cut inside `known_codes`, after its tenth entry. */
  const inCodes = (text: string) => text.slice(0, text.indexOf('"known_codes":[') + 200);
  const known = Array.from({ length: 40 }, (_, i) => `Tovar ${i + 1}`);

  it('salvageCut says the goods array closed — none of them or all of them', () => {
    expect(salvageCut(inCodes(empty))).toMatchObject({ goodsClosed: true, goods: [], totals: { weight_kg: 1592, volume_m3: 13.58 } });
    expect(salvageCut(inCodes(two))).toMatchObject({ goodsClosed: true });
    expect(salvageCut(two.slice(0, two.indexOf('"Shim"'))).goodsClosed).toBe(false);
  });

  for (const how of ['clock', 'size'] as const) {
    it(`a ${how} cut inside the codes after goods []: the totals and «no new goods» kept, no cut — never a failure`, async () => {
      api.script.push(
        how === 'clock'
          ? { text: inCodes(empty), chunk: 400, paceMs: 5, abortAfterMs: 300 }
          : { text: inCodes(empty), stop: 'max_tokens' },
      );
      const out = await analyzeIntake({ section: 'rastamojka', text: '', fileCount: 2, knownGoods: known, codeKnown: true, images: [], salvage: true, timeoutMs: 1_500 });
      expect(out.ok, JSON.stringify(out)).toBe(true);
      expect(out.ok && out.cut).toBeUndefined();
      expect(out.ok && out.facts).toMatchObject({ weightKg: 1592, volumeM3: 13.58, goods: [] });
      // One call: a whole reading is not read again without the codes.
      expect(api.bodies).toHaveLength(1);
    });

    it(`a ${how} cut inside the codes after two goods: both kept and NOT reported as a cut`, async () => {
      api.script.push(
        how === 'clock'
          ? { text: inCodes(two), chunk: 400, paceMs: 5, abortAfterMs: 300 }
          : { text: inCodes(two), stop: 'max_tokens' },
      );
      const out = await analyzeIntake({ section: 'rastamojka', text: 'invoys', fileCount: 1, salvage: true, timeoutMs: 1_500 });
      expect(out).toMatchObject({ ok: true, facts: { weightKg: 900 } });
      expect(out.ok && out.cut).toBeUndefined();
      expect(out.ok && out.facts.goods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim']);
    });
  }

  it('a cut INSIDE the goods array is still the cut it was (control)', async () => {
    api.script.push({ text: two.slice(0, two.indexOf('"Shim"') - 1), stop: 'max_tokens' });
    const out = await analyzeIntake({ section: 'rastamojka', text: 'invoys', fileCount: 1, salvage: true, timeoutMs: 1_500 });
    expect(out).toMatchObject({ ok: true, cut: { goods: 1, why: 'size' } });
  });
});

describe('the rows a reader dropped are context, never a reason to call (as-built review MODEL-8)', () => {
  const footer = { text: '[Под таблицей «inv.xlsx»: строки, не взятые как товары]\nBuyer signature: ____', cut: false, cellsCut: false, dropped: true as const };

  it('an all-coded Excel with a footer under it makes no call', async () => {
    const out = await analyzeIntake({
      section: 'rastamojka',
      text: '',
      fileCount: 1,
      knownGoods: ['Kurtka', 'Shim'],
      codeKnown: true,
      knownCoded: [true, true],
      contextSheets: [footer],
      salvage: true,
    });
    expect(out).toEqual({ ok: false, failure: 'nothing_to_read' });
    expect(api.bodies).toHaveLength(0);
  });

  it('beside a reading that happens anyway the footer is still shown (control)', async () => {
    api.script.push({ text: readingJson({}) });
    await analyzeIntake({ section: 'rastamojka', text: '', fileCount: 1, knownGoods: ['Kurtka'], codeKnown: true, contextSheets: [footer], salvage: true });
    expect(api.bodies).toHaveLength(1);
    expect(promptOf(0)).toContain('Buyer signature');
  });
});
