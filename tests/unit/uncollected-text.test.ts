import { describe, expect, it } from 'vitest';
import {
  OFFICE_LINES,
  SELLER_LINES,
  officeWaitingSection,
  sellerWaitingText,
  waitLine,
} from '@/modules/wms/issue/waiting-alerts';
import {
  readUncollectedFilters,
  tabMinDays,
  waitDays,
  waitLevel,
  waitRowKey,
  type UncollectedRow,
} from '@/modules/wms/issue/waiting';

/**
 * «Olib ketilmagan yuk»'s words (0116) — pure, so the rules are provable
 * without a Telegram. Uzbek like every staff message, one line per client at
 * its HIGHEST level, capped with the count of what it did not name, and the
 * list's link on the last line (the drain turns it into «↗️ Ochish»).
 */

const T = { warn: 5, alarm: 10 };
const LINK = 'https://gsrwms.uz/my-clients/olib-ketilmagan';

function row(over: Partial<UncollectedRow> & { clientCode: string }): UncollectedRow {
  return {
    clientId: `c-${over.clientCode}`,
    clientName: 'Yo‘lchi',
    phones: [],
    sellerId: 's-1',
    sellerName: 'Alisher',
    warehouseId: 'w-tas',
    warehouseCode: 'TAS1',
    customs: false,
    boxes: 40,
    kg: 312,
    m3: 1.8,
    goods: 'Kurtka',
    moreLots: 0,
    landedFrom: new Date('2026-09-14T04:00:00Z'),
    lastPickupAt: null,
    days: 12,
    leftover: false,
    clockFrom: new Date('2026-09-14T04:00:00Z'),
    ...over,
  };
}

describe('the waiting list\'s arithmetic', () => {
  it('counts whole calendar days, and the levels are the thresholds', () => {
    expect(waitDays('2026-09-21', '2026-09-26')).toBe(5);
    expect(waitDays('2026-02-27', '2026-03-01')).toBe(2);
    expect(waitLevel(4, T)).toBe(0);
    expect(waitLevel(5, T)).toBe(1);
    expect(waitLevel(10, T)).toBe(2);
    expect(waitLevel(null, T)).toBe(0);
  });

  it('reads the URL and drops what it cannot trust (#514)', () => {
    const wh = '0199a0b1-0000-7000-8000-000000000001';
    const seller = '0199a0b1-0000-7000-8000-000000000002';
    const all = readUncollectedFilters({ daraja: 'qizil', ombor: wh, sotuvchi: seller }, { seesAll: true, warehouseIds: [wh] });
    expect(all).toEqual({ tab: 'qizil', warehouseId: wh, sellerId: seller });
    // A seller's hand-typed `sotuvchi` is ignored, not obeyed.
    expect(readUncollectedFilters({ sotuvchi: seller }, { seesAll: false, warehouseIds: [] }).sellerId).toBeNull();
    // A warehouse the viewer cannot read is no filter at all.
    expect(readUncollectedFilters({ ombor: wh }, { seesAll: true, warehouseIds: [] }).warehouseId).toBeNull();
    // Garbage falls back to the 5+ tab; `none` is a real seller answer.
    const odd = readUncollectedFilters({ daraja: '10', sotuvchi: 'none' }, { seesAll: true, warehouseIds: [] });
    expect(odd).toEqual({ tab: 'sariq', warehouseId: null, sellerId: 'none' });
    expect(readUncollectedFilters({ sotuvchi: "x' OR 1=1" }, { seesAll: true, warehouseIds: [] }).sellerId).toBeNull();
    expect([tabMinDays('qizil', T), tabMinDays('sariq', T), tabMinDays('hammasi', T)]).toEqual([10, 5, 0]);
  });
});

describe('the seller\'s morning message', () => {
  it('names each client once, at its highest level, in Uzbek, and ends with the list', () => {
    const a = row({ clientCode: 'GS555', days: 12, leftover: true });
    const b = row({ clientCode: 'GS777', clientName: 'Anvar', days: 6, warehouseCode: 'AND', customs: true, boxes: 3, kg: 30 });
    const levels = new Map([
      [waitRowKey(a), 2 as const],
      [waitRowKey(b), 1 as const],
    ]);
    const text = sellerWaitingText({
      fresh: [a, b],
      levels,
      thresholds: T,
      waitingClients: 7,
      unpriced: new Map([[waitRowKey(a), 5]]),
      link: LINK,
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('⏳ Olib ketilmagan yuk');
    expect(lines[1]).toBe('🔴 10+ kun:');
    expect(lines[2]).toBe('• GS555 Yo‘lchi — TAS1 · 40 kor. · 312 kg · 12 kun (qoldiq) · narxsiz 5 kor.');
    expect(lines[3]).toBe('🟡 5+ kun:');
    expect(lines[4]).toBe('• GS777 Anvar — AND · 3 kor. · 30 kg · 6 kun · bojxona skladi');
    expect(lines.at(-2)).toBe('Jami kutmoqda: 7 mijoz');
    expect(lines.at(-1)).toBe(`🔗 ${LINK}`);
    expect(text.split('\n').filter((l) => l.includes('GS555'))).toHaveLength(1);
    expect(text, 'no Russian').not.toMatch(/[А-Яа-яЁё]/);
  });

  it('a deploy morning\'s backlog is one message: capped, and says how many it did not name', () => {
    const many = Array.from({ length: SELLER_LINES + 7 }, (_, i) => row({ clientCode: `GS${1000 + i}`, days: 11 }));
    const levels = new Map(many.map((r) => [waitRowKey(r), 2 as const]));
    const text = sellerWaitingText({ fresh: many, levels, thresholds: T, waitingClients: many.length, unpriced: new Map(), link: LINK });
    expect(text.split('\n').filter((l) => l.startsWith('• '))).toHaveLength(SELLER_LINES);
    expect(text).toContain('… yana 7 ta');
    expect(text.split('\n').at(-1)).toBe(`🔗 ${LINK}`);
  });

  it('kilos in the house\'s dot decimal, never a comma', () => {
    expect(waitLine(row({ clientCode: 'GS1', kg: 1.25 }))).toContain('1.25 kg');
    // Thousands grouped with a NO-BREAK space, so a figure never wraps.
    expect(waitLine(row({ clientCode: 'GS1', kg: 12845.5 }))).toContain('12\u00a0845.5 kg');
  });
});

describe('the svodka\'s section', () => {
  it('counts per warehouse and per seller, names only today\'s crossings, and ends with the list', () => {
    const rows = [
      row({ clientCode: 'GS1', clientId: 'c1', days: 40 }),
      row({ clientCode: 'GS2', clientId: 'c2', days: 9, sellerName: null, sellerId: null, warehouseCode: 'AND', warehouseId: 'w-and' }),
      row({ clientCode: 'GS3', clientId: 'c3', days: 6 }),
    ];
    const today = new Map([[waitRowKey(rows[2]!), 1 as const]]);
    const lines = officeWaitingSection({ rows, today, thresholds: T, unpriced: new Map(), link: LINK });
    expect(lines[0]).toBe('⏳ Olib ketilmagan yuk (5+ kun): 3 mijoz, 120 kor.');
    expect(lines[1]).toBe('🏭 AND 1 · TAS1 2');
    expect(lines[2]).toBe('👥 Alisher 2 · sotuvchisiz 1');
    // The 40-day client is in the counts and NOT named again — it was named
    // the day it crossed; the one that crossed today is named.
    expect(lines.some((l) => l.includes('GS1 '))).toBe(false);
    expect(lines).toContain("Bugun ro'yxatga tushgan: 1");
    expect(lines.find((l) => l.includes('GS3'))).toContain('· Alisher');
    expect(lines.at(-1)).toBe(`🔗 ${LINK}`);
    expect(lines.join('\n')).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('is capped at the office\'s line budget', () => {
    const rows = Array.from({ length: OFFICE_LINES + 3 }, (_, i) =>
      row({ clientCode: `GS${i}`, clientId: `c${i}`, days: 6 }),
    );
    const today = new Map(rows.map((r) => [waitRowKey(r), 1 as const]));
    const lines = officeWaitingSection({ rows, today, thresholds: T, unpriced: new Map(), link: LINK });
    expect(lines.filter((l) => l.startsWith('• '))).toHaveLength(OFFICE_LINES);
    expect(lines).toContain('… yana 3 ta');
  });

  it('says nothing when nothing waits', () => {
    expect(officeWaitingSection({ rows: [], today: new Map(), thresholds: T, unpriced: new Map(), link: LINK })).toEqual([]);
  });
});
