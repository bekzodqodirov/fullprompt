import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «🤖 Fayldan to'ldirish» — the one model call (docs/TARKIB-TAKLIFLAR.md §3),
 * with the SDK as a stand-in that records what each call was shown and
 * answers what the test scripts. Everything that decides what a reading
 * COSTS and what it is CALLED is the code that runs in production:
 *
 *  · what the model is sent for a PDF, a photograph and a spreadsheet;
 *  · every way a reading can end has its own code and its own usage rule —
 *    an answer that was no good is billed with its tokens, a call our own
 *    deadline abandoned is counted with none, and a call that never ran
 *    (a refused key, a rate limit, a dead network) is not counted at all.
 *
 * NOT provable here: the wire itself. There is no key and no network in this
 * container or in CI — the first real reading on the server is that proof.
 */
const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('@anthropic-ai/sdk')>();
  class Stand extends real.default {
    constructor(opts: ConstructorParameters<typeof real.default>[0]) {
      super({ ...opts, apiKey: 'test-key' });
      (this as unknown as { messages: unknown }).messages = { create: sdk.create };
    }
  }
  return { ...real, default: Stand };
});

import Anthropic from '@anthropic-ai/sdk';
import { ANALYST_MODEL } from '@/modules/platform/ai/model';
import { MERGED_MARK, type PreparedFile } from '@/modules/wms/receipts/tarkib-file';
import { READ_MAX_ROWS } from '@/modules/wms/receipts/tarkib-proposal';
import { READ_LEASH_MS, READ_SYSTEM, readContent, readTarkibDocument } from '@/modules/wms/receipts/tarkib-read-ai';

const saved = process.env.ANTHROPIC_API_KEY;
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  sdk.create.mockReset();
});
afterEach(() => {
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved;
});

const ROW = { name: '键盘', name_ru: 'Клавиатура', pieces: 500, cartons: 50, gross_kg: 600, net_kg: 550, volume_m3: 1.5, hs_code: null, unsure: null };
const body = (over: Record<string, unknown> = {}) => JSON.stringify({ rows: [ROW], totals: null, document: 'packing_list', notes: null, ...over });
const answered = (text: string, stop = 'end_turn') => ({
  stop_reason: stop,
  // The id the provider echoes is not the constant the call was made with.
  model: 'an-echoed-spelling',
  content: [{ type: 'text', text }],
  usage: { input_tokens: 2100, output_tokens: 640 },
});
const USAGE = { model: ANALYST_MODEL, inputTokens: 2100, outputTokens: 640 };

const sheet: PreparedFile = { kind: 'sheet', text: '[Packing]\nName | Qty\n键盘 | 500', rows: 2, rowsCut: false, cellsCut: false };
const pdf: PreparedFile = { kind: 'pdf', data: Buffer.from('%PDF-1.4\n%%EOF\n') };
const photo: PreparedFile = { kind: 'image', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) };
const read = (file: PreparedFile = sheet, leashMs?: number) => readTarkibDocument(file, { fileName: 'Packing  list\n0511.xlsx', leashMs });

type Sent = {
  model: string;
  max_tokens: number;
  system: string;
  output_config: { format: { type: string; schema: Record<string, unknown> } };
  messages: { role: string; content: Record<string, unknown>[] }[];
};
const sent = (call = 0) => sdk.create.mock.calls[call]![0] as Sent;

describe('what the model is sent', () => {
  it('the house call: the analyst constant, room for its thinking, the system prompt, a strict schema — one user turn', async () => {
    sdk.create.mockResolvedValueOnce(answered(body()));
    await read();
    const request = sent();
    expect(request.model).toBe(ANALYST_MODEL);
    expect(request.max_tokens).toBe(16_000);
    expect(request.system).toBe(READ_SYSTEM);
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]!.role).toBe('user');
    const { format } = request.output_config;
    expect(format.type).toBe('json_schema');
    expect(format.schema).toMatchObject({ type: 'object', additionalProperties: false, required: ['rows', 'totals', 'document', 'notes'] });
    const item = (format.schema.properties as { rows: { items: Record<string, unknown> } }).rows.items;
    // Every field REQUIRED and nullable: «the paper does not say» must be an answer the schema can give.
    expect(item.required).toEqual(['name', 'name_ru', 'pieces', 'cartons', 'gross_kg', 'net_kg', 'volume_m3', 'hs_code', 'unsure']);
    expect(item.additionalProperties).toBe(false);
    for (const key of ['pieces', 'cartons', 'gross_kg', 'net_kg', 'volume_m3'] as const) {
      expect((item.properties as Record<string, { type: unknown }>)[key]!.type, key).toEqual(['number', 'null']);
    }
    // Structured outputs take no bounds: the row ceiling is the prompt's and the code's.
    expect(JSON.stringify(format.schema)).not.toMatch(/maxItems|minimum|maximum|maxLength/);
  });

  it('ONE deadline for the whole call: the client’s timeout and the request’s signal are the same leash', async () => {
    sdk.create.mockResolvedValueOnce(answered(body()));
    await read();
    const options = sdk.create.mock.calls[0]![1] as { signal: AbortSignal };
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
    expect(READ_LEASH_MS).toBe(150_000);
  });

  it('a spreadsheet goes as its text, with the file’s own name on one line', async () => {
    expect(readContent(sheet, 'Packing  list\n0511.xlsx')).toEqual([
      {
        type: 'text',
        text: 'Документ — таблица, текстом:\n[Packing]\nName | Qty\n键盘 | 500\n\nФайл: Packing list 0511.xlsx\nПерепиши таблицу товаров из этого документа.',
      },
    ]);
    // A table that was cut says so to the model too.
    const cut = readContent({ ...sheet, rowsCut: true }, 'a.xlsx')[0] as { text: string };
    expect(cut.text).toContain('\n(Таблица показана не полностью — только начало.)\n');
  });

  it('a PDF goes whole as a document block, a photograph as a JPEG image block — each BEFORE the question', () => {
    expect(readContent(pdf, 'p.pdf')).toEqual([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.data.toString('base64') } },
      { type: 'text', text: 'Файл: p.pdf\nПерепиши таблицу товаров из этого документа.' },
    ]);
    expect(readContent(photo, '')).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photo.data.toString('base64') } },
      { type: 'text', text: 'Перепиши таблицу товаров из этого документа.' },
    ]);
  });

  it('the prompt carries the feature’s promises in words — transcribe, never invent, the traps by name', () => {
    for (const rule of [
      'Только переписывай. Ничего не вычисляй',
      'Ничего не придумывай и не достраивай',
      '«1,000 pcs» в колонке количества — это одна тысяча',
      'Колонка с НОМЕРАМИ коробок («CTN NO.», «箱号», «№ места», «1-50») — это не количество',
      'запиши её в первой строке группы, в остальных строках группы поставь null и скажи об этом в unsure',
      'запиши его ОДИН раз и возьми цифры из упаковочной таблицы',
      `Не больше ${READ_MAX_ROWS} строк. Если товаров больше — верни первые ${READ_MAX_ROWS} и напиши об этом в notes.`,
      'totals — только итоговая строка, напечатанная в самом документе',
      'Сам код не подбирай.',
      `Знак «${MERGED_MARK}» в ячейке означает, что она объединена с ячейкой над ней`,
    ]) {
      expect(READ_SYSTEM, rule).toContain(rule);
    }
  });
});

describe('how a reading ends', () => {
  it('a good answer: the rows as transcribed, billed as the model the call was MADE with', async () => {
    sdk.create.mockResolvedValueOnce(answered(body({ totals: { cartons: 50, gross_kg: 600, volume_m3: null }, notes: 'ок' })));
    expect(await read()).toEqual({
      ok: true,
      answer: { rows: [ROW], totals: { cartons: 50, gross_kg: 600, volume_m3: null }, document: 'packing_list', notes: 'ок' },
      usage: USAGE,
    });
  });

  it('a refusal, a cut-off and an unreadable answer were ANSWERED: their own codes, «failed», WITH the tokens', async () => {
    sdk.create.mockResolvedValueOnce(answered('', 'refusal'));
    expect(await read(pdf)).toEqual({ ok: false, code: 'ai_refused', outcome: 'failed', usage: USAGE });
    sdk.create.mockResolvedValueOnce(answered('{"rows": [{"name": "键', 'max_tokens'));
    expect(await read(pdf)).toEqual({ ok: false, code: 'ai_truncated', outcome: 'failed', usage: USAGE });
    for (const text of ['not json at all', '{"rows": "none"}', body({ document: 'letter' }), body({ rows: [{ ...ROW, pieces: '500' }] }), '']) {
      sdk.create.mockResolvedValueOnce(answered(text));
      expect(await read(), text).toEqual({ ok: false, code: 'ai_failed', outcome: 'failed', usage: USAGE });
    }
  });

  it('the SDK’s own timeout: the request was SENT — counted, with no tokens', async () => {
    sdk.create.mockRejectedValueOnce(new Anthropic.APIConnectionTimeoutError());
    expect(await read(pdf)).toEqual({ ok: false, code: 'ai_timeout', outcome: 'failed' });
  });

  it('OUR deadline ends the call where the leash ends — a hung provider is not waited on twice', async () => {
    // What the SDK does with the signal: an aborted request is an
    // APIUserAbortError, and it is not retried.
    sdk.create.mockImplementationOnce(
      (_params: unknown, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()));
        }),
    );
    const started = Date.now();
    expect(await read(pdf, 40)).toEqual({ ok: false, code: 'ai_timeout', outcome: 'failed' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(sdk.create).toHaveBeenCalledTimes(1);
  });

  it('an abort that is NOT our deadline is not a timeout', async () => {
    sdk.create.mockRejectedValueOnce(new Anthropic.APIUserAbortError());
    expect(await read(pdf)).toEqual({ ok: false, code: 'ai_failed', outcome: 'no_answer' });
  });

  it('a call that never ran — a refused key, a rate limit, an overload, a dead network — is «no_answer»: not counted', async () => {
    const api = (status: number) => Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message: 'x' } }, 'x', new Headers());
    for (const err of [api(401), api(403), api(429), api(500), api(529), new Anthropic.APIConnectionError({ message: 'ECONNREFUSED' })]) {
      sdk.create.mockRejectedValueOnce(err);
      expect(await read(pdf), String(err)).toEqual({ ok: false, code: 'ai_failed', outcome: 'no_answer' });
    }
  });

  it('a request the provider would not TAKE — too many pages, a file it cannot open — has its own word, and is not counted', async () => {
    const api = (status: number) => Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message: 'x' } }, 'x', new Headers());
    for (const status of [400, 413, 422]) {
      sdk.create.mockRejectedValueOnce(api(status));
      expect(await read(pdf), String(status)).toEqual({ ok: false, code: 'ai_rejected', outcome: 'no_answer' });
    }
  });
});
