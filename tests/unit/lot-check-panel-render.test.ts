// FIRST: the components compile to the classic `React.createElement`.
import '../fixtures/react-global';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

/**
 * The prixod card's two blocks about the client's own ✅ / ❌, RENDERED (the
 * as-built review, lens 3). Every case here is a face the database really
 * produces and that the browser spec never arranges — a previous owner's ✅,
 * a ❌ on cargo that has left China, a question that has waited an hour — so
 * the only place these were ever looked at was the reviewer's own render.
 *
 * The two `'use server'` modules are stubbed (they pull the whole service
 * in); nothing else is — the words are the real Uzbek bundle's.
 */

vi.mock('@/app/(protected)/receipts/[id]/lot-check-actions', () => ({
  checkLotAction: async () => ({ ok: true }),
  uncheckLotAction: async () => ({ ok: true }),
}));
vi.mock('@/app/(protected)/receipts/[id]/client-ask-actions', () => ({
  askClientAction: async () => ({ ok: true }),
  dismissDisputesAction: async () => ({ ok: true }),
}));

import { ClientAskPanel, type ClientAskFace } from '@/app/(protected)/receipts/[id]/client-ask-panel';
import { LotCheckPanel, type LotCheckFace } from '@/app/(protected)/receipts/[id]/lot-check-panel';

const uz = JSON.parse(readFileSync('messages/uz.json', 'utf8')) as { lotCheck: Record<string, string> };
const words = uz.lotCheck;

const wrap = (children: ReturnType<typeof h>) =>
  renderToStaticMarkup(h(NextIntlClientProvider, { locale: 'uz', messages: uz, timeZone: 'Asia/Tashkent', children }));

const SEEN = { nameZh: '键盘', nameRu: 'Клавиатура', boxCount: 3, clientId: 'c-owner' };
const answer = (over: Partial<NonNullable<LotCheckFace['client']>>): NonNullable<LotCheckFace['client']> => ({
  verdict: 'yes',
  day: '2026-11-11',
  token: '2026-11-11 09:05:00+00',
  holds: false,
  vetoes: false,
  ofOwner: true,
  askedBy: null,
  ...over,
});
const face = (over: Partial<LotCheckFace>): LotCheckFace => ({
  state: 'none',
  askable: true,
  byDocument: false,
  documentStale: false,
  person: null,
  client: null,
  ...over,
});
const lotPanel = (f: LotCheckFace, canWrite = true) =>
  wrap(
    h(LotCheckPanel, {
      receiptId: 'r-1',
      lotId: 'l-1',
      face: f,
      seen: SEEN,
      canWrite,
      canRename: true,
      phones: [{ tel: '+998901112233', telegram: null }],
    }),
  );
const has = (html: string, testid: string) => html.includes(`data-testid="${testid}"`);
/** A sentence as the markup carries it — React escapes the apostrophe Uzbek is full of. */
const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

describe('a PREVIOUS owner’s ✅ (the prixod was corrected to another client since)', () => {
  // The sentence reads such a lot «o'zgardi» — the client is one of the facts a ✅ is about, as it is
  // for a colleague's tick — and the worklist links it to the card. The card dropped an answer that
  // is not the owner's and then drew NOTHING: no line, no «✅ To'g'ri», no phones (L3-1).
  const former = face({ state: 'stale', client: answer({ ofOwner: false }) });

  it('while the cargo is still asked about: the reason is said, and the tick is there', () => {
    const html = lotPanel(former);
    expect(has(html, 'lot-check-face-former-owner')).toBe(true);
    expect(html).toContain('2026-11-11');
    expect(has(html, 'lot-check-yes')).toBe(true);
    expect(has(html, 'lot-check-phones')).toBe(true);
    // Nobody's answer: it is neither a ✅ of this client nor a dispute to close.
    expect(has(html, 'lot-check-face-client-yes')).toBe(false);
    expect(has(html, 'lot-check-dispute-close')).toBe(false);
  });

  it('for a reader who may not tick: the line alone', () => {
    const html = lotPanel(former, false);
    expect(has(html, 'lot-check-face-former-owner')).toBe(true);
    expect(has(html, 'lot-check-yes')).toBe(false);
  });

  it('once the cargo has left China it is history, drawn muted — and nothing is asked (his 4a)', () => {
    const html = lotPanel(face({ state: 'stale', askable: false, client: answer({ ofOwner: false }) }));
    expect(has(html, 'lot-check-face-former-owner-old')).toBe(true);
    expect(has(html, 'lot-check-face-former-owner')).toBe(false);
    expect(has(html, 'lot-check-yes')).toBe(false);
  });

  it('a previous owner’s ❌ is nobody’s: the lot reads as never asked, with the tick', () => {
    const html = lotPanel(face({ state: 'none', client: answer({ verdict: 'no', ofOwner: false }) }));
    expect(has(html, 'lot-check-face-none')).toBe(true);
    expect(has(html, 'lot-check-yes')).toBe(true);
    expect(has(html, 'lot-check-face-client-no')).toBe(false);
    expect(has(html, 'lot-check-dispute-close')).toBe(false);
  });

  it('the panel never returns nothing while the tick is offered — whatever lines it has', () => {
    // A face with no line of its own (no answer, no tick, no tarkib) on cargo still asked about is
    // «❓»; the guard is for the next state somebody adds without a line.
    expect(lotPanel(face({ state: 'stale' }))).not.toBe('');
    expect(has(lotPanel(face({ state: 'stale' })), 'lot-check-yes')).toBe(true);
  });
});

describe('the dispute’s hint promises only what the panel draws (L3-5)', () => {
  const veto = answer({ verdict: 'no', holds: true, vetoes: true });

  it('cargo still in China: correct, then ✅ or close — the tick, the note and the close are all there', () => {
    const html = lotPanel(face({ state: 'none', client: veto }));
    expect(has(html, 'lot-check-face-client-no')).toBe(true);
    expect(html).toContain(esc(words.disputeHint!));
    expect(has(html, 'lot-check-yes')).toBe(true);
    expect(has(html, 'lot-check-dispute-close')).toBe(true);
    // ONE note field serves whichever of the two is pressed.
    expect(html.match(/data-testid="lot-check-note"/g)).toHaveLength(1);
  });

  it('cargo that has left China: only the close is drawn, so only the close is named — and it takes a note', () => {
    const html = lotPanel(face({ state: 'none', askable: false, client: veto }));
    expect(has(html, 'lot-check-yes')).toBe(false);
    expect(has(html, 'lot-check-dispute-close')).toBe(true);
    expect(html).toContain(esc(words.disputeHintGone!));
    expect(html).not.toContain(esc(words.disputeHint!));
    // The words must not name a button that is not on the screen.
    expect(words.disputeHintGone).not.toContain('✅');
    expect(has(html, 'lot-check-note')).toBe(true);
  });

  it('a reader who cannot tick — the client’s SELLER, the alert’s first recipient — is told who resolves it (L5-2)', () => {
    const html = lotPanel(face({ state: 'none', client: veto }), false);
    expect(has(html, 'lot-check-face-client-no')).toBe(true);
    expect(has(html, 'lot-check-dispute-others')).toBe(true);
    expect(html).toContain(esc(words.disputeNotYours!));
    expect(has(html, 'lot-check-yes')).toBe(false);
    expect(has(html, 'lot-check-dispute-close')).toBe(false);
    // …and whoever CAN press is shown the buttons, not that sentence.
    expect(has(lotPanel(face({ state: 'none', client: veto })), 'lot-check-dispute-others')).toBe(false);
  });

  it('cargo in Uzbekistan that nobody ever checked still says nothing', () => {
    expect(lotPanel(face({ state: 'none', askable: false }))).toBe('');
  });
});

describe('«Mijozdan so‘rash» says what is true of the question NOW', () => {
  const ask = (over: Partial<ClientAskFace>, show = true) =>
    wrap(h(ClientAskPanel, { receiptId: 'r-1', show, face: { canAsk: true, noChat: false, status: null, disputes: [], ...over } }));
  const waitingStatus = (wait: 'soon' | 'later' | 'stuck', at: string | null) => ({
    state: 'pending' as const,
    when: null,
    by: 'Sardor',
    failure: null,
    wait,
    waitAt: at,
  });

  it('a question just queued: «a minute or two»', () => {
    const html = ask({ status: waitingStatus('soon', null) });
    expect(html).toContain(esc(words.askWaiting!));
  });

  it('a question that has been due for a long time (no bot token, a refused token): never «a minute or two» (L3-4)', () => {
    const html = ask({ status: waitingStatus('stuck', '14:05') });
    expect(html).not.toContain(esc(words.askWaiting!));
    expect(html).toContain('14:05');
    expect(html).toContain(esc(words.askStuck!.replace('{since}', '14:05')));
    expect(html).toMatch(/data-testid="client-ask-status"[^>]*data-wait="stuck"/);
  });

  it('a question Telegram asked us to hold: when it will go', () => {
    const html = ask({ status: waitingStatus('later', '15:40') });
    expect(html).not.toContain(esc(words.askWaiting!));
    expect(html).toContain(esc(words.askLater!.replace('{when}', '15:40')));
  });

  it('the explanation of what will be sent is drawn only beside the button that sends it (L3-7)', () => {
    expect(has(ask({}), 'client-ask-hint')).toBe(true);
    const noChat = ask({ canAsk: false, noChat: true });
    expect(has(noChat, 'client-ask-nochat')).toBe(true);
    expect(has(noChat, 'client-ask-hint')).toBe(false);
    const closeOnly = ask({ canAsk: false, disputes: [{ lotId: 'a', token: 't' }, { lotId: 'b', token: 't' }] });
    expect(has(closeOnly, 'client-dispute-close-all')).toBe(true);
    expect(has(closeOnly, 'client-ask-hint')).toBe(false);
  });

  it('with nothing to show and nothing just done, the block is not drawn at all', () => {
    expect(ask({ canAsk: false }, false)).toBe('');
  });
});
