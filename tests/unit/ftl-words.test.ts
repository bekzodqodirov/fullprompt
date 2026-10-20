import { describe, expect, it } from 'vitest';
import { soleOwnerOf, type SoleOwnerInputs } from '@/modules/wms/ftl/sole-owner';
import { ftlHintText, HINT_RECEIPTS } from '@/modules/wms/ftl/hint-text';
import { firstCargoHtml, leadWonHtml, type WonFacts } from '@/modules/wms/staff/celebrate-text';
import { ftlBlock, ratingHtml, type RatingView } from '@/modules/wms/staff/rating-text';
import { markingOfCode } from '@/modules/wms/pickups/owner-match';

/**
 * LTL / FTL (0135) — the pure halves: who owns a whole truck (7a), the hint's
 * words, the rating's separate line (3b) and the won post's label (4a).
 */

const io = (over: Partial<SoleOwnerInputs> = {}): SoleOwnerInputs => ({
  samePerson: () => false,
  markingOf: markingOfCode,
  markingOwner: () => null,
  ...over,
});

describe('soleOwnerOf (7a)', () => {
  it('one client is one owner; two are none', () => {
    expect(soleOwnerOf([{ clientId: 'c1', clientCode: 'GS500', marking: null }], io())).toEqual(['c1']);
    expect(
      soleOwnerOf(
        [
          { clientId: 'c1', clientCode: 'GS500', marking: null },
          { clientId: 'c2', clientCode: 'GS501', marking: null },
        ],
        io(),
      ),
    ).toBeNull();
  });

  it('two codes of one person (a shared phone, even through a chain) are one owner', () => {
    const lots = [
      { clientId: 'c1', clientCode: 'GS444', marking: null },
      { clientId: 'c2', clientCode: 'GS555', marking: null },
      { clientId: 'c3', clientCode: 'GS777', marking: null },
    ];
    const chain = (a: string, b: string) => new Set([a, b]).has('c2') && a !== b;
    expect(soleOwnerOf(lots, io({ samePerson: chain }))?.sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('an unclaimed lot is the owner’s only by its marking; a stranger’s marking is a second owner', () => {
    const own = { clientId: null, clientCode: null, marking: 'GS500MANIKEN' };
    const other = { clientId: null, clientCode: null, marking: 'GS5000X' };
    const claimed = { clientId: 'c1', clientCode: 'GS500', marking: null };
    expect(soleOwnerOf([claimed, own], io())).toEqual(['c1']);
    expect(soleOwnerOf([claimed, other], io())).toBeNull();
  });

  it('an all-unclaimed truck hints when its markings name one client', () => {
    const lots = [
      { clientId: null, clientCode: null, marking: 'GS500MANIKEN' },
      { clientId: null, clientCode: null, marking: 'GS500-AL' },
    ];
    const one = io({ markingOwner: () => ({ clientId: 'c1', clientCode: 'GS500' }) });
    expect(soleOwnerOf(lots, one)).toEqual(['c1']);
    expect(soleOwnerOf(lots, io())).toBeNull();
    expect(soleOwnerOf([], one)).toBeNull();
  });
});

describe('the hint’s words', () => {
  const facts = {
    batchCode: 'YW-045',
    clientCode: 'GS500',
    clientName: 'Ali <Valiyev>',
    sellerNames: ['Aziz'],
    boxes: 312,
    m3: 84.2,
    kg: 9870,
    planM3: 86,
    receipts: Array.from({ length: HINT_RECEIPTS + 2 }, (_, i) => ({
      number: `R-${i}`,
      dealCode: i === 0 ? null : 'B-000125',
      m3: 6,
      kg: 700,
    })),
    ftlDealCode: 'B-000125',
    link: 'https://gsrwms.uz/batches/x',
  };

  it('names the truck, the client, the seller and the LTL prixods — no money — and ends on the link', () => {
    const text = ftlHintText(facts);
    const lines = text.split('\n');
    expect(lines[0]).toBe("🚛 FTL bo'lishi mumkin — tekshiring");
    expect(text).toContain('YW-045: mashinada faqat bitta mijozning yuki');
    expect(text).toContain('👤 GS500 Ali <Valiyev> · sotuvchi: Aziz');
    expect(text).toContain('reja 86 kub (98 %)');
    expect(text).toContain('• R-0 · bitimsiz — 6 kub');
    expect(text).toContain(`… +2`);
    expect(text).toContain('Mijozning FTL bitimi bor: B-000125 — bitimsiz prixodlarni shunga biriktiring.');
    expect(lines.at(-1)).toBe('https://gsrwms.uz/batches/x');
    expect(text).not.toMatch(/\$|USD|so'm/);
  });
});

describe('the rating’s FTL line (3b)', () => {
  const view = (over: Partial<RatingView> = {}): RatingView => ({
    from: new Date('2026-10-10T13:00:00Z'),
    to: new Date('2026-10-17T13:00:00Z'),
    rows: [],
    team: { m3: 0, kg: 0, receipts: 0 },
    teamBefore: null,
    goalM3: null,
    streaks: [],
    records: [],
    unstamped: { m3: 0, receipts: 0 },
    idleSellers: 0,
    ftl: [],
    ...over,
  });

  it('comes AFTER the team line, plain names, kub first, no points', () => {
    const text = ratingHtml(
      view({
        rows: [{ userId: 'b', name: 'Bek', m3: 7, kg: 900, receipts: 1, rank: 1, hero: { name: 'Bek', telegramUserId: null }, before: null }],
        team: { m3: 7, kg: 900, receipts: 1 },
        ftl: [{ userId: 'a', name: 'Vali <x>', m3: 82, kg: 9500, receipts: 1 }],
      }),
    );
    expect(text.indexOf('🚛 <b>FTL — butun mashina (ochkosiz):</b>')).toBeGreaterThan(text.indexOf('Jamoa:'));
    expect(text).toContain('Vali &lt;x&gt; — 82 kub · 9 500 kg · 1 prixod');
  });

  it('«nobody brought cargo» never contradicts an FTL line under it', () => {
    const text = ratingHtml(view({ ftl: [{ userId: 'a', name: 'Vali', m3: 82, kg: 9500, receipts: 1 }] }));
    expect(text).toContain('Bu hafta sborniy (LTL) yuk hali olib kelinmadi.');
    expect(ratingHtml(view())).toContain('Bu hafta hali yuk olib kelinmadi.');
    expect(ftlBlock([])).toEqual([]);
  });
});

describe('the won post and the first cargo (4a)', () => {
  const hero = { name: 'Aziz', telegramUserId: null };
  const facts: WonFacts = {
    clientCode: 'GS512',
    amount: 2450,
    currency: 'USD',
    m3: 18.5,
    kg: 2300,
    ftl: true,
    monthWins: 3,
    monthUsd: 9800,
  };

  it('an FTL win says so and carries no month line', () => {
    const html = leadWonHtml(hero, facts, 0);
    expect(html).toContain('🚛 <b>FTL</b> — butun mashina');
    expect(html).not.toContain('Bu oy');
    expect(leadWonHtml(hero, { ...facts, ftl: false }, 0)).toContain('Bu oy');
  });

  it('an FTL first cargo is labelled; an LTL one is not', () => {
    expect(firstCargoHtml(hero, 'GS512', { m3: 82, kg: 9500, place: null, ftl: true }, 0)).toContain('🚛 <b>FTL</b> · ');
    expect(firstCargoHtml(hero, 'GS512', { m3: 2, kg: 300, place: null }, 0)).not.toContain('FTL');
  });
});
