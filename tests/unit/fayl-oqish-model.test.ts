import Anthropic from '@anthropic-ai/sdk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { goodJson, readingJson, startSseStandIn, type SseStandIn } from '../fixtures/sse-anthropic';
import { aiFailureOf, analyzeIntake, salvageCut } from '@/modules/wms/calc/intake-ai';
import { pdfMayBeEncrypted, readIntakeFile, receivePdf, TOO_BIG_SAY } from '@/modules/platform/telegram/calc-files';
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
    expect(Object.keys(salvageCut(full))).toEqual(['totals', 'goods', 'steps']);
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

  it('a PDF alone, refused: nothing else to read, so no second call — the refusal stands and names it', async () => {
    api.script.push({ status: 400 });
    const out = await analyzeIntake({ section: 'rastamojka', text: '', fileCount: 1, pdf: pdf('a2'), salvage: true });
    expect(api.bodies).toHaveLength(1);
    expect(out).toEqual({ ok: false, failure: 'rejected', unreadPdfs: ['a2'] });
  });

  it('refused WITHOUT the PDF as well: the PDF was not the cause, and is not named', async () => {
    api.script.push({ status: 400 }, { status: 400 });
    const out = await analyzeIntake({ section: 'rastamojka', text: 'Kurtka', fileCount: 1, pdf: pdf('a3'), salvage: true });
    expect(api.bodies).toHaveLength(2);
    expect(out).toEqual({ ok: false, failure: 'rejected' });
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
    expect(docx.patch.refusedFiles).toEqual([{ name: 'shartnoma.docx', why: 'Word fayl o‘qilmaydi' }]);
    const video = await readIntakeFile(saved(Buffer.from('\u0000\u0000\u0000\u0018ftypmp42')), 'v.mp4', null, s);
    expect(video.patch.refusedFiles).toEqual([{ name: 'v.mp4', why: 'video o‘qilmaydi' }]);
    const zip = await readIntakeFile(saved(Buffer.from('PK\u0003\u0004')), 'a.zip', null, s);
    expect(zip.patch.refusedFiles).toEqual([{ name: 'a.zip', why: 'arxiv o‘qilmaydi' }]);
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
