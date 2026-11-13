// FIRST: the components compile to the classic `React.createElement`.
import '../fixtures/react-global';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

/**
 * The prixod card's «Hisob» cell, RENDERED (the merged card's review, XF-2).
 *
 * A link the list does not hold — a calculation of the deal a client
 * correction left the prixod on, or one past the twenty newest — used to be a
 * select holding a value none of its options had: it SHOWED «—» while holding
 * the link, so choosing «—» changed nothing, «Saqlash» never drew, and the
 * link could never be cleared from the card. The browser cannot arrange that
 * state without a sealed calculation; the render can.
 */

vi.mock('@/app/(protected)/hisoblash/nazorat/actions', () => ({ setCalcLinkAction: async () => ({ ok: true }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('next/link', () => ({ default: (props: Record<string, unknown>) => h('a', props) }));

import { CalcLink } from '@/app/(protected)/receipts/[id]/calc-link';

const uz = JSON.parse(readFileSync('messages/uz.json', 'utf8')) as { calc: Record<string, string> };
const render = (currentId: string | null, options: { requestId: string }[]) =>
  renderToStaticMarkup(
    h(NextIntlClientProvider, {
      locale: 'uz',
      messages: uz,
      timeZone: 'Asia/Tashkent',
      children: h(CalcLink, {
        receiptId: 'r-1',
        currentId,
        currentHref: null,
        confirmed: false,
        options: options.map((o) => ({ ...o, section: 'rastamojka', sealedAt: '2026-11-11', volumeM3: null, weightKg: null })),
      }),
    }),
  );
const optionsOf = (html: string) => [...html.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map((m) => ({ attrs: m[1]!, text: m[2]! }));

describe('a link the list does not hold is still an option of its own', () => {
  it('drawn, disabled and SELECTED — so «—» is a different answer and clears it', () => {
    const options = optionsOf(render('req-left-over', [{ requestId: 'req-own' }]));
    const current = options.find((o) => o.attrs.includes('value="req-left-over"'));
    expect(current).toBeDefined();
    expect(current!.attrs).toContain('disabled');
    expect(current!.attrs).toContain('selected');
    expect(current!.text).toBe(uz.calc.linkCurrentElsewhere);
    // «—» is there to be chosen, and it is not the selected one.
    const none = options.find((o) => o.attrs.includes('value=""'));
    expect(none!.attrs).not.toContain('selected');
  });

  it('not drawn when the list holds the link, nor when there is none', () => {
    expect(optionsOf(render('req-own', [{ requestId: 'req-own' }])).filter((o) => o.attrs.includes('disabled'))).toEqual([]);
    expect(optionsOf(render(null, [{ requestId: 'req-own' }])).filter((o) => o.attrs.includes('disabled'))).toEqual([]);
  });
});
