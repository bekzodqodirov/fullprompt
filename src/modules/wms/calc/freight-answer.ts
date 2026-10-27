import type { AiVedFreight, FreightTail } from './ai-reply';
import { freightFor, type FreightBand, type FreightResult } from './pricing';
import { freightRefusalText } from './prefill-reply';
import { linesVolumeM3 } from './line-totals';
import { guessZone } from './zone-guess';

/**
 * The road as the machine's reply prints it (docs/SAKKIZ-R2.md K4, §6.4).
 *
 * `ZONE_ROUTE` and `aiFreight` moved here out of `prefill.ts`, and
 * `freightAnswerFor` is the ONE function that decides what a reply says about
 * freight — the stored zone or a guessed one, the request's m³ or the lines'
 * Σ, and who can fix a refusal — so the podklyuch reply and the yolkira
 * tariff reply cannot say two different things about one road (#513).
 */

/**
 * Where each of his zones starts, as a seller reads it — the one home of the
 * origin's name, so the route line and the «no price yet» refusal spell it
 * the same way.
 */
const ZONE_ORIGIN: Record<string, string> = {
  cn: 'Xitoy',
  kashgar: 'Qashg‘ar',
  horgos: 'Horgos',
};

/** The owner's zones, as a seller reads them — a new zone prints its code. */
export const ZONE_ROUTE: Record<string, string> = Object.fromEntries(
  Object.entries(ZONE_ORIGIN).map(([zone, origin]) => [zone, `${origin} → O‘zbekiston`]),
);

/** A city as the reply quotes it back — what was read, cut where a phone wraps. */
const READ_CAP = 40;
export function readCity(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length <= READ_CAP ? flat : `${flat.slice(0, READ_CAP - 1)}…`;
}

/**
 * Why the road could not be priced, one name per sentence (§2.5). The
 * engine's own refusals keep their words; the first six are the reply's own
 * pre-checks, which say WHAT is missing rather than the engine's «og‘irlik
 * yoki hajm yo‘q» — a seller cannot tell from that which of the two to ask.
 */
export type FreightRefusalCase =
  | 'no_city'
  | 'city_unplaced'
  | 'zone_unpriced'
  | 'kg_missing'
  | 'm3_missing'
  | 'both_missing'
  | 'band_missing'
  | 'band_ambiguous'
  | 'not_a_number';

/** What a sentence may need: the city as written, and the guessed zone. */
interface RefusalFacts {
  city: string;
  zone: string;
}

/**
 * The words, keyed on the union — a case with no sentence is a compile error
 * (#163's lesson for a code that reached the seller in Latin letters).
 */
export const FREIGHT_WORDS: Record<FreightRefusalCase, (f: RefusalFacts) => string> = {
  // «…qaysi shahardan EKANI yozilmagan» — «it is not written which city
  // (it comes) from»; without «ekani» the clause has no subject (review
  // product-fit-12).
  no_city: () => 'yo‘nalish (zona) tanlanmagan — qaysi shahardan ekani yozilmagan',
  city_unplaced: (f) => `yo‘nalish (zona) tanlanmagan — «${readCity(f.city)}»dan zona aniqlanmadi`,
  // A city we READ whose zone has no price is never «not understood»: the
  // seller would retype the city, and the price is the VED's to add.
  zone_unpriced: (f) => `«${ZONE_ORIGIN[f.zone] ?? f.zone}» → O‘zbekiston narxi tarifda hali yo‘q`,
  kg_missing: () => 'umumiy brutto og‘irlik (kg) yo‘q',
  m3_missing: () => 'umumiy hajm (m³) yo‘q',
  both_missing: () => 'umumiy hajm (m³) va brutto og‘irlik (kg) yo‘q',
  band_missing: () => freightRefusalText('band_missing'),
  band_ambiguous: () => freightRefusalText('band_ambiguous'),
  not_a_number: () => freightRefusalText('not_a_number'),
};

/**
 * WHO can fix it (§0.1(7)). A fact only the seller or the customer has — the
 * city, the brutto kilos, the cube — goes back to the seller, who can ask and
 * write it on the card's lenta; what the VED decides (a tariff hole, a stored
 * figure that is not a number) stays the VED's. Today's single «— VED xodimi
 * hisoblaydi» sent the seller to wait for a person who was waiting on him.
 *
 * A city WRITTEN but placed by no vocabulary («Foshan», his Question 3 a) is
 * the VED's: the customer has already said where the cargo leaves, and what
 * is missing is the ZONE, which only the VED chooses (`setFreightZone` is
 * `ved.docs`'s). Sent to the seller, the sentence had him ask the customer
 * for a fact the customer gave — and nothing re-answers after (`sayOnce`).
 */
export const FREIGHT_TAIL: Record<FreightRefusalCase, FreightTail> = {
  no_city: 'seller',
  city_unplaced: 'ved',
  zone_unpriced: 'ved',
  kg_missing: 'seller',
  m3_missing: 'seller',
  both_missing: 'seller',
  band_missing: 'ved',
  band_ambiguous: 'ved',
  not_a_number: 'ved',
};

const refusal = (c: FreightRefusalCase, facts: RefusalFacts): AiVedFreight => ({
  ok: false,
  refusal: FREIGHT_WORDS[c](facts),
  tail: FREIGHT_TAIL[c],
});

/**
 * Several of the SELLER's facts missing at once, said in one sentence.
 *
 * The reply goes out once per request (`sayOnce`) and nothing re-answers
 * after the seller writes on the lenta, so naming only the first gap —
 * «qaysi shahardan» — cost him a second trip to the customer for the kilos.
 * Only cases that share the seller's tail are joined: one sentence, one
 * fixer. A case the VED decides is said on its own, as before.
 */
const sellerRefusal = (cases: readonly FreightRefusalCase[], facts: RefusalFacts): AiVedFreight => ({
  ok: false,
  refusal: cases.map((c) => FREIGHT_WORDS[c](facts)).join('; '),
  tail: 'seller',
});

/**
 * The road as the AI reply prints it (item 13): the LIST price with the band
 * that made it, so «$1,920» arrives with «180 kg/m³ · $160/m³ × 12 m³» and a
 * seller can check it against the tariff sheet on the wall.
 *
 * `fromLines` labels the cube «(qatorlardan)» where it is printed (his 2.7 b):
 * a Σ of the lines is data, but a seller reading «12 m³» must know he did not
 * type it. A per-kg band prints no cube, so it carries no label.
 */
export function aiFreight(
  freight: FreightResult | null,
  measure: { weightKg: number | null; volumeM3: number | null },
  opts: { fromLines?: boolean; exact?: boolean } = {},
): AiVedFreight {
  if (!freight) return { ok: false, refusal: freightRefusalText('zone_required'), tail: 'ved' };
  if (!freight.ok) return { ok: false, refusal: freightRefusalText(freight.reason), tail: 'ved' };
  const b = freight.band;
  const qty = b.perKg ? measure.weightKg : measure.volumeM3;
  const per = `$${b.priceUsd}/${b.perKg ? 'kg' : 'm³'}`;
  const label = !b.perKg && opts.fromLines ? ' (qatorlardan)' : '';
  const times = qty === null ? per : `${per} × ${Number(qty.toFixed(3))} ${b.perKg ? 'kg' : 'm³'}${label}`;
  return {
    ok: true,
    listUsd: freight.listUsd,
    routeLabel: ZONE_ROUTE[b.zone] ?? b.zone,
    bandText: `${freight.bandDensity} kg/m³ · ${times}`,
    zoneGuessed: false,
    zoneReadFrom: null,
    volumeFromLines: opts.fromLines ?? false,
    // Closed by default: a caller that does not say it priced the screen's
    // own figure gets «JAMI taxminiy», never a plain «JAMI» it cannot vouch for.
    exact: opts.exact ?? false,
    small: freight.small,
  };
}

/** Everything the freight answer may read — the workspace's figures, named. */
export interface FreightAnswerInput {
  hasFreight: boolean;
  /** Stored on the request. */
  freightZone: string | null;
  /** `Workspace.guessedZone` — priced zones only. */
  guessedZone: string | null;
  fromCity: string | null;
  /** The request's (brutto). */
  weightKg: number | null;
  /** The request's. */
  volumeM3: number | null;
  /** `Workspace.volumeFromLines` (K13). */
  volumeFromLines: boolean;
  /** Every item, grouped or not. */
  lines: readonly { volumeM3: number | null }[];
  /** `Workspace.freight` — the stored zone and the request's totals. */
  stored: FreightResult | null;
}

const positive = (v: number | null): v is number => v !== null && v > 0;

/**
 * What the reply says about the road, or null on a job that has none.
 *
 * 1. The zone is the stored one, else the GUESS off the city (his 2.6 b and,
 *    by the ⭐ of his Question 2, on yolkira too). The guess prices the reply
 *    and nothing else: this file has no writer (`estimate-wire.test.ts`).
 * 2. The cube is the request's, else the Σ of the lines — all-or-nothing
 *    (`linesVolumeM3`). It is LABELLED when it came from the lines: K13's
 *    read-time provenance for a stored Σ, or the fallback here for a request
 *    landed before round 2 stored one.
 * 3. The kilos are the request's BRUTTO and NEVER the lines': a line's kg is
 *    netto, and a truck carries the cartons too (judge MR-8). Missing, it is
 *    asked of the seller, never summed.
 * 4. Every refusal names who can fix it (`FREIGHT_TAIL`); the seller's
 *    missing facts are named together (`sellerRefusal`).
 * 5. The answer is `exact` only when it IS the workspace's own road — the
 *    stored zone over the request's stored totals, the figure the VED's
 *    screen prints and the seal locks. A guessed zone, or the lines' Σ
 *    standing in for a cube the request does not hold, prices the reply's
 *    own estimate: the screen, the checklist chip and the seal all refuse
 *    that cube (review law-money-R2-1), so a sum with it is «JAMI taxminiy».
 *    The Σ fallback itself stays, labelled, for a request landed before
 *    round 2 stored one (§6.4 step 3).
 */
export function freightAnswerFor(
  input: FreightAnswerInput,
  tariff: readonly FreightBand[],
): AiVedFreight | null {
  if (!input.hasFreight) return null;

  const zone = input.freightZone ?? input.guessedZone;
  const zoneGuessed = input.freightZone === null && input.guessedZone !== null;
  const city = (input.fromCity ?? '').trim();
  const facts = { city, zone: '' };
  const m3 = input.volumeM3 ?? linesVolumeM3(input.lines);
  // A stored figure that is not a number is the VED's to correct, and must
  // not read as «missing» — that would send the seller to ask for it again.
  const notANumber = [input.weightKg, m3].some((v) => v !== null && !Number.isFinite(v));
  const kgOk = positive(input.weightKg);
  const m3Ok = positive(m3);
  // The measure's gap, as the seller is asked it — null when both are there.
  const measureGap: FreightRefusalCase | null = notANumber
    ? 'not_a_number'
    : !kgOk && !m3Ok
      ? 'both_missing'
      : !kgOk
        ? 'kg_missing'
        : !m3Ok
          ? 'm3_missing'
          : null;

  // Zone → kg → m³: the order a seller is asked in.
  if (zone === null) {
    if (!city) {
      // No city AND a missing measure: both are the customer's facts, said
      // in one sentence (`sellerRefusal`) — a stored figure that is not a
      // number is the VED's and waits behind the seller's question.
      return measureGap !== null && FREIGHT_TAIL[measureGap] === 'seller'
        ? sellerRefusal(['no_city', measureGap], facts)
        : refusal('no_city', facts);
    }
    const read = guessZone(city);
    // Read, but not priced: `guessedZone` is the priced zones only, so a
    // known city reaching here is a tariff hole, not a misunderstanding.
    const zoneRefusal = read !== null ? refusal('zone_unpriced', { city, zone: read }) : refusal('city_unplaced', facts);
    // Both are the VED's — and a missing brutto or cube is still the
    // SELLER's, said beside it with its own fixer (review PF-5): the reply
    // goes out once, so naming only the zone sent him back for the kilos
    // after the VED had chosen it.
    return measureGap !== null && FREIGHT_TAIL[measureGap] === 'seller' && !zoneRefusal.ok
      ? { ...zoneRefusal, also: { refusal: FREIGHT_WORDS[measureGap](facts), tail: 'seller' } }
      : zoneRefusal;
  }
  if (measureGap !== null) return refusal(measureGap, facts);

  const fromLines = input.volumeFromLines || (input.volumeM3 === null && m3 !== null);
  // The kernel's figure when nothing was guessed or summed — it IS
  // `freightFor` over these very inputs; otherwise priced here, on the bands.
  const priced =
    !zoneGuessed && input.volumeM3 !== null && input.stored
      ? input.stored
      : freightFor([...tariff], { zone, weightKg: input.weightKg, volumeM3: m3 });
  if (!priced.ok) {
    // Only the engine's own refusals can remain (the pre-checks took the
    // rest); a band hole or a figure that is not a number is the VED's.
    const c: FreightRefusalCase =
      priced.reason === 'band_missing' || priced.reason === 'band_ambiguous' ? priced.reason : 'not_a_number';
    return refusal(c, facts);
  }
  const out = aiFreight(priced, { weightKg: input.weightKg, volumeM3: m3 }, { fromLines, exact: priced === input.stored });
  return out.ok
    ? { ...out, zoneGuessed, zoneReadFrom: zoneGuessed && city ? readCity(city) : null }
    : out;
}
