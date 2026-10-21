import {
  clientCodePrefix,
  notGoodsWord,
  parseClientHint,
  prefixCode,
  statesGoods,
  type AmbiguousTotal,
  type CalcFacts,
  type ClientHintOpts,
} from './intake';
import type { MeasureUnit } from './pricing';
import { normalizeTnved, parseGoodsLine, readAmountText, unitOf, type SellerUnit } from './units';

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

/** A whole number with optional space-grouped thousands, or a decimal — the
 * shapes `readAmountText` reads; the regex only finds the candidate. */
const AMOUNT = String.raw`(\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)`;

/**
 * «250 kg», «250kg», «250 кг», «vazni 250 kg» → 250.
 *
 * The end of the unit is a NEGATIVE LOOKAHEAD, not `\b`: JavaScript's word
 * boundary is defined on ASCII, so «120кг» ends on a non-word character as
 * far as it is concerned and `\b` never matches — which is exactly how the
 * office writes it. (Caught by the test, not by reading the regex.)
 *
 * The NUMBER is read by the kernel's free-text reader (`readAmountText`,
 * 2026-10-09): «1 200 kg» is twelve hundred — the old `\d+` read «200», a
 * sixfold error on the shipment's weight — and «1,200 kg» / «1.200 kg» are
 * AMBIGUOUS in somebody's Russian, so they answer nothing and are ASKED
 * (`AmbiguousTotal`), never guessed.
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
function readNumber(
  text: string,
  units: string[],
): { value: number | null; ambiguous: { text: string; decimal: number; thousands: number } | null } {
  const seen = new Set<number>();
  let ambiguous: { text: string; decimal: number; thousands: number } | null = null;
  for (const unit of units) {
    const re = new RegExp(`(?<![\\d.,])${AMOUNT}\\s*${unit}(?![\\p{L}\\d])`, 'giu');
    for (let hit = re.exec(text); hit; hit = re.exec(text)) {
      const read = readAmountText(hit[1]!);
      if (read.state === 'ok') seen.add(read.value);
      else if (read.state === 'ambiguous' && !ambiguous) {
        ambiguous = { text: hit[1]!, decimal: read.decimal, thousands: read.thousands };
      }
    }
    // A unit that answered is the unit: «5 kub» and «5 m3» in one text are
    // one statement, and the next spelling must not add a second opinion.
    if (seen.size > 0 || ambiguous) break;
  }
  if (ambiguous) return { value: null, ambiguous };
  return { value: seen.size === 1 ? [...seen][0]! : null, ambiguous: null };
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

export function parseManualFacts(text: string): CalcFacts & { ambiguous: AmbiguousTotal[] } {
  const route = readRoute(text);
  const weight = readNumber(text, ['kg', 'кг', 'kilo', 'килограмм']);
  const volume = readNumber(text, ['kub', 'куб', 'm3', 'м3', 'м³', 'm³']);
  const ambiguous: AmbiguousTotal[] = [];
  if (weight.ambiguous) ambiguous.push({ field: 'weightKg', ...weight.ambiguous });
  if (volume.ambiguous) ambiguous.push({ field: 'volumeM3', ...volume.ambiguous });
  return {
    fromCity: route.fromCity,
    toCity: route.toCity,
    weightKg: weight.value,
    volumeM3: volume.value,
    goods: readGoodsLines(text),
    ambiguous,
  };
}

/**
 * A line naming itself a goods line: «Tovar: …», «Товар - …», «Tovar nomi:
 * …», «Tovarlar: …». The label is a WHOLE word (review #25): «Tovarni rasmi»
 * and «Tovarlar» were matched by their first five letters and glued the rest
 * of the word onto a product («lar Kurtka»). The separator is CAPTURED (group
 * 2), and so is whether the label says «the NAME is» (group 1, T7):
 *  - after a NAMING label — «Tovar nomi:», «Наименование:», «Product name:»,
 *    «品名:» — what follows is the product's name, figures or not;
 *  - after a plain «Tovar:» / «Товар -» the body must still read as a name
 *    followed by figures, exactly as an unlabelled line — «Tovar: tayyor»,
 *    «Товар: готов», «Tovar: keldi», «Mahsulot: 5 kun ichida» are what a
 *    customer says ABOUT the goods, and a status list never ends;
 *  - with no separator at all («Tovar синтетическое … 1.1 kub 240 kg», his
 *    screenshot) the same test, or «Tovar keldimi», «Tovar narxi 1200$» and
 *    «Mahsulot sifati yaxshi» are products.
 */
const GOODS_LABEL =
  /^\s*(?:(tovar(?:lar)?\s*nomi|товар(?:лар|ы)?\s*номи|mahsulot(?:lar)?\s*nomi|махсулот(?:лар)?\s*номи|наименование(?:\s*товара)?|название(?:\s*товара)?|(?:goods|products?)\s*names?|品名)|tovar(?:lar)?|товар(?:лар|ы)?|mahsulot(?:lar)?|махсулот(?:лар)?|goods|products?)(?![\p{L}\p{N}])\s*([:：\-–—])?\s*/iu;

/** A body that is a LIST — «shim, kurtka» — is several products, and with no
 * figures nobody can say where one ends: the model's job, never one name (T7). */
const LIST_BODY = /[,;、，；]/u;

/**
 * The carton nouns that are also products (T6/T12): «Korobka 1000 dona» is a
 * thousand boxes for sale, «Karobka: 45 ta» is how many cartons the goods
 * came in — a FIELD, the name followed by its separator.
 */
const CARTON_NOUNS = new Set([
  'karobka', 'karopka', 'korobka', 'коробка', 'коробки', 'коробок', 'qop', 'quti', 'кути', 'box', 'boxes', 'carton',
  'cartons',
]);
const FIELD_SHAPED = /^[\p{L}\s'’‘ʻ`-]+[:：]/u;

/**
 * Words that make ten bare digits beside them a NUMBER and not a TNVED code
 * (T11): a line accepted on its code alone has no unit to vouch for it, so
 * «Telefon 8901234567» and «Mening raqamim 8901234567» are a phone — a phone
 * written with its 8 is ten digits, and 89 is a real chapter.
 */
const NUMBER_FIELD_WORDS = new Set([
  'tel', 'tlf', 'telefon', 'telefoni', 'telefonim', 'тел', 'телефон', 'raqam', 'raqami', 'raqamim', 'номер', 'nomer',
  'nomeri', 'nomerim', 'zakaz', 'заказ', 'order', 'invoice', 'инвойс', 'schet', 'счет', 'счёт', 'inn', 'инн', 'kurs',
  'курс', 'sana', 'дата', 'no', '№', 'nr', 'id',
]);

/**
 * A client code standing as a word of the name — «Mijoz GS777». The company's
 * prefix always is one; any other letters-and-digits word only when the line
 * states no count or pair, because then it is a MODEL (T12: «LED32 100 dona»
 * was dropped as a client code). Never a unit («m2»).
 */
function codeWord(word: string, prefix: string | null, counted: boolean): boolean {
  if (prefixCode(word, prefix)) return true;
  return !counted && /^[a-z]{1,4}\d{1,8}$/u.test(word) && unitOf(word) === null;
}

/** A client code on its own — glued, spaced or hyphenated («GS777», «GS 777», «GS-777»). */
const CLIENT_CODE_LINE = /^[A-Za-z]{1,4}\s*[-–]?\s*\d{1,8}$/;

/**
 * The tail of an unlabelled line: every token a figure, a unit word or a code
 * word, and — when `measured` is asked — at least ONE unit that is not a
 * carton (review #24). A bare trailing number is not a goods line — «Tel 90
 * 123 45 67», «Kurs 12650», «Sana 21.10.2026», «Partiya YW-123» were read as
 * products with that number as their count — and a carton count alone states
 * no measure of the goods.
 */
function unitFigures(tail: string, opts: { measured: boolean } = { measured: true }): boolean {
  const tokens = tail.split(/[\s,;/+]+/u).filter(Boolean);
  let measured = false;
  for (const token of tokens) {
    if (/^\d[\d.,]*$/u.test(token)) continue;
    const glued = /^(\d[\d.,]*)([\p{L}²³]+\.?)$/u.exec(token);
    const unit = unitOf(token) ?? (glued ? unitOf(glued[2]!) : null);
    if (unit !== null) {
      if (unit !== 'karobka') measured = true;
      continue;
    }
    if (/^(?:kod|код|tnved|тнвэд|hs)$/iu.test(token)) continue;
    return false;
  }
  return measured || !opts.measured;
}

/** Where the first figure starts its OWN token: «iPhone15 300 dona»'s is «300». */
const firstFigure = (body: string) => body.search(/(?<![\p{L}\p{N}])\d/u);

/**
 * A name, THEN figures — the figure starting its OWN token. «Bobur aka GS777»
 * and «Mijoz GS777» are not a name followed by «777» (review #6): the digit
 * sits inside a code. «iPhone15 300 dona» still reads: its first figure is
 * «300».
 */
function nameThenFigures(body: string): boolean {
  const at = firstFigure(body);
  return at > 0 && unitFigures(body.slice(at));
}

/**
 * A name, then its TNVED code — «Kurtka 6201930000», «Kurtka 6201.93.00.00»,
 * «Kurtka tnved 6201930000» (T11). The finding's own fix allowed «a count or a
 * pair unit … or a TNVED code», and `statesGoods` calls the line goods: with
 * the model down, a seller who typed products with their codes got «Tovarlar:
 * —» and lost the codes. Figures after the code may follow; nothing else.
 */
function nameThenCode(body: string): boolean {
  const at = firstFigure(body);
  return at > 0 && unitFigures(body.slice(at), { measured: false }) && parseGoodsLine(body).tnvedCode !== null;
}

/**
 * «Guangzhou - Toshkent 12 kub 3500 kg»: two place names joined by a dash and
 * only the shipment's totals after them is the ROUTE (review #22), which
 * `readRoute` does not trust from a hyphen alone. A product with a dash in it
 * states a count or a pair («Futbolka - oq 300 dona»), so it never reaches
 * this test, and «Coca-Cola» has no spaces round its hyphen.
 */
const DASH_ROUTE = /^\p{Lu}[\p{L}']*(?:\s+[-–—]\s+|\s*[–—]\s*)\p{Lu}[\p{L}']*$/u;

/**
 * The goods a person TYPED, line by line, read without a model — so that when
 * the model is down or found nothing, the summary still says what the goods
 * are. His screenshot of 2026-10-21 is the case: «Tovar синтетическое
 * компрессорное масло 1.1 kub 240 kg» came back «Tovarlar: —» because this
 * reader used to return none, ever.
 *
 * Narrow on purpose — a wrong split reads as fact on the card. A line counts
 * only when it SAYS it is a goods line («Tovar: …»), or when it is a name
 * followed by nothing but figures that carry a unit («Kurtka 300 dona 150
 * kg»). Not a route line, not a line of totals, count or field words («vazni
 * 120 kg», «Кол-во: 300 шт», «Tel 90 123 45 67»), not a sentence with a
 * number in the middle («yana 250 kg deb yozishdi»), not a question, not a
 * client code. These lines sit LAST in every caller's order: an invoice's
 * rows and the model's reading both win over them.
 *
 * `labelledOnly` (review #22): when the model DID read the material and found
 * no goods, a regex must not overrule it with «Salom» or «Guangzhou -
 * Toshkent» — only a line that names itself goods still answers. When the
 * model did not read (no key, budget, failure), every typed line answers —
 * and then the word list is what keeps a totals line («Andijonga 5 kub 1200
 * kg», «Hayrli kun, 12 kub 3500 kg», «Yukimiz 12 kub») out (T1/T8), while
 * «Kurtka 150 kg» and «Kafel 12 kub» stay products.
 *
 * The word list judges UNLABELLED lines only (T6): a «Tovar: …» line names the
 * goods explicitly, so «Tovar: korobka 1000 dona» is a thousand boxes.
 * `prefix` is the company's client-code prefix (`ClientHintOpts`).
 */
export function readGoodsLines(
  text: string,
  opts?: { labelledOnly?: boolean } & ClientHintOpts,
): NonNullable<CalcFacts['goods']> {
  const prefix = clientCodePrefix(opts);
  const out: NonNullable<CalcFacts['goods']> = [];
  for (const raw of text.split(/\r?\n/)) {
    if (out.length >= 50) break;
    const line = raw.trim();
    if (!line || !/\p{L}/u.test(line)) continue;
    if (readRoute(line).fromCity !== null) continue;
    if (CLIENT_CODE_LINE.test(line)) continue;
    // «Tovar keldimi?» — a question about the goods is not a goods line.
    if (/[?？]$/u.test(line)) continue;
    const label = GOODS_LABEL.exec(line);
    if (opts?.labelledOnly && !label) continue;
    const naming = Boolean(label?.[1]);
    const separated = Boolean(label?.[2]);
    const body = label ? line.slice(label[0].length) : line;
    const figured = nameThenFigures(body);
    const coded = !figured && nameThenCode(body);
    if (!figured && !coded && !(naming && separated && !LIST_BODY.test(body))) continue;
    const parsed = parseGoodsLine(body);
    const name = parsed.name.replace(/^[\s:\-–—.,]+|[\s:\-–—.,]+$/gu, '').trim();
    const words = name
      .toLowerCase()
      .split(/[\s,.;:()]+/u)
      .filter(Boolean);
    if (words.length === 0) continue;
    if (!label) {
      const counted = parsed.quantity !== null || parsed.measureQty !== null;
      if (words.every((w) => notGoodsWord(w) || codeWord(w, prefix, counted))) continue;
      if (FIELD_SHAPED.test(line) && words.every((w) => CARTON_NOUNS.has(w))) continue;
    }
    // Ten digits on a line with no unit are a number when a field names them.
    if (coded && words.some((w) => NUMBER_FIELD_WORDS.has(w.replace(/[’ʻʼ‘`´']/gu, '')))) continue;
    if ((name.match(/\p{L}/gu) ?? []).length < 2) continue;
    if (!separated && parsed.quantity === null && parsed.measureQty === null && DASH_ROUTE.test(name)) continue;
    // An answer the parser could not settle («1,200 kg») is not a figure, and
    // a unit stated twice («300 dona …, 200 dona») is two lines welded into
    // one — splitting them is the model's job.
    if (parsed.problems.some((p) => p.kind === 'ambiguous' || p.kind === 'repeated' || p.kind === 'two_pairs')) {
      continue;
    }
    out.push({
      name: name.slice(0, 200),
      quantity: parsed.quantity,
      weightKg: parsed.weightKg,
      volumeM3: parsed.volumeM3,
      measureUnit: parsed.measureUnit,
      measureQty: parsed.measureQty,
      tnvedCode: parsed.tnvedCode,
      note: null,
    });
  }
  return out;
}

/**
 * The answer to the bot's question about ONE line.
 *
 * The follow-up loop asks about a row its law (or the one-measure rule) says
 * cannot be priced yet, and whatever this returns is written onto that row
 * and priced — so the rule is «read it exactly or refuse». A refusal costs one
 * more question; a wrong reading costs a duty computed on a number nobody
 * stated.
 *
 * The amount grammar is the kernel's own (`parseGoodsLine`, 2026-10-09), the
 * same one the card form, the paste and the invoice reader use, so «1 200
 * kg» is 1200 everywhere, «120 m2» / «40 juft» / «50 litr» land in the
 * measure pair (they were refused before — the owner's «juftda o'tadigan
 * tovarlar»), «300 dona 150 kg» is BOTH (it was refused: it is the clothing
 * answer, a per-kg baza under a per-piece floor), and «120 ta juft» is 120
 * pairs, never 120 pieces.
 *
 *  - a TNVED code («6403990000», «6403.99.00.00», «kod 6907») is a CODE —
 *    never a 6.4-billion-kg weight (the audit's finding, which then blamed
 *    the server for the overflow);
 *  - a BARE number is handed back as `bare`: what it means is the LAW's
 *    question (`bareUnitFor`) or the seller's tap, never a default unit;
 *  - «1,200 kg» is `ambiguous`, with both readings and its unit;
 *  - a figure no column can hold (numeric(12,3): nine integer digits) is
 *    refused in words at parse time;
 *  - two pairs, two different weights, a carton count alone, or a unit this
 *    office does not price are refused with the reason, for the bot to word.
 */
export interface LineFigures {
  quantity: number | null;
  weightKg: number | null;
  volumeM3: number | null;
  measureUnit: MeasureUnit | null;
  measureQty: number | null;
}

export type LineAnswerRefusal =
  | 'nothing'
  | 'too_large'
  | 'code_short'
  | 'cartons'
  | 'unknown_unit'
  | 'two_pairs'
  | 'unlabelled'
  | 'repeated';

export type LineAnswer =
  | { kind: 'figures'; figures: LineFigures; code: string | null }
  | { kind: 'bare'; value: number; code: string | null }
  | { kind: 'ambiguous'; decimal: number; thousands: number; unit: SellerUnit | null }
  | { kind: 'refused'; reason: LineAnswerRefusal; detail?: string };

/** numeric(12,3) holds nine integer digits; measure_qty numeric(14,4), ten. */
export const ROW_AMOUNT_CAP = 1e9;
export const PAIR_AMOUNT_CAP = 1e10;

/** The unit word written right after a number in the answer, if any. */
function unitAfter(text: string, numberText: string): SellerUnit | null {
  const at = text.indexOf(numberText);
  if (at < 0) return null;
  const word = /^\s*([\p{L}²³][\p{L}\d²³.]*)/u.exec(text.slice(at + numberText.length));
  return word ? unitOf(word[1]) : null;
}

export function parseLineAnswer(raw: string): LineAnswer {
  const text = raw.trim();
  if (!text) return { kind: 'refused', reason: 'nothing' };
  // A minus is not a quantity of anything; the kernel's amount grammar would
  // read «-5» as 5.
  if (/(?:^|\s)-\s*\d/.test(text)) return { kind: 'refused', reason: 'nothing' };

  // Nine bare digits are a code whose leading zero was lost, not 901 million
  // pieces — the kernel's rule for typed text (`normalizeTnved`).
  if (/^[\d.\s ]+$/.test(text)) {
    const code = normalizeTnved(text);
    if (code && 'problem' in code) return { kind: 'refused', reason: 'code_short', detail: code.text };
  }

  const line = parseGoodsLine(text);
  // Ten digits with a unit word after them are an AMOUNT no column can
  // hold, not a code: the kernel takes ten bare digits for a TNVED code
  // wherever they stand, so «2000000000 kg» would have answered the line
  // with a code and no figure.
  if (line.tnvedCode !== null && unitAfter(text, line.tnvedCode) !== null) {
    return { kind: 'refused', reason: 'too_large' };
  }
  for (const p of line.problems) {
    if (p.kind === 'ambiguous') {
      return { kind: 'ambiguous', decimal: p.decimal, thousands: p.thousands, unit: unitAfter(text, p.text) };
    }
  }
  for (const p of line.problems) {
    switch (p.kind) {
      case 'code_short':
        return { kind: 'refused', reason: 'code_short', detail: p.text };
      case 'two_pairs':
        return { kind: 'refused', reason: 'two_pairs' };
      case 'unlabelled':
        return { kind: 'refused', reason: 'unlabelled' };
      case 'repeated':
        return { kind: 'refused', reason: 'repeated' };
      case 'cartons_only':
        return { kind: 'refused', reason: 'cartons', detail: String(p.cartons) };
      case 'unknown_unit':
        return { kind: 'refused', reason: 'unknown_unit', detail: p.word };
      default:
        break;
    }
  }

  const figures: LineFigures = {
    quantity: line.quantity,
    weightKg: line.weightKg,
    volumeM3: line.volumeM3,
    measureUnit: line.measureUnit,
    measureQty: line.measureQty,
  };
  const tooLarge =
    [figures.quantity, figures.weightKg, figures.volumeM3].some((v) => v !== null && v >= ROW_AMOUNT_CAP) ||
    (figures.measureQty !== null && figures.measureQty >= PAIR_AMOUNT_CAP);
  if (tooLarge) return { kind: 'refused', reason: 'too_large' };

  const stated = [figures.quantity, figures.weightKg, figures.volumeM3, figures.measureQty].filter(
    (v) => v !== null,
  ).length;
  // A count is a COUNT only when a count word says so; the kernel reads a
  // lone bare number as one by its «nomi, soni» convention, which is right
  // for a list and wrong for an answer to «dona yoki kg?».
  const countSaid = line.unitWords.some((w) => unitOf(w) === 'dona');
  if (stated === 1 && figures.quantity !== null && !countSaid) {
    return { kind: 'bare', value: figures.quantity, code: line.tnvedCode };
  }
  if (stated === 0 && !line.tnvedCode) return { kind: 'refused', reason: 'nothing' };
  return { kind: 'figures', figures, code: line.tnvedCode };
}

/** «Shim 200», «Stol 1000»: one word and its count. */
const ONE_WORD_COUNT = /^\p{L}[\p{L}'’‘ʻ`-]*\s+\d{2,}$/u;
/** «Samsung A54», «Xiaomi Redmi K60»: a product and its one-letter model. */
const MODEL_TAIL = /\p{L}\s+[A-Z]\d{1,4}$/u;

/**
 * Is the first message of a collection MATERIAL rather than the customer's
 * name (his 1.7 b)? The bot asks «who is the customer» and a seller in a
 * hurry forwards the goods list instead; it used to become the lead's NAME
 * and was never shown to the model.
 *
 * Goods evidence decides FIRST (review #16, #23): a unit word, a TNVED code
 * or a line naming itself goods is material, whatever digits it also holds.
 * Then the customer: a code or a phone, written the ways people write them
 * («GS 777», «Bobur aka GS777», «Ali aka» over «+998 90 123 45 67»). Then
 * several lines or a long text is material. What is left — a short line of
 * words, perhaps with a bare number («Ali aka 2», «OOO Asia Trade 2020») —
 * is a NAME: filing a name as material re-asked the same question for ever.
 *
 * Except the two shapes a goods line has and a name does not (the second
 * review's T4): ONE word and its count («Shim 200», «Stol 1000», «Olma 300»
 * — the «nomi, soni» line of every list), and a product ending in its model
 * («Samsung A54», «Xiaomi Redmi K60»). Both used to be read as a client code
 * nobody holds, so the goods named the lead and never reached the model; as a
 * NAME they would do the same. `opts.prefix` is the company's client-code
 * prefix (`ClientHintOpts`), which the bot passes.
 */
export function looksLikeMaterial(raw: string, opts?: ClientHintOpts): boolean {
  const text = raw.trim();
  if (!text) return false;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const labelled = { labelledOnly: true, prefix: opts?.prefix };
  if (lines.some((l) => statesGoods(l) || readGoodsLines(l, labelled).length > 0)) return true;
  if (parseClientHint(text, opts)) return false;
  return lines.length > 1 || text.length > 60 || ONE_WORD_COUNT.test(text) || MODEL_TAIL.test(text);
}
