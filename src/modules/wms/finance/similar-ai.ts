import Anthropic from '@anthropic-ai/sdk';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import { logger } from '../../platform/logger';
import { aiConfigured, ANALYST_MODEL } from '../../platform/ai/model';
import type { ScopedActor } from '../../platform/rbac/scope';
import { batchEndsInScopeSql } from '../batches/card-door';
import { riderRowsSql } from '../batches/riders';
import { productKeySql } from '../tnved/service';
import { PRICING_CHARGE_TYPES } from './pricing-view';
import { windowStart } from './price-history';

/**
 * «📈 Oldingi narx»'s fallback (owner's 18a: «topa olmasa AI»). A Chinese
 * name written three ways, a Russian one abbreviated — the free search's
 * exact key, TNVED code and trigram all miss, and a person would still say
 * «that is the same thing». The model is asked to say THAT, and nothing else.
 *
 * `pickImportRows`' shape, law 1 at its narrowest: the candidates are REAL
 * past lots with a real price on a real truck; the model answers with INDEXES
 * into them — never a number — every index is checked against the list it
 * claims, and the price is read afterwards from the ledger by the same
 * function the free list uses (`pricedRowsForLots`).
 */

export interface SimilarCandidate {
  /** What the model reads: the goods' names, cut. */
  name: string;
  /** The past lots behind this name — what a pick resolves to. */
  lotIds: string[];
}

export interface SimilarPick {
  index: number;
  reason: string;
}

export interface SimilarUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** How many names the model is shown, and how many it may pick. */
export const SIMILAR_CANDIDATES = 60;
export const SIMILAR_PICKS = 5;

const picksSchema = z.object({
  picks: z.array(z.object({ index: z.number().int(), reason: z.string() })),
});

const SYSTEM = `Ты — помощник бухгалтера карго-компании GSR LOGISTICS.

Тебе дают товар с текущей машины (китайское и русское название) и СПИСОК
реальных товаров, которые компания уже возила. Выбери из списка те, что
являются ТЕМ ЖЕ товаром: то же изделие, то же назначение. Названия могут быть
написаны по-разному, сокращены, на другом языке — это не повод отказать.

Ты НЕ называешь цену и НЕ придумываешь её. Ты выбираешь НОМЕРА строк, не
больше пяти. Цену возьмёт система из учёта. Если ничего не подходит — пустой
список. Пустой ответ лучше неверного: похожая упаковка или тот же материал —
не тот же товар.

reason — одна короткая строка на узбекском: почему это тот же товар.`;

/**
 * The model's choice, validated: indexes in range, each once, five at most.
 * Pure — the tests drive it with a hand-written answer.
 */
export function validPicks(raw: SimilarPick[], candidates: number): SimilarPick[] {
  const seen = new Set<number>();
  const out: SimilarPick[] = [];
  for (const pick of raw) {
    if (!Number.isInteger(pick.index) || pick.index < 0 || pick.index >= candidates) continue;
    if (seen.has(pick.index)) continue;
    seen.add(pick.index);
    out.push({ index: pick.index, reason: String(pick.reason ?? '').slice(0, 300) });
    if (out.length >= SIMILAR_PICKS) break;
  }
  return out;
}

/**
 * Ask the model. Null when it is not available at all or failed — the route
 * then says so in words; an empty list is «none of these», a real answer.
 */
export async function pickSimilarLots(
  needle: { zh: string; ru: string | null },
  candidates: SimilarCandidate[],
  opts: { timeoutMs?: number; onUsage?: (usage: SimilarUsage) => void } = {},
): Promise<SimilarPick[] | null> {
  if (!aiConfigured()) return null;
  if (candidates.length === 0) return [];
  const listing = candidates.map((c, i) => `[${i}] ${c.name}`).join('\n');
  const ask = `Товар: «${needle.zh}»${needle.ru ? ` / «${needle.ru}»` : ''}\n\nСписок:\n${listing}`;
  try {
    // A person is waiting on the button: its own deadline, one retry (#706).
    const client = new Anthropic({ timeout: opts.timeoutMs ?? 60_000, maxRetries: 1 });
    const response = await client.messages.create({
      model: ANALYST_MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              picks: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    index: { type: 'integer', description: 'номер строки списка' },
                    reason: { type: 'string' },
                  },
                  required: ['index', 'reason'],
                  additionalProperties: false,
                },
              },
            },
            required: ['picks'],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: 'user', content: ask.slice(0, 20_000) }],
    });
    opts.onUsage?.({
      model: ANALYST_MODEL,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    });
    if (response.stop_reason === 'refusal') return null;
    const raw = response.content.find((b) => b.type === 'text')?.text ?? '';
    const parsed = picksSchema.parse(JSON.parse(raw));
    return validPicks(parsed.picks, candidates.length);
  } catch (err) {
    logger.warn({ err }, '[similar-ai] pick failed');
    return null;
  }
}

/**
 * What the model may choose from: distinct goods names of past lots that
 * carry a live price on a departed, in-scope truck within twelve
 * months — the free list's own frame, without its match arms — ordered by the
 * closer of the two trigram scores, then newest. Sixty names, cut at 120
 * characters: a declaration paragraph is not a name.
 */
export async function similarCandidates(
  lot: { id: string; zh: string; ru: string | null },
  batchId: string,
  actor: ScopedActor,
): Promise<SimilarCandidate[]> {
  const since = windowStart(13);
  const truckSince = windowStart(12);
  const types = sql.raw(`(${PRICING_CHARGE_TYPES.map((t) => `'${t}'`).join(', ')})`);
  const rows = await db.execute<{ key: string; name: string; lot_ids: string[] }>(sql`
    SELECT ${productKeySql(sql`pl.product_name_zh`)} AS key,
           min(pl.product_name_zh || coalesce(' / ' || pl.product_name_ru, '')) AS name,
           (array_agg(pl.id::text ORDER BY pr.confirmed_at DESC))[1:10] AS lot_ids,
           max(greatest(similarity(pl.product_name_zh, ${lot.zh}),
                        similarity(coalesce(pl.product_name_ru, ''), ${lot.ru ?? ''}))) AS sim,
           max(pr.confirmed_at) AS newest
      FROM receipt_lots pl
      JOIN receipts pr ON pr.id = pl.receipt_id
     WHERE pr.client_id IS NOT NULL AND pr.voided_at IS NULL AND pr.status = 'confirmed'
       AND pr.confirmed_at >= ${since}::timestamptz
       AND pl.id <> ${lot.id}::uuid
       AND EXISTS (
         SELECT 1
           FROM (${riderRowsSql({ boxes: sql`SELECT lb.id FROM boxes lb WHERE lb.lot_id = pl.id` })}) rides
           JOIN batches b ON b.id = rides.batch_id
           JOIN client_transactions c ON c.batch_id = b.id AND c.client_id = pr.client_id
          WHERE b.id <> ${batchId}::uuid AND b.departed_at IS NOT NULL
            AND b.departed_at >= ${truckSince}::timestamptz
            AND ${batchEndsInScopeSql(actor, 'b')}
            AND c.type IN ${types} AND c.voided_at IS NULL
       )
     GROUP BY 1
     ORDER BY sim DESC, newest DESC
     LIMIT ${SIMILAR_CANDIDATES}
  `);
  return rows.map((r) => ({ name: r.name.slice(0, 120), lotIds: r.lot_ids ?? [] }));
}
