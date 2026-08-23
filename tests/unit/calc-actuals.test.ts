import { describe, expect, it } from 'vitest';
import {
  bucketRefusal,
  freightBandCheck,
  settledFor,
  type ActualRefusal,
} from '@/modules/wms/calc/actuals';
import { ownerTariffRows } from '@/modules/wms/calc/tariff-seed';
import { compareQuote } from '@/modules/wms/deals/deviation';

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
