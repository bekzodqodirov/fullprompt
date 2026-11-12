import {
  chatLine,
  clientCodePrefix,
  notGoodsWord,
  ONE_WORD_COUNT,
  parseClientHint,
  placeWord,
  prefixCode,
  statesGoods,
  type AmbiguousTotal,
  type CalcFacts,
  type CalcSection,
  type ClientHintOpts,
} from './intake';
import { addressWord } from './address-words';
import { applyPacking } from './carton-math';
import type { MeasureUnit } from './pricing';
import {
  AMOUNT_NUMBER,
  amountsIn,
  BLANK,
  blankNonAmounts,
  blankSizes,
  blankSpan,
  blankSpans,
  codeIn,
  COUNTED_CUBES,
  FIELD_LABELS,
  groupedReading,
  labelPattern,
  NET_LABELS,
  normalizeTnved,
  packingRead,
  parseGoodsLine,
  perOneSpans,
  readAmountText,
  scaledKg,
  scaledKgValue,
  scaledPattern,
  UNIT_FREE_LABELS,
  unitOf,
  unitPattern,
  VOLUME_LABELS,
  WEIGHT_LABELS,
  weightLabelKind,
  withoutFirstGroup,
  type GoodsLine,
  type GoodsLineProblem,
  type SellerUnit,
} from './units';

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
 * The space between a number and its unit, a label and its figure — on ONE
 * line. `\s*` crossed the line break: «G.W.: 507⏎CBM: 5.92» stated a cube of
 * 507, once «cbm» was a word this reader knew.
 */
const GAP = String.raw`[ \t\u00a0\u202f]*`;

/**
 * Never a number glued to a letter on its left (review JN-5): the 777 of
 * «GS777» and the 3 of «5 m3» are no amounts, so neither can be the thousands
 * of the figure after it — «5 m3 200 kg» was 3 200 kg. A Han character is
 * exempt: «毛重507kg» is a label and its figure written with no space, and no
 * model number is spelled in Han.
 */
const NOT_GLUED = String.raw`(?<![\d.,])(?<!(?!\p{Script=Han})\p{L})`;

/**
 * A figure of ONE unit, in every word the vocabulary has for it (units.ts
 * `WORDS` — docs/AI-SORAYDI.md §2.4): «250 kg», «250kg», «507 KGS», «5.92
 * CBM», «12 кубов», «5.92立方». This reader kept two lists of its own — kg /
 * кг / kilo / килограмм and kub / куб / m3 — so «cbm», the word on every
 * Chinese packing list, was no cube (his «"cbm" degan yozuvni o‘qiy
 * olmayapti»), and the per-carton «34kg» beside «507 KGS» was the only weight
 * it saw. Group 1 is the number, group 2 the unit word.
 *
 * The end of the unit is a NEGATIVE LOOKAHEAD, not `\b`: JavaScript's word
 * boundary is defined on ASCII, so «120кг» ends on a non-word character as
 * far as it is concerned and `\b` never matches — which is exactly how the
 * office writes it. (Caught by the test, not by reading the regex.)
 */
const figureOf = (unit: 'kg' | 'm3' | 'dona') =>
  new RegExp(String.raw`${NOT_GLUED}(${AMOUNT_NUMBER})${GAP}(${unitPattern(unit)})(?![\p{L}\d])`, 'giu');
const KG_FIGURE = figureOf('kg');
const M3_FIGURE = figureOf('m3');
/** A piece count on the line — what keeps a counted cube («4 кубов») in the name (review JN-22). */
const PIECES_FIGURE = new RegExp(figureOf('dona').source, 'iu');

/**
 * A weight in TONNES or GRAMS (docs/AI-SORAYDI.md §3.1 T14, CR-7): «2 tonna»,
 * «20 тонн», «2,5 тн», «2吨», «500 gr» — kilos in another scale, in the
 * spellings that can be nothing else (units.ts `SCALED_KG`; review JN-9).
 * «yuk 2 tonna 12 kub» stated a cube and no weight at all. Never a figure
 * before a slash: «180 gr/m2» is a density. Group 1 is the number, group 2
 * the word.
 */
const SCALED_FIGURE = new RegExp(
  String.raw`${NOT_GLUED}(${AMOUNT_NUMBER})${GAP}(${scaledPattern('words')})(?![\p{L}\d])(?!${GAP}/)`,
  'giu',
);
/**
 * …and the lone letters — «2 t», «2.5 MT», «500 g» — which are capacities and
 * generations far more often than weights («Fleshka 128G», «Domkrat 5 t»,
 * «2024 г»). Never glued to the digits (a space is REQUIRED), never before a
 * slash, and read ONLY in the answer to the bot's own question about the
 * totals (`TypedTotalsOpts.totalsAnswer`), where nothing names goods. In
 * free material they are not read at all — not even after a weight's label,
 * which review JN-9 would allow: «G.W.: 2.5 MT» there stays unread and the
 * weight is asked (the corpus pins it so, c3275).
 */
const LONE_SCALED_FIGURE = new RegExp(
  String.raw`${NOT_GLUED}(${AMOUNT_NUMBER})[ \t\u00a0\u202f]+(${scaledPattern('lone')})(?![\p{L}\d])(?!${GAP}/)`,
  'giu',
);

/**
 * A figure written LABEL FIRST — «G.W.: 507», «CBM: 5.92», «毛重：507»,
 * «Hajmi (m3): 12», «Вес, кг: 150» (§3.1 T1). With NO unit, only after a
 * label that can name nothing but that measure (units.ts `UNIT_FREE_LABELS`,
 * review JN-21: «Gross: 12 500» heads a money line and «Manga Vol 3» is a
 * book) and only with a «:» or «=» between the two — «G.W. 507» with neither
 * is not read, and a bare «5.92» is no cube. With the UNIT written between
 * them, after any label of the measure («вес», «gross», «vol» need the unit —
 * and there it is). Group 1 is the number, and the match ENDS with it.
 */
const labelFirst = (free: readonly string[], all: readonly string[], unit: 'kg' | 'm3') => {
  const unitWritten = String.raw`${GAP}[,(（\[]?${GAP}(?:${unitPattern(unit)})(?![\p{L}\d])${GAP}[)）\]]?${GAP}[:：=]?`;
  return new RegExp(
    String.raw`(?<![\d])(?<!(?!\p{Script=Han})\p{L})(?:(?:${labelPattern(free)})(?:${unitWritten}|${GAP}[:：=])|(?:${labelPattern(all)})${unitWritten})${GAP}(${AMOUNT_NUMBER})(?![\d.,]*\d)`,
    'giu',
  );
};
const KG_LABELLED = labelFirst([...UNIT_FREE_LABELS.weightKg, ...UNIT_FREE_LABELS.netKg], [...WEIGHT_LABELS, ...NET_LABELS], 'kg');
const M3_LABELLED = labelFirst(UNIT_FREE_LABELS.volumeM3, VOLUME_LABELS, 'm3');

/** A label of a totals line opening what follows a label-first figure — «G.W.: 507 MEAS: 5.92». */
const LABEL_NEXT = new RegExp(
  String.raw`^(?:${labelPattern([...WEIGHT_LABELS, ...NET_LABELS, ...VOLUME_LABELS])})(?![\p{L}\d])`,
  'iu',
);

/** A currency on the line: «Brutto: 12 500 $» is a sum of money, never kilos (review JN-21). */
const CURRENCY = /[$€¥₽£]|(?<![\p{L}])(?:usd|eur|rmb|cny|uzs|yuan|dollar\p{L}*|доллар\p{L}*|руб\p{L}*|сум|сўм|so[’ʻʼ‘`´']?m|sum)(?![\p{L}])/iu;

/**
 * May the label-first figure ending at `end` stand? Not when a word of its
 * own follows it on the line — «G.W.: 2.5 MT» is tonnes, «G.W.: 507 pcs» a
 * count; a figure with a kilo or a cube word is the unit reader's — and not
 * when another number does. The next label of the same line may follow.
 */
function standsAlone(text: string, end: number): boolean {
  // The next word is within a label's length of the figure; no more is read.
  const near = text.slice(end, end + 48);
  const stop = near.indexOf('\n');
  const rest = (stop < 0 ? near : near.slice(0, stop)).trimStart();
  if (rest === '' || /^[,;.)\]|/]/u.test(rest)) return true;
  return LABEL_NEXT.test(rest);
}

/** The cargo itself, in the forms a label follows — «yuk hajmi», «tovarlar og‘irligi», «вес груза» is the other order. */
const CARGO_WORD = /^(?:yuk|юк|tovar|товар|mahsulot|махсулот|груз|goods|cargo)\p{L}*$/iu;

/**
 * Is the label at `labelAt` its line's own — or some product's? «Hajmi: 12»,
 * «Yuk hajmi: 12», «jami og‘irligi: 507», «G.W.: 507 MEAS: 5.92» state the
 * shipment; «Dvigatel hajmi: 1.6» is an engine's displacement, «Bak hajmi:
 * 50» a tank's litres, «Kurtka og‘irligi: 0.5» one jacket — a label a NAME
 * word possesses names that thing's measure, and with no unit after the
 * figure nothing else would say so (review JN-22's rule for a unit word
 * before a colon, on the labels). A Han label is a spec block's own.
 */
function labelStands(scan: string, labelAt: number): boolean {
  if (/\p{Script=Han}/u.test(scan.charAt(labelAt))) return true;
  const [from] = lineAround(scan, labelAt);
  const before = scan.slice(from, labelAt);
  // A figure before the label is the previous label's («G.W.: 507 MEAS: …»).
  if (/\d[.,]?\s*$/u.test(before.slice(-8))) return true;
  return groupedReading(before, before.length, (w) => figureLabel(w) || CARGO_WORD.test(w)) === 'thousands';
}

/** The text line holding offset `at`, as `[start, end)`. */
function lineAround(text: string, at: number): [number, number] {
  const end = text.indexOf('\n', at);
  return [text.lastIndexOf('\n', at - 1) + 1, end < 0 ? text.length : end];
}

/**
 * The text the totals are read from (§3.1 T0): every size, every phone, every
 * code's digits (units.ts `blankNonAmounts`) and the client's code in its
 * three spellings — «GS777», «GS 777», «GS-777» — blanked, line by line. None
 * of them is an amount, and each stood before a weight as its thousands («GS
 * 777 300 kg» — 777 300 kg, under ✅). Same length as `text`.
 */
function blankForTotals(text: string, prefix: string | null): string {
  const code = prefix ? new RegExp(String.raw`(?<![\p{L}\d])${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\s*[-–]?\s*\d{1,8}(?!\d)`, 'giu') : null;
  return text
    .split('\n')
    .map((line) => {
      let out = blankNonAmounts(line);
      for (const hit of code ? out.matchAll(code) : []) out = blankSpan(out, hit.index, hit.index + hit[0].length);
      return out;
    })
    .join('\n');
}

/** A word that modifies the figure itself — «taxminan 1 200 kg», «около 1 200 кг» — never a count before it. */
const APPROX_WORD = /^(?:taxminan|taxminiy|тахминан|примерно|около|приблизительно|approx|about)$/iu;

/**
 * One total, read from every place the text states it.
 *
 * The NUMBER is read by the kernel's free-text reader (`readAmountText`,
 * 2026-10-09): «1 200 kg» is twelve hundred — the old `\d+` read «200», a
 * sixfold error on the shipment's weight — and «1,200 kg» / «1.200 kg» are
 * AMBIGUOUS in somebody's Russian, so they answer nothing and are ASKED
 * (`AmbiguousTotal`), never guessed. So is a space-grouped number whose
 * first group may be another fact's — «stul 20 300 kg»: 300 or 20300
 * (units.ts `groupedReading`, review JN-6); `decimal` then carries the
 * reading without that group.
 *
 * It reads EVERY occurrence, not the first, and answers only when the whole
 * collection agrees on ONE number. The owner's report — «7 8 ta malumot
 * tashlaganda … faqat 1 tasini tahlil qilyabti» — is partly this: eight
 * forwarded messages are joined into one string, the first «12 kg» in a
 * packing line won, and because a typed fact deliberately BEATS the model's
 * reading, that one line became the shipment's whole weight and the model's
 * total was thrown away. Several different numbers mean the office wrote
 * several numbers: that is a question for the reader (the model, which sees
 * all of the text) or for the VED, who can now type it on the screen. Every
 * spelling of the unit is one statement now: «5 kub» beside «6 m3» is two
 * numbers, where the first spelling in a list used to win.
 *
 * `scan` is `text` blanked (`blankForTotals`): the figures are FOUND there,
 * and every offset means the same in both.
 */
function readNumber(
  text: string,
  scan: string,
  figure: RegExp,
  labelled: RegExp,
  /** A hit this reading does not count — a line's own figure, a netto label. */
  skip: (start: number, end: number) => boolean = () => false,
  /** The same field written in another scale — tonnes and grams of the kilo (T14). */
  scaled: readonly ScaledReader[] = [],
): TotalRead {
  const seen = new Set<number>();
  let ambiguous: { text: string; decimal: number; thousands: number } | null = null;
  // Where every figure this reading counted stands — `[start, end)`, its unit
  // or its label included — with the value it stated (null: a doubted one).
  const hits: { start: number; end: number; value: number | null }[] = [];
  const take = (number: string, at: number, labelFirstHit: boolean, span: [number, number], factor = 1) => {
    // Every reading of a scaled figure is in the field's own unit: «1,200 тн» is 1200 kg or 1200000 kg.
    const own = (n: number) => (factor === 1 ? n : scaledKgValue(n, factor));
    const read = readAmountText(number);
    if (read.state === 'ambiguous') {
      ambiguous ??= { text: number, decimal: own(read.decimal), thousands: own(read.thousands) };
      hits.push({ start: span[0], end: span[1], value: null });
      return;
    }
    if (read.state !== 'ok') return;
    // After its own label a grouped number is whole; anywhere else it is
    // asked when a count, a model or a bare number may be its first group.
    const tail = labelFirstHit ? null : withoutFirstGroup(number);
    if (tail !== null) {
      const [from] = lineAround(scan, at);
      if (groupedReading(scan.slice(from, at + number.length), at - from, figureLabel) === 'ask') {
        ambiguous ??= { text: number, decimal: own(tail), thousands: own(read.value) };
        hits.push({ start: span[0], end: span[1], value: null });
        return;
      }
    }
    seen.add(own(read.value));
    hits.push({ start: span[0], end: span[1], value: own(read.value) });
  };
  for (const hit of scan.matchAll(figure)) {
    const end = hit.index + hit[0].length;
    if (skip(hit.index, end)) continue;
    // «Набор 4 кубов 20 шт»: the toy's own cubes, beside its piece count.
    if (COUNTED_CUBES.has(hit[2]!.toLowerCase())) {
      const [from, to] = lineAround(scan, hit.index);
      if (PIECES_FIGURE.test(scan.slice(from, to))) continue;
    }
    take(hit[1]!, hit.index, false, [hit.index, end]);
  }
  for (const reader of scaled) {
    for (const hit of scan.matchAll(reader.figure)) {
      const end = hit.index + hit[0].length;
      const factor = scaledKg(hit[2])?.factor;
      if (factor === undefined || skip(hit.index, end) || !reader.when(hit.index)) continue;
      take(hit[1]!, hit.index, false, [hit.index, end], factor);
    }
  }
  // A line's currency is asked once per line, however many labels it holds.
  const money = new Map<number, boolean>();
  const hasCurrency = (at: number) => {
    const [from, to] = lineAround(text, at);
    if (!money.has(from)) money.set(from, CURRENCY.test(text.slice(from, to)));
    return money.get(from)!;
  };
  for (const hit of scan.matchAll(labelled)) {
    const end = hit.index + hit[0].length;
    const at = end - hit[1]!.length;
    if (skip(at, end) || !standsAlone(text, end) || !labelStands(scan, hit.index)) continue;
    if (hasCurrency(at)) continue;
    take(hit[1]!, at, true, [hit.index, end]);
  }
  // A doubt covers the whole field: every figure of it is the question's.
  if (ambiguous) return { value: null, ambiguous, taken: hits.map((h) => [h.start, h.end]) };
  const value = seen.size === 1 ? [...seen][0]! : null;
  // Two different figures answer nothing, and neither was taken.
  return { value, ambiguous: null, taken: value === null ? [] : hits.map((h) => [h.start, h.end]) };
}

/** A figure of the field in another scale, and where it may be read at all (`at` — the figure's offset). */
interface ScaledReader {
  figure: RegExp;
  when: (at: number) => boolean;
}

/** One field's reading: its value, or the doubt, and WHERE the figures it took stand in the text. */
interface TotalRead {
  value: number | null;
  ambiguous: { text: string; decimal: number; thousands: number } | null;
  taken: [number, number][];
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

/**
 * The word a weight's own label uses for NETTO (review PF-1): «Netto», «нетто»,
 * «N.W.», «NW», «N/W», «net weight», «净重», «sof og‘irlik» — units.ts
 * `NET_LABELS`, read through the one vocabulary since «KGS» became a kilo
 * word: «N/W 480 KGS» was on no list here, and would have answered the
 * brutto question.
 */
const NETTO_WORD = `(?:${labelPattern(NET_LABELS)})`;
const NETTO_BEFORE = new RegExp(String.raw`(?:^|[^\p{L}])${NETTO_WORD}(?![\p{L}])`, 'iu');
// After the unit, a netto word labels THIS figure only when no number follows
// it — «1300 kg netto 1200 kg» is the next figure's label, not this one's.
// The dot of «N.W.» is the label's own: without it in the class the label was
// matched as «N.W» and its dot stopped the look for the number — so in «G.W.
// 507 kg⏎N.W. 480 kg», the block every packing list carries, the BRUTTO was
// taken for the netto and the shipment's weight was nobody's.
const NETTO_AFTER = new RegExp(String.raw`^\s*[(\[]?\s*${NETTO_WORD}(?![\p{L}])(?![\s.:：=–—-]*\d)`, 'iu');

/**
 * Is the weight at [start, end) labelled NETTO?
 *
 * Read off the words right BEFORE the figure — back to the previous figure or
 * line break, at most 40 characters — and the word right after its unit
 * («1200 kg netto»). The window stops at the previous figure, so «Netto 1200
 * kg, Brutto 1300 kg» labels each number by its own word.
 */
function nettoLabelled(text: string, start: number, end: number): boolean {
  const from = Math.max(0, start - 40);
  const before = text.slice(from, start);
  const cut = Math.max(before.lastIndexOf('\n'), ...[...before.matchAll(/\d/g)].map((m) => m.index!));
  return NETTO_BEFORE.test(before.slice(cut + 1)) || NETTO_AFTER.test(text.slice(end, end + 16));
}

/**
 * The text's lines as [start, end) offsets, so a hit can be placed on its line.
 */
function lineSpans(text: string): [number, number][] {
  const out: [number, number][] = [];
  let at = 0;
  for (const line of text.split('\n')) {
    out.push([at, at + line.length]);
    at += line.length + 1;
  }
  return out;
}

/**
 * A typed line that addresses a ROW of the goods list by its number — «3: 150
 * kg», «3-qator 150 kg» — in the material stage (line-address.ts reads its
 * answers by this same form, regression-3; a numbered list «1. Kurtka …» is
 * goods). One home for both readers.
 */
export const MATERIAL_ROW_ADDRESS = /^\s*(\d{1,4})(?:-?(?:chi|nchi))?(?:\s*:|\s*-?\s*(?:qator|строк)\p{L}*(?=[\s:,.]|$))\s*/iu;

/**
 * A word that makes a line the SHIPMENT's, wherever it stands in the line: a
 * totals word (`TOTALS_WORDS`' own vocabulary — line-address.ts reads it, and
 * imports this module, so it is restated here), «xammasi», «faktik», and the
 * misspelt «обший».
 */
const SHIPMENT_WORD =
  /(?<![\p{L}\p{N}])(?:jami(?:si)?|жами(?:си)?|umumiy|умумий|obsh(?:iy|ii)|обш\p{L}*|общ\p{L}*|итог\p{L}*|всего|brutto|брутто|gross|totals?|ttl|[hx]ammasi|хаммаси|ҳаммаси|barchasi|барчаси|faktik|фактик|фактическ\p{L}*)(?![\p{L}\p{N}])/iu;
/** «Hamma yuk», «Barcha tovar», «Весь груз», «Hamma karobka/qop»: ALL of the cargo. */
const WHOLE_SHIPMENT =
  /(?<![\p{L}])(?:hamma|barcha|butun|весь|вся|всё|все)\s+(?:yuk|tovar|mahsulot|karobka|korobka|qop|quti|груз|товар|короб|мест)\p{L}*/iu;
/** The words a head that names no goods is made of: a measure, a package, the cargo itself. */
const SHIPMENT_HEAD = new Set(['massa', 'масса', 'mass', 'yuk', 'груз']);

/**
 * A line about the WHOLE shipment, whatever goods name the goods reader finds
 * on it (fix review FR-REGR-1, FR-SELL-1). `typedGoods` takes «Kurtka va shim
 * jami 3600 kg», «Jami: 3500 kg / 15 kub» («Jami /»), «Faktik vazn 3600 kg»,
 * «Karobka 20 ta, 3600 kg» and «Massa 3500 kg» for goods lines, and beside a
 * held list (`goodsBeside`) a lone goods line became the line's — the
 * seller's own total was dropped and the packing list's figure landed over
 * his correction. A totals word anywhere, all of the cargo, or a head made
 * only of measure and package words: the line is the shipment's, as it was.
 */
function shipmentLine(line: string): boolean {
  if (SHIPMENT_WORD.test(line) || WHOLE_SHIPMENT.test(line)) return true;
  const head = (line.split(/\d/u)[0] ?? '').toLowerCase().match(/\p{L}+/gu) ?? [];
  return head.length > 0 && head.every((w) => MEASURE_FIELDS.has(fieldKey(w)) || CARTON_NOUNS.has(w) || SHIPMENT_HEAD.has(w));
}

/**
 * The shipment's totals and route, as TYPED.
 *
 * Two rules decide which typed figure may be the SHIPMENT's (round 2's merged
 * review):
 *
 *  - **A goods line's figure is that line's, not the total** (PF-2). When two
 *    or more lines read as goods (`typedGoods`), a kilo or a cube standing on
 *    one of them belongs to it: «Kurtka 300 dona 400 kg 5 kub» and «Shim 200
 *    dona 400 kg 5 kub» state 400 kg and 5 m³ TWICE, and the one-distinct-
 *    value rule read that as one stated total — the truck priced and stored
 *    on one line's cube, the brutto never asked, no «(qatorlardan)» anywhere.
 *    A figure on any other line («Jami 10 kub 800 kg») still answers. One
 *    goods line keeps its figure as the shipment's, as it always did: there
 *    the line IS the shipment.
 *  - **A NETTO weight is not the shipment's brutto** (PF-1). The bot asks the
 *    total as BRUTTO on every freight section (his 2.7 b), and a figure the
 *    text labels netto («Netto 1200 kg», «N.W. 1200 kg») answered that
 *    question — the brutto was never asked and the seller was told «brutto
 *    og‘irlik bor». So a netto figure never fills `weightKg` on a freight
 *    section, nor when no section is named (the reading that asks); on a
 *    customs-only job, where nobody asks a brutto and the reading model is
 *    told to take the netto (`NETTO_ONLY`), it stands as the total when the
 *    text states nothing else — and says so (`weightNetto`), so the row note
 *    and the reply call it netto, never brutto (PF-3).
 *  - **Beside a goods list, a line's figure is the line's** (`goodsBeside`,
 *    as-built review CHAT-3 / CRITIC-2-NEW). When the collection already
 *    holds rows — an Excel, a packing list's totals, a request's stored
 *    lines — ONE typed goods line is no longer the shipment: «Sumka 80 kg»
 *    corrects a row, «Shapka 50 dona 20 kg» names a forgotten good, and a
 *    line addressing a row by its number («3: 150 kg») is that row's. Read as
 *    totals they outranked the packing list's 3500 kg (§1.2.5) and became the
 *    brutto under a ✅ — R3 §0.1(3)'s defect one press earlier. A figure on
 *    any other line («jami 3500 kg», «brutto 3500 kg», «3500 kg») is still a
 *    total there, and so is a lone line that speaks of the whole shipment
 *    («Kurtka va shim jami 3600 kg», «Jami: 3500 kg / 15 kub»: `shipmentLine`,
 *    fix review FR-REGR-1) — what the goods reader calls goods there is a
 *    totals line misread.
 */
export function parseManualFacts(
  text: string,
  section?: CalcSection,
  /**
   * Read only the totals standing at or after this offset (review CONC-2):
   * what the material that came AFTER the seller's totals answer states. The
   * goods lines are still the WHOLE text's — «Shim 50 dona 120 kg» added to
   * a typed list is that line's figure, exactly as in the full reading, and
   * an old «1,200 kg» the answer settled no longer poisons a new «1300 kg».
   *
   * `goodsBeside`: the collection already holds goods rows (above).
   */
  opts: TypedTotalsOpts = {},
): CalcFacts & { ambiguous: AmbiguousTotal[] } {
  return readTypedTotals(text, section, opts).facts;
}

export type TypedTotalsOpts = {
  from?: number;
  goodsBeside?: boolean;
  /**
   * The text IS the answer to the bot's question about the totals (the
   * table's «jami …», line-address.ts `readTotals`): a lone «t» or «g» after
   * a number is then its unit («jami 2 t»), and a tonne beside a count is the
   * shipment's weight, not what one piece is — nothing in an answer about the
   * totals names goods (T14, review JN-9).
   */
  totalsAnswer?: boolean;
} & ClientHintOpts;

/**
 * `parseManualFacts`, with WHERE the figures it took as the two totals stand
 * in the text (`taken`, `[start, end)` spans — a figure with its unit, a label
 * with its figure). For the reader that must account for every figure of an
 * answer (line-address.ts `readTotals`, docs/AI-SORAYDI.md §3.1 T2): what
 * stands outside these spans was read by nobody, and is said — never dropped
 * under a 👍. A doubted field's figures are all taken (the question is about
 * them); two different figures for one field are taken by neither.
 */
export function readTypedTotals(
  text: string,
  section?: CalcSection,
  opts: TypedTotalsOpts = {},
): { facts: CalcFacts & { ambiguous: AmbiguousTotal[] }; taken: [number, number][] } {
  const route = readRoute(text);
  const typed = typedGoods(text, { prefix: opts.prefix });
  const spans = lineSpans(text);
  const onGoodsLine = (start: number) => {
    if (!opts.goodsBeside && typed.figured < 2) return false;
    const line = spans.findIndex(([a, b]) => start >= a && start <= b);
    const lineText = line >= 0 ? text.slice(spans[line]![0], spans[line]![1]) : '';
    if (opts.goodsBeside && line >= 0 && MATERIAL_ROW_ADDRESS.test(lineText)) return true;
    if (!typed.lines.has(line)) return false;
    // Two goods lines keep PF-2's rule. A LONE one is the line's only beside
    // held rows — and never when it speaks of the whole shipment (FR-REGR-1):
    // there the goods reader's «goods name» is a totals line misread.
    return typed.figured >= 2 || !shipmentLine(lineText);
  };
  // A figure that is not the shipment's: a goods line's own, one written
  // before the part of the text being read — or ONE package's or ONE piece's
  // (§3.1 T4, units.ts `packingRead`): «20 karobka, har biri 15 kg», «15
  // kg/ctn», «0.12 cbm/ctn» put one carton's figure in as the whole
  // shipment's, under ✅ and over the model's correct total (DIM-4, dg3-01).
  const from = opts.from ?? 0;
  const perOne = perOneSpans(text, { scaled: true });
  // In order of their starts, which never overlap: the last one starting at or before `start` is the only candidate.
  const onePackage = (start: number) => {
    let lo = 0;
    let hi = perOne.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (perOne[mid]![0] <= start) lo = mid + 1;
      else hi = mid;
    }
    const span = perOne[lo - 1];
    return span !== undefined && start < span[1];
  };
  const notTotal = (start: number) => start < from || onGoodsLine(start) || onePackage(start);
  // What is no amount — a size, a code, a phone — is blanked before a figure
  // is looked for (§3.1 T0): its digits were the thousands of the weight after.
  const scan = blankForTotals(text, clientCodePrefix(opts));
  // Kilos written in tonnes or grams (T14). On a line that states its pieces
  // such a figure is what ONE piece is — a jack's 5 tonnes, a pack's 500
  // grams — exactly as the row kernel reads it (units.ts `parseGoodsLine`).
  const besidePieces = (at: number) => {
    const [a, b] = lineAround(scan, at);
    return PIECES_FIGURE.test(scan.slice(a, b));
  };
  // …unless the line itself speaks of the whole shipment: «jami 2 tonna 300 dona».
  const ofShipment = (at: number) => {
    const [a, b] = lineAround(text, at);
    return shipmentLine(text.slice(a, b));
  };
  const tonnes: ScaledReader[] = [
    { figure: SCALED_FIGURE, when: (at) => opts.totalsAnswer === true || !besidePieces(at) || ofShipment(at) },
    { figure: LONE_SCALED_FIGURE, when: () => opts.totalsAnswer === true },
  ];
  const plain = readNumber(text, scan, KG_FIGURE, KG_LABELLED, (a, b) => notTotal(a) || nettoLabelled(text, a, b), tonnes);
  // Customs-only: the netto stands for the total when nothing else is stated.
  const nettoStands = section !== undefined && !sectionHasFreight(section);
  const netto =
    nettoStands && plain.value === null && !plain.ambiguous
      ? readNumber(text, scan, KG_FIGURE, KG_LABELLED, (a, b) => notTotal(a) || !nettoLabelled(text, a, b), tonnes)
      : { value: null, ambiguous: null, taken: [] };
  const weight = netto.value !== null || netto.ambiguous ? netto : plain;
  const volume = readNumber(text, scan, M3_FIGURE, M3_LABELLED, (a) => notTotal(a));
  const ambiguous: AmbiguousTotal[] = [];
  if (weight.ambiguous) ambiguous.push({ field: 'weightKg', ...weight.ambiguous });
  if (volume.ambiguous) ambiguous.push({ field: 'volumeM3', ...volume.ambiguous });
  return {
    facts: {
      fromCity: route.fromCity,
      toCity: route.toCity,
      weightKg: weight.value,
      volumeM3: volume.value,
      ...(netto.value !== null ? { weightNetto: true } : {}),
      goods: typed.goods,
      ambiguous,
    },
    taken: [...weight.taken, ...volume.taken],
  };
}

/** Does the section price a truck — the totals the bot asks as BRUTTO? */
const sectionHasFreight = (section: CalcSection) => section !== 'rastamojka';

type TotalWeight = Pick<CalcFacts, 'weightKg' | 'weightNetto'>;

/**
 * The shipment's total weight from the two readers — ONE rule for the bot and
 * the thread door (#513).
 *
 * The TYPED figure wins (the person is looking at the material) and carries
 * its own netto flag (`parseManualFacts`). A total the text writes two ways
 * is asked, and the model — which read the same text — does not answer it
 * either. The model's figure answers otherwise, except that a NETTO figure
 * never stands for the brutto a freight section asks (review PF-1, the
 * model's half: `NETTO_ONLY` tells it null there, and a reading that says
 * «netto» anyway is not believed); on a customs job it stands, labelled.
 */
export function totalWeightFrom(
  section: CalcSection,
  typed: TotalWeight,
  read: TotalWeight | null,
  ambiguous: boolean,
): TotalWeight {
  if (typed.weightKg != null) {
    return typed.weightNetto ? { weightKg: typed.weightKg, weightNetto: true } : { weightKg: typed.weightKg };
  }
  if (ambiguous || read?.weightKg == null) return { weightKg: null };
  if (!read.weightNetto) return { weightKg: read.weightKg };
  return sectionHasFreight(section) ? { weightKg: null } : { weightKg: read.weightKg, weightNetto: true };
}

/**
 * A line naming itself a goods line: «Tovar: …», «Товар - …», «Tovar nomi:
 * …», «Tovarlar: …». The label is a WHOLE word (review #25): «Tovarni rasmi»
 * and «Tovarlar» were matched by their first five letters and glued the rest
 * of the word onto a product («lar Kurtka»). The separator is CAPTURED (group
 * 2), and so is whether the label says «the NAME is» (group 1, T7):
 *  - after a NAMING label — «Tovar nomi:», «Наименование:», «Product name:»,
 *    «品名:» — what follows is the product's name, figures or not, a digit
 *    first included («3D принтер»);
 *  - after a plain «Tovar:» / «Товар -» a product with its figures reads as
 *    an unlabelled line does, and a body with NO figure is the product's
 *    name too (R3-T2: «Tovar: kurtka», «Товар: куртка» — the commonest
 *    labelled shape — came back «Tovarlar: —» when T7 asked for a figure),
 *    except a body opening with a number («Mahsulot: 5 kun ichida», «Tovar:
 *    3 xil»);
 *  - after either, what a customer says ABOUT the goods is no product: a
 *    status, a time, a place, a file («Tovar: tayyor», «Товар: в пути»,
 *    «Tovar nomi: hali yo'q», `statusBody`);
 *  - with no separator at all («Tovar синтетическое … 1.1 kub 240 kg», his
 *    screenshot) the line is read as an unlabelled one, the word list
 *    included (R3-T1) — «Tovar keldimi», «Tovar narxi 1200$», «Tovar vazni
 *    1200 kg» are about the goods, never a product.
 */
const GOODS_LABEL =
  /^\s*(?:(tovar(?:lar)?\s*nomi|товар(?:лар|ы)?\s*номи|mahsulot(?:lar)?\s*nomi|махсулот(?:лар)?\s*номи|наименование(?:\s*товара)?|название(?:\s*товара)?|(?:goods|products?)\s*names?|品名)|tovar(?:lar)?|товар(?:лар|ы)?|mahsulot(?:lar)?|махсулот(?:лар)?|goods|products?)(?![\p{L}\p{N}])\s*([:：\-–—])?\s*/iu;

/** A PLURAL plain label — «Tovarlar:», «Товары:», «Goods:» — names several products. */
const PLURAL_LABEL = /^\s*(?:tovarlar|товар(?:лар|ы)|mahsulotlar|махсулотлар|goods|products)(?![\p{L}\p{N}])/iu;

/** A body that is a LIST — «shim, kurtka». A comma between two digits is a decimal («2,5 kub»). */
const LIST_BODY = /[;、，；]|,(?!\d)|(?<!\d),/u;
const LIST_SPLIT = /\s*(?:[;、，；]|,(?!\d)|(?<!\d),)\s*/u;

/**
 * An «and so on» closing a list (round 4, T-r1 ND10): «va hokazo», «va
 * boshqalar», «и т.д.», «и др.», «etc.» name no product, and the split kept
 * them as one («va hokazo», «обувь и т.д»).
 */
const ETC_TAIL =
  /[\s,;]*(?:va\s+hokazo|va\s+boshqa(?:lar)?|и\s+т\.?\s*[дп]\.?|и\s+др\.?|и\s+прочее|etc\.?|and\s+so\s+on)[\s.!]*$/iu;

/**
 * A leading list marker — «1.», «2)», «-», «•» (round 4, T-r2 ND8). A numbered
 * list never read: the line's number was its «first figure» at position 0, so
 * «1. Kurtka 300 dona» named nothing, and R3-T3's give-way then found no
 * other product and kept the carton count as the only one.
 */
const LIST_MARKER = /^(?:\d{1,3}[.)]|[-•*·–—])\s+/u;

/**
 * What a customer says ABOUT the goods under a label (T7, R3-T2, round 4
 * T-r1 ND6 / T-r2 ND7): a status, a time, a place, a reference to a file or
 * a person. Compared lower-cased with every apostrophe dropped («yo'q»,
 * «jo'natildi»).
 *
 * Uzbek says it at the END — «rasmi bor», «hali kelmadi», «Toshkentga
 * ketyapti», «Yiwu skladida», «mijozniki» — so the predicate is read off the
 * LAST word (`STATUS_LAST`, `STATUS_ENDING`, a place or a store in the
 * locative), and a product that only OPENS with such a word stays a product:
 * «Bor kislotasi» is boric acid (T-r2 t12). A Russian or English status
 * opens with its preposition («в пути», «на складе», «см. файл», «in
 * transit», «see attached», «as per invoice»). A body of one word that only
 * points — «shu», «ok» — names nothing, nor a time, a file or a photo alone
 * (`STATUS_ALONE`: «Tovar: ertaga», «Tovar: rasmlar»), nor a body made only of
 * a status's words (`STATUS_COMPANIONS`: «Товар: фото ниже»), nor one opening
 * with the customer's code («GS777 niki»).
 *
 * Narrowed where the round-3 list refused descriptions (T-r1 ND9): no «xil»
 * («har xil kiyimlar» — a variety COUNT opens with its digit, «3 xil»), «rasm»
 * only as the photo itself («rasmli futbolka» is printed), «kun» only as the
 * day («kunlik kiyim», «Kunlik krem», «kungaboqar» are products). The short
 * Russian forms only — «готов», «готовы» say a status; «готовая одежда» is a
 * description.
 *
 * A time, file or photo word refused ANY body until round 4's probe: beside
 * other words it is what the product is — «Rasm ramkalari», «Фото рамка»,
 * «Kun kremi» under «Tovar nomi:» vanished — and a status sentence ends in its
 * predicate anyway: «ertaga yuboraman», «hali yo'q», «Excel faylda». A place
 * closes a status only where the goods ARE or GO (`PLACE_CASES`): where they
 * come FROM is the product's origin, «kiyim Xitoydan».
 */
const STATUS_LAST = new Set([
  'tayyor', 'keldi', 'kelmadi', 'keladi', 'kelyapti', 'ketdi', 'ketmadi', 'jonatildi', 'jonatilmadi', 'bor', 'yoq',
  'yolda', 'omborda', 'skladda', 'berildi', 'olindi', 'yuklandi', 'tushirildi', 'yetdi', 'yetkazildi', 'qoldi',
  'kutilmoqda', 'turibdi', 'turibti', 'emas', 'kerak', 'готов', 'готова', 'готово', 'готовы', 'есть', 'нет',
  'будет', 'знаю', 'ready', 'shipped', 'arrived', 'sent', 'delivered', 'loaded', 'attached',
]);
/** The Uzbek verb forms a status ends in — «kelmagan», «qilingan», «ketyapti», «tekshirildi», «tushirildimi», «yuboraman», «mijozniki». */
const STATUS_ENDING = /(?:magan|ilgan|ingan|yapti|yapdi|moqda|ildi|indi|dimi|raman|taman|laman|ayman|niki)$/u;
/** Where the goods ARE, in the locative — «skladida», «bojxonada», «faylda», «invoysda», «pastda», «mashinada». */
const STORE_LOCATIVE =
  /^(?:sklad|склад|ombor|bojxona|tamojnya|fayl|invoys|excel|pdf|past|yol|mashina|fura|konteyner|dokon)(?:i)?(?:da|dagi|ga|dan)$/u;
/** A place in the locative or the directive — «Guangzhouda», «Toshkentga» (the bare name is a product's origin: «Xitoy choyi»). */
const PLACE_CASES = ['da', 'ta', 'dagi', 'ga', 'ka', 'qa', 'га', 'да'];
const STATUS_ALONE = new Set([
  'qachon', 'когда', 'hali', 'ertaga', 'keyin', 'kecha', 'hafta', 'завтра', 'сегодня', 'вчера', 'пока', 'скоро',
  'позже', 'потом', 'tomorrow', 'later', 'soon', 'фото', 'photo', 'photos', 'excel', 'pdf', 'invoice', 'инвойс',
  'қачон', 'качон', 'ҳали', 'хали', 'эртага', 'кейин', 'кеча', 'ҳафта', 'хафта',
]);
const STATUS_ALONE_STEMS =
  /^(?:(?:rasm|расм)(?:i|ini|lar|lari|ni|larni|da|и|ини|лар|лари|ни|ларни|да)?|kun(?:i|da|dan|ga|lari|larda)?|fayl\p{L}*|файл\p{L}*|invoys\p{L}*|инвойс\p{L}*|приш\p{L}*|отправ\p{L}*|отгруж\p{L}*|загруж\p{L}*|доставл\p{L}*)$/u;
/** A Russian or English status opens with its preposition. */
const STATUS_FIRST = new Set(['в', 'на', 'см', 'in', 'see', 'as', 'per']);
const POINTER_BODY = new Set(['shu', 'bu', 'mana', 'ok', 'ок', 'okay']);

/**
 * The rest of what a status SENTENCE is built of (round-5 probe): a verb of
 * sending, writing or clarifying, an adverb of when or where, a preposition,
 * a pronoun — «завтра скину», «фото ниже», «по инвойсу», «invoys bo'yicha»,
 * «keyin yozaman», «will send photo later». None of them names a product, so
 * a body made of nothing else names none (`statusBody`); one noun among them
 * is the product — «Фото рамка», «Rasm ramkalari», «Рамка для фото». The
 * Russian verbs are spelled out whole, never as stems: «Скинали» are kitchen
 * panels.
 */
const STATUS_COMPANIONS = new Set([
  // Russian
  'ниже', 'выше', 'далее', 'отдельно', 'сразу', 'по', 'согласно', 'как', 'во', 'с', 'со', 'к', 'я', 'мы', 'вы',
  'вам', 'не', 'ещё', 'еще', 'уже', 'будут', 'буду', 'приложении', 'вложении', 'список', 'списку',
  'списке', 'скину', 'скинем', 'скинет', 'скинут', 'скинул', 'скинула', 'кину', 'закину', 'уточню', 'уточним',
  'уточнит', 'уточняется', 'уточнить', 'напишу', 'напишем', 'напишет', 'скажу', 'скажем', 'скажет', 'сообщу',
  'сообщим', 'покажу', 'вышлю', 'вышлем', 'перешлю', 'перешлем', 'перешлём', 'смотрите', 'смотри', 'посмотрите',
  'уточняю', 'уточняем', 'сейчас', 'вечером', 'утром', 'известно', 'личке', 'личку', 'накладной', 'накладная',
  'накладную', 'спецификации', 'спецификация', 'спецификацию',
  // Uzbek, Latin and Cyrillic
  'boyicha', 'buyicha', 'asosida', 'kora', 'binoan', 'keyinroq', 'yuqorida', 'alohida', 'aniq', 'hozir', 'tez',
  'orada', 'men', 'biz', 'sizga', 'boladi', 'бўйича', 'буйича', 'асосида', 'кўра', 'кейинроқ', 'алоҳида', 'аниқ',
  'ҳозир', 'мен', 'биз', 'сизга', 'бўлади', 'булади', 'qarang', 'qaring', 'kechqurun', 'ertalab', 'hozircha',
  'қаранг', 'кечқурун', 'эрталаб', 'ҳозирча',
  // English
  'will', 'shall', 'send', 'sending', 'be', 'to', 'the', 'i', 'we', 'you', 'by', 'below', 'above', 'follow',
  'follows', 'following', 'separately', 'according', 'confirm', 'confirmed', 'advised', 'provided', 'list', 'tbd',
  'tba', 'not', 'yet', 'known', 'unknown', 'pending',
]);
/**
 * An Uzbek verb in its finite first person — «yozaman», «tashlayman»,
 * «yubordim», «юбораман» (never «-adi»: «shokoladi» is a noun). It ENDS a
 * sentence of two words or more, «kecha yubordim», «keyin yozaman»: alone the
 * ending is also a noun's, «Бодик», «Sandik», «Медик».
 */
const UZ_FINITE_VERB = /^\p{L}{2,}(?:aman|ayman|amiz|dim|dik|аман|айман|амиз|дим|дик)$/u;
/** A Chinese status — «见附件», «详见发票», «待定», «稍后发送» — written with no space to split it by. */
const HAN_STATUS =
  /^(?:(?:详|请|参)?见(?:附件|发票|清单|图片|照片|下图|下表|表格)|待定|后补|另附|(?:稍后|明天|随后)(?:发送?|提供|告知|补充))$/u;

const statusWord = (w: string) =>
  STATUS_ALONE.has(w) ||
  STATUS_ALONE_STEMS.test(w) ||
  STATUS_FIRST.has(w) ||
  POINTER_BODY.has(w) ||
  STATUS_LAST.has(w) ||
  STATUS_ENDING.test(w) ||
  STATUS_COMPANIONS.has(w);

function statusBody(body: string, prefix: string | null): boolean {
  const raw = body.split(/[\s,;:!()]+/u).filter(Boolean);
  if (raw.length > 0 && prefixCode(raw[0]!.replace(/[.,]+$/u, ''), prefix)) return true;
  if (HAN_STATUS.test(body.trim().replace(/[。.!！]+$/u, ''))) return true;
  const words = body
    .toLowerCase()
    .replace(/[’ʻʼ‘`´']/gu, '')
    .split(/[\s,.;:!()]+/u)
    .filter(Boolean);
  if (words.length === 0) return false;
  const last = words.at(-1)!;
  if (STATUS_FIRST.has(words[0]!)) return true;
  const verbLast = words.length > 1 && UZ_FINITE_VERB.test(last);
  if ((verbLast ? words.slice(0, -1) : words).every(statusWord)) return true;
  if (STATUS_LAST.has(last) || STATUS_ENDING.test(last) || STORE_LOCATIVE.test(last)) return true;
  return PLACE_CASES.some((e) => last.length > e.length && last.endsWith(e) && placeWord(last.slice(0, -e.length)));
}

/**
 * The carton nouns that are also products (T6/T12): «Korobka 1000 dona» is a
 * thousand boxes for sale, «Karobka: 45 ta» is how many cartons the goods
 * came in — a FIELD, the name followed by its separator — and so is a carton
 * noun beside a count or total word, «Karobka soni 45 ta», «Количество
 * коробок 45 шт», «Jami karobka 45 ta» (R3-T3).
 */
const CARTON_NOUNS = new Set([
  'karobka', 'karopka', 'korobka', 'коробка', 'коробки', 'коробок', 'qop', 'quti', 'кути', 'box', 'boxes', 'carton',
  'cartons', 'karobkalar', 'korobkalar', 'qoplar', 'qutilar',
]);
const FIELD_SHAPED = /^[\p{L}\s'’‘ʻ`-]+[:：]/u;

/** A word as the field lists hold it: lower-cased, every apostrophe dropped. */
const fieldKey = (word: string) => word.toLowerCase().replace(/[’ʻʼ‘`´']/gu, '');

/**
 * The measure fields of a goods line — its weight, volume, count, total — in
 * the possessive a label puts them in, or as the word before the figure it
 * names («вес 500 кг», «jami 800 kg», «weight 500 kg»).
 */
const MEASURE_FIELDS = new Set([
  'vazni', 'vazn', 'ogirligi', 'ogirlik', 'hajmi', 'hajm', 'soni', 'miqdori', 'miqdor', 'вес', 'весом', 'объем',
  'объём', 'обьем', 'количество', 'кол-во', 'jami', 'umumiy', 'brutto', 'netto', 'итого', 'всего', 'weight',
  'volume', 'qty', 'quantity',
]);

/**
 * A word after which a space-grouped number is ONE number (units.ts
 * `groupedReading`, review JN-6): a measure field or a totals word — «vazni 1
 * 200 kg», «jami 1 200 kg», «faktik 1 200 kg» — the cargo itself («yuk 1 200
 * kg», `SHIPMENT_HEAD`), or a word that only modifies the figure
 * («taxminan»). After any other word the first group may be that word's
 * count or model («stul 20 300 kg»), and both readings are asked.
 */
function figureLabel(word: string): boolean {
  return (
    MEASURE_FIELDS.has(fieldKey(word)) ||
    SHIPMENT_WORD.test(word) ||
    SHIPMENT_HEAD.has(word.toLowerCase()) ||
    APPROX_WORD.test(word)
  );
}

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
 * A person, a contact or a document beside ten BARE digits (R3-T4): «Murod
 * aka 8901234567», «Murojaat uchun 8901234567», «Shartnoma 2026100001»,
 * «Buyurtma 1234567890». The contact FIELDS are whole words with their
 * possessive endings — «telefon», «telefonim», «raqami», «номер» — never a
 * stem (round 4, T-r1 ND2 / T-r2 ND4): «Telefonlar 8517130000», «Raqamli
 * kamera 8525890000», «Счётчики 9028301100», «Nomerli qulf 8301400000» are
 * phones, a camera, meters and a lock with their codes, and «karta» / «phone»
 * are products themselves («SIM karta», «Phone case»). Only the person, the
 * document and the request words keep their stems («shartnomasi», «заказа»).
 *
 * A contact field is read in its CASES too (round-4 probe): «по номеру»,
 * «raqamga», «telefoniga» say where a number goes, as no plural («-lar»,
 * «-чики») or adjective («-li») does. But a TELEFON with no owner, in the
 * case that says what a product is for or whose part it is, BEFORE A NOUN is
 * the product's phone — «Telefonga chexol», «Telefonning chexoli», «Telefonni
 * ushlagich» (round-5 probe, `CONTACT_BARE_CASE`); at the end of the name or
 * before a verb («Telefonga yozing») it is still where the number goes, and so
 * is a raqam or a nomer, which has no parts and is for nothing («Raqamning
 * egasi», «Номерга звонить»); the phone's OWNER is a person beside the number
 * («Telefonning egasi Ali», `CONTACT_FIELD`). A hyphenated word is a contact
 * word when its FIRST part is («счёт-фактура»); after the hyphen a contact
 * field is the product the word names, «Mobil-telefon». In English the field
 * is a phrase — «contact phone», «phone number», «my number» — since «phone»
 * alone is the product of «Phone case».
 */
const CONTACT_FIELD = new Set([
  'aka', 'akam', 'akasi', 'akamiz', 'opa', 'opam', 'opasi', 'uka', 'ukam', 'ukasi', 'egasi', 'эгаси',
]);
const CONTACT_FORMS =
  /^(?:tel|tlf|тел|schet|(?:telefon|raqam|nomer)(?:i|im|imiz|ingiz)?(?:ga|da|dan|ni|ning)?|(?:телефон|рақам|номер)(?:и|им|имиз|ингиз)?(?:га|да|дан|ни|нинг)?|(?:телефон|номер|сч[её]т)(?:а|у|ом|е)?)$/u;
const CONTACT_BARE_CASE = /^(?:telefon(?:ga|ni|ning)|телефон(?:га|ни|нинг))$/u;
/**
 * A verb — Uzbek imperative, infinitive or finite, «yozing», «qiling»,
 * «tashlang», «yozish», «юборинг», or the Russian one a mixed line borrows,
 * «Телефонга звонить», «позвоните».
 */
const VERB =
  /(?:ing|ng|ngiz|nglar|gin|sin|moq|ish|aman|ayman|adi|ydi|инг|нг|нгиз|син|моқ|иш|аман|ади|ить|ать|ять|еть|ите|йте)$/u;
const CONTACT_STEM = /^(?:murojaat|shartnoma|buyurtma|договор|заказ|contract)/u;
const CONTACT_PHRASE = /(?:^|\s)(?:(?:contact|my|our)\s+(?:phone|number|tel)|phone\s+(?:number|no))(?:\s|$)/u;
/** Is the word at `at` of a name's words a contact word? */
function contactWord(words: readonly string[], at: number): boolean {
  const word = words[at]!;
  const after = words.slice(at + 1);
  if (CONTACT_BARE_CASE.test(word)) return after.length === 0 || after.some((w) => VERB.test(w));
  if (CONTACT_FIELD.has(word) || CONTACT_FORMS.test(word) || CONTACT_STEM.test(word)) return true;
  const parts = word.split(/[-–]/u).filter(Boolean);
  return parts.length > 1 && contactWord([parts[0]!], 0);
}

/**
 * Is a code-only line's code ten digits written BARE — no dots, no spaces, no
 * label? Only then can it be somebody's number; «6201.93.00.00», «6201 93
 * 0000» and «tnved 6201930000» keep T11's acceptance.
 */
function bareTenDigits(body: string): string | null {
  const found = codeIn(body);
  if (!found) return null;
  const span = body.slice(found.start, found.end);
  return /^\d{10}$/u.test(span) ? span : null;
}

/**
 * May ten bare digits after a name be its TNVED code (R3-T4)? T11 took any
 * ten, so a contact line in the material — a phone written with its trunk 8,
 * a Russian mobile, an order number — became a product with a code, and the
 * queued AI prefill coded it. Refused: a run opening 89 (an Uzbek mobile with
 * its 8 — and chapter 89, ships, is not this cargo), a line naming a person,
 * a contact or a document (`contactWord`), and a run that opens no real
 * heading. NOT every 8… or 9…: 84/85 (machinery, phones 8517) and 94/95
 * (furniture 9403, toys 9503) are this business's commonest codes. Left: a
 * Russian or Kazakh mobile after a bare first name, «Иван 9161234567» (91-61
 * reads as a heading) — the residue R3-T4 states, pinned so; the model and
 * the VED's eyes catch that one. The heading test here is R3-T4's (chapter
 * 01-97, no xx00), not the book's last heading the WRITTEN forms obey
 * (`opensRealHeading`), which would refuse that line against the decision.
 */
function bareCodeOk(code: string, words: string[]): boolean {
  if (code.startsWith('89') || !/^(?:0[1-9]|[1-8]\d|9[0-7])(?:0[1-9]|[1-9]\d)/u.test(code)) return false;
  const keys = words.map(fieldKey);
  return !keys.some((_, i) => contactWord(keys, i)) && !CONTACT_PHRASE.test(keys.join(' '));
}

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

/**
 * The letters of a code written with a hyphen — «YW-123», «B-00066» — in a
 * line's text: the kernel reads «-123» as a bare count, so «Partiya YW-123 12
 * kub» was the product «Partiya YW» × 123 (round 1, #24). As a word of the
 * name, such letters are that code's.
 */
function gluedCodeLetters(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\p{L}\d])(\p{L}{1,4})[-–]\d{1,8}(?![\p{L}\d])/gu)) out.add(m[1]!.toLowerCase());
  return out;
}

/** A client code on its own — glued, spaced or hyphenated («GS777», «GS 777», «GS-777»). */
const CLIENT_CODE_LINE = /^[A-Za-z]{1,4}\s*[-–]?\s*\d{1,8}$/;

/**
 * One line as the bot's TYPED readers read it: the row kernel, asked for the
 * tonnes and grams too (units.ts `parseGoodsLine`'s `scaled`, §3.1 T14), and
 * for what the line states per package (`packing`, T4/T6). The card form, the
 * VED's paste box and a sheet's cells call the kernel bare and read what they
 * always read (review JR-22).
 */
const typedLine = (text: string) => parseGoodsLine(text, { scaled: true, packing: true });

// ── a supplier's line as the typed reader reads it (§3.1 T8, T12) ──────────
//
// A forwarder writes the goods as the trade does — «Stol - 10ctn - 150kg -
// 1.2cbm», «LED lamp 3000pcs/15ctns/507kgs/5.92cbm», «Stul 20 ctns G.W. 300
// kgs», «Kurtka 300 dona 150 kg 5 meshok». The goods test wanted every token
// after the first figure to be a figure or a unit word it knew, so a dash, a
// label or one unknown word dropped the whole line — «Tovarlar (0)» — and its
// lone «150 kg» was then taken for the shipment's (dg3-09). The line is read
// instead for what it holds, and what it holds and nobody can read is kept on
// the row's note, never lost and never guessed:
//
//  1. a field label standing before its figure — «G.W.», «N.W.:», «Qty:»,
//     «MEAS», «箱数», «Кол-во:» — labels the figure and is no word of the name;
//     a weight's label says which weight. A figure the label alone would give
//     a unit to is read only where review JN-21 lets a total be (an
//     unambiguous label and a «:» or «=»); otherwise it is set aside;
//  2. a dash, a bar or a slash between two figure groups separates them;
//  3. a number and one word no vocabulary knows, AFTER the line's first figure
//     with a unit — «5 meshok», «2 xil» — is kept aside for the note. BEFORE
//     it the pair is the name's, as the kernel reads it — «iPhone 15 Pro 300
//     dona», «Samsung A54 128 GB 50 dona».
//
// And a supplier's SPEC BLOCK is ONE good (T12): a NAME label opens it, and
// the field lines under it — until a blank line, the next name or a line that
// is no field — are its figures, read as one line with the name first.

type FieldKind = 'weight' | 'volume' | 'cartons' | 'count';

/**
 * The field labels of units.ts §2.4 that a figure follows: a weight's, a
 * cube's, a package count's, a piece count's. A size's labels are the
 * kernel's — `packingRead` decides by them whose a size is, and takes them
 * out of the name itself.
 */
const FIELD_KIND_LABELS: readonly [FieldKind, readonly string[]][] = [
  ['weight', [...WEIGHT_LABELS, ...NET_LABELS]],
  ['volume', VOLUME_LABELS],
  ['cartons', FIELD_LABELS.cartons],
  ['count', FIELD_LABELS.count],
];
const FIELD_KIND_EXACT = FIELD_KIND_LABELS.map(([kind, labels]) => [kind, new RegExp(`^(?:${labelPattern(labels)})$`, 'iu')] as const);
/** The labels a figure needs no unit after — when a «:» or «=» stands between (review JN-21). */
const UNIT_FREE_EXACT = {
  weight: new RegExp(`^(?:${labelPattern([...UNIT_FREE_LABELS.weightKg, ...UNIT_FREE_LABELS.netKg])})$`, 'iu'),
  volume: new RegExp(`^(?:${labelPattern(UNIT_FREE_LABELS.volumeM3)})$`, 'iu'),
};

/**
 * A field label right before a figure. Never glued to a digit or a letter on
 * its left — a Han label may follow a Han name, as no name is spelled into
 * one. Group 1: the label; 2: the «:» / «=» between, if any.
 */
const FIELD_BEFORE_FIGURE = new RegExp(
  String.raw`(?<!\d)(?<!(?!\p{Script=Han})\p{L})(${labelPattern(FIELD_KIND_LABELS.flatMap(([, l]) => l))})${GAP}[.)]?${GAP}([:：=])?${GAP}(?=\d)`,
  'giu',
);
/** The figure after a label: its number, and the word after it. */
const FIGURE_AT = new RegExp(String.raw`^(${AMOUNT_NUMBER})(?!\d)(?:${GAP}([\p{L}²³][\p{L}\d²³.]*))?`, 'iu');
/** `FIELD_BEFORE_FIGURE` at one place: the next field of a spec line, its label and its own figure. */
const FIELD_HERE = new RegExp(String.raw`${GAP}(?:${FIELD_BEFORE_FIGURE.source})`, 'iuy');

/**
 * Does the next FIELD of a spec line start at `at` — a label with a figure of
 * its own («20 G.W.: 15 kg», «20 毛重 15kg/箱»)? Then the word there is no unit
 * of the figure before it: «Cartons: 20 G.W.: 15» is twenty cartons.
 */
function fieldAt(text: string, at: number): boolean {
  FIELD_HERE.lastIndex = at;
  return FIELD_HERE.test(text);
}
/** A figure followed by a slash and a word, or by «per …»: ONE package's or ONE piece's — the kernel's mark to read. */
const PER_ONE_AFTER = /^\s*\/\s*\p{L}|^\s+(?:per|pr)\s/iu;

/** What a weight or cube word is, in this reader's terms: a unit `SellerUnit`, a tonne or gram as `kg`, else null. */
const unitOrScaled = (word: string | undefined): string | null => {
  if (!word) return null;
  return unitOf(word) ?? (scaledKg(word)?.lone === false ? 'kg' : null);
};

const FIELD_FITS: Record<FieldKind, (unit: string) => boolean> = {
  weight: (u) => u === 'kg',
  volume: (u) => u === 'm3',
  cartons: (u) => u === 'karobka',
  count: (u) => u !== 'kg' && u !== 'm3',
};
/** The unit a bare figure takes from its label, written after it for the kernel to read. */
const FIELD_UNIT: Record<FieldKind, string> = { weight: 'kg', volume: 'm3', cartons: 'karobka', count: 'dona' };

interface LineFields {
  /** The line for the kernel: labels blanked, a label's unit written after its bare figure. */
  text: string;
  /** What the line states and nobody reads — as written, for the row's note. */
  aside: string[];
  /** WHICH weight the line's own weight is, when its label said. */
  weightKind: 'gross' | 'net' | null;
}

interface Edit {
  start: number;
  end: number;
  /** Replacement — a blank of the span's length unless said. */
  with?: string;
}

/** `text` with non-overlapping edits applied, each span blanked unless it says what replaces it. */
function applyEdits(text: string, edits: readonly Edit[]): string {
  const parts: string[] = [];
  let at = 0;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    if (e.start < at) continue;
    parts.push(text.slice(at, e.start), e.with ?? BLANK.repeat(e.end - e.start));
    at = e.end;
  }
  parts.push(text.slice(at));
  return parts.join('');
}

/**
 * Step 1: the field labels before their figures (above). `fields`: where a
 * spec block's field lines start in `text` — a label opening its own line is
 * a field however it is written («Soni 300»).
 */
function readFieldLabels(text: string, fields: readonly number[] = []): LineFields {
  const edits: Edit[] = [];
  const aside: string[] = [];
  const weights: { kind: 'gross' | 'net' | null; label: Edit; figure: Edit; written: string }[] = [];
  const money = CURRENCY.test(text);
  // Before the line's first figure a label is the NAME's word, as it always
  // was («Kurtka umumiy vazni 150 kg», «Qop soni 20 ta» — a places count) —
  // unless it is written as a field, with its «:» or «=» («Qty: 200 pcs»).
  const head = firstFigure(text);
  for (const hit of text.matchAll(FIELD_BEFORE_FIGURE)) {
    const label = hit[1]!;
    const labelStart = hit.index;
    const figureStart = labelStart + hit[0].length;
    const colon = hit[2] !== undefined;
    if (figureStart <= head && !colon && !fields.includes(labelStart)) continue;
    const read = FIGURE_AT.exec(text.slice(figureStart));
    if (!read) continue;
    const numberEnd = figureStart + read[1]!.length;
    // The word after the figure is the next field's label, not the figure's unit.
    const bare = read[2] !== undefined && fieldAt(text, numberEnd);
    const word = bare ? undefined : read[2];
    const figureEnd = bare ? numberEnd : figureStart + read[0].length;
    const unit = unitOrScaled(word);
    const labelEdit: Edit = { start: labelStart, end: figureStart };
    const written = text.slice(labelStart, figureEnd).replace(/\s+/gu, ' ').trim();
    // A label that is a unit word of its own — «CBM: 5.92», «Cartons: 20», «Мест: 20».
    const own = unitOf(label);
    if (own !== null) {
      if (word !== undefined) continue;
      // Written after its figure — «5.92 CBM», «20 Cartons» — the way the
      // kernel reads every unit: as a field before it, «200 pcs Cartons: 20»
      // was read as 200 cartons by the counter-then-unit rule («120 ta juft»).
      if (colon || own === 'karobka') {
        edits.push(labelEdit, { start: numberEnd, end: numberEnd, with: ` ${label}` });
      } else {
        // «CBM 2.5»: no «:», so no cube (JN-21) — kept aside.
        edits.push({ start: labelStart, end: figureEnd });
        aside.push(written);
      }
      continue;
    }
    const kind = FIELD_KIND_EXACT.find(([, exact]) => exact.test(label.replace(/\s+/gu, ' ').trim()))?.[0];
    if (kind === undefined) continue;
    // A figure the kernel marks one package's or one piece's keeps its label: the mark reads it.
    if (unit !== null && PER_ONE_AFTER.test(text.slice(figureEnd, figureEnd + 32))) continue;
    if (unit !== null && !FIELD_FITS[kind](unit)) continue;
    if (unit === null && word !== undefined) continue;
    if (unit === null) {
      const unitFree = (kind === 'weight' || kind === 'volume') && UNIT_FREE_EXACT[kind].test(label.replace(/\s+/gu, ' ').trim());
      const takesUnit = kind === 'cartons' || kind === 'count' || (unitFree && colon && !money);
      if (!takesUnit) {
        edits.push({ start: labelStart, end: figureEnd });
        aside.push(written);
        continue;
      }
      edits.push(labelEdit, { start: numberEnd, end: numberEnd, with: ` ${FIELD_UNIT[kind]}` });
    } else {
      edits.push(labelEdit);
    }
    if (kind === 'weight') {
      weights.push({ kind: weightLabelKind(label), label: labelEdit, figure: { start: figureStart, end: figureEnd }, written });
    }
  }
  // A brutto beside a netto: the row's weight is the netto (customs), and the
  // brutto is set aside for the note — both on one line were two weights of
  // ONE unit, and the line was dropped as two lines welded into one.
  let weightKind: LineFields['weightKind'] = null;
  const kinds = new Set(weights.map((w) => w.kind));
  if (weights.length === 1) weightKind = weights[0]!.kind;
  else if (weights.length === 2 && kinds.has('gross') && kinds.has('net')) {
    const gross = weights.find((w) => w.kind === 'gross')!;
    const at = edits.indexOf(gross.label);
    if (at >= 0) edits.splice(at, 1);
    edits.push({ start: gross.label.start, end: gross.figure.end });
    aside.push(gross.written);
    weightKind = 'net';
  }
  return { text: applyEdits(text, edits), aside, weightKind };
}

/**
 * Step 2: a dash, a bar or a slash between two figure groups — after a unit
 * word, before the next number: «10ctn - 150kg», «3000pcs/15ctns». A hyphen
 * only with a space on each side («XJ-200» is a model), a slash only before a
 * digit («15 kg/ctn» is one carton's, «1/2» a fraction).
 */
const FIGURE_SEPARATOR = /(?<=[\p{L}²³.])(?:[ \t]*[–—|][ \t]*|[ \t]+-[ \t]+|[ \t]*\/[ \t]*)(?=\d)/gu;

/** A word that is no unit and no name either: a times sign, a code's word. */
const NOT_A_PAIR_WORD = /^(?:[xх×*]|kod|код|tnved|тнвэд|hs)$/iu;

/** Step 3: the number-and-word pairs after the first figure with a unit — kept aside, out of the row. */
function setAsidePairs(text: string): { text: string; aside: string[] } {
  const spans = amountsIn(text);
  const first = spans.findIndex((s) => unitOrScaled(s.word ?? undefined) !== null);
  if (first < 0) return { text, aside: [] };
  const edits: Edit[] = [];
  const aside: string[] = [];
  for (const s of spans.slice(first + 1)) {
    if (s.word === null || unitOrScaled(s.word) !== null || !pairWord(s.word)) continue;
    // «Мест: 20 Вес брутто: 15 кг/место» — the word is the next field's label.
    if (fieldAt(text, s.start + s.number.length)) continue;
    // «1/2 dyuym» — the number is a fraction's, and the pair no pair at all.
    if (/\d[ \t]*\/[ \t]*$/u.test(text.slice(Math.max(0, s.start - 8), s.start))) continue;
    edits.push({ start: s.start, end: s.end });
    aside.push(text.slice(s.start, s.end).replace(/\s+/gu, ' ').trim());
  }
  return { text: applyEdits(text, edits), aside };
}

/** A typed line as the goods reader reads it — steps 1-3 above, the first figure's position deciding where step 2 starts. */
function lineFields(body: string, fields: readonly number[] = []): LineFields {
  const labelled = readFieldLabels(body, fields);
  const at = firstFigure(labelled.text);
  const separated = at < 0 ? labelled.text : labelled.text.slice(0, at) + labelled.text.slice(at).replace(FIGURE_SEPARATOR, (m) => BLANK.repeat(m.length));
  const pairs = setAsidePairs(separated);
  return { text: pairs.text, aside: [...labelled.aside, ...pairs.aside], weightKind: labelled.weightKind };
}

/**
 * The note a typed row carries for what it states per one and nobody can
 * place — «har biri 2 kg» beside a piece AND a carton count with neither
 * nearest, «20 x 15 kg» with no carton word: off every column, never lost.
 */
const asideNote = (aside: readonly string[] | undefined): string | null =>
  aside && aside.length > 0 ? `sotuvchi: ${aside.join(', ')}` : null;

/**
 * A goods row from the kernel's reading, its packing multiplied out by the
 * ONE carton arithmetic (carton-math.ts `applyPacking`, docs/AI-SORAYDI.md
 * §2.3): «Stul 20 karobka, har biri 15 kg» is 300 kg «hisoblangan», never 15
 * — and never multiplied here. A packing with no carton count computes
 * nothing, and the row asks for what it lacks (T4: the question is the
 * table's, release 1b).
 */
function typedRow(name: string, parsed: GoodsLine, fields?: Pick<LineFields, 'aside' | 'weightKind'>): TypedGoods {
  const row: TypedGoods = {
    ...figureless(name),
    quantity: parsed.quantity,
    weightKg: parsed.weightKg,
    volumeM3: parsed.volumeM3,
    measureUnit: parsed.measureUnit,
    measureQty: parsed.measureQty,
    tnvedCode: parsed.tnvedCode,
    // What the line holds and nobody reads (T8) beside what it states per one and nobody can place.
    note: asideNote([...(fields?.aside ?? []), ...(parsed.aside ?? [])]),
    // «G.W. 300 kgs»: the label said which weight the row's own is (customs wants netto).
    ...(fields?.weightKind && parsed.weightKg !== null ? { weightKind: fields.weightKind } : {}),
  };
  return parsed.packing ? applyPacking({ ...row, packing: parsed.packing }).line : row;
}

/** A tonne or a gram in a spelling that can be nothing else — a unit word to the typed readers. */
const scaledWord = (word: string) => scaledKg(word)?.lone === false;
/** Such a figure standing in a NAME — «Domkrat 5 tonna», «chay 500 gr» — number and word. */
const SCALED_IN_NAME = new RegExp(String.raw`(?<![\p{L}\d.,])\d[\d.,]*${GAP}(?:${scaledPattern('words')})(?![\p{L}\d])`, 'giu');

/** A tail's tokens: split on spaces, separators and what `figureTail` set aside. */
const TAIL_SPLIT = new RegExp(`[\\s,;/+${BLANK}]+`, 'u');

/** The size words a typed size stands beside — «o‘lchami», «razmeri», «carton size» (units.ts `FIELD_LABELS`). */
const SIZE_WORDS_BEFORE = new RegExp(
  String.raw`(?<![\p{L}])(?:${labelPattern([...FIELD_LABELS.packageSize, ...FIELD_LABELS.size])})\s*[.:：=]?\s*(?=${BLANK})`,
  'giu',
);

/**
 * A tail as the figure test reads it (§3.1 T4/T6): what a typed line states
 * per package — a mark («har biri», «dan», «per ctn»), a times sign, the
 * per-one figure itself — and every size with the words that name it, set
 * aside. «Stul 20 karobka, har biri 15 kg» and «Kurtka 300 dona 60x40x50 sm
 * 20 karobka» were no goods lines at all (DIM-10): a mark and a size were
 * words of nothing the test knew. `perOne`: a per-one figure stood there —
 * a measure of the goods; `sized`: a size did.
 */
function figureTail(tail: string): { text: string; perOne: boolean; sized: boolean } {
  const read = packingRead(tail, { scaled: true });
  const text = blankSpans(tail, read.consumed);
  const unsized = blankSizes(text);
  return {
    text: unsized.replace(SIZE_WORDS_BEFORE, (m) => ' '.repeat(m.length)),
    perOne: read.figures.some((f) => !f.inName),
    sized: read.size !== null || unsized !== text,
  };
}

/**
 * The tail of an unlabelled line: every token a figure, a unit word or a code
 * word, and — when `measured` is asked — at least ONE unit that is not a
 * carton (review #24). A bare trailing number is not a goods line — «Tel 90
 * 123 45 67», «Kurs 12650», «Sana 21.10.2026», «Partiya YW-123» were read as
 * products with that number as their count — and a carton count alone states
 * no measure of the goods. A carton count beside a size or a figure of one
 * carton does (T4/T6: the cube and the weight are its arithmetic) — «Kurtka
 * 45 karobka» alone still names nothing a table can price (c0649).
 */
function unitFigures(tail: string, opts: { measured: boolean } = { measured: true }): boolean {
  const read = figureTail(tail);
  // A fraction is ONE token — «1/2 dyuym» is a size, never a «2 dyuym» pair.
  const tokens = read.text.replace(FRACTION, FRACTION_MARK).split(TAIL_SPLIT).filter(Boolean);
  let measured = read.perOne;
  let cartons = false;
  let afterNumber = false;
  for (const token of tokens) {
    // What a set-aside label leaves behind — its «:», its «=» (`lineFields`).
    if (/^[:：=]+$/u.test(token)) continue;
    if (token === FRACTION_MARK) {
      afterNumber = false;
      continue;
    }
    const number = /^\d[\d.,'’ʼʻ]*$/u.test(token);
    const wasAfterNumber = afterNumber;
    afterNumber = number;
    if (number) continue;
    const glued = /^(\d[\d.,]*)([\p{L}²³]+\.?)$/u.exec(token);
    const unit = unitOf(token) ?? (glued ? unitOf(glued[2]!) : null);
    if (unit !== null) {
      if (unit !== 'karobka') measured = true;
      else cartons = true;
      continue;
    }
    // «Sement 2 tonna», «Zafaron 500gr»: kilos in another scale (T14).
    if (scaledWord(token) || (glued && scaledWord(glued[2]!))) {
      measured = true;
      continue;
    }
    if (/^(?:kod|код|tnved|тнвэд|hs)$/iu.test(token)) continue;
    // A number and ONE word no vocabulary knows (T8) — «15 Pro», «128GB», «2
    // xil» — a model's or a variety's, the name's as the kernel reads it; one
    // after the figures was set aside for the note (`lineFields`). Never a
    // currency (a price is no word of a name) and never a second word.
    if ((wasAfterNumber || glued) && pairWord(glued ? glued[2]! : token)) continue;
    return false;
  }
  return measured || (read.sized && cartons) || !opts.measured;
}

/** «1/2», «3/4» — two numbers a slash makes one, read as one token by the figure test. */
const FRACTION = /(?<![\d.,])\d+[ \t]*\/[ \t]*\d+(?![\d.,])/gu;
const FRACTION_MARK = '\u2044';

/** The word of a number-and-word pair: letters only, no currency, no times sign or code word. */
const pairWord = (word: string) => /^\p{L}[\p{L}'’ʻ‘`-]*$/u.test(word) && !NOT_A_PAIR_WORD.test(word) && !CURRENCY.test(word);

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
  return at > 0 && unitFigures(body.slice(at), { measured: false }) && typedLine(body).tnvedCode !== null;
}

/**
 * «Guangzhou - Toshkent 12 kub 3500 kg»: two place names joined by a dash and
 * only the shipment's totals after them is the ROUTE (review #22), which
 * `readRoute` does not trust from a hyphen alone. A product with a dash in it
 * states a count or a pair («Futbolka - oq 300 dona»), so it never reaches
 * this test, and «Coca-Cola» has no spaces round its hyphen.
 */
const DASH_ROUTE = /^\p{Lu}[\p{L}']*(?:\s+[-–—]\s+|\s*[–—]\s*)\p{Lu}[\p{L}']*$/u;

type TypedGoods = NonNullable<CalcFacts['goods']>[number];

const PROBLEM_KINDS = new Set(['ambiguous', 'repeated', 'two_pairs']);

/**
 * A problem the typed reader cannot make a row over. NOT a space-grouped
 * number that is asked («Kurtka 1 200 dona», «stul 20 300 kg» — review
 * JN-6): the name is certain and only that figure is not, so the row stands
 * without it and the table asks the row for it, as for any missing figure.
 * Dropping the line took the product with it, on the commonest way a count
 * over 999 is typed.
 */
const unsettled = (p: GoodsLineProblem) => PROBLEM_KINDS.has(p.kind) && !(p.kind === 'ambiguous' && p.grouped === true);

/** A name's edges trimmed — «：» too, the full-width colon a Chinese list writes (R3-T8), and a list's bullet. */
const tidyName = (name: string) =>
  name
    // What the reader set aside (a label, a separator — `lineFields`) is no part of the name.
    .replace(/\uE000+/gu, ' ')
    .replace(/^[\s:：\-–—.,•·*|]+|[\s:：\-–—.,•·*|/]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();

/** A name's words, lower-cased; a dotted abbreviation of single letters is ONE word («N.W.» → «nw»). */
const wordsOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/(?<!\p{L})(\p{L})\.(?=\p{L}(?!\p{L}))/gu, '$1')
    .split(/[\s,.;:：()]+/u)
    .filter(Boolean);

/**
 * A name's words with every size set aside (T6): a size kept in a name
 * («Stol 120x80x100 sm») describes the product and names nothing — a name of
 * nothing but a size and a label («Dims 60x40x50 cm») is no product.
 */
const nameWords = (name: string) => wordsOf(blankSizes(name).split(BLANK).join(' '));

/** At least two letters, and not a name made only of total, field or greeting words. */
const nameOk = (name: string) => (name.match(/\p{L}/gu) ?? []).length >= 2 && !nameWords(name).every(notGoodsWord);

const figureless = (name: string): TypedGoods => ({
  name: name.slice(0, 200),
  quantity: null,
  weightKg: null,
  volumeM3: null,
  measureUnit: null,
  measureQty: null,
  tnvedCode: null,
  note: null,
});

/**
 * A labelled body with no figure that vouches for it (R3-T2). With no figure
 * the words are the only evidence, so a name made only of not-goods words is
 * refused here too («Tovar: jami», «Tovar: yana»), although a FIGURED labelled
 * line skips the list (T6: «Tovar: Total 200 litr» is a motor oil).
 *
 * A body with no unit word and no code is a NAME, exactly as typed: a bare
 * number in it is no figure (#24 — «Tovar: Kurtka 1200» may be a count or a
 * price, and a guess there lands in the quantity column), so «Название:
 * iPhone 15» stays «iPhone 15» and never «iPhone» × 15. A comma list:
 *  - under a PLURAL plain label is several products — «Mahsulotlar: shim,
 *    kurtka» → shim, kurtka, each a figure-less name;
 *  - under a singular or a naming label is ONE name, its commas kept —
 *    «Наименование: Куртка женская, зимняя» is one jacket, and «Tovar:
 *    kurtka, shim» is what the seller typed, never «kurtka shim».
 * A body that states units but is not a name followed by figures («Tovar:
 * kurtka 300 dona qora rangda», «Tovar nomi: 300 dona kurtka») is the
 * kernel's reading, refused when the kernel cannot settle it — and when its
 * figures are not ONE run (round 4, T-r1 ND4): «Tovar: kurtka 300 dona, shim
 * 150 kg» is two products, and the kernel welded them into «kurtka shim» with
 * the jackets' count and the trousers' weight. Under a PLURAL label the list
 * is split and every piece read on its own — a name and its figures, or a
 * figure-less name — or nothing is read (`listPiece`).
 *
 * A body opening with a digit is a time or a count under a plain label
 * («Mahsulot: 5 kun ichida», «Tovar: 3 xil»); after a NAMING label it is the
 * name, as the label promises (T-r2 ND3: «Наименование: 3D принтер», «Tovar
 * nomi: 7up ichimlik», «Название: 4K монитор»), never a number and one word
 * («Tovar nomi: 3 xil» is a count of kinds).
 * What a customer says about the goods is refused under both (`statusBody`):
 * «Tovar nomi: hali yo'q».
 */
function bareGoods(body: string, labelText: string, naming: boolean, prefix: string | null): TypedGoods[] {
  const text = body.trim().replace(ETC_TAIL, '');
  if (!text || (!naming && /^\d/u.test(text))) return [];
  if (statusBody(text, prefix)) return [];
  if (!naming && PLURAL_LABEL.test(labelText) && LIST_BODY.test(text)) {
    const pieces = text.split(LIST_SPLIT).map(tidyName).filter(Boolean).map(listPiece);
    return pieces.length > 0 && pieces.every((p) => p !== null) ? (pieces as TypedGoods[]) : [];
  }
  const parsed = typedLine(text);
  if (parsed.unitWords.length === 0 && parsed.tnvedCode === null) {
    // A number and ONE word is a count of something — «3 xil», «2 позиции»,
    // «1 контейнер» (round-4 probe, after a naming label) — where a name's
    // digit is glued to it («3D принтер», «100% хлопок») or the name goes on
    // («2 в 1 шампунь», «5 litrli suv»).
    if (/^\d[\d.,]*\s+\S+$/u.test(text)) return [];
    const whole = tidyName(text);
    return nameOk(whole) ? [figureless(whole)] : [];
  }
  const labels = figureRunLabels(text);
  if (labels === null) return [];
  const read = kernelGoods(parsed, labels);
  return read ? [read] : [];
}

/**
 * The kernel's reading of a goods text as one product, or null when it cannot
 * be settled. `fields` are the measure field words that labelled its figures
 * («вес», «jami» — `figureRunLabels`): they name a figure, not the product.
 */
function kernelGoods(parsed: ReturnType<typeof parseGoodsLine>, fields: readonly string[] = []): TypedGoods | null {
  if (parsed.problems.some(unsettled)) return null;
  const labelWords = new Set(fields.map(fieldKey));
  const name = tidyName(
    parsed.name
      .split(/\s+/u)
      .filter((w) => !labelWords.has(fieldKey(w)))
      .join(' '),
  );
  if (!nameOk(name)) return null;
  return typedRow(name, parsed);
}

/**
 * One piece of a plural list — «kurtka 300 dona», «shim», «обувь 200 пар»: a
 * name and then its figures, or a name with none, read as a line of its own.
 */
function listPiece(piece: string): TypedGoods | null {
  if (/^\d/u.test(piece)) return null;
  if (nameThenFigures(piece)) return kernelGoods(typedLine(piece));
  const parsed = typedLine(piece);
  if (parsed.unitWords.length > 0 || parsed.tnvedCode !== null) return null;
  return nameOk(piece) ? figureless(piece) : null;
}

/**
 * Are a text's figures ONE run — every number and unit word side by side,
 * with no word of a name between them? «300 dona kurtka» and «kurtka 300 dona
 * qora rangda» are; «kurtka 300 dona, shim 150 kg» is two runs (null). A
 * measure FIELD between two figures labels the one after it and splits
 * nothing (round-4 probe: «куртки 300 шт, вес 500 кг, объем 3 куб» read
 * nothing): those words are returned, for the name to drop.
 */
function figureRunLabels(text: string): string[] | null {
  // A mark, a size and its words are no word of a name between two figures (T4/T6).
  const tokens = figureTail(text).text.split(TAIL_SPLIT).filter(Boolean);
  const figure = tokens.map((t) => /^\d/u.test(t) || unitOf(t) !== null || scaledWord(t));
  const first = figure.indexOf(true);
  const last = figure.lastIndexOf(true);
  if (first < 0) return [];
  const inside = tokens.slice(first, last + 1).filter((_, i) => !figure[first + i]);
  return inside.every((w) => MEASURE_FIELDS.has(fieldKey(w))) ? inside : null;
}

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
 * The word list skips only a SEPARATED label (T6): «Tovar: …» names the goods
 * explicitly, so «Tovar: korobka 1000 dona» is a thousand boxes. A label with
 * no separator is just «the goods'…» — «Tovar vazni 1200 kg», «Товар вес
 * 3500 кг», «Goods volume 12 m3» are totals, and with the list skipped they
 * were products even when the model had read and found none (R3-T1). Two
 * pinned cases meet here: the screenshot line has no separator either, and
 * still reads, because none of its words is on the list.
 *
 * A carton count is not a product (#24, R3-T3): a carton noun as a field
 * («Karobka: 45 ta») or beside a count or total word («Karobka soni 45 ta»);
 * and a line named only by carton nouns («Karobka 45 ta») gives way when the
 * text names another product — alone, «Korobka 1000 dona» is boxes for sale.
 * `prefix` is the company's client-code prefix (`ClientHintOpts`).
 */
export function readGoodsLines(
  text: string,
  opts?: { labelledOnly?: boolean } & ClientHintOpts,
): NonNullable<CalcFacts['goods']> {
  return typedGoods(text, opts).goods;
}

/**
 * `readGoodsLines`, with WHICH text lines (by index in `text.split('\n')`) it
 * read a figured product from — so `parseManualFacts` can tell a line's own
 * figure from a total (review PF-2). One reader, two answers: the goods and
 * where they stood.
 */
function typedGoods(
  text: string,
  opts?: { labelledOnly?: boolean } & ClientHintOpts,
): { goods: NonNullable<CalcFacts['goods']>; lines: Set<number>; figured: number } {
  const prefix = clientCodePrefix(opts);
  const out: { goods: TypedGoods; labelled: boolean; lines: readonly number[] }[] = [];
  const rawLines = text.split(/\r?\n/);
  const entries = specEntries(rawLines, prefix);
  for (let e = 0; e < entries.length && out.length < 50; e += 1) {
    const entry = entries[e]!;
    const read = readEntry(entry, rawLines, opts, prefix);
    if (read === null) {
      // A spec block no figure of which reads (T12) is read line by line, as it always was.
      if (entry.block) entries.splice(e + 1, 0, ...entry.lines.map((at) => ({ lines: [at], block: null })));
      continue;
    }
    for (const item of read) if (out.length < 50) out.push(item);
  }
  const cartonOnly = (g: TypedGoods) => wordsOf(g.name).every((w) => CARTON_NOUNS.has(w));
  const another = out.some((o) => !cartonOnly(o.goods));
  const kept = out.filter((o) => !another || o.labelled || !cartonOnly(o.goods));
  const figured = kept.filter((o) => o.lines.length > 0);
  return {
    goods: kept.map((o) => o.goods),
    lines: new Set(figured.flatMap((o) => o.lines)),
    // A spec block is ONE good on several text lines: «one goods line is the
    // shipment» counts goods, not the lines they stand on.
    figured: figured.length,
  };
}

/** What the typed reader reads as one line: a text line, or a spec block's (T12). */
interface TypedEntry {
  /** The text lines it stands on, by index. */
  lines: readonly number[];
  /** A spec block: its name said by a label, its field lines' text with the name first, and where each field line starts in it. */
  block: { name: string; text: string; fields: readonly number[] } | null;
}

/**
 * A NAME label opening a line beside the goods labels («Tovar:», «Наименование
 * товара:», «品名» — `GOODS_LABEL`): the spec block's own of units.ts §2.4
 * («Item:», «Description:», «货名», «名称»). A Latin or Cyrillic one ends its word.
 */
const NAME_FIELD = new RegExp(
  String.raw`^\s*(?:${labelPattern(FIELD_LABELS.name)})(?:(?<=\p{Script=Han})|(?![\p{L}\p{N}]))${GAP}[:：=]?${GAP}`,
  'iu',
);

/** A field line of a spec block: a field label of §2.4 — a size's included — and its figure or size. */
const FIELD_LINE = new RegExp(
  String.raw`^(?:${labelPattern([
    ...FIELD_KIND_LABELS.flatMap(([, l]) => l),
    ...FIELD_LABELS.size,
    ...FIELD_LABELS.packageSize,
  ])})${GAP}[.)]?${GAP}[:：=]?${GAP}(?=\p{L}?\d)`,
  'iu',
);

/**
 * The name a line opens with under a name label, or null — never a list, never
 * a figure first, never what a customer says ABOUT the goods («Tovar:
 * tayyor», `statusBody`).
 */
function nameLineOf(line: string, prefix: string | null): string | null {
  const m = GOODS_LABEL.exec(line) ?? NAME_FIELD.exec(line);
  const name = m ? line.slice(m[0].length).trim() : '';
  if (!nameOk(name) || LIST_BODY.test(name) || /^\d/u.test(name) || statusBody(name, prefix)) return null;
  return name;
}

/** Is a text line one of a spec block's fields — «Qty: 200 pcs», «毛重 15kg/箱», «20箱», «Carton size: 60*40*50cm»? */
function specFieldLine(line: string, prefix: string | null): boolean {
  const text = line.trim().replace(LIST_MARKER, '');
  if (!text || nameLineOf(text, prefix) !== null) return false;
  if (FIELD_LINE.test(text)) return true;
  // A line of nothing but figures — «20箱», «200 pcs», «20 ctns 300 kg».
  return firstFigure(text) === 0 && unitFigures(text, { measured: false });
}

/**
 * The text lines as the reader reads them (T12): a NAME line and the field
 * lines right under it — until a blank line, the next name, or a line that is
 * no field — are ONE entry, the block; every other line is its own.
 */
function specEntries(rawLines: readonly string[], prefix: string | null): TypedEntry[] {
  const out: TypedEntry[] = [];
  for (let at = 0; at < rawLines.length; at += 1) {
    const line = rawLines[at]!.trim().replace(LIST_MARKER, '');
    const name = nameLineOf(line, prefix);
    let end = at + 1;
    while (name !== null && end < rawLines.length && specFieldLine(rawLines[end]!, prefix)) end += 1;
    if (name === null || end === at + 1) {
      out.push({ lines: [at], block: null });
      continue;
    }
    let text = name;
    const fields: number[] = [];
    for (const field of rawLines.slice(at + 1, end).map((l) => l.trim().replace(LIST_MARKER, ''))) {
      text += ' ';
      fields.push(text.length);
      text += field;
    }
    out.push({ lines: Array.from({ length: end - at }, (_, i) => at + i), block: { name, text, fields } });
    at = end - 1;
  }
  return out;
}

/**
 * A supplier's ONE-line spec with its name label AFTER the figures — «尺寸
 * 60*40*50cm 20箱 毛重 15kg/箱 品名 折叠椅», a forwarded line (MP-2): the
 * name is moved to the front, its label blanked where it stood, and the line
 * reads as any spec line. Only where nothing before the first figure is a
 * name's word — a label alone, or nothing.
 */
const NAME_LABEL_INSIDE = new RegExp(
  String.raw`(?<!(?!\p{Script=Han})\p{L})(?:${labelPattern(FIELD_LABELS.name)})(?:(?<=\p{Script=Han})|(?![\p{L}\p{N}]))${GAP}[:：=]?${GAP}`,
  'giu',
);
/** Every field label of a spec line — a measure's, a count's, a size's. */
const FIELD_LABEL_ALL = labelPattern([...FIELD_KIND_LABELS.flatMap(([, l]) => l), ...FIELD_LABELS.size, ...FIELD_LABELS.packageSize]);
const FIELD_LABEL_WORDS = new RegExp(`(?:${FIELD_LABEL_ALL})`, 'giu');
/** Where a moved name ends: the next figure, or the next field label. */
const NAME_STOP = new RegExp(String.raw`\d|(?<!(?!\p{Script=Han})\p{L})(?:${FIELD_LABEL_ALL})(?:(?<=\p{Script=Han})|(?![\p{L}]))`, 'iu');
function nameToFront(line: string, prefix: string | null): string | null {
  const at = firstFigure(line);
  if (at < 0) return null;
  if (/\p{L}/u.test(line.slice(0, at).replace(FIELD_LABEL_WORDS, ' '))) return null;
  for (const hit of line.slice(at).matchAll(NAME_LABEL_INSIDE)) {
    const start = at + hit.index;
    const from = start + hit[0].length;
    const rest = line.slice(from);
    const stop = rest.search(NAME_STOP);
    const name = tidyName(stop < 0 ? rest : rest.slice(0, stop));
    if (!nameOk(name) || statusBody(name, prefix)) continue;
    const end = from + (stop < 0 ? rest.length : stop);
    return `${name} ${line.slice(0, start)}${BLANK.repeat(end - start)}${line.slice(end)}`;
  }
  return null;
}

/**
 * One entry as goods — the rules of `readGoodsLines` above — or null when a
 * spec block's joined text reads as no figured product (its lines are then
 * read one by one).
 */
function readEntry(
  entry: TypedEntry,
  rawLines: readonly string[],
  opts: ({ labelledOnly?: boolean } & ClientHintOpts) | undefined,
  prefix: string | null,
): { goods: TypedGoods; labelled: boolean; lines: readonly number[] }[] | null {
  const out: { goods: TypedGoods; labelled: boolean; lines: readonly number[] }[] = [];
  const at = entry.lines[0]!;
  const block = entry.block;
  const own = rawLines[at]!.trim().replace(LIST_MARKER, '');
  const moved = block ? null : nameToFront(own, prefix);
  const line = block ? block.text : (moved ?? own);
  if (!line || !/\p{L}/u.test(line)) return out;
  if (readRoute(line).fromCity !== null) return out;
  if (CLIENT_CODE_LINE.test(line)) return out;
  // «Tovar keldimi?» — a question about the goods is not a goods line.
  if (/[?？]$/u.test(line)) return out;
  // A spec block, or a spec line whose name label stood after its figures,
  // NAMES its goods: labelled, the name said (T12).
  const spec = block !== null || moved !== null;
  const label = spec ? null : GOODS_LABEL.exec(line);
  if (opts?.labelledOnly && !label && !spec) return out;
  const naming = spec || Boolean(label?.[1]);
  const separated = spec || Boolean(label?.[2]);
  const said = label ? line.slice(label[0].length) : line;
  const fields = lineFields(said, block?.fields ?? []);
  const body = fields.text;
  const figured = nameThenFigures(body);
  const coded = !figured && nameThenCode(body);
  if (block && !figured) return null;
  // A list under a plural label is split before anything reads it whole:
  // «Tovarlar: shim, kurtka 300 dona» is two products, and as one «name then
  // figures» line it was «shim kurtka» × 300 (round 4, T-r2 t7).
  const listed = separated && !naming && PLURAL_LABEL.test(label![0]) && LIST_BODY.test(said);
  if (listed || (!figured && !coded)) {
    if (label && separated) {
      // A bare name carries no figure of the line's own to set apart.
      for (const goods of bareGoods(said, label[0], naming, prefix)) out.push({ goods, labelled: true, lines: [] });
    }
    return out;
  }
  const parsed = typedLine(body);
  const name = tidyName(parsed.name);
  // A tonne or gram figure left in the name (it stands beside a piece count)
  // is no WORD of it: «jami 2 tonna 300 dona» is named by «jami» alone — a
  // totals line, never a product called «jami 2 tonna». Nor is a size (T6):
  // «Dims 60x40x50 cm 300 kg» is named by «Dims», a forwarder's label.
  const words = nameWords(name.replace(SCALED_IN_NAME, ' '));
  if (words.length === 0) return out;
  // The name's words are JUDGED without a number-and-word pair the kernel
  // left in it (T8): «iPhone 15 Pro» is judged by «iPhone», «Yuk 3 mashina 36
  // kub» by «Yuk» — the shipment's words, never a product.
  const judged = withoutPairs(words);
  if (judged.length === 0) return out;
  const counted = parsed.quantity !== null || parsed.measureQty !== null;
  // «Tovar: vazni 150 kg» is the goods' weight under a label (round 3,
  // R3-T1's optional half): the list skip a label earns (T6, «Tovar: Total
  // 200 litr» is a motor oil) stops at a name made only of a measure FIELD.
  if (separated && judged.every((w) => MEASURE_FIELDS.has(w.replace(/[’ʻʼ‘`´']/gu, '')))) return out;
  if (!separated) {
    const glued = gluedCodeLetters(body);
    // The company's prefix standing apart from its digits — «GS 777 300
    // kg» — is the client code's letters, never a product called «GS».
    const prefixLetters = (w: string) => prefix !== null && w === prefix.toLowerCase();
    if (judged.every((w) => notGoodsWord(w) || codeWord(w, prefix, counted) || glued.has(w) || prefixLetters(w))) return out;
    const cartonish = judged.every((w) => CARTON_NOUNS.has(w) || notGoodsWord(w));
    if (cartonish && (FIELD_SHAPED.test(line) || judged.some(notGoodsWord))) return out;
    // A chat line about the shipment states no count, pair or code (R3-T8):
    // «Salom aka, 12 kub», «Bugun 5 kub», «Toshkent shahriga 12 kub» (`chatLine`).
    if (!counted && parsed.tnvedCode === null && chatLine(judged)) return out;
  }
  // Ten digits on a line with no unit are a number when a field names them.
  if (coded && words.some((w) => NUMBER_FIELD_WORDS.has(w.replace(/[’ʻʼ‘`´']/gu, '')))) return out;
  const bare = coded ? bareTenDigits(body) : null;
  if (bare !== null && !bareCodeOk(bare, words)) return out;
  if ((name.match(/\p{L}/gu) ?? []).length < 2) return out;
  if (!separated && parsed.quantity === null && parsed.measureQty === null && DASH_ROUTE.test(name)) return out;
  // An answer the parser could not settle («1,200 kg») is not a figure, and
  // a unit stated twice («300 dona …, 200 dona») is two lines welded into
  // one — splitting them is the model's job.
  if (parsed.problems.some(unsettled)) return block ? null : out;
  out.push({
    goods: typedRow(name, parsed, fields),
    // A label with no separator is read as an unlabelled line (R3-T1), and
    // gives way as one too.
    labelled: separated,
    lines: entry.lines,
  });
  return out;
}

/** A name's words without a number and the one word after it — `readEntry`'s judging (T8). */
function withoutPairs(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    if (/^\d[\d.,]*$/u.test(words[i]!) && i + 1 < words.length && pairWord(words[i + 1]!)) {
      i += 1;
      continue;
    }
    out.push(words[i]!);
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
  | 'repeated'
  | 'per_one';

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
  if (!word) return null;
  // «1,200 тн»: both readings are kilos already (`parseGoodsLine`'s `scaled`).
  return unitOf(word[1]) ?? (scaledWord(word[1]!) ? 'kg' : null);
}

/**
 * «1.5 t», «500 g», «0,5 т», «2.5 MT» as the WHOLE answer to the bot's
 * question about one line: there the lone letter is the figure's unit, and it
 * is written out in the spelling the readers know («1.5 tonna»). Never glued
 * to the digits, and never beside anything else — in a longer answer a lone
 * letter is a model's («128G», «5 t domkrat») and is asked, as before (review
 * JN-9).
 */
const LONE_ANSWER = new RegExp(String.raw`^(${AMOUNT_NUMBER})[ \t\u00a0\u202f]+(${scaledPattern('lone')})\.?$`, 'iu');
function loneLetterSpelled(text: string): string {
  const lone = loneScaledAnswer(text);
  return lone ? `${lone.number} ${lone.factor > 1 ? 'tonna' : 'gr'}` : text;
}

/**
 * A WHOLE line answer that is a figure and a lone \u00abt\u00bb / \u00abg\u00bb \u2014 \u00ab1.5 t\u00bb, \u00ab128
 * g\u00bb \u2014 as `parseLineAnswer` reads it (number, letter, factor), or null. The
 * table asks it because review JN-9 lets the letter be a weight only as the
 * answer to the bot's own question about a WEIGHT: \u00ab1: 128 g\u00bb to a row the
 * table asks only its pieces is a flash drive's gigabytes as often as grams
 * (line-address.ts).
 */
export function loneScaledAnswer(raw: string): { number: string; word: string; factor: number } | null {
  const lone = LONE_ANSWER.exec(raw.trim());
  const scale = lone ? scaledKg(lone[2]) : null;
  return lone && scale ? { number: lone[1]!, word: lone[2]!, factor: scale.factor } : null;
}

export function parseLineAnswer(raw: string): LineAnswer {
  const text = loneLetterSpelled(raw.trim());
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

  const line = typedLine(text);
  // A figure of ONE package or ONE piece — «15 kg/ctn», «har biri 2 kg»,
  // «20 x 15 kg» — is never the row's own figure (§3.1 T4): written as the
  // answer it put one carton's weight in the row's column. Refused, in the
  // seller's own words; what such an answer MEANS is the table's to read
  // (T7, release 1b), never this guess.
  if ((line.perOne ?? []).length > 0) return { kind: 'refused', reason: 'per_one', detail: line.perOne![0] };
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

/**
 * «Samsung A54», «Xiaomi Redmi K60», «Televizor LG55», «Truba PPR20»: a
 * product and its model — one to three capitals and the digits (R3-T9 widened
 * it from one capital once two or three capitals beside a word stopped being
 * a client code).
 */
const MODEL_TAIL = /\p{L}\s+[A-Z]{1,3}\d{1,4}$/u;
/**
 * «Kurtka 1200 50 3000», «Futbolka 2000 10 5000»: a word and a ROW of two or
 * more bare figures — a packing-list row copied without its units. R3-T5 took
 * these out of the printed-code form, which had made them «goods» for the
 * wrong reason; without this they became a short line of words and a number,
 * i.e. the customer's NAME. A name carries one number at most («OOO Asia
 * Trade 2020», «Ali aka 2»).
 */
const NUMBER_ROW = /\p{L}\s+\d[\d.,]*(?:\s+\d[\d.,]*)+$/u;
/**
 * …but groups of two or three digits and nothing else are how a phone is
 * written, and one that is not whole is still a contact being typed — «Ali
 * aka 123 45 67», «Ali 90 123 45» (round 4, T-r2 ND9: NUMBER_ROW filed them
 * as goods). A row of figures carries what a phone never has: a group of four
 * digits or more, or a decimal. And a phone ENDS in a two-digit group («123
 * 45 67», «90 123 45»), so a row ending in three — the price × count = sum
 * «Kurtka 12 25 300» — is figures (round-4 probe). Left: «Kurtka 120 50 30»
 * reads as a name; the repeat rule and the model see it either way.
 */
const PHONE_GROUPS = /\p{L}\s+\d{2,3}(?:\s+\d{2,3})*\s+\d{2}$/u;
/** A word and THREE or more bare figures — a packing-list row («Kurtka 1200 50 3000»). */
const THREE_FIGURES = /\p{L}\s+\d[\d.,]*(?:\s+\d[\d.,]*){2,}$/u;
/** A word and TWO bare figures, one a decimal or the first a hundred or more — «Kafel 2400 36,5», «Kurtka 300 1200». */
const TWO_FIGURE_ROW = /\p{L}\s+(?:\d+[.,]\d+\s+\d[\d.,]*|\d[\d.,]*\s+\d+[.,]\d+|\d{3,}\s+\d+)$/u;
/** A phone written in two groups of four — «王先生 8512 3456». */
const FOUR_AND_FOUR = /\p{L}\s+\d{4}\s+\d{4}$/u;
/** The label words of a customer's code: «Mijoz 777» names a customer, never a product's count (R3-T7). */
const CLIENT_WORD = /^(?:mijoz|мижоз|klient|клиент|client|kod|код)$/iu;

/** A line opening with a goods label, its separator and something after it — «Tovar: kurtka». */
function labelledGoodsLine(line: string): boolean {
  const label = GOODS_LABEL.exec(line);
  return Boolean(label?.[2]) && line.slice(label![0].length).trim() !== '';
}

/**
 * Is the first message of a collection MATERIAL rather than the customer's
 * name (his 1.7 b)? The bot asks «who is the customer» and a seller in a
 * hurry forwards the goods list instead; it used to become the lead's NAME
 * and was never shown to the model.
 *
 * Goods evidence decides FIRST (review #16, #23): a unit word, a TNVED code
 * or a line naming itself goods is material, whatever digits it also holds.
 * A line naming itself goods is material by its LABEL (R3-T2), whatever the
 * goods reader makes of its body: «Tovar: kurtka, shim», «Goods: jackets» and
 * «Товар - куртка» were filed as the CUSTOMER once T7 stopped reading
 * figure-less bodies — the lead named «Tovar: kurtka, shim» and the goods
 * never reached the model.
 * Then the customer: a code or a phone, written the ways people write them
 * («GS 777», «Bobur aka GS777», «Ali aka» over «+998 90 123 45 67»). Then
 * several lines or a long text is material. What is left — a short line of
 * words, perhaps with a bare number («Ali aka 2», «OOO Asia Trade 2020») —
 * is a NAME: filing a name as material re-asked the same question for ever.
 *
 * Except the two shapes a goods line has and a name does not (the second
 * review's T4): ONE word and its count («Shim 200», «Stol 1000», «Olma 300»
 * — the «nomi, soni» line of every list) unless the word is a customer's
 * label («Mijoz 777», R3-T7), and a product ending in its model («Samsung
 * A54», «Televizor LG55», «Bobur ABC777» — R3-T9). Both used to be read as a
 * client code nobody holds, so the goods named the lead and never reached the
 * model; as a NAME they would do the same. A seller who meant «Bobur ABC777»
 * as the customer sends it again, and the collector's repeat rule
 * (`readCustomerText`: one short line with no goods evidence could be a
 * customer) believes him — the safety net for every guess this one makes.
 * `opts.prefix` is the company's client-code prefix (`ClientHintOpts`),
 * which the bot passes.
 */
export function looksLikeMaterial(raw: string, opts?: ClientHintOpts): boolean {
  const text = raw.trim();
  if (!text) return false;
  if (goodsEvidence(text, opts)) return true;
  if (parseClientHint(text, opts)) return false;
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const oneWordCount = ONE_WORD_COUNT.test(text) && !CLIENT_WORD.test(text.split(/\s+/u)[0]!);
  return (
    lines.length > 1 || text.length > 60 || oneWordCount || MODEL_TAIL.test(text) || numberRow(text) || wordList(text)
  );
}

/**
 * The goods evidence that decides FIRST, whatever else a text holds (review
 * #16, #23, R3-T2): some line states a unit or a code (`statesGoods`), names
 * itself goods («Tovar: …», `labelledGoodsLine`), or reads as a goods line
 * on its label alone. Exported for the customer question's «could this be a
 * customer» (round 4, integration defect 1): one test, so a line that is
 * material can never also be believed as the customer on a repeat.
 */
export function goodsEvidence(raw: string, opts?: ClientHintOpts): boolean {
  const labelled = { labelledOnly: true, prefix: opts?.prefix };
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .some((l) => labelledGoodsLine(l) || statesGoods(l) || typedLine(l).unitWords.length > 0 || readGoodsLines(l, labelled).length > 0);
}

/** A word and a ROW of bare figures with no phone's shape (`NUMBER_ROW`, `PHONE_GROUPS`) — material on the first send. */
function numberRow(text: string): boolean {
  return NUMBER_ROW.test(text) && !PHONE_GROUPS.test(text);
}

/**
 * A row of bare figures — «Kurtka 1200 50 3000» — that no repeat may insist
 * is the customer. Exported for the customer question, as `goodsEvidence` is.
 * A word and TWO figures is material on the first send (`numberRow`), but may
 * name a person on the repeat: a market stall «Ippodrom 4 115», «Чорсу бозори
 * 5 12», a landline written 4-4 «王先生 8512 3456» (round-4 probe: refusing
 * those left the seller no way to name him). Unless the pair has what neither
 * has (`TWO_FIGURE_ROW`, round-5 probe): a decimal («Kafel 2400 36,5»), or a
 * count of a hundred or more first («Kurtka 300 1200», «Oyinchoq 1500 25») —
 * a phone in two groups is four and four, and a market's row may be large
 * but the line then names the market («Ippodrom 112 15», `addressWord`).
 */
export function figureRow(raw: string): boolean {
  const text = raw.trim();
  if (!numberRow(text)) return false;
  if (THREE_FIGURES.test(text)) return true;
  const stall = text.split(/\s+/u).some(addressWord);
  return TWO_FIGURE_ROW.test(text) && !FOUR_AND_FOUR.test(text) && !stall;
}

/**
 * Three or more single words in a comma list, none of them a place or a
 * total — «Kurtka, shim, sharf» (round 3, collector C3 note: a unit-less
 * goods list was taken as the customer on the first send). A contact is a
 * name and a place, «Rustam, Andijon», «Ali aka, Toshkent, Chilonzor», never
 * a list of bare nouns. A seller who meant it as the customer sends it again,
 * and the repeat rule believes one short line. Nor is a list that names a
 * place of business — «Rustam, Asaka, bozor», «Олимжон, Ипподром, магазин»
 * (round-4 probe: a town the place list does not know made it «goods»).
 */
const VENUE_WORDS = new Set([
  'bozor', 'bozori', 'бозор', 'бозори', 'dokon', 'dokoni', 'докон', 'дўкон', 'дўкони', 'rasta', 'раста',
  'магазин', 'рынок', 'базар', 'market', 'shop', 'store',
]);
function wordList(text: string): boolean {
  const items = text.split(/\s*[,，、;]\s*/u).filter(Boolean);
  const plainNoun = (i: string) => /^\p{L}[\p{L}'’‘ʻ`-]*$/u.test(i) && !notGoodsWord(i) && !VENUE_WORDS.has(fieldKey(i));
  return items.length >= 3 && items.every(plainNoun);
}
