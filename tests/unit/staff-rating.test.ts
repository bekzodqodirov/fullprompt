import { describe, expect, it } from 'vitest';
import {
  firstPlaceStreak,
  isPersonalRecord,
  previousMonth,
  previousWindow,
  rankStandings,
  ratingWindowEnding,
  runningWindow,
  type PostedWeek,
} from '@/modules/wms/staff/rating-math';
import {
  championHtml,
  deltaText,
  goalBar,
  ratingHtml,
  windowLabel,
  type RatingView,
} from '@/modules/wms/staff/rating-text';

/**
 * The Saturday rating (0134, his 4a/5a/6a): the window, the order, the
 * streak and the record — every literal worked out by hand, never by the
 * code under test.
 */

// 2026-10-17 is a Saturday. 18:00 in Tashkent = 13:00 UTC.
const SAT_18 = new Date('2026-10-17T13:00:00Z');

describe('ratingWindowEnding — Saturday 18:00 to Saturday 18:00 (4a)', () => {
  it('at 18:00 sharp on Saturday the week just ended is THIS Saturday’s', () => {
    const w = ratingWindowEnding(SAT_18);
    expect(w.key).toBe('2026-10-17');
    expect(w.to.toISOString()).toBe('2026-10-17T13:00:00.000Z');
    expect(w.from.toISOString()).toBe('2026-10-10T13:00:00.000Z');
  });

  it('a minute before, it is still last Saturday’s', () => {
    const w = ratingWindowEnding(new Date('2026-10-17T12:59:00Z'));
    expect(w.key).toBe('2026-10-10');
    expect(w.to.toISOString()).toBe('2026-10-10T13:00:00.000Z');
  });

  it('on Sunday and on Friday the last closed week ended the Saturday before', () => {
    expect(ratingWindowEnding(new Date('2026-10-18T09:00:00Z')).key).toBe('2026-10-17');
    expect(ratingWindowEnding(new Date('2026-10-23T18:00:00Z')).key).toBe('2026-10-17');
  });

  it('Saturday 01:00 in Tashkent is still Friday night’s week (UTC says Friday)', () => {
    // 2026-10-16T20:00Z = Saturday 01:00 Tashkent.
    expect(ratingWindowEnding(new Date('2026-10-16T20:00:00Z')).key).toBe('2026-10-10');
  });

  it('previous and running windows touch with no gap', () => {
    const w = ratingWindowEnding(SAT_18);
    const p = previousWindow(w);
    expect(p.key).toBe('2026-10-10');
    expect(p.to.getTime()).toBe(w.from.getTime());
    const now = new Date('2026-10-19T06:00:00Z');
    const r = runningWindow(now);
    expect(r.from.getTime()).toBe(w.to.getTime());
    expect(r.to.getTime()).toBe(now.getTime());
  });
});

describe('rankStandings — kub, then kg, then the name (5a)', () => {
  it('orders by kub, shares a place only on equal kub AND kg, and drops the empty', () => {
    const ranked = rankStandings([
      { userId: 'c', name: 'Cho', m3: 5, kg: 900, receipts: 1 },
      { userId: 'a', name: 'Ali', m3: 12.4, kg: 1850, receipts: 5 },
      { userId: 'z', name: 'Zero', m3: 0, kg: 0, receipts: 0 },
      { userId: 'b', name: 'Bek', m3: 5, kg: 900, receipts: 2 },
      { userId: 'd', name: 'Dil', m3: 5, kg: 1000, receipts: 1 },
    ]);
    expect(ranked.map((r) => `${r.rank}:${r.userId}`)).toEqual(['1:a', '2:d', '3:b', '3:c']);
  });
});

const week = (key: string, rows: [string, number, number][]): PostedWeek => ({
  key,
  rows: rows.map(([userId, rank, m3]) => ({ userId, name: userId, rank, m3, kg: 0, receipts: 1 })),
});

describe('firstPlaceStreak — read from what the group SAW', () => {
  const posted = [week('2026-10-10', [['a', 1, 9]]), week('2026-10-03', [['a', 1, 8]]), week('2026-09-26', [['b', 1, 7]])];
  it('counts consecutive first places, this week included', () => {
    expect(firstPlaceStreak('a', '2026-10-17', posted)).toBe(3);
    expect(firstPlaceStreak('b', '2026-10-17', posted)).toBe(1);
  });
  it('a week nobody posted breaks the run', () => {
    const gap = [week('2026-10-03', [['a', 1, 8]])];
    expect(firstPlaceStreak('a', '2026-10-17', gap)).toBe(1);
  });
});

describe('isPersonalRecord', () => {
  const posted = [week('2026-10-10', [['a', 2, 6]]), week('2026-10-03', [['a', 1, 8]])];
  it('more than every week before, after at least two', () => {
    expect(isPersonalRecord('a', 8.5, '2026-10-17', posted)).toBe(true);
    expect(isPersonalRecord('a', 8, '2026-10-17', posted)).toBe(false);
  });
  it('a first or second appearance is never «a record»', () => {
    expect(isPersonalRecord('a', 99, '2026-10-17', posted.slice(0, 1))).toBe(false);
    expect(isPersonalRecord('new', 99, '2026-10-17', posted)).toBe(false);
  });
});

describe('previousMonth', () => {
  it('the month before, in Tashkent, January included', () => {
    expect(previousMonth(new Date('2026-10-08T13:00:00Z'))).toBe('2026-09');
    expect(previousMonth(new Date('2027-01-08T13:00:00Z'))).toBe('2026-12');
    // 2026-10-31T20:00Z is already 1 November in Tashkent.
    expect(previousMonth(new Date('2026-10-31T20:00:00Z'))).toBe('2026-10');
  });
});

/** groupDigits groups thousands with a NO-BREAK space — a literal written by hand says so. */
const nb = (text: string) => text.replace(/(\d) (\d)/g, '$1\u00a0$2');

describe('the words', () => {
  it('deltaText: up, down, still and new', () => {
    expect(deltaText(12.4, 9.3)).toBe(' ▲ +3.1');
    expect(deltaText(5, 5.4)).toBe(' ▼ −0.4');
    expect(deltaText(5, 5)).toBe('');
    expect(deltaText(5, null)).toBe(' 🆕');
  });

  it('goalBar fills by tenths and never past ten', () => {
    expect(goalBar(32.5, 40)).toBe('▓▓▓▓▓▓▓▓░░');
    expect(goalBar(99, 40)).toBe('▓▓▓▓▓▓▓▓▓▓');
  });

  it('windowLabel prints Tashkent time', () => {
    expect(windowLabel(new Date('2026-10-10T13:00:00Z'), new Date('2026-10-17T13:00:00Z'))).toBe(
      '10.10 18:00 — 17.10 18:00',
    );
  });

  const view = (over: Partial<RatingView> = {}): RatingView => ({
    from: new Date('2026-10-10T13:00:00Z'),
    to: new Date('2026-10-17T13:00:00Z'),
    rows: [
      { userId: 'a', name: 'Ali <b>', m3: 12.4, kg: 1850, receipts: 5, rank: 1, hero: { name: 'Ali <b>', telegramUserId: '777' }, before: 9.3 },
      { userId: 'b', name: 'Bek', m3: 9.8, kg: 1420, receipts: 4, rank: 2, hero: { name: 'Bek', telegramUserId: null }, before: null },
    ],
    team: { m3: 22.2, kg: 3270, receipts: 9 },
    teamBefore: 18.1,
    goalM3: 40,
    streaks: [{ name: 'Ali <b>', weeks: 3 }],
    records: [{ name: 'Bek', m3: 9.8 }],
    unstamped: { m3: 3.2, receipts: 2 },
    idleSellers: 2,
    ...over,
  });

  it('the rating names the podium, escapes every name, and carries no money', () => {
    const html = ratingHtml(view());
    expect(html).toContain(nb('🥇 <a href="tg://user?id=777"><b>Ali &lt;b&gt;</b></a> — 12.4 kub · 1 850 kg · 5 prixod ▲ +3.1'));
    expect(html).toContain(nb('🥈 <b>Bek</b> — 9.8 kub · 1 420 kg · 4 prixod 🆕'));
    expect(html).toContain("o'tgan hafta 18.1 kub ▲ +4.1");
    expect(html).toContain('Jamoa maqsadi: 22.2 / 40 kub — 55 % ▓▓▓▓▓░░░░░');
    expect(html).toContain("🔥 Ali &lt;b&gt; — 3 hafta ketma-ket 1-o'rinda!");
    expect(html).toContain('⭐ Bek — shaxsiy rekord: 9.8 kub!');
    expect(html).toContain('Sotuvchisi yozilmagan yuk: 3.2 kub (2 prixod)');
    expect(html).toContain('yuk olib kelmagan sotuvchilar: 2 kishi');
    expect(html).not.toMatch(/\$|USD|so['‘]m|foyda/i);
  });

  it('a reached goal says so; no goal, no line', () => {
    expect(ratingHtml(view({ goalM3: 20 }))).toContain('Jamoa maqsadi 20 kub — bajarildi!');
    expect(ratingHtml(view({ goalM3: null }))).not.toContain('maqsad');
  });

  it('twenty names and a count — never past Telegram’s 4096', () => {
    const rows = Array.from({ length: 45 }, (_, n) => ({
      userId: `u${n}`,
      name: `Sotuvchi juda uzun ism familiya ${n}`,
      m3: 50 - n,
      kg: 9000,
      receipts: 9,
      rank: n + 1,
      hero: { name: `Sotuvchi juda uzun ism familiya ${n}`, telegramUserId: '1234567890' },
      before: 1,
    }));
    const html = ratingHtml(view({ rows }));
    expect(html).toContain('… yana 25 kishi');
    expect(html.length).toBeLessThan(4096);
  });

  it('the champion names the month and the podium only', () => {
    const html = championHtml({
      month: '2026-09',
      rows: [
        { userId: 'a', name: 'Ali', m3: 52.1, kg: 7800, receipts: 21, rank: 1, hero: { name: 'Ali', telegramUserId: null } },
        { userId: 'd', name: 'Dil', m3: 1, kg: 10, receipts: 1, rank: 4, hero: { name: 'Dil', telegramUserId: null } },
      ],
      team: { m3: 53.1, kg: 7810, receipts: 22 },
    });
    expect(html).toContain('Oy chempioni — Sentabr 2026');
    expect(html).toContain(nb('🥇 <b>Ali</b> — 52.1 kub · 7 800 kg · 21 prixod'));
    expect(html).not.toContain('Dil');
  });
});
