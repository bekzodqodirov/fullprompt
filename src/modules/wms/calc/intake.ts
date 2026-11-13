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
import { applyPacking, derivedBrief, derivedNotes, packingWords, type LineDerived, type PackedField, type Packing } from './carton-math';
import { aiQuestionAsks, COMPUTED_MARK, computedFields, legendLines, packingAsks, packingLegend, PHOTO_MARK } from './table-asks';
import type { AiQuestionKind } from './intake-ai';
import { doorRow } from './door-row';
import { linesVolumeM3 } from './line-totals';
import type { TableRow, TableTarget } from './line-address';
import type { BazaBasis, MeasureUnit } from './pricing';
import { codeWrittenAsCode, normalizeRowUnit, parseGoodsLine, routeAmount, unitOf } from './units';
import { fitTelegram, TELEGRAM_LIMIT } from './fit-telegram';
import { SELLER_TAIL_NO_ASK } from './tail-words';
import { AI_CODE_MARK } from './code-source';
import { clipText } from '../../platform/telegram/format';
import type { IntakeState } from '../../platform/telegram/calc-intake';
import { TO_VED_LABEL, type ReadingWholeness } from '../../platform/telegram/reading-whole';

/** The bot's echo fits by the table's own 4096 rule — reached through this module, which the dialogue already imports. */
export { fitTelegram };
// The seller's answer on a row the bot computes (row-answer.ts): reached by
// the collector through this module, which is the one it loads.
export { answeredRow, answersStated, unansweredRow } from './row-answer';

export type CalcSection = 'yolkira' | 'rastamojka' | 'podklyuch';

export const CALC_SECTIONS: CalcSection[] = ['yolkira', 'rastamojka', 'podklyuch'];

/**
 * Which of the bot's two doors a job came in through (0141, docs/IKKI-ESHIK.md
 * §0): «🧮 Hisoblatish» is 'plain', «🤖 AI rastamojka» is 'ai'. A fact of the
 * REQUEST, read from its row (`intake-door.ts`). Where a door is named as
 * `IntakeDoor | null`, NULL is legacy — every request before 0141, the card
 * form, the thread door, the AI sotuvchi — and means TODAY's behaviour.
 */
export type IntakeDoor = 'plain' | 'ai';

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
  | 'network'
  // A stored file the reading could not load (docs/FAYL-OQISH.md §2.5): a
  // storage blip, which a re-read heals — never «nothing to read».
  | 'files_missing';

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
  files_missing: { text: 'Yuborilgan fayl saqlangan joydan olinmadi.', retry: true },
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
  /**
   * Where `tnvedCode` came from (docs/IKKI-ESHIK.md §3.1): the row's own
   * (Excel, typed), the sealed memory, the exact-key book, or the model's
   * proposal — the one coding function says, so the table and the INSERT can
   * word a model's code as «AI taklifi». Absent = not said (every line read
   * before that function, and every stored row).
   */
  tnvedSource?: 'row' | 'memory' | 'book' | 'model';
  /**
   * The model called its own code a GUESS (`code_sure: false`,
   * docs/AI-SORAYDI.md §2.2). Absent = not said. Only ever false beside
   * `tnvedSource: 'model'`.
   */
  tnvedSure?: boolean;
  /**
   * The NAME is what the model saw on a photo of the goods — written nowhere
   * (his 2a, docs/AI-SORAYDI.md §2.2). The table marks the row «📷 rasmdan
   * (AI taxmini)» and the landed row's note says so. Absent = read or typed.
   */
  nameFrom?: 'photo' | null;
  /** The picture the good was seen or written on — «Фото N» of the request (1-based). Absent = not from a picture. */
  photoNo?: number;
  /**
   * A sheet named this row by an ARTICLE NUMBER, not a word — «XJ-200» under
   * «Item No.» beside a picture column (docs/AI-SORAYDI.md §3.2 X10; the
   * reader's `GoodsRow.nameIsArticle`). Release 1a carries it; what the table
   * asks of it, and the rename that clears it, are release 1b's (review JS-9).
   * Absent = a name in words.
   */
  nameIsArticle?: true;
  /**
   * Which weight the row's own `weightKg` is, when its source SAID
   * (`weight_kind`, a sheet's «N.W.» / «G.W.» column). Customs wants netto;
   * a gross one is said on the row's note by CODE («og‘irlik brutto»), no
   * longer asked of the model in its free text. Absent = not said.
   */
  weightKind?: 'gross' | 'net';
  /**
   * What the source stated PER PACKAGE — a carton count, a carton's size,
   * cube, weight, pieces (docs/AI-SORAYDI.md §2.3). No reader multiplies:
   * `applyPacking` (carton-math.ts) does, and `derived` says how each
   * computed figure of this line was made. Both live in the collection's
   * state and are worded into the landed row's note (`provenanceNote`) —
   * there is no column for either.
   */
  packing?: Packing | null;
  derived?: LineDerived | null;
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
  /** A STORED row's own id and number (docs/SAKKIZ-R3.md K14) — what the add
   * door writes by, and the number the VED's screen prints. Absent on a line
   * that was only read, never stored. */
  itemId?: string | null;
  seq?: number;
}

/** A name the model took from a photo of the goods — the words on the table and on the landed row. */
export const PHOTO_NAME_MARK = '📷';
export const PHOTO_NAME_NOTE = 'nomi rasmdan (AI taxmini)';
/** A code the model itself called a guess — the table's and the landed row's words. */
export const UNSURE_CODE_NOTE = 'TNVED kodi AI taxmini — aniq emas, tekshiring';
/** A row weight its source called GROSS — said by code; the computed-from-cartons case has its own words. */
export const GROSS_WEIGHT_NOTE = 'og‘irlik brutto (netto yozilmagan)';

/**
 * The landed row's note is cut at 500 characters by the door (`doorRow`),
 * from the TAIL, and the door may add sentences of its own after it — so the
 * renderer below keeps itself under this by itself and never leaves the cut
 * to chance.
 */
export const LANDED_NOTE_BUDGET = 440;

const joinNote = (parts: readonly (string | null | undefined)[]): string =>
  parts.filter((part): part is string => Boolean(part && part.trim())).join(' · ');

/**
 * How a line's facts came to be, as ONE note for the landed row — rendered
 * from the line each time, never appended to it (a line passes through the
 * carton arithmetic again whenever a factor is added).
 *
 * In this ORDER, and the order is the safety (review JR-9, JS-11):
 *  1. `first` — sentences CODE reads back by `includes` (the lone-weight
 *     copy's «og‘irlik umumiy (brutto)dan olindi», `weightFromTotalNote`).
 *     They stand first and are never cut: at the tail a long provenance pushed
 *     them past the door's cut and the row forgot where its weight came from;
 *  2. the source's own note — the seller's words, a file's, the model's;
 *  3. the marks: «nomi rasmdan», an unsure code, a gross row weight;
 *  4. the packing as stated;
 *  5. every computed figure with its arithmetic.
 * Over the budget it gives way from the BACK: the arithmetic shrinks to one
 * clause (`derivedBrief` — which figures are computed, and any original a
 * replacement stood in for), then the source's note is clipped with «…». The
 * machine-read sentences, the marks and the packing line are never cut: the
 * VED must be able to redo the arithmetic from what is left.
 */
export function provenanceNote(
  line: Pick<
    CalcGoodsFact,
    | 'note'
    | 'nameFrom'
    | 'photoNo'
    | 'tnvedCode'
    | 'tnvedSure'
    | 'weightKind'
    | 'packing'
    | 'derived'
    | 'quantity'
    | 'weightKg'
    | 'volumeM3'
    | 'measureUnit'
    | 'measureQty'
  >,
  opts: { first?: readonly (string | null)[]; budget?: number } = {},
): string | null {
  const budget = opts.budget ?? LANDED_NOTE_BUDGET;
  const first = joinNote(opts.first ?? []);
  const own = line.note?.trim() ?? '';
  const marks = joinNote([
    line.nameFrom === 'photo' ? `${PHOTO_NAME_NOTE}${line.photoNo ? `, ${line.photoNo}-rasm` : ''}` : null,
    line.tnvedCode && line.tnvedSure === false ? UNSURE_CODE_NOTE : null,
    // A weight computed from the cartons says «brutto» in its own words (`derivedNotes`).
    line.weightKind === 'gross' && line.weightKg != null && !line.derived?.weightKg && !line.derived?.weightIsGross
      ? GROSS_WEIGHT_NOTE
      : null,
  ]);
  const packed = packingWords(line.packing);
  const full = joinNote([first, own, marks, packed, ...derivedNotes(line)]);
  if (full.length <= budget) return full || null;
  // The arithmetic gives way first…
  const brief = joinNote([first, own, marks, packed, derivedBrief(line)]);
  if (brief.length <= budget) return brief;
  // …then the source's own words, clipped to what is left for them.
  const fixed = joinNote([first, marks, packed, derivedBrief(line)]);
  const room = budget - fixed.length - 3; // the « · » that joins it
  // By code points, with its own «…» (`clipText`): a slice can halve an emoji.
  const clipped = room >= 12 ? clipText(own, room) : null;
  return joinNote([first, clipped, marks, packed, derivedBrief(line)]) || null;
}

/**
 * The marks a landed row's note carries, read back — each the twin of a
 * sentence `provenanceNote` writes (`includes`, like `weightFromTotalNote`
 * and `carriesAiCode`): there is no column for «the name is a photo's guess»
 * or «the model doubted its own code», so after the landing the note is where
 * the pass and the add door learn it.
 */
export const photoNameIn = (note: string | null): boolean => (note ?? '').includes(PHOTO_NAME_NOTE);
export const unsureCodeIn = (note: string | null): boolean => (note ?? '').includes(UNSURE_CODE_NOTE);

/** What the AI asked about a row and nobody answered before «✅» — one fixed-prefix clause on the row's note. */
export const AI_ASKED_PREFIX = '🤖 AI so‘radi: ';
const AI_ASKED_CHARS = 120;
export const aiAskedNote = (text: string): string =>
  `${AI_ASKED_PREFIX}${clipText(text.replace(/\s+/g, ' ').replace(/ · /g, ' — ').trim(), AI_ASKED_CHARS)}`;
/** The question standing on a row's note, or null. */
export function aiAskedOf(note: string | null): string | null {
  for (const part of (note ?? '').split(' · ')) {
    if (part.startsWith(AI_ASKED_PREFIX)) return part.slice(AI_ASKED_PREFIX.length).trim() || null;
  }
  return null;
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
  /** Where the code came from (§3.1), carried to the INSERT; absent = not said. */
  tnvedSource?: CalcGoodsFact['tnvedSource'];
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
      ...(g.tnvedSource && g.tnvedCode?.trim() ? { tnvedSource: g.tnvedSource } : {}),
      // The row's whole provenance (docs/AI-SORAYDI.md §2.3, review JB-2): a
      // figure the bot computed and a name it took from a photo land SAYING
      // so — and the lone-weight sentence stands FIRST, where no cut reaches.
      note: provenanceNote(g, { first: [fromTotal ? (facts.weightNetto ? LONE_NETTO_NOTE : LONE_WEIGHT_NOTE) : null] }),
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
    // …and where the code came from, so the INSERT marks a model's proposal
    // (`AI_CODE_NOTE`, docs/IKKI-ESHIK.md §3.1) — the reading coded the row by
    // the very function the INSERT asks.
    ...(g.tnvedSource ? { tnvedSource: g.tnvedSource } : {}),
    note: g.note,
  }));
}

/**
 * An attached invoice's rows as goods facts (P1.6) — everything the file
 * states: the volume and the money, the supplier's own code and what the
 * reader could not use — and its numbers already in the columns their unit
 * word names (docs/IKKI-ESHIK.md §1.7, M10): the landing's own rule
 * (`normalizeRowUnit`, which `doorRow` applies), applied ONCE here, so the
 * table, the summary, the completeness verdict, the file comparison and the
 * card all read the row the landing will store. «120 пар» was 120 PIECES to
 * every reader before the door and 120 juft after it — a table that said
 * «120 dona» with ⚠️ juft. «пар» is juft, m²/litr go to the measure pair,
 * «мест»/CTN/коробок are cartons: a note, never a count. The seller's words
 * go on the note, as the door writes them; the door then finds nothing left
 * to move. ONE mapping for the bot's invoice reader and its test.
 */
export function invoiceFacts(rows: readonly GoodsRow[]): CalcGoodsFact[] {
  return rows.map((g) => {
    const routed = normalizeRowUnit({
      quantity: g.quantity,
      unit: g.unit,
      weightKg: g.weightKg,
      volumeM3: g.volumeM3,
      measureUnit: null,
      measureQty: null,
    });
    const row = {
      name: g.description,
      quantity: g.quantity,
      unit: g.unit,
      weightKg: g.weightKg,
      volumeM3: g.volumeM3,
      amount: g.amount,
      tnvedCode: g.tnvedCode,
      note: g.note,
      // The name is an article number, not a word (§3.2 X10): the reader's flag, kept.
      ...(g.nameIsArticle ? { nameIsArticle: true as const } : {}),
    };
    // A carton count the row's PACKING holds is said there, once (§3.2 X2): a
    // sheet whose only count column counts cartons still writes «15 ctn» as
    // its count for the doors that keep no packing, and «sotuvchi: 15 ctn»
    // beside «📦 15 karobka — fayldan» would state one fact twice.
    const packed = routed.moved && routed.to === 'cartons' && g.packing?.cartons === g.quantity;
    const routedRow = routed.moved
      ? { ...row, ...routed.patch, note: [g.note, packed ? null : routed.note].filter(Boolean).join(' · ') || null }
      : row;
    // What the sheet states PER PACKAGE (docs/AI-SORAYDI.md §2.3): the row's
    // packing goes through the one carton arithmetic here, where every reader
    // of the row — the table, the comparison, the landing — takes it from.
    // Which weight the row's own is travels with it (review JN-4).
    return g.packing
      ? applyPacking({ ...routedRow, packing: g.packing, ...(g.weightKind ? { weightKind: g.weightKind } : {}) }).line
      : routedRow;
  });
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
export function lineFiguresText(g: CalcItemFact, computed: ReadonlySet<PackedField> = NO_FIELDS): string {
  // A figure the BOT multiplied carries its mark (his 3a; review JS-7): one
  // «*» on the figure, explained once under the rows.
  const mark = (field: PackedField) => (computed.has(field) ? COMPUTED_MARK : '');
  return [
    g.quantity !== null ? `${fmt(g.quantity)} ${needShortUz('dona')}${mark('quantity')}` : null,
    g.weightKg !== null
      ? `${fmt(g.weightKg)} ${needShortUz('kg')}${mark('weightKg')}${g.weightFromTotal ? ' (umumiydan)' : ''}`
      : null,
    g.measureQty !== null && g.measureUnit !== null
      ? `${fmt(g.measureQty)} ${needShortUz(g.measureUnit)}${mark('measureQty')}`
      : null,
    g.volumeM3 !== null ? `${fmt(g.volumeM3)} ${needShortUz('m3')}${mark('volumeM3')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
const NO_FIELDS: ReadonlySet<PackedField> = new Set();

/**
 * One line's missing figure in the bot's Uzbek — the kernel's own words
 * (`needWhatUz`/`needWhyUz`, judge UX5), never restated here.
 */
export function lineNeedText(line: LineNeed): string {
  return `${line.index + 1}-qator «${line.name}»: ${lineNeedWhat(line)}`;
}

/**
 * What a line still owes, without its address — the table's ↳ prints exactly
 * this (docs/SAKKIZ-R3.md §2.1, product-fit-19 c): a row stating nothing reads
 * «soni (dona) yoki sof og‘irligi (kg)», never a bare «og‘irligi» that reads
 * like the table's brutto.
 */
export function lineNeedWhat(line: LineNeed): string {
  return line.pinned.length > 0
    ? line.pinned.map((n) => `${needWhatUz(n.unit)} — ${needWhyUz(n)}`).join('; ')
    : `${needWhatUz('dona')} yoki ${needWhatUz('kg')}`;
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
 * A stored row the new material restates with another figure (P4's
 * `IntakeState.conflicts`, law-money-5) — the table's shape for it, so this
 * pure file never names the bot's state. `choice` null = unanswered.
 */
export interface TableConflict {
  itemId: string;
  seq: number;
  field: 'quantity' | 'weightKg' | 'volumeM3' | 'measureQty';
  unit: string;
  stored: number | null;
  read: number;
  choice: 'add' | 'rep' | 'ved' | null;
}

/** An add collection's part of the table (§2.4) — null on a new request. */
export interface TableAmend {
  cardLabel: string;
  storedCount: number;
  totalsStale: readonly ('weightKg' | 'volumeM3')[];
  conflicts: readonly TableConflict[];
  askedSeqs: readonly number[] | null;
  /** The VED has started on the job (`standingAtOpen`): the confirm is «📨 VED ga yuborish». */
  started?: boolean;
  /**
   * Does the collection hold anything the save would write or name — the
   * press's own «Hech narsa o‘zgarmadi» question, read from the state
   * (`amendAdds`, calc-dialog.ts; review ask-break-6). false = nothing yet:
   * the closing promises no press and no re-run. Absent = not known — today's
   * words.
   */
  adds?: boolean;
}

/** What the table is drawn from — everything a row, a total and the closing need. */
/**
 * A question the model asked at the last reading, as the collection keeps it
 * (docs/AI-SORAYDI.md §3.3 M4): by the NAME of the good it is about — the
 * model's row number names a row of ITS list, and the merge renumbers the
 * table (review JR-2). `about` null = the shipment.
 */
export interface AskedQuestion {
  about: string | null;
  kind: AiQuestionKind;
  text: string;
}

/**
 * One thing the table ASKS beyond a row's missing figure (review JB-6): a
 * doubt of the carton arithmetic, a question of the model's, and — from
 * release 1b — an offer with two buttons. Packages BUILD asks in pure files
 * of their own; `intakeTableText` draws them in ONE place (under its row, or
 * above the closing) and is the one that decides what «to‘liq» means:
 * `holds` takes the «✅ Ma’lumot to‘liq» LINE away and leaves the ✅ button —
 * only a table with no goods changes the keyboard.
 */
export interface TableAsk {
  /** Stable within a draw — «pk:3:volumeM3», «ai:0». */
  id: string;
  /** The table row's NUMBER (`TableRow.no`) it stands under; null = above the closing. */
  row: number | null;
  /** One line as the seller reads it — no mark and no address: the draw adds both. */
  text: string;
  holds: boolean;
  /** How a typed answer looks — «1: 2.49 kub»; taught when nothing else in the table is. */
  example?: string;
  /** Release 1b: one pair of buttons, by position (`ask_N_a` / `ask_N_b`). */
  buttons?: [string, string];
}

export interface TableInput {
  section: CalcSection;
  facts: CalcFacts;
  laws: ReadonlyMap<string, NeedLaw>;
  clientLabel: string | null;
  fileCount: number;
  /** R2's doubts (`IntakeState.ambiguousTotals`, CONC-2) — asked, never guessed (re-check p3-7). */
  ambiguous: readonly TotalDoubt[];
  amend: TableAmend | null;
  /** Notes + AI words + certificate, already rendered — fixed, never cut. */
  tail: string;
  /**
   * Totals the collection's lines left behind (calc-dialog `staleTotalsOf`):
   * an add collection's (`amendTotalsStale`, also on `amend`) and a SEEDED
   * one's brutto under a line added beyond the returned rows (review COMP-4).
   * Out of `amend` because a seeded collection has none (fix review FR-4: the
   * stale brutto was computed and never drawn).
   */
  totalsStale?: readonly ('weightKg' | 'volumeM3')[];
  /**
   * The words of a row's name the ANSWER PARSER reads as naming that row alone
   * among `rows` — line-address.ts `nameWordFor`, handed in by the caller
   * because line-address cannot be imported here (it imports intake-manual,
   * which imports this file). The ✍️ line teaches only such a name (review
   * PF-4): «Kurtka 30 dona» over two kurtka rows was refused «name_many» by
   * the parser it taught.
   */
  nameWord: (rows: readonly TableRow[], row: TableRow) => string | null;
  /**
   * The plain door's SUMMARY instead of the asking table (docs/IKKI-ESHIK.md
   * §2.1, his 2a): a gap is ℹ️ and the VED's to ask — no «✍️» asks, no
   * doubts asked, no example — and the closing says the job lands as it is.
   * Absent = the table (the AI door, and a request from before the doors).
   */
  plain?: boolean;
  /** The totals two packing lists disagreed on (`fileTotals.clash`) — the plain summary names them the VED's. */
  clash?: readonly ('weightKg' | 'volumeM3')[];
  /**
   * One line after everything, never cut (§1.4): «⬇️ Yangi ma’lumot
   * qo‘shildi …» on a table material arrived below. Absent = none.
   */
  marker?: string | null;
  /**
   * The plain door's reading stopped part-way (`IntakeState.aiCut`, as-built
   * review OWNER-3): the bot keeps the goods a cut answer completed on BOTH
   * doors (§3.6), and the plain summary listed «7 ta tovar» of a 12-good
   * invoice with no word of the rest — the VED priced seven. Said above the
   * closing; the keyboard and the landing are his 2a's, unchanged. Absent =
   * no cut. The AI door says it through `ai.reading`.
   */
  cut?: { goods: number; why: 'clock' | 'size' | 'dropped' } | null;
  /**
   * The AI door's TABLE (docs/IKKI-ESHIK.md §3.1-§3.4, his 4a/5a): the door
   * in its head, a code the model proposed marked as its proposal, a row with
   * no code told who finds it, the closing promising the AI's figure, and —
   * as the LAST block, right above the buttons — what the last answer did,
   * since the answer sends no message of its own. Absent = today's table (a
   * request from before the doors, §0.2). Ignored under `plain`.
   */
  ai?: TableAi | null;
  /**
   * What the model asked at the last reading (`IntakeState.aiQuestions`) —
   * drawn «🤖 AI so‘raydi» above the closing, each by its good's name. Never
   * under `plain`: the plain summary asks nothing (docs/IKKI-ESHIK.md §2.1).
   */
  aiQuestions?: readonly AskedQuestion[];
  /** Asks a package built in a pure file of its own (review JB-6) — drawn with the table's own. */
  asks?: readonly TableAsk[];
}

/** The AI door's part of the table — what the dialogue reads for it (§3.1, §3.4). */
export interface TableAi {
  /**
   * `aiCalcAvailable()` — a key AND budget today — read ONCE per draw: the
   * only thing that makes «AI hisoblashda topadi» a promise (review PF-SPEC-4).
   */
  available: boolean;
  /**
   * The last answer's result, or what the last «↩️» took back (§3.4) —
   * rendered by the dialogue from the echo records, never cut.
   */
  last: readonly string[];
  /**
   * What the reading read (docs/FAYL-OQISH.md §1.1-§1.2, §1.6): its
   * wholeness as `aiReadingWhole` judged the LIVE state, the state fields the
   * words are drawn from, and the one sheet the model was not shown whole, as
   * the dialogue measured it. Not whole → the closing says what was not read,
   * in words, and points at «👤 VED hisoblasin» (an addition: at «✅ Qo‘shish»
   * adding only what was read); the files refused at arrival are named on
   * every AI table. Absent = a table drawn without it: today's closing.
   */
  reading?: TableReading | null;
}

/** The state a not-whole closing is drawn from — the collection's own fields, never a projection a caller built (#513). */
export type ReadingState = Pick<
  IntakeState,
  'fileCount' | 'material' | 'invoiceGoods' | 'seed' | 'images' | 'pdfs' | 'sheetTexts' | 'aiUsed' | 'aiFailure' | 'goodsFiles'
> &
  Partial<Pick<IntakeState, 'aiCut' | 'aiCutRetried' | 'filesMissing' | 'unreadPdfs' | 'refusedFiles' | 'invoiceTexts'>>;

/** A sheet the model was not shown whole, by its file — `total` null when nobody counted the rest (the reader's own stop, the row ceiling). */
export interface InputCut {
  label: string;
  kept: number;
  total: number | null;
}

export interface TableReading {
  state: ReadingState;
  whole: ReadingWholeness;
  inputCut: InputCut | null;
}

/**
 * A row with no code yet on the AI door's table (§3.1, P13) — never ✅ and
 * never a question: the code is not the seller's part. With the AI
 * available the landing pass looks for one; without it, the VED sets it.
 */
export const CODE_GAP_AI = 'kod yo‘q — AI hisoblashda topadi (topolmasa VED qo‘yadi)';
export const CODE_GAP_VED = 'kod yo‘q — VED xodimi qo‘yadi';

/**
 * The plain door's tail on a gap (§2.1): the VED asks the seller — the
 * landing pass's own lenta words for a seller's fact (`SELLER_TAIL_NO_ASK`),
 * never restated.
 */
const PLAIN_GAP_TAIL = SELLER_TAIL_NO_ASK.lenta;

/** «kg yo‘q — VED xodimi so‘raydi» — what a plain summary row lacks, by its units alone. */
function plainNeedWhat(line: LineNeed): string {
  const units = line.pinned.length > 0 ? [...new Set(line.pinned.map((n) => needShortUz(n.unit)))].join(' va ') : 'dona yoki kg';
  return `${units} yo‘q ${PLAIN_GAP_TAIL}`;
}

/** The plain summary's last line (§2.1): what a typed figure does here, and that more material is welcome. */
export const PLAIN_SUMMARY_LAST =
  'Qator raqami bilan yozsangiz («3: 150 kg», «jami 3500 kg») — shu yerda yangilanadi. Yana ma’lumot bo‘lsa — yuboring.';

/**
 * Every row's number, the ONE numbering (§1's table, product-fit-4,
 * regression-8): the table, the echo, the undo, the offers and the address
 * parser all read `TableRow.no`. A stored row's `seq` (gaps after a VED
 * deletion stay gaps — the numbers the VED's screen and the 2.8 b ask print),
 * a new request's position, or `max(seq) + k` for a line an add collection
 * adds. `needs` are the units the line still owes (`lineNeeds`).
 */
export function tableRowsOf(input: Pick<TableInput, 'section' | 'facts' | 'laws'>): TableRow[] {
  const goods = input.facts.goods ?? [];
  const needs = lineNeeds(input.section, input.facts, input.laws);
  const seqs = goods.flatMap((g) => (typeof g.seq === 'number' ? [g.seq] : []));
  const top = seqs.length > 0 ? Math.max(...seqs) : 0;
  let added = 0;
  return goods.map((g, index) => {
    const seq = typeof g.seq === 'number' ? g.seq : null;
    const no = seq ?? (seqs.length > 0 ? top + ++added : index + 1);
    return { no, index, seq, name: g.name, needs: needs.find((l) => l.index === index)?.units ?? [] };
  });
}

/**
 * Which totals rows are ⚠️ — `missingFields` minus `LINE_FIELDS`, the ONE home
 * on every section (regression-22). R2's `totalsQuestion` said «rastamojka
 * never asks» while MR-9's `REQUIRED_FIELDS.rastamojka` asks brutto and m³, so
 * the rule had two homes that disagreed; the table reads this one.
 */
function totalsMissing(input: Pick<TableInput, 'section' | 'facts' | 'laws'>): CalcField[] {
  return missingFields(input.section, input.facts, input.laws).filter((f) => !LINE_FIELDS.includes(f));
}

/**
 * No conflict is an open question any more (his 1a, docs/IKKI-ESHIK.md §1.1):
 * the stored figure stands and the file's is the VED's. What the table still
 * SAYS under a row is every conflict the VED decides — unanswered, or left
 * to him — as a statement, never a ⚠️.
 */
const vedConflicts = (amend: TableAmend | null) =>
  (amend?.conflicts ?? []).filter((c) => c.choice === null || c.choice === 'ved');

/** The stale totals, wherever the caller put them (`TableInput.totalsStale`, `TableAmend.totalsStale`). */
const staleTotalsIn = (input: Pick<TableInput, 'amend' | 'totalsStale'>) =>
  new Set([...(input.totalsStale ?? []), ...(input.amend?.totalsStale ?? [])]);

/**
 * Every ⚠️ target of the table, in its order: the lines (a need, or an
 * unanswered conflict), the totals, the route. What an unaddressed answer may
 * mean (`TableRef.open`), and what the echo's «Yana {k} ta» counts.
 */
export function tableOpenOf(input: Pick<TableInput, 'section' | 'facts' | 'laws' | 'amend' | 'totalsStale'>): TableTarget[] {
  const lines: TableTarget[] = tableRowsOf(input)
    .filter((r) => r.needs.length > 0)
    .map((r) => ({ line: r.no }));
  const missing = totalsMissing(input);
  const stale = staleTotalsIn(input);
  const totals: TableTarget[] = (['weightKg', 'volumeM3'] as const)
    .filter((f) => missing.includes(f) || stale.has(f))
    .map((f) => ({ totals: f }));
  const route: TableTarget[] = missing.includes('fromCity') || missing.includes('toCity') ? [{ route: true }] : [];
  return [...lines, ...totals, ...route];
}

/**
 * «3-qator», «umumiy brutto», «umumiy hajm», «yo‘nalish» — a target as the
 * seller reads it: in the AI table's state line, an offer's button and the
 * echo of a request from before the doors (one home, #513).
 */
export function targetWord(t: TableTarget): string {
  if ('line' in t) return `${t.line}-qator`;
  if ('totals' in t) return t.totals === 'weightKg' ? 'umumiy brutto' : 'umumiy hajm';
  return 'yo‘nalish';
}

/** «3-qator, umumiy brutto va yana 2 ta» — the first six targets named, the rest counted. */
export function openTargetsText(open: readonly TableTarget[]): string {
  const names = open.map(targetWord);
  return names.slice(0, 6).join(', ') + (names.length > 6 ? ` va yana ${names.length - 6} ta` : '');
}

/** «1, 3, 5–9, 12» — numbers as ranges, in order. */
export function numberRanges(nos: readonly number[]): string {
  const sorted = [...new Set(nos)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j += 1;
    out.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return out.join(', ');
}

/** How many ⚠️ rows `answerHow` asks for a name of its own — the example needs one, not the best. */
export const NAME_ROWS_TRIED = 3;

/** A figure for the table's examples, per unit — «2: 40 juft», «Shapka 30 dona» (§2.1 literally). */
const EXAMPLE_VALUE: Record<NeedUnit, number> = {
  dona: 30, '1000_dona': 3000, kg: 150, m3: 2, m2: 120, juft: 40, litr: 50, sm3: 1500,
};
export const exampleFigure = (unit: NeedUnit) =>
  unit === '1000_dona' ? figureLabel(EXAMPLE_VALUE[unit], 'dona') : figureLabel(EXAMPLE_VALUE[unit], unit);

/** The field a conflict names, in the seller's word, for «so‘rovda og‘irlik yo‘q». */
const CONFLICT_FIELD_WORD: Record<TableConflict['field'], string> = {
  quantity: 'son',
  weightKg: 'og‘irlik',
  volumeM3: 'hajm',
  measureQty: 'o‘lchov',
};

/**
 * «faylda 200 dona, so‘rovda 300 — VED hal qiladi» (docs/IKKI-ESHIK.md §1.1):
 * a statement, never the R3 question «qo‘shilsinmi, o‘rniga yoki VED hal
 * qilsinmi?» — the stored figure stands and the file's goes to the VED.
 */
export function conflictText(c: Pick<TableConflict, 'field' | 'unit' | 'stored' | 'read'>): string {
  const unit = needShortUz(c.unit as NeedUnit) ?? c.unit;
  if (c.stored === null) {
    return `faylda ${fmt(c.read)} ${unit}, so‘rovda ${CONFLICT_FIELD_WORD[c.field]} yo‘q — VED hal qiladi`;
  }
  return `faylda ${fmt(c.read)} ${unit}, so‘rovda ${fmt(c.stored)} — VED hal qiladi`;
}

/** One goods row of the table: its line, and the ↳ under it when it is ⚠️ — ONE entry, a cut never separates them. */
interface TableEntry {
  no: number;
  warn: boolean;
  line: string;
  /** The needs' ↳ text (groupable), and the conflicts' own ↳ lines. */
  need: string | null;
  /** The AI door's «kod yo‘q — …» (§3.1, groupable) — a row with it is ℹ️, never ✅. */
  code: string | null;
  /**
   * The AI door's code is the MODEL's proposal (§3.1, P13): the row is ℹ️,
   * never ✅ on its own, and never folded into «to‘liq» — its «(AI taklifi)»
   * would go with it (review PC-ADV-2). Never a question either.
   */
  proposed: boolean;
  conflicts: string[];
  /** What the table asks about this row beyond a need (`TableAsk`, review JB-6) — its own ↳ lines, never grouped, never folded. */
  asks: string[];
}

const entryText = (e: TableEntry, need: boolean, code = true) =>
  [
    e.line,
    ...(need && e.need ? [`   ↳ ${e.need}`] : []),
    ...(code && e.code ? [`   ↳ ${e.code}`] : []),
    ...e.conflicts.map((c) => `   ↳ ${c}`),
    ...e.asks.map((a) => `   ↳ ❓ ${a}`),
  ].join('\n');

/** A row the table may fold into «✅ yana N ta qator to‘liq»: nothing owed — no figure, no question, and (AI door) a code nobody has to check. */
const entryOk = (e: TableEntry) => !e.warn && !e.code && !e.proposed && e.asks.length === 0;

/**
 * Every ask of a table (review JB-6) — the arithmetic's doubts, the model's
 * questions, a package's own — in the ONE order they are drawn. The plain
 * summary asks nothing (docs/IKKI-ESHIK.md §2.1): there is none.
 */
export function tableAsksOf(input: Pick<TableInput, 'section' | 'facts' | 'laws' | 'amend' | 'plain' | 'aiQuestions' | 'asks'>): TableAsk[] {
  if (input.plain === true) return [];
  const rows = tableRowsOf(input);
  return [...packingAsks(rows, input.facts.goods ?? []), ...aiQuestionAsks(input.aiQuestions ?? []), ...(input.asks ?? [])];
}

/**
 * The asks that stand under no row, as the block above the closing: a
 * package's own first, then the model's under its heading — with the one way
 * release 1a has to answer words (the model reads them on the next «Bo‘ldi»).
 */
function looseAskLines(asks: readonly TableAsk[]): string[] {
  if (asks.length === 0) return [];
  const model = asks.filter((a) => a.id.startsWith('ai:'));
  const other = asks.filter((a) => !a.id.startsWith('ai:'));
  return [
    ...other.map((a) => `❓ ${a.text}`),
    ...(model.length > 0
      ? ['🤖 AI so‘raydi:', ...model.map((a) => `❓ ${a.text}`), 'Javobini «➕ Yana ma’lumot» bilan yozib yuboring — AI qayta o‘qiydi.']
      : []),
  ];
}

/** A table with no goods row: what to send, on every door that asks. */
const NO_GOODS_CLOSING = '⚠️ Tovar nomi yozilmagan — tovarlarni «➕ Yana ma’lumot» bilan yuboring.';

/** The AI door's complete closing (§3.2), verbatim — «complete» being the SELLER's part. */
export const AI_TABLE_COMPLETE = '✅ Ma’lumot to‘liq — «✅ Tasdiqlash» ni bosing, AI hisoblaydi.';

/**
 * What a complete AI table promises the press does (§3.2, §3.7): the AI's
 * figure only while the AI will run today — otherwise the plain door's true
 * words, the job going to the VED; an addition the VED has started on goes
 * to him and nothing re-runs.
 */
/**
 * An add collection with nothing in it yet (review ask-break-6): «✅ Qo‘shish»
 * would answer «Hech narsa o‘zgarmadi» and queue no pass, so the closing
 * promises neither — it says what the door takes.
 */
export const AMEND_NOTHING_YET = 'ℹ️ Hali hech narsa qo‘shilmadi — yangi tovar, javob yoki faylni shu yerga yuboring.';

function aiCompleteLine(amend: TableAmend | null, available: boolean): string {
  if (amend?.adds === false) return AMEND_NOTHING_YET;
  if (amend?.started) return '✅ Ma’lumot to‘liq — «📨 VED ga yuborish» ni bosing.';
  if (amend) return available ? '✅ Ma’lumot to‘liq — «✅ Qo‘shish» ni bosing, AI qayta hisoblaydi.' : '✅ Ma’lumot to‘liq — «✅ Qo‘shish» ni bosing.';
  return available ? AI_TABLE_COMPLETE : '✅ Ma’lumot to‘liq — «✅ Tasdiqlash» ni bosing, so‘rov VED ga tushadi.';
}

/**
 * The AI door's zero-row line when no file was sent (docs/FAYL-OQISH.md §1.2):
 * the seller's to send, said once — the remedy line under it says how. Its
 * own constant: `NO_GOODS_CLOSING` stays the legacy table's words (critic-pins).
 */
export const AI_NO_GOODS = '⚠️ Tovar nomi yozilmagan.';

/** The AI door's goods row on a table of no rows, after a FILE: the file was not read — the seller is not blamed for typing nothing (critic-said-twice). */
export const AI_GOODS_ROW_UNREAD = '⚠️ tovar — fayldan o‘qilmadi';

export { TO_VED_LABEL };

/** Was anything TYPED (§2.2: a caption or a message with letters or figures — never whitespace)? */
export const typedSomething = (material: readonly string[]) => material.some((s) => s.trim() !== '');

/**
 * The tail's «what WAS read» when the model's reading is missing (§2.2, his
 * 1.6 a), by what was actually read: the Excel rows and the typed text, either,
 * or neither. The Excel-and-typed words are today's (c1892, the r4 pin).
 *
 * `rows`: the table's goods rows. Neither read, yet rows on the table — a
 * returned request's own, an addition's stored ones (door-break-7): the line
 * is left out (null), because «Hech narsa o‘qilmadi» stood right above
 * «⚠️ 2 ta tovar so‘rovdan olindi», and the closing below already says where
 * the rows came from. One sentence per fact.
 */
export function readInsteadWords(state: Pick<ReadingState, 'material' | 'invoiceGoods'>, rows = 0): string | null {
  const excel = (state.invoiceGoods ?? []).length > 0;
  const typed = typedSomething(state.material);
  if (excel && typed) return 'Faqat Excel va yozilganidan o‘qildi.';
  if (excel) return 'Faqat Excel’dan o‘qildi.';
  if (typed) return 'Faqat yozilganidan o‘qildi.';
  return rows > 0 ? null : 'Hech narsa o‘qilmadi.';
}

/**
 * A stored file that did not load, said on the tail with its count and the
 * press that heals it (§2.5) — once: the tail's failure line when the reading
 * had nothing else to read. The not-whole remedy below it then starts at
 * «Faylni …», never naming «🔄» a second time (door-break-6, critic-said-twice).
 */
export function tailNamesRetry(state: Pick<ReadingState, 'aiUsed' | 'aiFailure' | 'filesMissing'>): boolean {
  return !state.aiUsed && state.aiFailure === 'files_missing' && (state.filesMissing ?? 0) > 0;
}

/**
 * Has the table already named «🔄» for a stored file that did not load (as-built
 * review OWNER-7)? The tail's failure line when nothing else was read
 * (`tailNamesRetry`), else the reading's own note (calc-intake
 * `filesMissingNote`, which on the AI door's first or seeded table IS the «🔄»
 * sentence, §2.5) — either way the remedy under it starts at «Faylni …»: one
 * sentence per fact (critic-said-twice). The press re-reads everything.
 */
export const retryNamedAbove = (state: Pick<ReadingState, 'filesMissing'>) => (state.filesMissing ?? 0) > 0;

/** §2.5's words for that line. */
export const filesMissingRetryLine = (missing: number) => `${missing} ta fayl saqlangan joydan olinmadi — «🔄 AI qayta o‘qisin» ni bosing.`;

/** Where a not-whole table's rows came from — «Excel’dan», «yozilganidan», both, or the returned request's own. */
function rowsFromWords(state: ReadingState): string {
  const excel = (state.invoiceGoods ?? []).length > 0;
  const typed = typedSomething(state.material);
  if (excel && typed) return 'Excel va yozilganidan';
  if (excel) return 'Excel’dan';
  if (typed) return 'yozilganidan';
  return 'so‘rovdan';
}

/**
 * A file or sheet as a sentence names it, quoted ONCE (as-built review
 * OWNER-6): the readers store a label already quoted — «x.xlsx»
 * (`readIntakeFile`), «x.xlsx», «Zavod B» varag‘i (a further sheet) — and a
 * bare one only as a fallback or in a test. Wrapped again, every capped and
 * cut table said ««x.xlsx»».
 */
const quotedLabel = (label: string) => (label.includes('«') ? label : `«${label}»`);
/** A further sheet's label already says «… varag‘i»; a file's is called a table. */
const SHEET_LABEL = / varag‘i$/u;
/** «X jadvali» — the table a cut or a cap is about, as a noun («… to‘liq o‘qilmadi»). */
const tableNoun = (label: string) =>
  label === 'Jadval' ? 'jadval' : SHEET_LABEL.test(label) ? label : `${quotedLabel(label)} jadvali`;
/** «X jadvalining» — the same table owning its rows («… birinchi 500 qatori»). */
const tableOwner = (label: string) =>
  label === 'Jadval' ? 'Jadvalning' : SHEET_LABEL.test(label) ? `${label}ning` : `${quotedLabel(label)} jadvalining`;

/** The material only the model reads that it did not read — «1 ta PDF, 2 ta rasm, «Invoice» varag‘i». */
function unreadMaterialWords(state: ReadingState): string {
  const refused = new Set(state.unreadPdfs ?? []);
  const pdfs = state.pdfs.filter((p) => !refused.has(p.attachmentId)).length;
  const sheets = state.sheetTexts.filter((t) => t.text.trim() !== '');
  const named = sheets.flatMap((t) => (t.label ? [`${quotedLabel(t.label)} varag‘i`] : []));
  const unnamed = sheets.filter((t) => !t.label).length;
  return [
    ...(pdfs > 0 ? [`${pdfs} ta PDF`] : []),
    ...(state.images.length > 0 ? [`${state.images.length} ta rasm`] : []),
    ...named,
    ...(unnamed > 0 ? [`${unnamed} ta jadval`] : []),
  ].join(', ');
}

/**
 * Did a FILE the seller sent reach the material (as-built review OWNER-5) — a
 * PDF, a photo, a sheet read as text or as rows, a file storage then did not
 * hand back — as opposed to a file refused at arrival? `fileCount` counts a
 * DOCX, a video or a broken Excel the arrival refused and leaves out one past
 * 20 MB, so one fact read two ways: «AI yuborilgan fayllardan tovar topa
 * olmadi» about a Word file no model was shown, «Tovar nomi yozilmagan»
 * blaming the seller whose goods were in the 25 MB invoice.
 */
export function filesAccepted(state: ReadingState): boolean {
  return (
    state.pdfs.length > 0 ||
    state.images.length > 0 ||
    state.sheetTexts.some((t) => t.text.trim() !== '') ||
    (state.invoiceTexts ?? []).some((t) => t.text.trim() !== '') ||
    (state.invoiceGoods ?? []).length > 0 ||
    (state.goodsFiles ?? []).length > 0 ||
    (state.unreadPdfs ?? []).length > 0 ||
    (state.filesMissing ?? 0) > 0
  );
}

/** A file was sent: taken, or refused at arrival and named (`refusedFiles`). */
const fileSent = (state: ReadingState) => filesAccepted(state) || (state.refusedFiles ?? []).length > 0;

/** The zero-row line when every file sent was refused at arrival: the reasons are the named lines under it. */
export const AI_FILES_REFUSED = '⚠️ Yuborilgan fayl o‘qilmadi — sababi pastda.';

/** The refused PDFs by name, as the table names them (§3.4). */
function refusedPdfNames(state: ReadingState): string[] {
  const refused = new Set(state.unreadPdfs ?? []);
  return state.pdfs.filter((p) => refused.has(p.attachmentId)).map((p) => p.name);
}

/**
 * The first line of a not-whole AI table's closing (docs/FAYL-OQISH.md §1.2) —
 * ONE choice by the first reason that blocks, in the order the seller can do
 * something about. Null where the reason's own words already stand on the
 * table: a refused PDF (`refusedPdfLines`), a file storage did not hand back
 * (the reading's note, or the tail's failure line — §2.5, one sentence per
 * fact). With no rows after a model failure the REASON is the tail's failure
 * block, never said twice (critic-said-twice). Pure.
 */
export function notWholeClosing(state: ReadingState, whole: ReadingWholeness, rows: number, inputCut: InputCut | null): string | null {
  const blocking = new Set(whole.blocking);
  if (blocking.has('no_goods')) {
    if (!filesAccepted(state)) return fileSent(state) ? AI_FILES_REFUSED : AI_NO_GOODS;
    return state.aiUsed ? '⚠️ AI yuborilgan fayllardan tovar topa olmadi.' : '⚠️ Fayldan tovar o‘qilmadi.';
  }
  if (blocking.has('cut') && state.aiCut) {
    return state.aiCut.why === 'size' ? `${cutWords(state.aiCut)} Kamroq sahifa yoki Excel yuboring.` : cutWords(state.aiCut);
  }
  if (blocking.has('model_failed')) {
    return `⚠️ ${rows} ta tovar ${rowsFromWords(state)} olindi; ${unreadMaterialWords(state)} o‘qilmadi.`;
  }
  if (blocking.has('input_cut') || blocking.has('capped')) {
    if (!inputCut) return '⚠️ Jadval AI ga to‘liq ko‘rsatilmadi — bir qismi o‘qildi.';
    return inputCut.total !== null
      ? `⚠️ ${tableOwner(inputCut.label)} ${inputCut.kept}/${inputCut.total} qatori o‘qildi.`
      : `⚠️ ${tableOwner(inputCut.label)} birinchi ${inputCut.kept} qatori o‘qildi.`;
  }
  return null;
}

/** A cut reading's line (§1.2's table): how many goods were read, and that the rest were not. */
export function cutWords(cut: { goods: number; why: 'clock' | 'size' | 'dropped' }): string {
  return cut.why === 'size'
    ? `⚠️ Material juda katta — ${cut.goods} ta tovar o‘qildi, qolgani o‘qilmadi.`
    : `⚠️ AI faylni oxirigacha o‘qib ulgurmadi — ${cut.goods} ta tovar o‘qildi, qolgani o‘qilmadi.`;
}

/**
 * The card's record of a cut reading that landed as it is — the plain door's
 * (as-built review OWNER-3): the VED prices from the card, and «Tovarlar:» of
 * seven read like the whole invoice of twelve.
 */
export function cutNoteText(cut: { goods: number; why: 'clock' | 'size' | 'dropped' }): string {
  return `⚠️ AI faylni oxirigacha o‘qimadi — ${cut.goods} ta tovar o‘qildi, qolgani o‘qilmadi: ro‘yxat to‘liq emas, faylni ko‘ring.`;
}

/**
 * Does the closing name this failure itself (as-built review OWNER-12)? A
 * request the API refused over the PDFs it would not take, with nothing else
 * to read: the closing names each one («📄 «X.pdf» — AI bu faylni qabul
 * qilmadi»), and the tail's «AI so‘rovni qabul qilmadi … — fayllarni boshqacha
 * yuboring» said the one refusal twice, with two remedies.
 */
export function failureSaidBelow(state: ReadingState, failure: AiReadFailure): boolean {
  return failure === 'rejected' && refusedPdfNames(state).length > 0;
}

/** «📄 «X.pdf» — AI bu faylni qabul qilmadi», one per PDF the API refused (§3.4) — said on the table, every time it is drawn. */
export function refusedPdfLines(state: ReadingState): string[] {
  return refusedPdfNames(state).map((name) => `📄 «${name}» — AI bu faylni qabul qilmadi`);
}

/** How many files refused at arrival the table names one by one; the rest are counted. */
export const REFUSED_NAMED_MAX = 5;

/** A reason as the seller was told it at arrival, folded into the table's sentence: no closing stop of its own. */
const reasonClause = (why: string) => why.trim().replace(/[.\s]+$/u, '');

/**
 * A name the bot MADE UP for a file that had none (review of the fixes
 * RF-WORDS-9, RF-REGRESSION-9): a Telegram photo has no name and is kept as
 * «rasm», a nameless document as «fayl», the photos past the cap as «N ta
 * rasm». Said as words, never quoted — quoted, «rasm» read as a file the
 * seller had named «rasm».
 */
const madeUpName = (name: string) => name === 'rasm' || name === 'fayl' || /^\d+ ta /u.test(name);
/** A refused file as a sentence names it: its own name quoted once, a made-up one bare. */
const refusedName = (name: string) => (madeUpName(name) ? name : `«${name}»`);

/**
 * The entries past the first few, counted per reason in FILES (as-built review
 * REGRESSION-4) — a counted entry («9 ta rasm») is nine. One rule for the
 * table and the card's note (review of the fixes RF-WORDS-10): the note
 * counted entries, so the VED read «yana 2 ta» where the seller had read ten.
 */
function refusedRest(files: readonly { name: string; why: string }[]): [string, number][] {
  const rest = new Map<string, number>();
  for (const f of files) {
    const n = /^(\d+) ta /u.exec(f.name);
    const why = reasonClause(f.why);
    rest.set(why, (rest.get(why) ?? 0) + (n ? Number(n[1]) : 1));
  }
  return [...rest];
}

type RefusedEntry = { name: string; why: string; resent?: boolean };
/**
 * A refused copy a same-named file was taken after (`resent`) is not «goods
 * not counted»: the name is all the bot knows, and the later copy may hold
 * them. So the resent entries are kept apart from the real refusals — counted
 * apart past the first few, and outside the note's «tovarlari hisobga
 * kirmagan» heading — and two identical earlier copies are said once (the
 * independent check's IC-NEW-4).
 */
function splitResent(files: readonly RefusedEntry[]): { refused: RefusedEntry[]; resent: RefusedEntry[] } {
  const seen = new Set<string>();
  const resent = files.filter((f) => {
    if (!f.resent) return false;
    const key = `${f.name}\u0000${f.why}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { refused: files.filter((f) => !f.resent), resent };
}

/**
 * The files refused AT ARRIVAL, named on the table with their own reasons
 * (docs/FAYL-OQISH.md §1.1): never blocking — the seller was told then, and
 * no door takes a file back out of a collection — but never forgotten either,
 * or «✅ Tasdiqlash» reads «the AI read everything you sent» (critic-refused-unread).
 * An entry a same-named file was TAKEN after (`resent`, review of the fixes
 * RF-FILES-1) says both facts and claims neither file is the other: the name
 * is all the bot knows.
 */
export function refusedFileLines(named: readonly { name: string; why: string; resent?: boolean }[]): string[] {
  const line = (f: { name: string; why: string; resent?: boolean }) =>
    f.resent
      ? `${refusedName(f.name)} (avvalgi nusxa) o‘qilmadi (${reasonClause(f.why)}) — keyin shu nomli fayl olindi.`
      : /^\d+ ta /u.test(f.name)
        ? // A counted entry («3 ta rasm», the photo cap's) is plural: «ulardagi».
          `${f.name} o‘qilmadi (${reasonClause(f.why)}) — ulardagi tovarlar hisobga kirmaydi.`
        : `${refusedName(f.name)} o‘qilmadi (${reasonClause(f.why)}) — undagi tovarlar hisobga kirmaydi.`;
  const { refused, resent } = splitResent(named);
  const all = [...refused, ...resent];
  if (all.length <= REFUSED_NAMED_MAX) return all.map(line);
  // Bounded (as-built review REGRESSION-4): an album of HEIC photos forwarded
  // as files is one entry each, and sixty of them, in the closing the table's
  // fit holds fixed, left no goods row and cut the remedy away. The first few
  // by name, the rest counted per reason — the reasons are a short list.
  const shown = all.slice(0, REFUSED_NAMED_MAX);
  const rest = all.slice(REFUSED_NAMED_MAX);
  return [
    ...shown.map(line),
    ...refusedRest(rest.filter((f) => !f.resent)).map(
      ([why, n]) => `Yana ${n} ta fayl o‘qilmadi (${why}) — ulardagi tovarlar hisobga kirmaydi.`,
    ),
    ...refusedRest(rest.filter((f) => f.resent)).map(
      ([why, n]) => `Yana ${n} ta avvalgi nusxa o‘qilmadi (${why}) — keyin shu nomli fayllar olindi.`,
    ),
  ];
}

/**
 * Does «🔄 AI qayta o‘qisin» help a not-whole reading (§1.2)? A failure a retry
 * heals, a file storage did not hand back, or a CLOCK cut — at most once per
 * material mark (`aiCutRetried`): the same long invoice against the same wall
 * is cut again (model-reread-and-codes). A size cut never: the same material
 * under the same ceiling, another paid call (review #21). A dropped stream is
 * the clock's kind — the network, not the input.
 */
export function notWholeRetry(state: ReadingState): boolean {
  const failure = state.aiUsed ? null : state.aiFailure;
  if (failure !== null && AI_READ_FAILURE[failure].retry) return true;
  if ((state.filesMissing ?? 0) > 0) return true;
  return state.aiCut != null && state.aiCut.why !== 'size' && state.aiCutRetried !== true;
}

/**
 * What «➕ Yana ma’lumot» can do for a block (as-built review OWNER-8,
 * WORDS-3): no door takes a file back OUT of a collection, so new material
 * heals only a block that is not a property of the material already in it.
 * - `more`: it heals — no rows yet, a retryable failure (the next reading
 *   calls the model again), a stored file not handed back (it is loaded
 *   again), a refused PDF (the next reading names it as refused at arrival).
 * - `later`: the model will not answer TODAY for a cause no material moves —
 *   the day's budget, no key, a dead key; anything sent after it is back is
 *   read together with all of it.
 * - `restart`: never — a capped or cut table, a size cut, a refusal of the
 *   material itself: the same file stays in the collection, so only «✖️» and
 *   sending it again without it reads it.
 */
type RemedyKind = 'more' | 'later' | 'restart';
const LATER_FAILURES: ReadonlySet<AiReadFailure> = new Set(['budget', 'not_configured', 'auth']);
function remedyOf(state: ReadingState, reason: ReadingWholeness['blocking'][number]): { kind: RemedyKind; how?: string } {
  switch (reason) {
    case 'no_goods':
    case 'pdf_refused':
    case 'files_missing':
      return { kind: 'more' };
    case 'model_failed': {
      const failure = state.aiUsed ? null : state.aiFailure;
      if (failure === null || AI_READ_FAILURE[failure].retry) return { kind: 'more' };
      if (LATER_FAILURES.has(failure)) return { kind: 'later' };
      return failure === 'truncated'
        ? { kind: 'restart', how: 'kamroq sahifa yoki Excel qilib' }
        : { kind: 'restart', how: 'o‘qilmagan faylsiz (Excel qilib yoki yozib)' };
    }
    case 'cut':
      // A clock cut is «🔄»'s while its one retry stands (`notWholeRetry`);
      // after it the same long file meets the same wall.
      return state.aiCut?.why === 'size'
        ? { kind: 'restart', how: 'kamroq sahifa yoki Excel qilib' }
        : { kind: 'restart', how: 'faylni kichikroq (yoki Excel) qilib' };
    case 'input_cut':
    case 'capped':
      return { kind: 'restart', how: 'jadvalni kichikroq bo‘laklarga bo‘lib' };
  }
}

/**
 * The not-whole closing's last line (§1.2): only the presses that are drawn,
 * and only the roads that lead somewhere (as-built review OWNER-8, WORDS-3).
 * One sentence for every block sent the seller round a loop: under a capped
 * Excel, a budget day's PDF or a size cut, «Faylni Excel qilib … «➕ Yana
 * ma’lumot» bilan yuboring» was followed exactly and the next table said the
 * same, still with no «✅» — the file it could not read was still in the
 * collection. The VED is promised «fayllarni ko‘rib» only where a file
 * reached the card. `retry`: «🔄» is drawn and nothing above has named it.
 */
export function notWholeRemedy(state: ReadingState, whole: ReadingWholeness, retry: boolean): string {
  const remedies = whole.blocking.map((r) => remedyOf(state, r));
  const restart = remedies.find((r) => r.kind === 'restart');
  const later = remedies.some((r) => r.kind === 'later');
  // A file on the card: one taken, or one refused after it was stored (a
  // DOCX); a file past 20 MB never is, and `fileCount` counts exactly the
  // stored ones (the landing's ✅ asks the same, WORDS-2).
  const ved = filesAccepted(state) || state.fileCount > 0
    ? `«${TO_VED_LABEL}» — VED xodimi fayllarni o‘zi ko‘rib hisoblaydi (AI hisoblamaydi).`
    : `«${TO_VED_LABEL}» — VED xodimi o‘zi hisoblaydi (AI hisoblamaydi).`;
  if (!restart && !later) {
    const send = fileSent(state)
      ? 'faylni Excel qilib / tovarlarni yozib «➕ Yana ma’lumot» bilan yuboring.'
      : 'tovarlarni yozib «➕ Yana ma’lumot» bilan yuboring.';
    const lead = retry ? `«🔄 AI qayta o‘qisin» ni bosing, yoki ${send}` : `${send.charAt(0).toUpperCase()}${send.slice(1)}`;
    return `${lead} Yoki ${ved}`;
  }
  const press = retry ? `«🔄 AI qayta o‘qisin» ni bosing, yoki ${ved}` : `${ved.replace(/^(«[^»]+»)/u, '$1 ni bosing')}`;
  if (restart) return `${press} Yoki «✖️ Bekor qilish» ni bosib, ${restart.how} qaytadan yuboring.`;
  const back = state.aiFailure === 'budget' ? 'ertaga' : 'AI ulangach';
  return `${press} Yoki ${back} «➕ Yana ma’lumot» bilan biror narsa yuboring — AI hammasini qayta o‘qiydi.`;
}

/**
 * What a not-whole reading did not read, as a noun phrase — «1 ta PDF»,
 * «faylning oxiri», ««Invoice» jadvali to‘liq» — for the add table's line
 * (§1.6) and, with «o‘qilmadi», the VED landing's reason (§1.3). Null when
 * the reading is whole.
 */
export function unreadWhat(state: ReadingState, whole: ReadingWholeness, inputCut: InputCut | null): string | null {
  const first = whole.blocking[0];
  if (first === undefined) return null;
  switch (first) {
    case 'no_goods':
      return filesAccepted(state) ? 'fayldagi tovarlar' : fileSent(state) ? 'yuborilgan fayl' : 'tovar';
    case 'cut':
      return 'faylning oxiri';
    case 'model_failed':
      return unreadMaterialWords(state) || 'fayl';
    case 'pdf_refused':
      return refusedPdfNames(state).map((n) => `«${n}»`).join(', ') || 'PDF';
    case 'files_missing':
      return `${state.filesMissing ?? 0} ta fayl`;
    case 'input_cut':
    case 'capped':
      return inputCut ? `${tableNoun(inputCut.label)} to‘liq` : 'jadval to‘liq';
  }
  return null;
}

/** «AI hisoblamadi: {sabab}» — why a landing went to the VED alone (§1.3 b): what was not read, or the press itself. */
export function vedLandingReason(state: ReadingState, whole: ReadingWholeness, inputCut: InputCut | null): string {
  if (whole.whole) return `«${TO_VED_LABEL}» bosildi`;
  if (whole.blocking[0] === 'no_goods' && !fileSent(state)) return 'tovar nomi yozilmagan';
  return `${unreadWhat(state, whole, inputCut) ?? 'fayl'} o‘qilmadi`;
}

/**
 * The lenta's honest record of a VED landing (§1.3 a): the card is the «🧮»
 * door's from here on, and the VED reads why — and what the bot DID read, so
 * he knows which files are still his to open.
 */
export function vedLandingNote(state: ReadingState, whole: ReadingWholeness, inputCut: InputCut | null, rows: number): string {
  const read = [
    ...((state.invoiceGoods ?? []).length > 0 ? ['Excel'] : []),
    ...(typedSomething(state.material) ? ['yozilgan matn'] : []),
    ...(state.aiUsed ? ['AI o‘qigan fayllar'] : []),
    ...(state.seed ? ['qaytarilgan so‘rov'] : []),
  ];
  const got = rows > 0 ? `${rows} ta tovar${read.length > 0 ? ` (${read.join(', ')})` : ''}` : 'tovar yo‘q';
  return `🤖 AI eshigidan keldi — AI hisoblamadi: ${vedLandingReason(state, whole, inputCut)}. O‘qilgan: ${got}.`;
}

/** The add table's closing when its own reading is not whole (§1.6): what the press does — adds what was read, and nothing re-runs. */
export function amendNotWholeLine(what: string, confirm: string): string {
  return `⚠️ ${what.charAt(0).toUpperCase()}${what.slice(1)} o‘qilmadi — ${confirm} faqat o‘qilganini qo‘shadi, AI qayta hisoblamaydi.`;
}

/**
 * The table the seller reads after a reading and after every answer (his
 * 1.10 c, docs/SAKKIZ-R3.md §2.1) — it replaces the summary. Every line ✅ or
 * ⚠️ with WHY under it, the totals rows, and how to answer, so a seller fills
 * any line in one message instead of being walked through a question per row.
 *
 * Over Telegram's 4096 (§2.1): every ⚠️ row is always shown; ✅ rows while the
 * text fits, the rest collapsed into one numbered line; then ⚠️ rows sharing
 * one ↳ grouped under the last of them; only then are ⚠️ rows cut, by
 * `fitTelegram`'s own «… va yana N ta qator», with the closing saying what to
 * send instead. `maxLines: Infinity`: R2's 25-line cap is the AI answer's
 * rule, and on the table it would cut row 26 of a short table that fits
 * (product-fit-10). Pure.
 */
export function intakeTableText(input: TableInput): string {
  const rows = tableRowsOf(input);
  const items = itemFacts(input.facts);
  const needs = lineNeeds(input.section, input.facts, input.laws);
  const freightOnly = !REQUIRED_FIELDS[input.section].includes('itemMeasure');
  const goods = input.facts.goods ?? [];
  const conflicts = vedConflicts(input.amend);
  const client = input.clientLabel ?? 'mijoz hali yozilmagan';
  const plain = input.plain === true;
  const ai = !plain && input.ai ? input.ai : null;
  // The plain door's gap mark (§2.1): the VED asks, so the row is told, never warned.
  const gapMark = plain ? 'ℹ️' : '⚠️';
  // A row with no code on the AI door (§3.1): who finds it, by whether the AI
  // will run today — read once per draw by the dialogue.
  const codeGap = ai ? (ai.available ? CODE_GAP_AI : CODE_GAP_VED) : null;

  // The two doors look different on the screen where the seller decides what
  // ✅ does (§2.1, §3.2): «🧮 Hisoblatish · 🛃 Rastamojka», «🤖 AI rastamojka · 🛃 Rastamojka».
  const doorHead = plain ? '🧮 Hisoblatish · ' : ai ? '🤖 AI rastamojka · ' : '';
  const head = input.amend
    ? [`➕ Qo‘shimcha · ${input.amend.cardLabel} · ${SECTION_LABEL[input.section]}`, `Mijoz: ${client}`]
    : [`${doorHead}${SECTION_LABEL[input.section]}`, `Mijoz: ${client}`];
  if (input.fileCount) head.push(`Fayllar: ${input.fileCount}`);
  head.push('', input.amend ? `So‘rovdagi qatorlar (${input.amend.storedCount}):` : `Tovarlar (${rows.length}):`);

  // What the table asks beyond a need (review JB-6), drawn HERE and nowhere
  // else: under its row, or — an ask about no row, or about a row this table
  // does not draw — above the closing.
  const asks = tableAsksOf(input);
  const rowNos = new Set(rows.map((r) => r.no));
  const rowAsks = (no: number) => asks.filter((a) => a.row === no);
  const looseAsks = asks.filter((a) => a.row === null || !rowNos.has(a.row));
  const held = asks.filter((a) => a.holds);
  // The rows' marks, explained once each under the rows and never cut (JS-7).
  const legend = legendLines(packingLegend(rows, goods), numberRanges);

  const entries: TableEntry[] = rows.map((r) => {
    const item = items[r.index]!;
    const need = needs.find((l) => l.index === r.index);
    const itemId = goods[r.index]?.itemId ?? null;
    const own = itemId === null ? [] : conflicts.filter((c) => c.itemId === itemId);
    // A conflict is said under its row and asks nothing (§1.1): no ⚠️ for it.
    const warn = !freightOnly && need !== undefined;
    // No code on the AI door (§3.1): told, never asked, never ✅ — the code is
    // not the seller's part, so it never makes the table incomplete either.
    const code = codeGap !== null && !freightOnly && !item.tnvedCode?.trim() ? codeGap : null;
    // The model's code is its PROPOSAL (§3.1, P13): marked as such, so a code
    // nobody checked never reads like one the file stated — and the row is
    // ℹ️ like a row with none, never ✅ on the proposal alone.
    const proposed = Boolean(ai) && Boolean(item.tnvedCode?.trim()) && item.tnvedSource === 'model';
    const asked = rowAsks(r.no);
    // A row whose figure is in doubt is never ✅, whatever its section.
    const mark = asked.some((a) => a.holds) ? '⚠️' : freightOnly ? '·' : warn ? gapMark : code || proposed ? 'ℹ️' : '✅';
    const fresh = input.amend && r.seq === null ? '🆕 ' : '';
    const figures = lineFiguresText(item, computedFields(goods[r.index]));
    // A name the model gave a PICTURE is its guess (his 2a) — marked on the row.
    const photo = goods[r.index]?.nameFrom === 'photo' ? `${PHOTO_MARK} ` : '';
    return {
      no: r.no,
      warn,
      line: `${mark} ${fresh}${r.no}. ${photo}${clipText(item.name, 40)}${figures ? ` — ${figures}` : ''}${item.tnvedCode ? ` · ${item.tnvedCode}${proposed ? ` ${AI_CODE_MARK}` : ''}` : ''}`,
      need: !freightOnly && need ? (plain ? plainNeedWhat(need) : lineNeedWhat(need)) : null,
      code,
      proposed,
      conflicts: own.map(conflictText),
      asks: asked.map((a) => a.text),
    };
  });

  const missing = totalsMissing(input);
  const doubted = new Set(input.ambiguous.map((a) => a.field));
  const stale = staleTotalsIn(input);
  // «yangi tovar qo‘shildi» only when a line WAS added (fix review W-2): a
  // stored row's corrected weight that was copied from the brutto (lmp-2), or
  // a stored row's corrected m³ under a typed total, leaves the total stale
  // with nothing added — and the table said a new item came. A seeded
  // collection's total is stale only by an added line.
  const staleWhy = !input.amend || rows.some((r) => r.seq === null) ? 'yangi tovar qo‘shildi, yangilansinmi?' : 'yangilansinmi?';
  const clashed = new Set(input.clash ?? []);
  const totalsRows: string[] = [];
  let totalsWarn = false;
  const field = (f: 'weightKg' | 'volumeM3', ok: string, staleWords: string) => {
    const gap = doubted.has(f) || missing.includes(f) || stale.has(f);
    totalsWarn ||= gap;
    if (plain && gap) {
      // Said, never asked (§2.1): a doubt, two files that disagree, a figure
      // nobody gave or a line added under it — the VED's to ask.
      const why = doubted.has(f)
        ? 'ikki xil yozilgan'
        : missing.includes(f)
          ? clashed.has(f)
            ? 'fayllarda ikki xil'
            : 'yo‘q'
          : !input.amend || rows.some((r) => r.seq === null)
            ? 'yangi tovar qo‘shildi'
            : 'o‘zgardi';
      return `ℹ️ ${FIELD_LABEL[f]} ${why} ${PLAIN_GAP_TAIL}`;
    }
    if (doubted.has(f)) return `⚠️ ${FIELD_LABEL[f]} — ikki xil yozilgan (pastda)`;
    if (missing.includes(f)) return `⚠️ ${FIELD_LABEL[f]} — yozilmagan`;
    if (stale.has(f)) return staleWords;
    return ok;
  };
  totalsRows.push(
    field(
      'weightKg',
      `✅ ${weightLabel(input.section, input.facts)}: ${fmt(Number(input.facts.weightKg))} kg`,
      `⚠️ umumiy brutto og‘irligi (kg) — ${staleWhy} «jami … kg»`,
    ),
    field(
      'volumeM3',
      `✅ Hajm: ${volumeText(input.facts)}`,
      `⚠️ umumiy hajmi (kub) — ${staleWhy} «jami … kub»`,
    ),
  );
  if (input.section !== 'rastamojka') {
    const ends = (['fromCity', 'toCity'] as const).filter((f) => missing.includes(f));
    if (ends.length === 0) {
      totalsRows.push(`✅ Yo‘nalish: ${input.facts.fromCity?.trim()} → ${input.facts.toCity?.trim()}`);
    } else {
      totalsWarn = true;
      for (const end of ends) {
        totalsRows.push(plain ? `ℹ️ ${FIELD_LABEL[end]} yozilmagan ${PLAIN_GAP_TAIL}` : `⚠️ ${FIELD_LABEL[end]} — yozilmagan`);
      }
    }
  }
  // A doubt is a QUESTION («1.2 mi yoki 1200 mi?»): the plain summary asks
  // none — its total row already says it is the VED's (§2.1).
  const doubts = plain ? [] : input.ambiguous.map((a) => `⚠️ ${ambiguousTotalText(a)}`);

  const warnRows = entries.filter((e) => e.warn);
  // Something is MISSING (a row's figure, a total) — apart from a question
  // that merely holds the «to‘liq» line (review JB-6): each has its own words.
  const lacking = warnRows.length > 0 || totalsWarn;
  // Complete = the SELLER's part (§3.2): a row with no code is not his to
  // fill. A holding ask takes the «to‘liq» LINE away and leaves the ✅ button.
  const complete = !lacking && held.length === 0;
  const confirm = input.amend ? (input.amend.started ? '«📨 VED ga yuborish»' : '«✅ Qo‘shish»') : '«✅ Tasdiqlash»';
  const vedLine = `Bilmagan qatoringizni VED to‘ldiradi — ${confirm} ni hozir ham bosishingiz mumkin.`;
  const shortage = !lacking
    ? `❓ ${held.length} ta savol javobsiz — javobini yozing.`
    : warnRows.length > 0 && totalsWarn
      ? `⚠️ ${warnRows.length} ta qatorda va umumiyda ma’lumot yetishmayapti.`
      : warnRows.length > 0
        ? `⚠️ ${warnRows.length} ta qatorda ma’lumot yetishmayapti.`
        : '⚠️ Umumiyda ma’lumot yetishmayapti.';
  // How to answer: built from what is MISSING — and when nothing is, from the
  // question itself (its own example), never «Yiwu → Toshkent» on a job whose
  // route nobody asked (JB-6).
  const heldExample = held.find((a) => a.example)?.example ?? null;
  const how = (): string[] =>
    lacking ? answerHow(input, rows, missing, stale) : heldExample ? [`✍️ Javobni shunday yozing: «${heldExample}».`] : [];
  const closing: string[] = [];
  if (plain) {
    // His 2a: the job lands as it is, and the VED asks for what is missing —
    // so the closing promises nothing to fill, and the last line says what a
    // typed figure still does here (§2.2's quiet write). Collecting again
    // (the marker) the summary's ✅ is gone and refused: its closing would
    // point at it, so the marker alone points at «Bo‘ldi» (review PC-ADV-6,
    // the AI table's adv-18).
    if (!input.marker) {
      closing.push(
        ...(input.cut ? [cutWords(input.cut)] : []),
        // Never «to‘liq» under a list the line above says was not read to its
        // end (review of the fixes RF-WORDS-1, RF-REGRESSION-7): the keyboard
        // and the landing are his 2a's, only the words follow the cut.
        rows.length > 0 && warnRows.length === 0 && !totalsWarn && !input.cut
          ? `✅ Ma’lumot to‘liq — ${confirm} ni bosing, so‘rov VED ga tushadi.`
          : `ℹ️ Yetishmaganini VED xodimi o‘zi so‘raydi — ${confirm} ni hozir bosishingiz mumkin.`,
        PLAIN_SUMMARY_LAST,
      );
    }
  } else if (ai) {
    // The AI door's closing is the table's LAST block (§3.2, §3.4), under
    // what the last answer did. Collecting again (the marker) it points at no
    // press the save guard refuses (review adv-18): the marker points at
    // «Bo‘ldi», and only what is still open is said.
    const collecting = Boolean(input.marker);
    // After an answer the state names what is still open (§3.4): «⚠️ Yana 1 ta: 5-qator.»
    const openLine = () => {
      const open = tableOpenOf(input);
      return ai.last.length > 0 && open.length > 0 ? `⚠️ Yana ${open.length} ta: ${openTargetsText(open)}.` : shortage;
    };
    // The files refused at arrival, named on every AI table with their own
    // reasons (docs/FAYL-OQISH.md §1.1) — never blocking, never forgotten.
    const named = collecting ? [] : refusedFileLines(ai.reading?.whole.named ?? []);
    // Not whole (§1.2): the closing says what was not read, in words, and
    // replaces the complete line and `vedLine` — ONLY here: a whole table,
    // complete or not, keeps today's closing (IKKI-ESHIK §3.2, critic-pins).
    const unread = ai.reading && !ai.reading.whole.whole ? ai.reading : null;
    if (unread && input.amend) {
      // An addition keeps its keyboard (§1.6): its press adds what WAS read,
      // and says so — never «AI qayta hisoblaydi» over a file nobody read.
      const line = amendNotWholeLine(unreadWhat(unread.state, unread.whole, unread.inputCut) ?? 'fayl', confirm);
      if (rows.length > 0 && !complete) {
        closing.push(openLine());
        if (!collecting) closing.push(...how(), ...named, line);
      } else if (!collecting) closing.push(...named, line);
    } else if (unread) {
      const first = notWholeClosing(unread.state, unread.whole, rows.length, unread.inputCut);
      const said = [...(first ? [first] : []), ...refusedPdfLines(unread.state)];
      // «🔄» is drawn either way; named once — on the tail when it said it there.
      const remedy = notWholeRemedy(unread.state, unread.whole, notWholeRetry(unread.state) && !retryNamedAbove(unread.state));
      if (rows.length > 0 && !complete) {
        if (!collecting) closing.push(...said);
        closing.push(openLine());
        if (!collecting) closing.push(...how(), ...named, remedy);
      } else if (!collecting) closing.push(...said, ...named, remedy);
    } else if (rows.length === 0) {
      if (!collecting) closing.push(...named, NO_GOODS_CLOSING, vedLine);
    } else if (complete) {
      if (!collecting) closing.push(...named, aiCompleteLine(input.amend, ai.available));
    } else {
      closing.push(openLine());
      if (!collecting) closing.push(...how(), ...named, vedLine);
    }
  } else if (rows.length === 0) {
    closing.push(NO_GOODS_CLOSING, vedLine);
  } else if (complete) {
    closing.push('✅ Ma’lumot to‘liq. Tasdiqlaysizmi?');
  } else {
    closing.push(shortage, ...how(), vedLine);
  }

  const marker = input.marker ? ['', input.marker] : [];
  // The plain summary's closing is its LAST block (§2.1), after the bot's and
  // the model's notes; so is the AI table's (§3.4), after the certificate and
  // under what the last answer did. The table from before the doors keeps its
  // closing above them, as it was.
  const notes = input.tail ? input.tail.split('\n') : [];
  // The asks that stand under no row (review JB-6) — the model's questions,
  // each by its good's name — right above the closing, never cut. Collecting
  // again (the marker) the table asks nothing: «Bo‘ldi» re-reads everything.
  const asked = input.marker ? [] : looseAskLines(looseAsks);
  const closed = asked.length > 0 ? [...asked, ...(closing.length > 0 ? ['', ...closing] : [])] : closing;
  const last = ai ? [...ai.last, ...(ai.last.length > 0 && asked.length > 0 ? [''] : []), ...closed] : closed;
  const tail = plain || ai ? [...notes, ...(last.length > 0 ? ['', ...last] : []), ...marker] : [...notes, ...marker];
  const fixed = (cut: boolean) => [
    ...legend,
    '',
    'Umumiy:',
    ...totalsRows,
    ...doubts,
    ...(plain || ai ? [] : ['', ...closed]),
    ...(cut ? ['Qatorlar ko‘p — sonlar bor Excel yoki packing listni «➕ Yana ma’lumot» bilan yuboring.'] : []),
  ];
  // No rows after a FILE on the AI door: the file was not read — «tovar
  // nomi yozilmagan» there was the very phrase he quoted (critic-said-twice).
  // The plain door and a table from before the doors keep their words (§8).
  const goodsLines =
    rows.length === 0
      ? [
          plain
            ? `ℹ️ ${FIELD_LABEL.goods} yozilmagan ${PLAIN_GAP_TAIL}`
            : ai && (ai.reading ? fileSent(ai.reading.state) : input.fileCount > 0)
              ? AI_GOODS_ROW_UNREAD
              : `⚠️ ${FIELD_LABEL.goods} — yozilmagan`,
        ]
      : null;
  const length = (lines: string[], cut = false) => [...head, ...lines, ...fixed(cut), ...tail].join('\n').length;
  const fits = (lines: string[]) => length(lines) <= TELEGRAM_LIMIT;
  const draw = (lines: string[], cut = false) =>
    fitTelegram(head, lines, fixed(cut), tail, { maxLines: Number.POSITIVE_INFINITY });

  if (goodsLines) return draw(goodsLines);
  const all = entries.map((e) => entryText(e, true));
  if (fits(all)) return draw(all);

  // ✅ rows while they fit, the rest one line: «✅ yana 4 ta qator to‘liq: 1, 3, 5–7».
  // Only a row owing nothing folds there (`entryOk`): an AI-door row with no
  // code is never ✅ (§3.1), so it is never counted «to‘liq».
  const withOk = (list: TableEntry[], needText: (e: TableEntry) => string): string[] | null => {
    const ok = list.filter(entryOk);
    for (let k = ok.length - 1; k >= 0; k -= 1) {
      const shown = new Set(ok.slice(0, k).map((e) => e.no));
      const gone = ok.slice(k).map((e) => e.no);
      const lines = [
        ...list.filter((e) => !entryOk(e) || shown.has(e.no)).map(needText),
        `✅ yana ${gone.length} ta qator to‘liq: ${numberRanges(gone)}`,
      ];
      if (fits(lines)) return lines;
    }
    return null;
  };
  const collapsed = withOk(entries, (e) => entryText(e, true));
  if (collapsed) return draw(collapsed);

  // ⚠️ rows sharing one ↳ lose their own and get one grouped line under the
  // last of them — a 60-line clothing invoice priced only in kg repeats one
  // reason sixty times (product-fit-10). The AI door's «kod yo‘q» is one
  // reason too, grouped the same way.
  const byNeed = new Map<string, number[]>();
  for (const e of warnRows) if (e.need) byNeed.set(e.need, [...(byNeed.get(e.need) ?? []), e.no]);
  const grouped = new Set([...byNeed].filter(([, nos]) => nos.length > 1).map(([need]) => need));
  const codeNos = entries.filter((e) => e.code).map((e) => e.no);
  const codeGrouped = codeNos.length > 1;
  const needGroupedOf = (e: TableEntry) => e.warn && e.need !== null && grouped.has(e.need);
  const groupedText = (e: TableEntry) => {
    const needOwn = !needGroupedOf(e);
    const codeOwn = !(codeGrouped && e.code);
    if (needOwn && codeOwn) return entryText(e, true);
    const nos = needOwn ? [] : byNeed.get(e.need!)!;
    return [
      entryText(e, needOwn, codeOwn),
      ...(!needOwn && nos[nos.length - 1] === e.no ? [`   ↳ ${numberRanges(nos)}: ${e.need}`] : []),
      ...(!codeOwn && codeNos[codeNos.length - 1] === e.no ? [`   ↳ ${numberRanges(codeNos)}: ${codeGap ?? ''}`] : []),
    ].join('\n');
  };
  const groupedAll = entries.map(groupedText);
  if (fits(groupedAll)) return draw(groupedAll);
  const regrouped = withOk(entries, groupedText);
  if (regrouped) return draw(regrouped);
  const okNos = entries.filter(entryOk).map((e) => e.no);
  const okLine = okNos.length > 0 ? [`✅ yana ${okNos.length} ta qator to‘liq: ${numberRanges(okNos)}`] : [];
  const warnOnly = [...entries.filter((e) => !entryOk(e)).map(groupedText), ...okLine];
  if (fits(warnOnly)) return draw(warnOnly);
  // Only then are ⚠️ rows shortened — by `fitTelegram`'s own count line —
  // and the closing says what to send instead. A grouped reason leaves its
  // rows for the lines after the cut (review PF-5): hung under the LAST row of
  // its group, it was the first thing the cut took, and a 60-row clothing
  // table said what every row lacked nowhere.
  // The ✅ rows' one line stays out of the cut too (fix review W-12): one
  // entry of the cut list standing for all of them, it went first, and the
  // count line called it one row — «… va yana 10 ta qator» with 19 hidden.
  // Now the count is the ⚠️ rows the cut took, and nothing else is hidden.
  const reasons = [
    ...[...grouped].map((need) => `   ↳ ${numberRanges(byNeed.get(need)!)}: ${need}`),
    ...(codeGrouped ? [`   ↳ ${numberRanges(codeNos)}: ${codeGap ?? ''}`] : []),
  ];
  const bare = (e: TableEntry) => entryText(e, !needGroupedOf(e), !(codeGrouped && e.code));
  const cutRows = entries.filter((e) => !entryOk(e)).map(bare);
  return fitTelegram(head, cutRows, [...okLine, ...reasons, ...fixed(true)], tail, { maxLines: Number.POSITIVE_INFINITY });
}

/**
 * How to answer, built from THIS table (§2.1): the first ⚠️ line's number and
 * its first unit, a ⚠️ line's first name word (the next one, when there is
 * one, so the two examples show two rows), and the total the table still
 * owes. An add collection says it in its own words (§2.4).
 */
function answerHow(
  input: TableInput,
  rows: readonly TableRow[],
  missing: readonly CalcField[],
  stale: ReadonlySet<'weightKg' | 'volumeM3'>,
): string[] {
  const needing = rows.filter((r) => r.needs.length > 0);
  const first = needing[0];
  const numbered = first ? `${first.no}: ${exampleFigure(first.needs[0]!)}` : null;
  if (input.amend) {
    const asked = (input.amend.askedSeqs ?? [])
      .map((seq) => rows.find((r) => r.seq === seq))
      .filter((r): r is TableRow => r !== undefined && r.needs.length > 0);
    if (asked.length > 0) {
      // At most LINES_NAMED named, the rest counted (review PF-6): the closing
      // is never cut, so a 250-row ask pushed the instruction itself past
      // Telegram's 4096.
      const named =
        asked
          .slice(0, LINES_NAMED)
          .map((r) => `${r.no}-qator ${needWhatUz(r.needs[0]!)}`)
          .join(', ') + (asked.length > LINES_NAMED ? ` va yana ${asked.length - LINES_NAMED} ta` : '');
      return [`✍️ So‘ralgan: ${named}. Yozing: «${asked[0]!.no}: ${exampleFigure(asked[0]!.needs[0]!)}».`];
    }
    // The example is the first thing still OPEN (review adv-20): a ⚠️ row,
    // else the total the table owes — «jami 3500 kg» under a ✅ brutto taught
    // a figure nobody asked for. A conflict is no longer one (§1.1).
    const totalExample =
      missing.includes('weightKg') || stale.has('weightKg')
        ? 'jami 3500 kg'
        : missing.includes('volumeM3') || stale.has('volumeM3')
          ? 'jami 12 kub'
          : null;
    const example = numbered ?? totalExample ?? 'Yiwu → Toshkent';
    return [`✍️ Yetishmaganini yozing: «${example}». Yangi tovar yoki fayl — «➕ Yana ma’lumot».`];
  }
  // A name the parser reads as THAT row alone (`nameWord`, review PF-4) — the
  // next ⚠️ row's when it has one, so the two examples show two rows; else
  // another's; none (two rows of one name) → the numbered example only. It
  // starts with a letter: «100% paxta futbolka» gave «100 30 dona», which
  // reads as row 100 (review adv-20). At most NAME_ROWS_TRIED rows are asked,
  // and the first that answers ends the search (fix review FR-3): every ⚠️
  // row asked, each over every row, was 8 s of the one process on a 500-row
  // table where no row has a name of its own.
  let named: { row: TableRow; word: string } | null = null;
  for (const r of [...needing.slice(1, NAME_ROWS_TRIED), ...needing.slice(0, 1)]) {
    const word = input.nameWord(rows, r);
    if (word !== null) {
      named = { row: r, word };
      break;
    }
  }
  const examples = [
    ...(numbered ? [numbered] : []),
    ...(named ? [`${named.word} ${exampleFigure(named.row.needs[0]!)}`] : []),
    ...(missing.includes('weightKg') || stale.has('weightKg')
      ? ['jami 3500 kg']
      : missing.includes('volumeM3') || stale.has('volumeM3')
        ? ['jami 12 kub']
        : []),
  ];
  if (examples.length === 0) examples.push('Yiwu → Toshkent');
  const quoted = examples.map((e) => `«${e}»`);
  const list = quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} yoki ${quoted.at(-1)}` : quoted[0];
  return [
    `✍️ Bir xabarda istalgan qatorni to‘ldiring: ${list}.`,
    'Bir nechta bo‘lsa — har birini alohida satrga yozing (yoki «;» bilan).',
  ];
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
  /**
   * The AI door's job landed for the VED alone (docs/FAYL-OQISH.md §1.3 a,
   * `vedLandingNote`): the card says so under its head — why the AI did not
   * compute, and what the bot did read. Absent = every other landing.
   */
  doorNote?: string | null;
  /**
   * The files refused AT ARRIVAL (`IntakeState.refusedFiles`, as-built review
   * WORDS-2): the table named them to the seller, and the VED, who prices from
   * the card, was never told which files the AI did not read and that their
   * goods are not in the figure — and of a file past 20 MB he has no copy.
   */
  refusedFiles?: readonly { name: string; why: string; resent?: boolean }[];
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
    (input.doorNote ? `${input.doorNote}\n` : '') +
    (input.section === 'rastamojka'
      ? ''
      : `Yo‘nalish: ${input.facts.fromCity?.trim() || '—'} → ${input.facts.toCity?.trim() || '—'}\n`) +
    `${weightLabel(input.section, input.facts)}: ${num(input.facts.weightKg, 'kg')} · Hajm: ${volumeText(input.facts)}\n` +
    (input.fileCount ? `Fayllar: ${input.fileCount}\n` : '') +
    (input.refusedFiles?.length ? `${refusedFilesNote(input.refusedFiles)}\n` : '') +
    (goods.length ? `\nTovarlar:\n${goodsLines}\n` : '') +
    (input.steps.length ? `\nAI izohi:\n${input.steps.map((s) => `— ${s}`).join('\n')}\n` : '') +
    (material ? `\nSotuvchi yuborgani (asl matn):\n${material}\n` : '') +
    (fields.length ? `\n⚠️ Yetishmayotgan ma’lumot: ${fields.map((f) => FIELD_LABEL[f]).join(', ')}` : '') +
    (lines.length ? `\n⚠️ Qatorlarda yetishmayapti:\n${linesBlock(lines)}` : '')
  );
}

/**
 * «⚠️ O‘qilmagan fayllar: «CI.pdf» — 20 MB dan katta; «spec.docx» — Word fayl»
 * — the note's one line for the files refused at arrival (WORDS-2), in the
 * table's bound: the first few by name, the rest counted per reason in files,
 * as the table counts them (`refusedRest`).
 */
export function refusedFilesNote(files: readonly { name: string; why: string; resent?: boolean }[]): string {
  const { refused, resent } = splitResent(files);
  const listed = (list: readonly RefusedEntry[]) => {
    const shown = list.slice(0, REFUSED_NAMED_MAX).map((f) => `${refusedName(f.name)} — ${reasonClause(f.why)}`);
    const rest = refusedRest(list.slice(REFUSED_NAMED_MAX)).map(([why, n]) => `yana ${n} ta (${why})`);
    return `${shown.join('; ')}${rest.length > 0 ? `; ${rest.join(', ')}` : ''}`;
  };
  const parts = [
    ...(refused.length > 0 ? [`⚠️ O‘qilmagan fayllar (tovarlari hisobga kirmagan): ${listed(refused)}`] : []),
    ...(resent.length > 0 ? [`⚠️ Avvalgi nusxalar o‘qilmadi (keyin shu nomli fayl olindi): ${listed(resent)}`] : []),
  ];
  return parts.join('\n');
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
  // …and in the words of a forwarder's packing list (docs/AI-SORAYDI.md §3.1
  // T3, dg3-05): with the model silent «MEAS: 5.92 CBM» was a PRODUCT «MEAS —
  // 5.92 m³», and «G.W. 1136.5 kg CBM 7.19» a product «G.W. CBM». A unit word
  // or a measure's label is never what the goods are called. NOT «cube»,
  // «package», «size» (review JN-21): «Rubik cube» and a sized product are
  // goods — and the rule is every word of the name, so «Cubic zirconia» stays.
  'meas', 'measurement', 'vol', 'cubic', 'cbm', 'kgs', 'pkgs', 'pkg', 'packages', 'dim', 'dims',
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
