import { describe, expect, it } from 'vitest';
import {
  bucketRefusal,
  freightBandCheck,
  settledFor,
  type ActualRefusal,
} from '@/modules/wms/calc/actuals';
import { ownerTariffRows } from '@/modules/wms/calc/tariff-seed';
import { compareQuote } from '@/modules/wms/deals/deviation';
import { bandsAsOf } from '@/modules/wms/calc/dictionaries';

/**
 * The refusal ladder, in one table.
 *
 * Every one of these would otherwise read as a −100 % saving or a +∞ overrun
 * against a person's name, which is the whole reason phase E1 refuses instead
 * of printing a number: «⚠ va sabab, hech qachon $0» is phase B's own rule.
 */
const clean: Parameters<typeof bucketRefusal>[0] = {
  section: 'rastamojka',
  linkedReceipts: 2,
  anyCustomsByClient: false,
  cargoIncomplete: false,
  linkImplausible: false,
  entriesFound: 3,
  mappedEntries: 1,
  unconvertedEntries: 0,
  unallocatedEntries: 0,
};

describe('a bucket that cannot be compared is never scored', () => {
  it('scores a clean one', () => {
    expect(bucketRefusal(clean)).toBeNull();
  });

  const cases: [string, Partial<typeof clean>, ActualRefusal][] = [
    ['nothing is linked', { linkedReceipts: 0 }, 'not_linked'],
    ['a year of cargo on one quote', { linkImplausible: true }, 'link_implausible'],
    ['a yolkira quote has no customs line', { section: 'yolkira' }, 'section_has_no_customs'],
    ['the client cleared it themselves', { anyCustomsByClient: true }, 'customs_by_client'],
    ['half the cargo is still travelling', { cargoIncomplete: true }, 'cargo_incomplete'],
    ['nobody has typed the rastamojka', { entriesFound: 0 }, 'no_actual_yet'],
    ['the costs are all of other kinds', { mappedEntries: 0 }, 'no_actual_cost'],
    ['a rate has not arrived', { unconvertedEntries: 1 }, 'unconverted'],
    ['the bill allocated to nobody', { unallocatedEntries: 1 }, 'unallocated'],
  ];
  for (const [name, patch, expected] of cases) {
    it(`refuses when ${name}`, () => {
      expect(bucketRefusal({ ...clean, ...patch })).toBe(expected);
    });
  }

  /**
   * `not_linked` beats everything: with no cargo on the calculation, every
   * other question is about an empty set and would answer «fine».
   */
  it('asks whether anything is linked before anything else', () => {
    expect(bucketRefusal({ ...clean, linkedReceipts: 0, entriesFound: 0 })).toBe('not_linked');
  });

  it('reports a podklyuch quote as comparable — it carries customs too', () => {
    expect(bucketRefusal({ ...clean, section: 'podklyuch' })).toBeNull();
  });
});

describe('the freight half is a BAND check, never a money figure', () => {
  // The owner's own table, not a fixture — the band boundaries are the
  // subject and a hand-written tariff would prove nothing about his.
  const cn = ownerTariffRows().filter((b) => b.zone === 'cn');

  it('agrees when the cargo lands in the band it was quoted in', () => {
    // 30 m³ at 180 kg/m³ = 5400 kg, which is the 151-200 row.
    const check = freightBandCheck({
      section: 'yolkira',
      tariff: cn,
      zone: 'cn',
      quotedMin: 151,
      quotedRate: 160,
      actualVolumeM3: 30,
      actualWeightKg: 5400,
    });
    expect(check.arrivedMin).toBe(151);
    expect(check.ok).toBe(true);
  });

  /**
   * The sentence the owner can act on: «quoted the 151-200 band, the cargo
   * arrived at 96 kg/m³». It is a decision a person made and got wrong, which
   * is exactly what the money comparison could never be.
   */
  it('disagrees when the cargo arrives lighter than the quote assumed', () => {
    const check = freightBandCheck({
      section: 'yolkira',
      tariff: cn,
      zone: 'cn',
      quotedMin: 151,
      quotedRate: 160,
      actualVolumeM3: 30,
      actualWeightKg: 2880, // 96 kg/m³
    });
    expect(check.arrivedMin).toBe(1);
    expect(check.ok).toBe(false);
  });

  it('says nothing at all about a rastamojka quote', () => {
    const check = freightBandCheck({
      section: 'rastamojka',
      tariff: cn,
      zone: 'cn',
      quotedMin: 151,
      quotedRate: 160,
      actualVolumeM3: 30,
      actualWeightKg: 5400,
    });
    expect(check.ok).toBeNull();
    expect(check.arrivedMin).toBeNull();
  });

  it('says nothing when the cargo has no measure to place it by', () => {
    const check = freightBandCheck({
      section: 'yolkira',
      tariff: cn,
      zone: 'cn',
      quotedMin: 151,
      quotedRate: 160,
      actualVolumeM3: 0,
      actualWeightKg: 0,
    });
    expect(check.ok).toBeNull();
  });
});

/**
 * Found by looking at the screen, not by a test: the completeness gate used
 * `compareQuote`'s worst-of-both, so cargo that arrived in FULL but lighter
 * than quoted was refused as «not all the cargo arrived» — hiding exactly the
 * error the round exists to show. Missing cargo is a volume shortfall.
 */
describe('completeness is a VOLUME question', () => {
  const quote = { volumeM3: 30, weightKg: 5400, amount: null };

  it('half the cubes missing is incomplete', () => {
    const d = compareQuote(quote, { volumeM3: 15, weightKg: 2700 }, 10);
    expect(d.volumePct).toBeLessThan(-10);
  });

  it('every cube arrived, at half the weight — NOT incomplete', () => {
    const d = compareQuote(quote, { volumeM3: 30, weightKg: 2900 }, 10);
    // The old rule read this one, and refused the comparison on it.
    expect(d.worstPct).toBeLessThan(-10);
    // The rule that ships reads this one.
    expect(d.volumePct).toBe(0);
  });
});

/**
 * The band a quote was priced in came from the tariff in force when it was
 * SEALED, and the owner edits his table by adding a DATED row (that is what
 * the tariff screen is for). Comparing every historical quote against today's
 * boundaries would make correct old work start reporting the wrong band the
 * morning after any edit — the same failure this whole round exists to avoid.
 */
describe('the band check reads the tariff in force AT THE SEAL', () => {
  const history = [
    // Edited later: 151-200 became 151-180, and a new 181-200 row appeared.
    { zone: 'cn', minDensity: 1, maxDensity: 100, priceUsd: 110, perKg: false, effectiveDate: '2026-06-01' },
    { zone: 'cn', minDensity: 101, maxDensity: 150, priceUsd: 130, perKg: false, effectiveDate: '2026-06-01' },
    { zone: 'cn', minDensity: 151, maxDensity: 180, priceUsd: 160, perKg: false, effectiveDate: '2026-06-01' },
    { zone: 'cn', minDensity: 181, maxDensity: 400, priceUsd: 175, perKg: false, effectiveDate: '2026-06-01' },
    // The original table.
    { zone: 'cn', minDensity: 1, maxDensity: 100, priceUsd: 110, perKg: false, effectiveDate: '2026-01-01' },
    { zone: 'cn', minDensity: 101, maxDensity: 150, priceUsd: 130, perKg: false, effectiveDate: '2026-01-01' },
    { zone: 'cn', minDensity: 151, maxDensity: 200, priceUsd: 160, perKg: false, effectiveDate: '2026-01-01' },
    { zone: 'cn', minDensity: 201, maxDensity: 400, priceUsd: 180, perKg: false, effectiveDate: '2026-01-01' },
  ];

  // 30 m³ at 190 kg/m³ = 5,700 kg. Under the OLD table that is the 151-200
  // band the quote named; under the NEW one it is 181-400.
  const cargo = { actualVolumeM3: 30, actualWeightKg: 5700 };

  it('agrees with a quote sealed under the old table', () => {
    const check = freightBandCheck({
      section: 'yolkira',
      tariff: bandsAsOf(history, '2026-03-15'),
      zone: 'cn',
      quotedMin: 151,
      quotedRate: 160,
      ...cargo,
    });
    expect(check.arrivedMin).toBe(151);
    expect(check.ok).toBe(true);
  });

  it('would have flagged that same correct quote against TODAY’s table', () => {
    // The defect, stated as a measurement rather than an argument.
    const check = freightBandCheck({
      section: 'yolkira',
      tariff: bandsAsOf(history, '2026-08-23'),
      zone: 'cn',
      quotedMin: 151,
      quotedRate: 160,
      ...cargo,
    });
    expect(check.arrivedMin).toBe(181);
    expect(check.ok).toBe(false);
  });

  it('bandsAsOf takes the newest row on or before the day, per zone and band', () => {
    const old = bandsAsOf(history, '2026-03-15');
    expect(old.find((b) => b.minDensity === 151)?.maxDensity).toBe(200);
    const now = bandsAsOf(history, '2026-08-23');
    expect(now.find((b) => b.minDensity === 151)?.maxDensity).toBe(180);
    // And a date before ANY row answers with nothing — no earliest-row
    // fallback, the rule every dictionary in this module follows.
    expect(bandsAsOf(history, '2025-12-31')).toEqual([]);
  });
});

/**
 * A rastamojka quote needs no volume at all — `sectionParts().freight` is
 * false, so nothing blocks a seal without one — and a volume-ONLY rule leaves
 * such a quote with no completeness guard and no implausibility guard, which
 * is the worst combination this screen can have: it scores.
 */
describe('a quote with no volume falls back to WEIGHT', () => {
  const noVolume = { volumeM3: null, weightKg: 5000, amount: null };

  it('a 300 kg prixod against a 5,000 kg quote is incomplete', () => {
    const d = compareQuote(noVolume, { volumeM3: 1.8, weightKg: 300 }, 10);
    // The clause the old rule read, and threw away.
    expect(d.volumePct).toBeNull();
    expect(d.weightPct).toBeLessThan(-10);
  });

  it('still prefers volume when the quote has one', () => {
    const d = compareQuote({ volumeM3: 30, weightKg: 5400, amount: null }, { volumeM3: 30, weightKg: 2900 }, 10);
    expect(d.volumePct).toBe(0);
  });
});

describe('the settle clock runs from ARRIVAL and not from the seal', () => {
  const arrived = new Date('2026-08-01T00:00:00Z');

  it('is not settled the day the cargo lands', () => {
    expect(settledFor(arrived, 7, new Date('2026-08-02T00:00:00Z'))).toBe(false);
  });

  it('is settled once the window has passed', () => {
    expect(settledFor(arrived, 7, new Date('2026-08-08T00:00:00Z'))).toBe(true);
  });

  /**
   * Cargo that has not arrived is never settled, whatever the calendar says —
   * the road is a ten-day floor and about seventeen days typically, so a
   * sealed-at clock would score quotes whose cargo is still in Kashgar.
   */
  it('is never settled while the cargo is still travelling', () => {
    expect(settledFor(null, 7, new Date('2027-01-01T00:00:00Z'))).toBe(false);
  });
});
