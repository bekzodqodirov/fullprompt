import { describe, expect, it } from 'vitest';
import { factsVolumeM3, intakeNoteText, intakeSummaryText, missingFields, type CalcFacts } from '@/modules/wms/calc/intake';

/**
 * The shipment's cubic metres SUMMED from its lines (his 2.7 b,
 * docs/SAKKIZ-R2.md §8.2.2) — what the collector, the checklist and the
 * summary read, and why a STORED request reads nothing of the kind
 * (`totalsStored`, judge regression-3). Pure: the landing's half is
 * tests/integration/calc-intake.integration.test.ts, the stored half
 * tests/integration/stored-volume.integration.test.ts.
 */

const noLaws = new Map();
const road = { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg: 3500 } as const;

describe('factsVolumeM3 — over the DOOR-ROUTED rows', () => {
  it('«Kafel 2 kub» is a volume only once the door routes it (probe P4)', () => {
    // The bot's read facts carry «2» in the piece column with the unit word
    // «kub»; only `doorRow` moves it into the volume — the column
    // `openCalcRequest` stores it in. A Σ over the read facts as they stand
    // would find no volume at all, and the checklist would ask a total the
    // landing is about to store.
    const facts: CalcFacts = { goods: [{ name: 'Kafel', quantity: 2, unit: 'kub' }] };
    expect(factsVolumeM3(facts)).toBe(2);
  });

  it('every line or none, half-up to the thousandth, and a stated total wins', () => {
    const lines = (...m3: (number | null)[]): CalcFacts => ({
      goods: m3.map((volumeM3, i) => ({ name: `Tovar ${i + 1}`, quantity: 10, volumeM3 })),
    });
    expect(factsVolumeM3(lines(1.2, 1.6))).toBe(2.8);
    expect(factsVolumeM3(lines(0.1, 0.2))).toBe(0.3);
    expect(factsVolumeM3(lines(1.2, null))).toBeNull();
    expect(factsVolumeM3({ goods: [] })).toBeNull();
    expect(factsVolumeM3({ ...lines(1.2, 1.6), volumeM3: 5 })).toBe(5);
    // A typed 0 is a blank somebody typed over — the checklist's own reading.
    expect(factsVolumeM3({ ...lines(1.2, 1.6), volumeM3: 0 })).toBe(2.8);
  });

  it('a STORED request derives nothing — its column is what the engine prices', () => {
    const stored: CalcFacts = {
      volumeM3: null,
      goods: [{ name: 'Kurtka', quantity: 300, volumeM3: 1.2 }],
      totalsStored: true,
    };
    expect(factsVolumeM3(stored)).toBeNull();
  });
});

describe('the checklist asks a total only when the lines cannot give it', () => {
  it('yolkira: every line states m³ → no «umumiy hajmi»; one does not → asked', () => {
    const all: CalcFacts = {
      ...road,
      goods: [
        { name: 'Kurtka', quantity: 300, volumeM3: 1.2 },
        { name: 'Shim', quantity: 200, volumeM3: 1.6 },
      ],
    };
    expect(missingFields('yolkira', all, noLaws)).not.toContain('volumeM3');
    const one: CalcFacts = { ...all, goods: [all.goods![0]!, { name: 'Shim', quantity: 200 }] };
    expect(missingFields('yolkira', one, noLaws)).toContain('volumeM3');
  });

  it('a STORED request with a null volume STILL lists it, whatever its lines say (regression-3)', () => {
    // The workspace's freight refuses `measure_missing` on exactly this row;
    // a chip that said «complete» here would disagree with that refusal (#649).
    const stored: CalcFacts = {
      ...road,
      volumeM3: null,
      goods: [{ name: 'Kurtka', quantity: 300, volumeM3: 1.2 }],
      totalsStored: true,
    };
    expect(missingFields('yolkira', stored, noLaws)).toContain('volumeM3');
    expect(missingFields('rastamojka', stored, noLaws)).toContain('volumeM3');
  });

  it('the WEIGHT is asked even when every line states its kilos — they are netto', () => {
    // His 2.7 b: line kilos are netto, the truck's are brutto; a Σ of the
    // lines would be a different, smaller number wearing the shipment's name.
    const facts: CalcFacts = {
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      goods: [
        { name: 'Kurtka', quantity: 300, weightKg: 150, volumeM3: 1.2 },
        { name: 'Shim', quantity: 200, weightKg: 100, volumeM3: 1.6 },
      ],
    };
    expect(missingFields('yolkira', facts, noLaws)).toEqual(['weightKg']);
    expect(missingFields('podklyuch', facts, noLaws)).toEqual(['weightKg']);
  });
});

describe('a summed volume is SAID where it is printed', () => {
  const facts: CalcFacts = {
    ...road,
    goods: [
      { name: 'Kurtka', quantity: 300, volumeM3: 1.2 },
      { name: 'Shim', quantity: 200, volumeM3: 1.6 },
    ],
  };

  it('the summary and the lenta note print «(qatorlardan)» beside the Σ', () => {
    const summary = intakeSummaryText({ section: 'yolkira', facts, laws: noLaws, clientLabel: null, fileCount: 0 });
    expect(summary).toContain('Hajm: 2.8 m³ (qatorlardan)');
    expect(summary).toContain('✅');
    const note = intakeNoteText({ section: 'yolkira', facts, laws: noLaws, steps: [], collectedBy: 'Sotuvchi', fileCount: 0 });
    expect(note).toContain('Hajm: 2.8 m³ (qatorlardan)');
  });

  it('a typed total prints as before, with no label', () => {
    const summary = intakeSummaryText({
      section: 'yolkira',
      facts: { ...facts, volumeM3: 3 },
      laws: noLaws,
      clientLabel: null,
      fileCount: 0,
    });
    expect(summary).toContain('Hajm: 3 kub');
    expect(summary).not.toContain('qatorlardan');
  });

  it('the weight is asked as BRUTTO, in the words the checklist prints', () => {
    const summary = intakeSummaryText({
      section: 'yolkira',
      facts: { ...facts, weightKg: null },
      laws: noLaws,
      clientLabel: null,
      fileCount: 0,
    });
    expect(summary).toContain('umumiy brutto og‘irligi (kg, qadoq bilan)');
  });
});
