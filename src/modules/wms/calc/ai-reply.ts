import { dutyText } from './duty-text';
import { SMALL_FREIGHT_USD, type BazaSource } from './pricing';
import { AI_REPLY_HEAD, VED_ESTIMATE_MARK } from './reply-heads';
import type { TotalWeightBasis } from './intake';

/**
 * The AI-VED's answer in the seller's own chat — RASTAMOJKA, and on a
 * podklyuch job the road beside it.
 *
 * The owner, 2026-09-05: «telegramda AI ning o'zi tahminiy hisoblab bersin
 * rastamojka qancha bo'lishini. AI-VED faqat rastamojka hisoblaydi.»
 *
 * PURE, and separate from the work it reports on, for the reason every
 * sentence in this family is: the numbers come from the engine and the words
 * come from here, so a wording change cannot move a figure and a pricing
 * change cannot quietly change what the seller is told.
 *
 * The laws it exists to keep.
 *
 *  - **Law 6**: never a `$0`, never a silence. A line the engine refused
 *    prints WHY, in the office's words, and every refusal says who can fix
 *    it — the seller (a fact only the customer has) or the VED.
 *  - **No partial sum wears the job's name** (MR-23). Round 2 (his 2.2 b)
 *    gives the chat TWO customs totals when some rows have no baza: «Aniq»
 *    is a NAMED partial — it states its own row count and that it carries no
 *    fee — and «Taxminiy» is WHOLE or absent: the 📊 medians stand in for the
 *    missing bazas, the engine prices every group, and one row nothing can
 *    price leaves it absent with the reason in words. The screen and the seal
 *    keep the kernel's single total.
 *  - **The road is the TARIFF's list price, labelled as such.** Decision 8
 *    («no freight, ever») was overturned by the owner on 2026-09-26 (item
 *    13); a zone read off the city is said as a guess (his 2.6 b), and a cube
 *    summed from the lines says «qatorlardan» (2.7 b).
 *  - **The number is TAHMINIY.** The official price is the seal (or the typed
 *    «Готово»), and the caveat travels on its own line right under the
 *    total, because the seller reads this on a phone and repeats it.
 */

/** Telegram refuses a message past this; the caller never sends a longer one. */
export const TELEGRAM_LIMIT = 4096;
/** Past this many lines the list collapses — with a count, never in silence. */
export const MAX_REPLY_LINES = 25;

export interface AiVedLine {
  /** What the group is, in the seller's words — its items, joined. */
  label: string;
  code: string | null;
  /**
   * «100 dona × $20/dona» — the group's own measure and baza, when every
   * member states the same one. Null where the group is priced from mixed
   * measures: the figure is still exact, the shorthand is not.
   */
  measureText: string | null;
  /** Which of the machine's sources answered the baza, if any. */
  bazaSource: BazaSource;
  /** The law's shape in words: «10%», «20% / min 3 $/juft». */
  dutyText: string;
  /** The band the additional duty fell in — 0 when a certificate stands. */
  addDutyPct: number;
  /** The excise in words — «aksiz 20%», «aksiz $0.5/litr» — null when the
   * group has none (0131 gave it a per-unit shape beside the percentage). */
  exciseText: string | null;
  vatPct: number | null;
  /** What this group's customs came to, or null with a reason beside it. */
  customsUsd: number | null;
  /** Already in words (`blockerText`'s vocabulary) — never a raw code. */
  refusal: string | null;
  /**
   * Who can fix that refusal (§0.1(7)): a missing count or weight is the
   * customer's fact, so the seller asks; a baza, a law, a stored number that
   * is not a number is the VED's. REQUIRED (#790) — a builder that forgot it
   * would quietly send every refusal to the VED, the shape this field ends.
   */
  refusalTail: FreightTail;
  /**
   * The group's 📊 shadow (round 2, his 2.1 b): a figure from the median of
   * real declarations for the rows nobody priced, or the words for why there
   * is none. Null when nothing was estimated. REQUIRED-nullable (#790), so
   * every builder of a line has to say.
   */
  estimated: AiVedLineEstimate | null;
  /**
   * A priced row's weight was copied from the shipment's total
   * (`weightFromTotalNote`), and WHICH total: the line says «og‘irlik
   * bruttodan», or «og‘irlik nettodan» on a customs job whose document stated
   * only the netto (review PF-3 — calling that copy brutto contradicted the
   * AI izohi on the same card). Null: the rows' weights are their own.
   */
  weightFromTotal: TotalWeightBasis | null;
  /**
   * A row's own baza is OLD — a 📥 declaration from a quarter that ended past
   * BAZA_STALE_DAYS, a 🧠 seal or a 📖 book row as old: the workspace's own
   * ⚠ chip (`bazaStale`) on the same row. The figure beside it is still exact
   * — it is the number the VED's screen prints — so the line says the age
   * rather than dropping the figure. Round 2's per-code chooser reaches back
   * to an older quarter on purpose (§7.3 rule 1), so «the newest file» no
   * longer vouches for the price's age. REQUIRED (#790): a builder that
   * forgot would send an old price out undated.
   */
  staleBaza: boolean;
}

/** One group's 📊 shadow, already in the reply's vocabulary. */
export type AiVedLineEstimate =
  | {
      priced: true;
      customsUsd: number;
      measureText: string | null;
      /** How many declarations each median stood on — «23 va 8 ta». */
      declarations: number[];
      /** The quarter's end when the file is older than BAZA_STALE_DAYS. */
      oldFileEnd: string | null;
    }
  /** Every row's miss in words («2-qator — …»); the reply prints three. */
  | { priced: false; misses: string[] };

/**
 * The reply's two customs totals (his 2.2 b): «Aniq» over the rows that
 * priced, and «Taxminiy» — whole or absent — once the 📊 medians stand in for
 * the rest.
 */
export interface AiVedEstimate {
  /** Every goods row of the request, grouped or not. */
  rows: number;
  /** Rows inside groups whose customs is exact. */
  exactRows: number;
  /** Σ of those groups' customs, WITHOUT the declaration fee. */
  exactUsd: number | null;
  taxminiyUsd: number | null;
  /** bhm null = the typed fee override answered. */
  taxminiyFee: { bhm: number | null; usd: number } | null;
  /** Words, when taxminiyUsd is null. */
  taxminiyBlock: string | null;
}

export interface AiVedReplyInput {
  clientLabel: string | null;
  /** The card's own code — «B-000067» — so the seller can find it. */
  cardLabel: string | null;
  lines: AiVedLine[];
  /** Items nobody has coded: named, because a total that silently drops them
   * is the defect the partial label exists to prevent. */
  ungrouped: string[];
  /** The per-DECLARATION fee (VMQ-55's BHM scale), once for the whole job. */
  fee: { bhm: number; usd: number } | null;
  /** The customs total, or null when the engine refused to make one. */
  totalUsd: number | null;
  /**
   * Why the declaration fee could not be made, in words — null when it was.
   * REQUIRED-nullable (#790): when every line prices and only the fee
   * refuses, the total is absent and this is the only sentence that says why.
   */
  feeRefusal: string | null;
  hasCertificate: boolean;
  /**
   * The road, on a job that has one (podklyuch) — null on a customs-only one.
   * Priced at the tariff's LIST price, or refused with the reason in words.
   */
  freight: AiVedFreight | null;
  link: string | null;
  /** No key on this server: the honest word, not a silent half-answer. */
  aiConfigured: boolean;
  /**
   * A key, but the day's model calls are spent (0096's soft budget).
   *
   * A DIFFERENT sentence from «not configured», deliberately: one is a fact
   * about the server that only the owner can change, the other is a fact
   * about today that fixes itself at midnight — and a seller told the wrong
   * one goes to the wrong person.
   */
  budgetSpent?: boolean;
  /** Round 2's two totals; null when nothing was estimated (#790). */
  estimate: AiVedEstimate | null;
  /**
   * What the model's baza pick did NOT do, and why (review regression-10) —
   * the words `prefillReplyText` used to carry and the per-line reply lost:
   * a row the pick never looked at reads exactly like one the file has no
   * answer for. REQUIRED-nullable (#790): null when no pick ran at all (no
   * key, the budget, a person or a close stood the machine down first).
   */
  pickLeft: PickLeft | null;
  /** Who reads THIS rendering — the seller's chat, or the card's lenta, which
   * carries the VED's own line under its heading (§2.6). */
  audience: 'chat' | 'lenta';
}

/** The pick's own counts of what it left for the VED (`pickBazas`). */
export interface PickLeft {
  /** Rows past MAX_PICK_ROWS, never shown to the model. */
  capped: number;
  /** Picks refused because the chosen declaration's unit does not fit the row. */
  refused: number;
  /** Rows a person filled, or a person's save, while the model thought. */
  overtaken: number;
  /** Heading reads over their statement ceiling. */
  timedOut: number;
  /** The pass's deadline had passed: the pick did not run. */
  skipped: boolean;
}

/**
 * The pick's counts as the reply says them. A row the pass's deadline left
 * unread MID-pick (`pickBazas`' `pastDeadline`, review perf-2) is said with
 * the heading reads that ran out of time — «bojxona faylidan o‘qib
 * ulgurilmadi» is exactly what happened to it; counted nowhere, it read like
 * a row the file has no answer for (regression-10's own complaint, met again
 * at the seam between the two late-pass fixes).
 */
export function pickLeftOf(out: {
  capped: number;
  refused: number;
  overtaken: number;
  timedOut: number;
  pastDeadline: number;
}): PickLeft {
  return {
    capped: out.capped,
    refused: out.refused,
    overtaken: out.overtaken,
    timedOut: out.timedOut + out.pastDeadline,
    skipped: false,
  };
}

/** One line under the totals, or none when the pick left nothing unsaid. */
export function pickLeftLine(left: PickLeft | null): string | null {
  if (!left) return null;
  const parts = [
    ...(left.skipped ? ['vaqt yetmadi — AI deklaratsiya tanlamadi'] : []),
    ...(left.capped > 0 ? [`${left.capped} ta qator ko‘rilmadi (juda ko‘p)`] : []),
    ...(left.refused > 0 ? [`${left.refused} tasida tanlangan deklaratsiya o‘lchovi mos kelmadi`] : []),
    ...(left.timedOut > 0 ? [`${left.timedOut} tasini bojxona faylidan o‘qib ulgurilmadi`] : []),
    ...(left.overtaken > 0 ? [`${left.overtaken} tasida VED o‘zi ishlayapti`] : []),
  ];
  return parts.length === 0 ? null : `⚠️ AI bazasini qo‘ymadi: ${parts.join(', ')} — VED to‘ldiradi`;
}

/** Who can fix a refused road: a fact only the seller or the customer has, or
 * one the VED decides (docs/SAKKIZ-R2.md §2.5). */
export type FreightTail = 'seller' | 'ved';

export type AiVedFreight =
  | {
      ok: true;
      listUsd: number;
      /** «Xitoy → O‘zbekiston» — which of his zones answered. */
      routeLabel: string;
      /** «180 kg/m³ · $160/m³ × 12 m³» — the band, so the figure is checkable;
       * «(qatorlardan)» already after the cube when it is the lines' Σ. */
      bandText: string;
      /** The zone was read off the city (his 2.6 b) and never stored. */
      zoneGuessed: boolean;
      /** What the guess read — the stored `from_city`, cut at 40 characters. */
      zoneReadFrom: string | null;
      /** The m³ is the Σ of the lines (his 2.7 b) — said where it is printed. */
      volumeFromLines: boolean;
      /**
       * The road IS the workspace's own figure: the stored zone over the
       * request's stored totals — what the VED's screen prints and the seal
       * would lock (§0.1(4)). Only then may a sum with it wear the plain
       * «JAMI». A road priced on a guessed zone, or on the lines' Σ standing in
       * for a cube the request does not hold (a pre-round-2 request, or one
       * whose typed cube was ambiguous, P3-R2), is the reply's own estimate —
       * the screen, the chip and the seal all refuse that very cube.
       * REQUIRED (#790): a builder that forgot would claim exactness.
       */
      exact: boolean;
      /** Under SMALL_FREIGHT_USD — priced honestly, flagged loudly. */
      small: boolean;
    }
  | {
      ok: false;
      refusal: string;
      tail: FreightTail;
      /**
       * The SELLER's own gap, said beside a refusal the VED owns (review
       * PF-5): «Foshan» with no brutto kilos used to say only the zone — the
       * reply goes out once (`sayOnce`), so the seller heard about the kilos
       * only after the VED had chosen the zone. One fixer per sentence.
       */
      also?: { refusal: string; tail: 'seller' };
    };

/**
 * The tail of a refused road — WHO fixes it (§0.1(7)). Until round 3's
 * «➕ Shu so‘rovga qo‘shish» door, the card's lenta is the seller's one way to
 * add a fact to a request that has already landed.
 */
export const FREIGHT_TAIL_WORDS: Record<FreightTail, string> = {
  seller: '— mijozdan so‘rab, kartadagi lentaga yozing',
  ved: '— VED xodimi hisoblaydi',
};

/**
 * The tail of a refused CUSTOMS line — the same two fixers as the road's,
 * worded for a line (the VED «qo‘yadi» a baza; the road he «hisoblaydi»).
 * The seller's words are the Taxminiy block's own (`refused_measure`), so a
 * reply that says the count is missing says once who gets it.
 */
export const CUSTOMS_TAIL_WORDS: Record<FreightTail, string> = {
  seller: FREIGHT_TAIL_WORDS.seller,
  ved: '— VED xodimi qo‘yadi',
};

/** The tiny-invoice warning (law 8: priced honestly, flagged loudly). */
export const SMALL_ROAD_LINE = `⚠️ Juda kichik yuk (yo‘lkira $${SMALL_FREIGHT_USD} dan kam) — VED ko‘rib chiqadi.`;

export const money = (n: number) => `$${n.toFixed(2)}`;

/** The road's route as printed — with the guess said, in what was read. */
export function routeWords(f: Extract<AiVedFreight, { ok: true }>): string {
  return f.zoneGuessed ? `${f.routeLabel} — zona «${f.zoneReadFrom ?? ''}»dan taxmin` : f.routeLabel;
}

/** A refused road — the words and who fixes them, and the seller's own gap
 * on a line of its own when the refusal is the VED's (PF-5). */
export function roadRefusalLine(f: Extract<AiVedFreight, { ok: false }>): string {
  const first = `Yo‘lkira: ⚠️ ${f.refusal} ${FREIGHT_TAIL_WORDS[f.tail]}`;
  return f.also ? `${first}\n⚠️ ${f.also.refusal} ${FREIGHT_TAIL_WORDS[f.also.tail]}` : first;
}

/**
 * A priced road as both machine replies print it (review product-fit-13): the
 * route, the band, then the figure — one fact a line, the yolkira reply's own
 * shape. The podklyuch reply nested all three inside one pair of brackets
 * («…12 m³ (qatorlardan)): ≈ $1920.00»), three wrapped lines at 360 px.
 */
export function roadLines(f: Extract<AiVedFreight, { ok: true }>): string[] {
  return [routeWords(f), f.bandText, `Yo‘lkira: ≈ ${money(f.listUsd)}`, ...(f.small ? [SMALL_ROAD_LINE] : [])];
}

/** The chip beside a baza — the legend below spells each one out. */
const SOURCE_MARK: Record<Exclude<BazaSource, null>, string> = {
  memory: '🧠',
  import: '📥',
  dictionary: '📖',
  typed: '',
};

const SOURCE_LEGEND: Record<Exclude<BazaSource, null>, string> = {
  memory: '🧠 avvalgi muhrdan',
  // The VED's screen calls the same baza «importdan (taxmin)»: a declaration
  // the machine (or a person) chose from the file and nobody has ✅ed yet —
  // while it sits under «Aniq» here (review product-fit-9).
  import: '📥 bojxona faylidan tanlangan (VED tasdiqlaguncha taxmin)',
  dictionary: '📖 lug‘atdan',
  typed: '',
};

/** A row priced on an old baza, as the line says it — the screen's «eskirgan» chip. */
export const STALE_BAZA_WORDS = '⚠ eski baza';

/**
 * The 📊 mark and its legend. The shadow is written onto no row, so the VED's
 * table never prints it — it stands only in this text, the chat's copy and the
 * lenta's (his 2.4 c) — and the legend says what it is.
 */
const MEDIAN_MARK = '📊';
const MEDIAN_LEGEND = '📊 deklaratsiyalar medianasi (taxminiy)';

/**
 * A product name as a PHONE can read it.
 *
 * Measured on the round's own integration fixture: a real invoice
 * description is 300 characters and carries its own newlines, so the reply
 * printed «1. Нетканый материал…\n…2516 кг» and the NEXT line's number
 * appeared to belong to it. The list stopped being a list. A name is
 * collapsed to one line and cut at 60 characters with an ellipsis — the full
 * text is on the card, which the link goes to.
 */
const NAME_CAP = 60;
function shortName(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length <= NAME_CAP ? flat : `${flat.slice(0, NAME_CAP - 1)}…`;
}

/** «23», «23 va 8», «23, 8 va 5», then «23, 8, 5 …» — at most three numbers. */
function countList(ns: number[]): string {
  if (ns.length <= 1) return String(ns[0] ?? 0);
  if (ns.length > 3) return `${ns.slice(0, 3).join(', ')} …`;
  return `${ns.slice(0, -1).join(', ')} va ${ns[ns.length - 1]}`;
}

/**
 * The measure part, with the brutto mark (⭐ of his Question 4) where a
 * priced row's weight was copied from the shipment's total — or the netto
 * mark where that total was itself netto (PF-3): the row note says it to the
 * VED, this says it to the seller, who reads the figure.
 */
function measureWithMark(measureText: string | null, fromTotal: TotalWeightBasis | null): string | null {
  if (fromTotal === null) return measureText;
  const mark = `(og‘irlik ${fromTotal}dan)`;
  if (!measureText) return mark;
  const at = measureText.indexOf(' × ');
  // Beside the measure only when the measure IS kilos (review REG-4): a copy
  // that priced through the LAW (a per-kg duty half) under a per-dona baza is
  // said after the shorthand, never between the count and its price.
  const quantity = at === -1 ? measureText : measureText.slice(0, at);
  if (!/^[\d.]+ kg$/.test(quantity)) return `${measureText} · og‘irlik ${fromTotal}dan`;
  return at === -1 ? `${measureText} ${mark}` : `${quantity} ${mark}${measureText.slice(at)}`;
}

/** The law's parts of a priced line: «boj 10% · QQS 12%». */
function lawParts(line: AiVedLine): string {
  const parts = [`boj ${line.dutyText}`];
  if (line.addDutyPct > 0) parts.push(`qo‘shimcha boj ${line.addDutyPct}% (sertifikat yo‘q)`);
  if (line.exciseText) parts.push(line.exciseText);
  if (line.vatPct !== null) parts.push(`QQS ${line.vatPct}%`);
  return parts.join(' · ');
}

/** One group, as two (or three) lines: what it is, and what the law makes of it. */
function lineText(line: AiVedLine, index: number): string {
  const est = line.estimated;
  const priced = est?.priced ? est : null;
  const measure = measureWithMark(priced ? priced.measureText : line.measureText, line.weightFromTotal);
  const marks = [line.bazaSource && SOURCE_MARK[line.bazaSource] ? SOURCE_MARK[line.bazaSource] : '']
    .concat(priced ? [MEDIAN_MARK] : [])
    .filter(Boolean)
    .join(' ');
  // The age sits beside the baza it qualifies — in the head, which every
  // shape of the line prints (exact, estimated, refused).
  const head =
    `${index + 1}. ${shortName(line.label)}` +
    (line.code ? ` · ${line.code}` : '') +
    (measure ? ` · ${measure}` : '') +
    (marks ? ` ${marks}` : '') +
    (line.staleBaza ? ` · ${STALE_BAZA_WORDS}` : '');

  if (priced) {
    // His 2.1 b: «taxminiy, N ta deklaratsiyadan» — on the figure itself, so
    // a forwarded line cannot lose it.
    const from = priced.declarations.length > 1 ? 'taxminiy:' : 'taxminiy,';
    const old = priced.oldFileEnd ? ` · eski fayl, ${priced.oldFileEnd} gacha` : '';
    return (
      `${head}\n   ${lawParts(line)} → ≈ ${money(priced.customsUsd)} ` +
      `(${from} ${countList(priced.declarations)} ta deklaratsiyadan${old})`
    );
  }
  if (line.customsUsd === null) {
    // Law 6: a refusal is a sentence, and the line still exists — a seller
    // who cannot see the row cannot tell the customer what is missing.
    const refused = `${head}\n   ⚠️ ${line.refusal ?? 'hisoblanmadi'} ${CUSTOMS_TAIL_WORDS[line.refusalTail]}`;
    if (!est || est.priced || est.misses.length === 0) return refused;
    const shown = est.misses.slice(0, 3).join('; ');
    return `${refused}\n   ${MEDIAN_MARK} taxmin yo‘q: ${shown}${est.misses.length > 3 ? ' …' : ''}`;
  }
  return `${head}\n   ${lawParts(line)} → ${money(line.customsUsd)}`;
}

/** «(yig‘im 1.5 BHM ≈ $50.00 bilan)», or the override's own figure. */
function feeWords(fee: AiVedEstimate['taxminiyFee']): string {
  if (!fee) return '';
  return fee.bhm === null
    ? ` (yig‘im ≈ ${money(fee.usd)} bilan)`
    : ` (yig‘im ${fee.bhm} BHM ≈ ${money(fee.usd)} bilan)`;
}

/**
 * The VED's line on the card's copy (his 2.4 c): directly under the heading,
 * because a note can run to 25 group lines and the VED skimming the lenta
 * reads its first lines. Only when something in the reply IS an estimate —
 * a 📊 figure, a guessed zone, or a road priced on the lines' Σ for a cube
 * the request does not hold (`!exact`, the same condition that makes the
 * JAMI «taxminiy», so a note carrying «JAMI taxminiy» always wears the
 * estimate chip); a named partial «Aniq» says what it is on its own face.
 * P4's chip finds the note by `VED_ESTIMATE_MARK`.
 *
 * The button is named as the Uzbek screen labels it, with the Russian beside
 * it: the note is written once, in Uzbek, for a VED on either locale.
 */
function vedLine(anyMedian: boolean, guessedFrom: string | null, roadFromLines: boolean): string | null {
  const parts = [
    ...(anyMedian ? ['📊 baza deklaratsiyalar medianasidan (AI emas)'] : []),
    ...(guessedFrom !== null ? [`zona «${guessedFrom}»dan taxmin`] : []),
    ...(roadFromLines ? ['yo‘lkira hajmi qatorlardan — so‘rovda umumiy hajm yo‘q'] : []),
  ];
  if (parts.length === 0) return null;
  // Source-neutral (review product-fit-11): none of these three is the
  // model's — a median of declarations (which his 2.1 b chose OVER «AI o‘zi
  // taxmin qiladi»), a city read by a fixed rule, a Σ of the lines.
  return `${VED_ESTIMATE_MARK} bu taxminiy javob, rasmiy emas — ${parts.join(' · ')}. Muhrlashdan yoki «Bajarildi» (Готово) bosishdan oldin o‘zingiz tekshiring.`;
}

/**
 * Within Telegram's cap WITHOUT losing the end (§2.9).
 *
 * The head and the tail — the totals, the road, the JAMI, the caveat, the
 * legend, the link — are what the seller acts on and repeats; a trailing
 * `slice` cut exactly those off a long invoice and kept the lines. So the
 * LINE LIST shrinks, with «… va yana N ta qator», until the text fits, and a
 * slice is the last resort for a single head line longer than the cap.
 */
export function fitTelegram(head: string[], lines: string[], fixed: string[], tail: string[]): string {
  for (let k = Math.min(lines.length, MAX_REPLY_LINES); k >= 0; k -= 1) {
    const more = lines.length > k ? [`… va yana ${lines.length - k} ta qator`] : [];
    const text = [...head, ...lines.slice(0, k), ...more, ...fixed, ...tail].join('\n');
    if (text.length <= TELEGRAM_LIMIT) return text;
  }
  const text = [...head, ...fixed, ...tail].join('\n');
  return text.length <= TELEGRAM_LIMIT ? text : `${text.slice(0, TELEGRAM_LIMIT - 20)}\n… (qisqartirildi)`;
}

export function aiVedReplyText(input: AiVedReplyInput): string {
  const title = [
    input.freight
      ? `${AI_REPLY_HEAD} · taxminiy podklyuch (rastamojka + yo‘lkira)`
      : `${AI_REPLY_HEAD} · taxminiy rastamojka`,
  ]
    .concat(input.clientLabel ? [input.clientLabel] : [])
    .concat(input.cardLabel ? [input.cardLabel] : [])
    .join(' · ');

  const f = input.freight;
  const guessedFrom = f && f.ok && f.zoneGuessed ? (f.zoneReadFrom ?? '') : null;
  // A road that is not the screen's own figure, and not because of a guess:
  // the lines' Σ priced a cube the request does not hold.
  const roadFromLines = Boolean(f && f.ok && !f.exact && !f.zoneGuessed);
  const anyMedian = input.lines.some((l) => l.estimated?.priced === true);
  const head = [title];
  if (input.audience === 'lenta') {
    const ved = vedLine(anyMedian, guessedFrom, roadFromLines);
    if (ved) head.push(ved);
  }

  const lines = input.lines.map(lineText);

  const fixed: string[] = [];
  if (input.ungrouped.length > 0) {
    // Named, not counted: the seller can often supply the missing code or
    // say which of the three «sumka» rows this is.
    const names = input.ungrouped.slice(0, 5).map(shortName).join(', ');
    const more = input.ungrouped.length > 5 ? ` … (+${input.ungrouped.length - 5})` : '';
    fixed.push(`⚠️ Kod topilmadi: ${names}${more} — VED xodimi qo‘yadi`);
  }
  if (input.fee) {
    fixed.push(`Deklaratsiya yig‘imi (VMQ-55): ${input.fee.bhm} BHM ≈ ${money(input.fee.usd)}`);
  }

  const tail: string[] = ['━━━━━━━━━━━━'];
  // NO PARTIAL SUMS under the job's name (the kernel's rule, restated as a
  // belt here): a line the engine refused or a row nobody coded is part of
  // the declaration, so the single total is absent while either stands — a
  // caller that handed one in anyway still prints no figure.
  const blocked = input.lines.some((l) => l.customsUsd === null) || input.ungrouped.length > 0;
  const total = blocked ? null : input.totalUsd;
  const est = input.estimate;
  if (total !== null) {
    tail.push(`Rastamojka jami: ≈ ${money(total)}`);
  } else if (!est || (est.taxminiyUsd === null && (est.exactRows === 0 || est.exactRows === est.rows))) {
    // `exactRows === rows` with no Taxminiy: every row priced and only the
    // DECLARATION FEE refused (review law-money-8) — nothing was estimated,
    // so «Taxminiy: hisoblab bo‘lmadi» would report an estimate that failed.
    // Never a $0 and never a silence: the total is absent BECAUSE something
    // is, and the lines above already say which — or, when only the fee
    // refused, this line does.
    tail.push('Rastamojka jami: hozircha hisoblab bo‘lmadi.');
    if (!blocked && input.feeRefusal) tail.push(`⚠️ Bojxona yig‘imi: ${input.feeRefusal}`);
  } else {
    // His 2.2 b: two figures, each saying exactly what it is.
    tail.push('Rastamojka jami:');
    tail.push(
      est.exactRows > 0 && est.exactUsd !== null
        ? `  Aniq: ${money(est.exactUsd)} (${est.rows} tadan ${est.exactRows} qator, yig‘imsiz)`
        : `  Aniq: hali yo‘q (${est.rows} tadan 0 qator)`,
    );
    tail.push(
      est.taxminiyUsd !== null
        ? `  Taxminiy ≈ ${money(est.taxminiyUsd)}${feeWords(est.taxminiyFee)}`
        : `  Taxminiy: hisoblab bo‘lmadi${est.taxminiyBlock ? ` — ${est.taxminiyBlock}` : '.'}`,
    );
  }
  const taxminiy = total === null && est ? est.taxminiyUsd : null;

  if (f) {
    if (f.ok) {
      tail.push(...roadLines(f));
    } else {
      tail.push(roadRefusalLine(f));
    }
    // The sum only when BOTH halves are figures: half a price labelled
    // «jami» is the partial total law 6 forbids, one line lower. And when
    // either half is an estimate — the 📊 Taxminiy, a zone read off the
    // city, or a road on a cube the request does not hold — the sum says
    // «taxminiy» on its own face. The plain «JAMI» is the two figures the
    // VED's screen itself prints (§0.1(4)), so the road must be `exact`.
    if (f.ok && total !== null && f.exact && !f.zoneGuessed) {
      tail.push(`JAMI (rastamojka + yo‘lkira): ≈ ${money(total + f.listUsd)}`);
    } else if (f.ok && (total ?? taxminiy) !== null) {
      tail.push(`JAMI taxminiy (rastamojka + yo‘lkira): ≈ ${money((total ?? taxminiy)! + f.listUsd)}`);
    } else {
      tail.push('JAMI: hozircha hisoblab bo‘lmadi — yuqoridagi ⚠️ ni to‘ldiring.');
    }
  }
  tail.push('⚠️ Rasmiy emas — VED xodimi tasdiqlaydi.');
  const left = pickLeftLine(input.pickLeft);
  if (left) tail.push(left);

  tail.push(`📄 Sertifikat: ${input.hasCertificate ? 'bor' : 'yo‘q'} (deb hisoblandi)`);
  if (!input.aiConfigured) tail.push('AI sozlanmagan — faqat yozilganidan o‘qildi.');
  else if (input.budgetSpent) {
    tail.push('AI kunlik limiti tugadi — muhrlangan xotira va bojxona faylidan hisoblandi.');
  }

  // The legend names only what was actually used — a key to marks nobody can
  // see is noise on a phone.
  const used = [...new Set(input.lines.map((l) => l.bazaSource))]
    .filter((s): s is Exclude<BazaSource, null> => s !== null && SOURCE_LEGEND[s] !== '')
    .map((s) => SOURCE_LEGEND[s]);
  if (input.lines.some((l) => l.estimated !== null)) used.push(MEDIAN_LEGEND);
  if (used.length > 0) tail.push(used.join(' · '));

  if (input.link) tail.push(`Karta: ${input.link}`);

  return fitTelegram(head, lines, fixed, tail);
}

/** Re-exported so a caller need not reach into the screen's own module. */
export { dutyText };
