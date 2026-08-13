import { describe, expect, it } from 'vitest';
import { renderClientCabinetText } from '@/modules/platform/notifications/service';
import {
  CLIENT_LOCALES,
  allLabelVariants,
  clientLabels,
  isClientLocale,
  localeFromTelegram,
  stageLabel,
} from '@/modules/platform/telegram/client-labels';

/**
 * What the CLIENT reads, in the CLIENT's language.
 *
 * These are the only texts in the system a customer ever sees, and until this
 * round they were ~30 hard-coded Uzbek literals with two Russian staff
 * sentences mixed in. Nothing in the suite asserted a single cabinet string,
 * which is why translating the menu buttons was dangerous: they double as the
 * bot's router.
 */

const ARRIVED = {
  clientCode: 'GS777',
  number: 'YW-IN-260727-006',
  warehouseCode: 'YW',
  lots: [
    { letter: 'A', productNameZh: '手机壳', productNameRu: 'Чехлы', boxCount: 6, totalWeightKg: '48.5', totalVolumeM3: '0.6' },
    { letter: 'B', productNameZh: '杂货', productNameRu: null, boxCount: 4, totalWeightKg: '20', totalVolumeM3: '0.4' },
  ],
};

describe('cargo arrived at the Chinese warehouse', () => {
  it('is sent at all — it was the silent half of the journey', () => {
    // Before this, a client heard nothing until the cargo reached Uzbekistan.
    expect(renderClientCabinetText('ReceiptConfirmed', ARRIVED, 'uz')).not.toBeNull();
  });

  it('carries the code, the receipt, the warehouse and the totals', () => {
    const text = renderClientCabinetText('ReceiptConfirmed', ARRIVED, 'uz')!;
    expect(text).toContain('GS777');
    expect(text).toContain('YW-IN-260727-006');
    expect(text).toContain('YW');
    // 6 + 4 boxes, 48.5 + 20 kg, 0.6 + 0.4 m³ — summed across the lots.
    expect(text).toContain('10');
    expect(text).toContain('68.5');
    expect(text).toContain('1');
  });

  it('prefers the translated product name over the Chinese one', () => {
    // The name is stored Chinese-first with a NULLABLE translation. Without a
    // deliberate fallback an Uzbek client is shown 手机壳 and has to guess.
    const text = renderClientCabinetText('ReceiptConfirmed', ARRIVED, 'uz')!;
    expect(text).toContain('Чехлы');
    expect(text).not.toContain('手机壳');
    // …and where there IS no translation, the Chinese is better than nothing.
    expect(text).toContain('杂货');
  });

  it('says nothing when there is nothing to say', () => {
    expect(renderClientCabinetText('ReceiptConfirmed', { ...ARRIVED, lots: [] }, 'uz')).toBeNull();
    expect(renderClientCabinetText('ReceiptConfirmed', {}, 'uz')).toBeNull();
  });

  it('speaks each of the three languages', () => {
    const seen = CLIENT_LOCALES.map(
      (locale) => renderClientCabinetText('ReceiptConfirmed', ARRIVED, locale)!,
    );
    expect(seen.every(Boolean)).toBe(true);
    // Three different sentences, not one string three times.
    expect(new Set(seen).size).toBe(3);
    expect(seen[0]).toContain('Yukingiz');
    expect(seen[1]).toContain('груз');
    expect(seen[2]).toContain('cargo');
  });

  it('still says something to a client whose language was never asked', () => {
    // NULL locale is the state of every client on the owner's live database
    // the moment this ships — it must not produce an empty or broken message.
    expect(renderClientCabinetText('ReceiptConfirmed', ARRIVED, null)).toBeTruthy();
    expect(renderClientCabinetText('ReceiptConfirmed', ARRIVED, undefined)).toBeTruthy();
    expect(renderClientCabinetText('ReceiptConfirmed', ARRIVED, 'kl-KL')).toBeTruthy();
  });

  it('leaves events that are none of the client’s business alone', () => {
    expect(renderClientCabinetText('UnknownCargoReceived', ARRIVED, 'uz')).toBeNull();
    expect(renderClientCabinetText('DealDeviation', ARRIVED, 'uz')).toBeNull();
    expect(renderClientCabinetText('BackupFailed', {}, 'uz')).toBeNull();
  });
});

describe('cargo handed to the client (round 100, item 6)', () => {
  const ISSUED = {
    clientCode: 'GS777',
    warehouseCode: 'TAS',
    boxCount: 3,
    personName: 'Oluvchi Aka',
    remaining: 2,
    lots: [
      { letter: 'A', productNameZh: '手机壳', productNameRu: 'Чехлы', boxCount: 2, totalWeightKg: 16, totalVolumeM3: 0.2 },
      { letter: 'B', productNameZh: '杂货', productNameRu: null, boxCount: 1, totalWeightKg: 5, totalVolumeM3: 0.027 },
    ],
  };

  it('carries the goods, the kilos and the cubes — not a bare box count', () => {
    // Owner: «Yukingiz berildi degandan keyin toliq necha dona necha kub
    // necha kg nima tovar berilganini telegram jonatsin».
    const text = renderClientCabinetText('BoxIssued', ISSUED, 'uz')!;
    expect(text).toContain('Чехлы');
    expect(text).toContain('杂货');
    expect(text).toContain('21'); // 16 + 5 kg
    expect(text).toContain('0.23'); // 0.2 + 0.027 m³, two decimals
    expect(text).toContain('Oluvchi Aka');
    expect(text).toContain('3');
  });

  it('an event from before this round still renders, without inventing totals', () => {
    // The events table holds years of BoxIssued rows with no `lots` — a
    // replay or late worker must not crash or print «0 kg» about them.
    const old: Record<string, unknown> = { ...ISSUED };
    delete old.lots;
    const text = renderClientCabinetText('BoxIssued', old, 'uz')!;
    expect(text).toContain('GS777');
    expect(text).toContain('Oluvchi Aka');
    expect(text).not.toContain('kg');
  });
});

describe('the client’s language', () => {
  it('takes the primary subtag from Telegram, and only if we speak it', () => {
    expect(localeFromTelegram('ru')).toBe('ru');
    expect(localeFromTelegram('en-GB')).toBe('en');
    expect(localeFromTelegram('uz-Latn')).toBe('uz');
    // Not a cabinet language: leave it unset rather than guess wrong.
    expect(localeFromTelegram('zh-hans')).toBeNull();
    expect(localeFromTelegram('')).toBeNull();
    expect(localeFromTelegram(null)).toBeNull();
  });

  it('gives a Chinese-speaking client a real sentence, not a blank', () => {
    // The staff app has four languages and the cabinet three; a client whose
    // Telegram is Chinese must not fall into a hole.
    expect(isClientLocale('zh-CN')).toBe(false);
    expect(clientLabels('zh-CN').btnCargo).toBe(clientLabels('ru').btnCargo);
  });

  /*
   * REWRITTEN in round 98 with its subject.
   *
   * It used to check that every raw BOX STATUS had a client word — warehouse
   * vocabulary («planned», «in_stock») answering a question no customer
   * asked. The cabinet now speaks the owner's own ladder; every rung having a
   * sentence is asserted in `cargo-stages.test.ts`, which can see both halves.
   * What is left here is the fallback, which is a fact about this function.
   */
  it('an unknown rung shows its own name rather than crashing a reply', () => {
    const labels = clientLabels('uz');
    expect(stageLabel('ready', labels)).not.toBe('ready');
    expect(stageLabel('teleported', labels)).toBe('teleported');
  });
});

describe('the menu buttons are also the router', () => {
  /**
   * The trap this round had to design around: `bot.hears(BTN_CARGO)` matches
   * the literal button text. Translating the keyboard without widening the
   * matcher gives a Russian-speaking client a cabinet whose buttons do
   * nothing at all — and no test in this repo would have caught it.
   */
  it('offers every language’s label for matching, not just one', () => {
    for (const key of ['btnCargo', 'btnBalance', 'btnHistory', 'btnLanguage'] as const) {
      const variants = allLabelVariants(key);
      expect(variants, key).toHaveLength(CLIENT_LOCALES.length);
      // Distinct per language — otherwise a matcher built from them would
      // quietly cover fewer cases than it appears to.
      expect(new Set(variants).size, key).toBe(CLIENT_LOCALES.length);
      for (const locale of CLIENT_LOCALES) {
        expect(variants, `${key}/${locale}`).toContain(clientLabels(locale)[key]);
      }
    }
  });
});
