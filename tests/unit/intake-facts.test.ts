import { describe, expect, it } from 'vitest';
import { parseManualFacts } from '@/modules/wms/calc/intake-manual';
import { intakeSummaryText, itemFacts, missingFields } from '@/modules/wms/calc/intake';

/**
 * The owner's three bot reports, as pure rules (2026-09-04).
 *
 * The one this file exists for is his second: «7 8 ta malumot tashlaganda …
 * faqat 1 tasini tahlil qilyabti». Eight forwarded messages are joined into
 * ONE string before anything reads them, and a typed fact deliberately BEATS
 * the model's reading — so the first «12 kg» in a packing line became the
 * shipment's whole weight and the model's total was discarded. A rule that
 * is right about «250 kg» in one message and silently wrong about eight is
 * exactly the shape this codebase keeps finding.
 */

describe('a typed number wins only when the text states ONE of them', () => {
  it('reads a single statement, as it always did', () => {
    const f = parseManualFacts('Yiwu → Toshkent, 250 kg, 3.5 kub, chexollar');
    expect(f.weightKg).toBe(250);
    expect(f.volumeM3).toBe(3.5);
    expect(f.fromCity).toBe('Yiwu');
  });

  it('refuses when the collection names several DIFFERENT weights', () => {
    // Eight forwards, each a line of the packing list. Nothing here is the
    // shipment's weight, and picking the first is worse than picking none:
    // it beats the model, which had read all of it.
    const many = ['12 kg', '30 kg', '7,5 kg'].join('\n');
    expect(parseManualFacts(many).weightKg).toBeNull();
  });

  it('the same number repeated is still one statement', () => {
    expect(parseManualFacts('250 kg\nyana 250 kg deb yozishdi').weightKg).toBe(250);
  });

  it('one spelling answers for its unit — «5 kub» and «5 m3» are not two opinions', () => {
    expect(parseManualFacts('5 kub (5 m3)').volumeM3).toBe(5);
  });

  it('several cubes refuse too', () => {
    expect(parseManualFacts('2 kub … 3 kub').volumeM3).toBeNull();
  });

  it('the ASCII word-boundary trap stays fixed', () => {
    // «120кг» ends on a non-word character as far as \\b is concerned.
    expect(parseManualFacts('vazni 120кг, 2 куб').weightKg).toBe(120);
    expect(parseManualFacts('vazni 120кг, 2 куб').volumeM3).toBe(2);
  });
});

describe('the checklist still names what a quote cannot be made without', () => {
  it('a refused weight leaves the ⚠ standing — and now the VED can answer it', () => {
    const facts = parseManualFacts('12 kg, 30 kg, plitka');
    expect(missingFields('rastamojka', facts)).toContain('weightKg');
    const text = intakeSummaryText({
      section: 'rastamojka',
      facts,
      clientLabel: 'GS777',
      fileCount: 2,
    });
    expect(text).toContain('Yetishmayapti');
  });
});

describe('what a line weighs is derived once, or asked for', () => {
  /**
   * Customs is calculated per LINE, so the checklist grew two per-line
   * questions in sub-round B — and exactly one of them has an honest answer
   * the system can work out for itself.
   */
  it('one line takes the shipment’s weight; two lines take nothing', () => {
    const one = itemFacts({ weightKg: 250, goods: [{ name: 'Chexol' }] });
    expect(one[0]!.weightKg).toBe(250);

    // Two lines cannot be split without inventing a ratio, and inventing is
    // the one thing this module may not do — so both stay empty and the
    // checklist asks.
    const two = itemFacts({ weightKg: 250, goods: [{ name: 'Chexol' }, { name: 'Monitor' }] });
    expect(two.map((i) => i.weightKg)).toEqual([null, null]);
    // …unless the line states its own, which always wins.
    const stated = itemFacts({
      weightKg: 250,
      goods: [{ name: 'Chexol', weightKg: 40 }, { name: 'Monitor' }],
    });
    expect(stated.map((i) => i.weightKg)).toEqual([40, null]);
  });

  it('a zero is a blank here too, and there is nothing to derive from', () => {
    expect(itemFacts({ weightKg: 0, goods: [{ name: 'x' }] })[0]!.weightKg).toBeNull();
    expect(itemFacts({ weightKg: 250, goods: [{ name: 'x', quantity: 0 }] })[0]!.quantity).toBeNull();
  });

  it('no goods at all is ONE absence, not three', () => {
    // The per-line questions must not pile onto «tovar nomi». It falls out of
    // `[].some()` being false rather than out of a guard, which is why it is
    // asserted here: the mechanism is invisible and easy to «improve» away.
    expect(missingFields('rastamojka', { weightKg: 250, volumeM3: 3, goods: [] })).toEqual([
      'goods',
    ]);
  });

  it('freight asks for neither — a truck is priced on the totals', () => {
    const facts = { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg: 250, volumeM3: 3, goods: [{ name: 'Chexol' }] };
    expect(missingFields('yolkira', facts)).toEqual([]);
    expect(missingFields('rastamojka', facts)).toEqual(['itemQuantity']);
  });

  it('the summary prints the line’s own figures, derived weight included', () => {
    const text = intakeSummaryText({
      section: 'rastamojka',
      facts: { weightKg: 250, volumeM3: 3, goods: [{ name: 'Chexol', quantity: 100 }] },
      clientLabel: 'GS777',
      fileCount: 0,
    });
    expect(text).toContain('100 dona');
    expect(text).toContain('250 kg');
  });
});
