import Anthropic from '@anthropic-ai/sdk';
import { inArray, sql, type SQL } from 'drizzle-orm';
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

/**
 * JS `\s`, spelled out for postgres (0119). Postgres' own `\s` misses NBSP,
 * the BOM, U+202F and the ideographic space U+3000 — which is exactly the
 * space a Chinese name is typed with — so a key built with it agrees with
 * `productKey` on ASCII and silently disagrees on the names this is for.
 */
export const PRODUCT_KEY_WS =
  "U&'[\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]+'";

/**
 * `productKey`'s twin in SQL, over a column or an expression.
 *
 * It must render EXACTLY the expression of `receipt_lots_product_key_idx`, or
 * the planner never reads the index and «Oldingi narx» scans every lot ever
 * received. The order is JS's: collapse every whitespace run to one space,
 * then strip the one space a leading or trailing run became (`trim` then
 * `replace`, restated), then lower — `lower()` follows the database's ctype,
 * which is `C.UTF-8`/`en_US.utf8` on every server this runs on and lowers
 * Cyrillic like JS does (measured beside the test that pins it).
 */
export function productKeySql(col: SQL): SQL {
  return sql`lower(regexp_replace(regexp_replace(${col}, ${sql.raw(PRODUCT_KEY_WS)}, ' ', 'g'), '^ | $', '', 'g'))`;
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

/**
 * Lot tarkibi: a 💡 for a composition LINE on the Bojxona tab — read-only,
 * never auto-filled, never written to the memory (a line's name is a
 * person's Russian and has no memory key of its own). By name: (a) the
 * memory, matched on its key OR on its Russian name, else (b) the newest code
 * a person stated for a line of that name on any lot — so «Мышь» typed on
 * last week's truck is offered on this one (the owner's 4c: almost every
 * truck). Keyed by `productKey(name)`.
 */
export async function tnvedHintsFor(
  names: string[],
): Promise<Map<string, { code: string; from: 'memory' | 'composition' }>> {
  const out = new Map<string, { code: string; from: 'memory' | 'composition' }>();
  const keys = [...new Set(names.map(productKey))].filter(Boolean);
  if (keys.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT k.key,
           (SELECT t.tnved_code FROM tnved_assignments t
             WHERE t.product_key = k.key OR ${productKeySql(sql`t.product_name_ru`)} = k.key
             ORDER BY (t.product_key = k.key) DESC, t.updated_at DESC LIMIT 1) AS memory,
           (SELECT g.tnved_code FROM lot_composition_lines g
              JOIN lot_compositions h ON h.lot_id = g.lot_id
             WHERE g.tnved_code IS NOT NULL AND ${productKeySql(sql`g.name`)} = k.key
             ORDER BY h.updated_at DESC LIMIT 1) AS stated
      FROM (VALUES ${sql.join(
        keys.map((key) => sql`(${key})`),
        sql`, `,
      )}) AS k(key)
  `)) as unknown as { key: string; memory: string | null; stated: string | null }[];
  for (const row of rows) {
    if (row.memory) out.set(row.key, { code: row.memory, from: 'memory' });
    else if (row.stated) out.set(row.key, { code: row.stated, from: 'composition' });
  }
  return out;
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
