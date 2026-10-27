import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { logger } from '../../platform/logger';
import { aiConfigured, ANALYST_MODEL } from '../../platform/ai/model';
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
- общий вес ОТПРАВКИ — БРУТТО в килограммах (с упаковкой: G.W., gross, брутто,
  毛重) — и общий объём в кубометрах (если названы; пересчитай единицы при
  необходимости). Если документ называет только НЕТТО всей отправки — общий
  вес null: сотрудник спросит брутто. Нетто вместо брутто не подставляй;
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
 * ONE response, read: the reading, or why there is none (his 1.6 a — never
 * one sentence for all).
 *
 * A failure the model was PAID for — cut short, refused, unreadable — carries
 * its `usage` too (round 1, c21; both typed reviewers on #21): dropped, a
 * failed read never reached the day's budget, and a material too long for the
 * answer is exactly the one that costs the most.
 */
export type AiIntakeRead =
  | ({ ok: true } & AiIntakeResult)
  | { ok: false; failure: AiReadFailure; usage?: AiIntakeResult['usage'] };

/**
 * The whole reading (every attempt), as its callers take it — and what it
 * cost: `answered` is the usage of EVERY attempt the model answered, ok or
 * not — refused, cut short, unreadable (his 2.9 c, docs/SAKKIZ-R2.md
 * §8.2.7: a call counts when the model ANSWERED it, whatever was made of the
 * answer). Absent when none was: an attempt with no answer — a timeout, the
 * network, a 4xx/5xx — cost nothing knowable and is not billed, so a dead
 * key never spends the day's cap as «budget». Today at most one per reading:
 * a retry follows only a call that never ran (`retryAfterPause`), and an
 * answered attempt ends the reading. The collector APPENDS these across
 * re-reads and the landing bills each one.
 */
export type AiIntakeOutcome = AiIntakeRead & { answered?: AiUsage[] };

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
export function knownGoodsText(names: readonly string[], budget: number): string {
  const shown: string[] = [];
  let used = 0;
  for (const name of names) {
    const line = `- ${name.slice(0, 120)}`;
    if (used + line.length + 1 > budget) break;
    shown.push(line);
    used += line.length + 1;
  }
  const rest = names.length - shown.length;
  return (
    'Эти товары уже взяты из таблицы Excel — НЕ повторяй их в goods, перечисли только другие:\n' +
    shown.join('\n') +
    (rest > 0 ? `${shown.length > 0 ? '\n' : ''}…и ещё ${rest} строк этой таблицы — их тоже не повторяй.` : '') +
    '\n\n'
  );
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
   * Further PDFs (his 1.4 b, 1.13: two invoices from two factories are read
   * TOGETHER, not the first one alone). The caller caps the count and bytes.
   */
  morePdfs?: { data: Buffer; name: string }[];
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
   * Line names the seller's Excel already lists (round-1 review, c4): the
   * seller said a separate PDF or sheet is ANOTHER factory's goods, so the
   * model's lines are appended to the Excel's — and a model not told what is
   * already there repeats it from the caption. Shown within
   * `KNOWN_GOODS_CHARS`, the rest counted.
   */
  knownGoods?: readonly string[];
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
  const sheets = input.sheets ?? [];
  const contextSheets = input.contextSheets ?? [];
  const hasSheets = [...sheets, ...contextSheets].some((s) => s.text.trim() !== '');
  // A collection of nothing but photographs — or nothing but an invoice — is
  // still a collection: before this round the empty-text guard refused it
  // outright.
  if (!material && images.length === 0 && pdfs.length === 0 && !hasSheets) {
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
  const known = (input.knownGoods ?? []).map((n) => n.trim()).filter(Boolean);
  let failure: AiReadFailure = 'network';
  for (let attempt = 0; attempt < INTAKE_ATTEMPTS; attempt += 1) {
    const left = leash - (Date.now() - started);
    if (attempt > 0 && left < leash / 2) break;
    try {
      const client = new Anthropic({ timeout: left, maxRetries: 0 });
      const response = await client.messages.create({
        model: ANALYST_MODEL,
        max_tokens: INTAKE_MAX_TOKENS,
        system: SYSTEM,
        output_config: { format: { type: 'json_schema', schema: FACTS_JSON_SCHEMA } },
        messages: [
          {
            role: 'user',
            content: intakeContent(input.section, input.fileCount, material, images, pdfs, sheets, contextSheets, known),
          },
        ],
      });
      // Spec §3: «no new cap in v1, but log token use». Until this round
      // every model call was a person pressing a button; the pass makes
      // them automatic, so what it costs has to be readable in the log or
      // the owner cannot answer whether it is affordable.
      logger.info(
        { in: response.usage?.input_tokens, out: response.usage?.output_tokens, stop: response.stop_reason },
        '[calc intake] model tokens',
      );
      // The model ANSWERED this attempt: it is billed whatever is made of
      // the answer — refused, cut, unreadable or read (2.9 c).
      const read = readIntakeResponse(response);
      return read.usage ? { ...read, answered: [read.usage] } : read;
    } catch (err) {
      failure = aiFailureOf(err);
      // Never fatal: the intake goes on with what the person typed, and the
      // seller is told WHY. The reason is in the log beside the error.
      logger.warn({ err, failure, attempt }, 'calc intake AI failed');
      if (!retryAfterPause(failure, attempt, Date.now() - started, leash)) break;
      await new Promise((resolve) => setTimeout(resolve, INTAKE_RETRY_PAUSE_MS));
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
}): AiIntakeRead {
  const usage = {
    model: ANALYST_MODEL,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
  if (response.stop_reason === 'refusal') return { ok: false, failure: 'refused', usage };
  // Cut short: the JSON is half an object, and parsing it would throw and be
  // reported as «the AI could not be reached» (the 4096 trap).
  if (response.stop_reason === 'max_tokens') return { ok: false, failure: 'truncated', usage };
  const raw = response.content.find((b) => b.type === 'text')?.text ?? '';
  let parsed: z.infer<typeof factsSchema>;
  try {
    parsed = factsSchema.parse(JSON.parse(raw));
  } catch (err) {
    logger.warn({ err, head: raw.slice(0, 200) }, '[calc intake] answer not readable');
    return { ok: false, failure: 'unreadable', usage };
  }
  return {
    ok: true,
    usage,
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
    weight_kg: {
      type: ['number', 'null'],
      description: 'Общий вес отправки БРУТТО (с упаковкой), кг. Только нетто в документе — null.',
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
  sheets: readonly IntakeSheetText[],
  contextSheets: readonly IntakeSheetText[],
  known: readonly string[],
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
        // Said, never silent (round-1 review, a17; round-2, C1): a model not
        // told a table stops reads the visible rows as the whole order.
        sheetsPromptText(sheets, contextSheets, SHEET_TEXT_BUDGET) +
        (known.length ? knownGoodsText(known, KNOWN_GOODS_CHARS) : '') +
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
