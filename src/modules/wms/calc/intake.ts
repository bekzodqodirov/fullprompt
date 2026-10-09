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
import type { BazaBasis, MeasureUnit } from './pricing';
import { routeAmount, unitOf } from './units';

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
  weightKg: 'umumiy og‘irligi (kg)',
  volumeM3: 'umumiy hajmi (kub)',
  goods: 'tovar nomi',
  itemMeasure: 'tovarning soni yoki og‘irligi',
  lineNeed: 'kod so‘ragan o‘lchov',
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

const positive = (n: number | null | undefined): number | null =>
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
    const own = positive(g.weightKg);
    const fromTotal = own === null && lone !== null;
    const measureQty = positive(g.measureQty);
    return {
      name: g.name,
      quantity: positive(g.quantity),
      weightKg: own ?? lone,
      weightFromTotal: fromTotal,
      volumeM3: positive(g.volumeM3),
      measureUnit: measureQty !== null ? (g.measureUnit ?? null) : null,
      measureQty,
      unit: g.unit?.trim() || null,
      amount: positive(g.amount),
      tnvedCode: g.tnvedCode?.trim() || null,
      note: [g.note?.trim() || null, fromTotal ? LONE_WEIGHT_NOTE : null].filter(Boolean).join(' · ') || null,
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
    if (field === 'weightKg') return !(Number(facts.weightKg) > 0);
    if (field === 'volumeM3') return !(Number(facts.volumeM3) > 0);
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

/** «“1,200 kg” — 1.2 mi yoki 1200 mi?» — never a guess between the two. */
export function ambiguousTotalText(a: AmbiguousTotal): string {
  const unit = a.field === 'weightKg' ? needShortUz('kg') : needShortUz('m3');
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
  /** Totals the typed material states two ways — asked, never guessed. */
  ambiguous?: AmbiguousTotal[];
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
    `Og‘irlik: ${num(input.facts.weightKg, 'kg')} · Hajm: ${num(input.facts.volumeM3, 'kub')}\n` +
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
    `Og‘irlik: ${num(input.facts.weightKg, 'kg')} · Hajm: ${num(input.facts.volumeM3, 'kub')}\n` +
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
 * A phone or a client code typed into the collection — the two ways staff
 * name a customer. Neither is validated here beyond shape: WHICH client it
 * is gets resolved against the book, where the honest answer lives.
 */
export function parseClientHint(raw: string): { code?: string; phone?: string } | null {
  const text = raw.trim();
  if (!text) return null;
  const digits = text.replace(/\D/g, '');
  if (digits.length >= 7) return { phone: text };
  if (/^[A-Za-z]{1,4}\d{1,8}$/.test(text)) return { code: text.toUpperCase() };
  return null;
}
