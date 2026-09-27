import { describe, expect, it } from 'vitest';
import { boxWord, clientLabels, CLIENT_LOCALES, fillLabel } from '@/modules/platform/telegram/client-labels';
import { CARGO_STAGES, MILESTONES, milestoneOf } from '@/modules/wms/client-cabinet/stages';

/**
 * Round C's shared words: the five-step bar, the counted box, the filled
 * label. The bar is the one a customer reads first, so its two properties are
 * pinned over the WHOLE ladder rather than by example.
 */

describe('the five steps', () => {
  it('never go backwards along the ladder, and cover every step', () => {
    let previous = -1;
    const seen = new Set<number>();
    for (const stage of CARGO_STAGES) {
      const step = milestoneOf(stage);
      expect(step, stage).toBeGreaterThanOrEqual(previous);
      previous = step;
      seen.add(step);
    }
    expect([...seen].sort()).toEqual(MILESTONES.map((_, i) => i));
  });

  it('put the ends where a customer expects them', () => {
    expect(milestoneOf('cn_warehouse')).toBe(0);
    expect(milestoneOf('hub')).toBe(1); // a direct route skips the hub: still one step
    expect(milestoneOf('in_uz')).toBe(2);
    expect(milestoneOf('ready')).toBe(3);
    expect(milestoneOf('issued')).toBe(4);
  });

  it('every step has a label in every language (#163)', () => {
    for (const locale of CLIENT_LOCALES) {
      const t = clientLabels(locale) as unknown as Record<string, string>;
      for (const m of MILESTONES) {
        const key = `ms${m.charAt(0).toUpperCase()}${m.slice(1)}`;
        expect(t[key], `${locale} ${key}`).toBeTruthy();
        expect(t[key]!.length).toBeGreaterThan(3);
      }
    }
  });
});

describe('counting boxes', () => {
  it('Russian has three forms and 21 is «one»', () => {
    expect(boxWord(1, 'ru')).toBe('коробка');
    expect(boxWord(3, 'ru')).toBe('коробки');
    expect(boxWord(12, 'ru')).toBe('коробок');
    expect(boxWord(21, 'ru')).toBe('коробка');
    expect(boxWord(25, 'ru')).toBe('коробок');
  });

  it('English has two, Uzbek one, and an unknown language falls back like every label', () => {
    expect(boxWord(1, 'en')).toBe('box');
    expect(boxWord(21, 'en')).toBe('boxes');
    expect(boxWord(1, 'uz')).toBe('quti');
    expect(boxWord(7, 'uz')).toBe('quti');
    expect(boxWord(5, null)).toBe(boxWord(5, 'ru'));
  });
});

describe('filling a label', () => {
  it('fills what it is given and leaves the rest visible', () => {
    expect(fillLabel('💬 Menejer: {name}', { name: 'Dilnoza' })).toBe('💬 Menejer: Dilnoza');
    expect(fillLabel('{n} olib ketishga tayyor · {x}', { n: 5 })).toBe('5 olib ketishga tayyor · {x}');
  });
});
