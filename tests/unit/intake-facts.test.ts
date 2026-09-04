import { describe, expect, it } from 'vitest';
import { parseManualFacts } from '@/modules/wms/calc/intake-manual';
import { intakeSummaryText, missingFields } from '@/modules/wms/calc/intake';

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
