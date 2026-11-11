import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { ANALYST_MODEL, type ModelTokens } from '../../platform/ai/model';
import { logger } from '../../platform/logger';
import type { PreparedFile } from './tarkib-file';
import { MERGED_MARK } from './tarkib-file';
import { READ_MAX_ROWS, type ReadAnswer } from './tarkib-proposal';

/**
 * «🤖 Fayldan to'ldirish» — the ONE model call (docs/TARKIB-TAKLIFLAR.md §3):
 * the client's packing list or invoice goes in — a PDF whole, a photograph
 * reduced, a spreadsheet as text — and the goods table comes back
 * TRANSCRIBED. One reader for every kind of file, so «does a reading count»
 * has one answer.
 *
 * The house pattern (`tnved/service.ts suggestTnved`): a deadlined client,
 * structured output, `stop_reason` read before the text, the usage carried
 * beside the answer and on every failure AFTER an answer. Not the bot's
 * intake reader: that one prices a request, has no carton field and is
 * another round's to change.
 *
 * It never throws: every way a reading can end is a CODE with its own usage
 * rule, because the caller has a reserved ledger row to settle either way —
 *
 *   ai_refused / ai_truncated / ai_failed  the model ANSWERED and the answer
 *        was no good → `failed`, with its tokens, counted;
 *   ai_timeout    OUR deadline ran out after the request was sent → `failed`
 *        with no tokens, counted: the provider had been working, and an
 *        uncounted timeout can be pressed for ever;
 *   ai_failed (no usage) / ai_rejected    the call never ran — a refused key,
 *        a rate limit, a dead network, a request the provider would not take
 *        → `no_answer`, not counted: a dead key must not spend the day.
 */

/** How long one reading may take. The browser waits a little longer than this, never less. */
export const READ_LEASH_MS = 150_000;
/** The answer's room. The model THINKS inside `max_tokens`; forty rows of JSON are a few thousand. */
const READ_MAX_TOKENS = 16_000;

export type ReadFailure = 'ai_refused' | 'ai_truncated' | 'ai_failed' | 'ai_timeout' | 'ai_rejected';

export type ReadResult =
  | { ok: true; answer: ReadAnswer; usage: ModelTokens }
  | { ok: false; code: ReadFailure; outcome: 'failed' | 'no_answer'; usage?: ModelTokens };

const nullableNumber = { type: ['number', 'null'] } as const;
const nullableString = { type: ['string', 'null'] } as const;

/**
 * The structured output. Every field required and nullable — «the paper does
 * not say» is an answer the schema must be able to give for each figure, or
 * the model is pushed to fill one in. Structured outputs take no bounds, so
 * the forty-row ceiling is the prompt's and then the code's.
 */
const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Название товара как в документе, в одну строку' },
          name_ru: { ...nullableString, description: 'Краткое русское название, если в документе название не на русском; иначе null' },
          pieces: { ...nullableNumber, description: 'Количество штук этой строки' },
          cartons: { ...nullableNumber, description: 'Количество грузовых мест (коробок) этой строки' },
          gross_kg: { ...nullableNumber, description: 'Вес брутто всей строки, кг' },
          net_kg: { ...nullableNumber, description: 'Вес нетто всей строки, кг' },
          volume_m3: { ...nullableNumber, description: 'Объём всей строки, м³' },
          hs_code: { ...nullableString, description: 'Код ТН ВЭД / HS, если напечатан в документе для этой строки' },
          unsure: { ...nullableString, description: 'Что в этой строке прочитано неуверенно; иначе null' },
        },
        required: ['name', 'name_ru', 'pieces', 'cartons', 'gross_kg', 'net_kg', 'volume_m3', 'hs_code', 'unsure'],
        additionalProperties: false,
      },
    },
    totals: {
      anyOf: [
        {
          type: 'object',
          properties: { cartons: nullableNumber, gross_kg: nullableNumber, volume_m3: nullableNumber },
          required: ['cartons', 'gross_kg', 'volume_m3'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    },
    document: { type: 'string', enum: ['packing_list', 'invoice', 'other'] },
    notes: nullableString,
  },
  required: ['rows', 'totals', 'document', 'notes'],
  additionalProperties: false,
} as const;

const rowSchema = z.object({
  name: z.string(),
  name_ru: z.string().nullable(),
  pieces: z.number().nullable(),
  cartons: z.number().nullable(),
  gross_kg: z.number().nullable(),
  net_kg: z.number().nullable(),
  volume_m3: z.number().nullable(),
  hs_code: z.string().nullable(),
  unsure: z.string().nullable(),
});
const answerSchema = z.object({
  rows: z.array(rowSchema),
  totals: z.object({ cartons: z.number().nullable(), gross_kg: z.number().nullable(), volume_m3: z.number().nullable() }).nullable(),
  document: z.enum(['packing_list', 'invoice', 'other']),
  notes: z.string().nullable(),
});

/**
 * Exported so the test reads the prompt itself: the rules below are the
 * feature's promise («nothing invented»), and a prompt nobody can read is a
 * promise nobody checked.
 */
export const READ_SYSTEM = `Ты переписываешь таблицу товаров из документа клиента — упаковочного листа (packing list) или инвойса. По ней сотрудник склада заполнит состав лота и сам сверит каждую цифру с документом, поэтому важна точность, а не полнота.

Правила:
- Только переписывай. Ничего не вычисляй, не складывай, не умножай и не дели: число в ответе — это число, напечатанное в документе в этой же строке. Вес или объём ОДНОЙ коробки не умножай на количество коробок: если итоговой цифры по строке в документе нет — null.
- Ничего не придумывай и не достраивай. Если цифры нет, она не читается или непонятно, к какой строке она относится, — ставь null и коротко объясни в unsure.
- Одна строка ответа — один товар документа, в порядке документа. Итоговые строки («Итого», «Total», «合计»), заголовки, реквизиты продавца и покупателя товарами не являются.
- name — название товара так, как оно написано в документе, в одну строку. Если строки различаются только моделью, артикулом, цветом или размером из соседних колонок — добавь это к названию, чтобы строки различались.
- name_ru — краткое русское название товара, как его пишут в таможенных документах, если название в документе не на русском; если оно уже на русском — null.
- pieces — количество единиц товара в строке (PCS, QTY, 数量, шт, пар, комплектов). «1,000 pcs» в колонке количества — это одна тысяча, а не единица.
- cartons — количество грузовых мест этой строки (CTNS, 箱数, 件数, коробок, мест). Колонка с НОМЕРАМИ коробок («CTN NO.», «箱号», «№ места», «1-50») — это не количество: по ней cartons не заполняй.
- gross_kg — вес брутто всей строки (G.W., 毛重, брутто), net_kg — вес нетто всей строки (N.W., 净重, нетто), в килограммах; volume_m3 — объём всей строки в кубических метрах (CBM, 体积, м³).
- Цифра, объединённая на несколько строк (одна ячейка веса, объёма или мест на группу товаров), относится ко всей группе: запиши её в первой строке группы, в остальных строках группы поставь null и скажи об этом в unsure этих строк.
- hs_code — код ТН ВЭД (HS code), только если он напечатан в документе для этой строки. Сам код не подбирай.
- Если один и тот же товар перечислен дважды — в таблице инвойса и в упаковочной таблице, — запиши его ОДИН раз и возьми цифры из упаковочной таблицы.
- Не больше ${READ_MAX_ROWS} строк. Если товаров больше — верни первые ${READ_MAX_ROWS} и напиши об этом в notes.
- totals — только итоговая строка, напечатанная в самом документе (всего мест, всего брутто, общий объём). Сам ничего не складывай: чего в документе нет — null; если итоговой строки нет вовсе — totals = null.
- document — что это за документ: packing_list, invoice или other.
- unsure и notes — по-русски, коротко. notes — одна-две фразы о документе в целом (видны не все страницы, товаров больше ${READ_MAX_ROWS}, таблица товаров не найдена); если сказать нечего — null.

Если документ дан текстом таблицы: каждая строка текста — строка листа, ячейки разделены « | », пустое место между разделителями — пустая ячейка, «[имя]» — название листа. Знак «${MERGED_MARK}» в ячейке означает, что она объединена с ячейкой над ней: объединённое название или код относится и к этой строке, а объединённая цифра количества, веса или объёма — одна на всю группу (см. правило выше).`;

const ASK = 'Перепиши таблицу товаров из этого документа.';

/** What the model is sent for one prepared file — exported for the test, which reads the request itself. */
export function readContent(file: PreparedFile, fileName: string): Anthropic.ContentBlockParam[] {
  // The customer's own file name, flattened: «Packing list 0511.xlsx» says what the paper is.
  const named = fileName.replace(/\s+/g, ' ').trim().slice(0, 120);
  const ask = named ? `Файл: ${named}\n${ASK}` : ASK;
  if (file.kind === 'pdf') {
    return [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data.toString('base64') } },
      { type: 'text', text: ask },
    ];
  }
  if (file.kind === 'image') {
    return [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: file.data.toString('base64') } },
      { type: 'text', text: ask },
    ];
  }
  const cut = file.rowsCut ? '\n(Таблица показана не полностью — только начало.)' : '';
  return [{ type: 'text', text: `Документ — таблица, текстом:\n${file.text}${cut}\n\n${ask}` }];
}

/**
 * Read one prepared file. `leashMs` is a parameter for the test alone — the
 * deadline is the rule it proves, and nobody waits 150 seconds to prove it.
 *
 * ONE deadline for the whole call, retry included. The client's own
 * `timeout` is per ATTEMPT and a timed-out attempt is retried, so a provider
 * that hangs would hold this reading for twice the leash — longer than the
 * browser waits, with the second attempt's answer delivered to nobody and
 * paid for. The signal ends the call where the leash ends; a quick failure
 * (a 529, a reset connection) still gets its one retry inside it.
 */
export async function readTarkibDocument(
  file: PreparedFile,
  opts: { fileName: string; leashMs?: number },
): Promise<ReadResult> {
  const leashMs = opts.leashMs ?? READ_LEASH_MS;
  const client = new Anthropic({ timeout: leashMs, maxRetries: 1 });
  const deadline = AbortSignal.timeout(leashMs);
  const started = Date.now();
  let usage: ModelTokens | undefined;
  try {
    const response = await client.messages.create(
      {
        model: ANALYST_MODEL,
        max_tokens: READ_MAX_TOKENS,
        system: READ_SYSTEM,
        output_config: { format: { type: 'json_schema', schema: ANSWER_SCHEMA } },
        messages: [{ role: 'user', content: readContent(file, opts.fileName) }],
      },
      { signal: deadline },
    );
    // Billed as the model the call was MADE with — the constant, never the id
    // the provider echoes: the ledger prices a row by it (`calc/ai-press.ts`).
    usage = {
      model: ANALYST_MODEL,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    };
    const spent = { in: usage.inputTokens, out: usage.outputTokens, stop: response.stop_reason, kind: file.kind };
    const ms = () => Date.now() - started;
    if (response.stop_reason === 'refusal') {
      logger.warn({ ...spent, ms: ms() }, '[tarkib-read] the model declined the document');
      return { ok: false, code: 'ai_refused', outcome: 'failed', usage };
    }
    // A cut-off answer is NAMED: half a JSON document is «unreadable» below
    // too, but the cause — and the cure, fewer pages — are different.
    if (response.stop_reason === 'max_tokens') {
      logger.warn({ ...spent, ms: ms() }, '[tarkib-read] the answer was cut at max_tokens');
      return { ok: false, code: 'ai_truncated', outcome: 'failed', usage };
    }
    const text = response.content.find((block) => block.type === 'text')?.text ?? '';
    let answer: ReadAnswer;
    try {
      answer = answerSchema.parse(JSON.parse(text));
    } catch {
      logger.warn({ ...spent, ms: ms() }, '[tarkib-read] the answer could not be read');
      return { ok: false, code: 'ai_failed', outcome: 'failed', usage };
    }
    // One line per reading: what a person greps when a day's count looks wrong.
    logger.info({ ...spent, rows: answer.rows.length, ms: ms() }, '[tarkib-read] reading');
    return { ok: true, answer, usage };
  } catch (err) {
    // The SDK's own timeout, or our deadline ending a retry: either way the
    // request had been SENT and the provider had been working on it.
    const timedOut =
      err instanceof Anthropic.APIConnectionTimeoutError || (err instanceof Anthropic.APIUserAbortError && deadline.aborted);
    const status = err instanceof Anthropic.APIError ? err.status : undefined;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), status, timedOut, kind: file.kind, ms: Date.now() - started },
      '[tarkib-read] reading failed',
    );
    // Something of ours threw AFTER the model had answered: the answer was
    // paid for, whatever became of it.
    if (usage) return { ok: false, code: 'ai_failed', outcome: 'failed', usage };
    if (timedOut) return { ok: false, code: 'ai_timeout', outcome: 'failed' };
    // The provider would not take the request itself — too many pages, a
    // file it cannot open: pressing again changes nothing, so it has its own
    // word. Nothing was generated either way.
    if (status === 400 || status === 413 || status === 422) return { ok: false, code: 'ai_rejected', outcome: 'no_answer' };
    return { ok: false, code: 'ai_failed', outcome: 'no_answer' };
  }
}
