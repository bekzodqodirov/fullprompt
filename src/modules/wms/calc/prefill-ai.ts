import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { logger } from '../../platform/logger';
import type { ImportBazaRow } from '../customs/import-baza';

/**
 * The model PICKS A ROW out of the customs file — it never states a price.
 *
 * This is law 1 at its narrowest point. The candidates come from real
 * declarations somebody filed; the model's whole job is to say WHICH of
 * them describes this cargo, by index, or none. The number that reaches the
 * calculation is the file's own, written through 0094's `importRowId` path,
 * so `baza_source` lands on 'import' and never on 'ai' — the fence in
 * `tests/unit/ai-advisory.test.ts` says there is no such value at all.
 *
 * ONE call for the whole request (#432's discipline applied to model calls):
 * a fifty-line invoice must not be fifty round trips on a bot whose poller
 * is sequential.
 */

const picksSchema = z.object({
  picks: z.array(
    z.object({
      row: z.number().int(),
      candidate: z.number().int().nullable(),
      reason: z.string(),
    }),
  ),
});

export interface PickRequest {
  /** The item's display order — how the answer is matched back. */
  seq: number;
  name: string;
  tnvedCode: string;
  candidates: ImportBazaRow[];
}

export interface PickAnswer {
  seq: number;
  /** Index into that row's candidates, or null for «none of these». */
  candidate: number | null;
  reason: string;
}

const SYSTEM = `Ты — помощник декларанта карго-компании GSR LOGISTICS.

Тебе дают товар из заявки клиента и НЕСКОЛЬКО реальных строк из базы
таможенных деклараций с ТЕМ ЖЕ кодом ТН ВЭД. Твоя задача — выбрать ОДНУ
строку, которая описывает тот же товар, или не выбрать ни одной.

Ты НЕ называешь цену и НЕ придумываешь её. Ты выбираешь НОМЕР строки.
Цену возьмёт система из выбранной строки.

Выбирай только если уверен, что это тот же товар: то же назначение, тот же
вид изделия. Похожий код — не повод: под одним кодом лежат десятки разных
товаров. Если ни одна строка не подходит — candidate: null, и декларант
поставит базу сам. Пустой ответ лучше неверного.

reason — одна короткая строка на узбекском: почему выбрал именно её (или
почему ни одной). Это читает человек.`;

/**
 * Ask the model to choose. Returns null when it is not available at all —
 * the caller then leaves those bazas empty, which is the owner's own rule:
 * «agar to'g'ri bo'lmasa baza yo'q deb VED hodimi o'zi qo'yadi».
 */
export async function pickImportRows(
  rows: PickRequest[],
  opts: { timeoutMs?: number } = {},
): Promise<PickAnswer[] | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const asking = rows.filter((r) => r.candidates.length > 0);
  if (asking.length === 0) return [];

  const listing = asking
    .map((r) => {
      const lines = r.candidates
        .map(
          (c, i) =>
            `   [${i}] ${c.name.slice(0, 200)} — $${c.pricePerUnitUsd}/${c.basis}` +
            (c.weightPerUnitKg !== null ? ` · ${c.weightPerUnitKg} kg/dona` : '') +
            (c.unitMatches ? '' : ' (единица не совпадает)'),
        )
        .join('\n');
      return `Строка ${r.seq}: «${r.name}» (код ${r.tnvedCode})\n${lines}`;
    })
    .join('\n\n');

  try {
    // Round 101's law: this is called from the staff bot's sequential
    // poller, so it carries its own deadline. The SDK's default is none.
    const client = new Anthropic({ timeout: opts.timeoutMs ?? 60_000, maxRetries: 1 });
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
              picks: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    row: { type: 'integer', description: 'номер строки заявки' },
                    candidate: { type: ['integer', 'null'], description: 'индекс строки базы' },
                    reason: { type: 'string' },
                  },
                  required: ['row', 'candidate', 'reason'],
                  additionalProperties: false,
                },
              },
            },
            required: ['picks'],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: 'user', content: listing.slice(0, 40_000) }],
    });
    if (response.stop_reason === 'refusal') return null;
    const raw = response.content.find((b) => b.type === 'text')?.text ?? '';
    const parsed = picksSchema.parse(JSON.parse(raw));

    // Every index is checked against the row it claims to answer: an answer
    // about a row nobody asked about, or a candidate that does not exist, is
    // dropped rather than trusted (the model's output is data, not a
    // command).
    const bySeq = new Map(asking.map((r) => [r.seq, r]));
    const out: PickAnswer[] = [];
    for (const p of parsed.picks) {
      const row = bySeq.get(p.row);
      if (!row) continue;
      if (p.candidate === null) {
        out.push({ seq: p.row, candidate: null, reason: p.reason.slice(0, 300) });
        continue;
      }
      if (!Number.isInteger(p.candidate) || p.candidate < 0 || p.candidate >= row.candidates.length) {
        continue;
      }
      out.push({ seq: p.row, candidate: p.candidate, reason: p.reason.slice(0, 300) });
    }
    return out;
  } catch (err) {
    // Never fatal: the bazas stay empty and the VED fills them.
    logger.warn({ err }, 'calc prefill pick failed');
    return null;
  }
}
