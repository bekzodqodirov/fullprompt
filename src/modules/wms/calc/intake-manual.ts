import type { CalcFacts } from './intake';

/**
 * The facts a staff member typed, read without a model.
 *
 * Two reasons this exists rather than leaning on the AI for everything.
 * First, honesty: a person who wrote «5 kub» stated a fact, and a model that
 * missed it must not be able to erase it — so these values WIN over the
 * model's reading. Second, availability: the intake has to work on a server
 * with no API key at all, or the feature dies the day a key expires.
 *
 * Deliberately narrow. It reads the shapes the office actually types — «250
 * kg», «5 kub», «Yiwu → Toshkent» — and leaves everything else to the model
 * and to the person's own eyes at the review step.
 */

/**
 * «250 kg», «250kg», «250 кг», «vazni 250 kg» → 250.
 *
 * The end of the unit is a NEGATIVE LOOKAHEAD, not `\b`: JavaScript's word
 * boundary is defined on ASCII, so «120кг» ends on a non-word character as
 * far as it is concerned and `\b` never matches — which is exactly how the
 * office writes it. (Caught by the test, not by reading the regex.)
 *
 * It reads EVERY occurrence, not the first, and answers only when the whole
 * collection agrees on ONE number. The owner's report — «7 8 ta malumot
 * tashlaganda … faqat 1 tasini tahlil qilyabti» — is partly this: eight
 * forwarded messages are joined into one string, the first «12 kg» in a
 * packing line won, and because a typed fact deliberately BEATS the model's
 * reading, that one line became the shipment's whole weight and the model's
 * total was thrown away. Several different numbers mean the office wrote
 * several numbers: that is a question for the reader (the model, which sees
 * all of the text) or for the VED, who can now type it on the screen.
 */
function readNumber(text: string, units: string[]): number | null {
  const seen = new Set<number>();
  for (const unit of units) {
    const re = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${unit}(?![\\p{L}\\d])`, 'giu');
    for (let hit = re.exec(text); hit; hit = re.exec(text)) {
      const value = Number(hit[1]!.replace(',', '.'));
      if (Number.isFinite(value) && value > 0) seen.add(value);
    }
    // A unit that answered is the unit: «5 kub» and «5 m3» in one text are
    // one statement, and the next spelling must not add a second opinion.
    if (seen.size > 0) break;
  }
  return seen.size === 1 ? [...seen][0]! : null;
}

/**
 * «Yiwu → Toshkent», «Yiwu - Toshkent», «Guangzhou dan Andijon ga».
 * Only the arrow forms are trusted: a hyphen inside a product name would
 * otherwise turn half a packing list into a route.
 */
function readRoute(text: string): { fromCity: string | null; toCity: string | null } {
  const arrow = /([A-Za-zА-Яа-яЎўҚқҒғҲҳ' ]{2,24})\s*(?:→|->|=>)\s*([A-Za-zА-Яа-яЎўҚқҒғҲҳ' ]{2,24})/u.exec(
    text,
  );
  if (arrow) return { fromCity: arrow[1]!.trim(), toCity: arrow[2]!.trim() };

  const uz = /([A-Za-zА-Яа-яЎўҚқҒғҲҳ']{2,24})\s*(?:dan|дан|из)\s+([A-Za-zА-Яа-яЎўҚқҒғҲҳ']{2,24})\s*(?:ga|га|до|в)\b/iu.exec(
    text,
  );
  if (uz) return { fromCity: uz[1]!.trim(), toCity: uz[2]!.trim() };

  return { fromCity: null, toCity: null };
}

export function parseManualFacts(text: string): CalcFacts {
  const route = readRoute(text);
  return {
    fromCity: route.fromCity,
    toCity: route.toCity,
    weightKg: readNumber(text, ['kg', 'кг', 'kilo', 'килограмм']),
    volumeM3: readNumber(text, ['kub', 'куб', 'm3', 'м3', 'м³', 'm³']),
    // A typed product list is not parsed into items: guessing where one name
    // ends and the next begins is exactly the job the model does better, and
    // a wrong split reads as fact on the card.
    goods: [],
  };
}

/**
 * The answer to «how many, or how heavy?» about ONE line.
 *
 * The follow-up loop (sub-round C) asks the seller about the rows that state
 * neither a count nor a weight, because `unitsForRow` can price a row per
 * dona or per kg and can price a row stating NEITHER only by guessing — the
 * one thing this module may not do.
 *
 * Pure, and deliberately narrow in a different direction from
 * `parseManualFacts`: there the risk is a packing list full of numbers, here
 * the whole message IS the answer, so a bare «50» is legal and means the
 * unit the QUESTION was about.
 *
 * Rules:
 *  - «300 kg» / «300 кг» / «300kilo» → a weight. The unit ends on a NEGATIVE
 *    LOOKAHEAD and not `\b` — JavaScript's word boundary is ASCII, so «300кг»
 *    never matches a `\b` (#412, measured, and the same trap twice now).
 *  - «50 dona» / «50 шт» / «50 pcs» / «50 ta» → a count.
 *  - a bare number → whichever the caller says the line is shaped like.
 *  - anything with two different figures, or none, or a nonsense unit → null.
 *    A refusal here is re-asked once; a WRONG reading would be a weight the
 *    VED never sees and a duty computed on it.
 */
export type LineAnswer = { quantity: number } | { weightKg: number };

const KG_RE = /(\d+(?:[.,]\d+)?)\s*(?:kg|кг|kilogramm|kilo|килограмм|килограм)(?![\p{L}\d])/giu;
const QTY_RE = /(\d+(?:[.,]\d+)?)\s*(?:dona|donа|ta|sht|шт|штук|pcs|pc|adet)(?![\p{L}\d])/giu;
const BARE_RE = /^\s*(\d+(?:[.,]\d+)?)\s*$/u;

function only(text: string, re: RegExp): number | null {
  const seen = new Set<number>();
  const fresh = new RegExp(re.source, re.flags);
  for (let hit = fresh.exec(text); hit; hit = fresh.exec(text)) {
    const value = Number(hit[1]!.replace(',', '.'));
    if (Number.isFinite(value) && value > 0) seen.add(value);
  }
  return seen.size === 1 ? [...seen][0]! : null;
}

export function parseLineAnswer(
  raw: string,
  opts: { bareMeans: 'quantity' | 'weight' } = { bareMeans: 'quantity' },
): LineAnswer | null {
  const text = raw.trim();
  if (!text) return null;

  const kg = only(text, KG_RE);
  const qty = only(text, QTY_RE);
  // Both spelled out is not an answer to a question that asked for one — the
  // seller may have meant «50 dona, 300 kg jami», and picking either would be
  // a number nobody stated about this row.
  if (kg !== null && qty !== null) return null;
  if (kg !== null) return { weightKg: kg };
  if (qty !== null) return { quantity: qty };

  const bare = BARE_RE.exec(text);
  if (bare) {
    const value = Number(bare[1]!.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) return null;
    return opts.bareMeans === 'weight' ? { weightKg: value } : { quantity: value };
  }
  return null;
}
