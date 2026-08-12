import { describe, expect, it } from 'vitest';
import type { ArrivedSummary } from '@/modules/wms/notices/arrival';
import { arrivalText } from '@/modules/wms/notices/arrival-text';

const SUMMARY: ArrivedSummary = {
  lines: [
    { letter: 'A', name: 'Чехлы', boxCount: 8, weightKg: 40, volumeM3: 0.216 },
    { letter: 'B', name: 'Наушники', boxCount: 2, weightKg: 6.5, volumeM3: 0.0405 },
  ],
  boxCount: 10,
  weightKg: 46.5,
  volumeM3: 0.2565,
  warehouseCode: 'TAS1',
};

describe('arrivalText', () => {
  it('says what arrived: every lot, the count, the kilos and the cubic metres', () => {
    const text = arrivalText(SUMMARY, 'GS777', 'uz');
    expect(text).toContain('GS777');
    expect(text).toContain('TAS1');
    expect(text).toContain('Чехлы');
    expect(text).toContain('Наушники');
    expect(text).toContain('10');
    expect(text).toContain('46.5');
    expect(text).toContain('0.26');
  });

  it('never names the truck', () => {
    // A batch code is the company's throughput published to anyone who buys
    // one carton, and the truck carries twenty other customers. The summary
    // has no field for it and this says so from the outside.
    const text = arrivalText(SUMMARY, 'GS777', 'uz');
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
});
