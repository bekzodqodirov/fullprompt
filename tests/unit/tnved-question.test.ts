import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lineQuestion, tnvedQuestionText } from '@/modules/wms/tnved/service';

/**
 * What the 🤖 is ASKED about a lot tarkibi line (the owner's item 5,
 * 2026-11-10; docs/TARKIB-TUZATISH.md §5). The rule is a pure function so it
 * can be read here: a prompt nobody can test is a prompt that drifts.
 *
 * The lot throughout: 100 cartons received as «键盘 (Клавиатура)».
 */
const LOT = { zh: '键盘', ru: 'Клавиатура' };
const line = (name: string, over: Partial<{ pieces: number | null; cartons: number | null; kg: string; m3: string }> = {}) => ({
  name,
  pieces: 500,
  cartons: 50,
  kg: '60.000',
  m3: '0.8000',
  ...over,
});

describe('the question for a tarkib line', () => {
  it('a line that IS the lot’s own good asks the product row’s question — the Chinese name with the Russian', () => {
    // «Bitta tovar»: one line, named as the lot, made only to state the pieces.
    for (const name of ['Клавиатура', '键盘', '  клавиатура ']) {
      const q = lineQuestion({ lot: LOT, line: line(name), siblings: [] });
      expect([q.nameZh, q.nameRu], name).toEqual(['键盘', 'Клавиатура']);
      expect(q.context.join('\n'), name).not.toContain('приняты');
    }
  });

  it('any other line asks about ITS name alone — the lot’s Chinese name is never the goods name', () => {
    const q = lineQuestion({ lot: LOT, line: line('Мышь'), siblings: ['Клавиатура'] });
    expect([q.nameZh, q.nameRu]).toEqual(['Мышь', null]);
    const text = tnvedQuestionText(q);
    // The first line is the whole of what is classified…
    expect(text.split('\n')[0]).toBe('Товар: Мышь');
    // …and the warehouse's word for the cartons is a statement in the context.
    expect(text).toContain('приняты под названием «键盘 (Клавиатура)»');
    expect(text.indexOf('键盘')).toBeGreaterThan(text.indexOf('Контекст'));
  });

  it('the photograph only when the tarkib has ONE line — a lot of several goods shows one of them', () => {
    expect(lineQuestion({ lot: LOT, line: line('Клавиатура'), siblings: [] }).wantsPhoto).toBe(true);
    // One line of ANOTHER good: every carton is that good, so the photo is its photo.
    expect(lineQuestion({ lot: LOT, line: line('Мышь'), siblings: [] }).wantsPhoto).toBe(true);
    expect(lineQuestion({ lot: LOT, line: line('Клавиатура'), siblings: ['Мышь'] }).wantsPhoto).toBe(false);
    expect(lineQuestion({ lot: LOT, line: line('Мышь'), siblings: ['Клавиатура'] }).wantsPhoto).toBe(false);
  });

  it('the line’s own figures, as a person writes them, and never a zero or an absent one', () => {
    const full = lineQuestion({ lot: LOT, line: line('Мышь'), siblings: [] }).context[0];
    expect(full).toBe('Количество этого товара: 500 шт · 50 кор. · 60 кг · 0.8 м³');
    // «Aralash»: no cartons per line, no pieces stated.
    const mixed = lineQuestion({ lot: LOT, line: line('Мышь', { pieces: null, cartons: null, kg: '12.500' }), siblings: [] });
    expect(mixed.context[0]).toBe('Количество этого товара: 12.5 кг · 0.8 м³');
  });

  it('the siblings are named, in order, and CAPPED — twenty names are a list to classify, not a hint', () => {
    const names = Array.from({ length: 9 }, (_, i) => `Товар ${i + 1}`);
    const q = lineQuestion({ lot: LOT, line: line('Мышь'), siblings: names });
    const said = q.context.find((c) => c.startsWith('В тех же коробках'))!;
    expect(said).toBe('В тех же коробках лежат и другие товары: Товар 1; Товар 2; Товар 3; Товар 4; Товар 5; Товар 6 и ещё 3');
    // A paragraph pasted as a name does not become the prompt.
    const long = lineQuestion({ lot: LOT, line: line('Мышь'), siblings: ['я'.repeat(400)] });
    expect(long.context.at(-1)!.length).toBeLessThan(160);
  });
});

describe('the text the model reads', () => {
  it('with no context it is the sentence the 🤖 has always sent — a product row’s answer does not move', () => {
    expect(tnvedQuestionText({ nameZh: '键盘', nameRu: 'Клавиатура' })).toBe('Товар: 键盘 (Клавиатура)');
    expect(tnvedQuestionText({ nameZh: '键盘', nameRu: null })).toBe('Товар: 键盘');
    expect(tnvedQuestionText({ nameZh: '键盘', nameRu: null, context: [] })).toBe('Товар: 键盘');
    expect(tnvedQuestionText({ nameZh: '键盘', nameRu: null, context: ['  '] })).toBe('Товар: 键盘');
  });

  it('the context is a labelled block of statements under the good, never a second «Товар»', () => {
    const text = tnvedQuestionText({ nameZh: 'Мышь', nameRu: null, context: ['один', 'два'] });
    expect(text).toBe('Товар: Мышь\nКонтекст (только подсказка):\n- один\n- два');
    expect(text.match(/Товар:/g)).toHaveLength(1);
  });

  it('the system prompt tells the model the context is a hint, and the call has room to think', () => {
    const src = readFileSync('src/modules/wms/tnved/service.ts', 'utf8');
    expect(src).toContain('Классифицируй ТОЛЬКО «Товар»');
    // The analyst model thinks INSIDE max_tokens: at 2048 a hard good left
    // the JSON no room and the person read «AI javob bermadi».
    expect(src).toMatch(/const SUGGEST_MAX_TOKENS = 16000;/);
    expect(src).toMatch(/max_tokens: SUGGEST_MAX_TOKENS,/);
    // …and a cut-off answer is named in the log, not folded into «unreadable».
    expect(src).toContain("'[tnved] suggestion cut at max_tokens'");
    expect(src).toContain("'[tnved] suggestion failed'");
  });
});
