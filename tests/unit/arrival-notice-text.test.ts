import { describe, expect, it } from 'vitest';
import { clientLabels } from '@/modules/platform/telegram/client-labels';
import { htmlToPlain } from '@/modules/platform/telegram/format';
import type { ArrivedSummary } from '@/modules/wms/notices/arrival';
import { arrivalCleared, arrivalText } from '@/modules/wms/notices/arrival-text';
import { PUSH_LOT_LINES } from '@/modules/wms/notices/client-text';

const SUMMARY: ArrivedSummary = {
  lines: [
    { lotId: 'lot-a', letter: 'A', name: 'Чехлы', boxCount: 8, weightKg: 40, volumeM3: 0.216 },
    { lotId: 'lot-b', letter: 'B', name: 'Наушники', boxCount: 2, weightKg: 6.5, volumeM3: 0.0405 },
  ],
  boxCount: 10,
  weightKg: 46.5,
  volumeM3: 0.2565,
  warehouseCode: 'TAS1',
  warehouseName: 'Toshkent 1',
};

const plain = (html: string) => htmlToPlain(html);

describe('arrivalText', () => {
  it('says what arrived: every lot, the count, the kilos and the cubic metres', () => {
    const text = plain(arrivalText(SUMMARY, 'GS777', 'uz'));
    expect(text).toContain('GS777');
    // The warehouse by NAME — re-anchored ON PURPOSE in round C: «TAS1» is the
    // staff's code and the customer drives to «Toshkent 1» (the Mini App has
    // printed names since round 98; the push was the last surface on codes).
    expect(text).toContain('Toshkent 1');
    expect(text).not.toContain('TAS1');
    expect(text).toContain('Чехлы');
    expect(text).toContain('Наушники');
    expect(text).toContain('10');
    expect(text).toContain('46.5');
    // Three places since round C — the Mini App's own rounding, so the push
    // and the app print one number (was «0.26» at two places, re-anchored on
    // purpose; two places printed a 0.004 m³ lot as «0»).
    expect(text).toContain('0.257');
  });

  it('never names the truck', () => {
    // A batch code is the company's throughput published to anyone who buys
    // one carton, and the truck carries twenty other customers. The summary
    // has no field for it and this says so from the outside.
    const text = plain(arrivalText(SUMMARY, 'GS777', 'uz', { date: new Date('2026-09-27T06:00:00Z') }));
    expect(text).not.toMatch(/\b[A-Z]{2,5}-\d{3,}\b/);
  });

  it('is written in the client’s language, and an unknown one still gets a sentence', () => {
    const uz = arrivalText(SUMMARY, 'GS777', 'uz');
    const ru = arrivalText(SUMMARY, 'GS777', 'ru');
    const en = arrivalText(SUMMARY, 'GS777', 'en');
    expect(uz).not.toBe(ru);
    expect(ru).not.toBe(en);
    expect(uz).toContain('Yukingiz');
    expect(ru).toContain('груз');
    expect(en).toContain('arrived');
    for (const locale of [null, undefined, 'zh-CN', 'kl-KL']) {
      expect(arrivalText(SUMMARY, 'GS777', locale).length).toBeGreaterThan(20);
    }
  });

  it('rounds the numbers a person would read, never prints float noise', () => {
    const text = arrivalText(
      { ...SUMMARY, weightKg: 46.499999999, volumeM3: 0.2565000001 },
      'GS777',
      'uz',
    );
    expect(text).not.toContain('46.499999');
    expect(text).not.toContain('0.2565000001');
  });

  it('stands on the «ready» step — the word the Mini App shows for the same boxes', () => {
    // Judge STATE-1: the notice is claimed only for ready_for_pickup boxes and
    // the cabinet calls those «Olib ketishga tayyor». The push used to say
    // «after clearance» about the same cartons.
    const t = clientLabels('uz');
    const text = plain(arrivalText(SUMMARY, 'GS777', 'uz'));
    expect(text).toContain(`🟩🟩🟩🟩⬜ ${t.msReady}`);
  });

  it('says customs are behind it only when they are', () => {
    const t = clientLabels('uz');
    const cleared = plain(arrivalText(SUMMARY, 'GS777', 'uz', { cleared: true }));
    expect(cleared).toContain(t.pushReadyCleared);
    expect(cleared).not.toContain(t.readyNote);
    const pending = plain(arrivalText(SUMMARY, 'GS777', 'uz', { cleared: false }));
    expect(pending).toContain(t.readyNote);
    expect(pending).not.toContain(t.pushReadyCleared);
  });

  it('a truck that never crossed a border carries cleared cargo (judge CX-3)', () => {
    expect(arrivalCleared(null, 'UZ')).toBe(true);
    expect(arrivalCleared(new Date(), 'CN')).toBe(true);
    expect(arrivalCleared(null, 'CN')).toBe(false);
    expect(arrivalCleared(undefined, null)).toBe(false);
  });

  it('prints the address under the name when the office typed one, escaped', () => {
    const html = arrivalText({ ...SUMMARY, warehouseAddress: 'Chilonzor <5-mavze> & ombor' }, 'GS777', 'uz');
    expect(html).toContain('📍 Chilonzor &lt;5-mavze&gt; &amp; ombor');
    expect(arrivalText(SUMMARY, 'GS777', 'uz')).not.toContain('📍');
  });

  it('a goods name cannot become markup — the whole message would be refused', () => {
    const html = arrivalText(
      { ...SUMMARY, lines: [{ ...SUMMARY.lines[0]!, name: 'Kurtka <b>&</b> shim' }] },
      'GS777',
      'uz',
    );
    expect(html).toContain('Kurtka &lt;b&gt;&amp;&lt;/b&gt; shim');
    expect(html).not.toContain('<b>&</b>');
  });

  it('fifty lots do not make a message Telegram refuses — the list is capped, the total is not', () => {
    const lines = Array.from({ length: 50 }, (_, i) => ({
      lotId: `lot-${i}`,
      letter: String.fromCharCode(65 + (i % 26)),
      name: 'Juda uzun tovar nomi '.repeat(15),
      boxCount: 1,
      weightKg: 1,
      volumeM3: 0.01,
    }));
    const html = arrivalText({ ...SUMMARY, lines, boxCount: 50, weightKg: 50, volumeM3: 0.5 }, 'GS777', 'uz');
    const text = plain(html);
    expect(text.length).toBeLessThan(4096);
    expect(text.match(/📦/g)).toHaveLength(PUSH_LOT_LINES);
    expect(text).toContain(`yana ${50 - PUSH_LOT_LINES} ta`);
    expect(text).toContain('50 quti');
  });
});
