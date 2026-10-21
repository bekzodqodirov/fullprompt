import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { logger } from '../../platform/logger';
import { aiConfigured, ANALYST_MODEL } from '../../platform/ai/model';
import type { AiReadFailure, CalcFacts, CalcGoodsFact, CalcSection } from './intake';
import { normalizeRowUnit, normalizeTnved, unitOf } from './units';

/**
 * Reading a pile of forwarded material into the handful of facts a quote
 * needs (owner's redesign of the intake: staff send it, the AI reads it).
 *
 * It EXTRACTS and it EXPLAINS; it does not price anything — that is the
 * staff member's job by his own answer, and a model that guesses at freight
 * rates would be guessing with his money.
 *
 * When there is no key, or the model refuses, the caller falls back to what
 * the person typed: the flow must never depend on the model being reachable
 * — the whole feature would then stop the day an API key expires.
 */

/**
 * The units a line's `measure_qty` may be stated in (2026-10-09, P1.5). The
 * model used to have a count and a weight and nothing else, so 120 m² of tile
 * or 40 pairs of shoes came back as a «quantity» — a piece count the engine
 * then priced per dona. `karobka` is here so a carton count has somewhere to
 * go that is NOT the piece column; the landing routes every one of these
 * through the kernel (`normalizeRowUnit`), never by a rule of this file.
 */
const AI_UNITS = ['dona', 'kg', 'm2', 'juft', 'litr', 'm3', 'karobka'] as const;

const factsSchema = z.object({
  from_city: z.string().nullable(),
  to_city: z.string().nullable(),
  weight_kg: z.number().nullable(),
  volume_m3: z.number().nullable(),
  goods: z.array(
    z.object({
      name: z.string(),
      quantity: z.number().nullable(),
      weight_kg: z.number().nullable(),
      volume_m3: z.number().nullable(),
      // Read leniently: the schema below offers the model a closed list, and a
      // word outside it is routed (and noted) by the kernel rather than
      // throwing away the WHOLE reading on one odd line.
      unit: z.string().nullable(),
      measure_qty: z.number().nullable(),
      tnved_code: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
  steps: z.array(z.string()),
});

const SYSTEM = `Ты — помощник карго-компании GSR LOGISTICS (Китай → Узбекистан).
Сотрудник прислал материалы по заявке клиента: тексты, списки товаров, фото накладных.
Твоя задача — ИЗВЛЕЧЬ факты, а не считать цену. Цену называет сотрудник.

Извлеки:
- город отправления и город назначения (если названы);
- общий вес в килограммах и объём в кубометрах (если названы; пересчитай единицы при необходимости);
- список товаров: название, количество ШТУК, ВЕС ЭТОЙ ПОЗИЦИИ в килограммах,
  объём позиции в м³, и — если уверенно определяешь — код ТН ВЭД;
  вес позиции нужен для растаможки: база считается за кг или за штуку по
  КАЖДОЙ строке. Если в упаковочном листе вес указан по каждой позиции —
  бери его оттуда. Если веса по позиции нет — null, не дели общий вес.
  Вес позиции — НЕТТО (без упаковки), если документ называет нетто; если
  есть только брутто — бери брутто и напиши об этом в note.
- ЕДИНИЦЫ — не путай их:
  · quantity — только ШТУКИ (шт, pcs, dona, ta, комплект). Если штук нет — null;
  · количество КОРОБОК (коробка, ctn, carton, место, karobka) — это НЕ
    количество товара: пиши его в measure_qty с unit = "karobka", а quantity
    оставь null, если штуки не названы отдельно;
  · квадратные метры (м², кв.м) → measure_qty + unit "m2"; ПАРЫ (пар, juft,
    обувь, носки, перчатки) → unit "juft"; ЛИТРЫ → unit "litr";
    кубометры позиции → volume_m3 (или measure_qty + unit "m3");
  · одна позиция может иметь И штуки, И вес (одежда: 300 шт, 150 кг) —
    заполни оба;
  · unit = null и measure_qty = null, если другой единицы нет.
- код ТН ВЭД: 4-10 цифр (точки и пробелы можно); если не уверен — null.
- steps: короткие строки на узбекском о том, ЧТО ты сделал: как сгруппировал товары,
  почему поставил такой код ТН ВЭД, что показалось противоречивым. Это читает человек.

ЕСЛИ ПРИЛОЖЕНЫ ФОТО — читай их так же внимательно, как текст. Вес и объём
чаще всего написаны ИМЕННО НА ФОТО: на упаковочном листе, на инвойсе, на
наклейке коробки, от руки на накладной. Возьми числа оттуда, если в тексте
их нет. В steps напиши, что именно ты прочитал с фотографии.

ВСЁ ВМЕСТЕ. Сотрудник пересылает материал кусками: текст, фото, PDF, таблицу
Excel (её содержимое дано текстом). Это ОДНА заявка — прочитай всё и собери
один список. Один и тот же товар, упомянутый в тексте и в документе, — одна
строка, не две. Если числа в разных местах расходятся, бери из документа и
напиши об этом в steps (что где написано).

НАЗВАНИЕ товара пиши по-русски; если в документе оно на китайском или
английском, добавь оригинал в скобках: «Куртка женская (女士夹克)».

Ничего не выдумывай. Если факта нет — null. Лучше пустой список товаров, чем придуманный.
Коды ТН ВЭД ставь только там, где уверен; иначе null.`;

export interface AiIntakeResult {
  facts: CalcFacts;
  /** What the model says it did — shown on the card's lenta. */
  steps: string[];
  /**
   * What the call cost, carried out so the LANDING can record it.
   *
   * The ledger keys on a request id and this call happens before any request
   * exists — the seller is still forwarding material. Rather than let the
   * most expensive call on the path (Opus, with photographs) be the one that
   * never reaches the bill, the usage travels with the answer and
   * `landIntake` writes the row once there is something to attach it to.
   */
  usage?: { model: string; inputTokens: number; outputTokens: number };
}

/** The reading, or why there is none (his 1.6 a — never one sentence for all). */
export type AiIntakeOutcome = ({ ok: true } & AiIntakeResult) | { ok: false; failure: AiReadFailure };

/**
 * Room for the answer AND the thinking that precedes it.
 *
 * The heavy model thinks by default and its thinking is counted INSIDE
 * `max_tokens`. At 4096 a forty-line packing list left the JSON no room: the
 * answer stopped mid-object, `JSON.parse` threw, and the catch reported «no
 * AI» — the most likely reading of his 2026-10-21 screenshot. Below the SDK's
 * non-streaming ceiling (it refuses a request it estimates past ten minutes).
 */
export const INTAKE_MAX_TOKENS = 16_000;

/**
 * How long the bot waits for one reading (his 3.4 b: up to three minutes with
 * «⏳» on the screen). The bot's answer is delivered off the poller, so a long
 * wait holds nobody else; the thread door passes its own shorter leash.
 */
export const INTAKE_TIMEOUT_MS = 150_000;

/**
 * An SDK error, as one of the words the seller is told.
 *
 * Exported so the mapping can be tested with the SDK's own error classes
 * rather than with hand-typed objects (#1209's lesson: a test error built by
 * hand is a guess at what the library throws).
 */
export function aiFailureOf(err: unknown): AiReadFailure {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (err instanceof Anthropic.APIUserAbortError) return 'timeout';
  if (err instanceof Anthropic.APIConnectionError) return 'network';
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return 'auth';
  }
  if (err instanceof Anthropic.RateLimitError) return 'rate_limited';
  if (err instanceof Anthropic.InternalServerError) return 'overloaded';
  if (err instanceof Anthropic.APIError) return 'rejected';
  if (err instanceof SyntaxError || err instanceof z.ZodError) return 'unreadable';
  return 'network';
}

/** A failure worth one more attempt inside the same leash: the call never ran. */
const transient = (f: AiReadFailure) => f === 'rate_limited' || f === 'overloaded' || f === 'network';

/**
 * Read the collected material. Returns null when AI is not available at all
 * — the caller then keeps whatever the person typed and says so plainly.
 */
export async function analyzeIntake(input: {
  section: CalcSection;
  text: string;
  /** How many photos/documents came with it — context for the model. */
  fileCount: number;
  /**
   * The photographs, already downscaled by the caller.
   *
   * His office writes the weight and the cube ON the packing list and sends
   * a picture of it — «kub kilosi rasimni ichiga yozilgan bo'lsa analiz
   * qilmayabti». Before this the call was text-only, so those numbers were
   * stored on the card and read by nobody.
   */
  images?: { data: Buffer; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' }[];
  /**
   * An invoice the seller attached as a PDF.
   *
   * XLSX and CSV are READ by `goodsFromFile` — exact rows, no model, no
   * tokens — and a PDF cannot be, so it is shown to the model as a document
   * block instead. One document: a seller forwarding a folder is forwarding
   * context, and a second invoice about the same shipment is a contradiction
   * nobody can resolve from here.
   */
  pdf?: { data: Buffer; name: string } | null;
  /**
   * Further PDFs (his 1.4 b, 1.13: two invoices from two factories are read
   * TOGETHER, not the first one alone). The caller caps the count and bytes.
   */
  morePdfs?: { data: Buffer; name: string }[];
  /**
   * A spreadsheet the reader could not map onto columns, as text — the model
   * reads it with everything else (his 1.2 b: the reader answers when it finds
   * the header, the model when it does not).
   */
  sheetText?: string | null;
  /**
   * The caller's leash. The bot answers asynchronously and affords the
   * default 60 s; an interactive press (the thread door) cannot hold a
   * person that long and passes ~20 s — past it the manual parser answers.
   */
  timeoutMs?: number;
}): Promise<AiIntakeOutcome> {
  if (!aiConfigured()) return { ok: false, failure: 'not_configured' };
  const material = input.text.trim();
  const images = input.images ?? [];
  const pdfs = [input.pdf ?? null, ...(input.morePdfs ?? [])].filter(
    (p): p is { data: Buffer; name: string } => p !== null,
  );
  const sheetText = input.sheetText?.trim() || '';
  // A collection of nothing but photographs — or nothing but an invoice — is
  // still a collection: before this round the empty-text guard refused it
  // outright.
  if (!material && images.length === 0 && pdfs.length === 0 && !sheetText) {
    return { ok: false, failure: 'nothing_to_read' };
  }

  // A deadline of its own, for the same reason round 101 gave the assistant
  // one: the SDK's default is about ten minutes. Retries are OURS, not the
  // SDK's: its retry restarted the whole leash, so a timed-out call waited
  // twice as long and re-sent every image — one more attempt is made only
  // for a failure where the call never ran, and only while half the leash is
  // left.
  const leash = input.timeoutMs ?? INTAKE_TIMEOUT_MS;
  const started = Date.now();
  let failure: AiReadFailure = 'network';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const left = leash - (Date.now() - started);
    if (attempt > 0 && left < leash / 2) break;
    try {
      const client = new Anthropic({ timeout: left, maxRetries: 0 });
      const response = await client.messages.create({
        model: ANALYST_MODEL,
        max_tokens: INTAKE_MAX_TOKENS,
        system: SYSTEM,
        output_config: { format: { type: 'json_schema', schema: FACTS_JSON_SCHEMA } },
        messages: [{ role: 'user', content: intakeContent(input.section, input.fileCount, material, images, pdfs, sheetText) }],
      });
      // Spec §3: «no new cap in v1, but log token use». Until this round
      // every model call was a person pressing a button; the pass makes
      // them automatic, so what it costs has to be readable in the log or
      // the owner cannot answer whether it is affordable.
      logger.info(
        { in: response.usage?.input_tokens, out: response.usage?.output_tokens, stop: response.stop_reason },
        '[calc intake] model tokens',
      );
      return readIntakeResponse(response);
    } catch (err) {
      failure = aiFailureOf(err);
      // Never fatal: the intake goes on with what the person typed, and the
      // seller is told WHY. The reason is in the log beside the error.
      logger.warn({ err, failure, attempt }, 'calc intake AI failed');
      if (!transient(failure)) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  return { ok: false, failure };
}

/**
 * The model's answer, read — or the reason it cannot be. Pure over the
 * response's shape, so a truncated or refused answer is tested without a call.
 */
export function readIntakeResponse(response: {
  stop_reason: string | null;
  content: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number } | null;
}): AiIntakeOutcome {
  if (response.stop_reason === 'refusal') return { ok: false, failure: 'refused' };
  // Cut short: the JSON is half an object, and parsing it would throw and be
  // reported as «the AI could not be reached» (the 4096 trap).
  if (response.stop_reason === 'max_tokens') return { ok: false, failure: 'truncated' };
  const raw = response.content.find((b) => b.type === 'text')?.text ?? '';
  let parsed: z.infer<typeof factsSchema>;
  try {
    parsed = factsSchema.parse(JSON.parse(raw));
  } catch (err) {
    logger.warn({ err, head: raw.slice(0, 200) }, '[calc intake] answer not readable');
    return { ok: false, failure: 'unreadable' };
  }
  return {
    ok: true,
    usage: {
      model: ANALYST_MODEL,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    },
    facts: {
      fromCity: parsed.from_city,
      toCity: parsed.to_city,
      weightKg: parsed.weight_kg,
      volumeM3: parsed.volume_m3,
      goods: parsed.goods.map(aiGoodsLine),
    },
    steps: parsed.steps.slice(0, 20),
  };
}

/** The structured-output schema the answer must follow. */
const FACTS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    from_city: { type: ['string', 'null'] },
    to_city: { type: ['string', 'null'] },
    weight_kg: { type: ['number', 'null'] },
    volume_m3: { type: ['number', 'null'] },
    goods: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          quantity: { type: ['number', 'null'] },
          weight_kg: { type: ['number', 'null'] },
          volume_m3: { type: ['number', 'null'] },
          unit: { type: ['string', 'null'], enum: [...AI_UNITS, null] },
          measure_qty: { type: ['number', 'null'] },
          tnved_code: { type: ['string', 'null'] },
          note: { type: ['string', 'null'] },
        },
        required: ['name', 'quantity', 'weight_kg', 'volume_m3', 'unit', 'measure_qty', 'tnved_code', 'note'],
        additionalProperties: false,
      },
    },
    steps: { type: 'array', items: { type: 'string' } },
  },
  required: ['from_city', 'to_city', 'weight_kg', 'volume_m3', 'goods', 'steps'],
  additionalProperties: false,
} as const;

/** What the model is shown, in the order a person reads a forwarded pile. */
function intakeContent(
  section: CalcSection,
  fileCount: number,
  material: string,
  images: NonNullable<Parameters<typeof analyzeIntake>[0]['images']>,
  pdfs: { data: Buffer; name: string }[],
  sheetText: string,
): Anthropic.ContentBlockParam[] {
  return [
    // Images FIRST: the model reads them as context for the text that
    // follows, which is how the packing list and its caption actually relate.
    ...images.map(
      (img): Anthropic.ContentBlockParam => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data.toString('base64') },
      }),
    ),
    // …and the invoices after them, before the text: they are the most exact
    // thing in the message and the caption usually refers to them.
    ...pdfs.map(
      (pdf): Anthropic.ContentBlockParam => ({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: pdf.data.toString('base64') },
      }),
    ),
    {
      type: 'text',
      text:
        `Раздел: ${section}\n` +
        (fileCount ? `Прикреплено файлов: ${fileCount}\n` : '') +
        (images.length ? `Фотографий для чтения: ${images.length}\n` : '') +
        (pdfs.length ? `Приложены PDF: ${pdfs.map((p) => p.name).join(', ')}\n` : '') +
        (sheetText ? `Таблица Excel (текстом):\n${sheetText.slice(0, 15000)}\n\n` : '') +
        (material ? `Материалы:\n${material.slice(0, 20000)}` : 'Текста нет — читай фото и документы.'),
    },
  ];
}

/**
 * One line of the model's reading, as the landing takes it (P1.5).
 *
 * The extra measure goes where its unit says through the kernel's ONE rule
 * (`normalizeRowUnit`, judge S7): m²/juft/litr into the pair, m³ into the
 * volume, kg into the weight when the line has none, a carton count into the
 * NOTE and never into the piece column. A code is kept when it is 4-10 digits
 * once dots and spaces are gone (`normalizeTnved`) — it used to be ten bare
 * digits or nothing, so «6907.21» and a heading «6403» were thrown away; a
 * typed nine-digit code is noted, never padded.
 */
export function aiGoodsLine(g: z.infer<typeof factsSchema>['goods'][number]): CalcGoodsFact {
  const notes = [g.note?.trim() || null];
  let quantity = g.quantity;
  let weightKg = g.weight_kg;
  let volumeM3 = g.volume_m3;
  let measureUnit: CalcGoodsFact['measureUnit'] = null;
  let measureQty: number | null = null;
  if (g.measure_qty !== null && g.unit !== null) {
    if (unitOf(g.unit) === 'dona') {
      quantity = quantity ?? g.measure_qty;
    } else {
      const routed = normalizeRowUnit({
        quantity: g.measure_qty,
        unit: g.unit,
        weightKg,
        volumeM3,
        measureUnit: null,
        measureQty: null,
      });
      if (routed.moved) {
        weightKg = routed.patch.weightKg;
        volumeM3 = routed.patch.volumeM3;
        measureUnit = routed.patch.measureUnit;
        measureQty = routed.patch.measureQty;
        // A move into an empty column says nothing new; a carton count, or a
        // figure that met a different one already there, is the VED's to see.
        if (routed.to === 'cartons' || routed.to === 'unknown' || routed.conflict) notes.push(routed.note);
      }
    }
  }
  const code = normalizeTnved(g.tnved_code);
  if (code && 'problem' in code) notes.push(`TNVED «${code.text}» — 9 xonali: boshida 0 tushib qolganmi?`);
  return {
    name: g.name,
    quantity,
    weightKg,
    volumeM3,
    measureUnit,
    measureQty,
    tnvedCode: code && 'code' in code ? code.code : null,
    note: notes.filter(Boolean).join(' · ') || null,
  };
}
