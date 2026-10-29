import { describe, expect, it } from 'vitest';
import {
  densityBandRate,
  SITE_TARIFF,
  siteEstimate,
  type SiteEstimateInput,
} from '@/modules/wms/agent/site-estimate';
import { OWNER_TARIFF_BANDS } from '@/modules/wms/calc/tariff-seed';

/**
 * The AI quotes the website's calculator (his 9: «saytdagi kalkulyatorni ozi
 * boyicha»), so the website's OWN worked examples are the oracle — copied from
 * gsrlogistics.uz `scripts/test-pricing.mjs`, numbers and all. A port that
 * drifts from the original disagrees with sentences the site already prints.
 */
const DAY = '2026-10-24';
const est = (input: Omit<SiteEstimateInput, 'day'>) => {
  const r = siteEstimate({ ...input, day: DAY });
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.estimate;
};

describe('the website calculator, ported', () => {
  it('example 2: 300 kg shoes, 1.2 m³ → 250 kg/m³ → $180/m³ → $216', () => {
    const e = est({ mode: 'truck', kg: 300, m3: 1.2 });
    expect(e.rule).toBe('truck-lcl');
    expect(e.densityKgM3).toBe(250);
    expect(e.rate).toBe(180);
    expect(e.total).toBe(216);
  });

  it('example 3: 2 m³ toys, 180 kg → 90 kg/m³ → $110/m³ → $220', () => {
    const e = est({ mode: 'truck', kg: 180, m3: 2 });
    expect(e.unit).toBe('m3');
    expect(e.rate).toBe(110);
    expect(e.total).toBe(220);
  });

  it('example 6: every band of the sheet at the top of its range, and just inside the next', () => {
    const band = (kg: number) => est({ mode: 'truck', kg, m3: 1 }).rate;
    expect([100, 150, 200, 250, 300, 350, 400, 450, 500, 700, 900].map(band)).toEqual([
      110, 130, 160, 180, 200, 230, 260, 280, 290, 300, 320,
    ]);
    expect(band(101)).toBe(130);
    expect(band(201)).toBe(180);
  });

  it('example 6: at and above 1000 kg/m³ the sheet bills per kilogram', () => {
    const heavy = est({ mode: 'truck', kg: 1000, m3: 1 });
    expect(heavy.rule).toBe('truck-per-kg');
    expect(heavy.unit).toBe('kg');
    expect(heavy.rate).toBe(0.55);
    expect(heavy.total).toBe(550);
  });

  it('example 6b: below the 0.1 m³ minimum the minimum is billed, and said', () => {
    const e = est({ mode: 'truck', kg: 2, m3: 0.02 });
    expect(e.chargeableM3).toBe(0.1);
    expect(e.notes).toContain('min-m3-applied');
    expect(e.total).toBe(11);
  });

  it('weight alone prices no road: the sheet needs a volume (the site refuses too)', () => {
    expect(siteEstimate({ mode: 'truck', kg: 20, day: DAY })).toEqual({ ok: false, reason: 'volume_required' });
  });

  it('example 1 and 5: air by kilogram, the volumetric weight winning when larger', () => {
    // 20 kg commercial in 50×40×30 cm = 0.06 m³ → volumetric 12 kg, so 20 is billed.
    const commercial = est({ mode: 'air', kg: 20, m3: 0.06, category: 'commercial' });
    expect(commercial.rate).toBe(11.5);
    expect(commercial.total).toBe(230);
    // 5 kg in 60×50×40 cm = 0.12 m³ → 24 kg volumetric.
    const bulky = est({ mode: 'air', kg: 5, m3: 0.12 });
    expect(bulky.chargeableKg).toBe(24);
    expect(bulky.notes).toContain('volumetric-applied');
    expect(bulky.total).toBe(216);
  });

  it('example 4: the air minimum of 0.5 kg', () => {
    const e = est({ mode: 'air', kg: 0.3 });
    expect(e.chargeableKg).toBe(0.5);
    expect(e.total).toBe(4.5);
  });

  it('example 8: a battery cannot fly — the truck sheet answers, and says it switched', () => {
    const e = est({ mode: 'air', kg: 10, m3: 0.2, category: 'battery' });
    expect(e.mode).toBe('truck');
    expect(e.notes[0]).toBe('switched-to-truck');
  });

  it('example 7: rail is a range per container', () => {
    const e = est({ mode: 'rail', container: '40ft' });
    expect([e.total, e.totalMax]).toEqual([5200, 6800]);
  });

  it('refuses past the snapshot validThrough instead of quoting a stale public price', () => {
    expect(siteEstimate({ mode: 'truck', kg: 300, m3: 1.2, day: '2027-01-01' })).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(siteEstimate({ mode: 'truck', kg: 300, m3: 1.2, day: SITE_TARIFF.validThrough }).ok).toBe(true);
  });

  it('refuses NaN rather than pricing it (#777)', () => {
    expect(siteEstimate({ mode: 'truck', kg: Number.NaN, m3: 1, day: DAY })).toEqual({
      ok: false,
      reason: 'not_a_number',
    });
  });
});

describe('the website sheet and the system tariff agree on the China column', () => {
  /**
   * Not because one must follow the other — the website is what the customer
   * has seen, /admin/tarif is the VED's list price — but because the day they
   * part, a customer quoted by the AI and billed by the VED gets two numbers
   * for one road. This names that day instead of letting it be discovered.
   */
  it('every whole density 1..1500 picks the same China rate from both sheets', () => {
    for (let density = 1; density < 1000; density += 1) {
      const system = OWNER_TARIFF_BANDS.find(([min, max]) => density >= min && (max === null || density <= max));
      expect(system?.[2], `density ${density}`).toBe(densityBandRate(SITE_TARIFF.truck.lclPerM3ByDensity, density));
    }
    const perKg = OWNER_TARIFF_BANDS.find(([min, max]) => max === null && min === SITE_TARIFF.truck.perKgFromDensityKgM3);
    expect(perKg?.[2]).toBe(SITE_TARIFF.truck.perKgAboveDensity);
  });
});
