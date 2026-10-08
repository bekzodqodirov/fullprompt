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
  codeCandidates,
  markingCandidates,
  pickPerUnit,
  scrubIdentity,
  type ChannelPostView,
  type PostMark,
  type ScrubContext,
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
    // The thirteen cells the channel shipped with, moved onto the context: the
    // card's words stay `forbidden`, and the book has nothing to add here.
    const old = (name: string, forbidden: string[], codePrefix: string) =>
      scrubIdentity(name, { forbidden, ownCodes: [], codePrefix, knownCodes: new Set(), markings: [] });
    expect(old('GS777 Ali kurtka +998 90 123-45-67', ['GS777', 'Ali'], 'GS')).toBe('kurtka');
    expect(old('GS555 kurtka', ['GS777'], 'GS')).toBe('kurtka');
    expect(old('GS500MANIKEN-AL kurtka', ['GS777'], 'GS')).toBe('kurtka');
    expect(old('Алишер куртка', ['Алишер Валиев'], 'GS')).toBe('куртка');
    expect(old('Alyuminiy profil', ['Ali'], 'GS')).toBe('Alyuminiy profil');
    expect(old('Natalia ko‘ylak', ['Ali'], 'GS')).toBe('Natalia ko‘ylak');
    expect(old('@ali_uz kurtka', [], 'GS')).toBe('kurtka');
    expect(old('t.me/ali kurtka', [], 'GS')).toBe('kurtka');
    expect(old('https://x.uz kurtka', [], 'GS')).toBe('kurtka');
    expect(old('Bo shim', ['Bo'], 'GS')).toBe('Bo shim');
    expect(old('GS777 Ali', ['GS777', 'Ali'], 'GS')).toBe('');
    expect(old('GS555 kurtka', [], '')).toBe('GS555 kurtka');
  });

  it('the builder reads the price’s own amount, never the card’s, never a note', () => {
    const src = strip(readFileSync('src/modules/wms/calc/channel-queue.ts', 'utf8'));
    expect(src).toMatch(/total_usd/);
    expect(src).toMatch(/answer_amount/);
    expect(src).not.toMatch(/quotedAmount|quoted_amount|answerNote|answer_note/);
    expect(src).toContain('client_code_prefix');
  });
});

/**
 * F4 a — «no client identity at all». A code typed into a goods name, or
 * copied there from an invoice by the AI intake, opens onto a client for
 * somebody: the deal in ⌘K and by URL, the receipt in ⌘K, the box and the
 * crate in the bot, the pickup's lines, the client code everywhere. Each shape
 * is its own `it`, so a red proof strips one rule and names one cell. Every
 * cell runs with the batch cell beside it, which must stay: a truck code names
 * no client and cannot be told from a product model.
 */
describe('U4 — every code that opens onto a client', () => {
  const none: ScrubContext = { forbidden: [], ownCodes: [], codePrefix: 'GS', knownCodes: new Set(), markings: [] };
  const scrub = (name: string, ctx: Partial<ScrubContext> = {}) => scrubIdentity(name, { ...none, ...ctx });
  const batchSurvives = (ctx: Partial<ScrubContext> = {}) => expect(scrub('YW-045 kurtka', ctx)).toBe('YW-045 kurtka');
  const UUID = '3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c';

  it('a batch code is KEPT — it names no client, and its shape is a product model’s', () => {
    batchSurvives();
    expect(scrub('XR-500 model')).toBe('XR-500 model');
    expect(scrub('LED-100')).toBe('LED-100');
  });

  it('a deal code, in every spelling', () => {
    for (const code of ['B-000099', 'b-000099', 'B000099', 'Б-000099', 'В-000099', 'B\u2011000099']) {
      expect(scrub(`${code} kurtka`), code).toBe('kurtka');
    }
    expect(scrub('Vitamin B-12 kapsula')).toBe('Vitamin B-12 kapsula');
    expect(scrub('B12 vitamin')).toBe('B12 vitamin');
    // A deal code is six digits or more: a model number and the preposition
    // «в» (folded to «b») before a quantity are goods.
    expect(scrub('Printer B-400')).toBe('Printer B-400');
    expect(scrub('Mikser B-1200')).toBe('Mikser B-1200');
    expect(scrub('Пакеты в 100000 шт')).toBe('Пакеты в 100000 шт');
    batchSurvives();
  });

  it('the card’s own codes go whole, at any length, and leave no debris', () => {
    // The old word split left «kurtka B» behind: `-` cut the deal code in two.
    expect(scrub('kurtka B-000124', { ownCodes: ['B-000124', 'GS777'] })).toBe('kurtka');
    // A two-letter own code: no shape and no length rule knows it — only the card does.
    expect(scrub('kurtka A5', { ownCodes: ['A5'] })).toBe('kurtka');
    expect(scrub('A5-B kurtka', { ownCodes: ['A5'] })).toBe('kurtka');
    // What is glued to it goes with it — the person behind a code is the leak.
    expect(scrub('GS777-Bobur kurtka', { ownCodes: ['GS777'], codePrefix: 'GSR' })).toBe('kurtka');
    batchSurvives({ ownCodes: ['A5'] });
  });

  it('a receipt number', () => {
    expect(scrub('YW-IN-260915-003 kurtka')).toBe('kurtka');
    expect(scrub('tas1-in-260915-012 kurtka')).toBe('kurtka');
    batchSurvives();
  });

  it('a box code', () => {
    expect(scrub('YW26-000123 kurtka')).toBe('kurtka');
    expect(scrub('LED-100 lampa')).toBe('LED-100 lampa');
    // The truck stays and the box goes — with no «/» left standing alone.
    expect(scrub('YW-045 / YW26-000123')).toBe('YW-045');
    batchSurvives();
  });

  it('a crate code', () => {
    expect(scrub('CR-YW26-00001 kurtka')).toBe('kurtka');
    batchSurvives();
  });

  it('a pickup code', () => {
    expect(scrub('ZR-00012 kurtka')).toBe('kurtka');
    expect(scrub('ZR-12 bolt')).toBe('ZR-12 bolt');
    batchSurvives();
  });

  it('the client-code prefix, framed, spaced, in Cyrillic, full-width and lower-case', () => {
    for (const code of ['(GS555)', 'GS-555', 'GS 555', '#GS555', '№GS555', 'kod:GS555', 'ГС555', 'gs555']) {
      expect(scrub(`${code} kurtka`), code).toBe('kurtka');
    }
    expect(scrub('GSM modul')).toBe('GSM modul');
    batchSurvives();
  });

  it('a full-width code from a Chinese IME (NFKC)', () => {
    expect(scrub('ＧＳ５５５ kurtka')).toBe('kurtka');
    batchSurvives();
  });

  it('the book’s codes: manual, lot form, and minted under an older prefix', () => {
    const ctx = { codePrefix: 'GSR', knownCodes: new Set(['444', 'A55', 'GS555']) };
    expect(scrub('kurtka 444', ctx)).toBe('kurtka');
    expect(scrub('444-A kurtka', ctx)).toBe('kurtka');
    expect(scrub('A55 kurtka', ctx)).toBe('kurtka');
    expect(scrub('GS555 kurtka', ctx)).toBe('kurtka');
    expect(scrub('kurtka 445', ctx)).toBe('kurtka 445');
    expect(scrub('A5 qog‘oz', ctx)).toBe('A5 qog‘oz');
    // Glued by «-», «_» or «.», the tail is the person: «GS555-Bobur».
    expect(scrub('GS555-Bobur kurtka', ctx)).toBe('kurtka');
    expect(scrub('GS555_Bobur kurtka', ctx)).toBe('kurtka');
    expect(scrub('GS555.Bobur kurtka', ctx)).toBe('kurtka');
    batchSurvives(ctx);
  });

  it('an all-digit code of the book is never read out of a quantity', () => {
    const ctx = { knownCodes: new Set(['500', '220', '111', '444']) };
    expect(scrub('Suv 500 ml', ctx)).toBe('Suv 500 ml');
    expect(scrub('Бутылка 500 мл', ctx)).toBe('Бутылка 500 мл');
    expect(scrub('Lampa 220 V', ctx)).toBe('Lampa 220 V');
    expect(scrub('Pena 111 x 50', ctx)).toBe('Pena 111 x 50');
    expect(scrub('Pena 50×111', ctx)).toBe('Pena 50×111');
    expect(scrub('Kley 1.500', ctx)).toBe('Kley 1.500');
    expect(scrub('Bolt 500.5', ctx)).toBe('Bolt 500.5');
    // …and still a code where nothing makes it a quantity.
    expect(scrub('kurtka 444', ctx)).toBe('kurtka');
    expect(scrub('444-A kurtka', ctx)).toBe('kurtka');
    expect(scrub('500 kurtka', ctx)).toBe('kurtka');
    batchSurvives(ctx);
  });

  it('a code typed with Cyrillic look-alikes (the fold)', () => {
    // Cyrillic А and К: on a phone keyboard they ARE the letters of the code.
    expect(scrub('АК55 kurtka', { knownCodes: new Set(['AK55']) })).toBe('kurtka');
    batchSurvives({ knownCodes: new Set(['AK55']) });
  });

  it('an unclaimed marking goes as ONE unit and is never split into words', () => {
    const ctx = { markings: ['MANIKEN-AL', 'Ali kurtka'] };
    expect(scrub('MANIKEN-AL sumka', ctx)).toBe('sumka');
    expect(scrub('Ali kurtka shim', ctx)).toBe('shim');
    expect(scrub('kurtka shim', ctx)).toBe('kurtka shim');
    batchSurvives(ctx);
  });

  it('a marking that starts with a code or a person goes whole, before any piece of it is cut', () => {
    // GSR: the prefix rule must not be what removes these. Cut piece-first,
    // the tail («MANIKEN-AL», «Bobur») was posted — and ⌘K finds the lot by it.
    const gsr = { codePrefix: 'GSR' };
    const marking = { markings: ['GS500-MANIKEN-AL'] };
    expect(scrub('GS500-MANIKEN-AL sumka', { ...gsr, ...marking, ownCodes: ['GS500'] })).toBe('sumka');
    expect(scrub('GS500-MANIKEN-AL sumka', { ...gsr, ...marking, knownCodes: new Set(['GS500']) })).toBe('sumka');
    expect(scrub('444 Bobur sumka', { ...gsr, knownCodes: new Set(['444']), markings: ['444 Bobur'] })).toBe('sumka');
    expect(scrub('GS555 BOBUR kurtka', { ...gsr, knownCodes: new Set(['GS555']), markings: ['GS555 BOBUR'] })).toBe('kurtka');
    expect(scrub('Ali Bobur sumka', { ...gsr, forbidden: ['Ali Valiev'], markings: ['Ali Bobur'] })).toBe('sumka');
    batchSurvives({ ...gsr, markings: ['444 Bobur', 'Ali Bobur'] });
  });

  it('a code glued to Chinese text — CJK is no part of a code’s word', () => {
    expect(scrub('男士夹克GS777', { ownCodes: ['GS777'], codePrefix: 'GSR' })).toBe('男士夹克');
    expect(scrub('男士夹克444', { knownCodes: new Set(['444']) })).toBe('男士夹克');
    expect(scrub('444男士夹克', { ownCodes: ['444'] })).toBe('男士夹克');
    expect(scrub('男士夹克GS555')).toBe('男士夹克');
    expect(scrub('客户B-000099夹克')).toBe('客户 夹克');
    expect(scrub('男装YW26-000123')).toBe('男装');
    // A code BEFORE Chinese keeps the goods, and the Latin edge is unchanged.
    expect(scrub('GS777男士夹克')).toBe('男士夹克');
    expect(scrub('GS777-男士夹克', { ownCodes: ['GS777'] })).toBe('男士夹克');
    expect(scrub('kurtkaGS777')).toBe('kurtkaGS777');
    expect(scrub('GS555куртка shim')).toBe('shim');
    expect(scrub('Vitamin B-12 kapsula')).toBe('Vitamin B-12 kapsula');
    expect(scrub('LED-100')).toBe('LED-100');
    batchSurvives();
  });

  it('a separator goes only where a cut left it alone — the seller’s own stay', () => {
    expect(scrub('Kabel 10 - 20 m')).toBe('Kabel 10 - 20 m');
    expect(scrub('Stol / stul')).toBe('Stol / stul');
    expect(scrub('Kurtka № 5')).toBe('Kurtka № 5');
    expect(scrub('Rang: qora')).toBe('Rang: qora');
    expect(scrub('kurtka - GS555')).toBe('kurtka');
    expect(scrub('GS555 | kurtka / shim')).toBe('kurtka / shim');
    expect(scrub('kurtka ( GS555 ) shim')).toBe('kurtka shim');
    batchSurvives();
  });

  it('a link, a uuid, an app path or a bare host', () => {
    expect(scrub(`gsrwms.uz/bitimlar/${UUID} kurtka`)).toBe('kurtka');
    expect(scrub(`/crm/leads/${UUID} kurtka`)).toBe('kurtka');
    expect(scrub(`${UUID} kurtka`)).toBe('kurtka');
    expect(scrub('/hisoblash/123 kurtka')).toBe('kurtka');
    expect(scrub('gsrwms.uz kurtka')).toBe('kurtka');
    expect(scrub('kurtka/shim')).toBe('kurtka/shim');
    batchSurvives();
  });

  it('markingCandidates: a marking whose first run is a whole run of the names — and no other', () => {
    const all = ['MANIKEN-AL', 'MANIKEN', 'Ali kurtka', 'QQ9', 'kurt', '义乌-张三', '##', '  '];
    const out = markingCandidates(['ＭＡＮＩＫＥＮ-AL sumka', 'Ali kurtkasi', '义乌-张三 sumka'], all);
    expect(out).toEqual(expect.arrayContaining(['MANIKEN-AL', 'MANIKEN', 'Ali kurtka', '义乌-张三']));
    // A run that is only the START of a word, a marking nobody typed, and
    // anything under three code points never reach the scrub.
    expect(out).not.toContain('kurt');
    expect(out).not.toContain('QQ9');
    expect(out).not.toContain('##');
    // …and what reaches it is still decided by the scrub's own edges.
    expect(scrub('Ali kurtkasi', { markings: out })).toBe('Ali kurtkasi');
  });

  it('codeCandidates: the runs that could be a code, joined across a seam, never a word', () => {
    const out = codeCandidates(['kurtka GS 555-A', '444']);
    expect(out).toContain('GS555');
    expect(out).toContain('444');
    expect(out).not.toContain('KURTKA');
    expect(codeCandidates(['ＧＳ５５５'])).toContain('GS555');
    // Cyrillic А and К: the book is asked about the code they spell.
    expect(codeCandidates(['АК55 kurtka'])).toContain('AK55');
  });
});

describe('U5 — the builder hands the scrub the book, the markings and the card’s own codes', () => {
  const queue = strip(readFileSync('src/modules/wms/calc/channel-queue.ts', 'utf8'));
  const bodyOf = (name: string) => {
    const at = queue.search(new RegExp(`function ${name}\\b`));
    expect(at, `${name} is not in channel-queue.ts`).toBeGreaterThan(-1);
    const rest = queue.slice(at);
    return rest.slice(0, rest.indexOf('\n}') + 2);
  };

  it('the book is read by `inArray` over the candidates, the markings from receipts', () => {
    const reads = bodyOf('identitiesIn');
    expect(reads).toMatch(/codeCandidates\(names\)/);
    expect(reads).toMatch(/const slice = candidates\.slice\(/);
    expect(reads).toMatch(/inArray\(clients\.clientCode, slice\)/);
    expect(reads).toMatch(/unclaimed_marking/);
    expect(reads).toMatch(/markingCandidates\(names, /);
    const goods = bodyOf('goodsFor');
    expect(goods).toMatch(/await identitiesIn\(/);
    expect(goods).toMatch(/const scrub = makeScrubber\(\{[^}]*\bknownCodes\b[^}]*\bmarkings\b[^}]*\}\)/);
    expect(goods).toMatch(/scrub\(item\.name\)/);
    expect(goods).toMatch(/ownCodes: card\.ownCodes/);
  });

  it('the card’s codes are own CODES and never forbidden WORDS', () => {
    const card = bodyOf('forbiddenFor');
    expect(card).toMatch(/ownCodes\.push\(d\.code\)/);
    expect(card).toMatch(/ownCodes\.push\(c\.code\)/);
    expect(card).not.toMatch(/forbidden\.push\([^)]*\b(?:d|c)\.code\b/);
  });
});
