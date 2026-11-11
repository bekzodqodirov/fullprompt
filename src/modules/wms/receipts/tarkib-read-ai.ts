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
 * The house's DOCUMENT reading, as the bot's intake has made it since
 * docs/FAYL-OQISH.md §3 (`calc/intake-ai.ts`): STREAMED, at effort `medium`,
 * with room for 32 000 tokens, no SDK retry, one deadline. A forty-row
 * transcription of a PDF or a photograph is that shape of call, and the
 * shape this file first copied — `suggestTnved`'s: one good, four fields,
 * not streamed, the provider's default effort, the thinking inside 16 000
 * tokens — is the one that document says came back EMPTY on production: the
 * thinking spent the leash the rows needed. Here each such ending also costs
 * one of the day's readings and ten minutes of cooling (the T1 review, A3).
 * Not shared code with the intake reader: that one prices a request, salvages
 * a cut answer's goods and is another round's to change.
 *
 * It never throws: every way a reading can end is a CODE with its own usage
 * rule, because the caller has a reserved ledger row to settle either way —
 *
 *   ai_refused / ai_truncated / ai_failed  the model ANSWERED and the answer
 *        was no good → `failed`, with its tokens, counted;
 *   ai_timeout    OUR deadline ran out → `failed` with no tokens, counted:
 *        only our own deadline proves the provider had been working, and an
 *        uncounted timeout can be pressed for ever;
 *   ai_failed (no usage) / ai_rejected    the call never ran — a refused key,
 *        a rate limit, an overload, a connection that never opened, a
 *        request the provider would not take → `no_answer`, not counted: a
 *        dead key or a dead network must not spend the day.
 */

/** How long one reading may take. The browser waits longer than the server's whole budget, never less. */
export const READ_LEASH_MS = 150_000;
/**
 * The answer's room. The model THINKS inside `max_tokens`; streamed, the
 * clock and not this cap is what stops a long paper (`INTAKE_MAX_TOKENS`).
 */
export const READ_MAX_TOKENS = 32_000;
/** How hard the model thinks before it writes: a transcription a person checks — `INTAKE_EFFORT`'s reason. */
export const READ_EFFORT = 'medium' as const;
/** The stops that cut an answer at a SIZE: the cap, or the context window filling. */
const SIZE_STOPS: ReadonlySet<string> = new Set(['max_tokens', 'model_context_window_exceeded']);

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
  // Cut by CODE POINTS and made well-formed: a bare `.slice` leaves half an
  // emoji, and a lone surrogate in a request is a 400 that would be worded as
  // the FILE's fault (the house's own finding, `intake-ai.ts`).
  const named = [...fileName.replace(/\s+/g, ' ').trim()].slice(0, 120).join('').toWellFormed();
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
  // `.toWellFormed()`: a cell of an .xls is raw UTF-16 and may hold a lone surrogate.
  return [{ type: 'text', text: `Документ — таблица, текстом:\n${file.text}${cut}\n\n${ask}`.toWellFormed() }];
}

/**
 * Read one prepared file. `leashMs` is a parameter for the test alone — the
 * deadline is the rule it proves, and nobody waits 150 seconds to prove it.
 *
 * ONE deadline, and no retry but the person's own. The SDK's retry is not
 * inside any leash: on a 429 or a 529 that carries `retry-after` it sleeps
 * the WHOLE of it — uncapped, deaf to the signal — and only then notices the
 * abort, so a request the provider refused in milliseconds came back as OUR
 * timeout minutes later: counted against the day, cooled, and worded as «the
 * document is too large» (the T1 review, A2; the intake's rule since PR #141).
 * With `maxRetries: 0` a refusal is `no_answer` at once and the person
 * presses again.
 *
 * STREAMED, for the reason every long call is: a non-streamed request holds
 * one idle connection for the whole reading, and whatever sits between the
 * server and the provider may drop it. `finalMessage()` is the same Message
 * a non-streamed call returns.
 */
export async function readTarkibDocument(
  file: PreparedFile,
  opts: { fileName: string; leashMs?: number },
): Promise<ReadResult> {
  const leashMs = opts.leashMs ?? READ_LEASH_MS;
  const client = new Anthropic({ timeout: leashMs, maxRetries: 0 });
  const deadline = AbortSignal.timeout(leashMs);
  const started = Date.now();
  let usage: ModelTokens | undefined;
  try {
    const response = await client.messages
      .stream(
        {
          model: ANALYST_MODEL,
          max_tokens: READ_MAX_TOKENS,
          system: READ_SYSTEM,
          output_config: { effort: READ_EFFORT, format: { type: 'json_schema', schema: ANSWER_SCHEMA } },
          messages: [{ role: 'user', content: readContent(file, opts.fileName) }],
        },
        { signal: deadline },
      )
      .finalMessage();
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
    // too, but the cause — and the cure, fewer pages — are different. The
    // context window filling is the same cut by another name.
    if (response.stop_reason !== null && SIZE_STOPS.has(response.stop_reason)) {
      logger.warn({ ...spent, ms: ms() }, '[tarkib-read] the answer was cut at its size');
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
    // OUR deadline is the only timeout that proves the provider was working.
    // The SDK calls ANY fetch failure whose text says «timed out» a timeout —
    // a connection that never opened (undici's «Connect Timeout Error»), a
    // DNS timeout — and counted as ours, a dead network spent the day's
    // readings and cooled the document with «the paper is too large». And
    // the other way round: a deadline that lands while the answer's BODY is
    // arriving throws a bare abort, which read «never answered» about a call
    // the provider had billed (the T1 review, A1).
    const timedOut = deadline.aborted;
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
    // word. Only for a request that CARRIED a file: a spreadsheet goes as
    // plain text, has no pages and cannot be a broken file — a 400 there is
    // the request's shape or the account (a spend limit answers 400 too), and
    // «upload another file» would be said about every file on that day.
    // Nothing was generated either way.
    if (file.kind !== 'sheet' && (status === 400 || status === 413 || status === 422)) {
      return { ok: false, code: 'ai_rejected', outcome: 'no_answer' };
    }
    return { ok: false, code: 'ai_failed', outcome: 'no_answer' };
  }
}
