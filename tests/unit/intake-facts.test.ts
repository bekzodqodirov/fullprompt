import { describe, expect, it } from 'vitest';
import { parseManualFacts } from '@/modules/wms/calc/intake-manual';
import {
  LONE_WEIGHT_NOTE,
  intakeSummaryText,
  itemFacts,
  landingItems,
  lineNeeds,
  loneWeightKg,
  missingFields,
} from '@/modules/wms/calc/intake';
import { needLawOf, type NeedLaw } from '@/modules/wms/calc/needs';

/** No line here carries a code the book knows — the law cases build their own. */
const noLaws: ReadonlyMap<string, NeedLaw> = new Map();

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
    expect(missingFields('rastamojka', facts, noLaws)).toContain('weightKg');
    const text = intakeSummaryText({
      section: 'rastamojka',
      facts,
      laws: noLaws,
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

  it('the rule is one function, so all three doors can apply it', () => {
    // The bot and the thread hand over what was READ; the seller's card form
    // hands over what was TYPED. Different shapes, one rule — otherwise the
    // same job lands a different row depending on which door it came through.
    expect(loneWeightKg(1, 250)).toBe(250);
    expect(loneWeightKg(2, 250)).toBeNull();
    expect(loneWeightKg(1, 0)).toBeNull();
    expect(loneWeightKg(1, null)).toBeNull();
    expect(loneWeightKg(0, 250)).toBeNull();
    // …and `itemFacts` is that same function applied to read facts.
    expect(itemFacts({ weightKg: 250, goods: [{ name: 'x' }] })[0]!.weightKg).toBe(
      loneWeightKg(1, 250),
    );
  });

  it('a zero is a blank here too, and there is nothing to derive from', () => {
    expect(itemFacts({ weightKg: 0, goods: [{ name: 'x' }] })[0]!.weightKg).toBeNull();
    expect(itemFacts({ weightKg: 250, goods: [{ name: 'x', quantity: 0 }] })[0]!.quantity).toBeNull();
  });

  it('a line needs ONE measure, never both', () => {
    // `unitsForRow` prices a row per kg OR per dona; asking for both made a
    // multi-line podklyuch from the seller's card form — which has no
    // per-line weight input — permanently incomplete.
    const base = { weightKg: 500, volumeM3: 3 };
    const counted = { ...base, goods: [{ name: 'a', quantity: 4 }, { name: 'b', quantity: 2 }] };
    expect(missingFields('rastamojka', counted, noLaws)).toEqual([]);
    const weighed = { ...base, goods: [{ name: 'a', weightKg: 300 }, { name: 'b', weightKg: 200 }] };
    expect(missingFields('rastamojka', weighed, noLaws)).toEqual([]);
    // …and the law's OWN unit is the third way — m²/juft/litr, typed by the
    // VED in the workspace. Without it the chip stood over a request the
    // engine had fully priced, which is #649 a third time in one round.
    const measured = {
      ...base,
      goods: [{ name: 'a', measureUnit: 'm2' as const, measureQty: 12.5 }, { name: 'b', quantity: 2 }],
    };
    expect(missingFields('rastamojka', measured, noLaws)).toEqual([]);
    // Neither is the one case the engine genuinely cannot value.
    const bare = { ...base, goods: [{ name: 'a', quantity: 4 }, { name: 'b' }] };
    expect(missingFields('rastamojka', bare, noLaws)).toEqual(['itemMeasure']);
  });

  it('no goods at all is ONE absence, not three', () => {
    // The per-line questions must not pile onto «tovar nomi». It falls out of
    // `[].some()` being false rather than out of a guard, which is why it is
    // asserted here: the mechanism is invisible and easy to «improve» away.
    expect(missingFields('rastamojka', { weightKg: 250, volumeM3: 3, goods: [] }, noLaws)).toEqual([
      'goods',
    ]);
  });

  it('freight asks for neither — a truck is priced on the totals', () => {
    const facts = { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg: 250, volumeM3: 3, goods: [{ name: 'Chexol' }] };
    expect(missingFields('yolkira', facts, noLaws)).toEqual([]);
    // The line carries a derived weight (one line, 250 kg total), so it is
    // priceable per kg and nothing is outstanding.
    expect(missingFields('rastamojka', facts, noLaws)).toEqual([]);
  });

  it('the summary prints the line’s own figures, derived weight included', () => {
    const text = intakeSummaryText({
      section: 'rastamojka',
      facts: { weightKg: 250, volumeM3: 3, goods: [{ name: 'Chexol', quantity: 100 }] },
      laws: noLaws,
      clientLabel: 'GS777',
      fileCount: 0,
    });
    expect(text).toContain('100 dona');
    expect(text).toContain('250 kg');
  });
});

describe('a total written with a separator is read, or asked — never guessed (P1.2)', () => {
  it('«1 200 kg» is twelve hundred, not the «200» the old pattern found', () => {
    // A sixfold error on the shipment's weight: `\\d+` stopped at the space.
    expect(parseManualFacts('vazni 1 200 kg, 4 kub').weightKg).toBe(1200);
  });

  it('«1,200 kg» is ambiguous in somebody’s Russian, so it states nothing and is ASKED', () => {
    const facts = parseManualFacts('1,200 kg');
    expect(facts.weightKg).toBeNull();
    expect(facts.ambiguous).toEqual([{ field: 'weightKg', text: '1,200', decimal: 1.2, thousands: 1200 }]);
    const text = intakeSummaryText({
      section: 'rastamojka',
      facts,
      laws: noLaws,
      clientLabel: null,
      fileCount: 0,
      ambiguous: facts.ambiguous,
    });
    // Both readings in the seller's face, and the way to answer each.
    expect(text).toContain('1.2 mi yoki 1200 mi');
  });
});

describe('the LAW decides what a coded line owes (P1.1 / judge TT-5)', () => {
  // PP-3818's own shapes, as the book holds them after the seed: 6110
  // knitwear «20 %, kamida $1/dona», 9403 furniture «… kamida $0.4/kg».
  const laws = new Map<string, NeedLaw>([
    ['6110200000', needLawOf({ dutyMode: 'max', dutyUnit: 'dona', dutySpecific: 1, dutyFree: false })],
    ['9403600000', needLawOf({ dutyMode: 'max', dutyUnit: 'kg', dutySpecific: 0.4, dutyFree: false })],
    ['8528720000', needLawOf({ dutyMode: 'advalor', dutyUnit: null, dutySpecific: null, dutyFree: false })],
  ]);
  const base = { weightKg: 500, volumeM3: 3, lineWeightsStated: true };

  it('a sweater stating only kg owes its COUNT — the floor is per piece', () => {
    // The checklist said «to'liq» here and the engine refused
    // `measure_missing` on the same row: #910 reading the wrong half.
    const facts = { ...base, goods: [{ name: 'Sviter', weightKg: 150, tnvedCode: '6110200000' }] };
    expect(missingFields('rastamojka', facts, laws)).toEqual(['lineNeed']);
    const [line] = lineNeeds('rastamojka', facts, laws);
    expect(line!.units).toEqual(['dona']);
    // Asked with the money reason first («boj kamida $1/dona»).
    expect(line!.pinned[0]!.why).toBe('duty');
  });

  it('a table stating only dona owes its NET WEIGHT', () => {
    const facts = { ...base, goods: [{ name: 'Stol', quantity: 40, tnvedCode: '9403600000' }] };
    expect(missingFields('rastamojka', facts, laws)).toEqual(['lineNeed']);
    expect(lineNeeds('rastamojka', facts, laws)[0]!.units).toEqual(['kg']);
    // …and stating it closes the need.
    const weighed = { ...base, goods: [{ name: 'Stol', quantity: 40, weightKg: 600, tnvedCode: '9403600000' }] };
    expect(missingFields('rastamojka', weighed, laws)).toEqual([]);
  });

  it('an ad-valorem code pins no unit: any one figure answers its baza', () => {
    const weighed = { ...base, goods: [{ name: 'Monitor', weightKg: 80, tnvedCode: '8528720000' }] };
    expect(missingFields('rastamojka', weighed, laws)).toEqual([]);
    // Stating nothing at all is still the one-measure question, not a
    // per-unit one — the VED picks what the baza is per.
    const bare = { ...base, goods: [{ name: 'Monitor', tnvedCode: '8528720000' }] };
    expect(missingFields('rastamojka', bare, laws)).toEqual(['itemMeasure']);
    expect(lineNeeds('rastamojka', bare, laws)[0]!.units).toEqual(['dona', 'kg']);
  });

  it('a volume or a pair is a figure in its own right', () => {
    const facts = {
      ...base,
      goods: [
        { name: 'Paket', volumeM3: 2 },
        { name: 'Kafel', measureUnit: 'm2' as const, measureQty: 120 },
      ],
    };
    expect(missingFields('rastamojka', facts, laws)).toEqual([]);
  });

  it('freight never consults the law', () => {
    const facts = {
      ...base,
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      goods: [{ name: 'Sviter', weightKg: 150, tnvedCode: '6110200000' }],
    };
    expect(missingFields('yolkira', facts, laws)).toEqual([]);
    expect(lineNeeds('yolkira', facts, laws)).toEqual([]);
  });
});

describe('a derived weight is SAID, and a stated one is never overwritten (judge MR-7)', () => {
  it('the bot’s lone line carries the total, labelled brutto in its note', () => {
    const [item] = itemFacts({ weightKg: 250, goods: [{ name: 'Chexol', note: 'qora' }] });
    expect(item!.weightKg).toBe(250);
    expect(item!.weightFromTotal).toBe(true);
    expect(item!.note).toBe(`qora · ${LONE_WEIGHT_NOTE}`);
  });

  it('facts whose line weights were STATED derive nothing from the total', () => {
    // The card form types netto in its own cell and the total box is
    // brutto: copying one into the other wrote brutto under the per-kg baza.
    const [item] = itemFacts({ weightKg: 250, lineWeightsStated: true, goods: [{ name: 'Chexol' }] });
    expect(item!.weightKg).toBeNull();
    expect(item!.weightFromTotal).toBe(false);
    expect(item!.note).toBeNull();
  });

  it('the landing carries every column, the pair and the volume included', () => {
    const [row] = landingItems({
      lineWeightsStated: true,
      goods: [
        {
          name: 'Kafel',
          measureUnit: 'm2',
          measureQty: 120,
          volumeM3: 1.5,
          tnvedCode: '6907210000',
          unit: 'm2',
        },
      ],
    });
    expect(row).toMatchObject({
      name: 'Kafel',
      quantity: null,
      weightKg: null,
      volumeM3: 1.5,
      measureUnit: 'm2',
      measureQty: 120,
      tnvedCode: '6907210000',
    });
  });
});
