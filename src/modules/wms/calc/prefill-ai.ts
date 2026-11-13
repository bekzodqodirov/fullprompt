import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { logger } from '../../platform/logger';
import { aiConfigured, ANALYST_MODEL } from '../../platform/ai/model';
import type { ImportBazaRow } from '../customs/import-baza';
import { answerFacts, listingNote } from '../tnved/service';

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
  /**
   * The row's note — what the reading saw on the picture, what the good is
   * made of and for (docs/AI-SORAYDI.md §3.4 A12, PR-9). The grouping that
   * coded the row reads it; the pick choosing between declarations of that
   * code read the name alone, and «Стул офисный» is a chair of WHAT. Listed as
   * the grouping lists it (`listingNote`). REQUIRED-nullable (#790): a caller
   * that forgot would send a thinner listing in silence.
   */
  note: string | null;
  candidates: ImportBazaRow[];
}

/** What one pick call cost, carried out for the ledger (0096). */
export interface PickUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface PickAnswer {
  seq: number;
  /** Index into that row's candidates, or null for «none of these». */
  candidate: number | null;
  reason: string;
}

/**
 * What one pick call came back with — the answers, and what the call cost.
 *
 * The usage rides BESIDE the answers rather than through a callback (K5):
 * `onUsage` was called without `await`, so no caller could ever make the
 * ledger write finish before the pass returned, and nothing in the toolchain
 * would have said so (an async function is accepted where `void` is expected,
 * and lint has no `no-misused-promises`). The answers' own shape is untouched
 * — law 1's fence (`ai-advisory.test.ts`) asserts exactly its three keys.
 */
export interface PickOutcome {
  /** null = not available, refused, or unreadable; [] = nothing to ask. */
  answers: PickAnswer[] | null;
  /** null = the model never answered (no key, a timeout, a network error). */
  usage: PickUsage | null;
  /**
   * WHY there are no answers, when the call was made and gave none (A12):
   * `cut` — stopped at the size (`max_tokens`), `refused`, `unreadable` — it
   * answered and the answer was not the schema, `no_answer` — a timeout, the
   * network, an HTTP error. A cut answer used to read «baza yo‘q», silently,
   * for rows that had candidates (PR-9); the pass now says the model did not
   * answer them. Absent: the call answered, or was never made — no key,
   * nothing to ask — which nothing needs to be told about.
   */
  failed?: PickFailure;
}

export type PickFailure = 'cut' | 'refused' | 'unreadable' | 'no_answer';

/**
 * The room the pick's answer gets — and the thinking before it, counted
 * INSIDE `max_tokens` (docs/AI-SORAYDI.md §3.4 A12). At 4096 the analyst
 * model's thinking left the JSON no room on a long list: the answer stopped
 * mid-object, `JSON.parse` threw, and the pass printed «baza yo‘q — VED xodimi
 * qo‘yadi» for rows that had declarations to choose from (PR-9) — the trap the
 * reading met and fixed (`INTAKE_MAX_TOKENS`). Not streamed: the call's own
 * deadline bounds the whole answer, as the grouping's does.
 */
export const PICK_MAX_TOKENS = 16_000;

/**
 * How hard the pick thinks — SET, never the model's default (A12): the
 * default moves with the model. Choosing which of a few real declarations
 * describes the good is a judgement the VED re-reads (the reason is on the
 * row), not a derivation; the reading and the grouping think at this level.
 */
export const PICK_EFFORT = 'medium' as const;

/** The stops that cut an answer at a SIZE — no JSON is whole after them. */
const CUT_STOPS: ReadonlySet<string> = new Set<Anthropic.StopReason>(['max_tokens', 'model_context_window_exceeded']);

const SYSTEM = `Ты — помощник декларанта карго-компании GSR LOGISTICS.

Тебе дают товар из заявки клиента и НЕСКОЛЬКО реальных строк из базы
таможенных деклараций с тем же кодом или из той же товарной позиции; у каждой
строки свой код — выбирай строку, чей код подходит товару. Твоя задача —
выбрать ОДНУ строку, которая описывает тот же товар, или не выбрать ни одной.
«прим.» после товара — что о нём известно: материал, назначение, что видно
на фото. Это подсказка, о каком товаре речь.

Ты НЕ называешь цену и НЕ придумываешь её. Ты выбираешь НОМЕР строки.
Цену возьмёт система из выбранной строки.

Выбирай только если уверен, что это тот же товар: то же назначение, тот же
вид изделия. Похожий код — не повод: под одним кодом лежат десятки разных
товаров. Если ни одна строка не подходит — candidate: null, и декларант
поставит базу сам. Пустой ответ лучше неверного.

reason — одна короткая строка на узбекском: почему выбрал именно её (или
почему ни одной). Это читает человек.`;

/**
 * Ask the model to choose. Answers null when it is not available at all —
 * the caller then leaves those bazas empty, which is the owner's own rule:
 * «agar to'g'ri bo'lmasa baza yo'q deb VED hodimi o'zi qo'yadi».
 */
export async function pickImportRows(
  rows: PickRequest[],
  opts: { timeoutMs?: number } = {},
): Promise<PickOutcome> {
  if (!aiConfigured()) return { answers: null, usage: null };
  const asking = rows.filter((r) => r.candidates.length > 0);
  if (asking.length === 0) return { answers: [], usage: null };

  // Set the moment the model has answered, so every exit after that — a
  // refusal, an unparseable answer — still carries what the call cost, as the
  // callback this replaced reported it before any of them.
  let usage: PickUsage | null = null;

  const listing = asking
    .map((r) => {
      const lines = r.candidates
        .map(
          (c, i) =>
            `   [${i}] ${c.name.slice(0, 200)} — $${c.pricePerUnitUsd}/${c.basis}` +
            (c.weightPerUnitKg !== null ? ` · ${c.weightPerUnitKg} kg/dona` : '') +
            (c.unitMatches ? '' : ' (единица не совпадает)') +
            // A heading's list (round 2): each declaration names its OWN code
            // where it differs from the row's, because choosing it chooses
            // that code — and with it the duty law.
            (c.tnvedCode !== r.tnvedCode ? ` (код ${c.tnvedCode})` : ''),
        )
        .join('\n');
      // The row's note, as the grouping that coded it read it (A12).
      const note = listingNote(r.note);
      return `Строка ${r.seq}: «${r.name}» (код ${r.tnvedCode})${note ? ` — ${note}` : ''}\n${lines}`;
    })
    .join('\n\n');

  try {
    // Round 101's law: this is called from the staff bot's sequential
    // poller, so it carries its own deadline. The SDK's default is none.
    const client = new Anthropic({ timeout: opts.timeoutMs ?? 60_000, maxRetries: 1 });
    const response = await client.messages.create({
      model: ANALYST_MODEL,
      max_tokens: PICK_MAX_TOKENS,
      system: SYSTEM,
      output_config: {
        effort: PICK_EFFORT,
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
    // Spec §3: «no new cap in v1, but log token use». Until this round
    // every model call was a person pressing a button; the pass makes
    // them automatic, so what it costs has to be readable in the log or
    // the owner cannot answer whether it is affordable.
    //
    // The line carries the thinking and why the model stopped too (A12), and
    // a refusal's category (`stop_details`): a pick that came back empty is
    // otherwise one shape in the log whatever stopped it.
    const facts = { ...answerFacts(response), rows: asking.length };
    logger.info(facts, '[calc-prefill pick] model tokens');
    // …and told to the caller, which is the one that knows WHICH request to
    // bill — beside the answers (`PickOutcome`), never inside them: the
    // answer's shape is law 1's own fence («seq, candidate, reason» and
    // nothing else) and `ai-advisory.test.ts` asserts exactly those three keys.
    usage = {
      model: ANALYST_MODEL,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    };
    if (response.stop_reason === 'refusal') {
      logger.warn(facts, '[calc-prefill pick] refused');
      return { answers: null, usage, failed: 'refused' };
    }
    // A cut answer is NAMED (A12): half a JSON document, parsed, reads as
    // «unreadable» below — or, before this round, as nothing at all.
    if (response.stop_reason !== null && CUT_STOPS.has(response.stop_reason)) {
      logger.warn(facts, '[calc-prefill pick] answer cut at max_tokens');
      return { answers: null, usage, failed: 'cut' };
    }
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
    return { answers: out, usage };
  } catch (err) {
    // Never fatal: the bazas stay empty and the VED fills them — and the
    // reply says the model did not answer them (A12). An answer that came
    // back and was not the schema is `unreadable`; no answer at all — a
    // timeout, the network, an HTTP error — is `no_answer`.
    logger.warn({ err }, 'calc prefill pick failed');
    return { answers: null, usage, failed: usage ? 'unreadable' : 'no_answer' };
  }
}
