import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { visibleLength } from '@/modules/platform/telegram/format';
import {
  CHANNEL_POST_MAX,
  MARK_LINES,
  REPRICED_UNPOSTED,
  channelPostHtml,
  childPostedFor,
  fitGoods,
  markLine,
  pickPerUnit,
  scrubIdentity,
  type ChannelPostView,
  type PostMark,
} from '@/modules/wms/calc/channel-post';
import type { ChildState } from '@/modules/wms/calc/chain';

/**
 * The price channel's post (the owner's F, 2026-10-07): F2 a's body, F4 a's
 * «no client identity at all», F9 b's named seller.
 *
 * The projection fence is offer-sheet.test.ts's shape: the view is a TYPE with
 * no field a client, a floor breakdown, a discount or a note could ride in, and
 * a field added to it fails `pnpm typecheck` here (which types tests/) before
 * it can reach the channel.
 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const base: ChannelPostView = {
  kind: 'seal',
  section: 'rastamojka',
  quoteNo: 2,
  day: '2026-10-07',
  validUntilDay: '2026-10-21',
  goods: ['Kurtka', 'Krossovka', 'Sumka'],
  goodsMore: 3,
  weightKg: 3000,
  volumeM3: 18.5,
  amount: 4280,
  currency: 'USD',
  perUnit: { value: 1.42, unit: 'kg' },
  sellerName: 'Ali Valiyev',
  vedName: 'Sardor',
  replacesQuoteNo: null,
  isCorrection: false,
};

const ALL_STATES: ChildState[] = ['open', 'sealed', 'answered', 'returned', 'unpriced'];

describe('U1 — the projection fence', () => {
  it('carries exactly its sixteen fields and none named for a client, a cost or a note', () => {
    const keys = Object.keys(base).sort();
    expect(keys).toEqual(
      [
        'amount',
        'currency',
        'day',
        'goods',
        'goodsMore',
        'isCorrection',
        'kind',
        'perUnit',
        'quoteNo',
        'replacesQuoteNo',
        'section',
        'sellerName',
        'validUntilDay',
        'vedName',
        'volumeM3',
        'weightKg',
      ].sort(),
    );
    for (const key of keys) {
      expect(key).not.toMatch(/client|phone|code|deal|lead|link|url|discount|reason|note|baza|duty|vat|fee|customs|tnved|floor|upsale|offer/i);
    }
  });

  it('the composer reads no card amount, no note and nothing internal', () => {
    const src = strip(readFileSync('src/modules/wms/calc/channel-post.ts', 'utf8'));
    expect(src).not.toMatch(/quotedAmount|quoted_amount|answerNote|answer_note|internal/);
  });
});

describe('U2 — the composer and the marks', () => {
  it('(a) a sealed rastamojka: section, V, the total, ONE per-unit, the people, and no link', () => {
    // groupDigits groups with a no-break space; read as a person reads it.
    const html = channelPostHtml(base, null).replace(/\u00a0/g, ' ');
    expect(html).toContain('RASTAMOJKA');
    expect(html).toContain('V2');
    expect(html).toContain('$4 280.00');
    expect(html).toContain('/kg');
    expect(html).toContain('Ali Valiyev');
    expect(html).toContain('Sardor');
    expect(html).toContain('(+3)');
    expect(html).toContain('07.10.2026');
    expect(html).toContain('21.10.2026 gacha amal qiladi');
    expect(html).not.toContain('<a');
    expect(html).not.toContain('<s>');
  });

  it('(b) an answer in so‘m: «qo‘lda berilgan», the currency, no per-unit', () => {
    const html = channelPostHtml(
      { ...base, kind: 'answer', quoteNo: null, currency: 'UZS', amount: 52_000_000, perUnit: null },
      null,
    ).replace(/\u00a0/g, ' ');
    expect(html).toContain('qo‘lda berilgan');
    expect(html).toContain('UZS');
    expect(html).toContain('52 000 000');
    expect(html).not.toContain('/kg');
    expect(html).not.toContain('V2');
  });

  it('(c) a goods name arrives escaped', () => {
    const html = channelPostHtml({ ...base, goods: ['<b>x</b>'] }, null);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });

  it('(d) the worst case fits the caption ceiling with every mark', () => {
    const worst = fitGoods({
      ...base,
      goods: Array.from({ length: 20 }, (_, i) => `${i}`.repeat(200)),
      goodsMore: 0,
      sellerName: 'S'.repeat(60),
      vedName: 'V'.repeat(60),
      isCorrection: true,
      replacesQuoteNo: 9,
    });
    expect(worst.goodsMore).toBeGreaterThan(0);
    const marks: (PostMark | null)[] = [null];
    for (const state of ALL_STATES) for (const childPosted of [true, false]) marks.push({ state, childPosted });
    for (const mark of marks) {
      expect(visibleLength(channelPostHtml(worst, mark)), JSON.stringify(mark)).toBeLessThanOrEqual(CHANNEL_POST_MAX);
    }
  });

  it('(e) every mark goes first and strikes the price; none renders no mark', () => {
    for (const state of ALL_STATES) {
      const mark = { state, childPosted: true };
      const html = channelPostHtml(base, mark);
      expect(html.split('\n')[0]).toBe(markLine(mark));
      expect(html).toMatch(/<s>💵 .*<\/s>/);
    }
    expect(channelPostHtml(base, null).split('\n')[0]).not.toContain('amal qilmaydi');
  });

  it('(f) a correction that was NOT posted never promises a new price, and never names a discount', () => {
    expect(markLine({ state: 'sealed', childPosted: false })).toBe(REPRICED_UNPOSTED);
    expect(markLine({ state: 'answered', childPosted: false })).toBe(REPRICED_UNPOSTED);
    expect(REPRICED_UNPOSTED).not.toContain('yangi narx');
    expect(REPRICED_UNPOSTED).not.toContain('chegirma');
    expect(markLine({ state: 'sealed', childPosted: true })).toContain('yangi narx berildi');
    expect(markLine({ state: 'open', childPosted: false })).toBe(MARK_LINES.open);
    expect(MARK_LINES.open).toContain('QAYTA HISOBLANMOQDA');
  });

  it('(g) was the correction posted?', () => {
    const now = new Date('2026-10-07T10:00:00Z');
    const ago = (min: number) => new Date(now.getTime() - min * 60_000);
    const ask = (childPostStatus: 'sent' | 'pending' | 'sending' | 'skipped' | 'failed' | null, min: number) =>
      childPostedFor({ state: 'sealed', childPostStatus, childCompletedAt: ago(min), now });
    expect(ask('sent', 1)).toBe('posted');
    expect(ask('pending', 1)).toBe('waiting');
    expect(ask('sending', 1)).toBe('waiting');
    expect(ask(null, 3)).toBe('waiting');
    expect(ask(null, 11)).toBe('unposted');
    expect(ask('skipped', 1)).toBe('unposted');
    expect(ask('failed', 1)).toBe('unposted');
  });
});

describe('U3 — one per-unit figure, the identity scrub, and the amount’s source', () => {
  it('picks the unit the customer is charged in', () => {
    const p = (section: 'yolkira' | 'rastamojka' | 'podklyuch' | null, bandPerKg: boolean | null, perKg: number | null, perM3: number | null, currency = 'USD') =>
      pickPerUnit({ section, bandPerKg, perKg, perM3, currency })?.unit ?? null;
    expect(p('yolkira', true, 1, 100)).toBe('kg');
    expect(p('yolkira', false, 1, 100)).toBe('m3');
    expect(p('podklyuch', true, 1, 100)).toBe('kg');
    expect(p('podklyuch', false, 1, 100)).toBe('m3');
    expect(p('rastamojka', null, 1, 100)).toBe('kg');
    expect(p('rastamojka', null, null, 100)).toBe('m3');
    expect(p('yolkira', false, 1, null)).toBe('kg');
    expect(p('rastamojka', null, null, null)).toBeNull();
    expect(p('rastamojka', null, 1, 100, 'UZS')).toBeNull();
  });

  it('takes the card’s identity out of a goods name — and nothing else', () => {
    expect(scrubIdentity('GS777 Ali kurtka +998 90 123-45-67', ['GS777', 'Ali'], 'GS')).toBe('kurtka');
    expect(scrubIdentity('GS555 kurtka', ['GS777'], 'GS')).toBe('kurtka');
    expect(scrubIdentity('GS500MANIKEN-AL kurtka', ['GS777'], 'GS')).toBe('kurtka');
    expect(scrubIdentity('Алишер куртка', ['Алишер Валиев'], 'GS')).toBe('куртка');
    expect(scrubIdentity('Alyuminiy profil', ['Ali'], 'GS')).toBe('Alyuminiy profil');
    expect(scrubIdentity('Natalia ko‘ylak', ['Ali'], 'GS')).toBe('Natalia ko‘ylak');
    expect(scrubIdentity('@ali_uz kurtka', [], 'GS')).toBe('kurtka');
    expect(scrubIdentity('t.me/ali kurtka', [], 'GS')).toBe('kurtka');
    expect(scrubIdentity('https://x.uz kurtka', [], 'GS')).toBe('kurtka');
    expect(scrubIdentity('Bo shim', ['Bo'], 'GS')).toBe('Bo shim');
    expect(scrubIdentity('GS777 Ali', ['GS777', 'Ali'], 'GS')).toBe('');
    expect(scrubIdentity('GS555 kurtka', [], '')).toBe('GS555 kurtka');
  });

  it('the builder reads the price’s own amount, never the card’s, never a note', () => {
    const src = strip(readFileSync('src/modules/wms/calc/channel-queue.ts', 'utf8'));
    expect(src).toMatch(/total_usd/);
    expect(src).toMatch(/answer_amount/);
    expect(src).not.toMatch(/quotedAmount|quoted_amount|answerNote|answer_note/);
    expect(src).toContain('client_code_prefix');
  });
});
