// FIRST: the components compile to the classic `React.createElement`.
import '../fixtures/react-global';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

// The fold's buttons call server actions; a render needs none of them, and
// importing the real module would drag the database into a pure render.
vi.mock('@/app/(protected)/hisoblash/actions', () => ({}));

import { NotAnEstimate } from '@/app/(protected)/hisoblash/[id]/calc-actions';

/**
 * «Bu taxmin rasmiy narx emas» — at the one box where it would become one
 * (docs/SAKKIZ-R2.md §7.2.9, law-money-1; his 2.4 b reason, kept under his
 * 2.4 c).
 *
 * The bot now prints «Aniq», «Taxminiy» and «JAMI taxminiy» in Telegram and
 * on the lenta, and a figure typed into «Готово» becomes `answer_amount`:
 * the upsale's floor, the card's quote lock, a price-channel post and the
 * seller's «✅ Hisoblash tayyor». The reminder must stand exactly where the
 * fold asks for a typed figure — `canSeal` false — and nowhere else, where a
 * sentence about copying numbers would be noise. So: rendered (the words a
 * VED reads), and pinned by source shape to the price-box branch.
 */
const uz = JSON.parse(readFileSync('messages/uz.json', 'utf8'));

const strip = (text: string) =>
  text.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SOURCE = strip(readFileSync('src/app/(protected)/hisoblash/[id]/calc-actions.tsx', 'utf8'));

describe('the «Готово» price box says the bot’s figures are not official', () => {
  it('renders the uz words of calc.finishNotEstimate', () => {
    const html = renderToStaticMarkup(
      h(NextIntlClientProvider, {
        locale: 'uz',
        messages: uz,
        timeZone: 'Asia/Tashkent',
        children: h(NotAnEstimate),
      }),
    );
    expect(html).toContain('data-testid="calc-finish-not-estimate"');
    expect(html).toContain('rasmiy narx emas');
    expect(html).toContain('«JAMI taxminiy»');
    // The words are the bundle's, verbatim — no second copy in the component.
    expect(html).toContain(String(uz.calc.finishNotEstimate).slice(0, 40));
  });

  it('is rendered once, inside the branch that asks for a typed figure (!canSeal)', () => {
    const uses = [...SOURCE.matchAll(/<NotAnEstimate\b/g)];
    expect(uses).toHaveLength(1);
    const at = uses[0]!.index!;
    // Inside the finish fold…
    const fold = SOURCE.indexOf("mode === 'finish'");
    expect(fold).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(fold);
    // …guarded by the same condition that hides the price box when the job
    // could be sealed instead, and before the amount input it speaks about.
    expect(SOURCE.slice(at - 40, at)).toMatch(/\{!canSeal \? $/);
    const amount = SOURCE.indexOf('data-testid="calc-answer-amount"');
    expect(amount).toBeGreaterThan(at);
  });
});
