import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { logger } from '../../platform/logger';
import { aiConfigured, ANALYST_MODEL } from '../../platform/ai/model';
import type { CalcFacts, CalcGoodsFact, CalcSection } from './intake';
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
   * The caller's leash. The bot answers asynchronously and affords the
   * default 60 s; an interactive press (the thread door) cannot hold a
   * person that long and passes ~20 s — past it the manual parser answers.
   */
  timeoutMs?: number;
}): Promise<AiIntakeResult | null> {
  if (!aiConfigured()) return null;
  const material = input.text.trim();
  const images = input.images ?? [];
  const pdf = input.pdf ?? null;
  // A collection of nothing but photographs — or nothing but an invoice — is
  // still a collection: before this round the empty-text guard refused it
  // outright.
  if (!material && images.length === 0 && !pdf) return null;

  try {
    // A deadline of its own, for the same reason round 101 gave the
    // assistant one: the SDK's default is about ten minutes, and this call
    // is made from the staff bot, whose poller is sequential — a hung socket
    // there is a customer bot that answers nobody until it clears.
    const client = new Anthropic({ timeout: input.timeoutMs ?? 60_000, maxRetries: 1 });
    const response = await client.messages.create({
      model: ANALYST_MODEL,
      max_tokens: 4096,
      system: SYSTEM,
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
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
                  required: [
                    'name',
                    'quantity',
                    'weight_kg',
                    'volume_m3',
                    'unit',
                    'measure_qty',
                    'tnved_code',
                    'note',
                  ],
                  additionalProperties: false,
                },
              },
              steps: { type: 'array', items: { type: 'string' } },
            },
            required: ['from_city', 'to_city', 'weight_kg', 'volume_m3', 'goods', 'steps'],
            additionalProperties: false,
          },
        },
      },
      messages: [
        {
          role: 'user',
          content: [
            // Images FIRST: the model reads them as context for the text
            // that follows, which is how the packing list and its caption
            // actually relate.
            ...images.map(
              (img): Anthropic.ContentBlockParam => ({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: img.mediaType,
                  data: img.data.toString('base64'),
                },
              }),
            ),
            // …and the invoice after them, before the text: it is the most
            // exact thing in the message and the caption usually refers to it.
            ...(pdf
              ? [
                  {
                    type: 'document',
                    source: {
                      type: 'base64',
                      media_type: 'application/pdf',
                      data: pdf.data.toString('base64'),
                    },
                  } as Anthropic.ContentBlockParam,
                ]
              : []),
            {
              type: 'text',
              text:
                `Раздел: ${input.section}\n` +
                (input.fileCount ? `Прикреплено файлов: ${input.fileCount}\n` : '') +
                (images.length ? `Фотографий для чтения: ${images.length}\n` : '') +
                (pdf ? `Приложен инвойс PDF: ${pdf.name}\n` : '') +
                (material ? `Материалы:\n${material.slice(0, 20000)}` : 'Текста нет — читай фото.'),
            },
          ],
        },
      ],
    });
    // Spec §3: «no new cap in v1, but log token use». Until this round
    // every model call was a person pressing a button; the pass makes
    // them automatic, so what it costs has to be readable in the log or
    // the owner cannot answer whether it is affordable.
    logger.info(
      { in: response.usage?.input_tokens, out: response.usage?.output_tokens },
      '[calc intake] model tokens',
    );
    if (response.stop_reason === 'refusal') return null;
    const raw = response.content.find((b) => b.type === 'text')?.text ?? '';
    const parsed = factsSchema.parse(JSON.parse(raw));
    return {
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
  } catch (err) {
    // Never fatal: the intake goes on with what the person typed.
    logger.warn({ err }, 'calc intake AI failed');
    return null;
  }
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
