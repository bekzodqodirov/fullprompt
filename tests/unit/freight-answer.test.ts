import { describe, expect, it } from 'vitest';
import {
  FREIGHT_TAIL,
  FREIGHT_WORDS,
  ZONE_ROUTE,
  freightAnswerFor,
  type FreightAnswerInput,
  type FreightRefusalCase,
} from '@/modules/wms/calc/freight-answer';
import { freightFor, type FreightBand } from '@/modules/wms/calc/pricing';
import { guessedZoneFor } from '@/modules/wms/calc/zone-guess';

/**
 * What the machine's reply says about the road (docs/SAKKIZ-R2.md §6.4) —
 * his 2.5 b (yolkira answered from the tariff), 2.6 b (the zone guessed from
 * the city, said as a guess) and 2.7 b (the cube summed from the lines, the
 * brutto kilos ASKED). Every literal is written by hand from the bands below.
 */
const TARIFF: FreightBand[] = [
  { zone: 'cn', minDensity: 1, maxDensity: 200, priceUsd: 160, perKg: false },
  { zone: 'cn', minDensity: 201, maxDensity: 400, priceUsd: 1.2, perKg: true },
  { zone: 'kashgar', minDensity: 1, maxDensity: 400, priceUsd: 70, perKg: false },
];
const priced = ['cn', 'kashgar'];

const input = (over: Partial<FreightAnswerInput> = {}): FreightAnswerInput => {
  const base: FreightAnswerInput = {
    hasFreight: true,
    freightZone: 'cn',
    guessedZone: null,
    fromCity: 'Yiwu',
    weightKg: 2160,
    volumeM3: 12,
    volumeFromLines: false,
    lines: [{ volumeM3: 12 }],
    stored: null,
    ...over,
  };
  return base;
};

describe('a road the seller can check against the tariff sheet', () => {
  it('a stored zone prices exactly as the engine does', () => {
    const stored = freightFor(TARIFF, { zone: 'cn', weightKg: 2160, volumeM3: 12 });
    const out = freightAnswerFor(input({ stored }), TARIFF);
    expect(stored.ok && out?.ok).toBe(true);
    // 2160 / 12 = 180 kg/m³ → the 1-200 band, $160 × 12 m³.
    expect(out).toEqual({
      ok: true,
      listUsd: 1920,
      routeLabel: 'Xitoy → O‘zbekiston',
      bandText: '180 kg/m³ · $160/m³ × 12 m³',
      zoneGuessed: false,
      zoneReadFrom: null,
      volumeFromLines: false,
      // The workspace's own figure, passed through — the one a plain «JAMI» may sum.
      exact: true,
      small: false,
    });
    expect(out!.ok && stored.ok && out!.listUsd).toBe(stored.ok ? stored.listUsd : NaN);
  });

  it('a job with no road says nothing about one', () => {
    expect(freightAnswerFor(input({ hasFreight: false }), TARIFF)).toBeNull();
  });

  it('no zone stored + «Yiwu» → priced on the guess, and the guess is said', () => {
    const out = freightAnswerFor(
      input({ freightZone: null, guessedZone: guessedZoneFor('Yiwu', priced), fromCity: 'Yiwu' }),
      TARIFF,
    );
    expect(out).toMatchObject({ ok: true, listUsd: 1920, zoneGuessed: true, zoneReadFrom: 'Yiwu', exact: false });
  });

  it('the city read back is cut where a phone wraps', () => {
    const city = `Yiwu, ${'Futian bozori '.repeat(6)}`;
    const out = freightAnswerFor(input({ freightZone: null, guessedZone: 'cn', fromCity: city }), TARIFF);
    expect(out!.ok && out!.zoneReadFrom!.length).toBe(40);
    expect(out!.ok && out!.zoneReadFrom!.endsWith('…')).toBe(true);
  });
});

describe('every refusal names what is missing and who can fix it (§2.5)', () => {
  const refusalOf = (over: Partial<FreightAnswerInput>) => {
    const out = freightAnswerFor(input(over), TARIFF);
    if (!out || out.ok) throw new Error(`expected a refusal, got ${JSON.stringify(out)}`);
    return out;
  };

  it('no zone and no city → the seller is asked where from', () => {
    expect(refusalOf({ freightZone: null, fromCity: null })).toEqual({
      ok: false,
      refusal: 'yo‘nalish (zona) tanlanmagan — qaysi shahardan yozilmagan',
      tail: 'seller',
    });
  });

  // Re-anchored (review PF-4): the customer has already said «Foshan» —
  // what is missing is the ZONE, and only the VED chooses one. Sending the
  // seller back for the city had him ask for a fact already given.
  it('a city no vocabulary places → named, and the VED chooses the zone', () => {
    expect(refusalOf({ freightZone: null, fromCity: 'Foshan' })).toEqual({
      ok: false,
      refusal: 'yo‘nalish (zona) tanlanmagan — «Foshan»dan zona aniqlanmadi',
      tail: 'ved',
    });
  });

  it('no city AND no kilos → both of the seller’s facts in ONE sentence (review PF-5)', () => {
    // The reply goes out once per request; naming the city alone cost the
    // seller a second trip to the customer for the kilos.
    expect(refusalOf({ freightZone: null, fromCity: null, weightKg: null })).toEqual({
      ok: false,
      refusal: 'yo‘nalish (zona) tanlanmagan — qaysi shahardan yozilmagan; umumiy brutto og‘irlik (kg) yo‘q',
      tail: 'seller',
    });
    // A VED-side gap is never joined to a seller sentence: one fixer per line.
    expect(refusalOf({ freightZone: null, fromCity: 'Foshan', weightKg: null })).toMatchObject({ tail: 'ved' });
  });

  it('a city we READ whose zone has no price is the VED’s hole, never «not understood»', () => {
    // The tariff prices cn and kashgar only — Horgos is guessable and not
    // priceable, so `guessedZone` (priced zones only) is null.
    const out = refusalOf({ freightZone: null, guessedZone: guessedZoneFor('Horgos', priced), fromCity: 'Horgos' });
    expect(out.refusal).toBe('«Horgos» → O‘zbekiston narxi tarifda hali yo‘q');
    expect(ZONE_ROUTE.horgos).toBe('Horgos → O‘zbekiston');
    expect(out.tail).toBe('ved');
    expect(out.refusal).not.toContain('aniqlanmadi');
  });

  it('m³ absent but every line states its own → the Σ prices it, labelled', () => {
    const out = freightAnswerFor(input({ volumeM3: null, lines: [{ volumeM3: 1.2 }, { volumeM3: 1.6 }], weightKg: 504 }), TARIFF);
    // Σ 2.8 m³, 504 / 2.8 = 180 kg/m³ → $160 × 2.8 = $448.
    expect(out).toMatchObject({
      ok: true,
      listUsd: 448,
      volumeFromLines: true,
      bandText: '180 kg/m³ · $160/m³ × 2.8 m³ (qatorlardan)',
    });
  });

  it('the lines’ Σ standing in for a cube the request does NOT hold is never `exact` (review law-money-R2-1)', () => {
    // The workspace's own road refuses this very request — no stored cube —
    // so the figure here is the reply's estimate, and a sum with it must say so.
    const stored = freightFor(TARIFF, { zone: 'cn', weightKg: 504, volumeM3: null });
    expect(stored.ok).toBe(false);
    const out = freightAnswerFor(
      input({ volumeM3: null, lines: [{ volumeM3: 1.2 }, { volumeM3: 1.6 }], weightKg: 504, stored }),
      TARIFF,
    );
    expect(out).toMatchObject({ ok: true, listUsd: 448, exact: false });
    // The Σ STORED at the INSERT (K13) is the screen's own figure: exact.
    const storedSum = freightFor(TARIFF, { zone: 'cn', weightKg: 504, volumeM3: 2.8 });
    expect(
      freightAnswerFor(input({ volumeM3: 2.8, volumeFromLines: true, weightKg: 504, stored: storedSum }), TARIFF),
    ).toMatchObject({ ok: true, listUsd: 448, exact: true, volumeFromLines: true });
  });

  it('m³ STORED but derived from the lines (K13) still carries the label', () => {
    // A request landed after round 2 stores the Σ at its INSERT, so «the
    // stored m³ is null» alone would never label it again.
    const out = freightAnswerFor(input({ volumeM3: 12, volumeFromLines: true }), TARIFF);
    expect(out).toMatchObject({ ok: true, volumeFromLines: true, bandText: '180 kg/m³ · $160/m³ × 12 m³ (qatorlardan)' });
  });

  it('one line without a cube → no Σ at all, and the seller asked for the total', () => {
    expect(refusalOf({ volumeM3: null, lines: [{ volumeM3: 1.2 }, { volumeM3: null }] })).toEqual({
      ok: false,
      refusal: 'umumiy hajm (m³) yo‘q',
      tail: 'seller',
    });
  });

  it('the kilos are the request’s BRUTTO — never summed from the lines', () => {
    // The lines carry kilos here; reading them would price the truck on the
    // netto weight of the goods (judge MR-8).
    const lines = [
      { volumeM3: 6, weightKg: 1000 },
      { volumeM3: 6, weightKg: 1160 },
    ];
    expect(refusalOf({ weightKg: null, lines })).toEqual({
      ok: false,
      refusal: 'umumiy brutto og‘irlik (kg) yo‘q',
      tail: 'seller',
    });
    expect(refusalOf({ weightKg: null, volumeM3: null, lines: [{ volumeM3: null }] }).refusal).toBe(
      'umumiy hajm (m³) va brutto og‘irlik (kg) yo‘q',
    );
  });

  it('a density the tariff has no band for is the VED’s', () => {
    // 6000 kg / 12 m³ = 500 kg/m³ — past every cn band.
    expect(refusalOf({ weightKg: 6000 })).toEqual({ ok: false, refusal: 'bu zichlikka tarif yo‘q', tail: 'ved' });
  });

  it('a stored figure that is not a number is the VED’s, never «missing»', () => {
    expect(refusalOf({ weightKg: Number.NaN })).toMatchObject({ refusal: 'raqam noto‘g‘ri', tail: 'ved' });
  });

  it('a very small load is priced and flagged', () => {
    // 36 kg / 0.2 m³ = 180 kg/m³ → $160 × 0.2 = $32, under the $50 line.
    expect(freightAnswerFor(input({ weightKg: 36, volumeM3: 0.2 }), TARIFF)).toMatchObject({ ok: true, listUsd: 32, small: true });
  });

  it('a per-kg band prints no cube, so it carries no label', () => {
    // 3600 kg / 12 m³ = 300 kg/m³ → $1.2/kg × 3600.
    const out = freightAnswerFor(input({ weightKg: 3600, volumeFromLines: true }), TARIFF);
    expect(out).toMatchObject({ ok: true, listUsd: 4320, bandText: '300 kg/m³ · $1.2/kg × 3600 kg', volumeFromLines: true });
  });

  it('every case has words and a tail — and the words are never the code', () => {
    const cases = Object.keys(FREIGHT_TAIL) as FreightRefusalCase[];
    expect(cases.length).toBe(9);
    for (const c of cases) {
      const words = FREIGHT_WORDS[c]({ city: 'Foshan', zone: 'horgos' });
      expect(words.length, c).toBeGreaterThan(5);
      expect(words, c).not.toContain(c);
    }
  });
});
