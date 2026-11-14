import { normalizeDigits, unreadNumeral } from './digits';
import { extractNumbers, placedLedger, type NumberSource, type TravelMode } from './numbers';
import { QUOTED_MIN_FIGURE, withoutQuotedHan } from './policy';

/**
 * The auto layer's MONEY facts that are read off the reply itself (spec
 * SPEC-P1-v2 §1.1, §1.8) — pure, so the gate's facts at the scheduling and at
 * the press are the same function of the same stored evidence.
 *
 * His Q1 (⭐ as told to him): the AI states the truck's yo'lkira from the table
 * and the avia price his rate × the kilos by itself — and nothing else that is
 * money. These helpers say whether the money in a reply is that and only that;
 * the gate (`auto-gate.ts`) judges.
 */

/** The two tools whose answer is a PRICE the auto layer may send (§1.1) — never `own_balance`. */
export const ESTIMATE_TOOLS = ['yolkira_estimate', 'avia_estimate'] as const;
export type EstimateTool = (typeof ESTIMATE_TOOLS)[number];

export function isEstimateTool(name: string | null | undefined): name is EstimateTool {
  return (ESTIMATE_TOOLS as readonly string[]).includes(name ?? '');
}

/**
 * One priced estimate call of the run, as the draft's memory keeps it
 * (`memory.estimates`, §1.3) — what the press and the send step re-price with
 * the same function, and what «the reply names the load it priced» is judged
 * against. `m3` and `zone` are null for the flight; `unit` is what the rate is
 * per. Written by the run (§1.3's `memoryFor`); a draft with an estimate and
 * none stored was written before it and is refused (`money`, §1.1).
 */
export interface StoredEstimate {
  tool: EstimateTool;
  kg: number;
  m3: number | null;
  zone: string | null;
  /** The Tashkent day the figure was priced for, YYYY-MM-DD. */
  day: string;
  total: number;
  rate: number;
  unit: 'kg' | 'm3';
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** Where a sentence ends — never a dot between two digits («1.5 kub»). */
const SENTENCE_END = /[!?؟。！？\n]|(?<!\d)\.|\.(?!\d)/gu;

function sentenceSpan(text: string, at: number): [number, number] {
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(SENTENCE_END)) {
    const i = m.index ?? 0;
    if (i < at) start = i + m[0].length;
    else {
      end = i;
      break;
    }
  }
  return [start, end];
}

/**
 * Does the reply quote a price WITHOUT the load it priced (`estimate_unnamed`,
 * §1.1)? Every money line an estimate tool vouched for must sit in a sentence
 * that also carries that call's kilos — and, for the truck, its cubes. In a
 * chat that talks of two loads and priced one, «Yukingiz taxminan 800 $» reads
 * as the price of everything; restated with «5 kub, 800 kg uchun» it cannot.
 *
 * A money line that matches no stored estimate's total or rate is unnamed too:
 * nothing says which load it is. With no stored estimates the question is not
 * asked here — the gate refuses such a draft `money` on its own (§1.1).
 */
export function estimateUnnamed(
  body: string,
  memory: { sources: readonly NumberSource[]; estimates?: readonly StoredEstimate[] | null; askedMode?: TravelMode | null },
): boolean {
  const estimates = memory.estimates ?? [];
  if (estimates.length === 0) return false;
  const text = normalizeDigits(body);
  const found = extractNumbers(body);
  for (const line of placedLedger(body, memory.sources, [], memory.askedMode ?? null)) {
    if (line.kind !== 'money' || line.origin !== 'tool' || !isEstimateTool(line.tool)) continue;
    const figure = found.find((f) => f.index === line.index);
    if (!figure) return true;
    const own = estimates.filter((e) => e.tool === line.tool && (near(e.total, figure.value) || near(e.rate, figure.value)));
    const [from, to] = sentenceSpan(text, line.index);
    const beside = found.filter((f) => f.index >= from && f.index < to && f.index !== line.index && f.kind !== 'money');
    const has = (v: number) => beside.some((f) => near(f.value, v));
    const named = own.some((e) => has(e.kg) && (e.tool === 'avia_estimate' || (e.m3 !== null && has(e.m3))));
    if (!named) return true;
  }
  return false;
}

/**
 * «…to Tashkent» — the table is China → Tashkent (§1.8): an estimate reply
 * says where its price takes the cargo, in the customer's language and
 * script. Anywhere in the reply.
 */
const TO_TASHKENT = [
  /(?<![\p{L}])toshkent(?:\s+shahri)?(?:ga|gacha)(?![\p{L}])/iu,
  /(?<![\p{L}])тошкент(?:\s+шаҳри)?(?:га|гача)(?![\p{L}])/iu,
  /(?<![\p{L}])(?:до|в)\s+(?:г\.\s*|города\s+)?ташкент(?:а)?(?![\p{L}])/iu,
  /(?<![\p{L}])to\s+tashkent(?![\p{L}])/iu,
  /(?:到|至|运到|运往|送到)塔什干/u,
  /(?:تا|به)\s*تاشکند/u,
];

export function saysTashkent(body: string): boolean {
  const text = normalizeDigits(body);
  return TO_TASHKENT.some((re) => re.test(text));
}

/**
 * Does the reply hold a numeral no reader here reads reliably — a Chinese numeral run (`numeral_unread`, the 0148
 * fix)? Asked of the reply less the Chinese its facts hold verbatim, as G1 asks it (policy `withoutQuotedHan`):
 * Horgos's «金亿» in a quoted address is the address's spelling. The gate's fact, read with this one function at
 * the scheduling and at the press (`autoFactsFor`).
 */
export function numeralUnread(body: string, quotableHan: string): boolean {
  return unreadNumeral(withoutQuotedHan(normalizeDigits(body), quotableHan, QUOTED_MIN_FIGURE));
}
