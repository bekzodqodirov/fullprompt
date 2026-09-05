import Anthropic from '@anthropic-ai/sdk';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import { tnvedAssignments } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { aiConfigured, ANALYST_MODEL } from '../../platform/ai/model';

/**
 * ТНВЭД assistant (Phase 1.5, owner's spec): the AI suggests a customs code
 * from the product name (zh/ru) + photo; every CONFIRMED assignment is stored
 * and reused, so the AI is only asked about products the memory has never
 * seen. The VED manager stays the final authority — suggestions are drafts.
 */

/** Normalized lookup key: same product written slightly differently → one row. */
export function productKey(nameZh: string): string {
  return nameZh.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** UZ ТНВЭД codes are 4–10 digits (10 in the declaration). */
export function isValidTnved(code: string): boolean {
  return /^\d{4,10}$/.test(code.trim());
}

export async function tnvedFor(namesZh: string[]) {
  const keys = [...new Set(namesZh.map(productKey))].filter(Boolean);
  if (keys.length === 0) return new Map<string, typeof tnvedAssignments.$inferSelect>();
  const rows = await db
    .select()
    .from(tnvedAssignments)
    .where(inArray(tnvedAssignments.productKey, keys));
  return new Map(rows.map((r) => [r.productKey, r]));
}

export class TnvedError extends Error {
  constructor(public code: 'invalid_code' | 'ai_not_configured' | 'ai_failed') {
    super(code);
  }
}

export async function saveTnved(
  input: { nameZh: string; nameRu: string | null; code: string; source: 'manual' | 'ai'; aiReasoning?: string | null },
  ctx: AuditContext,
): Promise<void> {
  const code = input.code.trim();
  if (!isValidTnved(code)) throw new TnvedError('invalid_code');
  const key = productKey(input.nameZh);
  const [row] = await db
    .insert(tnvedAssignments)
    .values({
      productKey: key,
      productNameZh: input.nameZh.trim(),
      productNameRu: input.nameRu,
      tnvedCode: code,
      source: input.source,
      aiReasoning: input.aiReasoning ?? null,
      assignedBy: ctx.actorId ?? null,
    })
    .onConflictDoUpdate({
      target: tnvedAssignments.productKey,
      set: {
        tnvedCode: code,
        productNameRu: input.nameRu,
        source: input.source,
        aiReasoning: input.aiReasoning ?? null,
        assignedBy: ctx.actorId ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'tnved_assignment',
    entityId: row!.id,
    action: 'update',
    after: { productKey: key, tnvedCode: code, source: input.source },
  });
}

const suggestionSchema = z.object({
  tnved_code: z.string(),
  name_ru: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  reasoning: z.string(),
});
export type TnvedSuggestion = z.infer<typeof suggestionSchema>;

const SYSTEM = `Ты — эксперт по классификации товаров по ТН ВЭД Республики Узбекистан.
По названию товара (китайский/русский) и фотографии определи наиболее подходящий 10-значный код ТН ВЭД.
Правила:
- Код должен быть ЗАЩИТИМЫМ на таможне: он обязан честно соответствовать товару. Среди честно подходящих кодов выбирай оптимальный по ставке пошлины.
- Если по фото и названию возможны несколько принципиально разных классификаций, выбери наиболее вероятную и снизь confidence.
- reasoning: 1-2 коротких предложения на русском — почему именно этот код.
- name_ru: краткое русское торговое название товара.`;

/**
 * Ask the AI for a suggestion. NOT saved — the human confirms first.
 * Photo (jpeg/png/webp bytes) is optional but strongly improves accuracy.
 */
export async function suggestTnved(input: {
  nameZh: string;
  nameRu: string | null;
  photo?: { data: Buffer; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' } | null;
}): Promise<TnvedSuggestion> {
  if (!aiConfigured()) throw new TnvedError('ai_not_configured');
  // The same deadline `proposeGoodsGrouping` twenty lines below already
  // carries, and for the same reason: the SDK's default is no timeout and two
  // retries, so a hung call held a slot in the one Node process for half an
  // hour — round 101's availability defect, in the file that never learned it.
  const client = new Anthropic({ timeout: 60_000, maxRetries: 1 });

  const content: Anthropic.ContentBlockParam[] = [];
  if (input.photo) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: input.photo.mediaType,
        data: input.photo.data.toString('base64'),
      },
    });
  }
  content.push({
    type: 'text',
    text: `Товар: ${input.nameZh}${input.nameRu ? ` (${input.nameRu})` : ''}`,
  });

  try {
    const response = await client.messages.create({
      model: ANALYST_MODEL,
      max_tokens: 2048,
      system: SYSTEM,
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              tnved_code: { type: 'string', description: '10-значный код ТН ВЭД' },
              name_ru: { type: 'string' },
              confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
              reasoning: { type: 'string' },
            },
            required: ['tnved_code', 'name_ru', 'confidence', 'reasoning'],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: 'user', content }],
    });
    if (response.stop_reason === 'refusal') throw new TnvedError('ai_failed');
    const text = response.content.find((b) => b.type === 'text')?.text ?? '';
    const parsed = suggestionSchema.parse(JSON.parse(text));
    if (!isValidTnved(parsed.tnved_code)) throw new TnvedError('ai_failed');
    return parsed;
  } catch (err) {
    if (err instanceof TnvedError) throw err;
    throw new TnvedError('ai_failed');
  }
}

const groupingSchema = z.object({
  groups: z.array(
    z.object({
      tnved_code: z.string(),
      name_ru: z.string(),
      item_indexes: z.array(z.number().int().nonnegative()),
      confidence: z.enum(['high', 'medium', 'low']),
      reasoning: z.string(),
      duty_rate_pct: z.number().nullable(),
    }),
  ),
});
export type TnvedGrouping = z.infer<typeof groupingSchema>;

const GROUPING_SYSTEM = `Ты — эксперт по классификации товаров по ТН ВЭД Республики Узбекистан.
Тебе дают список товаров из инвойса клиента (обычно 20-100 позиций). Сгруппируй их в позиции ТН ВЭД для таможенной декларации.
Правила:
- Каждая группа: один 10-значный код ТН ВЭД + краткое русское торговое название группы (name_ru).
- Код обязан ЗАЩИТИМО соответствовать каждому товару группы. Среди честно подходящих кодов выбирай оптимальный по ставке пошлины. Никогда не объединяй товары под код, которому один из них не соответствует.
- Меньше групп лучше, но честность важнее компактности.
- item_indexes: индексы товаров из входного списка (с нуля). Каждый товар ровно в одной группе.
- duty_rate_pct: ОЦЕНКА ставки импортной пошлины Узбекистана для этого кода в процентах, или null если не уверен. Это черновая подсказка для менеджера, не официальная ставка.
- reasoning: одно короткое предложение на русском.
- Если товар непонятен, дай ему отдельную группу с confidence low.`;

/**
 * DEALS.md answer 6: the assistant proposes the ~50-goods → ~30-lines
 * grouping, the VED manager confirms. NOT saved anywhere — the caller shows
 * it, a human decides. Degrades cleanly: no key (or a refusal) surfaces as a
 * TnvedError and the file simply stays ungrouped for hand work.
 */
/** What one grouping call cost — carried out so the caller can bill it. */
export interface AiUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export async function proposeGoodsGrouping(
  goods: { name: string; quantity: number | null; unit: string | null }[],
): Promise<TnvedGrouping & { usage?: AiUsage }> {
  if (!aiConfigured()) throw new TnvedError('ai_not_configured');
  if (goods.length === 0 || goods.length > 200) throw new TnvedError('ai_failed');
  // Round 97's lesson, which never reached this file: an un-deadlined network
  // call is the failure that looks like a hang rather than an error, and a
  // person is standing in front of this one waiting for a grouping.
  const client = new Anthropic({ timeout: 60_000, maxRetries: 1 });

  const listing = goods
    .map((g, i) => `${i}. ${g.name}${g.quantity ? ` — ${g.quantity} ${g.unit ?? 'шт'}` : ''}`)
    .join('\n');

  try {
    const response = await client.messages.create({
      model: ANALYST_MODEL,
      max_tokens: 8192,
      system: GROUPING_SYSTEM,
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              groups: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    tnved_code: { type: 'string', description: '10-значный код ТН ВЭД' },
                    name_ru: { type: 'string' },
                    item_indexes: { type: 'array', items: { type: 'integer' } },
                    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                    reasoning: { type: 'string' },
                    duty_rate_pct: { type: ['number', 'null'] },
                  },
                  required: [
                    'tnved_code',
                    'name_ru',
                    'item_indexes',
                    'confidence',
                    'reasoning',
                    'duty_rate_pct',
                  ],
                  additionalProperties: false,
                },
              },
            },
            required: ['groups'],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: 'user', content: `Товары:\n${listing}` }],
    });
    if (response.stop_reason === 'refusal') throw new TnvedError('ai_failed');
    const text = response.content.find((b) => b.type === 'text')?.text ?? '';
    const parsed = groupingSchema.parse(JSON.parse(text));
    // A bad code does not sink the other twenty-nine groups: it is blanked
    // and demoted, and the VED manager types the right one in the review.
    const groups = parsed.groups
      .map((g) =>
        isValidTnved(g.tnved_code) ? g : { ...g, tnved_code: '', confidence: 'low' as const },
      )
      .map((g) => ({
        ...g,
        item_indexes: g.item_indexes.filter((i) => i < goods.length),
      }))
      .filter((g) => g.item_indexes.length > 0);
    if (groups.length === 0) throw new TnvedError('ai_failed');
    return {
      groups,
      usage: {
        model: ANALYST_MODEL,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  } catch (err) {
    if (err instanceof TnvedError) throw err;
    throw new TnvedError('ai_failed');
  }
}
