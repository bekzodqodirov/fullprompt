import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { goodJson, readingJson, startSseStandIn, type SseStandIn } from '../fixtures/sse-anthropic';
import {
  __resetIntakeContract,
  analyzeIntake,
  INTAKE_CONTRACTS,
  intakeContract,
} from '@/modules/wms/calc/intake-ai';

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
            cartons: 20,
            pieces_per_carton: 2,
            carton_weight_kg: 0,
            carton_weight_kind: 'unknown',
            carton_volume_m3: 0.12,
            carton_l: 0,
            carton_w: 0,
            carton_h: 0,
            carton_size_unit: 'unknown',
            tnved_code: '9401310000',
            code_sure: false,
          }),
        ],
        questions: [
          { n: 1, text: 'Stul nimadan — plastikmi, metallmi?' },
          { n: 0, text: 'Umumiy og‘irlik qancha?' },
          { n: 7, text: 'Qaysi qator?' }, // past the goods: asked of the shipment, never of a row that is not there
          { n: 1, text: '   ' }, // nothing asked
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
      { name: 'Стул офисный', nameFrom: 'photo', tnvedCode: '9401310000', tnvedSure: false, volumeM3: 2.4, quantity: 40 },
    ]);
    expect(out.questions).toEqual([
      { row: 0, text: 'Stul nimadan — plastikmi, metallmi?' },
      { row: null, text: 'Umumiy og‘irlik qancha?' },
      { row: null, text: 'Qaysi qator?' },
    ]);
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
