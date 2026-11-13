import { tierWords } from './name-tiers';
import type { Packing } from '../../wms/calc/carton-math';
import type { CalcGoodsFact, TableAsk } from '../../wms/calc/intake';
import type { ColumnAsk, WeightKind } from '../../wms/deals/goods-import';
import type { IntakeState, SheetText, TotalsMark } from './calc-intake';

/**
 * What several goods FILES are worth together, decided by the bot and named
 * (docs/IKKI-ESHIK.md §1.2, his 1a: «the bot does not ask; the AI compares the
 * files itself»). The seller used to be asked about every second Excel and
 * every model-read document beside an Excel; now the same goods are taken
 * once, new goods are added, and a packing list is read for its totals and
 * the weights the goods list lacks — and every decision is a sentence for the
 * card.
 *
 * Pure, and with no runtime import but the zero-import tier words: the hydrate
 * (calc-store.ts `migrateIntakeState`) resolves an old collection's open
 * question through these same rules, and calc-store must not import the
 * collector (calc-intake.ts imports calc-store). The name keys and the figure
 * comparison MOVED here from calc-intake.ts, which re-exports what its
 * importers used — one home for «the same line» on every path (#513).
 */

type GoodsList = CalcGoodsFact[];

/**
 * A goods name as two lists compare it: case, spacing and punctuation are not
 * what makes two lines the same product. Exported for the test.
 */
export function goodsNameKey(name: string): string {
  return name.toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
}

/**
 * A name's OUTERMOST brackets (ASCII and full-width — a Chinese original often
 * comes in （）): what each holds, and the name outside them. «Куртка женская
 * (Ladies jacket (XL))» holds «Ladies jacket (XL)» — the innermost pair alone
 * read «XL» and left the original's half outside (round-3 review, collector
 * C2 note). Unbalanced brackets are no brackets: nothing is guessed open.
 */
function bracketParts(name: string): { inside: string[]; outside: string } {
  const inside: string[] = [];
  let outside = '';
  let depth = 0;
  let start = 0;
  for (let i = 0; i < name.length; i += 1) {
    const ch = name[i]!;
    if (ch === '(' || ch === '（') {
      if (depth === 0) {
        start = i + 1;
        outside += ' ';
      }
      depth += 1;
    } else if (ch === ')' || ch === '）') {
      if (depth === 0) return { inside: [], outside: name };
      depth -= 1;
      if (depth === 0) inside.push(name.slice(start, i));
    } else if (depth === 0) outside += ch;
  }
  return depth === 0 ? { inside, outside } : { inside: [], outside: name };
}

/**
 * The names one goods line answers to (round-2 review, C2/C6), each through
 * `goodsNameKey`:
 *  - `whole` — the name as written: the one name the line IS;
 *  - `outside` / `inside` — the name outside its outermost brackets, and what
 *    each holds;
 *  - `keys` — everything the line answers to: the whole, the outside, the
 *    insides. The model is TOLD to write «Куртка женская (Ladies jacket)»
 *    (its SYSTEM prompt: Russian, the original in brackets), so the whole
 *    name alone never equalled the Excel's «Ladies jacket» and an «add»
 *    landed the same line twice;
 *  - `halves` — for a Chinese factory's bilingual cell with no brackets
 *    («女士夹克 Ladies jacket», «女士夹克\nLadies jacket») its Chinese half and
 *    the rest, each beside the OTHER half (`rest`): the model reads such a
 *    cell as «Куртка женская (女士夹克)» and the Excel's whole name met neither
 *    half (round-3 review, collector C2 note). How a half may meet is
 *    `halfMeets` — not as a name the line IS: «Kurtka 黑色» is a black jacket
 *    and «LED灯泡» a bulb, and nothing says a half is the other's translation
 *    (round-4 probe, collector).
 * Halves only without brackets: in «Kurtka (黑色)» the colour is the bracket.
 * Empty keys are dropped.
 */
export function goodsNameKeys(name: string): {
  whole: string;
  outside: string;
  inside: string[];
  keys: string[];
  halves: { key: string; rest: string }[];
} {
  const whole = goodsNameKey(name);
  const parts = bracketParts(name);
  const outside = goodsNameKey(parts.outside);
  const inside = parts.inside.map(goodsNameKey).filter(Boolean);
  const han = goodsNameKey((name.match(/\p{Script=Han}+/gu) ?? []).join(' '));
  const rest = goodsNameKey(name.replace(/\p{Script=Han}+/gu, ' '));
  const split = parts.inside.length === 0 && han !== '' && /\p{L}/u.test(rest);
  return {
    whole,
    outside,
    inside,
    keys: [...new Set([whole, outside, ...inside])].filter(Boolean),
    halves: split ? [{ key: han, rest }, { key: rest, rest: han }] : [],
  };
}

/**
 * Do two names point at the same product the WIDE way — a name ONE of them
 * answers to is the name the OTHER is: «Куртка женская (Ladies jacket)» is
 * «Ladies jacket», «Kurtka» is «Kurtka (qora)» (round-2 review, C2/C6)? Never
 * bracket against bracket or outside against outside: a bracket is as often a
 * colour or a size, and «Kurtka (qora)» beside «Kurtka (oq)» are two lines of
 * one order. A bilingual cell's half meets by `halfMeets` alone.
 */
export type NameKeys = ReturnType<typeof goodsNameKeys>;

/**
 * A string function remembered for the strings it has seen, up to `cap`
 * (then forgotten whole — a bound, never a leak). The comparisons below are
 * pure over a NAME, and two files of 500 rows compare 250 000 pairs: keying
 * both names inside every pair was seconds of the one process, the bot and
 * every web request stalled with it (as-built review DURABILITY-1 — fix
 * review DRILL-1's shape, in the file rule that did not inherit its fix).
 */
function remembered<V>(fn: (s: string) => V, cap = 8192): (s: string) => V {
  const seen = new Map<string, V>();
  return (s) => {
    const hit = seen.get(s);
    if (hit !== undefined) return hit;
    const v = fn(s);
    if (seen.size >= cap) seen.clear();
    seen.set(s, v);
    return v;
  };
}

/** `goodsNameKeys`, keyed once per name — read only, never mutated. */
const keysOf = remembered(goodsNameKeys);
/** `goodsNameKey`, keyed once per name. */
const keyOf = remembered(goodsNameKey);

export function namesMeet(a: NameKeys, b: NameKeys): boolean {
  return a.keys.includes(b.whole) || b.keys.includes(a.whole) || halfMeets(a, b) || halfMeets(b, a);
}

const SCRIPTS = [
  ['han', /\p{Script=Han}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['latin', /\p{Script=Latin}/u],
] as const;

/**
 * A key's words for comparing two names: each word's LETTERS under the script
 * of its first one, and the NUMBERS the key states as their own bucket — every
 * run of digits, counted (a multiset), however they are written. A size is
 * «600*600mm» in the cell and «600×600 мм» in the model's reading of it, a
 * range «36~40» and «36–40»: compared as words they were two names and one
 * order landed twice (round-6 probe, collector, 28 common cases); left out,
 * «iPhone 14» met «iPhone 15» and a 800×800 tile met the 600*600 one (the
 * lead's undo, probed: 5 common). Read as numbers both hold. Not read: a unit
 * conversion («0.35L» / «350 мл»), which stays another name.
 */
function nameWords(key: string): Map<string, Set<string>> {
  const by = new Map<string, Set<string>>();
  const add = (bucket: string, word: string) => by.set(bucket, (by.get(bucket) ?? new Set<string>()).add(word));
  // NFKC writes full-width digits as digits and «№» as «No» — capitalised,
  // so the case is folded after it.
  const plain = key.normalize('NFKC').toLowerCase();
  for (const word of plain.split(' ').filter(Boolean)) {
    const letters = word.replace(/[^\p{L}]/gu, '');
    if (letters === '') continue;
    add(SCRIPTS.find(([, re]) => re.test(letters))?.[0] ?? 'other', letters);
  }
  const seen = new Map<string, number>();
  for (const run of plain.match(/[0-9]+/g) ?? []) {
    const n = run.replace(/^0+(?=\d)/, '');
    const nth = (seen.get(n) ?? 0) + 1;
    seen.set(n, nth);
    add('number', `${n}#${nth}`);
  }
  return by;
}

// The tier words (#1468) live in name-tiers.ts, one home with the bot table's
// name address (docs/SAKKIZ-R3.md §8.1); `otherName` reads them from there —
// both remembered per key (DURABILITY-1): `halfMeets` asks them in every pair.
const tiersOfKey = remembered(tierWords);
const wordsOfKey = remembered(nameWords);

/**
 * Are two keys two DIFFERENT names: in some script both write — or in the
 * numbers both state — each has a word the other lacks: «Shirt» beside
 * «Jacket», «Куртка M» beside «XL», «iPhone 15» beside «iPhone 14», «600*600»
 * beside «800×800». One naming MORE of the same is not another name:
 * «Наушники Bluetooth» shares the Latin of «Bluetooth earphones», «Куртка
 * женская XL» the «XL» of «Ladies jacket XL», and «Мужские кроссовки» is
 * «Кроссовки мужские» (round-5 probe, collector: comparing SCRIPTS alone made
 * each of those a clash, and one order landed twice) — except a model's TIER
 * (`tierWords`): «Чехол iPhone 15» is not «Phone case iPhone 15 Pro», and two
 * stalls' phone cases had one line dropped as the other's (round-6 final
 * probe, collector, 10 common cases).
 */
export function otherName(a: string, b: string): boolean {
  const tiersA = tiersOfKey(a);
  const tiersB = tiersOfKey(b);
  if ([...tiersA].some((t) => !tiersB.has(t)) || [...tiersB].some((t) => !tiersA.has(t))) return true;
  const wordsB = wordsOfKey(b);
  for (const [bucket, ofA] of wordsOfKey(a)) {
    const ofB = wordsB.get(bucket);
    if (ofB && [...ofA].some((w) => !ofB.has(w)) && [...ofB].some((w) => !ofA.has(w))) return true;
  }
  return false;
}

/**
 * A bilingual cell meets another line through a half only where a
 * translation stands: the other line's bracket — the model's «Куртка женская
 * (女士夹克)» — unless that line's outside and the cell's other half are two
 * names (`otherName`: «Shirt (黑色)» is not «Jacket 黑色»), or the other's
 * whole bare name («Ladies jacket»). Half against half, or against an
 * outside, met «夹克 XL» with «衬衫 XL» and «Kurtka 黑色» with «Kurtka (oq)»
 * (round-4 probe, collector).
 */
function halfMeets(cell: NameKeys, other: NameKeys): boolean {
  return cell.halves.some(({ key, rest }) => {
    if (other.inside.length === 0) return other.whole === key;
    if (!other.inside.includes(key)) return false;
    return other.outside === '' || !otherName(other.outside, rest);
  });
}

/**
 * The figures a goods line can state, and what «equal» means for each: a
 * count is exact (300 and 299 are two lines); a weight, volume or amount is
 * equal within rounding — under `unit` apart, or within 0.5 % (a PDF's
 * «1 234,5 kg» read as 1234).
 */
export const LINE_FIGURES: { field: 'quantity' | 'weightKg' | 'volumeM3' | 'measureQty' | 'amount'; unit: number | null }[] = [
  { field: 'quantity', unit: null },
  { field: 'weightKg', unit: 1 },
  { field: 'volumeM3', unit: 0.01 },
  { field: 'measureQty', unit: null },
  { field: 'amount', unit: 0.01 },
];

export function figureOf(g: GoodsList[number], field: (typeof LINE_FIGURES)[number]['field']): number | null {
  const v = g[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Is the model's line the Excel line READ AGAIN, by its figures (round-3
 * review, R3-C1)? A packing list re-read carries the Excel line's own count or
 * weight; another factory's same-named product does not. Only the figures
 * BOTH lines state are compared (round-4 review, C-r2 ND2 and integration
 * defect 3): a re-read that states the count beside an Excel line stating
 * only the weight — the Invoice sheet beside the Packing list, or a count the
 * reader took once from a merged cell — shares nothing to disagree on, and
 * counting «the Excel has no count» as a disagreement landed the order twice.
 * So: nothing shared (nothing says it is another line), or a shared figure
 * agrees.
 */
export function figuresAgree(model: GoodsList[number], invoice: GoodsList[number]): boolean {
  const shared = LINE_FIGURES.filter((f) => figureOf(model, f.field) !== null && figureOf(invoice, f.field) !== null);
  if (shared.length === 0) return true;
  return shared.some((f) => figureAgrees(f, model, invoice));
}

/** One figure two lines both state, equal by its own rule (`LINE_FIGURES`). */
function figureAgrees(f: (typeof LINE_FIGURES)[number], a: GoodsList[number], b: GoodsList[number]): boolean {
  const ours = figureOf(a, f.field)!;
  const theirs = figureOf(b, f.field)!;
  if (f.unit === null) return ours === theirs;
  const gap = Math.abs(ours - theirs);
  return gap < f.unit || gap <= 0.005 * Math.max(Math.abs(ours), Math.abs(theirs));
}

/**
 * Is the line READ the line KEPT, read again — `pickGoods`' «already
 * carries» rule, one home for it (docs/SAKKIZ-R3.md §9.4): the same WHOLE
 * name, or a name one answers to that is the other's (`namesMeet`) with
 * figures that agree (`figuresAgree`). The wide match alone threw factory B's
 * «Kurtka (qora)» 200 away against factory A's «Kurtka» 300 — two factories,
 * one generic name, two lines. The add door asks it of a stored row and a
 * top-up's line: «Куртка женская (Ladies jacket)» against a stored «Ladies
 * jacket» is that row, never a second one priced twice. Pure.
 */
export function sameGoodsLine(kept: GoodsList[number], read: GoodsList[number]): boolean {
  return sameLine(kept, goodsNameKeys(kept.name), read, goodsNameKeys(read.name));
}

/**
 * `sameGoodsLine` over names already keyed — `pickGoods` keys its invoice
 * once. ONE rule for both (§9.1): a name of nothing but spaces and signs keys
 * to nothing, and nothing is no name to be «the same» by — two such lines are
 * not one line.
 */
export function sameLine(kept: GoodsList[number], keptNames: NameKeys, read: GoodsList[number], readNames: NameKeys): boolean {
  if (!keptNames.whole || !readNames.whole) return false;
  return keptNames.whole === readNames.whole || (namesMeet(readNames, keptNames) && figuresAgree(read, kept));
}

// ---------------------------------------------------------------------------
// Two files of goods (docs/IKKI-ESHIK.md §1.2.2).
// ---------------------------------------------------------------------------

export type { WeightKind };

/**
 * A mapped Excel's block of `IntakeState.invoiceGoods`, in order: which file,
 * its shape, the column its line weights came from, and its sums — so a
 * LATER file can tell a gross weight from a netto row by row, and a packing
 * list that came FIRST can hand the goods role to the invoice after it.
 * `text` is the packing list's own rows as text, kept only for that hand-over
 * (it then joins the model's totals-only sheets). `rows` is the block's
 * length; when the blocks do not add up to the list (a row hydrated from
 * before them), every row's weight kind reads unknown.
 */
export interface GoodsFileMeta {
  label: string;
  shape: 'invoice' | 'packing';
  weightKind: WeightKind;
  grossKg: number | null;
  /** The sheet HAS a gross column — so a null `grossKg` is a hole, never «no column». */
  grossColumn: boolean;
  volumeM3: number | null;
  rows: number;
  text: string | null;
  /**
   * The reader's own cuts of `text` (review PF-ADV-14): rows missing, cells
   * shortened — the model is told a table it reads for totals stops short.
   * Absent = whole (a block written before them).
   */
  textCut?: boolean;
  textCellsCut?: boolean;
  /**
   * Where the material stood when THIS file arrived (review PF-ADV-9): a
   * packing list that came first hands its totals over when the invoice
   * arrives, and they are the packing list's — a totals answer given in
   * between was given with them in front of the seller. Absent = unknown.
   */
  at?: TotalsMark;
  /**
   * The reader stopped at its row ceiling (review PF-ADV-2): the rows are the
   * first 500, so nothing is summed from them — neither the gross column nor
   * the lines' netto.
   */
  capped?: boolean;
  /**
   * How many pictures the file's WORKBOOK carries (`GoodsFileRead.pictures`,
   * docs/AI-SORAYDI.md §3.2 X10): its rows may be named by article numbers
   * beside the pictures that show the goods (`nameIsArticle`). On the block
   * of the workbook's goods sheet only — a count of the BOOK, said once.
   * Absent = none, or a block written before the count.
   */
  pictures?: number;
  /**
   * The file's line columns nothing settled as the lines' or one carton's
   * (`ParsedGoods.asks`, docs/AI-SORAYDI.md §3.2 X5, review JN-12): asked
   * once, by the rows' names and figures (`columnAsks`). Absent = none, or a
   * block written before the round.
   */
  asks?: ColumnAsk[];
}

/**
 * The column questions of the collection's goods files as the table's asks
 * (review JN-12, JR-11, JS-33; excel-spec-1) — one per column, above the
 * closing, holding «Ma’lumot to‘liq» while it stands. Release 1a answers it
 * by TYPING (the kernel's minimal draw): a row's figure given by a person
 * (`derived.person`), or changed from the file's, answers that row; the ask
 * stands while some asked row still has the file's figure, or none, as the
 * file left it. Pure; the dialogue hands it the state (`tableInputOf`'s
 * `asks`, the lead's wiring — release 1a builds the ask, never the draw).
 */
export function columnAsks(files: readonly GoodsFileMeta[] | undefined, goods: GoodsList): TableAsk[] {
  const out: TableAsk[] = [];
  const list = files ?? [];
  // Where each file's rows stand in the list — while the blocks still add up
  // to it (`rowKindsOf`'s rule): an asked row is found by its PLACE when the
  // row there bears its name (review seams-5 — by name alone, two rows of one
  // model were one, and answering the first closed the second); else by its
  // name over EVERY row of that name, the safe side: the ask stands while any
  // of them still has the file's figure, or none.
  const offsets: number[] = [];
  let total = 0;
  for (const file of list) {
    offsets.push(total);
    total += file.rows;
  }
  const placed = total === goods.length;
  list.forEach((file, i) => {
    for (const ask of file.asks ?? []) {
      const unanswered = (row: GoodsList[number], value: number) => {
        if ((row.derived?.person ?? []).includes(ask.field)) return false;
        const now = row[ask.field] ?? null;
        return now === null || now === value;
      };
      const open = ask.rows.some(({ name, value, at }) => {
        const there = placed && at !== undefined ? goods[offsets[i]! + at] : undefined;
        const rows = there && there.name === name ? [there] : goods.filter((g) => g.name === name);
        return rows.some((row) => unanswered(row, value));
      });
      if (!open) continue;
      const what = ask.field === 'weightKg' ? 'og‘irligini (kg)' : 'hajmini (m³)';
      out.push({
        id: `col:${i}:${ask.field}`,
        row: null,
        holds: true,
        text: `«${ask.title}» ustuni — bitta karobkanikimi yoki qatornikimi? Har qatorning umumiy ${what} yozing: «1: …».`,
      });
    }
  });
  return out;
}

/** Each held row's weight kind, from the file blocks — unknown when they do not add up. */
export function rowKindsOf(files: readonly GoodsFileMeta[] | undefined, count: number): WeightKind[] {
  const kinds = (files ?? []).flatMap((f) => Array.from({ length: f.rows }, () => f.weightKind));
  return kinds.length === count ? kinds : Array.from({ length: count }, () => null);
}

/** The weight kinds of the two rows compared. */
export interface RowKinds {
  held: WeightKind;
  read: WeightKind;
}

const UNKNOWN_KINDS: RowKinds = { held: null, read: null };

/** A gross weight is compared with a gross one only; a netto, a plain and an unknown weight are the line's own. */
const grossOnly = (k: WeightKind) => k === 'gross';

/**
 * A row's weight computed from its cartons' GROSS — «G.W./CTN» × «CTNS», the
 * row's own column empty (docs/AI-SORAYDI.md §3.2 X4; `derived.weightIsGross`,
 * carton-math.ts) — is a brutto whatever column its FILE's line weights came
 * from: such a sheet has no line-weight column at all, so its kind reads
 * unknown, and compared as «the line's own» the brutto disagreed with the
 * same row's netto in the next file — one order, landed twice. Nor is it a
 * netto a packing list may write into a goods row, or sum as one.
 */
const cartonsGross = (g: GoodsList[number]): boolean => g.derived?.weightIsGross === true;
/**
 * A packing list row's weight that is the KERNEL's product, of any kind — what
 * its packages give, never a figure its line states (docs/AI-SORAYDI.md §3.2
 * X4). A netto fill copies only what the list STATES: the packages themselves
 * travel (`packingCarries`), and the goods row's weight is computed from them
 * there, marked as the bot's — or judged against a weight the row states.
 */
const fillable = (p: GoodsList[number]): boolean => !cartonsGross(p) && p.derived?.weightKg === undefined;
const kindOf = (g: GoodsList[number], fileKind: WeightKind): WeightKind => (cartonsGross(g) ? 'gross' : fileKind);

/**
 * The same-unit figures two rows of two files BOTH state: a count with a
 * count (a carton count never reaches `quantity` — the door routes it into
 * the note), a weight with a weight of the same kind (never a gross with a
 * netto), a cube with a cube, a measure with a measure in the same unit.
 * Money is not one: the row carries no currency, and one file's unit price
 * stands beside another's line total.
 */
function sharedFigures(held: GoodsList[number], read: GoodsList[number], kinds: RowKinds): (typeof LINE_FIGURES)[number][] {
  return LINE_FIGURES.filter((f) => {
    if (f.field === 'amount') return false;
    if (figureOf(held, f.field) === null || figureOf(read, f.field) === null) return false;
    if (f.field === 'weightKg') return grossOnly(kindOf(held, kinds.held)) === grossOnly(kindOf(read, kinds.read));
    if (f.field === 'measureQty') return held.measureUnit != null && held.measureUnit === read.measureUnit;
    return true;
  });
}

/**
 * Is the row of a further Excel a row already held, read again
 * (docs/IKKI-ESHIK.md §1.2.2, M1)? All three: the names meet (the whole name,
 * or one it answers to — `goodsNameKeys` / `namesMeet`), at least one
 * same-unit figure is shared, and EVERY shared one agrees. Stricter than
 * `sameGoodsLine` on purpose (F3): there a model line beside the Excel needs
 * only one figure to agree, because the model re-reads the same document;
 * here two Excels are two documents, and two factories shipping one generic
 * name with one equal figure is this business's ordinary day (INT-4) — a row
 * added is one press to delete on the VED's screen, a row dropped is silent.
 * Pure.
 */
export function sameRowAgain(held: GoodsList[number], read: GoodsList[number], kinds: RowKinds = UNKNOWN_KINDS): boolean {
  const h = keysOf(held.name);
  const r = keysOf(read.name);
  if (!h.whole || !r.whole) return false;
  if (h.whole !== r.whole && !namesMeet(h, r)) return false;
  const shared = sharedFigures(held, read, kinds);
  return shared.length > 0 && shared.every((f) => figureAgrees(f, held, read));
}

/** Do the two names point at one product, the wide way (`namesMeet`, or the same whole name)? */
function namesMeetLine(a: GoodsList[number], b: GoodsList[number]): boolean {
  const x = keysOf(a.name);
  const y = keysOf(b.name);
  return Boolean(x.whole && y.whole) && (x.whole === y.whole || namesMeet(x, y));
}

/**
 * The rows of a list by every name they answer to, so a row meets its
 * possible namesakes by LOOK-UP instead of a scan of the list (DURABILITY-1).
 * `named(q)` is a SUPERSET of the rows whose names meet `q` the wide way
 * (`namesMeet`, or the same whole name) — each clause of `namesMeet` has its
 * own map — in list order, so the caller's exact test then picks the very row
 * a scan would have. `counted(n)` is the rows stating exactly that count: a
 * twin by figures (`sameFigures`) and an equal-count meet both need one.
 */
function rowIndex(rows: GoodsList): { named(q: NameKeys): number[]; counted(n: number | null): number[] } {
  const byWhole = new Map<string, number[]>();
  const byKey = new Map<string, number[]>();
  const byInside = new Map<string, number[]>();
  const byHalf = new Map<string, number[]>();
  const byCount = new Map<number, number[]>();
  const put = (map: Map<string, number[]>, k: string, i: number) => {
    const at = map.get(k);
    if (!at) map.set(k, [i]);
    else if (at[at.length - 1] !== i) at.push(i);
  };
  rows.forEach((row, i) => {
    const x = keysOf(row.name);
    if (x.whole) put(byWhole, x.whole, i);
    for (const k of x.keys) put(byKey, k, i);
    for (const k of x.inside) put(byInside, k, i);
    for (const h of x.halves) put(byHalf, h.key, i);
    const n = figureOf(row, 'quantity');
    if (n !== null) {
      const at = byCount.get(n);
      if (at) at.push(i);
      else byCount.set(n, [i]);
    }
  });
  return {
    named(q) {
      if (!q.whole) return [];
      const out = new Set<number>();
      const take = (at: number[] | undefined) => at?.forEach((i) => out.add(i));
      // a.keys ∋ q.whole (the same whole name too: a row's keys hold its whole)
      take(byKey.get(q.whole));
      // q.keys ∋ a.whole
      for (const k of q.keys) take(byWhole.get(k));
      // a row's half meets q: q's whole, or what q's brackets hold
      take(byHalf.get(q.whole));
      for (const k of q.inside) take(byHalf.get(k));
      // q's half meets a row: the row's whole, or what its brackets hold
      for (const h of q.halves) {
        take(byWhole.get(h.key));
        take(byInside.get(h.key));
      }
      return [...out].sort((a, b) => a - b);
    },
    counted(n) {
      return n === null ? [] : (byCount.get(n) ?? []);
    },
  };
}

/** The ascending union of two ascending index lists. */
function unionSorted(a: readonly number[], b: readonly number[]): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

/**
 * A count AND a weight on both rows, in comparable units, both equal — the
 * same row under another name («nomi boshqacha, raqamlari bir xil», §1.2.2,
 * M1 c): a Chinese PDF's «女士夹克» read as «Куртка женская» beside the
 * Excel's «Ladies jacket», one tile written «60x60cm» and «600×600 мм» — only
 * the figures say they are one line. Unless the names CONTRADICT each other
 * (`namesContradict`): two stalls' «iPhone 16 Pro» and «iPhone 16 Plus»
 * cases, «Nails 2.5*50mm» and «Гвозди 3×70 мм», may ship the same count at the
 * same weight and are two products (the corpus' c2367, c2202). Pure.
 */
export function sameFigures(held: GoodsList[number], read: GoodsList[number], kinds: RowKinds = UNKNOWN_KINDS): boolean {
  const shared = sharedFigures(held, read, kinds);
  const both = shared.filter((f) => f.field === 'quantity' || f.field === 'weightKg');
  return (
    both.length === 2 &&
    both.every((f) => (f.field === 'weightKg' ? twinWeight(held.weightKg!, read.weightKg!) : figureAgrees(f, held, read))) &&
    !namesContradict(held.name, read.name)
  );
}

/**
 * The weight two lines of two NAMES share, equal only to the gram or within
 * 0.5 % (review PF-ADV-7). `LINE_FIGURES`' «under 1 kg apart» is for one
 * document read twice; with nothing but the figures to say two names are one
 * line, it made «Phone case» 100 / 5 kg and «Защитное стекло» 100 / 5.4 kg
 * one row and dropped the glass.
 */
function twinWeight(a: number, b: number): boolean {
  const gap = Math.abs(a - b);
  return gap < 0.001 || gap <= 0.005 * Math.max(Math.abs(a), Math.abs(b));
}

/**
 * The units a name writes its sizes in, one spelling per unit across the
 * scripts a seller writes — so «50mm» and «70 мм» are two sizes in ONE unit,
 * while «60cm» and «600 мм» are one size in two (nobody converts here; a
 * conversion is never a contradiction).
 */
const SIZE_UNITS: Readonly<Record<string, string>> = {
  mm: 'mm', мм: 'mm', cm: 'cm', см: 'cm', m: 'm', м: 'm',
  ml: 'ml', мл: 'ml', l: 'l', л: 'l',
  w: 'w', вт: 'w', kw: 'kw', квт: 'kw', mah: 'mah', мач: 'mah',
  inch: 'inch', дюйм: 'inch', дюйма: 'inch', дюймов: 'inch',
  kg: 'kg', кг: 'kg', g: 'g', г: 'g',
};

/** A number as a size writes it: «2,8» and «2.8», «12,000» and «12 000». */
function sizeNumber(text: string): number {
  const t = text.replace(/[\s\u00a0]/g, '');
  if (/^\d{1,3}(?:,\d{3})+$/.test(t)) return Number(t.replace(/,/g, ''));
  return Number(t.replace(',', '.'));
}

/** «2.5*50mm» → mm: [2.5, 50] — every number of a run sized in a unit, by that unit. */
function sizesOf(name: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const NUMBER = String.raw`\d{1,3}(?:[ \u00a0]\d{3})+|\d+(?:[.,]\d+)?`;
  const run = new RegExp(String.raw`((?:${NUMBER})(?:\s*[*x×х/~\-–]\s*(?:${NUMBER}))*)\s*([a-zа-яё]+)(?![\p{L}\p{N}])`, 'giu');
  for (const m of name.normalize('NFKC').matchAll(run)) {
    const unit = SIZE_UNITS[m[2]!.toLowerCase()];
    if (!unit) continue;
    const numbers = (m[1]!.match(new RegExp(NUMBER, 'g')) ?? []).map(sizeNumber).filter((n) => Number.isFinite(n));
    out.set(unit, [...(out.get(unit) ?? []), ...numbers]);
  }
  return out;
}

/** `sizesOf`, read once per name (DURABILITY-1). */
const sizesOfName = remembered(sizesOf);

/**
 * Do two names say they are two DIFFERENT products, whatever their figures —
 * another model TIER («iPhone 16 Pro» / «iPhone 16 Plus», `tierWords`), or
 * other sizes in the SAME unit («2.5*50mm» / «3×70 мм»)? A size in another
 * unit is a translation's conversion and says nothing. Pure.
 */
export function namesContradict(a: string, b: string): boolean {
  const tiersA = tiersOfKey(keyOf(a));
  const tiersB = tiersOfKey(keyOf(b));
  if ([...tiersA].some((t) => !tiersB.has(t)) || [...tiersB].some((t) => !tiersA.has(t))) return true;
  const sizesB = sizesOfName(b);
  for (const [unit, ofA] of sizesOfName(a)) {
    const ofB = sizesB.get(unit);
    if (!ofB) continue;
    const x = [...ofA].sort((p, q) => p - q);
    const y = [...ofB].sort((p, q) => p - q);
    if (x.length !== y.length || x.some((n, i) => Math.abs(n - y[i]!) > 1e-9)) return true;
  }
  return false;
}

/**
 * What a held row takes from its duplicate — only what it LACKS: the code,
 * the unit word, the measure pair, the money, and — given the kernel
 * (`repack`) — the packages its duplicate states (`carriedPacking`, the seam:
 * a second file's «CTNS | CTN SIZE» beside a first that states none). Its own
 * figures stand (§1.2.2); the kernel judges them against the packages.
 */
function fillGaps(held: GoodsList[number], dup: GoodsList[number], repack?: Repack): GoodsList[number] {
  const filled = fillFigureGaps(held, dup);
  return (repack && carryOnto(filled, dup, repack)) || filled;
}

function fillFigureGaps(held: GoodsList[number], dup: GoodsList[number]): GoodsList[number] {
  const out = { ...held };
  if (!out.tnvedCode && dup.tnvedCode) out.tnvedCode = dup.tnvedCode;
  if (!out.unit && dup.unit) out.unit = dup.unit;
  if ((out.measureQty == null || out.measureUnit == null) && dup.measureQty != null && dup.measureUnit != null) {
    out.measureUnit = dup.measureUnit;
    out.measureQty = dup.measureQty;
    // The duplicate's measure IS the held row's unit-less count in its unit
    // («120» here, «120 пар» there — the door routed that count into the
    // pair): one count stated once, never 120 pieces AND 120 pairs (review
    // PF-ADV-15).
    if (!held.unit && dup.quantity == null && held.quantity != null && held.quantity === dup.measureQty) out.quantity = null;
  }
  if (out.amount == null && dup.amount != null) out.amount = dup.amount;
  return out;
}

/**
 * The same row stated again, word for word: the same whole name, code, unit,
 * figures, money and note. `filled` — a held row may carry a weight its own
 * line lacked: a packing list beside it wrote the netto in (`packingFills`),
 * and the row read again is the line as it was sent.
 */
function identicalRow(held: GoodsList[number], read: GoodsList[number], filled = false): boolean {
  const whole = keyOf(held.name);
  if (!whole || whole !== keyOf(read.name)) return false;
  const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  return (
    same(held.quantity, read.quantity) &&
    same(held.unit, read.unit) &&
    ((filled && read.weightKg == null) || same(held.weightKg, read.weightKg)) &&
    same(held.volumeM3, read.volumeM3) &&
    same(held.measureUnit, read.measureUnit) &&
    same(held.measureQty, read.measureQty) &&
    same(held.amount, read.amount) &&
    same(held.tnvedCode, read.tnvedCode) &&
    same(held.note, read.note)
  );
}

/** How many sentences of one kind a file's note names before it counts the rest. */
const NAMED_LINES = 3;

const clip = (name: string) => (name.length > 30 ? `${name.slice(0, 29)}…` : name);
const num = (n: number) => String(Number(n.toFixed(3)));

/** A row's first figure in the seller's words — «200 dona», «150 kg», «40 juft» — or null. */
function figureWords(g: GoodsList[number], prefer?: 'quantity' | 'weightKg' | 'measureQty' | 'volumeM3'): string | null {
  const words: Record<'quantity' | 'weightKg' | 'measureQty' | 'volumeM3', string | null> = {
    quantity: figureOf(g, 'quantity') !== null ? `${num(g.quantity!)} dona` : null,
    weightKg: figureOf(g, 'weightKg') !== null ? `${num(g.weightKg!)} kg` : null,
    measureQty: figureOf(g, 'measureQty') !== null && g.measureUnit ? `${num(g.measureQty!)} ${g.measureUnit === 'm2' ? 'm²' : g.measureUnit === 'sm3' ? 'sm³' : g.measureUnit}` : null,
    volumeM3: figureOf(g, 'volumeM3') !== null ? `${num(g.volumeM3!)} m³` : null,
  };
  if (prefer && words[prefer]) return words[prefer];
  return words.quantity ?? words.weightKg ?? words.measureQty ?? words.volumeM3;
}

/** The field a row's first figure is in — so the held row's figure is said in the same unit. */
function firstField(g: GoodsList[number]): 'quantity' | 'weightKg' | 'measureQty' | 'volumeM3' | undefined {
  if (figureOf(g, 'quantity') !== null) return 'quantity';
  if (figureOf(g, 'weightKg') !== null) return 'weightKg';
  if (figureOf(g, 'measureQty') !== null && g.measureUnit) return 'measureQty';
  if (figureOf(g, 'volumeM3') !== null) return 'volumeM3';
  return undefined;
}

/** «… va yana N ta» after the first `NAMED_LINES` sentences. */
function capped(sentences: string[], label: string): string[] {
  if (sentences.length <= NAMED_LINES) return sentences;
  return [...sentences.slice(0, NAMED_LINES), `📄 ${label} — yana ${sentences.length - NAMED_LINES} ta shunday qator.`];
}

/**
 * Is a further Excel the SAME FILE again (review PF-ADV-6)? The seller who
 * forwards one Excel twice is the commonest double send, and a names-only or
 * an amounts-only list shares no figure for `sameRowAgain` to compare — every
 * row landed twice. Every row identical, word for word, to a different held
 * row, and its other sheets (if any) one a held file already gave: nothing of
 * it is new. A row sharing nothing with its namesake in a DIFFERENT file is
 * still added (§1.2.2): two factories' bare «Kurtka» are two lines. Pure.
 */
export function sameFileAgain(
  held: GoodsList,
  read: GoodsList,
  readText: string,
  heldTexts: readonly { text: string }[],
): boolean {
  if (read.length === 0) return false;
  if (readText.trim() !== '' && !heldTexts.some((t) => t.text.trim() === readText.trim())) return false;
  const claimed = new Set<number>();
  // An identical row has the same whole name: looked up, never scanned (DURABILITY-1).
  const byWhole = new Map<string, number[]>();
  held.forEach((h, i) => {
    const whole = keyOf(h.name);
    if (whole) byWhole.set(whole, [...(byWhole.get(whole) ?? []), i]);
  });
  return read.every((r) => {
    const at = (byWhole.get(keyOf(r.name)) ?? []).find((i) => !claimed.has(i) && identicalRow(held[i]!, r));
    if (at === undefined) return false;
    claimed.add(at);
    return true;
  });
}

/** The sentence for a file sent again (`sameFileAgain`). */
export function sameFileNote(label: string): string {
  return `📄 ${label} — bu fayl avval yuborilgan: qatorlari bir marta olindi.`;
}

/**
 * Is a WORKBOOK with several mapped sheets the same file again
 * (docs/FAYL-OQISH.md §4.1, sheets-06)? Judged as a whole, before any of its
 * sheets is: its goods sheet's rows are held, word for word (a netto a
 * packing sheet wrote into a held row is not a difference — `identicalRow`'s
 * `filled`); its unmapped sheets' text is held; and every further mapped
 * sheet is held one way or the other — its text (a packing list of the same
 * goods and a sheet read for the totals go to the model's sheets) or its rows
 * (another factory's, folded in). Judged sheet by sheet instead, a re-sent
 * CI+PL workbook pushed the packing list's text in twice and said «o‘sha
 * tovarlar» again. One held row answers one read row across every sheet.
 * Pure.
 */
export function sameWorkbookAgain(
  held: GoodsList,
  goods: GoodsList,
  further: readonly { goods: GoodsList; text: string }[],
  text: string,
  heldTexts: readonly { text: string }[],
): boolean {
  if (goods.length === 0) return false;
  const isHeld = (t: string) => t.trim() !== '' && heldTexts.some((h) => h.text.trim() === t.trim());
  if (text.trim() !== '' && !isHeld(text)) return false;
  const claimed = new Set<number>();
  const byWhole = new Map<string, number[]>();
  held.forEach((h, i) => {
    const whole = keyOf(h.name);
    if (whole) byWhole.set(whole, [...(byWhole.get(whole) ?? []), i]);
  });
  const take = (rows: GoodsList) => {
    const at = rows.map((r) => {
      const i = (byWhole.get(keyOf(r.name)) ?? []).find((j) => !claimed.has(j) && identicalRow(held[j]!, r, true));
      if (i !== undefined) claimed.add(i);
      return i;
    });
    return at.every((i) => i !== undefined);
  };
  if (!take(goods)) return false;
  return further.every((f) => isHeld(f.text) || (f.goods.length > 0 && take(f.goods)));
}

/** What a further invoice-shaped Excel did to the held list. */
export interface FoldedInvoice {
  goods: GoodsList;
  /** The rows ADDED, at the end of `goods`. */
  added: number;
  notes: string[];
}

/**
 * An invoice-shaped further Excel, compared row by row with the held list
 * (docs/IKKI-ESHIK.md §1.2.2):
 *  - the same row again (`sameRowAgain`) is dropped as a duplicate, and the
 *    held row takes what it lacks from it;
 *  - names that do not meet, with a count AND a weight equal to exactly ONE
 *    held row's, are that row too — named «nomi boshqacha, raqamlari bir xil»;
 *  - anything else is ADDED — a same-named row whose figures disagree or
 *    share nothing included, and named, for the VED to delete one if they are
 *    one (INT-4: two factories, one name, two lines).
 * A held row is claimed once, so two «Kurtka» rows of B meet two of A, never
 * one twice. `heldKinds` is each held row's weight kind (`rowKindsOf`). Pure.
 */
export function foldInvoice(
  held: GoodsList,
  heldKinds: readonly WeightKind[],
  read: GoodsList,
  readKind: WeightKind,
  label: string,
  /** Between the label and the head's count: « — » for a file; a sheet's label ends «… varag‘idan», which reads on with a space. */
  join = ' — ',
  /** The kernel, for the packages a duplicate carries onto its held row (`fillGaps`); absent = none carried. */
  repack?: Repack,
): FoldedInvoice {
  const out = held.map((g) => ({ ...g }));
  const claimed = new Set<number>();
  const added: GoodsList = [];
  const cross: string[] = [];
  const namesakes: string[] = [];
  let again = 0;
  const kinds = (i: number): RowKinds => ({ held: heldKinds[i] ?? null, read: readKind });
  // Each read row meets its candidates by look-up (DURABILITY-1); the exact
  // tests below still decide, in list order, so the row a scan picked is the
  // row picked. A held row's name never changes (`fillGaps` keeps it).
  const index = rowIndex(out);
  for (const r of read) {
    const named = index.named(keysOf(r.name));
    const at = named.find((i) => !claimed.has(i) && sameRowAgain(out[i]!, r, kinds(i)));
    if (at !== undefined) {
      claimed.add(at);
      out[at] = fillGaps(out[at]!, r, repack);
      again += 1;
      continue;
    }
    // A twin by figures states the same count: only those rows are asked.
    const twins = index
      .counted(figureOf(r, 'quantity'))
      .filter((i) => !claimed.has(i) && !namesMeetLine(out[i]!, r) && sameFigures(out[i]!, r, kinds(i)));
    if (twins.length === 1) {
      const i = twins[0]!;
      claimed.add(i);
      cross.push(`📄 ${label} — «${clip(r.name)}» va «${clip(out[i]!.name)}»: nomi boshqacha, raqamlari bir xil — bitta deb olindi.`);
      out[i] = fillGaps(out[i]!, r, repack);
      again += 1;
      continue;
    }
    const namesakeAt = named.find((i) => namesMeetLine(out[i]!, r));
    const namesake = namesakeAt === undefined ? undefined : out[namesakeAt];
    if (namesake) {
      const field = firstField(r);
      const readWords = figureWords(r);
      // The held figure in the read's own unit is said bare, as the spec's
      // sentence has it («… «Kurtka» 300 — ikkalasi olindi»); another unit
      // keeps its word (review PF-SPEC-8).
      const heldWords = field && figureOf(namesake, field) !== null ? num(figureOf(namesake, field)!) : figureWords(namesake, field);
      namesakes.push(
        `📄 ${label} — «${clip(r.name)}»${readWords ? ` ${readWords}` : ''}: birinchi faylda ham «${clip(namesake.name)}»${heldWords ? ` ${heldWords}` : ''} — ikkalasi olindi (bir xil bo‘lsa, VED bittasini o‘chiradi).`,
      );
    }
    added.push(r);
  }
  const head =
    again === 0
      ? added.length > 0
        ? `📄 ${label}${join}${added.length} ta yangi tovar qo‘shildi.`
        : null
      : added.length > 0
        ? `📄 ${label}${join}${again} tasi ro‘yxatda bor edi, ${added.length} ta yangi tovar qo‘shildi.`
        : `📄 ${label}${join}${again} tasi ro‘yxatda bor edi, yangi tovar qo‘shilmadi.`;
  return {
    goods: [...out, ...added],
    added: added.length,
    notes: [...(head ? [head] : []), ...capped(cross, label), ...capped(namesakes, label)],
  };
}

/** The totals a packing list GIVES: its gross Σ as the brutto, else its net Σ as a netto; its cube. */
export interface PackingTotals {
  weightKg: number | null;
  weightNetto: boolean;
  volumeM3: number | null;
}

/**
 * A packing list's totals (docs/IKKI-ESHIK.md §1.2.2, M2): the brutto is its
 * GROSS Σ and nothing else — with no gross column there is no brutto; a Σ
 * from a NET column is offered as a netto (`weightNetto`), which the freight
 * total refuses where the section needs brutto (`totalWeightFrom`); the cube
 * is its m³ Σ. A plain weight column is neither: nobody can say which it is.
 */
export function packingTotals(
  meta: Pick<GoodsFileMeta, 'weightKind' | 'grossKg' | 'volumeM3' | 'capped'>,
  rows: GoodsList,
): PackingTotals {
  // A list the reader stopped short of its end gives no totals (PF-ADV-2).
  if (meta.capped) return { weightKg: null, weightNetto: false, volumeM3: null };
  if (meta.grossKg !== null) return { weightKg: meta.grossKg, weightNetto: false, volumeM3: meta.volumeM3 };
  if (meta.weightKind === 'net' && rows.length > 0 && rows.every((g) => figureOf(g, 'weightKg') !== null && g.weightKg! > 0 && !cartonsGross(g))) {
    const sum = rows.reduce((n, g) => n + g.weightKg!, 0);
    return { weightKg: Number(sum.toFixed(3)), weightNetto: true, volumeM3: meta.volumeM3 };
  }
  return { weightKg: null, weightNetto: false, volumeM3: meta.volumeM3 };
}

/** A total a file's own column questions doubt (`withoutAskedTotals`). */
export type AskedTotal = 'weightKg' | 'volumeM3';

/**
 * The totals a file's OWN column questions take from it (docs/AI-SORAYDI.md
 * §3.2 X5; ruling JR-11 «the line figures STAY, the Σ stays null, and the
 * column is asked»; review seams-2, seams-4). A column the table asks «one
 * carton's or the line's?» adds up to the very figure the question doubts —
 * 36 kg / 0.18 m³ where, one carton's, the shipment is 710 kg / 3.8 m³ — and
 * the seller answers it ROW by row, so its Σ, or the TOTAL row that is its Σ,
 * is never the shipment's: under ✅ it stayed 20× small after every row was
 * answered as told. So the cube falls to the current lines' Σ «qatorlardan»,
 * which follows his answers, and the brutto is asked. A brutto in a gross
 * column of its OWN beside an asked NET column is not the asked column's and
 * stands; a netto offered from the asked column is its Σ and goes.
 *
 * `doubted` — what the model's reading of the same file must not stand for
 * either (it reads that TOTAL row as text); `dropped` — the asked columns
 * whose total is not taken, for the receipt to name. Only on a door that ASKS
 * (`tableAsksOf` draws the column there): the plain door is frozen and takes
 * the file as it stands. Pure.
 */
export function withoutAskedTotals(
  meta: Pick<GoodsFileMeta, 'asks' | 'weightKind' | 'grossColumn'>,
  totals: PackingTotals,
): { totals: PackingTotals; doubted: AskedTotal[]; dropped: ColumnAsk[] } {
  const asks = meta.asks ?? [];
  if (asks.length === 0) return { totals, doubted: [], dropped: [] };
  const asked = (field: AskedTotal) => asks.some((a) => a.field === field);
  const ownGross = meta.weightKind === 'net' && meta.grossColumn;
  const doubted: AskedTotal[] = [];
  let { weightKg, weightNetto, volumeM3 } = totals;
  if (asked('weightKg') && (!ownGross || weightNetto)) {
    weightKg = null;
    weightNetto = false;
    if (!ownGross) doubted.push('weightKg');
  }
  if (asked('volumeM3')) {
    volumeM3 = null;
    doubted.push('volumeM3');
  }
  const after = { weightKg, weightNetto, volumeM3 };
  return { totals: after, doubted, dropped: asks.filter((a) => after[a.field] === null) };
}

/** Both rows state a count (or a measure in one unit), and the counts differ. */
function countsDisagree(a: GoodsList[number], b: GoodsList[number]): boolean {
  const qa = figureOf(a, 'quantity');
  const qb = figureOf(b, 'quantity');
  if (qa !== null && qb !== null && qa !== qb) return true;
  const ma = figureOf(a, 'measureQty');
  const mb = figureOf(b, 'measureQty');
  return ma !== null && mb !== null && a.measureUnit != null && a.measureUnit === b.measureUnit && ma !== mb;
}

/**
 * Is a packing-shaped file a packing list OF the held goods — «o‘sha
 * tovarlar» — or another factory's own list that merely has a carton or gross
 * column and no money (review PF-ADV-5)? The shape is a column decision; the
 * totals role needs the rows to answer to the held ones. Either more than half
 * of its rows each meet a DIFFERENT held row — by name with no count against
 * it, by count and weight (`sameFigures`), or by an equal count under names
 * that do not contradict (a Chinese list beside a Russian invoice) — or the
 * whole lists count the same pieces (one shipment, broken down otherwise:
 * «Kurtka 300» invoiced, S/M/L 100 each packed). Otherwise its goods are new
 * goods (his 1a) and its totals are not the shipment's. Pure.
 */
export function packingOfHeld(
  held: GoodsList,
  heldKinds: readonly WeightKind[],
  packing: GoodsList,
  packingKind: WeightKind,
): boolean {
  const meets = packingMeets(held, heldKinds, packing, packingKind);
  return meets.samePieces || meets.met * 2 > packing.length;
}

/**
 * Does a packing list of the held goods answer for the WHOLE held list — its
 * totals the shipment's? `packingOfHeld` asks only that most of the PACKING
 * list's rows meet held rows; once a fold has added another factory's goods
 * to the list (a sheet folded in, a second factory's file), factory A's own
 * packing list still passes it, and its Σ was written and announced as the
 * shipment's brutto and cube with factory B's cargo in the list and out of
 * both (as-built review SHEETS-3). It covers when the lists count the same
 * pieces, or when every held row is met by a row of its own. Pure.
 */
export function packingCoversHeld(
  held: GoodsList,
  heldKinds: readonly WeightKind[],
  packing: GoodsList,
  packingKind: WeightKind,
): boolean {
  const meets = packingMeets(held, heldKinds, packing, packingKind);
  return meets.samePieces || (held.length > 0 && meets.met === held.length);
}

/** How a packing list answers to the held rows: the same Σ pieces, and how many held rows a row of it meets. */
function packingMeets(
  held: GoodsList,
  heldKinds: readonly WeightKind[],
  packing: GoodsList,
  packingKind: WeightKind,
): { samePieces: boolean; met: number } {
  if (held.length === 0 || packing.length === 0) return { samePieces: false, met: 0 };
  const total = (rows: GoodsList) =>
    rows.every((g) => figureOf(g, 'quantity') !== null) ? rows.reduce((n, g) => n + g.quantity!, 0) : null;
  const heldPieces = total(held);
  if (heldPieces !== null && heldPieces > 0 && heldPieces === total(packing)) return { samePieces: true, met: 0 };
  return { samePieces: false, met: meetPairs(held, heldKinds, packing, packingKind).length };
}

/**
 * Which held row each row of a packing list meets, one held row to one row of
 * the list (`[packingIndex, heldIndex]`, in the list's order) — the meeting
 * `packingOfHeld` counts, and the one a row's packages travel by
 * (`packingCarries`).
 */
function meetPairs(held: GoodsList, heldKinds: readonly WeightKind[], packing: GoodsList, packingKind: WeightKind): [number, number][] {
  const claimed = new Set<number>();
  const pairs: [number, number][] = [];
  // A held row meets by name, or — names apart — by an equal count (a twin by
  // figures states one too): only those rows are asked, in list order
  // (DURABILITY-1).
  const index = rowIndex(held);
  packing.forEach((p, j) => {
    const candidates = unionSorted(index.named(keysOf(p.name)), index.counted(figureOf(p, 'quantity')));
    const at = candidates.find((i) => {
      if (claimed.has(i)) return false;
      const h = held[i]!;
      if (namesMeetLine(h, p)) return !countsDisagree(h, p);
      if (sameFigures(h, p, { held: heldKinds[i] ?? null, read: packingKind })) return true;
      const q = figureOf(h, 'quantity');
      return q !== null && q === figureOf(p, 'quantity') && !namesContradict(h.name, p.name);
    });
    if (at === undefined) return;
    claimed.add(at);
    pairs.push([j, at]);
  });
  return pairs;
}

/** The letter scripts a key writes — han, cyrillic, latin (numbers and other scripts are none of them). */
function scriptsOf(key: string): Set<string> {
  const out = new Set<string>();
  for (const bucket of wordsOfKey(key).keys()) if (bucket === 'han' || bucket === 'cyrillic' || bucket === 'latin') out.add(bucket);
  return out;
}
const scriptsOfKey = remembered(scriptsOf);
const shareScript = (a: ReadonlySet<string>, b: ReadonlySet<string>) => [...a].some((x) => b.has(x));

/** The pieces a list counts, when EVERY row states a count; null otherwise. */
function piecesOf(rows: GoodsList): number | null {
  return rows.every((g) => figureOf(g, 'quantity') !== null) ? rows.reduce((n, g) => n + g.quantity!, 0) : null;
}

/**
 * Is a further sheet of a workbook PROVEN to hold OTHER goods than the held
 * list (docs/FAYL-OQISH.md §4.2, sheets-01)? Positive evidence of
 * disjointness, never the absence of a meeting — all three:
 *  - both lists state a piece count on EVERY row, and the Σ pieces differ (so
 *    the whole-list test of a packing list of the same goods ran and failed —
 *    a packing list counts cartons, which never reach `quantity`);
 *  - every row shares a letter script with every held row it is held against
 *    (a Chinese row beside an English one can be its translation);
 *  - every row is ANOTHER NAME than every held row (`otherName`: each has a
 *    word the other lacks). «Куртка женская» is not another name than
 *    «Куртка женская зимняя на синтепоне» — the customs name of the same
 *    jacket — and «no `namesMeet`» said it was (the judge's t3: one
 *    workbook's invoice and its short-named packing list folded to six rows).
 * Anything short of that is not proven, and the workbook keeps today's
 * reading. `stored` — a top-up's rows already on the request — only fence the
 * NAMES: every row must be another name than each of them too («Krossovka
 * sport» beside a stored «Krossovka» may be that row, and the landing would
 * price it twice). They count into no Σ and are asked no count: a request's
 * own goods are not the workbook's goods sheet, and counted in, a stored
 * «Ladies jacket» 300 made an invoice and its Specification of the same 920
 * pieces «other» and folded the goods twice, while a stored row with a weight
 * and no count kept a real «Zavod B» out (review sheets-break-topup-sum-kept).
 * `otherName` asks a script both names write, so a stored row in another
 * script — what a line may translate — proves nothing either. Pure.
 */
export function provenOther(held: GoodsList, read: GoodsList, stored: readonly GoodsList[number][] = []): boolean {
  if (held.length === 0 || read.length === 0) return false;
  const ours = piecesOf(held);
  const theirs = piecesOf(read);
  if (ours === null || theirs === null || ours === theirs) return false;
  const heldKeys = held.map((g) => keyOf(g.name));
  const storedKeys = stored.map((g) => keyOf(g.name));
  if (heldKeys.some((k) => !k) || storedKeys.some((k) => !k)) return false;
  return read.every((g) => {
    const key = keyOf(g.name);
    if (!key) return false;
    const scripts = scriptsOfKey(key);
    return heldKeys.every((k) => shareScript(scripts, scriptsOfKey(k)) && otherName(key, k)) && storedKeys.every((k) => otherName(key, k));
  });
}

/**
 * The commonest workbook the name rules cannot see (docs/FAYL-OQISH.md §4.2,
 * sheets-05 a, R1): an English invoice and the factory's Chinese-only packing
 * list of the same goods, which counts cartons and states no piece — no name
 * meets, no figure is shared, so `packingOfHeld` cannot say it, and the
 * packing list's brutto and cube reached the shipment only through the model.
 * INSIDE ONE WORKBOOK only, a packing-shaped sheet with exactly the goods
 * sheet's row count, in no script the goods sheet writes, is the same goods
 * line for line. The exposure is stated: a workbook of two factories' lists
 * of equal length in two scripts loses factory B to it. Pure; the shapes are
 * the caller's.
 */
export function samePositions(goodsSheet: GoodsList, packing: GoodsList): boolean {
  if (goodsSheet.length === 0 || goodsSheet.length !== packing.length) return false;
  const scripts = (rows: GoodsList) => {
    const out = new Set<string>();
    for (const g of rows) for (const s of scriptsOfKey(keyOf(g.name))) out.add(s);
    return out;
  };
  const ours = scripts(goodsSheet);
  const theirs = scripts(packing);
  return ours.size > 0 && theirs.size > 0 && !shareScript(ours, theirs);
}

/**
 * The kernel's carton arithmetic (`applyPacking(row).line`, carton-math.ts),
 * handed in by the door that reads the file: this file has no runtime import
 * of wms, and the multiplication has ONE home.
 */
export type Repack = (row: GoodsList[number]) => GoodsList[number];

const packingSaid = (p: Packing | null | undefined): p is Packing =>
  Boolean(p) &&
  (p!.cartons !== null || p!.pcsPerCarton !== null || p!.kgPerCarton !== null || p!.m3PerCarton !== null || p!.size !== null || (p!.kgPerPiece ?? null) !== null);

/**
 * What a packing list states per package, as it may stand on the GOODS row it
 * matched (docs/AI-SORAYDI.md §3.2 X4 — the seam): the carton count, what one
 * carton holds, its cube and its size travel whole, so the invoice's row has
 * its cube computed exactly as the packing list's own row did. The weight
 * travels only as a NETTO (`kgPerCartonKind: 'net'`): a goods row's weight is
 * the customs netto, and a packing list's brutto never fills it — its G.W.
 * column never did (`packingFills`), and its cartons' gross is that column one
 * carton at a time. Null = nothing left to carry.
 */
export function carriedPacking(p: Packing | null | undefined): Packing | null {
  if (!packingSaid(p)) return null;
  const net = p.kgPerCartonKind === 'net' && p.kgPerCarton !== null;
  const out: Packing = { ...p };
  if (!net) {
    out.kgPerCarton = null;
    out.kgPerCartonKind = null;
  }
  if ((out.kgPerPiece ?? null) !== null) out.kgPerPiece = null;
  // A factor left behind leaves its source behind with it.
  if (out.fromOf) {
    const fromOf = { ...out.fromOf };
    if (!net) delete fromOf.kgPerCarton;
    delete fromOf.kgPerPiece;
    out.fromOf = fromOf;
  }
  return packingSaid(out) ? out : null;
}

/**
 * One packing row's packages onto one goods row — only onto a row that states
 * none of its own. The goods row's weight KIND goes with them (review
 * excel-break-2, JN-4): its own weight is a G.W. column's brutto beside the
 * list's N.W./CTN, and a gross line weight up to 25 % over its cartons' netto
 * is a row, never a «qaysi biri to‘g‘ri?» — so the kernel must be told which
 * weight the row's is. A kind the row already carries stands.
 */
function carryOnto(h: GoodsList[number], p: GoodsList[number] | undefined, repack: Repack, kind: WeightKind = null): GoodsList[number] | null {
  if (!p || packingSaid(h.packing)) return null;
  const packing = carriedPacking(p.packing);
  if (!packing) return null;
  const said = h.weightKind ?? (kind === 'gross' || kind === 'net' ? kind : null);
  return repack({ ...h, packing, ...(said ? { weightKind: said } : {}) });
}

/**
 * Which held row a packing list's row may hand its PACKAGES to (review
 * excel-break-1): `meetPairs` narrowed to a pairing that NAMES the row. An
 * equal count proves the list is of these goods (`packingOfHeld` counts it),
 * never WHICH row — an invoice «Office chair 40» and «Desk 40» beside a list
 * sorted the other way gave the chair the desk's cartons and size, both rows
 * marked computed and asked nothing. So, in three passes over the whole list:
 * a name that meets (and no count against it); then a twin by count AND
 * weight (`sameFigures`); and only then an equal count under names that do
 * not contradict — when that count is the ONLY one of its value left on both
 * sides, so nothing else could be the row. A list row that met a held row and
 * carries nothing here is `unplaced`: its packages are said not taken. Pure.
 */
function carryPairs(
  held: GoodsList,
  heldKinds: readonly WeightKind[],
  packing: GoodsList,
  packingKind: WeightKind,
): { pairs: [number, number][]; unplaced: number } {
  const index = rowIndex(held);
  const claimed = new Set<number>();
  const paired = new Map<number, number>();
  const take = (j: number, test: (h: GoodsList[number], i: number) => boolean, candidates: (p: GoodsList[number]) => number[]) => {
    if (paired.has(j)) return;
    const p = packing[j]!;
    const at = candidates(p).find((i) => !claimed.has(i) && test(held[i]!, i));
    if (at === undefined) return;
    claimed.add(at);
    paired.set(j, at);
  };
  const named = (p: GoodsList[number]) => index.named(keysOf(p.name));
  const counted = (p: GoodsList[number]) => index.counted(figureOf(p, 'quantity'));
  packing.forEach((p, j) => take(j, (h) => namesMeetLine(h, p) && !countsDisagree(h, p), named));
  packing.forEach((p, j) => take(j, (h, i) => sameFigures(h, p, { held: heldKinds[i] ?? null, read: packingKind }), counted));
  // An equal count, only where it is the one count of its value left on each side.
  const left = (rows: GoodsList, taken: (k: number) => boolean) => {
    const by = new Map<number, number[]>();
    rows.forEach((g, k) => {
      const q = figureOf(g, 'quantity');
      if (q === null || taken(k)) return;
      by.set(q, [...(by.get(q) ?? []), k]);
    });
    return by;
  };
  const heldLeft = left(held, (i) => claimed.has(i));
  const listLeft = left(packing, (j) => paired.has(j));
  for (const [q, js] of listLeft) {
    const is = heldLeft.get(q);
    if (js.length !== 1 || is?.length !== 1) continue;
    const [j, i] = [js[0]!, is[0]!];
    if (namesContradict(held[i]!.name, packing[j]!.name)) continue;
    claimed.add(i);
    paired.set(j, i);
  }
  // What met (`meetPairs`) and carries nothing for want of a row it names.
  let unplaced = 0;
  for (const [j, i] of meetPairs(held, heldKinds, packing, packingKind)) {
    if (paired.has(j) || packingSaid(held[i]!.packing) || !carriedPacking(packing[j]!.packing)) continue;
    unplaced += 1;
  }
  return { pairs: [...paired.entries()].sort((a, b) => a[0] - b[0]), unplaced };
}

/**
 * A packing list over a goods list (docs/IKKI-ESHIK.md §1.2.2) gives each
 * goods row it meets (`meetPairs` — the very meeting that made it a packing
 * list OF these goods) the packages its own row states (`carriedPacking`),
 * and the kernel computes the row's figures from them (`repack`): an invoice
 * of names, counts and money beside the factory's «CTNS | CTN SIZE | G.W./CTN»
 * gets its cube, where before the list's cartons and sizes were read and
 * thrown away and the cube was asked (the seam, §3.2 X4). A row that states a
 * packing of its own keeps it — two packings are never merged here, a clash
 * would have nobody to ask. The row's own figures are judged by the kernel as
 * any file's are: one that agrees stands, one carton's is replaced and said,
 * any other is a doubt the table asks. Runs AFTER the netto fills, which copy
 * only what the list's lines STATE (`fillable`): a line's netto is the file's
 * figure and the packages are judged against it; a weight only the packages
 * give is computed here, marked as the bot's. No `repack` — a caller from
 * before — carries nothing. Pure but for `repack`.
 */
export function packingCarries(
  held: GoodsList,
  heldKinds: readonly WeightKind[],
  packing: GoodsList,
  packingKind: WeightKind,
  repack?: Repack,
): { goods: GoodsList; carried: number; unplaced: number } {
  if (!repack) return { goods: held, carried: 0, unplaced: 0 };
  const goods = [...held];
  let carried = 0;
  const { pairs, unplaced } = carryPairs(held, heldKinds, packing, packingKind);
  for (const [j, i] of pairs) {
    const next = carryOnto(goods[i]!, packing[j], repack, heldKinds[i] ?? null);
    if (!next) continue;
    goods[i] = next;
    carried += 1;
  }
  return { goods, carried, unplaced };
}

/**
 * `packingCarries` by POSITION, for the workbook `samePositions` lines up —
 * never across two counts that disagree. Position IS the pairing there (no
 * name meets across the two scripts), with `samePositions`' own stated
 * exposure: a workbook whose two sheets list the goods in different orders.
 */
export function positionalCarries(
  held: GoodsList,
  packing: GoodsList,
  repack?: Repack,
  heldKinds: readonly WeightKind[] = [],
): { goods: GoodsList; carried: number; unplaced: number } {
  if (!repack) return { goods: held, carried: 0, unplaced: 0 };
  let carried = 0;
  const goods = held.map((h, i) => {
    const p = packing[i];
    const next = p && !countsDisagree(h, p) ? carryOnto(h, p, repack, heldKinds[i] ?? null) : null;
    if (!next) return h;
    carried += 1;
    return next;
  });
  return { goods, carried, unplaced: 0 };
}

/**
 * «N ta qatorga karobka ma’lumoti shu fayldan olindi» — what `packingCarries`
 * did, said beside the fills. It promises no figure: a list that states only
 * its carton counts computes none, and what the kernel did compute carries
 * its own «*» on the table.
 */
export function carriedWords(carried: number, unplaced = 0): string {
  const took = carried > 0 ? `${carried} ta qatorga karobka ma’lumoti shu fayldan olindi.` : '';
  // A packing row met only by a count another row shares (review
  // excel-break-1): which row its packages are, nobody can say — said, so the
  // asked cube is no surprise.
  const left = unplaced > 0 ? `${unplaced} ta qatorniki olinmadi: nomi mos kelmadi, soni boshqa qatorniki bilan bir xil — qaysi qatorniki ekani aniq emas.` : '';
  return [took, left].filter(Boolean).join(' ');
}

/**
 * `packingFills` by POSITION, for the workbook `samePositions` lines up: the
 * row at the same place takes the packing line's NET weight when it states
 * none — never a gross weight, never over a figure the row states, never
 * across two counts that disagree. Pure.
 */
export function positionalFills(held: GoodsList, packing: GoodsList, packingKind: WeightKind): { goods: GoodsList; filled: number } {
  if (packingKind !== 'net') return { goods: held, filled: 0 };
  let filled = 0;
  const goods = held.map((h, i) => {
    const p = packing[i];
    if (!p || figureOf(h, 'weightKg') !== null || figureOf(p, 'weightKg') === null || p.weightKg! <= 0 || !fillable(p) || countsDisagree(h, p)) return h;
    filled += 1;
    return { ...h, weightKg: p.weightKg! };
  });
  return { goods, filled };
}

/**
 * A packing list over a goods list (docs/IKKI-ESHIK.md §1.2.2): it never adds
 * a row and never sets a count — its «мест» is cartons. A held row with NO
 * weight takes its matching line's weight (`sameRowAgain`), and only from a
 * NET column: never a gross weight for a line's netto, never over a figure
 * the row states (INT-10). Pure.
 */
export function packingFills(
  held: GoodsList,
  heldKinds: readonly WeightKind[],
  packing: GoodsList,
  packingKind: WeightKind,
): { goods: GoodsList; filled: number } {
  if (packingKind !== 'net') return { goods: held, filled: 0 };
  const claimed = new Set<number>();
  let filled = 0;
  // The matching line's names meet the row's: looked up, in list order (DURABILITY-1).
  const index = rowIndex(packing);
  const goods = held.map((h, i) => {
    if (figureOf(h, 'weightKg') !== null) return h;
    const at = index
      .named(keysOf(h.name))
      .find(
        (j) =>
          !claimed.has(j) &&
          figureOf(packing[j]!, 'weightKg') !== null &&
          packing[j]!.weightKg! > 0 &&
          fillable(packing[j]!) &&
          sameRowAgain(h, packing[j]!, { held: heldKinds[i] ?? null, read: packingKind }),
      );
    if (at === undefined) return h;
    claimed.add(at);
    filled += 1;
    return { ...h, weightKg: packing[at]!.weightKg! };
  });
  return { goods, filled };
}

/**
 * The note on a packing list beside a goods list (docs/IKKI-ESHIK.md §1.2.4):
 * it names only what was actually read. `rowsFrom` says where the rows came
 * from — «oldingi fayldan», or the invoice that took the goods role after it.
 */
export function packingNote(
  label: string,
  rowsFrom: string,
  totals: PackingTotals,
  grossColumn: boolean,
  filled: number,
  /** Goods rows the list's packages went onto (`packingCarries`). */
  carried = 0,
  /** List rows whose packages no goods row could be named for (`packingCarries`' `unplaced`). */
  unplaced = 0,
  /** The list's asked columns whose total was not taken (`withoutAskedTotals`' `dropped`), and its weight kind. */
  asked: { columns: readonly Pick<ColumnAsk, 'field' | 'title'>[]; weightKind: WeightKind } = { columns: [], weightKind: null },
): string {
  const taken = [
    totals.weightKg !== null ? (totals.weightNetto ? 'umumiy netto' : 'umumiy brutto') : null,
    totals.volumeM3 !== null ? 'kub' : null,
  ].filter((t): t is string => t !== null);
  const carriedSaid = carriedWords(carried, unplaced);
  const fills = `${filled > 0 ? ` ${fillsWords(filled)}` : ''}${carriedSaid ? ` ${carriedSaid}` : ''}`;
  const doubt = asked.columns.length > 0 ? askedColumnsClause(asked.columns, asked.weightKind === 'net') : null;
  if (taken.length === 0) {
    return doubt
      ? `📄 ${label} — o‘sha tovarlar: qatorlar ${rowsFrom}; ${doubt}.${fills}`
      : `📄 ${label} — o‘sha tovarlar: qatorlar ${rowsFrom}, jami o‘qilmadi — VED fayldan ko‘radi.${fills}`;
  }
  // A brutto the column question took is said by that clause, never as a missing column.
  const noBrutto = (totals.weightKg === null || totals.weightNetto) && !asked.columns.some((a) => a.field === 'weightKg');
  const brutto = noBrutto ? (grossColumn ? '; brutto ba’zi qatorlarda yo‘q' : '; brutto ustuni yo‘q') : '';
  return `📄 ${label} — o‘sha tovarlar: qatorlar ${rowsFrom}, bundan faqat ${taken.join(' va ')} olindi${doubt ? `; ${doubt}` : ''}${brutto}.${fills}`;
}

/**
 * The receipt's clause for a packing list's asked columns whose total was not
 * taken (`withoutAskedTotals`, review seams-4) — the column NAMED, as the
 * belt's own «aniq emas» note names its: beside an invoice the rows are the
 * invoice's, so the list's column question is never drawn under them, and
 * this sentence is where the seller learns why the brutto and the cube are
 * asked.
 */
function askedColumnsClause(columns: readonly Pick<ColumnAsk, 'field' | 'title'>[], netto: boolean): string {
  const titles = [...new Set(columns.map((a) => `«${a.title}»`))];
  const what = [
    columns.some((a) => a.field === 'weightKg') ? (netto ? 'umumiy netto' : 'umumiy brutto') : null,
    columns.some((a) => a.field === 'volumeM3') ? 'kub' : null,
  ].filter((w): w is string => w !== null);
  const where = titles.length === 1 ? `${titles[0]} ustunidagi son` : `${titles.join(' va ')} ustunlaridagi sonlar`;
  return `${where} bitta karobkanikimi yoki qatornikimi — aniq emas, shuning uchun ${what.join(' va ')} fayldan olinmadi`;
}

/** «N ta qatorga netto og‘irlik shu fayldan yozildi» — never over a figure the row states. */
export function fillsWords(filled: number): string {
  return `${filled} ta qatorga netto og‘irlik shu fayldan yozildi (yozilgan og‘irlikka tegilmadi).`;
}

/**
 * The note on a packing list in a TOP-UP (an add or seeded collection,
 * §1.2.3): totals in top-up material are never written (R3 interp 2 — a
 * top-up's list may state its own totals or the whole truck's), so what it
 * says goes on the note for the VED.
 */
export function notedTotalsNote(label: string, totals: PackingTotals): string {
  const parts = [
    totals.weightKg !== null ? `${totals.weightNetto ? 'netto' : 'brutto'} ${num(totals.weightKg)} kg` : null,
    totals.volumeM3 !== null ? `${num(totals.volumeM3)} m³` : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return `📄 ${label} — packing list: jami o‘qilmadi — VED fayldan ko‘radi.`;
  return `📄 ${label} — packing list jami: ${parts.join(', ')} — so‘rovga yozilmadi, VED fayldan ko‘radi.`;
}

/** Equal within the house rule for a weight or a cube (`LINE_FIGURES`). */
const agreeTotal = (a: number, b: number, unit: number) => {
  const gap = Math.abs(a - b);
  return gap < unit || gap <= 0.005 * Math.max(Math.abs(a), Math.abs(b));
};

/**
 * A packing list's totals onto the collection's `fileTotals` (§1.2.5). A
 * second packing list that states the SAME figure changes nothing; one that
 * states another leaves that figure to the VED — neither file wins in silence
 * (CONC-2's rule) — and `clash` names it. A brutto outranks a netto. `at` is
 * the later file's, so a totals answer given before it is doubted. Null =
 * nothing to keep.
 */
export function withFileTotals(
  prev: IntakeState['fileTotals'],
  next: PackingTotals & { label: string; at: TotalsMark; doubted?: readonly AskedTotal[] },
): { fileTotals: IntakeState['fileTotals']; clash: boolean } {
  // A figure the list's own column question doubted (`withoutAskedTotals`) is
  // kept as a DOUBT even with nothing taken (review seams-4): the model reads
  // the same list's TOTAL row as text, and must not stand where the file's Σ
  // could not. Like a clash, it names the field and states no figure.
  const doubted = [...new Set([...(prev?.doubted ?? []), ...(next.doubted ?? [])])];
  const doubtOf = doubted.length > 0 ? { doubted } : {};
  if (next.weightKg === null && next.volumeM3 === null) {
    if ((next.doubted ?? []).length === 0) return { fileTotals: prev, clash: false };
    return {
      fileTotals: prev ? { ...prev, ...doubtOf } : { weightKg: null, volumeM3: null, weightNetto: false, label: next.label, at: next.at, ...doubtOf },
      clash: false,
    };
  }
  if (!prev) {
    return {
      fileTotals: {
        weightKg: next.weightKg,
        volumeM3: next.volumeM3,
        weightNetto: next.weightKg !== null && next.weightNetto,
        label: next.label,
        at: next.at,
        ...doubtOf,
      },
      clash: false,
    };
  }
  // A figure two files disagreed on STAYS the VED's (review PF-ADV-8): a third
  // file's figure does not settle it in silence, and the reading must not let
  // the model's figure — the two lists added up, as often as not — land in
  // its place (`clash`, read by `analyzeCollected`).
  const clashed = new Set(prev.clash ?? []);
  let weightKg = prev.weightKg;
  let weightNetto = prev.weightNetto;
  if (next.weightKg !== null && !clashed.has('weightKg')) {
    if (prev.weightKg === null || (prev.weightNetto && !next.weightNetto)) {
      weightKg = next.weightKg;
      weightNetto = next.weightNetto;
    } else if (prev.weightNetto === next.weightNetto && !agreeTotal(prev.weightKg, next.weightKg, 1)) {
      weightKg = null;
      weightNetto = false;
      clashed.add('weightKg');
    }
  }
  let volumeM3 = prev.volumeM3;
  if (next.volumeM3 !== null && !clashed.has('volumeM3')) {
    if (prev.volumeM3 === null) volumeM3 = next.volumeM3;
    else if (!agreeTotal(prev.volumeM3, next.volumeM3, 0.01)) {
      volumeM3 = null;
      clashed.add('volumeM3');
    }
  }
  const clash = clashed.size > (prev.clash ?? []).length;
  return {
    fileTotals: {
      weightKg,
      volumeM3,
      weightNetto,
      label: `${prev.label}, ${next.label}`,
      at: next.at,
      ...(clashed.size > 0 ? { clash: [...clashed] } : {}),
      ...doubtOf,
    },
    clash,
  };
}

/** The sentence for a second packing list whose totals disagree with the first's. */
export function totalsClashNote(label: string, prev: string): string {
  return `📄 ${label} — jami ${prev} dagidan boshqa — ikkalasi ham olinmadi, VED fayldan ko‘radi.`;
}

/**
 * An OLD collection's second Excel, still waiting for «qo‘shilsin yoki
 * o‘rniga?» when this release deployed (docs/IKKI-ESHIK.md §1.3): resolved by
 * the invoice rule a new one meets — compared row by row, its other sheets
 * kept — and its decisions said in `fileNotes`. Which files the waiting rows
 * came from is not known (the old question folded them into one label), so
 * their weights read unknown. Pure.
 */
export function foldPendingInvoice(state: IntakeState): Partial<IntakeState> {
  const pending = state.pendingInvoice;
  if (!pending) return {};
  const held = state.invoiceGoods ?? [];
  const goods = pending.goods ?? [];
  const texts: SheetText[] = pending.texts ?? [];
  const fold = foldInvoice(held, rowKindsOf(state.goodsFiles, held.length), goods, null, pending.label);
  const files = state.goodsFiles ?? [];
  return {
    invoiceGoods: fold.goods,
    invoiceTexts: [...state.invoiceTexts, ...texts],
    goodsFiles: [
      ...files,
      { label: pending.label, shape: 'invoice', weightKind: null, grossKg: null, grossColumn: false, volumeM3: null, rows: fold.added, text: null },
    ],
    fileNotes: [...(state.fileNotes ?? []), ...fold.notes],
    pendingInvoice: null,
  };
}
