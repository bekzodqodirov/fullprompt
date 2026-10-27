import { describe, expect, it } from 'vitest';
import { parseManualFacts, totalWeightFrom } from '@/modules/wms/calc/intake-manual';
import {
  LONE_NETTO_NOTE,
  LONE_WEIGHT_NOTE,
  factsVolumeM3,
  intakeSummaryText,
  landingItems,
  missingFields,
  weightFromTotalNote,
} from '@/modules/wms/calc/intake';
import { readIntakeResponse } from '@/modules/wms/calc/intake-ai';
import type { NeedLaw } from '@/modules/wms/calc/needs';

/**
 * WHICH weight a typed or read total is (round 2's merged review, PF-1 to
 * PF-3).
 *
 * The bot asks the shipment's total as BRUTTO on every freight section (his
 * 2.7 b) — a truck carries the cartons too. Three holes let something else
 * answer that question or wear its name:
 *
 *  - PF-1: a figure the text labels NETTO («Netto 1200 kg», «N.W. 1200 kg»)
 *    was read as the total, the brutto question skipped and the seller told
 *    «brutto og‘irlik bor»;
 *  - PF-2: two goods lines stating the SAME figures were read as one stated
 *    total, so the truck was priced on one line's cube;
 *  - PF-3: on a customs job whose document gave only the netto, the single
 *    line's copied weight was labelled «brutto» on the card and in Telegram,
 *    while the AI izohi on the same lenta said «faqat netto».
 *
 * The corpus pins the reader's freight-safe default (c2278-c2282); this file
 * pins what depends on the SECTION, the model's half, and the labels.
 */
const noLaws = new Map<string, NeedLaw>();

describe('a NETTO total stands only where nobody asks a brutto (PF-1, PF-3)', () => {
  const text = 'Kurtka 300 dona\nNetto 1200 kg';

  it('on a customs job the netto is the total, and is flagged as one', () => {
    const facts = parseManualFacts(text, 'rastamojka');
    expect(facts.weightKg).toBe(1200);
    expect(facts.weightNetto).toBe(true);
    // The single line takes it — and its note says NETTO, never brutto.
    const [line] = landingItems(facts);
    expect(line!.weightKg).toBe(1200);
    expect(line!.note).toBe(LONE_NETTO_NOTE);
    expect(weightFromTotalNote(line!.note)).toBe('netto');
  });

  it('on a freight section it is not the brutto — the weight stays missing, so the bot asks', () => {
    for (const section of ['yolkira', 'podklyuch'] as const) {
      const facts = parseManualFacts(text, section);
      expect(facts.weightKg, section).toBeNull();
      expect(facts.weightNetto, section).toBeUndefined();
      expect(missingFields(section, facts, noLaws), section).toContain('weightKg');
    }
  });

  it('a brutto beside it answers on every section, unlabelled', () => {
    const facts = parseManualFacts('Kurtka 300 dona\nBrutto 1300 kg\nNetto 1200 kg', 'rastamojka');
    expect(facts.weightKg).toBe(1300);
    expect(facts.weightNetto).toBeUndefined();
    expect(landingItems(facts)[0]!.note).toBe(LONE_WEIGHT_NOTE);
  });

  it('«1300 kg netto 1200 kg»: a netto word followed by a number labels the NEXT figure', () => {
    expect(parseManualFacts('Kurtka 300 dona\n1300 kg netto 1200 kg', 'podklyuch').weightKg).toBe(1300);
  });
});

describe('the model’s netto, under the same rule (totalWeightFrom)', () => {
  const read = { weightKg: 1200, weightNetto: true as const };

  it('a freight section does not believe a netto reading — null, and the brutto is asked', () => {
    expect(totalWeightFrom('podklyuch', { weightKg: null }, read, false)).toEqual({ weightKg: null });
    expect(totalWeightFrom('yolkira', { weightKg: null }, read, false)).toEqual({ weightKg: null });
  });

  it('a customs job takes it, flagged', () => {
    expect(totalWeightFrom('rastamojka', { weightKg: null }, read, false)).toEqual({ weightKg: 1200, weightNetto: true });
  });

  it('the typed figure wins, and a total asked two ways is answered by neither', () => {
    expect(totalWeightFrom('podklyuch', { weightKg: 3500 }, read, false)).toEqual({ weightKg: 3500 });
    expect(totalWeightFrom('rastamojka', { weightKg: null }, { weightKg: 900 }, true)).toEqual({ weightKg: null });
  });

  it('the reading carries the model’s weight_netto only beside a figure', () => {
    const answer = (body: object) =>
      readIntakeResponse({
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({ from_city: null, to_city: null, volume_m3: null, goods: [], steps: [], ...body }),
          },
        ],
      });
    const netto = answer({ weight_kg: 1200, weight_netto: true });
    expect(netto.ok && netto.facts.weightNetto).toBe(true);
    // An answer from before the field still parses — «not said» is brutto.
    const old = answer({ weight_kg: 1200 });
    expect(old.ok && old.facts.weightNetto).toBeUndefined();
    const none = answer({ weight_kg: null, weight_netto: true });
    expect(none.ok && none.facts.weightNetto).toBeUndefined();
  });
});

describe('a goods line’s own figure is that line’s (PF-2)', () => {
  it('two lines stating the same figures: no total, the cube is their Σ', () => {
    const facts = parseManualFacts('Kurtka 300 dona 400 kg 5 kub\nShim 200 dona 400 kg 5 kub\nYiwu → Toshkent', 'yolkira');
    expect(facts.weightKg).toBeNull();
    expect(facts.volumeM3).toBeNull();
    // Σ 5 + 5 — the landing stores it, labelled «qatorlardan».
    expect(factsVolumeM3(facts)).toBe(10);
  });

  it('ONE goods line keeps its figure as the shipment’s — there the line is the shipment', () => {
    const facts = parseManualFacts('Kurtka 300 dona 400 kg 5 kub\nYiwu → Toshkent', 'yolkira');
    expect(facts.weightKg).toBe(400);
    expect(facts.volumeM3).toBe(5);
  });
});

describe('the summary says which weight the seller confirms', () => {
  it('«(brutto)» on a freight section, «(netto)» on a netto customs total, plain otherwise', () => {
    const summary = (section: 'yolkira' | 'podklyuch' | 'rastamojka', text: string) =>
      intakeSummaryText({ section, facts: parseManualFacts(text, section), laws: noLaws, clientLabel: null, fileCount: 0 });
    expect(summary('podklyuch', 'Kurtka 300 dona\nJami 3500 kg 12 kub')).toContain('Og‘irlik (brutto): 3500 kg');
    expect(summary('rastamojka', 'Kurtka 300 dona\nNetto 1200 kg')).toContain('Og‘irlik (netto): 1200 kg');
    expect(summary('rastamojka', 'Kurtka 300 dona\nJami 1200 kg')).toContain('Og‘irlik: 1200 kg');
  });
});
