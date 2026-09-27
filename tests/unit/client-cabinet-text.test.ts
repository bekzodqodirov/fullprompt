import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_LOCALES,
  allLabelVariants,
  clientLabels,
  isClientLocale,
  localeFromTelegram,
  stageLabel,
} from '@/modules/platform/telegram/client-labels';
import { htmlToPlain } from '@/modules/platform/telegram/format';
import {
  issuedText,
  pushLotName,
  receivedText,
  type IssuedSummary,
  type ReceivedSummary,
} from '@/modules/wms/notices/client-text';

/**
 * What the CLIENT reads, in the CLIENT's language.
 *
 * These are the only texts in the system a customer ever sees, and until this
 * round they were ~30 hard-coded Uzbek literals with two Russian staff
 * sentences mixed in. Nothing in the suite asserted a single cabinet string,
 * which is why translating the menu buttons was dangerous: they double as the
 * bot's router.
 *
 * RE-POINTED in round C, facts unchanged. «Qabul qilindi» and «berildi» left
 * the event drain (`renderClientCabinetText` rendered them from the event's
 * payload) for the notices sweep, which renders them from a SUMMARY read out
 * of the database at send time (`wms/notices/client-text.ts`). The same facts
 * are asserted against the new renderers: the code, the receipt number, the
 * goods names Russian-first with the Chinese fallback, the totals, the three
 * languages, the receiver, and «no kg» for a handover with no lots. The
 * messages are HTML now, so the assertions read the text a phone shows
 * (`htmlToPlain`).
 */

const RECEIVED: ReceivedSummary = {
  clientCode: 'GS777',
  receiptNumber: 'YW-IN-260727-006',
  warehouseName: 'Yiwu',
  receivedAt: new Date('2026-07-27T05:00:00Z'),
  stage: 'cn_warehouse',
  lines: [
    { lotId: 'lot-a', letter: 'A', name: pushLotName('Чехлы', '手机壳'), boxCount: 6, weightKg: 48.5, volumeM3: 0.6 },
    { lotId: 'lot-b', letter: 'B', name: pushLotName(null, '杂货'), boxCount: 4, weightKg: 20, volumeM3: 0.4 },
  ],
};

const plain = (html: string) => htmlToPlain(html);

describe('cargo arrived at the Chinese warehouse', () => {
  it('is sent at all — it was the silent half of the journey', () => {
    // Before this, a client heard nothing until the cargo reached Uzbekistan.
    expect(receivedText(RECEIVED, 'uz').length).toBeGreaterThan(20);
  });

  it('carries the code, the receipt, the warehouse and the totals', () => {
    const text = plain(receivedText(RECEIVED, 'uz'));
    expect(text).toContain('GS777');
    expect(text).toContain('YW-IN-260727-006');
    // The warehouse by NAME since round C — the code «YW» is staff jargon.
    expect(text).toContain('Yiwu');
    // 6 + 4 boxes, 48.5 + 20 kg, 0.6 + 0.4 m³ — summed across the lots.
    expect(text).toContain('10');
    expect(text).toContain('68.5');
    expect(text).toContain('1 m³');
  });

  it('prefers the translated product name over the Chinese one', () => {
    // The name is stored Chinese-first with a NULLABLE translation. Without a
    // deliberate fallback an Uzbek client is shown 手机壳 and has to guess.
    const text = plain(receivedText(RECEIVED, 'uz'));
    expect(text).toContain('Чехлы');
    expect(text).not.toContain('手机壳');
    // …and where there IS no translation, the Chinese is better than nothing.
    expect(text).toContain('杂货');
    expect(pushLotName('  ', '杂货')).toBe('杂货');
  });

  it('speaks each of the three languages', () => {
    const seen = CLIENT_LOCALES.map((locale) => receivedText(RECEIVED, locale));
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
    expect(receivedText(RECEIVED, null)).toBeTruthy();
    expect(receivedText(RECEIVED, undefined)).toBeTruthy();
    expect(receivedText(RECEIVED, 'kl-KL')).toBeTruthy();
  });

  it('the event drain says nothing to any customer any more (round C)', () => {
    // It used to render ReceiptConfirmed / BoxIssued from the event payload
    // and fetch Telegram inline — no deadline, no retry, a payload a
    // correction could not reach. The customer's copy is a claimed notice
    // now; nothing in the drain may reach a client chat again.
    const service = readFileSync('src/modules/platform/notifications/service.ts', 'utf8');
    expect(service).not.toContain('clientTelegramLinks');
    expect(service).not.toContain('renderClientCabinetText');
    expect(service).not.toContain('notifyLinkedClients');
  });
});

describe('cargo handed to the client (round 100, item 6)', () => {
  const ISSUED: IssuedSummary = {
    clientCode: 'GS777',
    warehouseName: 'Toshkent 1',
    issuedAt: new Date('2026-09-20T09:00:00Z'),
    boxCount: 3,
    personName: 'Oluvchi Aka',
    leftHere: 2,
    elsewhere: null,
    lines: [
      { lotId: 'lot-a', letter: 'A', name: 'Чехлы', boxCount: 2, weightKg: 16, volumeM3: 0.2 },
      { lotId: 'lot-b', letter: 'B', name: '杂货', boxCount: 1, weightKg: 5, volumeM3: 0.027 },
    ],
  };

  it('carries the goods, the kilos and the cubes — not a bare box count', () => {
    // Owner: «Yukingiz berildi degandan keyin toliq necha dona necha kub
    // necha kg nima tovar berilganini telegram jonatsin».
    const text = plain(issuedText(ISSUED, 'uz'));
    expect(text).toContain('Чехлы');
    expect(text).toContain('杂货');
    expect(text).toContain('21'); // 16 + 5 kg
    // 0.2 + 0.027 m³ — three places since round C, the Mini App's own rounding
    // (was «0.23» at two places; re-anchored ON PURPOSE, the push and the app
    // must print the same number).
    expect(text).toContain('0.227');
    expect(text).toContain('Oluvchi Aka');
    expect(text).toContain('3');
  });

  it('a handover with no lots known still renders, without inventing totals', () => {
    // The summary of a handover whose boxes cannot be found must not crash or
    // print «0 kg» about it.
    const text = plain(issuedText({ ...ISSUED, lines: [] }, 'uz'));
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
