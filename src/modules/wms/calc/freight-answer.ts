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
  no_city: () => 'yo‘nalish (zona) tanlanmagan — qaysi shahardan yozilmagan',
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
 */
export const FREIGHT_TAIL: Record<FreightRefusalCase, FreightTail> = {
  no_city: 'seller',
  city_unplaced: 'seller',
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
  opts: { fromLines?: boolean } = {},
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
 * 4. Every refusal names who can fix it (`FREIGHT_TAIL`).
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

  // Zone → kg → m³: the order a seller is asked in.
  if (zone === null) {
    if (!city) return refusal('no_city', facts);
    const read = guessZone(city);
    // Read, but not priced: `guessedZone` is the priced zones only, so a
    // known city reaching here is a tariff hole, not a misunderstanding.
    if (read !== null) return refusal('zone_unpriced', { city, zone: read });
    return refusal('city_unplaced', facts);
  }
  const m3 = input.volumeM3 ?? linesVolumeM3(input.lines);
  // A stored figure that is not a number is the VED's to correct, and must
  // not read as «missing» — that would send the seller to ask for it again.
  if ([input.weightKg, m3].some((v) => v !== null && !Number.isFinite(v))) return refusal('not_a_number', facts);
  const kgOk = positive(input.weightKg);
  const m3Ok = positive(m3);
  if (!kgOk && !m3Ok) return refusal('both_missing', facts);
  if (!kgOk) return refusal('kg_missing', facts);
  if (!m3Ok) return refusal('m3_missing', facts);

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
  const out = aiFreight(priced, { weightKg: input.weightKg, volumeM3: m3 }, { fromLines });
  return out.ok
    ? { ...out, zoneGuessed, zoneReadFrom: zoneGuessed && city ? readCity(city) : null }
    : out;
}
