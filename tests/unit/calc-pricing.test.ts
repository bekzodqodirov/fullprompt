import { describe, expect, it } from 'vitest';
import {
  bandDensityOf,
  bandFor,
  customsFor,
  densityOf,
  freightFor,
  sectionParts,
  totalsFor,
  type FreightBand,
  type PricedGroup,
  type PricedItem,
} from '@/modules/wms/calc/pricing';
import { OWNER_TARIFF_BANDS, ownerTariffRows } from '@/modules/wms/calc/tariff-seed';

/**
 * A tariff WITH A HOLE and an OVERLAP — deliberately not the owner's.
 *
 * His own table used to look like this (700 in two rows, nothing for 900-999)
 * and he has since closed both. The fixture keeps the broken shape because the
 * refusals are a property of the ENGINE, not of today's data: the tariff is
 * editable on /admin/tarif, and the day somebody types a band that leaves a
 * gap, the price has to refuse rather than quietly pick the cheaper reading.
 */
const HOLEY: FreightBand[] = [
  { zone: 'cn', minDensity: 1, maxDensity: 100, priceUsd: 110, perKg: false },
  { zone: 'cn', minDensity: 101, maxDensity: 150, priceUsd: 130, perKg: false },
  { zone: 'cn', minDensity: 501, maxDensity: 700, priceUsd: 300, perKg: false },
  { zone: 'cn', minDensity: 700, maxDensity: 900, priceUsd: 320, perKg: false },
  { zone: 'cn', minDensity: 1000, maxDensity: null, priceUsd: 0.55, perKg: true },
  { zone: 'kashgar', minDensity: 1, maxDensity: 100, priceUsd: 70, perKg: false },
  { zone: 'kashgar', minDensity: 1000, maxDensity: null, priceUsd: 0.3, perKg: true },
];

/** The owner's settled table, from the module `scripts/seed.ts` writes. */
const TARIFF: FreightBand[] = ownerTariffRows().map((r) => ({
  zone: r.zone,
  minDensity: r.minDensity,
  maxDensity: r.maxDensity,
  priceUsd: r.priceUsd,
  perKg: r.perKg,
}));

const group = (over: Partial<PricedGroup> = {}): PricedGroup => ({
  seq: 1,
  label: 'Monitorlar',
  tnvedCode: '8528520000',
  dutyPct: 10,
  vatPct: 12,
  feeUsd: 0,
  dutyFree: false,
  vatFree: false,
  ...over,
});

const item = (over: Partial<PricedItem> = {}): PricedItem => ({
  seq: 1,
  label: 'monitor 24"',
  quantity: 100,
  weightKg: 500,
  bazaUsd: 20,
  bazaBasis: 'unit',
  ...over,
});

describe('sections', () => {
  it('a yolkira quote has no customs and a rastamojka quote has no freight', () => {
    expect(sectionParts('yolkira')).toEqual({ customs: false, freight: true, extras: true });
    expect(sectionParts('rastamojka')).toEqual({ customs: true, freight: false, extras: true });
    expect(sectionParts('podklyuch')).toEqual({ customs: true, freight: true, extras: true });
  });
});

describe('customsFor', () => {
  it('sums the group over its items, each at its OWN product baza', () => {
    // The law this file exists for: one TNVED code, two products, two bazas.
    // Priced at either one alone the answer is out by nearly half.
    const res = customsFor(group({ dutyPct: 10, vatPct: 12 }), [
      item({ seq: 1, bazaUsd: 8, bazaBasis: 'kg', weightKg: 100 }),
      item({ seq: 2, bazaUsd: 3, bazaBasis: 'kg', weightKg: 100 }),
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.valueUsd).toBe(1100); // 8×100 + 3×100, not 8×200 (1600) and not 3×200 (600)
    expect(res.dutyUsd).toBe(110);
    expect(res.vatUsd).toBe(145.2); // (1100 + 110) × 12 %
    expect(res.customsUsd).toBe(255.2);
  });

  it('every printed line adds up to the printed total', () => {
    const res = customsFor(group({ dutyPct: 7.5, vatPct: 12, feeUsd: 33.33 }), [
      item({ bazaUsd: 12.345, bazaBasis: 'unit', quantity: 37 }),
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.dutyUsd + res.vatUsd + res.feeUsd).toBe(res.customsUsd);
  });

  it('refuses instead of multiplying a missing baza, and names the item', () => {
    const res = customsFor(group(), [item({ seq: 4, label: 'noma’lum', bazaUsd: null })]);
    expect(res).toMatchObject({ ok: false, reason: 'baza_missing', itemSeq: 4, itemLabel: 'noma’lum' });
  });

  it('refuses instead of multiplying a missing measure', () => {
    // The bot's goods routinely carry no quantity at all. `4 * null` is 0 in
    // JavaScript, so without this the seal would lock «rastamojka: $0.00».
    const res = customsFor(group(), [item({ seq: 2, quantity: null, bazaBasis: 'unit' })]);
    expect(res).toMatchObject({ ok: false, reason: 'measure_missing', itemSeq: 2 });
  });

  it('refuses when the rates dictionary has never heard of the code', () => {
    expect(customsFor(group({ dutyPct: null }), [item()])).toMatchObject({
      ok: false,
      reason: 'rates_missing',
    });
    expect(customsFor(group({ vatPct: null }), [item()])).toMatchObject({
      ok: false,
      reason: 'rates_missing',
    });
  });

  it('a lgota is a real zero, not a missing rate', () => {
    const res = customsFor(
      group({ dutyPct: null, vatPct: null, dutyFree: true, vatFree: true, feeUsd: 25 }),
      [item({ bazaUsd: 10, bazaBasis: 'unit', quantity: 100 })],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res).toMatchObject({ valueUsd: 1000, dutyUsd: 0, vatUsd: 0, customsUsd: 25 });
  });

  it('an empty group is refused, never priced at zero', () => {
    expect(customsFor(group(), [])).toMatchObject({ ok: false, reason: 'group_empty' });
  });

  it('refuses NaN, which passes every range check a person writes', () => {
    // `Number('1 000')` and `Number('abc')` are both NaN, and NaN answers
    // false to `< 0`, to `> 100` and to `> 0` — so it slips through guards
    // that look correct. Postgres then stores it and answers TRUE to `>= 0`.
    expect(Number('1 000')).toBeNaN();
    expect(NaN < 0 || NaN > 100).toBe(false);

    expect(customsFor(group({ dutyPct: NaN }), [item()])).toMatchObject({
      ok: false,
      reason: 'not_a_number',
    });
    expect(customsFor(group(), [item({ bazaUsd: NaN })])).toMatchObject({
      ok: false,
      reason: 'not_a_number',
    });
  });
});

describe('bandFor', () => {
  it('reads his table in the whole numbers he wrote it in', () => {
    // 100.4 kg/m³ is ordinary cargo and lies between «1–100» and «101–150».
    // Carried raw it would find no row at all.
    expect(bandDensityOf(100.4)).toBe(100);
    const res = bandFor(TARIFF, 'cn', 100.4);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.band.priceUsd).toBe(110);
    const up = bandFor(TARIFF, 'cn', 100.6);
    expect(up.ok).toBe(true);
    if (up.ok) expect(up.band.priceUsd).toBe(130);
  });

  it('REFUSES a gap rather than choosing the cheaper band', () => {
    // 30 m³ at 950 kg/m³ is $9,600 read down and $15,675 read up. On a tariff
    // that covers neither, the engine must say so — the difference is a
    // person's to decide, and their answer becomes a band.
    expect(bandFor(HOLEY, 'cn', 950)).toEqual({ ok: false, reason: 'band_missing' });
    expect(bandFor(HOLEY, 'cn', 901)).toEqual({ ok: false, reason: 'band_missing' });
    expect(bandFor(HOLEY, 'cn', 999)).toEqual({ ok: false, reason: 'band_missing' });
  });

  it('REFUSES a density two bands both claim', () => {
    expect(bandFor(HOLEY, 'cn', 700)).toEqual({ ok: false, reason: 'band_ambiguous' });
  });

  it('nonsense density finds nothing', () => {
    expect(bandFor(TARIFF, 'cn', 0.4)).toEqual({ ok: false, reason: 'band_missing' });
  });

  it('the zone is part of the lookup — kashgar is a different price', () => {
    const cn = bandFor(TARIFF, 'cn', 50);
    const kg = bandFor(TARIFF, 'kashgar', 50);
    expect(cn.ok && cn.band.priceUsd).toBe(110);
    expect(kg.ok && kg.band.priceUsd).toBe(70);
    expect(bandFor(HOLEY, 'kashgar', 120)).toEqual({ ok: false, reason: 'band_missing' });
  });
});

describe('the owner’s settled tariff', () => {
  /**
   * His three answers, as one property: the table covers EVERY whole kg/m³
   * from 1 upwards, exactly once, in both zones.
   *
   * This is the fence the round's questions bought. It reads the same module
   * `scripts/seed.ts` writes from, so a hole cannot be re-introduced on one
   * side without the other side going red — and the two densities that used
   * to be wrong (700 in two bands, 950 in none) are asserted by name below so
   * a future edit cannot quietly undo his decision.
   */
  it('covers every whole kg/m³ from 1 upwards, exactly once, in both zones', () => {
    const gaps: string[] = [];
    const overlaps: string[] = [];
    for (const zone of ['cn', 'kashgar']) {
      for (let d = 1; d <= 1500; d += 1) {
        const hits = TARIFF.filter(
          (r) => r.zone === zone && d >= r.minDensity && (r.maxDensity === null || d <= r.maxDensity),
        );
        if (hits.length === 0) gaps.push(`${zone}@${d}`);
        if (hits.length > 1) overlaps.push(`${zone}@${d}`);
      }
    }
    expect(gaps, 'densities his tariff cannot price').toEqual([]);
    expect(overlaps, 'densities two of his bands both claim').toEqual([]);
  });

  it('answers the three questions he settled', () => {
    // «ketma-ket»: 700 stays in the band below.
    const at700 = bandFor(TARIFF, 'cn', 700);
    expect(at700.ok && at700.band.priceUsd).toBe(300);
    // «sen aytgandek»: 900-999 takes the $320 band.
    for (const d of [900, 950, 999]) {
      const hit = bandFor(TARIFF, 'cn', d);
      expect(hit.ok && hit.band.priceUsd, `cn@${d}`).toBe(320);
    }
    // «shunday qolsin»: 1000 is still a step, and still per kilogram.
    const at1000 = bandFor(TARIFF, 'cn', 1000);
    expect(at1000.ok && at1000.band.perKg).toBe(true);
    expect(at1000.ok && at1000.band.priceUsd).toBe(0.55);
  });

  it('is twelve bands per zone, and only the top one is per kilogram', () => {
    expect(OWNER_TARIFF_BANDS).toHaveLength(12);
    const perKg = TARIFF.filter((r) => r.perKg);
    expect(perKg).toHaveLength(2);
    expect(perKg.every((r) => r.maxDensity === null)).toBe(true);
  });
});

describe('freightFor', () => {
  it('prices per m³ below the top band and per kg above it', () => {
    const perM3 = freightFor(TARIFF, { zone: 'cn', weightKg: 1500, volumeM3: 30 });
    expect(perM3.ok).toBe(true);
    if (perM3.ok) {
      expect(perM3.density).toBe(50);
      expect(perM3.listUsd).toBe(3300); // 30 m³ × $110
    }
    const perKg = freightFor(TARIFF, { zone: 'cn', weightKg: 30_000, volumeM3: 30 });
    expect(perKg.ok).toBe(true);
    if (perKg.ok) expect(perKg.listUsd).toBe(16_500); // 30 000 kg × $0.55
  });

  it('refuses without a zone — nothing infers CN from a city name', () => {
    expect(freightFor(TARIFF, { zone: null, weightKg: 1500, volumeM3: 30 })).toEqual({
      ok: false,
      reason: 'zone_required',
    });
  });

  it('refuses a missing measure on either side', () => {
    expect(freightFor(TARIFF, { zone: 'cn', weightKg: null, volumeM3: 30 })).toEqual({
      ok: false,
      reason: 'measure_missing',
    });
    expect(freightFor(TARIFF, { zone: 'cn', weightKg: 1500, volumeM3: 0 })).toEqual({
      ok: false,
      reason: 'measure_missing',
    });
  });

  it('a band override moves the band and leaves the real density on the record', () => {
    const res = freightFor(TARIFF, {
      zone: 'cn',
      weightKg: 28_500,
      volumeM3: 30,
      overrideDensity: 700.5,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.density).toBe(950); // what the cargo measured — refused on its own
    expect(res.bandDensity).toBe(701); // what the VED said it belongs in
    expect(res.listUsd).toBe(9600);
  });
});

describe('totalsFor', () => {
  const base = {
    customsUsd: 1000,
    freightUsd: 3300,
    extrasUsd: 200,
    discountUsd: 0,
    weightKg: 1500,
    volumeM3: 30,
  };

  it('the section decides which parts exist', () => {
    const yolkira = totalsFor({ ...base, section: 'yolkira' });
    expect(yolkira.ok && yolkira.customsUsd).toBe(0);
    expect(yolkira.ok && yolkira.totalUsd).toBe(3500);

    const rastamojka = totalsFor({ ...base, section: 'rastamojka' });
    expect(rastamojka.ok && rastamojka.freightUsd).toBe(0);
    expect(rastamojka.ok && rastamojka.totalUsd).toBe(1200);

    const podklyuch = totalsFor({ ...base, section: 'podklyuch' });
    expect(podklyuch.ok && podklyuch.totalUsd).toBe(4500);
  });

  it('gives the per-cube and per-kilo lines the owner asks for', () => {
    const res = totalsFor({ ...base, section: 'podklyuch' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.perM3Usd).toBe(150);
    expect(res.perKgUsd).toBe(3);
  });

  it('a discount comes off the total and is kept on its own line', () => {
    const res = totalsFor({ ...base, section: 'podklyuch', discountUsd: 500 });
    expect(res.ok && res.totalUsd).toBe(4000);
    expect(res.ok && res.discountUsd).toBe(500);
  });

  it('refuses a discount bigger than the job', () => {
    expect(totalsFor({ ...base, section: 'podklyuch', discountUsd: 9999 })).toEqual({
      ok: false,
      reason: 'discount_exceeds_total',
    });
  });

  it('refuses a NaN discount instead of sealing an unreadable total', () => {
    const res = totalsFor({ ...base, section: 'podklyuch', discountUsd: NaN });
    expect(res).toEqual({ ok: false, reason: 'not_a_number' });
  });

  it('no divisor, no per-unit line — never a zero', () => {
    const res = totalsFor({ ...base, section: 'podklyuch', weightKg: null, volumeM3: 0 });
    expect(res.ok && res.perM3Usd).toBeNull();
    expect(res.ok && res.perKgUsd).toBeNull();
  });
});

describe('densityOf', () => {
  it('is unrounded, and null without a volume', () => {
    expect(densityOf(1234.5, 12.3)).toBeCloseTo(100.3659, 4);
    expect(densityOf(1234.5, 0)).toBeNull();
    expect(densityOf(null, 12)).toBeNull();
  });
});

describe('law 8: no minimum charge — very small cargo gets only a warning', () => {
  const rows = ownerTariffRows();

  it('a tiny load prices honestly and carries the flag', () => {
    // 0.2 m³ of light goods: band 1-100 at $110/m³ = $22 — under $50.
    const r = freightFor(rows, { zone: 'cn', weightKg: 15, volumeM3: 0.2 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.listUsd).toBe(22);
      expect(r.small).toBe(true);
    }
  });

  it('an ordinary load does not', () => {
    const r = freightFor(rows, { zone: 'cn', weightKg: 1500, volumeM3: 30 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.small).toBe(false);
  });

  it('the per-kg branch is under the same rule', () => {
    // 40 kg at 0.03 m³ → ≥1000 kg/m³ → $0.55/kg = $22.
    const r = freightFor(rows, { zone: 'cn', weightKg: 40, volumeM3: 0.03 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.band.perKg).toBe(true);
      expect(r.small).toBe(true);
    }
  });
});
