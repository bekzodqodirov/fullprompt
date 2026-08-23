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

/** The owner's own table, as `scripts/seed.ts` seeds it (docs/VED.md). */
const TARIFF: FreightBand[] = [
  { zone: 'cn', minDensity: 1, maxDensity: 100, priceUsd: 110, perKg: false },
  { zone: 'cn', minDensity: 101, maxDensity: 150, priceUsd: 130, perKg: false },
  { zone: 'cn', minDensity: 501, maxDensity: 700, priceUsd: 300, perKg: false },
  { zone: 'cn', minDensity: 700, maxDensity: 900, priceUsd: 320, perKg: false },
  { zone: 'cn', minDensity: 1000, maxDensity: null, priceUsd: 0.55, perKg: true },
  { zone: 'kashgar', minDensity: 1, maxDensity: 100, priceUsd: 70, perKg: false },
  { zone: 'kashgar', minDensity: 1000, maxDensity: null, priceUsd: 0.3, perKg: true },
];

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

  it('REFUSES the 900-999 hole rather than choosing the cheaper band', () => {
    // 30 m³ at 950 kg/m³ is $9,600 read down and $15,675 read up. The
    // difference is the owner's to decide, and his answer becomes a row.
    expect(bandFor(TARIFF, 'cn', 950)).toEqual({ ok: false, reason: 'band_missing' });
    expect(bandFor(TARIFF, 'cn', 901)).toEqual({ ok: false, reason: 'band_missing' });
    expect(bandFor(TARIFF, 'cn', 999)).toEqual({ ok: false, reason: 'band_missing' });
  });

  it('REFUSES the density his table lists twice', () => {
    expect(bandFor(TARIFF, 'cn', 700)).toEqual({ ok: false, reason: 'band_ambiguous' });
  });

  it('nonsense density finds nothing', () => {
    expect(bandFor(TARIFF, 'cn', 0.4)).toEqual({ ok: false, reason: 'band_missing' });
  });

  it('the zone is part of the lookup — kashgar is a different price', () => {
    const cn = bandFor(TARIFF, 'cn', 50);
    const kg = bandFor(TARIFF, 'kashgar', 50);
    expect(cn.ok && cn.band.priceUsd).toBe(110);
    expect(kg.ok && kg.band.priceUsd).toBe(70);
    expect(bandFor(TARIFF, 'kashgar', 120)).toEqual({ ok: false, reason: 'band_missing' });
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
