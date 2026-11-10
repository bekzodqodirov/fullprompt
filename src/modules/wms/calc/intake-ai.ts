import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { logger } from '../../platform/logger';
import { aiConfigured, ANALYST_MODEL } from '../../platform/ai/model';
import { clipUnits } from '../../platform/text/clip';
import { SHEET_TEXT_BUDGET } from '../deals/goods-file';
import type { AiUsage } from '../tnved/service';
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

/**
 * One good of the answer — every key present, nothing defaulted: it is also
 * the test a CUT answer's goods must pass one by one (`salvageCut`), where a
 * key absent is a good the stream did not finish.
 */
const goodSchema = z.object({
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
});

const factsSchema = z.object({
  from_city: z.string().nullable(),
  to_city: z.string().nullable(),
  weight_kg: z.number().nullable(),
  // Read leniently (absent = not said): an answer from before this field, or a
  // stand-in that omits it, still parses — and «not said» is the brutto label.
  weight_netto: z.boolean().nullish(),
  volume_m3: z.number().nullable(),
  goods: z.array(goodSchema),
  steps: z.array(z.string()),
  // Read leniently and entry by entry (`knownCodesOf`): an answer from before
  // this field, or one bad entry, must never cost the WHOLE reading — the
  // codes are a proposal, the goods and totals are the reading.
  known_codes: z.array(z.unknown()).nullish(),
});

const SYSTEM = `Ты — помощник карго-компании GSR LOGISTICS (Китай → Узбекистан).
Сотрудник прислал материалы по заявке клиента: тексты, списки товаров, фото накладных.
Твоя задача — ИЗВЛЕЧЬ факты, а не считать цену. Цену называет сотрудник.

Извлеки:
- город отправления и город назначения (если названы);
- общий вес ОТПРАВКИ — БРУТТО в килограммах (с упаковкой: G.W., gross, брутто,
  毛重) — и общий объём в кубометрах (если названы; пересчитай единицы при
  необходимости). Если документ называет только НЕТТО всей отправки — как
  поступить, сказано в строке «Только нетто:» под разделом заявки;
- список товаров: название, количество ШТУК, ВЕС ЭТОЙ ПОЗИЦИИ в килограммах,
  объём ВСЕЙ позиции в м³ (все её коробки — TOTAL CBM, никогда не объём одной
  коробки CBM/CTN; если дан только объём одной коробки — null, не умножай),
  и — если уверенно определяешь — код ТН ВЭД;
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
Коды ТН ВЭД ставь только там, где уверен; иначе null.

known_codes — только если ниже дан ПРОНУМЕРОВАННЫЙ список «уже взятых» товаров:
коды ТН ВЭД строк этого списка, где ты уверен (n — номер строки в списке,
tnved_code — код). Сами эти строки в goods не повторяй. Нет такого списка или
не уверен — пустой массив.`;

/**
 * A code the model proposed for a row of the «already taken» list, by the
 * row's INDEX into the `knownGoods` the caller passed (docs/IKKI-ESHIK.md
 * §3.1) — re-checked by `knownCodesOf`: a number the model was not shown, or
 * a code that is not one, is dropped. The caller then checks that the row at
 * that index is still the row that was shown.
 */
export interface KnownCode {
  index: number;
  code: string;
}

export interface AiIntakeResult {
  facts: CalcFacts;
  /** What the model says it did — shown on the card's lenta. */
  steps: string[];
  /** The model's codes for the Excel's rows (`codeKnown`); absent = none. */
  knownCodes?: KnownCode[];
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
 * A reading the model did not finish (docs/FAYL-OQISH.md §3.3), kept for the
 * goods it DID complete: `goods` is how many, `why` what stopped it — the
 * clock (an abort at the leash), the size (`max_tokens`), or a stream that
 * dropped mid-answer. A cut is never whole, so the AI door draws no
 * «✅ Tasdiqlash» over it (§1.1 b).
 */
export interface AiReadingCut {
  goods: number;
  why: 'clock' | 'size' | 'dropped';
}

/**
 * ONE response, read: the reading, or why there is none (his 1.6 a — never
 * one sentence for all).
 *
 * A failure the model was PAID for — cut short, refused, unreadable — carries
 * its `usage` too (round 1, c21; both typed reviewers on #21): dropped, a
 * failed read never reached the day's budget, and a material too long for the
 * answer is exactly the one that costs the most.
 */
export type AiIntakeRead =
  | ({ ok: true; cut?: AiReadingCut } & AiIntakeResult)
  | { ok: false; failure: AiReadFailure; usage?: AiIntakeResult['usage'] };

/**
 * The whole reading (every attempt), as its callers take it — and what it
 * cost: `answered` is the usage of EVERY attempt the model answered, ok or
 * not — refused, cut short, unreadable (his 2.9 c, docs/SAKKIZ-R2.md
 * §8.2.7: a call counts when the model ANSWERED it, whatever was made of the
 * answer). Absent when none was: an attempt with no answer — a timeout, the
 * network, a 4xx/5xx — cost nothing knowable and is not billed, so a dead
 * key never spends the day's cap as «budget». At most two per reading: a
 * retry follows a call that never ran (`retryAfterPause`), or an answer cut
 * at the cap while the rows' codes were asked, which is read once more
 * without them (review PF-ADV-13) — both answers billed; any other answered
 * attempt ends the reading. The collector APPENDS these across re-reads and
 * the landing bills each one.
 */
export type AiIntakeOutcome = AiIntakeRead & {
  answered?: AnsweredUsage[];
  /**
   * The PDFs (attachment ids) the API refused (docs/FAYL-OQISH.md §3.4): the
   * request was refused WITH them and read again without them. Absent = none.
   */
  unreadPdfs?: string[];
};

/**
 * One answered attempt's bill, and WHEN the model answered it (judge
 * concurrency-11): the collector bills its readings only at the landing, and
 * the day's budget is counted by the ledger row's time — so a reading at 23:58
 * that landed at 00:03 counted against the next day. The landing writes this
 * instant as the row's own.
 */
export type AnsweredUsage = AiUsage & { at: number };

/**
 * Room for the answer AND the thinking that precedes it.
 *
 * The heavy model thinks by default and its thinking is counted INSIDE
 * `max_tokens`. At 4096 a forty-line packing list left the JSON no room: the
 * answer stopped mid-object, `JSON.parse` threw, and the catch reported «no
 * AI» — the most likely reading of his 2026-10-21 screenshot. 32 000 since the
 * call is streamed (docs/FAYL-OQISH.md §3.2): the clock, not this cap, is what
 * stops a long invoice, and a cut keeps the goods it completed (§3.3).
 */
export const INTAKE_MAX_TOKENS = 32_000;

/**
 * How hard the model thinks before it writes (docs/FAYL-OQISH.md §3.1). The
 * reading is a transcription plus a code PROPOSAL a person confirms and the
 * landing pass codes again; at the default (`high`) the thinking spent the
 * 150 s leash a long invoice needed for its rows (zero-06, pdfimg-10).
 * Measured nowhere here — the container has no key; the log line (§3.5)
 * carries `thinking`, so its effect is read off production.
 */
export const INTAKE_EFFORT = 'medium' as const;

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
  // A streamed answer's own `event: error` has no HTTP status — the stream
  // throws `new APIError(undefined, body, …, type)` (core/streaming.ts) — so
  // only its `type` says what it is (docs/FAYL-OQISH.md §3.3, judge
  // model-midstream-errors): an overload mid-answer read as «rejected» told
  // the seller «fayllarni boshqacha yuboring» about the server's load.
  if (err instanceof Anthropic.APIError && err.status === undefined) {
    if (err.type === 'overloaded_error' || err.type === 'api_error') return 'overloaded';
    if (err.type === 'rate_limit_error') return 'rate_limited';
    return 'rejected';
  }
  if (err instanceof Anthropic.APIError) return 'rejected';
  if (err instanceof SyntaxError || err instanceof z.ZodError) return 'unreadable';
  // A socket that dropped mid-body is a bare `AnthropicError('terminated')`
  // (undici's word) — no response class at all: the connection's, said so.
  if (err instanceof Anthropic.AnthropicError) return 'network';
  return 'network';
}

/** A failure worth one more attempt inside the same leash: the call never ran. */
const transient = (f: AiReadFailure) => f === 'rate_limited' || f === 'overloaded' || f === 'network';

/** Two attempts at most, and this long between them. */
export const INTAKE_ATTEMPTS = 2;
export const INTAKE_RETRY_PAUSE_MS = 2_000;

/**
 * Is another attempt worth the pause, decided BEFORE pausing (round-1 review,
 * a19)? The pause used to run after every transient failure — the LAST one
 * too, so every failed reading cost two seconds of nothing, and a failure
 * near the end of the leash slept past it (measured: a 10 s leash answered
 * at 12 s, the chat door's 20 s at 22 s). One more attempt only when there
 * is one, and only when half the leash is still left once the pause is over
 * — which also bounds the whole reading by the leash. Pure, so the rule is a
 * test rather than a stopwatch.
 */
export function retryAfterPause(failure: AiReadFailure, attempt: number, elapsedMs: number, leashMs: number): boolean {
  if (!transient(failure)) return false;
  if (attempt + 1 >= INTAKE_ATTEMPTS) return false;
  return leashMs - elapsedMs - INTAKE_RETRY_PAUSE_MS >= leashMs / 2;
}

/**
 * Spreadsheet text as the model is shown it: whole LINES while they fit in
 * `cap` characters, and a count of what was kept (round-1 review, a17).
 *
 * The text was cut with `slice(0, 15000)`: in the middle of a row, with
 * nothing said to the model or the seller — a 300-line header-less packing
 * list came back as 229 goods, the half row as a broken one, and the job
 * landed short with no word anywhere. A row is kept whole or not at all; the
 * model is told the table was cut (`sheetsPromptText`), and the bot tells the
 * seller when the file ARRIVES, with the same function over the same texts.
 *
 * Per text, in order, so a caller can name what one file loses: `kept[i]` of
 * `total[i]` lines of `texts[i]`, and `parts[i]` is those lines — so a goods
 * file and a workbook's other sheets can be shown under their own headings
 * while sharing ONE budget (round-2 review, C2). Once a line does not fit
 * nothing after it is taken — a later line read without the ones above it is
 * a row without its table.
 */
export function fitSheetTexts(
  texts: readonly string[],
  cap: number,
): { text: string; kept: number[]; total: number[]; parts: string[] } {
  const out: string[] = [];
  const kept: number[] = [];
  const total: number[] = [];
  const parts: string[] = [];
  let used = 0;
  let full = false;
  for (const text of texts) {
    const lines = text.split('\n');
    total.push(lines.length);
    let n = 0;
    let part = '';
    if (!full) {
      // The blank line between two texts costs what it is.
      const gap = out.length > 0 ? 2 : 0;
      const taken: string[] = [];
      let size = gap;
      for (const line of lines) {
        const cost = (taken.length > 0 ? 1 : 0) + line.length;
        if (used + size + cost > cap) {
          full = true;
          break;
        }
        taken.push(line);
        size += cost;
      }
      if (taken.length > 0) {
        part = taken.join('\n');
        out.push(part);
        used += size;
      }
      n = taken.length;
    }
    kept.push(n);
    parts.push(part);
  }
  return { text: out.join('\n\n'), kept, total, parts };
}

/**
 * A spreadsheet's text as the collector holds it: what the reader handed
 * over, and the reader's two words about what it left out.
 *
 *  - `cut` — ROWS are missing: the reader stopped before the file's end — its
 *    `textCut` (round-2 review, C1/C4/C5). The reader caps every file at its
 *    own budget and says so; the fit above only ever sees what is left, so ONE
 *    oversized file passed it whole and reached the model with no «обрезана»
 *    note, and the seller heard only «AI o'qiydi». The model then took the
 *    visible rows for the whole order.
 *  - `cellsCut` — every row is there, but a long cell (or a too-long row's
 *    tail) was shortened — the reader's `cellsCut` (round-3 review, R3-C2/
 *    R3-S6). One flag for both told the seller «faqat boshini o'qiydi» and the
 *    model «не считай итоги» about a table it had in FULL, because one Chinese
 *    description ran past 300 characters — and the totals it could see
 *    were the very figures the job needed.
 */
export interface IntakeSheetText {
  text: string;
  cut: boolean;
  cellsCut: boolean;
}

/**
 * The ROWS a sheet text holds (round-3 review, R3-C2): its lines without the
 * blank lines between sheets and without a sheet's «[name]» heading — the
 * reader writes `[name]` as the first line of each sheet, after a blank line.
 * «kept 21» for a 20-row CSV was the «[CSV]» line counted as a row, to the
 * seller («birinchi 21 qator») and to the model alike. Pure.
 */
export function sheetRowCount(text: string): number {
  const lines = text.split('\n');
  let rows = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const heading = (i === 0 || !lines[i - 1]!.trim()) && /^\[[^\]\n]*\]$/.test(line.trim());
    if (!heading) rows += 1;
  }
  return rows;
}

/**
 * `fitSheetTexts` counted in ROWS (`sheetRowCount`): how many rows of each
 * text the model is shown, of how many it has. What the collector tells the
 * seller when a file ARRIVES, so the count is the one the model's note uses.
 */
export function fitSheetRows(
  texts: readonly string[],
  cap: number,
): { kept: number[]; total: number[] } {
  const fit = fitSheetTexts(texts, cap);
  return { kept: fit.parts.map(sheetRowCount), total: texts.map(sheetRowCount) };
}

/**
 * How the spreadsheets are shown to the model — pure, so the headings and the
 * notes are a test (round-2 review, C1/C2).
 *
 * Two kinds under ONE budget, in this order (the order `receiveSheetText`
 * measures the seller's warning by):
 *  - `goods` — separate files whose LINES the model is asked for (a sheet with
 *    no header the reader knows);
 *  - `context` — the other sheets of a workbook whose goods the reader already
 *    took exactly («Packing list» beside «Invoice»). They list the SAME goods,
 *    so they stand under their own heading, for the totals only: joined into
 *    the goods block, with the seller's «boshqa zavod» answer, the model
 *    re-listed the workbook's own lines and a 150-line Excel landed 201
 *    (round-2 review, C2/C6).
 *
 * A text cut by the reader (`cut`) or by this budget carries the note right
 * under it, counted in ROWS (`sheetRowCount` — never the «[name]» heading);
 * a text that did not fit at all is said too, never dropped. A text whose
 * rows are all there and only some cells were shortened (`cellsCut`) says
 * exactly that — and nothing about totals, because the totals it shows are
 * the file's (round-3 review, R3-C2).
 */
export function sheetsPromptText(
  goods: readonly IntakeSheetText[],
  context: readonly IntakeSheetText[],
  cap: number,
): string {
  const all = [...goods, ...context].map((s) => ({ text: s.text.trim(), cut: s.cut, cellsCut: s.cellsCut }));
  const fit = fitSheetTexts(all.map((s) => s.text), cap);
  const block = (from: number, to: number): string => {
    const out: string[] = [];
    for (let i = from; i < to; i += 1) {
      const sheet = all[i]!;
      if (!sheet.text) continue;
      const kept = sheetRowCount(fit.parts[i] ?? '');
      const total = sheetRowCount(sheet.text);
      // A text of headings and no row has nothing to show or to miss.
      if (total === 0) continue;
      if (kept === 0) {
        out.push('[Ещё одна таблица не поместилась — ты её не видишь. Напиши в steps, что она не прочитана.]');
        continue;
      }
      const fitCut = kept < total;
      out.push(
        (fit.parts[i] ?? '') +
          (fitCut || sheet.cut
            ? `\n[Таблица обрезана: показаны первые ${kept}${sheet.cut ? '' : ` из ${total}`} строк` +
              (sheet.cut ? ', файл длиннее' : '') +
              '. Остальные строки ты не видишь — не считай итоги по видимой части и напиши в steps, что таблица прочитана не целиком.]'
            : sheet.cellsCut
              ? '\n[Длинные ячейки сокращены, все строки показаны.]'
              : ''),
      );
    }
    return out.join('\n\n');
  };
  const goodsText = block(0, goods.length);
  const contextText = block(goods.length, all.length);
  return (
    (goodsText ? `Таблица Excel (текстом):\n${goodsText}\n\n` : '') +
    (contextText
      ? 'Другие листы книги, товары из которой уже взяты в список, — только для итогов (общий вес/объём). ' +
        `Товары отсюда НЕ перечисляй в goods:\n${contextText}\n\n`
      : '')
  );
}

/**
 * The most characters the «already taken» names may cost the prompt (round-2
 * review, C2). It was the first 100 NAMES: the 101st line of a 150-line Excel
 * went unmentioned, so the model was not even told the list went on. A
 * budget of characters, and a count of the rest.
 */
export const KNOWN_GOODS_CHARS = 6_000;

/**
 * «These are already taken — do not repeat them»: whole names while they fit
 * `budget`, then how many more there are. One of two fences, and neither is
 * whole: `pickGoods` drops a model line whose whole name an Excel line is, or
 * whose original in brackets is one AND whose figures agree with it (round-3
 * review, R3-C1 — another factory's same-named line is kept, and what was
 * dropped is named to the seller); a line the model renamed with no trace of
 * the Excel's words gets past it, and only this list tells the model not to
 * write one (round-2 review, C2: the old comment called the name check «the
 * fence whatever the model does», and a translated name walked through).
 */
export function knownGoodsText(
  names: readonly string[],
  budget: number,
  /** Whose names: the invoice's (an Excel) or the REQUEST's own rows (the add door, §9.4). */
  source: 'invoice' | 'request' = 'invoice',
  /**
   * Numbered, and the model asked for the rows' codes by number (the AI door,
   * docs/IKKI-ESHIK.md §3.1) — the invoice's list only. `ask` says which rows
   * are asked (absent = every one): a row with a code of its own is listed and
   * not numbered.
   */
  opts: { numbered?: boolean; ask?: (index: number) => boolean } = {},
): string {
  const numbered = opts.numbered === true && source === 'invoice';
  const { lines: shown } = knownGoodsLines(names, budget, numbered ? (opts.ask ?? (() => true)) : null);
  const rest = names.length - shown.length;
  const request = source === 'request';
  return (
    (request
      ? // The exception is the add door's conflict path (law-money-5): a
        // top-up restating a stored good with ITS OWN figures («Kurtka 200»
        // against a stored 300) must come back with them, or the bot never
        // asks «qo‘shilsin / o‘rniga / VED hal qilsin» and factory B's 200
        // vanishes; `sameGoodsLine` then matches it to its row, so it is never
        // priced as a second line. Without figures it is the same row — left out.
        'Эти товары уже есть в заявке — НЕ повторяй их в goods, перечисли только новые. Исключение: если в материале у такого товара СВОИ цифры (количество, вес или объём), укажи его в goods с этими цифрами из материала — не придумывай их:\n'
      : numbered
        ? 'Эти товары уже взяты из таблицы Excel — НЕ повторяй их в goods, перечисли только другие. ' +
          'Для строки этого списка, чей код ТН ВЭД ты уверенно определяешь, укажи его в known_codes ' +
          '(n — номер строки, tnved_code — код); не уверен — не указывай:\n'
        : 'Эти товары уже взяты из таблицы Excel — НЕ повторяй их в goods, перечисли только другие:\n') +
    shown.join('\n') +
    (rest > 0
      ? `${shown.length > 0 ? '\n' : ''}…и ещё ${rest} строк ${request ? 'этой заявки — для них то же правило.' : 'этой таблицы — их тоже не повторяй.'}`
      : '') +
    '\n\n'
  );
}

/**
 * At most this many rows are asked for a code in one reading (review
 * PF-ADV-13): the codes are output inside the same `INTAKE_MAX_TOKENS` as the
 * reading's thinking, and an answer cut at the cap costs the WHOLE reading —
 * the totals, the extra goods, the steps — for a proposal the coding step
 * does without. The rows past it are coded by the memory and the book.
 */
export const KNOWN_CODES_MAX = 40;

/**
 * The name lines `knownGoodsText` shows — whole lines while they fit
 * `budget` — and, when the codes are asked for (`ask`), which of them are
 * numbered: from 1, each row `ask` accepts, up to `KNOWN_CODES_MAX`; the rest
 * are listed with a dash. ONE fit, so the numbers the model answers by are the
 * numbers it was shown; `asked` holds each number's position in `names`.
 */
function knownGoodsLines(
  names: readonly string[],
  budget: number,
  ask: ((index: number) => boolean) | null,
): { lines: string[]; asked: number[] } {
  const lines: string[] = [];
  const asked: number[] = [];
  let used = 0;
  for (const [i, name] of names.entries()) {
    const numberIt = ask !== null && asked.length < KNOWN_CODES_MAX && ask(i);
    // Cut by UTF-16 units and never inside an emoji (apireq-1): a lone half
    // in the request body is a 400 for the whole reading.
    const line = numberIt ? `${asked.length + 1}. ${clipUnits(name, 120)}` : `- ${clipUnits(name, 120)}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    if (numberIt) asked.push(i);
    used += line.length + 1;
  }
  return { lines, asked };
}

/** What the Excel's names may cost after the request's own rows (the two lists share one budget). */
function knownBudgetAfter(request: readonly string[]): { requestText: string; knownBudget: number } {
  const requestText = request.length ? knownGoodsText(request, KNOWN_GOODS_CHARS, 'request') : '';
  return { requestText, knownBudget: Math.max(0, KNOWN_GOODS_CHARS - requestText.length) };
}

/**
 * The model's `known_codes`, re-checked (docs/IKKI-ESHIK.md §3.1 — the
 * `pickImportRows` idiom: the model's output is data, not a command). `shown`
 * maps each number the model was SHOWN (1-based) to the caller's index; a
 * number outside it — a row past `KNOWN_GOODS_CHARS`, a row that does not
 * exist — is dropped, and so is a code that is not 4-10 digits (a typed
 * nine-digit one included: nobody can say which zero fell off). A row given
 * two different codes is no answer at all. Pure.
 */
export function knownCodesOf(raw: unknown, shown: readonly number[]): KnownCode[] {
  if (!Array.isArray(raw)) return [];
  const byIndex = new Map<number, string | null>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const n = (entry as { n?: unknown }).n;
    const text = (entry as { tnved_code?: unknown }).tnved_code;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > shown.length) continue;
    if (typeof text !== 'string') continue;
    const code = normalizeTnved(text);
    if (!code || !('code' in code)) continue;
    const index = shown[n - 1]!;
    const before = byIndex.get(index);
    byIndex.set(index, before === undefined || before === code.code ? code.code : null);
  }
  return [...byIndex].flatMap(([index, code]) => (code ? [{ index, code }] : []));
}

/**
 * What a cut answer COMPLETED (docs/FAYL-OQISH.md §3.3, judge
 * model-salvage-scanner) — pure, over the text the stream delivered.
 *
 * A hand tokenizer, never the SDK's `partialParse` nor MessageStream's partial
 * snapshot: both keep the trailing half-object, number and all — a cut after
 * `"weight_kg":15` of «150» was a good weighing 15 with the rest of its keys
 * absent, priced per kg. Here a string is tracked with its escapes, so a «}»
 * inside «Куртка {женская}» or a `\"` closes nothing; a good is kept only once
 * its own closing «}» is reached at the array's depth, and is then re-checked
 * by the per-good schema with every key present and nothing defaulted. A
 * number counts as ended only when a character follows it. The totals are
 * kept when their value closed BEFORE the goods array opened (the schema's
 * order puts them first); `steps` only when its whole array closed; the
 * codes never (they come last — a cut drops them, and the landing pass codes
 * the rows).
 */
export function salvageCut(text: string): {
  totals: Partial<Pick<z.infer<typeof factsSchema>, keyof typeof TOTALS>>;
  goods: z.infer<typeof goodSchema>[];
  steps: string[];
} {
  const out: ReturnType<typeof salvageCut> = { totals: {}, goods: [], steps: [] };
  let i = skipWs(text, 0);
  if (text[i] !== '{') return out;
  i += 1;
  let goodsOpened = false;
  for (;;) {
    i = skipWs(text, i);
    // A closing «}» (a whole answer) or the cut: either way nothing more.
    if (text[i] !== '"') return out;
    const keyEnd = stringEnd(text, i);
    if (keyEnd === null) return out;
    const key = jsonOf(text.slice(i, keyEnd));
    i = skipWs(text, keyEnd);
    if (text[i] !== ':') return out;
    i = skipWs(text, i + 1);
    if (key === 'goods') {
      goodsOpened = true;
      if (text[i] !== '[') return out;
      i += 1;
      for (;;) {
        i = skipWs(text, i);
        if (text[i] === ']') {
          i += 1;
          break;
        }
        const end = valueEnd(text, i);
        if (end === null) return out;
        if (text[i] === '{') {
          const good = goodSchema.safeParse(jsonOf(text.slice(i, end)));
          if (good.success) out.goods.push(good.data);
        }
        i = skipWs(text, end);
        if (text[i] === ',') i += 1;
        else if (text[i] !== ']') return out;
      }
    } else {
      const end = valueEnd(text, i);
      if (end === null) return out;
      const value = jsonOf(text.slice(i, end));
      if (!goodsOpened && typeof key === 'string' && key in TOTALS) {
        const total = TOTALS[key as keyof typeof TOTALS].safeParse(value);
        if (total.success) (out.totals as Record<string, unknown>)[key] = total.data;
      }
      if (key === 'steps') {
        const steps = z.array(z.string()).safeParse(value);
        if (steps.success) out.steps = steps.data;
      }
      i = end;
    }
    i = skipWs(text, i);
    if (text[i] !== ',') return out;
    i += 1;
  }
}

/** The totals a cut answer may keep, each checked as the whole answer's schema checks it. */
const TOTALS = {
  from_city: z.string().nullable(),
  to_city: z.string().nullable(),
  weight_kg: z.number().nullable(),
  weight_netto: z.boolean().nullable(),
  volume_m3: z.number().nullable(),
} as const;

const skipWs = (t: string, i: number): number => {
  let j = i;
  while (j < t.length && (t[j] === ' ' || t[j] === '\n' || t[j] === '\r' || t[j] === '\t')) j += 1;
  return j;
};

/** Where the string opening at `i` ends (past its quote), or null when the text stops inside it. */
function stringEnd(t: string, i: number): number | null {
  for (let j = i + 1; j < t.length; j += 1) {
    if (t[j] === '\\') {
      j += 1;
      continue;
    }
    if (t[j] === '"') return j + 1;
  }
  return null;
}

/** Where the JSON value opening at `i` ends, or null when the text stops inside it. */
function valueEnd(t: string, i: number): number | null {
  const c = t[i];
  if (c === undefined) return null;
  if (c === '"') return stringEnd(t, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    for (let j = i; j < t.length; j += 1) {
      const d = t[j];
      if (d === '"') {
        const e = stringEnd(t, j);
        if (e === null) return null;
        j = e - 1;
      } else if (d === '{' || d === '[') depth += 1;
      else if (d === '}' || d === ']') {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
    }
    return null;
  }
  // A number or a literal: only a following character proves it ended.
  let j = i;
  while (j < t.length && /[-+0-9.eEa-z]/.test(t[j]!)) j += 1;
  return j > i && j < t.length ? j : null;
}

/** A complete span, parsed — or nothing, never a throw (a malformed one is simply not kept). */
function jsonOf(span: string): unknown {
  try {
    return JSON.parse(span) as unknown;
  } catch {
    return undefined;
  }
}

/** What one attempt cost, as far as the stream said it. */
interface AttemptUsage {
  inputTokens: number;
  outputTokens: number;
  /** The model's thinking tokens, from the raw `message_delta` — null when none arrived. */
  thinking: number | null;
  /** `outputTokens` is the characters' estimate, not the API's count (no `message_delta` arrived). */
  estimated: boolean;
}

/**
 * One streamed attempt, as it ended:
 *  - `answered` — the stream finished with a message (any stop reason);
 *  - `cut` — it ended AFTER `message_start`, with text in hand: the caller's
 *    clock aborted it (`clock`), or a mid-stream `event: error` or a dropped
 *    socket ended it (`dropped`) — the model was paid for what it wrote;
 *  - `failed` — it ended before the model began: a refusal of the request, a
 *    connection that never answered — billed nothing, as before.
 */
type Attempt =
  | { kind: 'answered'; message: Anthropic.Message; usage: AttemptUsage; stop: string | null; ms: number }
  | { kind: 'cut'; why: 'clock' | 'dropped'; err: unknown; text: string; usage: AttemptUsage; ms: number }
  | { kind: 'failed'; err: unknown; ms: number };

/**
 * One call, STREAMED, under the caller's leash (docs/FAYL-OQISH.md §3.2, judge
 * model-leash-unbounded). The client's `timeout` bounds the connection and the
 * response headers only: for a stream the SDK clears it once fetch() resolves,
 * on the headers, so the BODY had no deadline at all — measured, a stand-in
 * dripping for 4 s past a 1.5 s timeout ran to its end. The clock is an
 * `AbortController` this function aborts at `leftMs`, and `stream.abort()`
 * runs on every exit, so nothing outlives the attempt.
 *
 * What the model wrote is accumulated off the raw events, beside the SDK's own
 * accumulator: on an abort there is no final message, and the usage the final
 * message would carry (`output_tokens_details` included, which the SDK's
 * accumulator drops — judge model-thinking-null) only ever arrives in
 * `message_delta`.
 */
async function streamAttempt(content: Anthropic.ContentBlockParam[], leftMs: number): Promise<Attempt> {
  const began = Date.now();
  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(), Math.max(0, leftMs));
  let stream: { abort(): void } | null = null;
  let inputTokens: number | null = null;
  let delta: { in: number | null; out: number; thinking: number | null; stop: string | null } | null = null;
  let textIndex: number | null = null;
  let text = '';
  let chars = 0;
  const usage = (): AttemptUsage => ({
    inputTokens: delta?.in ?? inputTokens ?? 0,
    // No `message_delta` arrived (an abort, a drop): every streamed character
    // of the answer AND the thinking, at three to a token — an ESTIMATE, so
    // the attempt is billed and the day's cap counts it, never a nothing.
    outputTokens: delta?.out ?? Math.ceil(chars / 3),
    thinking: delta?.thinking ?? null,
    estimated: delta === null,
  });
  try {
    const client = new Anthropic({ timeout: Math.max(1, leftMs), maxRetries: 0 });
    const live = client.messages.stream(
      {
        model: ANALYST_MODEL,
        max_tokens: INTAKE_MAX_TOKENS,
        system: SYSTEM,
        output_config: { effort: INTAKE_EFFORT, format: { type: 'json_schema', schema: FACTS_JSON_SCHEMA } },
        messages: [{ role: 'user', content }],
      },
      { signal: clock.signal },
    );
    stream = live;
    live.on('streamEvent', (event: Anthropic.RawMessageStreamEvent) => {
      switch (event.type) {
        case 'message_start':
          inputTokens = event.message.usage.input_tokens ?? 0;
          break;
        case 'content_block_start':
          if (event.content_block.type === 'text' && textIndex === null) textIndex = event.index;
          break;
        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            chars += event.delta.text.length;
            if (event.index === textIndex) text += event.delta.text;
          } else if (event.delta.type === 'thinking_delta') chars += event.delta.thinking.length;
          break;
        case 'message_delta':
          delta = {
            in: event.usage.input_tokens ?? null,
            out: event.usage.output_tokens,
            thinking: event.usage.output_tokens_details?.thinking_tokens ?? null,
            stop: event.delta.stop_reason,
          };
          break;
        default:
          break;
      }
    });
    const message = await live.finalMessage();
    const stop = (delta as { stop: string | null } | null)?.stop ?? message.stop_reason;
    return { kind: 'answered', message, usage: usage(), stop, ms: Date.now() - began };
  } catch (err) {
    const ms = Date.now() - began;
    if (inputTokens === null) return { kind: 'failed', err, ms };
    return { kind: 'cut', why: clock.signal.aborted ? 'clock' : 'dropped', err, text, usage: usage(), ms };
  } finally {
    clearTimeout(timer);
    stream?.abort();
  }
}

/**
 * Read the collected material. Never throws: no key, no answer, a refusal —
 * each is a named failure, and the caller keeps whatever the person typed and
 * says why.
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
   * block instead. `attachmentId` names it in `unreadPdfs` when the API
   * refuses it (docs/FAYL-OQISH.md §3.4).
   */
  pdf?: IntakePdf | null;
  /**
   * Further PDFs (his 1.4 b, 1.13: two invoices from two factories are read
   * TOGETHER, not the first one alone). The caller caps the count and bytes.
   */
  morePdfs?: IntakePdf[];
  /**
   * Spreadsheets the reader could not map onto columns, as text — the model
   * reads them with everything else and lists their goods (his 1.2 b: the
   * reader answers when it finds the header, the model when it does not).
   */
  sheets?: readonly IntakeSheetText[];
  /**
   * The OTHER sheets of workbooks whose goods the reader already took — shown
   * for the shipment's totals under their own heading, never as goods
   * (round-2 review, C2/C6).
   */
  contextSheets?: readonly IntakeSheetText[];
  /**
   * The mapped goods sheet's OWN rows as text (a packing-shaped list keeps
   * them, `GoodsFileMeta.text`) — shown under the totals heading only while
   * its rows' codes are asked, so the model codes a row from its specs and
   * not its name alone (docs/FAYL-OQISH.md §3.7, sheets-04 (3)). Never
   * something to read by itself: a lone Excel with every row coded makes no
   * call.
   */
  goodsSheetText?: IntakeSheetText | null;
  /**
   * Line names the seller's Excel already lists (round-1 review, c4): the
   * seller said a separate PDF or sheet is ANOTHER factory's goods, so the
   * model's lines are appended to the Excel's — and a model not told what is
   * already there repeats it from the caption. Shown within
   * `KNOWN_GOODS_CHARS`, the rest counted.
   */
  knownGoods?: readonly string[];
  /**
   * Ask the model for the `knownGoods` rows' codes too (the AI door,
   * docs/IKKI-ESHIK.md §3.1): the list is shown numbered, and the answer's
   * `known_codes` come back by index into `knownGoods`. A row asked is
   * something to read by itself (docs/FAYL-OQISH.md §3.7): a lone Excel on
   * the AI door is coded by the model, not met with «nothing to read».
   */
  codeKnown?: boolean;
  /**
   * Which `knownGoods` rows already carry a code of their own (by index):
   * listed, never asked — their code is the row's, and asking it only spends
   * the answer's tokens (review PF-ADV-13). Absent = none.
   */
  knownCoded?: readonly boolean[];
  /**
   * The rows already on the REQUEST, by name (the add door, docs/SAKKIZ-R3.md
   * §9.4): a top-up's reading must list only NEW goods, or a stored row read
   * again is priced twice. Printed before the Excel's names, inside the same
   * `KNOWN_GOODS_CHARS` budget.
   */
  requestGoods?: readonly string[];
  /**
   * Keep what a CUT answer completed (docs/FAYL-OQISH.md §3.3, §3.6) —
   * REQUIRED, so every caller chooses (judge model-thread-door-cut): the bot
   * carries a cut as `aiCut` and draws no «✅ Tasdiqlash» over it; the thread
   * door's preview has no word for a partial list, so it passes false and a
   * cut stays the «timeout» / «truncated» it always was.
   */
  salvage: boolean;
  /**
   * The caller's leash. The bot answers asynchronously and affords
   * `INTAKE_TIMEOUT_MS`; an interactive press (the thread door) cannot hold a
   * person that long and passes ~20 s — past it the manual parser answers.
   */
  timeoutMs?: number;
}): Promise<AiIntakeOutcome> {
  if (!aiConfigured()) return { ok: false, failure: 'not_configured' };
  const material = input.text.trim();
  const images = input.images ?? [];
  let pdfs = [input.pdf ?? null, ...(input.morePdfs ?? [])].filter((p): p is IntakePdf => p !== null);
  const sheets = input.sheets ?? [];
  const contextSheets = input.contextSheets ?? [];
  const hasSheets = [...sheets, ...contextSheets].some((s) => s.text.trim() !== '');
  // Each shown name keeps its index into the caller's list, so a code the
  // model gives by NUMBER lands on the row that number was shown for. Built
  // ABOVE the guard (docs/FAYL-OQISH.md §3.7, known-3): a row whose code is
  // asked is material too — the AI door's commonest order is a lone Excel
  // with no caption, and the guard used to answer it «nothing to read»
  // without ever counting this list.
  const knownList = (input.knownGoods ?? []).map((name, index) => ({ index, name: name.trim() })).filter((k) => k.name);
  const known = knownList.map((k) => k.name);
  const requestNames = (input.requestGoods ?? []).map((n) => n.trim()).filter(Boolean);
  // Asked: a shown row with no code of its own, by its index into the
  // caller's list (`knownCoded`).
  const ask = (i: number) => input.knownCoded?.[knownList[i]!.index] !== true;
  const codesAsked = input.codeKnown === true && knownList.some((_, i) => ask(i));
  // A collection of nothing but photographs — or nothing but an invoice — is
  // still a collection: before this round the empty-text guard refused it
  // outright.
  if (!material && images.length === 0 && pdfs.length === 0 && !hasSheets && !codesAsked) {
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
  let numbered = input.codeKnown === true && known.length > 0;
  let shown = numbered
    ? knownGoodsLines(known, knownBudgetAfter(requestNames).knownBudget, ask).asked.map((i) => knownList[i]!.index)
    : [];
  // What else is there besides the numbered list — a codes-free re-read of a
  // list that WAS the only material would read nothing at all.
  const otherMaterial = () => Boolean(material) || images.length > 0 || pdfs.length > 0 || hasSheets;
  // What every answered attempt cost — a cut answer retried is two (2.9 c).
  let answered: AnsweredUsage[] = [];
  let failure: AiReadFailure = 'network';
  // PDFs the API refused (§3.4): read once more without them, and named.
  let unreadPdfs: string[] = [];
  let pdfsDropped = false;
  const withUnread = <T extends AiIntakeOutcome>(out: T): T =>
    unreadPdfs.length > 0 ? { ...out, unreadPdfs } : out;
  const withBill = <T extends AiIntakeRead>(out: T): T & { answered?: AnsweredUsage[] } =>
    answered.length > 0 ? { ...out, answered } : out;
  const counts = () => ({
    images: images.length,
    pdfs: pdfs.length,
    sheets: sheets.filter((s) => s.text.trim()).length + contextSheets.filter((s) => s.text.trim()).length,
    known: shown.length,
  });
  // The attempts that count against `INTAKE_ATTEMPTS`; the PDF-less re-read
  // after a refusal is not one of them (a 400 is instant and never billed).
  let counted = 0;
  while (counted < INTAKE_ATTEMPTS) {
    const attempt = counted;
    const left = leash - (Date.now() - started);
    if (attempt > 0 && left < leash / 2) break;
    counted += 1;
    const coding = numbered && shown.length > 0 && input.goodsSheetText?.text.trim() ? [input.goodsSheetText] : [];
    const content = intakeContent(
      input.section,
      input.fileCount,
      material,
      images,
      pdfs,
      sheets,
      [...contextSheets, ...coding],
      known,
      requestNames,
      numbered ? ask : null,
    );
    const run = await streamAttempt(content, left);
    if (run.kind === 'failed') {
      failure = aiFailureOf(run.err);
      // Never fatal: the intake goes on with what the person typed, and the
      // seller is told WHY. The reason is in the log beside the error.
      logger.warn({ err: run.err, failure, attempt, ms: run.ms, ...counts() }, 'calc intake AI failed');
      // A request REFUSED with documents in it is read once more without
      // them (docs/FAYL-OQISH.md §3.4, pdfimg-9 a+b): one bad PDF used to sink
      // the photos' and the text's reading with it, and every re-read after.
      // The PDFs are named unread (`unreadPdfs`) and later readings skip them.
      if (failure === 'rejected' && pdfs.length > 0 && !pdfsDropped) {
        pdfsDropped = true;
        unreadPdfs = pdfs.flatMap((p) => (p.attachmentId ? [p.attachmentId] : []));
        pdfs = [];
        if (!otherMaterial() && !codesAsked) break;
        counted -= 1;
        continue;
      }
      // Refused WITHOUT them as well: the PDFs were not the cause, and are
      // not named for it.
      if (failure === 'rejected' && pdfsDropped) unreadPdfs = [];
      if (!retryAfterPause(failure, attempt, Date.now() - started, leash)) break;
      await new Promise((resolve) => setTimeout(resolve, INTAKE_RETRY_PAUSE_MS));
      continue;
    }
    // The model ANSWERED this attempt — or began to: it is billed whatever is
    // made of the answer (2.9 c), a cut by what the stream said it cost
    // (docs/FAYL-OQISH.md §3.3, judge model-cut-unbilled).
    const bill: AnsweredUsage = {
      model: ANALYST_MODEL,
      inputTokens: run.usage.inputTokens,
      outputTokens: run.usage.outputTokens,
      at: Date.now(),
    };
    answered = [...answered, bill];
    // Spec §3: «no new cap in v1, but log token use» — read off the RAW
    // `message_delta` (docs/FAYL-OQISH.md §3.5): the thinking share is what
    // the effort change moves, and the SDK's final message drops it.
    logger.info(
      {
        in: run.usage.inputTokens,
        out: run.usage.outputTokens,
        thinking: run.usage.thinking,
        stop: run.kind === 'answered' ? run.stop : run.why === 'clock' ? 'aborted' : 'dropped',
        ms: run.ms,
        cut: run.kind === 'cut' || run.stop === 'max_tokens',
        ...(run.kind === 'cut' ? { textChars: run.text.length, estimated: run.usage.estimated } : {}),
        ...counts(),
      },
      '[calc intake] model tokens',
    );
    if (run.kind === 'answered') {
      const read = readIntakeResponse(run.message, shown);
      if (read.ok) return withUnread(withBill(read));
      if (read.failure === 'truncated') {
        // Cut at the size (`max_tokens`): what it completed is the reading.
        const kept = input.salvage ? keptOf(textOf(run.message), 'size') : null;
        if (kept) return withUnread(withBill(kept));
        // An answer cut at the cap WHILE the codes were asked, with no good
        // completed, is read once more without them (review PF-ADV-13): the
        // codes are a proposal the coding step does without, the reading is
        // not.
        if (numbered && counted < INTAKE_ATTEMPTS && otherMaterial()) {
          logger.warn({ shown: shown.length }, '[calc intake] answer cut with the codes asked — read again without them');
          numbered = false;
          shown = [];
          failure = 'truncated';
          continue;
        }
      }
      return withUnread(withBill(read));
    }
    // Cut by the clock or a dropped stream, after the model began.
    const kept = input.salvage ? keptOf(run.text, run.why) : null;
    if (kept) return withUnread(withBill(kept));
    failure = run.why === 'clock' ? 'timeout' : aiFailureOf(run.err);
    logger.warn({ err: run.err, failure, attempt, ms: run.ms, ...counts() }, 'calc intake AI failed');
    if (run.why === 'clock' || !retryAfterPause(failure, attempt, Date.now() - started, leash)) break;
    await new Promise((resolve) => setTimeout(resolve, INTAKE_RETRY_PAUSE_MS));
  }
  // The clock ran out between attempts: what stopped the reading is time.
  return withUnread(answered.length > 0 ? { ok: false, failure, answered } : { ok: false, failure });
}

/** One PDF the model is shown, and the attachment that names it if the API refuses it. */
export interface IntakePdf {
  data: Buffer;
  name: string;
  attachmentId?: string;
}

/** The answer's text block — what the schema's JSON is written in. */
const textOf = (message: { content: { type: string; text?: string }[] }): string =>
  message.content.find((b) => b.type === 'text')?.text ?? '';

/**
 * A cut answer as a reading — null when it completed no good (then it stays
 * the failure it was, and a drop or an overload may be read again). Its codes
 * are dropped (`known_codes` is the schema's last property, and a cut
 * finishes no list it began): the landing pass codes the rows.
 */
function keptOf(text: string, why: AiReadingCut['why']): ({ ok: true; cut: AiReadingCut } & AiIntakeResult) | null {
  const cut = salvageCut(text);
  if (cut.goods.length === 0) return null;
  return {
    ok: true,
    cut: { goods: cut.goods.length, why },
    facts: factsOf({ ...cut.totals, goods: cut.goods }),
    steps: cut.steps.slice(0, 20),
  };
}

/**
 * The model's answer, read — or the reason it cannot be. Pure over the
 * response's shape, so a truncated or refused answer is tested without a call.
 */
export function readIntakeResponse(
  response: {
    stop_reason: string | null;
    content: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number } | null;
  },
  /** The numbers the «already taken» list was shown with (`knownCodesOf`); none = no codes asked. */
  shown: readonly number[] = [],
): AiIntakeRead {
  const usage = {
    model: ANALYST_MODEL,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
  if (response.stop_reason === 'refusal') return { ok: false, failure: 'refused', usage };
  // Cut short: the JSON is half an object, and parsing it would throw and be
  // reported as «the AI could not be reached» (the 4096 trap).
  if (response.stop_reason === 'max_tokens') return { ok: false, failure: 'truncated', usage };
  const raw = textOf(response);
  let parsed: z.infer<typeof factsSchema>;
  try {
    parsed = factsSchema.parse(JSON.parse(raw));
  } catch (err) {
    logger.warn({ err, head: raw.slice(0, 200) }, '[calc intake] answer not readable');
    return { ok: false, failure: 'unreadable', usage };
  }
  const knownCodes = knownCodesOf(parsed.known_codes ?? [], shown);
  return {
    ok: true,
    usage,
    facts: factsOf(parsed),
    steps: parsed.steps.slice(0, 20),
    ...(knownCodes.length > 0 ? { knownCodes } : {}),
  };
}

/** A whole answer's facts — or what a cut one completed of them (`salvageCut`). */
function factsOf(p: Partial<Pick<z.infer<typeof factsSchema>, keyof typeof TOTALS>> & { goods: z.infer<typeof goodSchema>[] }): CalcFacts {
  return {
    fromCity: p.from_city ?? null,
    toCity: p.to_city ?? null,
    weightKg: p.weight_kg ?? null,
    volumeM3: p.volume_m3 ?? null,
    // Only a figure that IS there can be netto (review PF-3).
    ...(p.weight_netto === true && p.weight_kg != null ? { weightNetto: true } : {}),
    goods: p.goods.map(aiGoodsLine),
  };
}

/** The structured-output schema the answer must follow. */
const FACTS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    from_city: { type: ['string', 'null'] },
    to_city: { type: ['string', 'null'] },
    weight_kg: {
      type: ['number', 'null'],
      description: 'Общий вес отправки БРУТТО (с упаковкой), кг. Только нетто в документе — см. строку «Только нетто:».',
    },
    weight_netto: {
      type: ['boolean', 'null'],
      description: 'true — общий вес выше это НЕТТО (документ называет только нетто); иначе false.',
    },
    volume_m3: { type: ['number', 'null'], description: 'Общий объём отправки, м³.' },
    goods: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          quantity: { type: ['number', 'null'] },
          weight_kg: { type: ['number', 'null'], description: 'Вес ЭТОЙ позиции, кг (нетто, если назван).' },
          volume_m3: {
            type: ['number', 'null'],
            description: 'Объём ВСЕЙ позиции (все коробки), м³. Дан только объём одной коробки — null.',
          },
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
    known_codes: {
      type: 'array',
      description: 'Коды ТН ВЭД строк пронумерованного списка «уже взятых» товаров, по номеру строки; нет списка — пустой массив.',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer', description: 'номер строки в списке' },
          tnved_code: { type: 'string' },
        },
        required: ['n', 'tnved_code'],
        additionalProperties: false,
      },
    },
  },
  required: ['from_city', 'to_city', 'weight_kg', 'weight_netto', 'volume_m3', 'goods', 'steps', 'known_codes'],
  additionalProperties: false,
} as const;

/**
 * What a document stating only the NETTO of the whole shipment becomes —
 * per section, because only the freight sections must have the BRUTTO (the
 * table's ⚠️ brutto row, `totalsMissing` in intake.ts; R2's retired
 * `totalsQuestion`, review P3-R3). There the netto must not pass for it: the
 * truck is priced on what it carries with the packaging, so null, and the
 * table asks. Customs prices the lines, so a null there landed every
 * netto-only invoice with no weight at all — a chip asking for ever, and a
 * single line's derived weight with no source.
 * There the netto stands as the total, and the reading SAYS it is netto,
 * on the lenta the VED reads — and in `weight_netto` (review PF-3), so the
 * single line's copied weight, the summary and the Telegram line call it
 * netto too, never the «brutto» the lone copy's note used to claim.
 */
const NETTO_ONLY: Record<CalcSection, string> = {
  yolkira: 'Только нетто: общий вес null — сотрудник спросит брутто. Нетто вместо брутто не подставляй.',
  podklyuch: 'Только нетто: общий вес null — сотрудник спросит брутто. Нетто вместо брутто не подставляй.',
  rastamojka:
    'Только нетто: возьми нетто как общий вес, поставь weight_netto = true и напиши в steps: «Umumiy og‘irlik faqat netto — bruttosi hujjatda yo‘q».',
};

/**
 * What the model is shown, in the order a person reads a forwarded pile. The
 * two name lists share one budget: the request's own rows first (the add
 * door), the Excel's in what is left.
 */
function intakeContent(
  section: CalcSection,
  fileCount: number,
  material: string,
  images: NonNullable<Parameters<typeof analyzeIntake>[0]['images']>,
  pdfs: { data: Buffer; name: string }[],
  sheets: readonly IntakeSheetText[],
  contextSheets: readonly IntakeSheetText[],
  known: readonly string[],
  request: readonly string[] = [],
  /** The codes asked (numbered), and of which rows — null = none asked. */
  ask: ((index: number) => boolean) | null = null,
): Anthropic.ContentBlockParam[] {
  const { requestText, knownBudget } = knownBudgetAfter(request);
  const sheetsText = sheetsPromptText(sheets, contextSheets, SHEET_TEXT_BUDGET);
  // The closing line is chosen by what was SENT (xlsxN-14, docs/FAYL-OQISH.md
  // §3.7): «read the photos and documents» to a model shown neither
  // contradicted its own input — and to the AI door's lone Excel, whose only
  // material is the numbered list, it was no instruction at all.
  const closing = material
    ? `Материалы:\n${clipUnits(material, 20000)}`
    : images.length > 0 || pdfs.length > 0
      ? 'Текста нет — читай фото и документы.'
      : sheetsText
        ? 'Текста нет — читай таблицу выше.'
        : ask
          ? 'Других материалов нет: goods оставь пустым, дай только known_codes для строк списка.'
          : 'Текста нет.';
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
      // `.toWellFormed()` — the one fence at the request boundary (apireq-1):
      // a lone surrogate from any cut, or inside a file's own text, is a 400
      // that sinks every image and PDF with it.
      text: (
        `Раздел: ${section}\n` +
        `${NETTO_ONLY[section]}\n` +
        // What it was SHOWN (pdfimg-12): the attached count includes files
        // refused at arrival or not loaded, which the model never sees.
        (fileCount ? `Прикреплено файлов: ${fileCount}; из них тебе показано: ${images.length} фото, ${pdfs.length} PDF\n` : '') +
        (!fileCount && images.length ? `Фотографий для чтения: ${images.length}\n` : '') +
        (pdfs.length ? `Приложены PDF: ${pdfs.map((p) => p.name).join(', ')}\n` : '') +
        // Said, never silent (round-1 review, a17; round-2, C1): a model not
        // told a table stops reads the visible rows as the whole order.
        sheetsText +
        requestText +
        (known.length ? knownGoodsText(known, knownBudget, 'invoice', ask ? { numbered: true, ask } : {}) : '') +
        closing
      ).toWellFormed(),
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
export function aiGoodsLine(g: z.infer<typeof goodSchema>): CalcGoodsFact {
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
