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
  measures: false,
  measuresMoved: false,
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
    wrap(h(ClientAskPanel, { receiptId: 'r-1', show, face: { canAsk: true, full: false, noChat: false, status: null, disputes: [], ...over } }));
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

describe('what the client’s ✅ covered — name and count, or the kilos and cubic metres too (0146)', () => {
  // His «4 ha … og'irlik va hajmga urg'u berilsin»: an answer given to a
  // question that asked the weight and the volume vouches for them, and the
  // card must say which kind of answer it is looking at — a re-weigh after
  // one reads «o'zgardi», and after the other changes nothing.
  it('a full answer says so; an older one says what it did NOT cover', () => {
    const full = lotPanel(face({ state: 'checked', client: answer({ holds: true, measures: true }) }));
    expect(full).toContain(esc(words.clientYesFull!));
    expect(full).not.toContain(esc(words.clientYesBasicNote!));

    const basic = lotPanel(face({ state: 'checked', client: answer({ holds: true }) }));
    expect(basic).toContain(esc(words.clientYes!));
    expect(basic).not.toContain(esc(words.clientYesFull!));
    expect(basic).toContain(esc(words.clientYesBasicNote!));
  });

  it('a re-weigh after a full ✅: the card names the weight or the volume, not «the data»', () => {
    const moved = lotPanel(face({ state: 'stale', client: answer({ holds: false, measures: true, measuresMoved: true }) }));
    expect(has(moved, 'lot-check-face-client-stale')).toBe(true);
    expect(moved).toContain(esc(words.clientStaleMeasures!.replace('{day}', '2026-11-11')));
    expect(moved).not.toContain(esc(words.clientStale!.replace('{day}', '2026-11-11')));

    // The name or the count moved (with or without the measures): the general sentence.
    const renamed = lotPanel(face({ state: 'stale', client: answer({ holds: false, measures: true }) }));
    expect(renamed).toContain(esc(words.clientStale!.replace('{day}', '2026-11-11')));

    // Off the Chinese shelf it is history, drawn muted, in the same words' other form.
    const gone = lotPanel(face({ state: 'stale', askable: false, client: answer({ holds: false, measures: true, measuresMoved: true }) }));
    expect(has(gone, 'lot-check-face-client-old')).toBe(true);
    expect(gone).toContain(esc(words.clientYesOldMeasures!.replace('{day}', '2026-11-11')));
  });

  it('«Mijozdan so‘rash» says what the question sent NOW will ask', () => {
    const ask = (full: boolean) =>
      wrap(h(ClientAskPanel, { receiptId: 'r-1', show: true, face: { canAsk: true, full, noChat: false, status: null, disputes: [] } }));
    expect(ask(true)).toContain(esc(words.askHintFull!));
    expect(ask(true)).not.toContain(esc(words.askHint!));
    expect(ask(false)).toContain(esc(words.askHint!));
  });

  it('the five new sentences exist in all four bundles (#163)', () => {
    for (const locale of ['uz', 'ru', 'en', 'zh-CN']) {
      const bundle = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as { lotCheck: Record<string, string> };
      for (const key of ['clientYesFull', 'clientYesBasicNote', 'clientStaleMeasures', 'clientYesOldMeasures', 'askHintFull']) {
        expect(typeof bundle.lotCheck[key], `${locale}: ${key}`).toBe('string');
      }
      expect(bundle.lotCheck.clientStaleMeasures).toContain('{day}');
      expect(bundle.lotCheck.clientYesOldMeasures).toContain('{day}');
    }
  });
});

describe('the system’s own question, and a tick that remembers the weight (the owner’s «1 b» / «2 b» of 2026-11-12)', () => {
  const ask = (auto: ClientAskFace['auto'], status: ClientAskFace['status'] = null) =>
    wrap(h(ClientAskPanel, { receiptId: 'r-1', show: true, face: { canAsk: true, full: true, noChat: false, status, disputes: [], auto } }));
  const failed = uz.lotCheck as unknown as { askFailed: Record<string, string> };

  it('held by us: when it will go — and the person’s 📨 stays pressable', () => {
    const html = ask({ state: 'waiting', at: '15:40', failure: null });
    expect(html).toContain(esc(words.reaskWaiting!.replace('{when}', '15:40')));
    expect(html).toMatch(/data-testid="client-reask"[^>]*data-state="waiting"/);
    expect(html).not.toMatch(/data-testid="client-ask-send"[^>]*disabled/);
  });

  it('sent: when, in its own words — never «So‘rov yuborilgan … · —» about nobody', () => {
    const html = ask({ state: 'sent', at: '13.11.26, 15:40', failure: null });
    expect(html).toContain(esc(words.reaskSent!.replace('{when}', '13.11.26, 15:40')));
    expect(html).not.toContain(esc(words.askSent!.replace('{when}', '13.11.26, 15:40').replace('{by}', '—')));
  });

  it('not delivered: the closed word, under its own label', () => {
    const html = ask({ state: 'failed', at: null, failure: 'blocked' });
    expect(html).toContain(esc(words.reaskLabel!));
    expect(html).toContain(esc(failed.askFailed.blocked!));
    expect(html).toMatch(/data-testid="client-reask"[^>]*data-state="failed"/);
  });

  it('held long past its time (the bot cannot send): worded by its age, never «will go at» a time already gone', () => {
    const html = ask({ state: 'waiting', at: '09:10', wait: 'stuck', failure: null });
    expect(html).not.toContain(esc(words.reaskWaiting!.replace('{when}', '09:10')));
    expect(html).toContain(esc(words.askStuck!.replace('{since}', '09:10')));
    expect(html).toMatch(/data-testid="client-reask"[^>]*data-state="stuck"/);
  });

  it('none to draw: nothing of it', () => {
    expect(has(ask(null), 'client-reask')).toBe(false);
    expect(has(ask(undefined), 'client-reask')).toBe(false);
  });

  it('a tick whose kilos or cubic metres moved names the weight', () => {
    const person = (moved: { name: boolean; count: boolean; client: boolean; measures: boolean }) =>
      lotPanel(face({ state: 'stale', person: { by: 'Sardor', day: '2026-11-12', token: 't', note: null, holds: false, moved } }));
    const html = person({ name: false, count: false, client: false, measures: true });
    expect(html).toContain(esc(words.stalePerson!.replace('{what}', words.movedMeasures!)));
    const both = person({ name: true, count: false, client: false, measures: true });
    expect(both).toContain(esc(words.stalePerson!.replace('{what}', `${words.movedName!}, ${words.movedMeasures!}`)));
  });

  it('the new sentences exist in all four bundles (#163)', () => {
    for (const locale of ['uz', 'ru', 'en', 'zh-CN']) {
      const bundle = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as { lotCheck: Record<string, string>; tarkib: Record<string, string> };
      for (const key of ['reaskWaiting', 'reaskSent', 'reaskLabel', 'movedMeasures', 'clientViaPush']) {
        expect(typeof bundle.lotCheck[key], `${locale}: ${key}`).toBe('string');
      }
      expect(bundle.lotCheck.reaskWaiting).toContain('{when}');
      expect(bundle.lotCheck.reaskSent).toContain('{when}');
      expect(typeof bundle.tarkib.measureOnLotForm, `${locale}: tarkib.measureOnLotForm`).toBe('string');
    }
  });
});
