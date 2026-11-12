import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { goodJson, readingJson, startSseStandIn, type SseStandIn } from '../fixtures/sse-anthropic';
import {
  __resetIntakeContract,
  aiGoodsLine,
  analyzeIntake,
  INTAKE_CONTRACTS,
  intakeContract,
  knownCodesOf,
  knownNamesOf,
  questionsOf,
} from '@/modules/wms/calc/intake-ai';
import { applyPacking } from '@/modules/wms/calc/carton-math';

/**
 * docs/AI-SORAYDI.md §2.1 — the reading falls back to the LEGACY contract
 * when the API refuses the new schema.
 *
 * No key exists where this is written, so the first real request under the
 * new schema is made in production. If the API will not compile it («Schema
 * is too complex for compilation», HTTP 400), every reading would fail until
 * the next deploy. The SDK itself makes these calls against a local stand-in
 * that answers the platform's own words, so what is tested is what the SDK
 * throws — never an error object typed by hand (#1209).
 */
const TOO_COMPLEX = 'Schema is too complex for compilation.';
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
  __resetIntakeContract();
});

const schemaOf = (i: number) => JSON.stringify((api.bodies[i]!.output_config as { format: { schema: unknown } }).format.schema);
const read = () => analyzeIntake({ section: 'rastamojka', text: 'Kurtka 300 dona 150 kg', fileCount: 0, salvage: true });

describe('the API refuses the schema → the same reading is asked again under the legacy contract', () => {
  it('one refusal, one legacy request, a reading — and the refusal is not counted as an attempt', async () => {
    api.script.push({ status: 400, message: TOO_COMPLEX }, { text: readingJson({ goods: [goodJson('Куртка', { quantity: 300, weight_kg: 150 })] }) });
    const out = await read();
    expect(out.ok && out.facts.goods).toMatchObject([{ name: 'Куртка', quantity: 300, weightKg: 150 }]);
    expect(api.bodies).toHaveLength(2);
    // The first request carried the packing contract — its prompt AND its shape…
    expect(api.bodies[0]!.system).toBe(INTAKE_CONTRACTS.packing.system);
    expect(schemaOf(0)).toContain('"carton_volume_m3"');
    // …the second the legacy pair, whole: never one's prompt with the other's shape.
    expect(api.bodies[1]!.system).toBe(INTAKE_CONTRACTS.legacy.system);
    expect(schemaOf(1)).not.toContain('"cartons"');
    expect(schemaOf(1)).not.toContain('"questions"');
    // Only the answered attempt is billed.
    expect(out.answered).toHaveLength(1);
  });

  it('…and it stays for the process: the next reading asks the legacy contract at once', async () => {
    api.script.push({ status: 400, message: TOO_COMPLEX }, { text: readingJson() }, { text: readingJson() });
    await read();
    expect(intakeContract().name).toBe('legacy');
    // On globalThis, as boss.ts keeps its state (review JB-14): Next bundles
    // the worker's copy of this module apart from the routes', and a flag in
    // the module would be latched in one and unknown to the other.
    expect((globalThis as { __gsrIntakeLegacyContract?: boolean }).__gsrIntakeLegacyContract).toBe(true);
    api.bodies.length = 0;
    await read();
    expect(api.bodies).toHaveLength(1);
    expect(api.bodies[0]!.system).toBe(INTAKE_CONTRACTS.legacy.system);
  });

  it('a refusal under the LEGACY contract is a refusal — no third contract, no loop', async () => {
    api.script.push({ status: 400, message: TOO_COMPLEX }, { status: 400, message: TOO_COMPLEX });
    const out = await read();
    expect(out).toMatchObject({ ok: false, failure: 'rejected' });
    expect(api.bodies).toHaveLength(2);
  });
});

describe('a 400 that is NOT about the schema keeps today’s road', () => {
  it('a plain refusal: «rejected», the packing contract stays', async () => {
    api.script.push({ status: 400 });
    const out = await read();
    expect(out).toMatchObject({ ok: false, failure: 'rejected' });
    expect(intakeContract().name).toBe('packing');
    expect(api.bodies).toHaveLength(1);
  });

  it('a 400 about ANOTHER field of output_config is not the schema’s: no latch (the prompt audit’s PR-14)', async () => {
    // «invalid» + «output_config» used to be enough — and the packing was then
    // lost for the life of the process over a parameter nobody sent wrongly twice.
    api.script.push({ status: 400, message: 'output_config.effort: Input should be low, medium, high, xhigh or max (invalid)' });
    const out = await read();
    expect(out.ok).toBe(false);
    expect(api.bodies).toHaveLength(1);
    expect(intakeContract().name).toBe('packing');
  });

  it('a request refused WITH a PDF is still read again without it — the PDF is blamed, not the schema', async () => {
    api.script.push({ status: 400, message: 'messages.0.content.0.document.source.base64: could not process the PDF' }, { text: readingJson() });
    const out = await analyzeIntake({
      section: 'rastamojka',
      text: 'Kurtka 300 dona',
      fileCount: 1,
      pdf: { data: Buffer.from('%PDF-1.4'), name: 'inv.pdf', attachmentId: 'a-1' },
      salvage: true,
    });
    expect(out.ok).toBe(true);
    expect(out.unreadPdfs).toEqual(['a-1']);
    expect(intakeContract().name).toBe('packing');
    expect(api.bodies[1]!.system).toBe(INTAKE_CONTRACTS.packing.system);
  });

  it('a schema refusal beside a PDF is the SCHEMA’s: the PDF is asked again under the legacy contract, not dropped', async () => {
    api.script.push({ status: 400, message: TOO_COMPLEX }, { text: readingJson() });
    const out = await analyzeIntake({
      section: 'rastamojka',
      text: '',
      fileCount: 1,
      pdf: { data: Buffer.from('%PDF-1.4'), name: 'inv.pdf', attachmentId: 'a-1' },
      salvage: true,
    });
    expect(out.ok).toBe(true);
    expect(out.unreadPdfs).toBeUndefined();
    const second = api.bodies[1]!.messages[0]!.content.map((b) => b.type);
    expect(second).toContain('document');
  });
});

describe('the new answer is read: packing, the picture’s name, the model’s questions', () => {
  it('a product photo’s good with its packing, and a question about the shipment and about a row', async () => {
    api.script.push({
      text: readingJson({
        goods: [
          goodJson('Стул офисный', {
            name_source: 'picture',
            photo: 1,
            weight_kind: 'unknown',
            packing: [
              {
                cartons: 20,
                pieces_per_carton: 2,
                carton_weight_kg: 0,
                carton_weight_kind: 'unknown',
                carton_volume_m3: 0.12,
                l: 0,
                w: 0,
                h: 0,
                size_unit: 'unknown',
                size_of: 'unknown',
                piece_weight_kg: 0,
              },
            ],
            tnved_code: '9401310000',
            code_sure: false,
          }),
        ],
        questions: [
          { n: 1, kind: 'material', text: 'Stul nimadan — plastikmi, metallmi?' },
          { n: 0, kind: 'Per_Or_Total', text: '0.12 kub — bitta karobkanikimi?' }, // the enum word is folded
          { n: 7, kind: 'which_row', text: 'Qaysi qator?' }, // past the goods: asked of the shipment, never of a row that is not there
          { n: 1, kind: 'a word nobody defined', text: 'Yana nima?' }, // an unknown kind reads «other»
          { n: 1, kind: 'other', text: '   ' }, // nothing asked
          'garbage',
        ],
      }),
    });
    const out = await analyzeIntake({
      section: 'rastamojka',
      text: '',
      fileCount: 1,
      images: [{ data: Buffer.from('x'), mediaType: 'image/jpeg' }],
      salvage: true,
    });
    if (!out.ok) throw new Error('expected a reading');
    // 20 × 0.12 = 2.4 m³ and 20 × 2 = 40 — the BOT's arithmetic, by hand here.
    expect(out.facts.goods).toMatchObject([
      { name: 'Стул офисный', nameFrom: 'photo', photoNo: 1, tnvedCode: '9401310000', tnvedSure: false, volumeM3: 2.4, quantity: 40 },
    ]);
    // Each is kept by its good's NAME (`about`, review JR-2) — the row number is the model's list's.
    expect(out.questions).toEqual([
      { list: 'goods', row: 0, kind: 'material', text: 'Stul nimadan — plastikmi, metallmi?', about: 'Стул офисный' },
      { list: 'goods', row: null, kind: 'per_or_total', text: '0.12 kub — bitta karobkanikimi?' },
      { list: 'goods', row: null, kind: 'which_row', text: 'Qaysi qator?' },
      { list: 'goods', row: 0, kind: 'other', text: 'Yana nima?', about: 'Стул офисный' },
    ]);
    // Every picture is numbered for the model: «Фото 1:» stands before its image block.
    const blocks = api.bodies.at(-1)!.messages[0]!.content;
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image', 'text']);
    expect(blocks[0]!.text).toBe('Фото 1:');
  });

  it('a CUT answer keeps the questions whose array closed — they stand right after the goods', async () => {
    const whole = readingJson({
      goods: [goodJson('Стул', { quantity: 20 })],
      questions: [{ n: 1, kind: 'material', text: 'Stul nimadan?' }],
      steps: ['a', 'b'],
    });
    // The schema's order is goods → questions → steps: cut inside `steps`.
    const ordered = JSON.stringify((({ goods, questions, steps, ...rest }) => ({ ...rest, goods, questions, steps }))(JSON.parse(whole)));
    const at = ordered.indexOf('"steps"') + 12;
    api.script.push({ text: ordered.slice(0, at), stop: 'max_tokens' });
    const out = await read();
    if (!out.ok) throw new Error('expected the kept reading');
    expect(out.facts.goods).toHaveLength(1);
    expect(out.questions).toEqual([{ list: 'goods', row: 0, kind: 'material', text: 'Stul nimadan?', about: 'Стул' }]);
  });

  it('a question says WHICH list its number is in: the reading’s goods, or the rows it was shown (JR-2, JS-3)', () => {
    // Three Excel rows were shown as 1, 2, 3 — the caller's indexes 4, 7 and 9.
    const shown = [4, 7, 9];
    const raw = [
      { list: 'known', n: 2, kind: 'material', text: 'Nimadan qilingan?' },
      { list: 'goods', n: 2, kind: 'what_goods', text: 'Rasmdagi tovar nima?' },
      { list: ' KNOWN ', n: 5, kind: 'other', text: 'Bu qaysi?' }, // a number it was not shown: the shipment's
      { n: 1, kind: 'other', text: 'Eski javob' }, // no list said: its own goods
    ];
    expect(questionsOf(raw, 2, shown)).toEqual([
      { list: 'known', row: 7, kind: 'material', text: 'Nimadan qilingan?' },
      { list: 'goods', row: 1, kind: 'what_goods', text: 'Rasmdagi tovar nima?' },
      { list: 'known', row: null, kind: 'other', text: 'Bu qaysi?' },
      { list: 'goods', row: 0, kind: 'other', text: 'Eski javob' },
    ]);
    // With the names at hand each question says WHAT it is about — a known
    // row by the caller's own name for it, a good by the reading's.
    const taken = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'XJ-200 (stul)', 'h', 'i'];
    expect(questionsOf(raw, [{ name: 'Стул' }, { name: 'Стол  письменный' }], shown, taken).map((q) => q.about)).toEqual([
      'XJ-200 (stul)',
      'Стол письменный',
      undefined,
      'Стул',
    ]);
    // With no list shown, a «known» number names nothing.
    expect(questionsOf([{ list: 'known', n: 1, kind: 'other', text: 'Qaysi?' }], 3)).toEqual([
      { list: 'known', row: null, kind: 'other', text: 'Qaysi?' },
    ]);
  });

  it('a row LABEL the model wrote into its words is cut — the bot numbers the rows; a number in the sentence stays', () => {
    const said = (text: string) => questionsOf([{ list: 'goods', n: 1, kind: 'other', text }], 1)[0]?.text;
    expect(said('2-qator: nimadan qilingan?')).toBe('nimadan qilingan?');
    expect(said('3) Karobkada nechta?')).toBe('Karobkada nechta?');
    expect(said('1. Stul nimadan?')).toBe('Stul nimadan?');
    expect(said('Строка 2: из чего?')).toBe('Строка 2: из чего?'); // not a leading number: left as written
    // Figures that ARE the sentence.
    expect(said('0.12 kub — bitta karobkanikimi?')).toBe('0.12 kub — bitta karobkanikimi?');
    expect(said('20 karobka jami necha kg?')).toBe('20 karobka jami necha kg?');
    expect(said('3-qatordagi tovar nima?')).toBe('3-qatordagi tovar nima?');
    expect(said('1.5 kg bittasimi?')).toBe('1.5 kg bittasimi?');
  });

  it('known_codes may NAME a row the sheet calls by its article — with a code, or alone (JS-9, JB-12)', () => {
    const shown = [0, 1, 2, 3];
    const raw = [
      { n: 1, tnved_code: '9401310000', name: 'Стул офисный' },
      { n: 2, tnved_code: '', name: '  Стол   письменный ' },
      { n: 3, tnved_code: '8516500000', name: '' },
      { n: 4, tnved_code: '', name: '' }, // nothing said
      { n: 9, tnved_code: '9403100000', name: 'Шкаф' }, // a number it was not shown
      { n: 2, tnved_code: '', name: 'Стол письменный' }, // the same name twice is one name
    ];
    expect(knownCodesOf(raw, shown)).toEqual([
      { index: 0, code: '9401310000' },
      { index: 2, code: '8516500000' },
    ]);
    expect(knownNamesOf(raw, shown)).toEqual([
      { index: 0, name: 'Стул офисный' },
      { index: 1, name: 'Стол письменный' },
    ]);
    // Two DIFFERENT names for one row is no answer — as two codes are.
    expect(knownNamesOf([{ n: 1, tnved_code: '', name: 'Стул' }, { n: 1, tnved_code: '', name: 'Кресло' }], shown)).toEqual([]);
    // The legacy answer has no `name` at all.
    expect(knownNamesOf([{ n: 1, tnved_code: '9401310000' }], shown)).toEqual([]);
  });

  it('a reading returns the names beside the codes, by the caller’s index', async () => {
    api.script.push({
      text: readingJson({ goods: [], known_codes: [{ n: 1, tnved_code: '9401310000', name: 'Стул офисный' }] }),
    });
    const out = await analyzeIntake({
      section: 'rastamojka',
      text: '',
      fileCount: 1,
      images: [{ data: Buffer.from('x'), mediaType: 'image/jpeg' }],
      knownGoods: ['XJ-200'],
      codeKnown: true,
      salvage: true,
    });
    if (!out.ok) throw new Error('expected a reading');
    expect(out.knownCodes).toEqual([{ index: 0, code: '9401310000' }]);
    expect(out.knownNames).toEqual([{ index: 0, name: 'Стул офисный' }]);
  });

  it('what ONE carton holds is counted in the row’s own measure: «12 пар/кор × 40 кор» is 480 PAIRS, never 480 pieces (JR-1)', () => {
    const pack = { cartons: 40, pieces_per_carton: 12, carton_weight_kg: 0, carton_weight_kind: 'unknown', carton_volume_m3: 0, l: 0, w: 0, h: 0, size_unit: 'unknown', size_of: 'unknown', piece_weight_kg: 0 };
    const base = { name: 'Кроссовки', name_source: 'text', photo: 0, quantity: null, weight_kg: null, weight_kind: 'unknown', volume_m3: null, tnved_code: null, code_sure: true, note: null };
    const pairs = aiGoodsLine({ ...base, unit: 'juft', measure_qty: null, packing: [pack] });
    expect(pairs).toMatchObject({ quantity: null, measureUnit: 'juft', measureQty: 480 });
    expect(pairs.packing?.perCartonUnit).toBe('juft');
    // No unit on the row: pieces, as before.
    const pieces = aiGoodsLine({ ...base, unit: null, measure_qty: null, packing: [pack] });
    expect(pieces).toMatchObject({ quantity: 480, measureUnit: null, measureQty: null });
    // The row STATES its pairs: the per-carton figure is not re-labelled, and
    // a stated total that is not the product is a doubt, never overwritten.
    const stated = aiGoodsLine({ ...base, unit: 'juft', measure_qty: 500, packing: [pack] });
    expect(stated).toMatchObject({ measureUnit: 'juft', measureQty: 500 });
    expect(stated.packing?.perCartonUnit).toBeUndefined();
    expect(applyPacking(stated).line.measureQty).toBe(500);
  });

  it('a legacy answer (none of the new keys) reads exactly as before', async () => {
    api.script.push({ text: readingJson({ goods: [goodJson('Куртка', { quantity: 300 })] }) });
    const out = await read();
    if (!out.ok) throw new Error('expected a reading');
    expect(out.facts.goods).toEqual([
      { name: 'Куртка', quantity: 300, weightKg: null, volumeM3: null, measureUnit: null, measureQty: null, tnvedCode: null, note: null },
    ]);
    expect(out.questions).toBeUndefined();
  });
});
