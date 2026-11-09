import { tierWords } from './name-tiers';
import type { CalcGoodsFact } from '../../wms/calc/intake';
import type { WeightKind } from '../../wms/deals/goods-import';
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
// name address (docs/SAKKIZ-R3.md §8.1); `otherName` reads them from there.

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
function otherName(a: string, b: string): boolean {
  const tiersA = tierWords(a);
  const tiersB = tierWords(b);
  if ([...tiersA].some((t) => !tiersB.has(t)) || [...tiersB].some((t) => !tiersA.has(t))) return true;
  const wordsB = nameWords(b);
  for (const [bucket, ofA] of nameWords(a)) {
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
    if (f.field === 'weightKg') return grossOnly(kinds.held) === grossOnly(kinds.read);
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
  const h = goodsNameKeys(held.name);
  const r = goodsNameKeys(read.name);
  if (!h.whole || !r.whole) return false;
  if (h.whole !== r.whole && !namesMeet(h, r)) return false;
  const shared = sharedFigures(held, read, kinds);
  return shared.length > 0 && shared.every((f) => figureAgrees(f, held, read));
}

/** Do the two names point at one product, the wide way (`namesMeet`, or the same whole name)? */
function namesMeetLine(a: GoodsList[number], b: GoodsList[number]): boolean {
  const x = goodsNameKeys(a.name);
  const y = goodsNameKeys(b.name);
  return Boolean(x.whole && y.whole) && (x.whole === y.whole || namesMeet(x, y));
}

/**
 * A count AND a weight on both rows, in comparable units, both equal — the
 * same row under another name («nomi boshqacha, raqamlari bir xil», §1.2.2):
 * a Russian invoice and its Chinese packing list name one jacket two ways,
 * and only its figures say so. Pure.
 */
export function sameFigures(held: GoodsList[number], read: GoodsList[number], kinds: RowKinds = UNKNOWN_KINDS): boolean {
  const shared = sharedFigures(held, read, kinds);
  const both = shared.filter((f) => f.field === 'quantity' || f.field === 'weightKg');
  return both.length === 2 && both.every((f) => figureAgrees(f, held, read));
}

/**
 * What a held row takes from its duplicate — only what it LACKS: the code,
 * the unit word, the measure pair, the money. Its own figures stand (§1.2.2).
 */
function fillGaps(held: GoodsList[number], dup: GoodsList[number]): GoodsList[number] {
  const out = { ...held };
  if (!out.tnvedCode && dup.tnvedCode) out.tnvedCode = dup.tnvedCode;
  if (!out.unit && dup.unit) out.unit = dup.unit;
  if ((out.measureQty == null || out.measureUnit == null) && dup.measureQty != null && dup.measureUnit != null) {
    out.measureUnit = dup.measureUnit;
    out.measureQty = dup.measureQty;
  }
  if (out.amount == null && dup.amount != null) out.amount = dup.amount;
  return out;
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
): FoldedInvoice {
  const out = held.map((g) => ({ ...g }));
  const claimed = new Set<number>();
  const added: GoodsList = [];
  const cross: string[] = [];
  const namesakes: string[] = [];
  let again = 0;
  const kinds = (i: number): RowKinds => ({ held: heldKinds[i] ?? null, read: readKind });
  for (const r of read) {
    const at = out.findIndex((h, i) => !claimed.has(i) && sameRowAgain(h, r, kinds(i)));
    if (at >= 0) {
      claimed.add(at);
      out[at] = fillGaps(out[at]!, r);
      again += 1;
      continue;
    }
    const twins = out.flatMap((h, i) => (!claimed.has(i) && !namesMeetLine(h, r) && sameFigures(h, r, kinds(i)) ? [i] : []));
    if (twins.length === 1) {
      const i = twins[0]!;
      claimed.add(i);
      cross.push(`📄 ${label} — «${clip(r.name)}» va «${clip(out[i]!.name)}»: nomi boshqacha, raqamlari bir xil — bitta deb olindi.`);
      out[i] = fillGaps(out[i]!, r);
      again += 1;
      continue;
    }
    const namesake = out.find((h) => namesMeetLine(h, r));
    if (namesake) {
      const field = firstField(r);
      const readWords = figureWords(r);
      const heldWords = figureWords(namesake, field);
      namesakes.push(
        `📄 ${label} — «${clip(r.name)}»${readWords ? ` ${readWords}` : ''}: birinchi faylda ham «${clip(namesake.name)}»${heldWords ? ` ${heldWords}` : ''} — ikkalasi olindi (bir xil bo‘lsa, VED bittasini o‘chiradi).`,
      );
    }
    added.push(r);
  }
  const head =
    again === 0
      ? added.length > 0
        ? `📄 ${label} — ${added.length} ta yangi tovar qo‘shildi.`
        : null
      : added.length > 0
        ? `📄 ${label} — ${again} tasi ro‘yxatda bor edi, ${added.length} ta yangi tovar qo‘shildi.`
        : `📄 ${label} — ${again} tasi ro‘yxatda bor edi, yangi tovar qo‘shilmadi.`;
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
export function packingTotals(meta: Pick<GoodsFileMeta, 'weightKind' | 'grossKg' | 'volumeM3'>, rows: GoodsList): PackingTotals {
  if (meta.grossKg !== null) return { weightKg: meta.grossKg, weightNetto: false, volumeM3: meta.volumeM3 };
  if (meta.weightKind === 'net' && rows.length > 0 && rows.every((g) => figureOf(g, 'weightKg') !== null && g.weightKg! > 0)) {
    const sum = rows.reduce((n, g) => n + g.weightKg!, 0);
    return { weightKg: Number(sum.toFixed(3)), weightNetto: true, volumeM3: meta.volumeM3 };
  }
  return { weightKg: null, weightNetto: false, volumeM3: meta.volumeM3 };
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
  const goods = held.map((h, i) => {
    if (figureOf(h, 'weightKg') !== null) return h;
    const at = packing.findIndex(
      (p, j) => !claimed.has(j) && figureOf(p, 'weightKg') !== null && p.weightKg! > 0 && sameRowAgain(h, p, { held: heldKinds[i] ?? null, read: packingKind }),
    );
    if (at < 0) return h;
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
): string {
  const taken = [
    totals.weightKg !== null ? (totals.weightNetto ? 'umumiy netto' : 'umumiy brutto') : null,
    totals.volumeM3 !== null ? 'kub' : null,
  ].filter((t): t is string => t !== null);
  const fills = filled > 0 ? ` ${fillsWords(filled)}` : '';
  if (taken.length === 0) return `📄 ${label} — o‘sha tovarlar: qatorlar ${rowsFrom}, jami o‘qilmadi — VED fayldan ko‘radi.${fills}`;
  const noBrutto = totals.weightKg === null || totals.weightNetto;
  const brutto = noBrutto ? (grossColumn ? '; brutto ba’zi qatorlarda yo‘q.' : '; brutto ustuni yo‘q.') : '.';
  return `📄 ${label} — o‘sha tovarlar: qatorlar ${rowsFrom}, bundan faqat ${taken.join(' va ')} olindi${brutto}${fills}`;
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
  next: PackingTotals & { label: string; at: TotalsMark },
): { fileTotals: IntakeState['fileTotals']; clash: boolean } {
  if (next.weightKg === null && next.volumeM3 === null) return { fileTotals: prev, clash: false };
  if (!prev) {
    return {
      fileTotals: { weightKg: next.weightKg, volumeM3: next.volumeM3, weightNetto: next.weightKg !== null && next.weightNetto, label: next.label, at: next.at },
      clash: false,
    };
  }
  let clash = false;
  let weightKg = prev.weightKg;
  let weightNetto = prev.weightNetto;
  if (next.weightKg !== null) {
    if (prev.weightKg === null || (prev.weightNetto && !next.weightNetto)) {
      weightKg = next.weightKg;
      weightNetto = next.weightNetto;
    } else if (prev.weightNetto === next.weightNetto && !agreeTotal(prev.weightKg, next.weightKg, 1)) {
      weightKg = null;
      weightNetto = false;
      clash = true;
    }
  }
  let volumeM3 = prev.volumeM3;
  if (next.volumeM3 !== null) {
    if (prev.volumeM3 === null) volumeM3 = next.volumeM3;
    else if (!agreeTotal(prev.volumeM3, next.volumeM3, 0.01)) {
      volumeM3 = null;
      clash = true;
    }
  }
  return { fileTotals: { weightKg, volumeM3, weightNetto, label: `${prev.label}, ${next.label}`, at: next.at }, clash };
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
