// FIRST: the components compile to the classic `React.createElement`.
import '../fixtures/react-global';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LotGoodsName, LotNameText } from '@/components/lot-goods-name';
import { clipKeepingCount, splitLabelCount, withoutLabelCount } from '@/modules/platform/text/label-count';

/**
 * «Клавиатура +2» must keep its «+2» wherever a string is shortened (the
 * owner's item 4, 2026-11-10 — «yonida + nechta tarkibligi yozilsin»;
 * docs/TARKIB-TUZATISH.md §3). Everything that shortens cuts the END, and
 * the count is the end.
 */
describe('splitLabelCount — the count is found in the text', () => {
  it('a trailing « +N» is the count; the rest is the name', () => {
    expect(splitLabelCount('Клавиатура +2')).toEqual({ name: 'Клавиатура', count: '+2' });
    expect(splitLabelCount('Товар 1 +19')).toEqual({ name: 'Товар 1', count: '+19' });
  });

  it('anything else is a name whole: no space, three digits, a bare count, a plus inside', () => {
    for (const text of ['Клавиатура', 'Модель A+2', 'Клавиатура +123', '+2', 'A +2 B', 'Клавиатура + 2', '']) {
      expect(splitLabelCount(text)).toEqual({ name: text, count: null });
    }
  });
});

describe('clipKeepingCount — the name gives way, the count never does', () => {
  it('a text that fits is untouched', () => {
    expect(clipKeepingCount('Клавиатура +2', 40)).toBe('Клавиатура +2');
  });

  it('a long label is cut in the NAME and still ends in its count, at exactly the limit', () => {
    const label = `${'Клавиатура проводная игровая '.repeat(4).trim()} +12`;
    const clipped = clipKeepingCount(label, 40);
    expect(clipped.endsWith('… +12')).toBe(true);
    expect(Array.from(clipped)).toHaveLength(40);
    expect(clipped.startsWith('Клавиатура проводная игровая')).toBe(true);
  });

  it('a long text with no count is cut at the end, as clipText cuts it', () => {
    const text = 'Клавиатура проводная игровая с подсветкой и подставкой';
    const clipped = clipKeepingCount(text, 20);
    expect(clipped).toBe(`${Array.from(text).slice(0, 19).join('')}…`);
  });

  it('counts code points: an emoji is never halved into a lone surrogate', () => {
    const label = `${'📦'.repeat(30)} +3`;
    const clipped = clipKeepingCount(label, 10);
    expect(Array.from(clipped)).toHaveLength(10);
    expect(clipped.endsWith('… +3')).toBe(true);
    // A lone surrogate would not survive a round trip through encodeURIComponent.
    expect(() => encodeURIComponent(clipped)).not.toThrow();
  });

  it('a limit too small to hold a name beside the count falls back to the plain cut', () => {
    expect(clipKeepingCount('Клавиатура +2', 4)).toBe('Кла…');
  });
});

describe('withoutLabelCount — a pasted label searches for the goods', () => {
  it('drops the count and the outer spaces, leaves an ordinary needle alone', () => {
    expect(withoutLabelCount('  Клавиатура +2 ')).toBe('Клавиатура');
    expect(withoutLabelCount('мышь')).toBe('мышь');
    expect(withoutLabelCount('C++ книга')).toBe('C++ книга');
  });
});

describe('the list cell — «+N» sits outside the element that truncates', () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, '');

  it('a label: the count is its own non-shrinking element and the characters are the same', () => {
    const html = renderToStaticMarkup(h(LotGoodsName, { zh: '键盘', ru: 'Клавиатура +2' }));
    expect(text(html)).toBe('键盘 (Клавиатура +2)');
    const count = /<span class="([^"]*)" data-testid="lot-name-count">([^<]*)<\/span>/.exec(html);
    expect(count?.[1]).toContain('shrink-0');
    expect(count?.[2]).toBe(' +2)');
    // …and the truncating element does not contain it.
    const truncating = /<span class="[^"]*truncate[^"]*">(.*?)<\/span><span class="[^"]*shrink-0/.exec(html);
    expect(truncating?.[1]).not.toContain('+2');
  });

  it('a plain name, and no Russian name at all, are the cell they always were', () => {
    const plain = renderToStaticMarkup(h(LotGoodsName, { zh: '键盘', ru: 'Клавиатура' }));
    expect(text(plain)).toBe('键盘 (Клавиатура)');
    expect(plain).not.toContain('lot-name-count');
    expect(plain).toContain('block truncate');
    const none = renderToStaticMarkup(h(LotGoodsName, { zh: '键盘', ru: null }));
    expect(text(none)).toBe('键盘');
  });

  it('the one-name cell follows the same rule', () => {
    const html = renderToStaticMarkup(h(LotNameText, { text: 'Клавиатура +2' }));
    expect(text(html)).toBe('Клавиатура +2');
    expect(html).toContain('lot-name-count');
    expect(renderToStaticMarkup(h(LotNameText, { text: 'Клавиатура' }))).not.toContain('lot-name-count');
  });
});
