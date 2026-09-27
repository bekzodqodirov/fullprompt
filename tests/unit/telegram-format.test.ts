import { describe, expect, it } from 'vitest';
import {
  a,
  b,
  clipText,
  escapeHtml,
  groupDigits,
  h,
  htmlToPlain,
  packHtmlBlocks,
  plainAsHtml,
  stepBar,
  usd,
  visibleLength,
} from '@/modules/platform/telegram/format';

/**
 * Round C's formatting rules. The escape is the load-bearing one: a single
 * unescaped `<` in a goods name makes Telegram refuse the whole message, and
 * on the arrival path a 400 is PERMANENT — the customer is never told.
 */

describe('escaping', () => {
  it('escapes exactly the three characters Telegram HTML needs', () => {
    expect(escapeHtml('Кабель <USB> & «зарядка» > 2м')).toBe('Кабель &lt;USB&gt; &amp; «зарядка» &gt; 2м');
    expect(h(null)).toBe('');
    expect(h(12.5)).toBe('12.5');
  });

  it('a typed value inside markup round-trips to the same visible text', () => {
    const name = 'A&B <shop>';
    const html = `${b(h(name))} — 5`;
    expect(html).toBe('<b>A&amp;B &lt;shop&gt;</b> — 5');
    expect(htmlToPlain(html)).toBe('A&B <shop> — 5');
    expect(visibleLength(html)).toBe('A&B <shop> — 5'.length);
  });

  it('a link to anywhere but https/tg prints the text alone', () => {
    expect(a('https://t.me/dilnoza', 'Yozish')).toBe('<a href="https://t.me/dilnoza">Yozish</a>');
    expect(a('http://localhost:3000/x', 'Ochish')).toBe('Ochish');
    expect(a('', 'Ochish')).toBe('Ochish');
    expect(a('https://x.uz/?a="b"&c', 'q')).toBe('<a href="https://x.uz/?a=&quot;b&quot;&amp;c">q</a>');
  });

  it('a stored plain text is escaped whole and only its first line is bolded', () => {
    expect(plainAsHtml('🆕 Yangi vazifa: <tekshir>\n📅 01.01', { boldTitle: true })).toBe(
      '<b>🆕 Yangi vazifa: &lt;tekshir&gt;</b>\n📅 01.01',
    );
    expect(plainAsHtml('bitta qator', { boldTitle: true })).toBe('<b>bitta qator</b>');
    expect(plainAsHtml('a & b')).toBe('a &amp; b');
  });
});

describe('numbers', () => {
  it('groups thousands with a no-break space and keeps the decimals it was given', () => {
    expect(groupDigits(12845.5)).toBe('12 845.5');
    expect(groupDigits(68.5)).toBe('68.5');
    expect(groupDigits(1.02)).toBe('1.02');
    expect(groupDigits(0.2346)).toBe('0.235');
    expect(groupDigits(1_250_000)).toBe('1 250 000');
    expect(groupDigits(-3400)).toBe('-3 400');
    expect(groupDigits(0)).toBe('0');
    expect(groupDigits(Number.NaN)).toBe('0');
  });

  it('prints dollars with two places and the sign before the symbol', () => {
    expect(usd(250)).toBe('$250.00');
    expect(usd(1250)).toBe('$1 250.00');
    expect(usd(-50)).toBe('-$50.00');
    expect(usd(-0.001)).toBe('$0.00');
  });
});

describe('the five-step bar', () => {
  it('fills up to and including the current step', () => {
    expect(stepBar(0, 5)).toBe('🟩⬜⬜⬜⬜');
    expect(stepBar(2, 5)).toBe('🟩🟩🟩⬜⬜');
    expect(stepBar(4, 5)).toBe('🟩🟩🟩🟩🟩');
    expect(stepBar(9, 5)).toBe('🟩🟩🟩🟩🟩');
  });
});

describe('packing blocks into messages', () => {
  it('never splits a block and never cuts a tag', () => {
    const block = (n: number) => `<b>${n}</b> ${'x'.repeat(40)}`;
    const blocks = Array.from({ length: 30 }, (_, k) => block(k));
    const messages = packHtmlBlocks(blocks, 200);
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) {
      expect(visibleLength(m)).toBeLessThanOrEqual(200);
      expect(m.match(/<b>/g)?.length).toBe(m.match(/<\/b>/g)?.length);
    }
    expect(messages.join('\n\n')).toBe(blocks.join('\n\n'));
  });

  it('a single block bigger than a message is cut as PLAIN text, nothing lost', () => {
    const huge = `<b>Title</b>\n${'line &amp; more\n'.repeat(40)}`;
    const messages = packHtmlBlocks([huge], 100);
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) expect(m).not.toContain('<b>');
    expect(messages.map(htmlToPlain).join('\n').replace(/\s+/g, ' ')).toContain('line & more');
  });
});

describe('clipText — a cut is on a whole character (round C review, CONV-2/PA-3)', () => {
  it('counts code points, so an emoji at the edge survives whole or not at all', () => {
    const text = `${'a'.repeat(9)}😀bbb`;
    expect(clipText(text, 11)).toBe(`${'a'.repeat(9)}😀…`);
    expect(clipText(text, 10)).toBe(`${'a'.repeat(9)}…`);
    // A slice would have left a lone surrogate here — jsonb refuses one.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clipText(text, 11))).toBe(false);
  });

  it('leaves a short text exactly as it came', () => {
    expect(clipText('salom', 5)).toBe('salom');
    expect(clipText('😀😀', 2)).toBe('😀😀');
  });
});
