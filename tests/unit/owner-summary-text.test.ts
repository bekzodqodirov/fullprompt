import { describe, expect, it } from 'vitest';
import uz from '../../messages/uz.json';
import ru from '../../messages/ru.json';
import en from '../../messages/en.json';
import zh from '../../messages/zh-CN.json';
import { STAFF_TEXT_CAP } from '@/modules/platform/notifications/staff-html';
import { ATTENTION_KEYS, type AttentionFact } from '@/modules/wms/reports/attention';
import {
  attentionLine,
  ddmm,
  ownerSummaryText,
  paymentsDue,
  PAYMENTS_DAYS,
  summaryQuiet,
  summaryWindow,
  type DueRecurring,
  type SummaryFacts,
} from '@/modules/wms/reports/owner-summary-text';

/**
 * The evening summary's WORDS, pinned on literals (#1116): every figure below
 * is typed here, never computed by the code under test, so a formatting rule
 * that drifts is red and not «consistent with itself».
 */

const LINK = 'https://gsrwms.uz/dashboard?davr=bugun';

/**
 * Figures group thousands with a NO-BREAK space (`groupDigits`, so a number
 * never wraps on a phone); the literals below are typed with ordinary spaces
 * and compared through this — one assertion pins the no-break space itself.
 */
const plain = (text: string) => text.replace(/\u00a0/g, ' ');
const summary = (...args: Parameters<typeof ownerSummaryText>) => plain(ownerSummaryText(...args));

function facts(over: Partial<SummaryFacts> = {}): SummaryFacts {
  return {
    day: '2026-09-29',
    weekly: false,
    from: '2026-09-29',
    to: '2026-09-29',
    asOf: '20:00',
    revenueUsd: 1250,
    collectedUsd: 123.45,
    cash: { inUsd: 1000, outUsd: 450.5, unconverted: { count: 0, byCurrency: [] } },
    tills: { usd: 12345.67, count: 5, unrated: [] },
    intake: { receipts: 3, boxes: 1204, m3: 12.5, kg: 1250.25 },
    trucks: { departed: 1, arrived: 0, onRoad: 7 },
    leads: { fresh: 4, won: 1, wonUsd: 500, wonOther: 0 },
    attention: { total: 0, top: [] },
    weeklyBlock: null,
    link: LINK,
    ...over,
  };
}

const quietFacts = () =>
  facts({
    revenueUsd: 0,
    collectedUsd: 0,
    cash: { inUsd: 0, outUsd: 0, unconverted: { count: 0, byCurrency: [] } },
    intake: { receipts: 0, boxes: 0, m3: 0, kg: 0 },
    trucks: { departed: 0, arrived: 0, onRoad: 7 },
    leads: { fresh: 0, won: 0, wonUsd: 0, wonOther: 0 },
  });

describe('the daily message', () => {
  it('reads top to bottom as the owner asked, in Uzbek, with the link last', () => {
    const text = summary(facts());
    const lines = text.split('\n');
    expect(lines[0]).toBe('📊 GSR — kun xulosasi, 29.09 (soat 20:00)');
    expect(text).toContain('💰 Tushum (hisoblangan): $1 250.00');
    expect(text).toContain('💵 Mijozlar to‘lagan (sof): $123.45');
    expect(text).toContain('🏦 Kassa: kirim $1 000.00 · chiqim $450.50');
    expect(text).toContain('💼 Kassalarda: $12 345.67 · 5 kassa');
    expect(text).toContain('📦 Prixod: 3 ta · 1 204 karobka · 12.5 m³ · 1 250.25 kg');
    expect(text).toContain('🚚 Jo‘nadi: 1 · Keldi: 0 · Yo‘lda: 7');
    expect(text).toContain('👥 Yangi lid: 4 · Yutildi: 1 · $500.00');
    expect(lines[lines.length - 1]).toBe(LINK);
    expect(ownerSummaryText(facts())).toContain('$1\u00a0250.00');
    // No weekly block on an ordinary day.
    expect(text).not.toContain('Keyingi 4 hafta');
  });

  it('a lead line only for a reader the funnel’s outcome gate admits', () => {
    expect(summary(facts({ leads: null }))).not.toContain('Yangi lid');
    expect(
      summary(facts({ leads: { fresh: 2, won: 1, wonUsd: 0, wonOther: 2 } })),
    ).toContain('Yutildi: 1 · $0.00 (+2 boshqa valyutada)');
  });

  it('money with no rate is NAMED in its own currency with ⚠, never printed as $0 (#86, U14, U24)', () => {
    const text = summary(
      facts({
        cash: { inUsd: 0, outUsd: 0, unconverted: { count: 2, byCurrency: [{ currency: 'CNY', amount: 1200 }] } },
        tills: { usd: 100, count: 2, unrated: [{ currency: 'CNY', balance: 5000.5, count: 1 }] },
      }),
    );
    expect(text).toContain('   ⚠ 2 ta xarajat kursi yo‘q (CNY 1 200) — chiqimga kirmagan');
    expect(text).toContain('   ⚠ kursi yo‘q: CNY 5 000.5 (1 kassa) — jamiga kirmagan');
  });

  it('the attention rows are the dashboard’s own sentences, from the uz bundle', () => {
    const stuck: AttentionFact = {
      kind: 'stuck',
      level: 'warn',
      count: 2,
      key: 'stuck',
      params: { n: { as: 'n', v: 2 } },
      suffix: null,
      href: '/transit',
    };
    const missing: AttentionFact = {
      kind: 'missing',
      level: 'bad',
      count: 3,
      usd: 1234.5,
      key: 'missing',
      params: { n: { as: 'n', v: 3 }, m3: { as: 'm3', v: 1.2345 }, usd: { as: 'usd', v: 1234.5 } },
      suffix: null,
      href: '/transit',
    };
    expect(attentionLine(stuck)).toBe('2 kundan beri tushirilmagan fura: 2');
    expect(plain(attentionLine(missing))).toBe('Yo‘lda yo‘qolgan: 3 karobka · 1.235 m³ · sarflangan $1 234.50');
    const text = summary(facts({ attention: { total: 5, top: [missing, stuck] } }));
    expect(text).toContain('⚠️ E’tibor kerak (5):\n• Yo‘lda yo‘qolgan: 3 karobka');
    expect(text).toContain('• 2 kundan beri tushirilmagan fura: 2\n… yana 3 ta — ekranda');
  });

  it('the pull on a quiet day says so in one line', () => {
    expect(summary(quietFacts(), { quietLine: true })).toContain('\nHali harakat yo‘q.\n');
    expect(summary(quietFacts())).not.toContain('Hali harakat');
  });
});

describe('silence (the push stays quiet when nothing HAPPENED)', () => {
  it('every flow figure zero → quiet; standing state never counts', () => {
    // Tills, trucks on the road and the attention list are the same tomorrow.
    expect(summaryQuiet(quietFacts())).toBe(true);
  });

  it('one prixod, one payment, one departed truck, one lead — each alone wakes it', () => {
    const q = quietFacts();
    expect(summaryQuiet({ ...q, intake: { receipts: 1, boxes: 1, m3: 0.1, kg: 1 } })).toBe(false);
    expect(summaryQuiet({ ...q, collectedUsd: 123.45 })).toBe(false);
    expect(summaryQuiet({ ...q, trucks: { departed: 1, arrived: 0, onRoad: 0 } })).toBe(false);
    expect(summaryQuiet({ ...q, leads: { fresh: 1, won: 0, wonUsd: 0, wonOther: 0 } })).toBe(false);
    expect(summaryQuiet({ ...q, revenueUsd: -5 })).toBe(false);
  });

  it('a quiet Monday with a payment coming due sends — the payments ARE the news', () => {
    const payments = paymentsDue({
      today: '2026-09-28',
      recurring: [],
      partners: [{ name: 'Yiwu Trans', active: true, open: [{ dueDate: '2026-10-03', usd: 800 }] }],
      upsale: { usd: 0, count: 0 },
      arrears: null,
    });
    const weekly = {
      ...quietFacts(),
      weekly: true,
      weeklyBlock: {
        payments,
        arrears: null,
        arrearsUnrated: [],
        pendingSpend: { count: 0, byCurrency: [], ownPocket: { count: 0, byCurrency: [] } },
        receivableUsd: 0,
      },
    };
    expect(summaryQuiet(weekly)).toBe(false);
    const nothing = { ...weekly, weeklyBlock: { ...weekly.weeklyBlock, payments: { items: [], totals: [] } } };
    expect(summaryQuiet(nothing)).toBe(true);
  });
});

describe('the window is Tashkent’s day (R5, #1063)', () => {
  it('15:00 UTC on a Monday is 20:00 Monday here: the weekly message over «7 kun»', () => {
    const w = summaryWindow(new Date('2026-09-28T15:00:00Z'));
    expect(w).toMatchObject({ today: '2026-09-28', weekly: true, key: '7' });
    expect(w.period.from).toBe('2026-09-22');
    expect(w.period.to).toBe('2026-09-28');
  });

  it('19:30 UTC on a Monday is 00:30 TUESDAY here: a daily message about Tuesday', () => {
    const w = summaryWindow(new Date('2026-09-28T19:30:00Z'));
    expect(w).toMatchObject({ today: '2026-09-29', weekly: false, key: 'bugun' });
    expect(w.period.from).toBe('2026-09-29');
    expect(w.period.to).toBe('2026-09-29');
  });

  it('dates are cut from the string (#678)', () => {
    expect(ddmm('2026-10-05')).toBe('05.10');
  });
});

const rec = (over: Partial<DueRecurring>): DueRecurring => ({
  dueDate: '2026-10-01',
  amount: 5000,
  currency: 'CNY',
  cash: true,
  dueNow: false,
  templateActive: true,
  categoryName: 'Ijara',
  employeeName: null,
  warehouseCode: 'YW',
  paidParts: [],
  ...over,
});

describe('the weekly payments (outflows only, each in its own money)', () => {
  const today = '2026-09-28';

  it('day+28 is in, day+29 is out', () => {
    const due = paymentsDue({
      today,
      recurring: [rec({ dueDate: '2026-10-26' }), rec({ dueDate: '2026-10-27', categoryName: 'Kechroq' })],
      partners: [],
      upsale: { usd: 0, count: 0 },
      arrears: null,
    });
    expect(PAYMENTS_DAYS).toBe(28);
    expect(due.items.map((item) => item.date)).toEqual(['2026-10-26']);
  });

  it('a book entry, a dead template and a month already due are not listed (the arrears line carries those)', () => {
    const due = paymentsDue({
      today,
      recurring: [
        rec({ cash: false, categoryName: 'Amortizatsiya' }),
        rec({ templateActive: false, categoryName: 'Eski' }),
        rec({ dueNow: true, dueDate: '2026-09-20', categoryName: 'Kechikkan' }),
        rec({ categoryName: 'Oylik', employeeName: 'Alisher', warehouseCode: null, currency: 'UZS', amount: 5000000 }),
      ],
      partners: [],
      upsale: { usd: 0, count: 0 },
      arrears: { usd: 700, unrated: [{ currency: 'KZT', amount: 1000 }] },
    });
    expect(due.items.map((item) => item.label)).toEqual(['Oylik · Alisher']);
    // So'm stays so'm: never converted, never printed as dollars.
    expect(due.items[0]).toMatchObject({ amount: 5000000, currency: 'UZS' });
    // The arrears' money joins the totals, each currency apart; no «net».
    expect(due.totals).toEqual([
      { currency: 'USD', amount: 700 },
      { currency: 'KZT', amount: 1000 },
      { currency: 'UZS', amount: 5000000 },
    ]);
  });

  it('a part-paid month prints what is left, or the whole with «qisman» when that cannot be known', () => {
    const due = paymentsDue({
      today,
      recurring: [
        rec({ categoryName: 'A', paidParts: [{ amount: 2000, currency: 'CNY' }] }),
        rec({ categoryName: 'B', paidParts: [{ amount: 100, currency: 'USD' }] }),
        rec({ categoryName: 'C', paidParts: [{ amount: 5000, currency: 'CNY' }] }),
      ],
      partners: [],
      upsale: { usd: 0, count: 0 },
      arrears: null,
    });
    expect(due.items.map((item) => [item.label, item.amount, item.note])).toEqual([
      ['A · YW', 3000, null],
      ['B · YW', 5000, 'qisman to‘langan'],
    ]);
  });

  it('a firm: its overdue part and its coming part, apart; a retired one still owed says so (#428)', () => {
    const due = paymentsDue({
      today,
      recurring: [],
      partners: [
        {
          name: 'Kashgar Logistics',
          active: false,
          open: [
            { dueDate: '2026-09-10', usd: 300 },
            { dueDate: '2026-09-20', usd: 200 },
            { dueDate: '2026-10-05', usd: 150 },
            { dueDate: '2026-12-01', usd: 999 },
          ],
        },
      ],
      upsale: { usd: 120, count: 3 },
      arrears: null,
    });
    expect(due.items.map((item) => [item.date, item.label, item.amount, item.overdue, item.note])).toEqual([
      ['2026-09-10', 'Kashgar Logistics', 500, true, 'arxivda'],
      ['2026-10-05', 'Kashgar Logistics', 150, false, 'arxivda'],
      [null, 'Sotuvchilar ulushi (3 ta)', 120, false, null],
    ]);
    const text = summary(
      facts({
        day: today,
        weekly: true,
        from: '2026-09-22',
        to: today,
        weeklyBlock: {
          payments: due,
          arrears: null,
          arrearsUnrated: [],
          pendingSpend: {
            count: 4,
            byCurrency: [{ currency: 'UZS', amount: 1200000 }, { currency: 'USD', amount: 50 }],
            ownPocket: { count: 1, byCurrency: [{ currency: 'UZS', amount: 300000 }] },
          },
          receivableUsd: 45000,
        },
      }),
    );
    expect(text.split('\n')[0]).toBe('📊 GSR — hafta xulosasi, 22.09–28.09 (soat 20:00)');
    expect(text).toContain('📅 Keyingi 4 hafta to‘lovlari (29.09–26.10):');
    expect(text).toContain('• ⚠ 10.09 — Kashgar Logistics: $500.00 (muddati o‘tgan, arxivda)');
    expect(text).toContain('• 05.10 — Kashgar Logistics: $150.00 (arxivda)');
    expect(text).toContain('• Sotuvchilar ulushi (3 ta): $120.00');
    expect(text).toContain('Jami: $770.00');
    // Money already out of a warehouse's pocket is NOT a coming payment
    // (judge 4) — its own line, the colleague's part named.
    expect(text).toContain('🧾 Chiqib ketgan, hali yozilmagan: 4 ta — UZS 1 200 000 · $50.00');
    expect(text).toContain('   shundan 1 tasi hodimning o‘z pulidan: UZS 300 000');
    expect(text).toContain('💳 Mijozlar qarzi (muddatsiz): $45 000.00');
  });
});

describe('the worst case still fits one Telegram message and keeps its link', () => {
  it('200 recurring, 200 firms, 60-character names, eight attention rows', () => {
    const long = 'Ж'.repeat(60);
    const recurring = Array.from({ length: 200 }, (_, i) =>
      rec({ dueDate: `2026-10-${String((i % 26) + 1).padStart(2, '0')}`, categoryName: `${long}${i}`, employeeName: long }),
    );
    const partners = Array.from({ length: 200 }, (_, i) => ({
      name: `${long}${i}`,
      active: i % 2 === 0,
      open: [
        { dueDate: '2026-09-01', usd: 10 + i },
        { dueDate: '2026-10-02', usd: 20 + i },
      ],
    }));
    const payments = paymentsDue({ today: '2026-09-28', recurring, partners, upsale: { usd: 5, count: 1 }, arrears: null });
    const fact = (i: number): AttentionFact => ({
      kind: 'unconverted',
      level: 'warn',
      count: i + 1,
      key: 'unconverted',
      params: {
        n: { as: 'n', v: i + 1 },
        sums: { as: 'sums', v: Array.from({ length: 30 }, (_, k) => ({ currency: `C${k}`, amount: 123456.78 })) },
      },
      suffix: null,
      href: '/admin/fx',
    });
    const text = ownerSummaryText(
      facts({
        weekly: true,
        attention: { total: 40, top: Array.from({ length: 8 }, (_, i) => fact(i)) },
        tills: {
          usd: 1,
          count: 90,
          unrated: Array.from({ length: 12 }, (_, k) => ({ currency: `U${k}`, balance: 1e9, count: 7 })),
        },
        weeklyBlock: {
          payments,
          arrears: null,
          arrearsUnrated: [],
          pendingSpend: { count: 0, byCurrency: [], ownPocket: { count: 0, byCurrency: [] } },
          receivableUsd: 1,
        },
      }),
    );
    expect(text.length).toBeLessThanOrEqual(STAFF_TEXT_CAP);
    expect(text.endsWith(`\n${LINK}`)).toBe(true);
    // The list stops at eight and COUNTS the rest.
    expect(text).toMatch(/… yana \d+ ta/);
  });
});

describe('every attention sentence exists in all four bundles (#163)', () => {
  it('reads the keys out of the one list the facts are typed by', () => {
    const missing: string[] = [];
    for (const [name, bundle] of [
      ['ru', ru],
      ['uz', uz],
      ['zh-CN', zh],
      ['en', en],
    ] as const) {
      const att = (bundle as unknown as { dashboard: { att: Record<string, unknown> } }).dashboard.att;
      for (const key of ATTENTION_KEYS) if (typeof att[key] !== 'string') missing.push(`${name}: ${key}`);
    }
    expect(missing).toEqual([]);
    expect(ATTENTION_KEYS.length).toBeGreaterThan(20);
  });

  it('the profile switch has its words in all four', () => {
    for (const bundle of [ru, uz, zh, en]) {
      expect((bundle as unknown as { kechkiXulosa: { notifMuteOwner: string } }).kechkiXulosa.notifMuteOwner).toMatch(
        /20:00/,
      );
    }
  });
});
