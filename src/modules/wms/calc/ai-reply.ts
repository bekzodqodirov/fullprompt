import { dutyText } from './duty-text';
import { AI_CODE_MARK } from './code-source';
import { fitTelegram, MAX_REPLY_LINES, TELEGRAM_LIMIT } from './fit-telegram';
import { SMALL_FREIGHT_USD, type BazaSource } from './pricing';
import { AI_REPLY_HEAD, RERUN_WORD, VED_ESTIMATE_MARK } from './reply-heads';
import { figureLabel, type TotalWeightBasis } from './intake';
import { needWhatUz, needWhyUz, type NeedUnit } from './needs';
import { askName, type LawAsk, type SellerAsk } from './law-asks';
import {
  CUSTOMS_TAIL_WORDS,
  FREIGHT_TAIL_WORDS,
  SELLER_TAIL_NO_ASK,
  tailWords,
  type FreightTail,
  type ReplyAudience,
} from './tail-words';

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

// The cap's one home is fit-telegram.ts (K15); re-exported, so every reader
// of this module keeps its import.
export { fitTelegram, MAX_REPLY_LINES, TELEGRAM_LIMIT };
// …and the tails' one home is tail-words.ts (docs/IKKI-ESHIK.md §3.5), for the
// same reason.
export { CUSTOMS_TAIL_WORDS, FREIGHT_TAIL_WORDS, SELLER_TAIL_NO_ASK, tailWords };
export type { FreightTail, ReplyAudience };

// A group's code the model proposed while reading (§3.1, P13), as the line
// prints it — «· 6403990000 (AI taklifi)», the table's own mark — so a code
// nobody has checked never reads like one the file stated. Its home is
// code-source.ts, beside the item note it stands for; re-exported here.
export { AI_CODE_MARK };

export interface AiVedLine {
  /**
   * The group's rows by their own `seq` — the number the add table, the VED's
   * screen and every answer address a row by (docs/AI-SORAYDI.md §3.4 A3).
   * The line OPENS with them («3. Куртка…», «1-2. Посуда, Чашки»): numbered
   * by the group's index, the answer's «2.» was another row's «2:» and the
   * seller's reply overwrote it (PA-3, 10 → 300 dona). REQUIRED (#790): a
   * builder that forgot would number the line by nothing.
   */
  seqs: number[];
  /** What the group is, in the seller's words — its items, joined. */
  label: string;
  code: string | null;
  /**
   * The code is the model's READING-time proposal (`AI_CODE_NOTE` on an item
   * of the group, docs/IKKI-ESHIK.md §3.1): printed «(AI taklifi)» beside it.
   * REQUIRED (#790) — a builder that forgot would pass an unchecked code off
   * as the file's.
   */
  aiCode: boolean;
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

/** A row nobody has coded, by its own number (A3) — the line it is listed on. */
export interface UncodedRow {
  seq: number;
  name: string;
}

/**
 * What a coding call that did not answer leaves — said as it is (review
 * JS-15): the request is in the VED's queue and the VED will code it. No
 * «🔄 qayta urinib ko‘ring»: the answer carries no button that would, and an
 * emoji that reads as one is an instruction nothing obeys.
 */
export const CODING_FAILED_LINE = '⚠️ AI kod qo‘ya olmadi (javob bermadi) — so‘rov VED navbatida, kodni VED xodimi qo‘yadi';

/** How an uncoded row's line ends when nothing else on the answer says who codes it. */
export const UNCODED_WORDS = 'kod yo‘q';

export interface AiVedReplyInput {
  clientLabel: string | null;
  /** The card's own code — «B-000067» — so the seller can find it. */
  cardLabel: string | null;
  lines: AiVedLine[];
  /**
   * Items nobody has coded: named, because a total that silently drops them
   * is the defect the partial label exists to prevent — and listed IN THEIR
   * PLACE among the lines by their `seq` («2. Zapchast XJ-200 — kod yo‘q»,
   * A3), never in a list of names under them that no answer can address.
   */
  ungrouped: UncodedRow[];
  /**
   * The pass's coding call failed — the model did not answer (a timeout, a
   * refusal, a cut), even after its one retry (docs/AI-SORAYDI.md §3.4 A6,
   * review JS-15). The uncoded rows are then said as what is TRUE: the AI
   * could not code them and the VED will — never «Kod topilmadi: Куртка
   * мужская зимняя» about a jacket the model never looked at. REQUIRED (#790).
   */
  proposeFailed: boolean;
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
  /**
   * His 2.8 b (docs/SAKKIZ-R3.md §2.5): the figures the LAW pins that the
   * rows still lack — asked of the seller in the chat, named for the VED on
   * the lenta. REQUIRED-nullable (#790): null when it was not asked (a person
   * has written since the machine, the pass was overtaken), [] when nothing
   * is owed. On a `noAsk` rendering the same rows are the VED's to get
   * («⚠️ VED uchun:» on the lenta).
   */
  asks: LawAsk[] | null;
  /**
   * The AI door's ONE list (docs/AI-SORAYDI.md §3.4 A2, review JR-13):
   * everything the seller can give — the law's unit, a row with no figure,
   * an uncoded row, the reading's own question, the road's totals
   * (`sellerAsksOf`). Non-null REPLACES `asks` as what the answer asks: the
   * chat's «❓ AI so‘raydi» block and the lenta's «❓ Sotuvchidan so‘raldi»
   * line are built from it alone. REQUIRED-nullable (#790): null on every
   * other door, and on the AI door's rendering for a seller whose copy
   * reached nobody (`noAsk`).
   */
  sellerAsks: SellerAsk[] | null;
  /** The landing's pass, or the re-run after a seller's addition — whose
   * heading says «qayta hisob» (§2.5). REQUIRED (#790). */
  pass: 'landing' | 'amend';
  /** Who reads THIS rendering — the seller's chat, or the card's lenta, which
   * carries the VED's own line under its heading (§2.6). */
  audience: ReplyAudience;
  /**
   * Nobody asks the seller (docs/IKKI-ESHIK.md §3.5): no ❓ block, the
   * seller's tails say the VED will ask him (`tailWords`), the JAMI that
   * cannot be made is the VED's to make, and the lenta names the same gaps
   * under «⚠️ VED uchun:». Since docs/AI-SORAYDI.md §3.4 A1 (review JR-13)
   * that is the plain door's alone — and the AI door's card copy when the
   * seller's own copy reached nobody (`lentaUnasked`): the AI door ASKS
   * again, with the NULL door's tails. False — the AI door, a request from
   * before the doors (NULL), the card form, the thread, the agent — keeps the
   * asking words. REQUIRED (#790).
   */
  noAsk: boolean;
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
      /**
       * Not priced because a seller's addition left a total the road needs
       * behind (law-money-1, docs/SAKKIZ-R3.md §10.2.9) — said in its own
       * words (`ROAD_STALE_LINE`), never a figure on the stale column.
       */
      stale?: boolean;
    };

/** Why a re-run's road is not priced (law-money-1) — the line below says it whole. */
export const ROAD_STALE_WORDS = 'qo‘shimchadan keyin umumiy hajm/og‘irlik yangilanmagan';
/** The road's line after an addition that left its totals behind (§2.5). */
export const ROAD_STALE_LINE = `🚚 Yo‘lkira: ${ROAD_STALE_WORDS} — yo‘lkirani VED hisoblaydi.`;

/** The tiny-invoice warning (law 8: priced honestly, flagged loudly). */
export const SMALL_ROAD_LINE = `⚠️ Juda kichik yuk (yo‘lkira $${SMALL_FREIGHT_USD} dan kam) — VED ko‘rib chiqadi.`;

export const money = (n: number) => `$${n.toFixed(2)}`;

/** The customs half of a request with no goods (zero-03) — the chat's, the lenta's and the VED's note alike. */
export const NO_GOODS_CUSTOMS = 'Rastamojka: so‘rovda tovar yo‘q — hisoblanadigan narsa yo‘q (VED xodimi so‘raydi).';

/** The road's route as printed — with the guess said, in what was read. */
export function routeWords(f: Extract<AiVedFreight, { ok: true }>): string {
  return f.zoneGuessed ? `${f.routeLabel} — zona «${f.zoneReadFrom ?? ''}»dan taxmin` : f.routeLabel;
}

/** A refused road — the words and who fixes them, and the seller's own gap
 * on a line of its own when the refusal is the VED's (PF-5). In the
 * reader's words (`audience`): the tails differ between the chat and the
 * lenta — and where nobody asks him (`noAsk`, §3.5) the seller's tail says
 * the VED will ask him, in all four of the seller's cases alike. */
export function roadRefusalLine(
  f: Extract<AiVedFreight, { ok: false }>,
  audience: ReplyAudience,
  noAsk: boolean,
): string {
  if (f.stale) return ROAD_STALE_LINE;
  const first = `Yo‘lkira: ⚠️ ${f.refusal} ${tailWords(FREIGHT_TAIL_WORDS, f.tail, audience, noAsk)}`;
  return f.also ? `${first}\n⚠️ ${f.also.refusal} ${tailWords(FREIGHT_TAIL_WORDS, f.also.tail, audience, noAsk)}` : first;
}

/**
 * The gaps a request nobody asks the seller about leaves for the VED (the
 * plain door's note, the AI door's card copy for a seller nobody reached —
 * docs/IKKI-ESHIK.md §3.5), in ONE line under the lenta's heading — where
 * `lawAsksLentaLine` told him what the seller had been asked, this tells him
 * what is his to get: each row the LAW still wants a figure for (the 2.8 b
 * block's own rows, not asked of the seller here), and the road's facts only
 * the customer has. Null when
 * there are none. Capped like the old line: it sits in the head the fit
 * never cuts (review p5-adv-5).
 *
 * The LAW's figures and the road's facts, and nothing else (review
 * PP-SPEC-4, stated): a group the engine refused for a measure the law does
 * not pin is the seller's fact too, and it is said on that GROUP's own line
 * with its tail — the refusal names the row — not here, where it would name a
 * law-pinned row a second time.
 */
export function vedGapsLine(asks: readonly LawAsk[], freight: AiVedFreight | null): string | null {
  const parts = asks
    .slice(0, LAW_ASKS_NAMED)
    .map((a) => `${a.seq}-qator «${shortName(a.name)}»: ${a.needs.map((n) => needWhatUz(n.unit)).join(', ')}`);
  if (asks.length > LAW_ASKS_NAMED) parts.push(`yana ${asks.length - LAW_ASKS_NAMED} ta qator`);
  if (freight && !freight.ok && !freight.stale) {
    if (freight.tail === 'seller') parts.push(freight.refusal);
    if (freight.also) parts.push(freight.also.refusal);
  }
  return parts.length === 0 ? null : `⚠️ VED uchun: ${parts.join('; ')}.`;
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
 * text is on the card, which the link goes to. ONE cap for the group lines
 * and the ❓ block: `askName` (law-asks.ts), where the AI door's asks are
 * worded.
 */
function shortName(raw: string): string {
  return askName(raw);
}

/** At most this many pieces of a line's number — the rest are counted. */
const HEAD_RUNS = 5;

/**
 * The number a line OPENS with (docs/AI-SORAYDI.md §3.4 A3): its rows' own
 * `seq`s, the number every answer is addressed by — «3.», «1-2.» for a run,
 * «1, 3.» apart. Never the group's index: the seller answered «2: 300 dona»
 * to what he read as line 2 and another row's count was overwritten (PA-3).
 * Past HEAD_RUNS pieces the rest are COUNTED («(+4)») — never folded into a
 * range over a gap, which would name a row that is not in the group. A group
 * of no rows (`group_empty`) has nothing to address: «·».
 *
 * Exported: the plain door's note numbers its groups the same way (ai-note.ts).
 */
export function lineNumber(seqs: readonly number[]): string {
  const sorted = [...new Set(seqs)].sort((a, b) => a - b);
  if (sorted.length === 0) return '·';
  const runs: [number, number][] = [];
  for (const s of sorted) {
    const last = runs[runs.length - 1];
    if (last && s === last[1] + 1) last[1] = s;
    else runs.push([s, s]);
  }
  const piece = ([a, b]: [number, number]) => (a === b ? String(a) : `${a}-${b}`);
  const shown = runs.slice(0, HEAD_RUNS).map(piece).join(', ');
  const rest = runs.slice(HEAD_RUNS).reduce((n, [a, b]) => n + b - a + 1, 0);
  return rest > 0 ? `${shown} (+${rest}).` : `${shown}.`;
}

/** The first row a line names — the order the answer lists its lines in (A3). */
const firstSeq = (seqs: readonly number[]) => seqs.reduce((m, s) => Math.min(m, s), Number.POSITIVE_INFINITY);

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

/** The law's parts of a priced line: «boj 10% · QQS 12%». Exported for the
 * plain door's note (`ai-note.ts`), which prints the law and never its figure. */
export function lawParts(line: Pick<AiVedLine, 'dutyText' | 'addDutyPct' | 'exciseText' | 'vatPct'>): string {
  const parts = [`boj ${line.dutyText}`];
  if (line.addDutyPct > 0) parts.push(`qo‘shimcha boj ${line.addDutyPct}% (sertifikat yo‘q)`);
  if (line.exciseText) parts.push(line.exciseText);
  if (line.vatPct !== null) parts.push(`QQS ${line.vatPct}%`);
  return parts.join(' · ');
}

/** One group, as two (or three) lines: what it is, and what the law makes of it. */
function lineText(line: AiVedLine, audience: ReplyAudience, noAsk: boolean): string {
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
    `${lineNumber(line.seqs)} ${shortName(line.label)}` +
    (line.code ? ` · ${line.code}${line.aiCode ? ` ${AI_CODE_MARK}` : ''}` : '') +
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
    const refused = `${head}\n   ⚠️ ${line.refusal ?? 'hisoblanmadi'} ${tailWords(CUSTOMS_TAIL_WORDS, line.refusalTail, audience, noAsk)}`;
    if (!est || est.priced || est.misses.length === 0) return refused;
    const shown = est.misses.slice(0, 3).join('; ');
    return `${refused}\n   ${MEDIAN_MARK} taxmin yo‘q: ${shown}${est.misses.length > 3 ? ' …' : ''}`;
  }
  return `${head}\n   ${lawParts(line)} → ${money(line.customsUsd)}`;
}

/**
 * A row nobody coded, on its own line in its place (A3): «2. Zapchast XJ-200
 * — kod yo‘q». Who codes it is said once, where it is true: the ❓ block
 * below when the answer asks the seller what the row is (A2), the coding
 * call's own line when the model did not answer (A6) — else here, the VED,
 * as the old list under the lines said it.
 */
function uncodedLine(row: UncodedRow, askedWhat: boolean, proposeFailed: boolean): string {
  const tail = askedWhat || proposeFailed ? '' : ' — VED xodimi qo‘yadi';
  return `${lineNumber([row.seq])} ${shortName(row.name)} — ${UNCODED_WORDS}${tail}`;
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

export function aiVedReplyText(input: AiVedReplyInput): string {
  const title = [
    input.freight
      ? `${AI_REPLY_HEAD} · taxminiy podklyuch (rastamojka + yo‘lkira)`
      : `${AI_REPLY_HEAD} · taxminiy rastamojka`,
  ]
    // A re-run after a seller's addition says so AFTER the title phrase, so
    // the heading still starts with AI_REPLY_HEAD and the lenta's chip reads
    // it unchanged (feed.ts, PF-9).
    .concat(input.pass === 'amend' ? [RERUN_WORD] : [])
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
  const asks = input.asks ?? [];
  // The AI door's list, when this rendering asks it (A2) — it replaces the
  // law's (review JR-13: one list per door).
  const seller = input.noAsk ? null : (input.sellerAsks ?? null);
  if (input.audience === 'lenta') {
    const ved = vedLine(anyMedian, guessedFrom, roadFromLines);
    if (ved) head.push(ved);
    // The VED skimming the lenta reads its first lines: what the seller was
    // asked goes there, in one line (§2.5) — or, where nobody asks him
    // (docs/IKKI-ESHIK.md §3.5), the same gaps as the VED's to get.
    if (input.noAsk) {
      const gaps = vedGapsLine(asks, f);
      if (gaps) head.push(gaps);
    } else if (seller !== null) {
      if (seller.length > 0) head.push(sellerAsksLentaLine(seller));
    } else if (asks.length > 0) head.push(lawAsksLentaLine(asks));
  }

  // ONE numbering in the whole message (A3): every line opens with its rows'
  // own numbers, an uncoded row stands IN ITS PLACE among them — not under
  // the list by name, where no «2: …» could reach it — and the lines are in
  // row order, as the add table and the VED's screen list them.
  const askedWhat = new Set((seller ?? []).filter((a) => a.kind === 'what' && a.seq !== null).map((a) => a.seq!));
  const uncoded = input.ungrouped.map((row) => ({ row, text: uncodedLine(row, askedWhat.has(row.seq), input.proposeFailed) }));
  const lines = [
    ...input.lines.map((line) => ({ at: firstSeq(line.seqs), text: lineText(line, input.audience, input.noAsk) })),
    ...uncoded.map((u) => ({ at: u.row.seq, text: u.text })),
  ]
    .sort((a, b) => a.at - b.at)
    .map((e) => e.text);

  const fixed: string[] = [];
  // A coding call that did not answer says so, once (A6) — the rows above
  // then say only «kod yo‘q», and who codes them is this line's.
  if (input.ungrouped.length > 0 && input.proposeFailed) fixed.push(CODING_FAILED_LINE);
  if (input.fee) {
    fixed.push(`Deklaratsiya yig‘imi (VMQ-55): ${input.fee.bhm} BHM ≈ ${money(input.fee.usd)}`);
  }
  // His 2.8 b — in `fixed`, which the fit never cuts: on a 40-line invoice
  // the group lines shrink and the question the seller must answer stays.
  // The AI door asks again after «Tasdiqlash» (docs/AI-SORAYDI.md §3.4 A1,
  // his 4a of 2026-11-11 reversing IKKI-ESHIK's 5a for that door): its own
  // block, capped on the UNION of what it asks (review JS-25). Never where
  // nobody asks (`noAsk` — the plain door).
  if (input.audience === 'chat' && !input.noAsk) {
    if (seller !== null) {
      if (seller.length > 0) fixed.push(...sellerAsksBlock(seller));
    } else if (asks.length > 0) fixed.push(...lawAsksBlock(asks));
  }

  const tail: string[] = ['━━━━━━━━━━━━'];
  // NO PARTIAL SUMS under the job's name (the kernel's rule, restated as a
  // belt here): a line the engine refused or a row nobody coded is part of
  // the declaration, so the single total is absent while either stands — a
  // caller that handed one in anyway still prints no figure.
  // A request with NO goods (docs/FAYL-OQISH.md §1.3 c, zero-03): the
  // customs half has nothing to price, and «hozircha hisoblab bo‘lmadi» said
  // «the lines above say which» over no lines at all — nor is a sum of nothing
  // a «Rastamojka jami». Only a podklyuch should reach here so: its road is
  // priced from the totals; a rastamojka of no goods owes no pass
  // (`landingOwesPass`).
  const noGoods = input.lines.length === 0 && input.ungrouped.length === 0;
  const blocked = input.lines.some((l) => l.customsUsd === null) || input.ungrouped.length > 0;
  const total = blocked || noGoods ? null : input.totalUsd;
  const est = input.estimate;
  if (noGoods) {
    tail.push(NO_GOODS_CUSTOMS);
  } else if (total !== null) {
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
      tail.push(roadRefusalLine(f, input.audience, input.noAsk));
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
      // «…to‘ldiring» is a request to the seller; where nothing is asked of
      // him, the sum is the VED's to make (§3.5).
      tail.push(
        input.noAsk
          ? 'JAMI: hozircha hisoblab bo‘lmadi — VED xodimi hisoblaydi.'
          : 'JAMI: hozircha hisoblab bo‘lmadi — yuqoridagi ⚠️ ni to‘ldiring.',
      );
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

  const text = fitTelegram(head, lines, fixed, tail);
  // An uncoded row in its place can fall past the fit's cut on a long
  // invoice — the old list under the lines never did, it sat in `fixed`. So
  // when one whose coder is the VED (nobody asks the seller about it, the
  // model did not fail on it) was cut, every such row is named once more by
  // its number, where the fit never cuts. The ❓ block and the coding call's
  // line already name the others.
  const theVeds = uncoded.filter((u) => !askedWhat.has(u.row.seq) && !input.proposeFailed);
  const shown = new Set(text.split('\n'));
  if (!theVeds.some((u) => !shown.has(u.text))) return text;
  return fitTelegram(head, lines, [...fixed, `⚠️ Kod yo‘q: ${seqRanges(theVeds.map((u) => u.row.seq))}-qator — VED xodimi qo‘yadi`], tail);
}

/** At most this many rows are named in the 2.8 b block; the rest are counted. */
export const LAW_ASKS_NAMED = 8;

/** An example figure per unit, for the block's «✍️» line — the bot's
 * question's own examples (150 kg, 300 dona) and §2.5's «40 juft». */
const EXAMPLE_FIGURE: Record<NeedUnit, number> = {
  dona: 300,
  '1000_dona': 300,
  juft: 40,
  kg: 150,
  m2: 120,
  m3: 2,
  litr: 50,
  sm3: 1500,
};

/**
 * The 2.8 b block in the CHAT rendering (docs/SAKKIZ-R3.md §2.5): each asked
 * row by its `seq` — the number the add table and the VED's screen print,
 * so «3: 40 juft» typed from it lands on the row it names — with what the
 * law wants and why, in the kernel's own words (`needWhatUz`/`needWhyUz`).
 */
export function lawAsksBlock(asks: readonly LawAsk[]): string[] {
  const shown = asks.slice(0, LAW_ASKS_NAMED).map(
    (a) => `· ${a.seq}-qator «${shortName(a.name)}»: ${a.needs.map((n) => `${needWhatUz(n.unit)} — ${needWhyUz(n)}`).join('; ')}`,
  );
  if (asks.length > LAW_ASKS_NAMED) shown.push(`· … yana ${asks.length - LAW_ASKS_NAMED} ta qator — «➕» jadvalida`);
  // A 1000-dona floor is answered in pieces: the law divides.
  const example = asks
    .slice(0, 2)
    .map((a) => {
      const unit = a.needs[0]!.unit === '1000_dona' ? 'dona' : a.needs[0]!.unit;
      return `${a.seq}: ${figureLabel(EXAMPLE_FIGURE[unit], unit)}`;
    })
    .join('; ');
  return [
    '❓ Hisob to‘liq bo‘lishi uchun o‘lchov kerak — qonun shuni so‘raydi:',
    ...shown,
    `✍️ Shu xabarga reply qilib yozing: «${example}» — yoki «➕ Shu so‘rovga qo‘shish» ni bosing.`,
  ];
}

/** The AI door's block head (review JS-25): it asks more than the law's unit now. */
export const SELLER_ASKS_HEAD = '❓ AI so‘raydi — javob yozsangiz qayta hisoblaydi:';

/** More than this many uncoded rows fold into ONE line (review JS-25). */
export const WHAT_FOLD_AFTER = 3;
/** …the folded line's words, after its row numbers. */
export const WHAT_FOLD = 'nima tovar ekanini yozing (nimadan, nima uchun)';

/**
 * The order the block NAMES its asks in, and so the order the cap cuts in
 * (review JS-25): a row with no figure at all first — nothing prices it —
 * then the law's unit, the uncoded rows, the reading's own questions, the
 * shipment's totals. The certificate is never asked (JR-8).
 */
const ASK_RANK: readonly SellerAsk['kind'][] = ['measure', 'law', 'what', 'ai', 'total', 'certificate'];

/**
 * «2, 5-9, 12» — a run of consecutive rows written as its ends, at most ten
 * pieces and then «…»: the fold exists to keep forty uncoded rows to one line,
 * and a list of forty scattered numbers would be the forty lines again.
 */
function seqRanges(seqs: readonly number[]): string {
  const sorted = [...new Set(seqs)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j += 1;
    runs.push(j === i ? String(sorted[i]) : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return runs.length <= 10 ? runs.join(', ') : `${runs.slice(0, 10).join(', ')}, …`;
}

/** The totals' examples are the add table's own (`answerHow`): what «jami …» it reads. */
const TOTAL_EXAMPLE: Partial<Record<NeedUnit, string>> = { kg: 'jami 3500 kg', m3: 'jami 12 kub' };

/** One ask as the ✍️ line's example: a figure for a figure, words for words. */
function askExample(a: SellerAsk): string | null {
  const unit = a.needs[0];
  if (a.kind === 'total') return unit ? (TOTAL_EXAMPLE[unit] ?? null) : null;
  if (a.seq === null) return null;
  // A 1000-dona floor is answered in pieces: the law divides.
  if (unit) return `${a.seq}: ${figureLabel(EXAMPLE_FIGURE[unit === '1000_dona' ? 'dona' : unit], unit === '1000_dona' ? 'dona' : unit)}`;
  return a.kind === 'what' ? `${a.seq}: metall, tormoz kolodkasi` : null;
}

/**
 * The AI door's block in the CHAT rendering (docs/AI-SORAYDI.md §3.4 A2;
 * review JS-25): ONE head, then at most LAW_ASKS_NAMED lines in `ASK_RANK`'s
 * order — more than three uncoded rows folded into one «2, 5-9-qator: …» —
 * then the count of the rest, then how to answer. It sits in `fixed`, which
 * the fit never cuts, so the cap is on the UNION: forty uncoded rows asked
 * one line each pushed «Rastamojka jami», the caveat and this very ✍️ line
 * off the end of the message.
 *
 * The example is a FIGURE where one is asked — the add table writes a
 * figure into the row it names — and words only when nothing but words is.
 */
export function sellerAsksBlock(asks: readonly SellerAsk[]): string[] {
  const ranked = ASK_RANK.flatMap((kind) => asks.filter((a) => a.kind === kind));
  const what = ranked.filter((a) => a.kind === 'what' && a.seq !== null);
  const fold = what.length > WHAT_FOLD_AFTER;
  const entries: { line: string; count: number }[] = [];
  for (const a of ranked) {
    if (fold && a.kind === 'what' && a.seq !== null) {
      if (a === what[0]) entries.push({ line: `${seqRanges(what.map((w) => w.seq!))}-qator: ${WHAT_FOLD}`, count: what.length });
      continue;
    }
    entries.push({ line: a.text, count: 1 });
  }
  const shown = entries.slice(0, LAW_ASKS_NAMED).map((e) => `· ${e.line}`);
  const hidden = entries.slice(LAW_ASKS_NAMED).reduce((n, e) => n + e.count, 0);
  if (hidden > 0) shown.push(`· … yana ${hidden} ta — «➕» jadvalida`);
  const figures = ranked.filter((a) => a.needs.length > 0).map(askExample).filter((e): e is string => e !== null);
  const examples = figures.length > 0 ? figures.slice(0, 2) : ranked.map(askExample).filter((e): e is string => e !== null).slice(0, 1);
  const how = examples.length > 0 ? `yozing: «${examples.join('; ')}»` : 'javobni yozing';
  return [SELLER_ASKS_HEAD, ...shown, `✍️ Shu xabarga reply qilib ${how} — yoki «➕ Shu so‘rovga qo‘shish» ni bosing.`];
}

/**
 * …and the AI door's line on the LENTA instead (A2): the rows asked, by
 * number, and the shipment's totals — capped like the block, because the
 * head is never cut (review p5-adv-5).
 */
export function sellerAsksLentaLine(asks: readonly SellerAsk[]): string {
  const seqs = asks.filter((a) => a.seq !== null).map((a) => a.seq!);
  const parts = [
    ...(seqs.length > 0 ? [`${seqRanges(seqs)}-qator`] : []),
    ...asks.filter((a) => a.kind === 'total').map((a) => (a.needs[0] === 'kg' ? 'umumiy brutto' : 'umumiy hajm')),
  ];
  return `❓ Sotuvchidan so‘raldi: ${parts.join('; ')}.`;
}

/** …and the one line the LENTA carries under its heading instead (§2.5) —
 * capped like the chat block: it sits in the head `fitTelegram` never cuts,
 * so 900 asked rows would push the groups and the totals off the card's copy
 * (review p5-adv-5). The rows past the cap are on the VED's own screen. */
export function lawAsksLentaLine(asks: readonly LawAsk[]): string {
  return `❓ Sotuvchidan so‘raldi: ${asks.slice(0, LAW_ASKS_NAMED).map((a) => a.seq).join(', ')}${asks.length > LAW_ASKS_NAMED ? ', …' : ''}-qator o‘lchovi (qonun so‘raydi).`;
}

/** Re-exported so a caller need not reach into the screen's own module. */
export { dutyText };
