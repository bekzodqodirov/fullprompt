/**
 * «Hisoblatish» — what the bot COLLECTS before anybody quotes a price.
 *
 * The owner's design, and it is better than the one I proposed: rather than
 * having the AI read a whole client conversation and guess which parts are a
 * quote request — «hato ishlash extimoli yuqori» — a member of staff opens
 * the bot, presses «Hisoblatish», and sends exactly the files, photos and
 * facts that belong to this job. What is sent is what is analysed; nothing
 * is inferred from a chat nobody pointed at.
 *
 * Three sections, his words: **yo'lkira** (freight), **rastamojka**
 * (customs clearance) and **podklyuch** — which is not a third service but
 * the two added together, so it asks for both sets of facts.
 *
 * The bot never quotes. It collects, checks that the facts a quote needs are
 * actually there, and lands a card; the price is the staff member's to say
 * (his answer 2). Everything in this file is a pure decision so the whole of
 * it can be tested without a Telegram or a model.
 */
import { addressWord } from './address-words';
import { autoBasisFor } from './basis';
import {
  missingNeeds,
  needShortUz,
  needWhatUz,
  needWhyUz,
  rowNeeds,
  type NeedLaw,
  type NeedUnit,
  type RowNeed,
} from './needs';
import type { GoodsRow } from '../deals/goods-import';
import { doorRow } from './door-row';
import { linesVolumeM3 } from './line-totals';
import type { BazaBasis, MeasureUnit } from './pricing';
import { codeWrittenAsCode, parseGoodsLine, routeAmount, unitOf } from './units';

export type CalcSection = 'yolkira' | 'rastamojka' | 'podklyuch';

export const CALC_SECTIONS: CalcSection[] = ['yolkira', 'rastamojka', 'podklyuch'];

export const SECTION_LABEL: Record<CalcSection, string> = {
  yolkira: '🚚 Yo‘lkira',
  rastamojka: '🛃 Rastamojka',
  podklyuch: '🔑 Podklyuch (yo‘lkira + rastamojka)',
};

/**
 * What a section cannot be quoted without.
 *
 * Cargo facts (weight, volume, what it actually IS) are what customs needs;
 * freight additionally needs the two ends of the road. Podklyuch is the sum
 * of both, so it asks for everything — that is the whole meaning of the word
 * here.
 *
 * The shipment TOTALS stay on the customs sections too (2026-10-09, judge
 * MR-9 — the spec's «information only» was cancelled): customs never reads
 * them, but the seller's upsale payout scales by the quoted cube and kilos
 * (upsale.ts's `quoted_m3`), and a rastamojka quote with no totals would pay
 * the whole share on the first carton that arrives.
 */
export const REQUIRED_FIELDS: Record<CalcSection, CalcField[]> = {
  yolkira: ['fromCity', 'toCity', 'weightKg', 'volumeM3', 'goods'],
  rastamojka: ['weightKg', 'volumeM3', 'goods', 'itemMeasure', 'lineNeed'],
  podklyuch: ['fromCity', 'toCity', 'weightKg', 'volumeM3', 'goods', 'itemMeasure', 'lineNeed'],
};

export type CalcField =
  | 'fromCity'
  | 'toCity'
  | 'weightKg'
  | 'volumeM3'
  | 'goods'
  /**
   * PER-ITEM, and only where customs is being calculated (sub-round B).
   *
   * A total weight prices a truck; it cannot price a declaration. The baza is
   * per kg or per dona or per m², chosen per ROW, so the row has to state a
   * figure for SOMETHING — and `unitsForRow` says exactly which: a count
   * prices it per dona, a weight per kg, and a row stating NEITHER can be
   * valued only by guessing, which is the one thing this module may not do.
   *
   * ONE field, not two, and the first version got that wrong. Asking for a
   * count AND a weight made a multi-line podklyuch submitted through the
   * SELLER'S CARD FORM permanently incomplete — that form has no per-line
   * weight input at all — so the chip rendered for ever on the commonest
   * submission there is. That is #649's «a warning that fires on everything
   * names nothing» a second time, in the same round that fixed it once.
   * Found by CI, on the e2e that walks the very door this round opened.
   *
   * Freight asks for none of it: a truck is priced on the totals.
   *
   * Since 2026-10-09 this is the UNCODED half: a line whose law nobody knows
   * yet still needs only one figure, any of a count, a net weight, a volume
   * or a pair (m²/juft/litr) — the VED picks what its baza is per.
   */
  | 'itemMeasure'
  /**
   * The CODED half (2026-10-09, the owner's «kg hamda donani birga
   * kirgizadgan tovarlar»): a line whose TNVED law pins a unit it does not
   * state. A 6110 sweater stating only kg owes its count («boj kamida $X/
   * dona»), a 9403 table stating only dona owes its net weight. The engine
   * would refuse both with `measure_missing`; the checklist now names the
   * figure BEFORE the VED meets the refusal (`lineNeeds`).
   */
  | 'lineNeed';

export const FIELD_LABEL: Record<CalcField, string> = {
  fromCity: 'qaysi shahardan',
  toCity: 'qaysi shaharga',
  // BRUTTO, said where it is asked (his 2.7 b): the lines' kilos are netto
  // — the baza and the per-kg floor are declared on them — and the truck is
  // priced on what it carries with the packaging. A seller who read
  // «og‘irligi» answered with the netto sum, which is the shorter number.
  weightKg: 'umumiy brutto og‘irligi (kg, qadoq bilan)',
  volumeM3: 'umumiy hajmi (kub)',
  goods: 'tovar nomi',
  itemMeasure: 'tovarning soni yoki og‘irligi',
  lineNeed: 'kod so‘ragan o‘lchov',
};

/**
 * Why the model's reading is missing, named (his 1.6 a, 2026-10-21).
 *
 * Every one of these used to reach the seller as the same sentence, «AI
 * mavjud emas» — a key that expired, a packing list too long for the answer,
 * a five-second Anthropic outage and a refused chemical were one message, so
 * nobody could tell «try again in a minute» from «tell the admin». His own
 * screenshot of 2026-10-21 is that sentence over a message the model never
 * read. `budget` is the caller's (the day's cap), the rest come from the call.
 */
export type AiReadFailure =
  | 'not_configured'
  | 'nothing_to_read'
  | 'budget'
  | 'refused'
  | 'truncated'
  | 'timeout'
  | 'rate_limited'
  | 'overloaded'
  | 'auth'
  | 'rejected'
  | 'unreadable'
  | 'network';

/** The sentence per failure, and whether pressing «🔄 Qayta o‘qish» can help. */
export const AI_READ_FAILURE: Record<AiReadFailure, { text: string; retry: boolean }> = {
  not_configured: { text: 'AI ulanmagan (serverda kalit yo‘q) — adminga ayting.', retry: false },
  nothing_to_read: { text: 'AI ga o‘qish uchun matn, rasm yoki PDF yo‘q edi.', retry: false },
  budget: { text: 'AI kunlik limiti tugadi.', retry: false },
  refused: {
    text: 'AI bu materialni o‘qishdan bosh tortdi (xavfsizlik filtri) — VED qo‘lda ko‘radi.',
    retry: false,
  },
  // No retry (review #21): the cut is a property of the INPUT — the same
  // material under the same ceiling is cut again, each press a paid call the
  // day's budget never counts. The sentence already names the one remedy.
  truncated: {
    text: 'Material juda katta — AI javobi sig‘madi. Kamroq sahifa yoki Excel yuboring.',
    retry: false,
  },
  timeout: { text: 'AI belgilangan vaqtda javob bermadi.', retry: true },
  rate_limited: { text: 'AI hozir band (so‘rov ko‘p) — bir daqiqadan keyin qayta urinib ko‘ring.', retry: true },
  overloaded: { text: 'AI xizmatida vaqtinchalik nosozlik — birozdan keyin qayta urinib ko‘ring.', retry: true },
  auth: { text: 'AI kaliti ishlamayapti (eskirgan yoki noto‘g‘ri) — adminga ayting.', retry: false },
  rejected: {
    text: 'AI so‘rovni qabul qilmadi (fayl o‘qilmaydigan yoki juda katta) — fayllarni boshqacha yuboring.',
    retry: false,
  },
  unreadable: { text: 'AI javobini o‘qib bo‘lmadi.', retry: true },
  network: { text: 'AI bilan aloqa uzildi.', retry: true },
};

/** What the AI (or a human) managed to read out of the sent material. */
export interface CalcFacts {
  fromCity?: string | null;
  toCity?: string | null;
  weightKg?: number | null;
  volumeM3?: number | null;
  goods?: CalcGoodsFact[];
  /**
   * Every line's weight was STATED — typed into the seller's own netto cell,
   * or read back from a stored row — so the shipment total is never copied
   * onto a line (`loneWeightKg`). Unset on the bot's and the thread's READ
   * facts, where a single line's weight is still derived, and labelled.
   *
   * 2026-10-09 (judge MR-7, UX6, TT-14): the card form now has its own
   * «Sof og‘irlik (netto)» cell and labels the total box «brutto», so copying
   * the total onto the line wrote BRUTTO into the NETTO column — under the
   * per-kg baza and the «kamida $X/kg» floor. And a server projection that
   * derived would call a stored row complete while the row itself has no
   * weight, so the header chip and the engine's refusal would disagree.
   */
  lineWeightsStated?: boolean;
  /**
   * The totals were read back from a STORED request, and what the column
   * holds is what the engine prices (docs/SAKKIZ-R2.md §8.2.2, judge
   * regression-3). So nothing is derived from the lines: a stored request
   * whose `volume_m3` is null (every pre-deploy request, or one the VED
   * cleared) is refused by the workspace's freight with `measure_missing`,
   * and a chip that called its volume present because the lines add up
   * would disagree with that refusal — #649's shape. Set by `missingFor` /
   * `lineNeedsFor` beside `lineWeightsStated`; unset on every door's READ
   * facts, where the Σ is what the landing will store.
   */
  totalsStored?: boolean;
  /**
   * The seller TYPED the shipment's cube, and typed it two ways («2,500
   * kub» — 2.5 or 2500?), and nobody has said which (review P3-R2). The
   * figure is left blank so the model that read the same text cannot answer
   * it — and the lines' Σ must not answer it either: it would stand in for
   * a total the seller did state, the totals question would not ask, and
   * the summary would print «which did you mean?» beside «to‘liq». So
   * nothing is derived (`factsVolumeM3`), the question asks the cube, and
   * the INSERT stores no Σ. Set by the doors that read typed text
   * (`analyzeCollected`, the thread preview); an answer clears it.
   */
  volumeAmbiguous?: boolean;
  /**
   * The shipment's total weight is NETTO — the material stated no brutto
   * (review PF-3). Only a customs-only job ever lands one: there nobody asks
   * a brutto, and both readers take the netto as the total (the typed one,
   * `parseManualFacts`, and the model, told so by `NETTO_ONLY`). Said where
   * the figure is printed: the summary («Og‘irlik (netto)»), a single line's
   * copied weight («og‘irlik umumiy (netto)dan olindi») and the Telegram line
   * («og‘irlik nettodan») — the old brutto label put the opposite of the AI
   * izohi on the same card. An answer to the brutto question clears it.
   */
  weightNetto?: boolean;
}

/** One goods line as a door hands it over. */
export interface CalcGoodsFact {
  name: string;
  /** PIECES — a carton count is never this (it lives in the note). */
  quantity?: number | null;
  /** What THIS line weighs NET, in kg — see `CalcField`'s `itemMeasure`. */
  weightKg?: number | null;
  /** What THIS line takes, in m³ — a measure in its own right since 0125. */
  volumeM3?: number | null;
  /**
   * A measure in its own unit — m² / juft / litr / sm³ (0092's pair).
   *
   * A seller's «Kafel 120 m²» lands here at the door (units.ts
   * `routeAmount`), and so does a pair the VED typed, read back by the
   * projections. Without it the chip could never close on a row priced per
   * m²: a warning standing over a request the engine had fully priced (#649).
   */
  measureUnit?: MeasureUnit | null;
  measureQty?: number | null;
  /**
   * The seller's own unit word for `quantity` («шт», «m2», «karobka»), when a
   * door hands over a number in the old «nomi, soni, birlik» shape — the door
   * routes it to the column the word names (`normalizeRowUnit`), ONCE.
   */
  unit?: string | null;
  /** An invoice line's money, carried for the VED; nothing prices it. */
  amount?: number | null;
  tnvedCode?: string | null;
  note?: string | null;
  /** A chosen baza basis (stored rows): the VED's choice pins its unit too. */
  bazaBasis?: BazaBasis | null;
  /**
   * The law THIS line answers to, when the caller knows it better than the
   * book — on /hisoblash/[id] a grouped line takes its GROUP's law (judge S9),
   * so the header chip and the row's cell border agree. Absent = look the
   * line's code up in `laws`; null = the line has no known law.
   */
  law?: NeedLaw | null;
}

/** One line as the rest of the system should read it. */
export interface CalcItemFact {
  name: string;
  quantity: number | null;
  weightKg: number | null;
  /** The weight above was copied from the shipment total, not stated. */
  weightFromTotal: boolean;
  volumeM3: number | null;
  measureUnit: MeasureUnit | null;
  measureQty: number | null;
  unit: string | null;
  amount: number | null;
  tnvedCode: string | null;
  note: string | null;
  bazaBasis: BazaBasis | null;
  law: NeedLaw | null | undefined;
}

/**
 * The one weight a single-line job never has to be asked for.
 *
 * Split out from `itemFacts` because three doors land a calculation and only
 * one of them carries `CalcFacts`: the bot and the thread hand over what was
 * READ, the seller's card form hands over what was TYPED. The shape differs;
 * the RULE must not, or the same job lands a different row depending on which
 * door it came through — which is the asymmetry a derived fence found here on
 * its first run.
 */
export function loneWeightKg(
  itemCount: number,
  totalKg: number | null | undefined,
): number | null {
  const total = Number(totalKg);
  return itemCount === 1 && total > 0 ? total : null;
}

/**
 * The row note a derived line weight carries (judge UX6): the VED reads that
 * the netto cell holds the shipment's BRUTTO, which is the one thing the
 * number alone cannot say.
 */
export const LONE_WEIGHT_NOTE = 'og‘irlik umumiy (brutto)dan olindi';
/**
 * …and when the shipment's total was itself NETTO (`CalcFacts.weightNetto`,
 * review PF-3): the copy is the netto, and calling it brutto would put the
 * opposite of the AI izohi («faqat netto») on the same card.
 */
export const LONE_NETTO_NOTE = 'og‘irlik umumiy (netto)dan olindi';

/** Which total a copied line weight came from. */
export type TotalWeightBasis = 'brutto' | 'netto';

/**
 * The row note says its weight was copied from the shipment total
 * (`itemFacts`' lone copy) — docs/SAKKIZ-R2.md K15 — and from WHICH total.
 * The note is the only place that fact survives the landing, so every reader
 * that has to say it (the Telegram line's «og‘irlik bruttodan» /
 * «nettodan») asks it here rather than re-spelling the sentence it looks
 * for. Null: the row's weight is its own.
 */
export function weightFromTotalNote(note: string | null): TotalWeightBasis | null {
  const n = note ?? '';
  if (n.includes(LONE_NETTO_NOTE)) return 'netto';
  return n.includes(LONE_WEIGHT_NOTE) ? 'brutto' : null;
}

/**
 * A typed figure, or a blank: only a positive, finite number counts. «0 kg»
 * is a blank somebody typed over. ONE rule for the checklist and the
 * INSERT's «was a total typed» (service.ts, review P3-5), so the chip and the
 * stored column cannot read the same box two ways.
 */
export const typedFigure = (n: number | null | undefined): number | null =>
  Number(n) > 0 && Number.isFinite(Number(n)) ? Number(n) : null;

/**
 * The goods, with the one weight that can be DERIVED rather than asked for.
 *
 * With a single line on the bot's and the thread's READ facts, the
 * shipment's weight is taken for the line — and SAID so in the row note,
 * because the total is brutto and the line's column is netto. With two or
 * more lines nothing can be split without inventing a ratio, so those stay
 * empty and the checklist asks. Facts whose weights were stated
 * (`lineWeightsStated`: the card form, a stored row) derive nothing.
 *
 * ONE home (#513): the checklist, the summary, the note and the landing all
 * read the goods through here, so «what does this line weigh» has a single
 * answer everywhere it is asked.
 */
export function itemFacts(facts: CalcFacts): CalcItemFact[] {
  const goods = facts.goods ?? [];
  const lone = facts.lineWeightsStated ? null : loneWeightKg(goods.length, facts.weightKg);
  return goods.map((g) => {
    const own = typedFigure(g.weightKg);
    const fromTotal = own === null && lone !== null;
    const measureQty = typedFigure(g.measureQty);
    return {
      name: g.name,
      quantity: typedFigure(g.quantity),
      weightKg: own ?? lone,
      weightFromTotal: fromTotal,
      volumeM3: typedFigure(g.volumeM3),
      measureUnit: measureQty !== null ? (g.measureUnit ?? null) : null,
      measureQty,
      unit: g.unit?.trim() || null,
      amount: typedFigure(g.amount),
      tnvedCode: g.tnvedCode?.trim() || null,
      note:
        [g.note?.trim() || null, fromTotal ? (facts.weightNetto ? LONE_NETTO_NOTE : LONE_WEIGHT_NOTE) : null]
          .filter(Boolean)
          .join(' · ') || null,
      bazaBasis: g.bazaBasis ?? null,
      law: g.law,
    };
  });
}

/**
 * The items a door hands `openCalcRequest` — every door through this one
 * function, so the same job lands the same row whichever door it came
 * through (intake-items-wire.test.ts walks the callers). The door itself
 * then routes a seller's unit word and checks the code's shape
 * (`door-row.ts`); nothing here decides a column.
 */
export function landingItems(facts: CalcFacts) {
  return itemFacts(facts).map((g) => ({
    name: g.name,
    quantity: g.quantity,
    unit: g.unit,
    weightKg: g.weightKg,
    volumeM3: g.volumeM3,
    measureUnit: g.measureUnit,
    measureQty: g.measureQty,
    amount: g.amount,
    tnvedCode: g.tnvedCode,
    note: g.note,
  }));
}

/**
 * An attached invoice's rows as goods facts (P1.6) — everything the file
 * states, so the landing can route it: the unit word (the door sends «м2» /
 * «пар» to the measure pair), the volume and the money, the supplier's own
 * code and what the reader could not use. ONE mapping for the bot's invoice
 * reader and its test; nothing is decided here that the door decides.
 */
export function invoiceFacts(rows: readonly GoodsRow[]): CalcGoodsFact[] {
  return rows.map((g) => ({
    name: g.description,
    quantity: g.quantity,
    unit: g.unit,
    weightKg: g.weightKg,
    volumeM3: g.volumeM3,
    amount: g.amount,
    tnvedCode: g.tnvedCode,
    note: g.note,
  }));
}

/**
 * The shipment's cubic metres as a door's facts state them — typed or read,
 * else SUMMED from the lines (his 2.7 b, docs/SAKKIZ-R2.md §8.2.2).
 *
 * The Σ is over the DOOR-ROUTED rows (`landingItems` → `doorRow`), never the
 * read facts as they stand (probe P4): «Kafel 2 kub» arrives as a quantity of
 * 2 with the unit word «kub», and only the door moves it into the volume
 * column — so the checklist, the summary and the totals question see exactly
 * the volume `openCalcRequest` will store at its INSERT, whichever door the
 * job came through. ALL or nothing (`linesVolumeM3`): one line without a
 * figure and there is no Σ to stand for the truck.
 *
 * A stored request derives nothing (`totalsStored`): its column is what
 * prices it.
 */
export function factsVolumeM3(facts: CalcFacts): number | null {
  // Nor is an AMBIGUOUS typed cube answered by the lines (`volumeAmbiguous`).
  if (facts.totalsStored || facts.volumeAmbiguous) return typedFigure(facts.volumeM3);
  return typedFigure(facts.volumeM3) ?? linesVolumeM3(landingItems(facts).map(doorRow));
}

/**
 * Was the volume SUMMED from the lines rather than stated — the label's one
 * question, asked by the summary, the lenta note and the bot's totals
 * question alike (review P3-5: the bot spelt it a second time).
 */
export function volumeFromLines(facts: CalcFacts): boolean {
  return typedFigure(facts.volumeM3) === null && factsVolumeM3(facts) !== null;
}

/**
 * The volume as the bot and the lenta print it — labelled «qatorlardan»
 * when the lines gave it, so the seller reading the summary knows nobody
 * typed it (§0.1(6): a Σ is data, but its provenance is said).
 */
function volumeText(facts: CalcFacts): string {
  const volume = factsVolumeM3(facts);
  if (volume !== null && volumeFromLines(facts)) return `${fmt(volume)} m³ (qatorlardan)`;
  return num(facts.volumeM3, 'kub');
}

/** A line states SOME figure — a count, a net weight, a volume or a pair. */
function statesAMeasure(i: CalcItemFact): boolean {
  return i.quantity !== null || i.weightKg !== null || i.volumeM3 !== null || i.measureQty !== null;
}

/**
 * What one goods line still owes before its customs can be computed.
 *
 * `pinned` are the figures the LAW (or a basis the VED chose) names in ONE
 * unit and the line does not state — the duty floor's unit, a specific
 * excise's, the law's pair (m²/juft/litr) its baza defaults to — straight off
 * the engine's own `rowNeeds`, so a need and a refusal cannot disagree. A
 * baza need the law does NOT pin (an advalor code, or no code at all) is the
 * VED's to choose, so it asks nothing in a particular unit: a line stating
 * any figure answers it (#910's one-measure rule), and a line stating none
 * is `anyMeasure` — «nechta dona yoki necha kg?» (judge UX5).
 */
export interface LineNeed {
  /** Index into `facts.goods` — a name is not an address. */
  index: number;
  name: string;
  pinned: RowNeed[];
  anyMeasure: boolean;
  /** The units to ask or to chip: the pinned ones, else a count or a weight. */
  units: NeedUnit[];
}

function lawOfLine(item: CalcItemFact, laws: ReadonlyMap<string, NeedLaw>): NeedLaw | null {
  if (item.law !== undefined) return item.law;
  return item.tnvedCode ? (laws.get(item.tnvedCode) ?? null) : null;
}

function pinnedNeedsOf(item: CalcItemFact, law: NeedLaw | null): RowNeed[] {
  const chosen = item.bazaBasis;
  const basis = chosen ?? autoBasisFor(law, item);
  const needs = rowNeeds(law, basis, item);
  // The floor's and the excise's reasons first, so a count asked for both
  // reasons is asked with the money one («boj kamida $3/dona»).
  const lawPins = law !== null && law.dutyUnit !== null;
  return missingNeeds([
    ...needs.filter((n) => n.why !== 'baza'),
    ...needs.filter((n) => n.why === 'baza' && (chosen !== null || lawPins)),
  ]);
}

/**
 * Every line that still owes a figure, in order. Empty on a freight-only
 * section — a truck is priced on the totals (`REQUIRED_FIELDS` says so, read
 * here rather than restated, #513).
 *
 * `laws` is the book's answer for the lines' codes (`bookLawsFor`, read on
 * the POOL before any transaction — #714). REQUIRED: a checklist that cannot
 * see the law is #910's — «to'liq» on a sweater whose floor is per piece.
 */
export function lineNeeds(
  section: CalcSection,
  facts: CalcFacts,
  laws: ReadonlyMap<string, NeedLaw>,
): LineNeed[] {
  if (!REQUIRED_FIELDS[section].includes('itemMeasure')) return [];
  const out: LineNeed[] = [];
  itemFacts(facts).forEach((item, index) => {
    const pinned = pinnedNeedsOf(item, lawOfLine(item, laws));
    const anyMeasure = pinned.length === 0 && !statesAMeasure(item);
    if (pinned.length === 0 && !anyMeasure) return;
    out.push({
      index,
      name: item.name,
      pinned,
      anyMeasure,
      units: pinned.length > 0 ? pinned.map((n) => n.unit) : ['dona', 'kg'],
    });
  });
  return out;
}

/**
 * Which required facts are still missing. A number that is present but zero
 * or negative counts as missing: «0 kg» is not a weight, it is a blank
 * somebody typed over.
 */
export function missingFields(
  section: CalcSection,
  facts: CalcFacts,
  laws: ReadonlyMap<string, NeedLaw>,
): CalcField[] {
  const items = itemFacts(facts);
  const lines = lineNeeds(section, facts, laws);
  return REQUIRED_FIELDS[section].filter((field) => {
    if (field === 'goods') return items.length === 0;
    // With no goods at all these stay silent — no line, no need — and that
    // is deliberate, not incidental: «tovar nomi» already names that
    // absence, and one hole reported three times is how a checklist stops
    // being read. Pinned behaviourally, because the mechanism is subtle
    // enough that a later `!items.length ||` would look like an improvement.
    if (field === 'itemMeasure') return lines.some((l) => l.anyMeasure);
    if (field === 'lineNeed') return lines.some((l) => l.pinned.length > 0);
    // The weight is ASKED, never summed: line kilos are netto and the truck's
    // are brutto (his 2.7 b) — a Σ would be a different, smaller number.
    if (field === 'weightKg') return !(Number(facts.weightKg) > 0);
    if (field === 'volumeM3') return factsVolumeM3(facts) === null;
    return !String(facts[field] ?? '').trim();
  });
}
/** Ready to be handed over for pricing? */
export function isComplete(
  section: CalcSection,
  facts: CalcFacts,
  laws: ReadonlyMap<string, NeedLaw>,
): boolean {
  return missingFields(section, facts, laws).length === 0;
}

const num = (n: number | null | undefined, unit: string) =>
  Number(n) > 0 ? `${Math.round(Number(n) * 1000) / 1000} ${unit}` : '—';

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * A line's figures as the bot prints them — each in the unit it is IN, so a
 * line read as «120 m²» never prints as «120 dona» (the shape every door used
 * to land: the number in the piece column and the unit as display text).
 */
export function lineFiguresText(g: CalcItemFact): string {
  return [
    g.quantity !== null ? `${fmt(g.quantity)} ${needShortUz('dona')}` : null,
    g.weightKg !== null
      ? `${fmt(g.weightKg)} ${needShortUz('kg')}${g.weightFromTotal ? ' (umumiydan)' : ''}`
      : null,
    g.measureQty !== null && g.measureUnit !== null
      ? `${fmt(g.measureQty)} ${needShortUz(g.measureUnit)}`
      : null,
    g.volumeM3 !== null ? `${fmt(g.volumeM3)} ${needShortUz('m3')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * One line's missing figure in the bot's Uzbek — the kernel's own words
 * (`needWhatUz`/`needWhyUz`, judge UX5), never restated here.
 */
export function lineNeedText(line: LineNeed): string {
  const what =
    line.pinned.length > 0
      ? line.pinned.map((n) => `${needWhatUz(n.unit)} — ${needWhyUz(n)}`).join('; ')
      : `${needWhatUz('dona')} yoki ${needWhatUz('kg')}`;
  return `${line.index + 1}-qator «${line.name}»: ${what}`;
}

/**
 * At most this many lines are NAMED in a message (judge UX18): a 30-line
 * invoice would otherwise be 30 lines against Telegram's 4096 characters,
 * and the full list lives on the rows anyway.
 */
export const LINES_NAMED = 8;

export function linesBlock(lines: LineNeed[]): string {
  const shown = lines.slice(0, LINES_NAMED).map((l) => `· ${lineNeedText(l)}`);
  if (lines.length > LINES_NAMED) shown.push(`… yana ${lines.length - LINES_NAMED} ta qator`);
  return shown.join('\n');
}

/** A total the material states two ways («1,200 kg» — 1.2 or 1200?). */
export interface AmbiguousTotal {
  field: 'weightKg' | 'volumeM3';
  text: string;
  decimal: number;
  thousands: number;
}

/**
 * A total the seller ANSWERED that material sent after the answer states
 * differently (review CONC-2): «3500» typed to the brutto question, then a
 * packing list saying G.W. 4200 kg. Neither wins in silence — the answer was
 * given before the seller had sent the list, the list may be the wrong one.
 */
export interface ContradictedTotal {
  field: 'weightKg' | 'volumeM3';
  answered: number;
  stated: number;
}

/** Why a total is asked rather than taken: written two ways, or contradicting its answer. */
export type TotalDoubt = AmbiguousTotal | ContradictedTotal;

/** «“1,200 kg” — 1.2 mi yoki 1200 mi?» — never a guess between the two. */
export function ambiguousTotalText(a: TotalDoubt): string {
  const unit = a.field === 'weightKg' ? needShortUz('kg') : needShortUz('m3');
  if ('answered' in a) {
    return `Siz ${fmt(a.answered)} ${unit} deb javob bergansiz, keyin yuborilgan ma’lumotda ${fmt(a.stated)} ${unit} — qaysi biri? Aniq yozing: «${fmt(a.stated)} ${unit}» yoki «${fmt(a.answered)} ${unit}».`;
  }
  return `«${a.text} ${unit}» — ${fmt(a.decimal)} mi yoki ${fmt(a.thousands)} mi? Aniq yozing: «${fmt(a.thousands)} ${unit}» yoki «${fmt(a.decimal)} ${unit}».`;
}

/** The fields the checklist names by word — the per-line ones are listed by line. */
const LINE_FIELDS: readonly CalcField[] = ['itemMeasure', 'lineNeed'];

/**
 * The message the staff member reads before pressing confirm — the facts as
 * the system understood them, and, in red, what a quote still needs.
 *
 * Deliberately shows what is THERE as well as what is missing: a checklist
 * of absences alone gives no way to catch the commonest error, which is not
 * a missing number but a misread one. Every still-missing LINE is named by
 * its number and its name (P1.3) — «tovarning soni yoki og‘irligi» named
 * none of the ten lines it was about.
 */
export function intakeSummaryText(input: {
  section: CalcSection;
  facts: CalcFacts;
  laws: ReadonlyMap<string, NeedLaw>;
  clientLabel: string | null;
  fileCount: number;
  /** Totals the typed material states two ways, or against the answer — asked, never guessed. */
  ambiguous?: TotalDoubt[];
}): string {
  const missing = missingFields(input.section, input.facts, input.laws);
  const fields = missing.filter((f) => !LINE_FIELDS.includes(f));
  const lines = lineNeeds(input.section, input.facts, input.laws);
  const goods = itemFacts(input.facts);
  const goodsLines = goods
    .slice(0, 15)
    .map((g) => {
      const figures = lineFiguresText(g);
      return `· ${g.name}${figures ? ` — ${figures}` : ''}${g.tnvedCode ? ` · ${g.tnvedCode}` : ''}`;
    })
    .join('\n');
  const ambiguous = input.ambiguous ?? [];

  return (
    `${SECTION_LABEL[input.section]}\n` +
    `Mijoz: ${input.clientLabel ?? '— (yangi)'}\n` +
    (input.section === 'rastamojka'
      ? ''
      : `Yo‘nalish: ${input.facts.fromCity?.trim() || '—'} → ${input.facts.toCity?.trim() || '—'}\n`) +
    `${weightLabel(input.section, input.facts)}: ${num(input.facts.weightKg, 'kg')} · Hajm: ${volumeText(input.facts)}\n` +
    (goods.length
      ? `Tovarlar (${goods.length}):\n${goodsLines}${goods.length > 15 ? '\n…' : ''}\n`
      : 'Tovarlar: —\n') +
    (input.fileCount ? `Fayllar: ${input.fileCount}\n` : '') +
    (ambiguous.length ? `\n${ambiguous.map((a) => `⚠️ ${ambiguousTotalText(a)}`).join('\n')}\n` : '') +
    (missing.length
      ? (fields.length ? `\n⚠️ Yetishmayapti: ${fields.map((f) => FIELD_LABEL[f]).join(', ')}\n` : '\n') +
        (lines.length ? `⚠️ Qatorlarda yetishmayapti:\n${linesBlock(lines)}\n` : '') +
        'Yetishmaganini yozib yuboring yoki shundayligicha tasdiqlang.'
      : '\n✅ Ma’lumot to‘liq. Tasdiqlaysizmi?')
  );
}

/**
 * What the shipment's weight IS, on the line that prints it (review PF-1,
 * PF-3). On a freight section the figure is the BRUTTO the bot asks for, and
 * the seller confirming the summary must be able to see which he is
 * confirming; a customs-only total that came from a netto says so. Otherwise
 * plain — nobody said.
 */
export function weightLabel(section: CalcSection, facts: CalcFacts): string {
  if (section !== 'rastamojka') return 'Og‘irlik (brutto)';
  return facts.weightNetto ? 'Og‘irlik (netto)' : 'Og‘irlik';
}

/**
 * The note that lands on the card's lenta — the AI's working shown, which is
 * what the owner asked for: «kartochkani ichida lenta bor, AI tartib bilan
 * qanday TNVED kod qo'ygan, qanday guruhlagan yozib ketsin».
 */
/**
 * Law 11's cap. The note column is unbounded, but a forwarded dump has no
 * ceiling either — 20 000 characters is the same slice the model reads, and
 * past it the note says it was cut rather than cutting in silence.
 */
export const MATERIAL_NOTE_CAP = 20_000;

export function intakeNoteText(input: {
  section: CalcSection;
  facts: CalcFacts;
  laws: ReadonlyMap<string, NeedLaw>;
  steps: string[];
  collectedBy: string;
  /** Which door collected it — the note names its own provenance. */
  via?: string;
  fileCount: number;
  /**
   * The seller's own words, verbatim (law 11: «everything the seller
   * submitted is shown to the VED AS-IS — forwarded messages, unabridged»).
   * The whole-module audit found the bot path persisted only the parsed
   * digest: the typed and forwarded TEXT lived in a 30-minute in-memory
   * state whose sole consumer was the model, so the VED read a summary of a
   * submission nobody could reopen.
   */
  material?: string[];
}): string {
  const goods = itemFacts(input.facts);
  const goodsLines = goods
    .map((g) => {
      const figures = lineFiguresText(g);
      return (
        `· ${g.name}${figures ? ` — ${figures}` : ''}` +
        `${g.tnvedCode ? `\n   TNVED: ${g.tnvedCode}` : ''}` +
        `${g.note ? `\n   ${g.note}` : ''}`
      );
    })
    .join('\n');
  const missing = missingFields(input.section, input.facts, input.laws);
  const fields = missing.filter((f) => !LINE_FIELDS.includes(f));
  const lines = lineNeeds(input.section, input.facts, input.laws);
  const raw = (input.material ?? []).map((m) => m.trim()).filter(Boolean).join('\n');
  const material =
    raw.length === 0
      ? null
      : raw.length > MATERIAL_NOTE_CAP
        ? raw.slice(0, MATERIAL_NOTE_CAP) + '\n… (qisqartirildi)'
        : raw;

  return (
    `🧮 Hisoblatish — ${SECTION_LABEL[input.section]}\n` +
    `Yig‘di: ${input.collectedBy} (${input.via ?? 'Telegram bot'})\n` +
    (input.section === 'rastamojka'
      ? ''
      : `Yo‘nalish: ${input.facts.fromCity?.trim() || '—'} → ${input.facts.toCity?.trim() || '—'}\n`) +
    `${weightLabel(input.section, input.facts)}: ${num(input.facts.weightKg, 'kg')} · Hajm: ${volumeText(input.facts)}\n` +
    (input.fileCount ? `Fayllar: ${input.fileCount}\n` : '') +
    (goods.length ? `\nTovarlar:\n${goodsLines}\n` : '') +
    (input.steps.length ? `\nAI izohi:\n${input.steps.map((s) => `— ${s}`).join('\n')}\n` : '') +
    (material ? `\nSotuvchi yuborgani (asl matn):\n${material}\n` : '') +
    (fields.length ? `\n⚠️ Yetishmayotgan ma’lumot: ${fields.map((f) => FIELD_LABEL[f]).join(', ')}` : '') +
    (lines.length ? `\n⚠️ Qatorlarda yetishmayapti:\n${linesBlock(lines)}` : '')
  );
}

/**
 * Which line the bot should ask about next, and what to ask (sub-round C).
 *
 * The rule is `lineNeeds`, one row at a time: a row the LAW asks a figure of
 * that it does not state, or a row stating no figure at all. Everything else
 * about the shipment can be left to the VED — never «are you sure», never a
 * form.
 *
 * Freight-only sections ask NOTHING: a truck is priced on the totals, and
 * `lineNeeds` reads `REQUIRED_FIELDS` to say so (#513).
 *
 * `skip` holds the lines already dealt with this collection — answered, or
 * passed with «⏭» — so a re-analysis after «➕ Yana ma'lumot» never asks
 * the same line twice (P1.3). Returns the INDEX into `facts.goods` so the
 * answer is written back onto exactly the row that was asked about — a name
 * is not an address, two lines of a packing list are routinely called the
 * same thing.
 */
export function nextLineToAsk(
  section: CalcSection,
  facts: CalcFacts,
  laws: ReadonlyMap<string, NeedLaw>,
  opts: { skip?: readonly number[] } = {},
): LineNeed | null {
  const skip = new Set(opts.skip ?? []);
  return lineNeeds(section, facts, laws).find((l) => !skip.has(l.index)) ?? null;
}

/**
 * What a BARE «50» means on this line — the one unit the law pins, when it
 * pins exactly one (P1.3). Anything else is asked with buttons: a bare
 * number is never silently a weight (the audit's finding: «a bare number
 * becomes KILOGRAMS on practically every line»).
 */
export function bareUnitFor(line: LineNeed): NeedUnit | null {
  return line.pinned.length === 1 ? line.pinned[0]!.unit : null;
}

/**
 * The units a bare number is offered in, as buttons (judge UX4): the law's
 * own when it pins several; otherwise a count or a net weight, plus m²/juft/
 * litr ONLY when the line's own word names one — a pair nobody mentioned is
 * not a third guess to hand the seller.
 */
export function bareChoices(line: LineNeed, sellerWord: string | null | undefined): NeedUnit[] {
  if (line.pinned.length > 0) return line.pinned.map((n) => n.unit);
  const out: NeedUnit[] = ['dona', 'kg'];
  const said = unitOf(sellerWord);
  if (said === 'm2' || said === 'juft' || said === 'litr') out.push(said);
  return out;
}

/**
 * A figure in a unit, as the line's columns hold it — through the kernel's
 * router, so «m2» lands in the pair and «kg» in the weight here exactly as
 * at the door. `1000_dona` is a count of PIECES (the law divides).
 */
export function needFigure(unit: NeedUnit, value: number): Partial<CalcGoodsFact> {
  const routed = routeAmount(value, unit === '1000_dona' ? 'dona' : unit);
  if ('quantity' in routed) return { quantity: routed.quantity };
  if ('weightKg' in routed) return { weightKg: routed.weightKg };
  if ('volumeM3' in routed) return { volumeM3: routed.volumeM3 };
  if ('measureUnit' in routed) return { measureUnit: routed.measureUnit, measureQty: routed.measureQty };
  return {};
}

/** «50 dona», «120 m²» — a figure as a button's label and an example. */
export function figureLabel(value: number, unit: NeedUnit): string {
  return `${fmt(value)} ${needShortUz(unit)}`;
}

/** A number as the bot writes it — «1200», «1.2». */
export function numberText(value: number): string {
  return fmt(value);
}

/**
 * The line a bare answer is offered against when the law pins nothing it
 * still lacks — a count or a net weight, the one-measure rule (#910).
 */
export function anyMeasureLine(index: number, name: string): LineNeed {
  return { index, name, pinned: [], anyMeasure: true, units: ['dona', 'kg'] };
}

/**
 * The question, in the seller's own language — ONE unit only when the law
 * pins it (judge UX5); a baza-only line is asked for a count OR a weight,
 * because either prices it.
 */
export function lineQuestionText(line: LineNeed): string {
  const head = `❓ ${line.index + 1}-qator «${line.name}»`;
  if (line.pinned.length > 0) {
    const asked = line.pinned.map((n) => `${needWhatUz(n.unit)} — ${needWhyUz(n)}`).join('; ');
    const example = line.pinned.map((n) => `«${figureLabel(n.unit === 'kg' ? 150 : 300, n.unit)}»`).join(', ');
    return `${head}: ${asked}.\nMasalan: ${example}.`;
  }
  return (
    `${head} — nechta dona yoki necha kg (sof og‘irlik)?\n` +
    'Masalan: «50 dona», «300 kg» yoki ikkalasi «300 dona 150 kg». ' +
    'm², juft yoki litr ham bo‘ladi: «120 m²», «40 juft».'
  );
}

/**
 * The «send everything» prompt, per section (judge UX14). The owner's first
 * complaint was «there is no place to enter» a code or m²/juft — and the bot
 * had been telling staff to send «kub/kg» and nothing else.
 */
export function collectPromptText(section: CalcSection): string {
  const goods =
    'Tovar ro‘yxatini yuboring — har qatorda nomi va miqdori (300 dona, 150 kg, 120 m², 40 juft), ' +
    'TNVED kodini bilsangiz yozing. Fayl va rasmlar ham bo‘ladi.';
  if (section === 'rastamojka') return `${goods}\nTugagach «Bo‘ldi» ni bosing.`;
  if (section === 'podklyuch') {
    return `${goods}\nYo‘nalish (Yiwu → Toshkent) va umumiy kub/kg ham yozing.\nTugagach «Bo‘ldi» ni bosing.`;
  }
  return (
    'Endi hamma narsani yuboring: tovar ro‘yxati, fayllar, rasmlar, kub/kg, yo‘nalish.\n' +
    'Tugagach «Bo‘ldi» ni bosing.'
  );
}

/**
 * Does this line STATE goods — a unit word after a figure («300 dona», «1.1
 * kub»), or a TNVED code beside a word («Kurtka 6201930000», «6201.93.00.00»)?
 *
 * The one test both readers of «who is the customer» ask FIRST (review #16):
 * a phone carries neither, and a goods line that also happens to hold nine
 * digits («Kurtka 6201930000 300 dona» — the code and the count glue into
 * one 13-digit run) must never become the lead's phone. A bare line of
 * digits is not a code here: «8901234567» typed alone is somebody's number.
 */
export function statesGoods(line: string): boolean {
  const read = parseGoodsLine(line);
  if (read.unitWords.length > 0) return true;
  // A count after a carton noun and its colon states goods whichever the noun
  // is — the field «Мест: 45», or the product's own noun «Pitsa korobka:
  // 5000», which the kernel reads as the name since round 6.
  const boxed = /(\p{L}+)\s*[:：]\s*\d[\d\s.,]*$/u.exec(line.trim());
  if (boxed && unitOf(boxed[1]!) === 'karobka') return true;
  // …and a code PRINTED as one («6201.93.0000», «2710 19 820 0») is goods
  // with no word beside it (T3): no phone is written 4-2-…
  return read.tnvedCode !== null && (/\p{L}/u.test(line) || codeWrittenAsCode(line));
}

/**
 * Words that make a line something other than a product — ONE list, read by
 * the typed-goods reader (a line named only by these is not goods) and by the
 * customer reader (letters that are one of these are never a client code).
 * Compared lower-cased with every apostrophe DROPPED: «Og’irligi»,
 * «O'g'irligi» and «ogʻirligi» are one word, and phones type all three (the
 * second review's T8 — «O'g'irligi» with its first apostrophe slipped past).
 *
 *  - a TOTAL — «vazni 120 kg», «Вес груза: 3500 кг», «总重量 3500 kg»: the
 *    shipment's totals are read by `parseManualFacts`;
 *  - a COUNT or CARTON-COUNT label — «Кол-во: 300 шт», «Мест: 45»: the figure
 *    belongs to the product named elsewhere. The carton NOUNS that are also
 *    products («Korobka 1000 dona», «Qop 500 dona») are not here (T6/T12) —
 *    intake-manual's `CARTON_NOUNS` says when they are a field;
 *  - a FIELD — a phone, a client, an order, a rate, a date. «Telefon» and
 *    «Телефон» are not here: mobile phones are a staple of this cargo (T6),
 *    and a phone NUMBER carries no unit, so it never reads as goods anyway;
 *  - a greeting, an «about», an «also» — «Hayrli kun, 12 kub», «Yana 5 kub»;
 *  - our own cargo — «Yukimiz 12 kub» (`YUK_WORD`) — and a PLACE with its
 *    case ending, «Andijonga», «Xitoydan» (`placeWord`): the route, not goods;
 *  - a variety — «har xil», «turli», «разные» — never what it is a variety of.
 */
const NOT_GOODS_WORDS = new Set([
  // totals
  'vazni', 'vazn', 'ogirligi', 'ogirlik', 'hajmi', 'hajm', 'kub', 'kg', 'umumiy', 'jami', 'brutto', 'netto',
  'ves', 'вес', 'весом', 'объем', 'объём', 'обьем', 'обьём', 'обем', 'кубатура', 'kubatura', 'obyom', 'obyem',
  'общий', 'общая', 'общее', 'итого', 'всего', 'брутто', 'нетто', 'weight', 'volume', 'gross', 'net', 'total',
  'груз', 'груза', 'грузы', 'грузов', 'jonatma', 'партия', 'partiya',
  // …in the Latin a phone keyboard writes them (round 3 residual): «Itogo 12
  // kub», «Obshiy ves 3500 kg», «Vsego 12 kub», «N.W. 3000 kg» (`wordsOf`
  // reads «N.W.» as one word)
  'itogo', 'vsego', 'obshiy', 'obshij', 'obshchiy', 'obshchij', 'nw', 'gw',
  // counts and carton-count labels
  'кол-во', 'количество', 'soni', 'son', 'miqdori', 'miqdor', 'qty', 'quantity', 'pcs', 'мест', 'места', 'место',
  'joy', 'joyi', 'ctns', 'ctn', 'dona', 'шт',
  // fields
  'tel', 'tlf', 'тел', 'raqam', 'raqami', 'raqamim', 'номер', 'nomer', 'nomeri', 'mijoz', 'мижоз', 'klient',
  'клиент', 'client', 'kod', 'код', 'zakaz', 'заказ', 'invoice', 'no', '№', 'kurs', 'курс', 'inn', 'инн', 'sana',
  'дата',
  // greetings, «about», «also»
  'salom', 'salam', 'assalomu', 'assalom', 'assalamu', 'alaykum', 'aleykum', 'alaikum', 'aleikum', 'alekum',
  'hayrli', 'xayrli', 'kun', 'kech', 'tong', 'hello', 'hi', 'hey', 'привет', 'здравствуйте', 'добрый', 'день',
  'утро', 'вечер', 'taxminan', 'taxminiy', 'примерно', 'около', 'hammasi', 'bolib', 'yana', 'ham', 'va', 'и',
  'ещё', 'еще', 'also',
  // the route's own words — «Xitoydan kelgan yuk 12 kub» is the shipment
  'в', 'из', 'до', 'dan', 'ga', 'gacha', 'kelgan', 'keladigan', 'kelayotgan', 'ketgan', 'ketadigan',
  'ketayotgan', 'jonatilgan', 'boradigan',
  // a variety, never what it is of — «Tovar: har xil» names no product, while
  // «har xil kiyimlar» does by its last word (round-4 probe: «xil» left the
  // status words, and the bare «various» became a product)
  'har', 'xil', 'хил', 'turli', 'турли', 'разные', 'различные', 'various', 'assorted',
]);

/** «Yuk», «Yukimiz», «Yuklarimiz», «Юкимиз» — our cargo, never its name. */
const YUK_WORD = /^(?:yuk|юк)(?:i|im|imiz|ingiz|lar|lari|larim|larimiz|larni|ni|ning|ka|ga|da|dan|и|им|имиз|ингиз|лар|ни|нинг|га|да|дан)?$/u;

/**
 * Where the cargo goes or comes from (T1/T8): «Andijonga 5 kub 1200 kg»,
 * «Xitoydan 12 kub», «Из Китая 12 кубов». A STEM list and the case endings,
 * not an ending alone — «Kurtka», «Sumka» and «Chemodan» end in a case
 * ending too, and they are the commonest cargo there is.
 */
const PLACE_STEMS = new Set([
  'toshkent', 'tashkent', 'andijon', 'andijan', 'namangan', 'fargona', 'fergana', 'qoqon', 'kokand', 'margilon',
  'samarqand', 'samarkand', 'buxoro', 'bukhara', 'xorazm', 'urganch', 'xiva', 'nukus', 'termiz', 'qarshi',
  'navoiy', 'jizzax', 'guliston', 'chirchiq', 'olmaliq', 'angren', 'ozbekiston', 'uzbekiston', 'uzbekistan',
  'xitoy', 'kitay', 'yiwu', 'iwu', 'ivu', 'guangzhou', 'guanchjou', 'gonchjou', 'urumchi', 'urumqi', 'qashqar',
  'kashgar', 'shanghai', 'shanxay', 'beijing', 'pekin', 'shenzhen', 'foshan', 'ningbo', 'horgos', 'xorgos',
  'khorgos', 'irkeshtam', 'bishkek', 'almati', 'almaty', 'olmaota', 'moskva', 'moscow', 'rossiya', 'qozogiston',
  'kazakhstan', 'qirgiziston', 'kyrgyzstan', 'dushanbe',
  'тошкент', 'ташкент', 'андижон', 'андижан', 'наманган', 'фаргона', 'фергана', 'самарканд', 'самарқанд',
  'бухара', 'бухоро', 'хитой', 'иу', 'иву', 'гуанчжоу', 'урумчи', 'кашгар', 'қашқар', 'бишкек', 'алматы',
  'узбекистан', 'ўзбекистон',
  // Russian forms whose ending is not a suffix of the stem
  'китай', 'китая', 'китае', 'китаю', 'москва', 'москвы', 'москве', 'москву', 'россия', 'россии', 'россию',
]);
const PLACE_ENDINGS = [
  '', 'ga', 'ka', 'qa', 'gacha', 'kacha', 'qacha', 'dan', 'tan', 'da', 'ta', 'dagi', 'ning', 'ni', 'га', 'ка',
  'қа', 'гача', 'дан', 'тан', 'да', 'та', 'даги', 'нинг', 'ни', 'а', 'е', 'у', 'ом',
];
export function placeWord(word: string): boolean {
  return PLACE_ENDINGS.some((e) => word.endsWith(e) && PLACE_STEMS.has(word.slice(0, word.length - e.length)));
}

/** A Chinese packing-list total is one unspaced word: «总重量», «总体积», «合计». */
const CJK_TOTALS = ['重量', '毛重', '净重', '体积', '总重', '总计', '合计', '数量', '箱数', '件数', '立方'];

/** Is this word one that makes a line something other than a product? */
export function notGoodsWord(raw: string): boolean {
  const word = raw.toLowerCase().replace(/[’ʻʼ‘`´']/gu, '');
  if (!word) return false;
  if (NOT_GOODS_WORDS.has(word) || YUK_WORD.test(word) || placeWord(word)) return true;
  if (/^\p{Script=Han}+$/u.test(word) && CJK_TOTALS.some((t) => word.includes(t))) return true;
  // «Guangzhou-Toshkent» glued by a hyphen is two places (T1); «Coca-Cola» is not.
  const parts = word.split(/[-–—]/u).filter(Boolean);
  return parts.length > 1 && parts.every(notGoodsWord);
}

/**
 * A greeting or a REQUEST — what a person writes TO us, never what a product
 * is called (R3-T6/T8). Compared as `notGoodsWord` compares: lower-cased,
 * every apostrophe dropped. The stems are the request VERB forms — «hisoblab»,
 * «hisoblang»; «narxi», «narxini»; «растаможить», «растаможка» — and never
 * the bare nouns they share with products (round 4, T-r1 ND3): «Elektr
 * hisoblagichlari», «Hisoblash mashinasi» (a calculator), «Narx yorliqlari»
 * and «Narxlagich» are cargo, and a «hisobla*» / «narx*» stem dropped every
 * one of them. The CAUSATIVE «hisoblat-» («hisoblatmoqchi», «hisoblatib
 * bering») and the bare imperative «hisobla» are verbs no product is named by
 * (round-4 probe: the narrowing lost them), and nor is «how much» — «Narx
 * qancha 12 kub» asks, while «Narx yorliqlari» are price tags.
 */
const REQUEST_WORDS = new Set([
  'salom', 'salam', 'assalomu', 'assalom', 'assalamu', 'alaykum', 'aleykum', 'alaikum', 'aleikum', 'alekum',
  'салом', 'ассалому', 'ассалом', 'ассаламу', 'алайкум', 'алейкум', 'hayrli', 'xayrli', 'hello', 'hi', 'hey',
  'привет', 'здравствуйте', 'добрый', 'kerak', 'нужно', 'надо', 'керак', 'iltimos', 'илтимос', 'пожалуйста',
  'please', 'rahmat', 'рахмат', 'спасибо', 'hisobla', 'хисобла', 'qancha', 'канча', 'қанча', 'сколько',
]);
const REQUEST_STEMS =
  /^(?:hisoblab|hisoblang|hisoblay|hisoblasa|hisoblat|хисоблаб|хисобланг|хисоблат|narxi|narxlari|нархи|нархлари|растамож|rastamoj|rastamozh)/u;

const lowered = (raw: string) => raw.toLowerCase().replace(/[’ʻʼ‘`´']/gu, '');

/** Is this word a greeting or a request? (the contact reader's list, R3-T6). */
export function requestWord(raw: string): boolean {
  const word = lowered(raw);
  return word !== '' && (REQUEST_WORDS.has(word) || REQUEST_STEMS.test(word));
}

/**
 * Words that make a figures-only line a CHAT line about the shipment —
 * «Salom aka, 12 kub 3500 kg», «Bugun 5 kub», «Наш груз 12 куб» (R3-T8):
 * a greeting or request, a person's address (aka, opa, uka), a day, «our».
 * ONE of them is enough. Only words no product is called.
 */
const CHAT_WORDS = new Set([
  'aka', 'akam', 'opa', 'opajon', 'uka', 'ukam', 'bugun', 'ertaga', 'kecha', 'bizning', 'bizni', 'bizga',
  'наш', 'наша', 'наше', 'наши',
]);

/**
 * Words that NAME the shipment or what carries it — the cargo, a city, a
 * total, «also», the truck — and are also how a product is described
 * (round 4, T-r1 ND3 / T-r2 ND5): «Yuk aravasi» is a hand truck, «Ремни для
 * груза» are cargo straps, «Shahar velosipedi» a city bike, «Kurtka jami 150
 * kg» the jackets' own total, «Yana kurtka 150 kg» more jackets. So they make
 * a chat line only when EVERY word of the name is chat or not-goods:
 * «Toshkent shahriga 12 kub», «Bizning yuk 12 kub», «Fura 82 kub», «Mashina
 * 12 kub» (the truck's own total — a round-3 residual). «Mashina moyi 1200
 * kg» is motor oil and «Yuk mashina shinasi 150 kg» truck tyres: a word of
 * the name is neither.
 */
const SHIPMENT_WORDS = new Set([
  'shahar', 'shahri', 'shahriga', 'shahridan', 'shahrida', 'shaharga', 'shahardan', 'shaharda', 'город', 'города',
  'городу', 'городе', 'груз', 'груза', 'грузы', 'грузов', 'jami', 'umumiy', 'итого', 'всего', 'yana', 'fura',
  'фура', 'mashina', 'машина', 'konteyner', 'контейнер', 'container', 'truck',
]);

/** A word of the shipment (`SHIPMENT_WORDS`, or our cargo — «yuk», «yukimiz»). */
function shipmentWord(raw: string): boolean {
  const word = lowered(raw);
  return SHIPMENT_WORDS.has(word) || YUK_WORD.test(word);
}

/**
 * Beside a shipment word, a word that only says WHOSE, WHICH or HOW the cargo
 * is — a possessive, the client's genitive, a count word, today's, «bor» /
 * «готов» — names no product either (round-4 probe: «Mening yukim 12 kub»,
 * «Груз клиента», «Yuk bor», «Yana bitta mashina» became products carrying
 * the shipment's whole total). «Yuk aravasi», «Mashina moyi» still name one.
 */
const SHIPMENT_COMPANIONS = new Set([
  'mening', 'менинг', 'мой', 'моя', 'моё', 'мое', 'мои', 'my', 'our', 'sizning', 'сизнинг', 'ваш', 'ваша', 'uning',
  'унинг', 'его', 'её', 'ее', 'mijozning', 'мижознинг', 'mijozimiz', 'mijozimizning', 'клиента', 'клиентов',
  'clients', 'customers', 'bitta', 'битта', 'bir', 'бир', 'один', 'одна', 'одно', 'one', 'bugungi', 'бугунги',
  'ertangi', 'эртанги', 'сегодняшний', 'сегодняшняя', 'todays', 'bor', 'бор', 'tayyor', 'тайёр', 'готов',
  'готова', 'готово', 'готовы', 'ready',
]);

/** Is this word ONE that makes a figures-only line a chat line by itself? */
export function chatWord(raw: string): boolean {
  const word = lowered(raw);
  return word !== '' && (requestWord(word) || CHAT_WORDS.has(word));
}

/**
 * Is a figures-only name (no count, pair or code) a CHAT line about the
 * shipment rather than a product? One chat word says so; shipment words say
 * so only when nothing else names a product (`SHIPMENT_COMPANIONS` name none).
 */
export function chatLine(words: readonly string[]): boolean {
  if (words.some(chatWord)) return true;
  const plain = (w: string) => shipmentWord(w) || notGoodsWord(w) || SHIPMENT_COMPANIONS.has(lowered(w));
  return words.some(shipmentWord) && words.every(plain);
}

/**
 * The company's `client_code_prefix` setting (round-1 review 2, T4/T10): the
 * bot passes it. Left out, it is the setting's own default, «GS»; null or
 * empty is a company with no prefix.
 */
export interface ClientHintOpts {
  prefix?: string | null;
}

/** The default of `client_code_prefix` in platform/settings — this module is
 * pure and never reads a setting. */
const DEFAULT_CLIENT_CODE_PREFIX = 'GS';

export function clientCodePrefix(opts?: ClientHintOpts): string | null {
  const prefix = (opts?.prefix === undefined ? DEFAULT_CLIENT_CODE_PREFIX : opts.prefix)?.trim();
  return prefix ? prefix : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** «GS777», «gs 777», «GS-777» — the company's own prefix and its digits, as one code. */
export function prefixCode(text: string, prefix: string | null): string | null {
  if (!prefix) return null;
  const m = new RegExp(`^${escapeRe(prefix)}\\s*[-–]?\\s*(\\d{1,8})$`, 'iu').exec(text);
  return m ? `${prefix}${m[1]}`.toUpperCase() : null;
}

/**
 * The label words before a client code — «Mijoz», «Klient», «Kod», and their
 * two-word forms «Mijoz kodi», «Client code», «Код клиента» (round 4, T-r2:
 * «Код клиента 777» named nobody). ONE list for the code reader and the
 * code-before-phone reader.
 */
const CLIENT_LABEL_WORDS = String.raw`(?:mijoz|мижоз|klient|клиент|client|kod|код)(?:\s*(?:kodi|коди|кода|code|клиента|klienta))?`;

/** «Mijoz: GS777», «Klient GS777», «Kod - GS 777» — the label before a code. */
const CLIENT_LABEL = new RegExp(String.raw`^${CLIENT_LABEL_WORDS}(?![\p{L}\p{N}])\s*[:\-–—]?\s*`, 'iu');

/** Letters that are a field's name, not a code's prefix: «Tel 2345678», «No 125». */
const NOT_CODE_LETTERS = /^(?:tel|tlf|no|nr|inn|id)$/i;

/**
 * May these letters, written APART from their digits or among other words, be
 * a client code? (the second review's T4/T10). «GS 777» and «Bobur aka GS777»
 * are the best answers a seller gives — but «Shim 200», «Stol 1000», «Olma
 * 300» and «Samsung A54» are the same shape and are a product and its count or
 * model. So: the company's own prefix, in any case; otherwise two or three
 * CAPITALS («AB 123»), the way a code is printed on a carton. Never a unit,
 * a field or a total word — «JAMI 300», «VES 300», «KUB 5» are figures.
 */
function codeLettersOk(letters: string, prefix: string | null): boolean {
  if (prefix !== null && letters.toLowerCase() === prefix.toLowerCase()) return true;
  if (unitOf(letters) !== null || NOT_CODE_LETTERS.test(letters) || notGoodsWord(letters)) return false;
  return /^[A-Z]{2,3}$/.test(letters);
}

/**
 * A client code written whole: glued («GS777»), with a separator («GS 777»,
 * «GS-777» — a phone keyboard puts the space in), or after a label. Never a
 * figure: «kg 5», «ta 5» and «m2» are amounts in a unit (review #6). The
 * glued and the labelled forms say «code» by their shape; the separated one
 * is a code only when its letters may be one (`codeLettersOk`).
 *
 * A label and bare digits — «Mijoz 777», «Kod: 777», «Klient 1234» — are the
 * company's code written without its prefix (R3-T7): the seller SAID it is
 * the customer, and filing it as goods material re-asked him for ever. A
 * company with no prefix mints codes that ARE the digits, so there the digits
 * are the code (round 4, integration S-e: «Ali aka\nMijoz 777» was refused as
 * a multi-line text on the repeat, with no way to name the customer).
 *
 * `strict` is a line of a MULTI-line hint (R3-T9): there a code other than
 * the company's prefix needs its label — «Kurtka» over «LG55» is a product
 * and its model, not a contact.
 */
function codeWritten(raw: string, prefix: string | null, strict = false): string | null {
  const body = raw.replace(CLIENT_LABEL, '');
  const labelled = body.length < raw.length;
  const own = prefixCode(body, prefix);
  if (own) return own;
  if (labelled && /^\d{1,8}$/.test(body)) return `${prefix ?? ''}${body}`.toUpperCase();
  const m = /^([A-Za-z]{1,4})(\s*[-–]?\s*)(\d{1,8})$/.exec(body);
  if (!m) return null;
  const [, letters, gap, digits] = m as unknown as [string, string, string, string];
  if (unitOf(letters) !== null || unitOf(letters + digits) !== null || NOT_CODE_LETTERS.test(letters)) return null;
  if (strict && !labelled && prefix !== null) return null;
  if (gap !== '' && !labelled && !codeLettersOk(letters, prefix)) return null;
  if (notGoodsWord(letters)) return null;
  return (letters + digits).toUpperCase();
}

/**
 * ONE code among words, and no other digit — «Bobur aka GS777», «GS777
 * Bobur», «Bobur aka GS 777» (review #6, #23): the seller answered «who» with
 * a name AND the code, which is the best answer there is. The token's letters
 * must be a code's (`codeLettersOk`): «Samsung A54», «Xiaomi Redmi K60» name a
 * phone model (T4). A second digit anywhere makes it a guess.
 *
 * With a configured prefix ONLY the prefix is a code among words (R3-T9):
 * two or three capitals beside a word are how a MODEL is written —
 * «Televizor LG55», «Printer HP400», «Lampa LED32», «Truba PPR20», «Nike AF1»
 * — and each became a client code nobody holds, the goods text naming the
 * lead and never reaching the model. Other capitals stay a code on a line
 * that is just the code («AB 123») or after a label («Mijoz: AB123»), in
 * `codeWritten`; a company with no prefix keeps the capitals rule here.
 */
function codeAmongWords(line: string, prefix: string | null): string | null {
  const tokens = line.split(/[\s,;:()«»"'‘’ʻ.]+/u).filter(Boolean);
  const codes: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const own = prefixCode(token, prefix);
    if (own) {
      codes.push(own);
      continue;
    }
    // The company's prefix and its digits as two words.
    const next = tokens[i + 1];
    if (next !== undefined && /^\d{1,8}$/.test(next)) {
      const split = prefixCode(`${token}${next}`, prefix);
      if (split && token.toLowerCase() === prefix?.toLowerCase()) {
        codes.push(split);
        i += 1;
        continue;
      }
    }
    const glued = prefix === null ? /^([A-Za-z]{1,4})[-–]?(\d{1,8})$/.exec(token) : null;
    if (glued && unitOf(token) === null && codeLettersOk(glued[1]!, prefix)) {
      codes.push(`${glued[1]}${glued[2]}`.toUpperCase());
    }
  }
  if (codes.length !== 1) return null;
  const code = codes[0]!;
  // A stall or block number («5-rasta», «2-do‘kon», «9-kvartal») is an
  // address, never a second code or a count.
  const digitsIn = (s: string) => (s.replace(/(?<![\p{L}\d])\d{1,2}[-–]\p{L}+/gu, '').match(/\d/g) ?? []).length;
  return digitsIn(line) === digitsIn(code) ? code : null;
}

/**
 * A phone's digit run: it STARTS at a digit no letter or digit is glued to
 * (T9 — «GS777 901234567» was read as the phone «777 901234567», the code
 * thrown away), and a bracket inside it only holds a two- or three-digit
 * group, «+998 (90) 123-45-67» — «(5-rasta)» after the number is not part of
 * it (T5). A leading «(90) 123-45-67» keeps its bracket below.
 */
const PHONE_RUN = /(?<![\p{L}\d])\+?\d(?:[\d\s.-]|\(\d{2,3}\)|\)){6,20}\d/u;

/**
 * Uzbekistan's 998 and China's 86: a number written in full international
 * form — 998 + nine digits, 86 + eleven — is a phone however its groups fall,
 * and no client code or count is so long.
 */
const COUNTRY_CODES: readonly string[] = ['998', '86'];
const international = (digits: string) => /^(?:998\d{9}|86\d{11})$/u.test(digits);

/**
 * Is this run a WHOLE phone number? Nine digits (the Uzbek mobile without its
 * country code), or a full international or trunk form — 998 + nine, 8 + nine,
 * 0 + nine (the Kyrgyz trunk, and how «Mijoz 0 90 123 45 67» is written),
 * 86 + eleven (China), or 7/8 + ten (Russia, Kazakhstan) with the 7 or 8
 * written APART («+7 701 …», «8 916 …») or the whole number glued. A run
 * opening «71 234 56 78» is a Tashkent number, so «71 234 56 78 12» is it and
 * a room — never a Russian number that happens to start with 7 (round 4,
 * T-r2: «Ali 71 234 56 78 12 xona» kept the room in the phone).
 */
function completePhone(run: string): boolean {
  const digits = run.replace(/\D/g, '');
  if (digits.length === 9 || /^(?:998\d{9}|8\d{9}|0\d{9}|86\d{11})$/.test(digits)) return true;
  return /^[78]\d{10}$/.test(digits) && /^\+?(?:[78](?!\d)|\d{11}$)/.test(run.trim());
}

/**
 * «… 67 5 rasta», «… 67 2-do‘kon», «… 67 12-rasta», «… 67 12 rasta» — a
 * number that names a stall. A one-digit group, or one a hyphen joins to a
 * word, always does; a longer group only when a WORD follows it and the
 * number is whole without it but not with it (R3-T10: «Ali 90 123 45 67 12
 * rasta» was read as the eleven-digit phone «90 123 45 67 12», whose last
 * nine match nobody). «998 90 123 45 67 Ali» and «+7 701 234 56 78 Ivan» keep
 * their last group: without it the number is not whole.
 */
function stallAfter(run: string, after: string): string {
  const last = /^(.*\d)[\s.-]+(\d+)$/su.exec(run);
  if (!last) return run;
  const [, head, group] = last as unknown as [string, string, string];
  const headDigits = head.replace(/\D/g, '');
  const named = /^\s+\p{L}/u.test(after) && completePhone(head) && !completePhone(run);
  const labels = group.length === 1 || /^[-–]\s*\p{L}/u.test(after) || named;
  return labels && headDigits.length >= 9 ? head : run;
}

/**
 * The phone in a line, as the NUMBER RUN (review #26) — the matchers
 * downstream read its digits (`activeClientsByPhone`'s last seven,
 * `openLeadForPhone`'s last nine), and a run is what belongs in the lead's
 * phone column, never «Ali aka +998…».
 *
 * Written as phones are written: digits grouped by spaces, brackets, hyphens
 * or DOTS («90.175.78.00» — the office writes it so, the import parser found
 * eight in one spreadsheet), 9-15 of them. A stall or row number beside it
 * («Dilshod (Andijon, 5-rasta) 90 123 45 67», «… 90 123 45 67 5 rasta») is
 * allowed and left OUT of the run (T5: it used to be read into it, a
 * different number the right one could never join); a free run of four to
 * eight digits is not — an order number, a landline or a code makes the line
 * something other than a contact. Digits glued to letters are a client code
 * and never count against it (T9). Ten CONTIGUOUS digits after a word are a
 * TNVED code («Kurtka 6201930000»), and a run opening 4-2 is one printed
 * («6201 93 000 0», T3); ten spaced ones are a phone written with its 8 («Ali
 * aka 8 90 123 45 67», review #23).
 */
function phoneIn(line: string): { phone: string; start: number; end: number } | null {
  const m = PHONE_RUN.exec(line);
  if (!m) return null;
  const run = stallAfter(m[0], line.slice(m.index + m[0].length));
  const digits = run.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  if (/^\d{10}$/.test(run) && /\p{L}/u.test(line)) return null;
  if (/^\d{4}[\s.-]\d{2}(?!\d)/.test(run)) return null;
  // A phone puts its long part LAST — «90 1234567», «998 901234567». Five to
  // eight digits BEFORE another group are a short code and a count, «Kurtka
  // 620193 300» (round 1, #16), and a phone holds no such group — unless the
  // group opens with the country code glued to the operator's, which is how
  // a number is typed after «+998901234567»: «+99890 123 45 67», «+86138 1234
  // 5678» (round-4 probe: the guard refused the commonest Uzbek form).
  if (/^\+?\d{5,8}[\s.()-]+\d/u.test(run) && !international(digits)) return null;
  const end = m.index + run.length;
  const rest = `${line.slice(0, m.index)} ${line.slice(end)}`;
  if (/(?<![\p{L}\d])\d{4,8}(?!\d)/u.test(rest)) return null;
  // «(90) 123-45-67»: the bracket the run opened belongs to it.
  const bracket = line[m.index - 1] === '(';
  return { phone: bracket ? `(${run}` : run, start: bracket ? m.index - 1 : m.index, end };
}

/**
 * Past sixty characters only a phone answers, and only ONE (T2): «Abdulloh
 * aka Toshkent Chilonzor 9-kvartal dokoni +998 90 123 45 67» is a contact
 * with an address, and re-asking it is the loop #23 closed. Past this it is a
 * paragraph, and a paragraph is material.
 */
const LONG_HINT_CAP = 120;

/**
 * Is what a long line holds besides its phone a CONTACT — a name, a place, a
 * shop — rather than a message with a phone signed under it (R3-T6)? A
 * forwarded request — «Здравствуйте, нужно растаможить куртки и обувь из
 * Китая, мой номер +998 …», «Salom, bizga kurtka va shimlar keladi, iltimos
 * hisoblab bering, tel …» — became the customer: the lead was named with the
 * paragraph and its goods never reached the model. A contact has at most
 * twelve words, no sentence ends inside it, and no greeting or request word.
 *
 * Round 4 (T-r1 ND7, T-r2 ND2) found the round-3 shape refusing the contacts
 * it exists for: an address is written with abbreviations — «г. Ташкент»,
 * «ул. Регистан», «Toshkent sh.», «Urgut t.», «Samarqand vil.», «Ip.» — and a
 * dot after any letter was a «sentence», while «Olimjon aka Andijon viloyati
 * Asaka tumani bozor yonidagi do'kon egasi» is ten words of contact. So a
 * sentence ends at «!» or «?», or at a dot after a word of four letters or
 * more that a capital (or the end) follows; the request words carry the
 * refusal of a request paragraph, and twelve words bound the rest.
 *
 * A line naming somebody's RELATIVE — «akasi», «ukasi», «opasi», «брат» —
 * is about another person (R3-T6's «Bu mijoz GS777 ning akasi, … telefoni
 * 90 …»: whose job and whose phone is the very question), so it is no
 * contact; eight words used to refuse it, and twelve no longer do. «O'g'li»
 * and «qizi» are a relative only after a genitive («Boburning o'g'li»): after
 * a bare name they are the PATRONYMIC a passport writes, «Vali o'g'li»,
 * «Akmal qizi» (round-4 probe).
 *
 * And a contact never speaks of the cargo or what it costs (round-4 probe:
 * twelve words let «У меня груз из Китая хочу узнать стоимость доставки мой
 * номер …» through as the customer, with none of the few request words in it).
 * A cargo word still NAMES the customer beside the role it opens — «Yuk egasi»,
 * «yuk qabul qiluvchi», «Получатель груза», «Грузополучатель» — and «Cargo»
 * capitalised inside the line is a firm's name, «Asia Cargo Express» (round-5
 * probe: the customer of a cargo company is often one itself), while a
 * capitalised «Доставка» or «Груз» there still asks for the delivery. A price
 * is never a contact's word.
 */
const RELATIVE_WORDS = new Set([
  'akasi', 'ukasi', 'opasi', 'singlisi', 'otasi', 'onasi', 'xotini', 'qarindoshi', 'tanishi', 'dosti', 'брат',
  'брата', 'сестра', 'сестры', 'отец', 'мать', 'жена', 'муж', 'сын', 'дочь', 'друг', 'знакомый',
]);
const CHILD_WORDS = new Set(['ogli', 'qizi', 'ўғли', 'угли', 'қизи', 'кизи']);
const CARGO_WORD = /^(?:груз\p{L}*|cargo|доставк\p{L}*)$/u;
const PRICE_TALK = /^(?:стоимост\p{L}*|цен[аыуе]|price|narx\p{L}*|нарх\p{L}*)$/u;
/** The role a cargo word opens: «Yuk egasi», «yuk qabul qiluvchi», «получатель груза», «cargo owner». */
const CARGO_ROLE = new Set([
  'egasi', 'egalari', 'oluvchi', 'oluvchisi', 'jonatuvchi', 'эгаси', 'олувчи', 'получатель', 'получателя',
  'отправитель', 'отправителя', 'владелец', 'хозяин', 'owner', 'receiver', 'recipient', 'consignee',
]);
/** «Qabul qiluvchi» — the receiver — is two words; «qabul qilib oling» is a request. */
const RECEIVER_AFTER = /^(?:qabul|қабул)\s+(?:qiluvchi|қилувчи)/u;
const CARGO_ROLE_GLUED = /^груз(?:о)?(?:получател|отправител)/u;

function contactShaped(rest: string): boolean {
  const words = rest.split(/[\s,;:()«»"]+/u).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length > 12) return false;
  if (/\p{L}[!?](?:\s|$)|\p{L}{4}\.(?:\s+\p{Lu}|\s*$)/u.test(rest)) return false;
  if (/(?<![\p{L}])olib\s+kel/iu.test(rest)) return false;
  const afterGenitive = (i: number) => /(?:ning|нинг)$/u.test(lowered(words[i - 1] ?? ''));
  const role = (i: number) =>
    [words[i - 1], words[i + 1]].some((n) => n !== undefined && CARGO_ROLE.has(lowered(n))) ||
    RECEIVER_AFTER.test(lowered(words.slice(i + 1, i + 3).join(' ')));
  return !words.some((raw, i) => {
    const w = lowered(raw.replace(/[.!?]+$/u, ''));
    const relative = RELATIVE_WORDS.has(w) || (CHILD_WORDS.has(w) && afterGenitive(i));
    const firm = w === 'cargo' && i > 0 && /^\p{Lu}/u.test(raw);
    const cargo = (CARGO_WORD.test(w) || YUK_WORD.test(w)) && !CARGO_ROLE_GLUED.test(w) && !role(i) && !firm;
    return requestWord(w) || relative || PRICE_TALK.test(w) || cargo;
  });
}

/**
 * The company's prefix written APART from its digits before a phone —
 * «GS 777 90 123 45 67», «GS-777 90 …» (R3-T11). The phone's digit run
 * starts at «777» (a space is part of a phone), so the code was swallowed
 * into an eleven-digit «phone» and lost; it is found and masked FIRST. A
 * client label and its digits are the same code (R3-T7): «Mijoz 777 90 123 45
 * 67». Two such codes on one line are a list, never a contact.
 *
 * Unless the «code» is the phone's own head (round 4, T-r1/T-r2 ND1): a label
 * is how a seller introduces a PHONE as readily as a code — «Mijoz: 998 90
 * 123 45 67», «Klient 8 90 …», «Mijoz 7 701 …», «Mijoz 0 90 …» — and the
 * country or trunk digits were taken for the client GS998 / GS8 / GS7 / GS0,
 * whose deal the job then landed on (the landing looks the CODE up first).
 * When the digits and the phone after them make one whole number, they are
 * the number, and `phoneIn` reads it whole; «GS 777 90 123 45 67» is no whole
 * number and stays a code and a phone. After the company's PREFIX only a
 * country code (`COUNTRY_CODES`) is the phone's own head — «GS 998 90 …»; a
 * trunk digit there is the code, «GS 8 90 123 45 67» is GS8 and a mobile,
 * never the trunk-dialled «8 90 …» (round-4 probe).
 */
function codeBeforePhone(line: string, prefix: string | null): { code?: string; phone?: string } | null {
  if (prefix === null) return null;
  const label = String.raw`(?:${CLIENT_LABEL_WORDS})\s*[:\-–—]?`;
  const re = new RegExp(`(?<![\\p{L}\\d])(?:(${escapeRe(prefix)})|${label})\\s*[-–]?\\s*(\\d{1,8})(?!\\d)`, 'giu');
  const hits = [...line.matchAll(re)];
  if (hits.length !== 1) return null;
  const hit = hits[0]!;
  const [, prefixed, digits] = hit as unknown as [string, string | undefined, string];
  const masked = line.slice(0, hit.index) + ' '.repeat(hit[0].length) + line.slice(hit.index + hit[0].length);
  const found = phoneIn(masked);
  const head = prefixed === undefined || COUNTRY_CODES.includes(digits);
  if (!found || (head && completePhone(`${digits} ${found.phone}`))) return null;
  return { code: `${prefix}${digits}`.toUpperCase(), phone: found.phone };
}

/**
 * One line of the answer. `multi` is a line of a two- or three-line answer:
 * there a code other than the company's prefix needs its label (R3-T9).
 */
function lineHint(line: string, prefix: string | null, multi = false): { code?: string; phone?: string } | null {
  if (line.length > LONG_HINT_CAP) return null;
  const long = line.length > 60;
  const code = long ? null : codeWritten(line, prefix, multi);
  if (code) return { code };
  const both = long ? null : codeBeforePhone(line, prefix);
  if (both) return both;
  const found = phoneIn(line);
  if (found) {
    const rest = `${line.slice(0, found.start)} ${line.slice(found.end)}`;
    // A long line is a contact only by its shape, and never names a code
    // beside the phone (R3-T6: «Bu mijoz GS777 ning akasi, … telefoni 90 …»
    // is GS777's BROTHER, and his job landed on GS777's deal).
    if (long) return phoneIn(rest) === null && contactShaped(rest) ? { phone: found.phone } : null;
    // A code BESIDE the phone is the seller's best answer: both (T9). With
    // only the phone the job of a person holding several codes on one number
    // (#407) lands on a new lead.
    const beside = codeAmongWords(rest, prefix) ?? (rest.trim() ? codeWritten(rest.trim(), prefix, multi) : null);
    return beside ? { code: beside, phone: found.phone } : { phone: found.phone };
  }
  if (long) return null;
  const among = codeAmongWords(line, prefix);
  return among ? { code: among } : null;
}

/**
 * A phone or a client code typed into the collection — the two ways staff
 * name a customer. Neither is validated here beyond shape: WHICH client it
 * is gets resolved against the book, where the honest answer lives.
 *
 * NOT «any text with seven digits» (the diagnosis' cause 6): a forwarded
 * goods list carrying a TNVED code used to name the lead AND become its
 * «phone». A line that states goods (`statesGoods`) is never a hint. What a
 * seller actually types is (review #23): one short line holding a code or a
 * phone, a name beside either — or up to three lines where ONE carries digits
 * («Ali aka» / «+998 90 123 45 67»), which is how Telegram users write a
 * contact, or two that carry a code and a phone («GS777» / «+998 …», T2/T9).
 * `opts.prefix` is the company's client-code prefix (`ClientHintOpts`).
 *
 * A digit line no hint reads is still the NAME when its digits are a small
 * number or a numbered place — «Ali aka 2», «Dilshod 5-rasta», «OOO "Asia
 * Trade" 3-filial» (`nameDigits`) — and another line names the customer
 * (round 4, integration defect 2: one such line voided the whole hint, so
 * R3-C4's own pins could never reach the landing). Three digits or more
 * («Kurtka 300», «OOO Asia Trade 2020») still void it: a goods line, or a
 * number nobody can tell from a count — and so does ONE word and its count
 * of two digits or more (`ONE_WORD_COUNT`, round-4 probe: «Kurtka 50» /
 * «Shim 40» over a phone were read as the customer's name lines).
 */
export function parseClientHint(raw: string, opts?: ClientHintOpts): { code?: string; phone?: string } | null {
  const text = raw.trim();
  if (!text) return null;
  const prefix = clientCodePrefix(opts);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > 3 || lines.some(statesGoods)) return null;
  if (lines.length === 1) return lineHint(lines[0]!, prefix);
  if (lines.some((l) => l.length > 60)) return null;
  const read = lines.filter((l) => /\d/.test(l)).map((l) => ({ line: l, hint: lineHint(l, prefix, true) }));
  if (read.some((r) => r.hint === null && !nameDigits(r.line))) return null;
  const hints = read.flatMap((r) => (r.hint ? [r.hint] : []));
  if (hints.length === 0 || hints.length > 2) return null;
  const codes = hints.flatMap((h) => (h.code ? [h.code] : []));
  const phones = hints.flatMap((h) => (h.phone ? [h.phone] : []));
  if (codes.length > 1 || phones.length > 1) return null;
  return { ...(codes[0] ? { code: codes[0] } : {}), ...(phones[0] ? { phone: phones[0] } : {}) };
}

/**
 * A name line's digits: «2», «12», «5-rasta», «3-filial» — never three bare
 * digits in a row, nor a goods line's «nomi, soni». An ADDRESS line is one
 * address word (`addressWord`) and its number of four digits at most —
 * «Chilonzor 12», «Do'kon 45», «Офис 112» say where the customer is, while
 * «Kurtka 50» is a count (round-5 probe).
 */
function nameDigits(line: string): boolean {
  if (ONE_WORD_COUNT.test(line)) {
    return addressWord(line.split(/\s+/u)[0]!) && /(?<!\d)\d{1,4}$/u.test(line);
  }
  return !/\d{3}/u.test(line.replace(/(?<![\p{L}\d])\d{1,3}[-–]\p{L}+/gu, ''));
}

/**
 * «Shim 200», «Stol 1000», «Kurtka 50»: ONE word and its count of two digits
 * or more — the «nomi, soni» line of every list, never a name. ONE home for the
 * customer reader and the material reader (`looksLikeMaterial`).
 */
export const ONE_WORD_COUNT = /^\p{L}[\p{L}'’‘ʻ`-]*\s+\d{2,}$/u;
