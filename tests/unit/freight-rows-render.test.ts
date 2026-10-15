// FIRST: the components compile to the classic `React.createElement`.
import '../fixtures/react-global';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { FREIGHT_PREVIEW_CAP, FreightLotRows } from '@/components/freight-views';
import { rollupClients } from '@/modules/wms/costing/freight-split';
import type { LotView, SplitView } from '@/modules/wms/costing/freight-types';

/**
 * The split's rows RENDERED (judge J9, J14): the add form's preview shows the
 * first five clients and one «+N mijoz» button whose dollars are the hidden
 * clients' lots, so the shown rows plus the button are the bill; and a client
 * header's dollars are the sum of its lots' cents — never a second split.
 *
 * Literals by hand: $100.10 over lot values 110 + 605 (client A's yostiq and
 * kafel), 300, 160, 50, 40, 30, 20 = 1315, cents by the largest remainder in
 * key order → a1 8.37, a2 46.05, b 22.84, c 12.18, e 3.81, f 3.05, g 2.28,
 * h 1.52. A = 54.42 — a second split over the CLIENTS would say 54.43 (and
 * f 3.04); hidden (g, h) = 3.80.
 */
const uz = JSON.parse(readFileSync('messages/uz.json', 'utf8'));

const lot = (id: string, client: string, value: number): LotView => ({
  key: `l:${id}`,
  lotId: id,
  receiptId: `r-${client}`,
  receiptNumber: null,
  clientKey: `c:${client}`,
  clientLabel: client.toUpperCase(),
  label: `${client.toUpperCase()}-${id}`,
  goods: '',
  m3: 1,
  density: 100,
  band: { min: 1, max: 100, perKg: false, price: 110 },
  share: value / 1315,
});
const { lots, clients } = rollupClients([
  lot('a1', 'a', 110),
  lot('a2', 'a', 605),
  lot('b', 'b', 300),
  lot('c', 'c', 160),
  lot('e', 'e', 50),
  lot('f', 'f', 40),
  lot('g', 'g', 30),
  lot('h', 'h', 20),
]);
const view: SplitView = { kind: 'split', lots, clients };

const render = (cap?: number) =>
  renderToStaticMarkup(
    h(NextIntlClientProvider, {
      locale: 'uz',
      messages: uz,
      timeZone: 'Asia/Tashkent',
      children: h(FreightLotRows, { view, money: true, amount: 100.1, currency: 'USD', limit: 10, cap }),
    }),
  );

describe('the add form’s preview is capped, and its dollars still add up to the bill (judge J9)', () => {
  it('five clients, the largest first, then «+2 mijoz · 3.80 USD»; the two smallest are not in the DOM', () => {
    expect(FREIGHT_PREVIEW_CAP).toBe(5);
    const html = render(FREIGHT_PREVIEW_CAP);
    for (const c of ['a', 'b', 'c', 'e', 'f']) expect(html).toContain(`data-testid="freight-row-c:${c}"`);
    for (const c of ['g', 'h']) expect(html).not.toContain(`data-testid="freight-row-c:${c}"`);
    expect(html).toContain('data-testid="freight-row-summary"');
    expect(html).toMatch(/data-testid="freight-row-more"[^>]*>\+2 mijoz · 3\.80 USD</);
  });

  it('uncapped (the saved fold, the re-basis fold) every client is drawn and there is no button', () => {
    const html = render();
    for (const c of ['a', 'b', 'c', 'e', 'f', 'g', 'h']) expect(html).toContain(`data-testid="freight-row-c:${c}"`);
    expect(html).not.toContain('freight-row-more');
    expect(html).not.toContain('freight-row-summary');
  });

  it('a client header is the SUM of its lots’ cents: A 8.37 + 46.05 = 54.42, its lots folded until pressed', () => {
    const html = render(FREIGHT_PREVIEW_CAP);
    expect(html).toMatch(/data-testid="freight-row-c:a"[\s\S]*?· 54\.42 USD/);
    expect(html).not.toContain('data-testid="freight-row-l:a1"');
    expect(html).toMatch(/data-testid="freight-row-c:b"[\s\S]*?· 22\.84 USD/);
    expect(html).toMatch(/data-testid="freight-row-c:f"[\s\S]*?· 3\.05 USD/);
  });
});

describe('a claimed lot that keeps its marking names its client (the review as built)', () => {
  it('«470-A» claimed by GS500: the one-lot row reads «GS500 · 470-A · Kafel»; an unclaimed one stays its marking', () => {
    const claimed: LotView = { ...lot('x', 'x', 100), label: '470-A', clientKey: 'c:x', clientLabel: 'GS500', goods: 'Kafel', share: 0.6 };
    const open: LotView = { ...lot('y', 'y', 100), label: 'MANIKEN-A', clientKey: 'r:y', clientLabel: 'MANIKEN', share: 0.4 };
    const two = rollupClients([claimed, open]);
    const html = renderToStaticMarkup(
      h(NextIntlClientProvider, {
        locale: 'uz',
        messages: uz,
        timeZone: 'Asia/Tashkent',
        children: h(FreightLotRows, { view: { kind: 'split', ...two }, money: false, amount: null, currency: 'USD', limit: 10 }),
      }),
    );
    expect(html).toContain('GS500 · 470-A · Kafel');
    expect(html).toContain('MANIKEN-A');
    expect(html).not.toContain('MANIKEN · MANIKEN-A');
  });
});
