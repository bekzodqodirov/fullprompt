import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { logger } from '../../platform/logger';
import type { CalcFacts, CalcSection } from './intake';

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

const factsSchema = z.object({
  from_city: z.string().nullable(),
  to_city: z.string().nullable(),
  weight_kg: z.number().nullable(),
  volume_m3: z.number().nullable(),
  goods: z.array(
    z.object({
      name: z.string(),
      quantity: z.number().nullable(),
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
- список товаров: название, количество, и — если уверенно определяешь — код ТН ВЭД (10 цифр);
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
   * The caller's leash. The bot answers asynchronously and affords the
   * default 60 s; an interactive press (the thread door) cannot hold a
   * person that long and passes ~20 s — past it the manual parser answers.
   */
  timeoutMs?: number;
}): Promise<AiIntakeResult | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const material = input.text.trim();
  const images = input.images ?? [];
  // A collection of nothing but photographs is still a collection: before
  // this round the empty-text guard refused it outright.
  if (!material && images.length === 0) return null;

  try {
    // A deadline of its own, for the same reason round 101 gave the
    // assistant one: the SDK's default is about ten minutes, and this call
    // is made from the staff bot, whose poller is sequential — a hung socket
    // there is a customer bot that answers nobody until it clears.
    const client = new Anthropic({ timeout: input.timeoutMs ?? 60_000, maxRetries: 1 });
    const response = await client.messages.create({
      model: 'claude-opus-5',
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
                    tnved_code: { type: ['string', 'null'] },
                    note: { type: ['string', 'null'] },
                  },
                  required: ['name', 'quantity', 'tnved_code', 'note'],
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
            {
              type: 'text',
              text:
                `Раздел: ${input.section}\n` +
                (input.fileCount ? `Прикреплено файлов: ${input.fileCount}\n` : '') +
                (images.length ? `Фотографий для чтения: ${images.length}\n` : '') +
                (material ? `Материалы:\n${material.slice(0, 20000)}` : 'Текста нет — читай фото.'),
            },
          ],
        },
      ],
    });
    if (response.stop_reason === 'refusal') return null;
    const raw = response.content.find((b) => b.type === 'text')?.text ?? '';
    const parsed = factsSchema.parse(JSON.parse(raw));
    return {
      facts: {
        fromCity: parsed.from_city,
        toCity: parsed.to_city,
        weightKg: parsed.weight_kg,
        volumeM3: parsed.volume_m3,
        goods: parsed.goods.map((g) => ({
          name: g.name,
          quantity: g.quantity,
          // A code that is not ten digits is not a code — blanked rather
          // than passed on, the same rule the goods import uses (#378).
          tnvedCode: g.tnved_code && /^\d{10}$/.test(g.tnved_code) ? g.tnved_code : null,
          note: g.note,
        })),
      },
      steps: parsed.steps.slice(0, 20),
    };
  } catch (err) {
    // Never fatal: the intake goes on with what the person typed.
    logger.warn({ err }, 'calc intake AI failed');
    return null;
  }
}
