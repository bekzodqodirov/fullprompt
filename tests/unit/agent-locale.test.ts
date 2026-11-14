import { describe, expect, it } from 'vitest';
import { detectLocale, dominantScript, scriptOf } from '@/modules/wms/agent/locale';

describe('detectLocale', () => {
  it('reads the six languages he answered for (his 13)', () => {
    expect(detectLocale('Assalomu alaykum, yukim qachon keladi?').locale).toBe('uz');
    expect(detectLocale("Bu yuk necha kub bo'ladi aka").locale).toBe('uz');
    expect(detectLocale('Ассалому алайкум, юким қачон келади?').locale).toBe('uz_cyrl');
    expect(detectLocale('Здравствуйте, сколько стоит доставка?').locale).toBe('ru');
    expect(detectLocale('Hello, how much is shipping from Yiwu?').locale).toBe('en');
    expect(detectLocale('سلام، قیمت حمل بار از چین چند است؟').locale).toBe('fa');
    expect(detectLocale('你好，运费多少钱？').locale).toBe('zh');
  });

  it('a Chinese line with a product code in Latin is still Chinese', () => {
    expect(detectLocale('GS777 的货什么时候到？').locale).toBe('zh');
  });

  it('a message that settles nothing keeps the conversation language and says it is unsure', () => {
    expect(detectLocale('ok', 'ru')).toEqual({ locale: 'ru', confident: false, script: 'latin' });
    expect(detectLocale('👍', 'fa')).toEqual({ locale: 'fa', confident: false, script: 'none' });
    expect(detectLocale('GS777', null)).toEqual({ locale: null, confident: false, script: 'latin' });
  });

  it('short Cyrillic in an Uzbek-Cyrillic conversation stays Uzbek', () => {
    expect(detectLocale('ок рахмат', 'uz_cyrl').locale).toBe('uz_cyrl');
    expect(detectLocale('ок', 'uz_cyrl').locale).toBe('uz_cyrl');
    expect(detectLocale('ок', 'ru').locale).toBe('ru');
  });

  // 0148 fix (the review's regress finding): «Cyrillic with no Uzbek mark» is how most Uzbek customers type — on a
  // Russian keyboard, «у» for «ў», «к» for «қ» — and it was «ru, confident», so the auto layer's language clause
  // refused every correct Uzbek Cyrillic reply to such a line. `confident` means a MARK in the text decided.
  it('Cyrillic that carries no mark of either language is a guess, and says so — the conversation keeps its language', () => {
    for (const line of ['Кийим-кечак, Гуанчжоудан жунатаман', '5 куб 800 кг', 'Иву шахридан', 'Гуанчжоудан юборилади']) {
      expect(detectLocale(line), line).toEqual({ locale: 'ru', confident: false, script: 'cyrillic' });
      expect(detectLocale(line, 'uz_cyrl'), line).toEqual({ locale: 'uz_cyrl', confident: false, script: 'cyrillic' });
      expect(detectLocale(line, 'ru'), line).toEqual({ locale: 'ru', confident: false, script: 'cyrillic' });
      // A conversation in another script has no Cyrillic language to keep.
      expect(detectLocale(line, 'uz'), line).toEqual({ locale: 'ru', confident: false, script: 'cyrillic' });
    }
  });

  it('…Russian is confident on its own words or letters, Uzbek on its own', () => {
    for (const line of ['Здравствуйте, сколько стоит доставка из Китая?', 'Есть груз, 5 кубов', 'Когда будет?', 'Нужны цены', 'Привет']) {
      expect(detectLocale(line), line).toEqual({ locale: 'ru', confident: true, script: 'cyrillic' });
    }
    for (const line of ['Ассалому алайкум', 'Гуанчжоудан юк бор эди', 'нархи қанча', 'Салом, юк бор эди']) {
      expect(detectLocale(line), line).toEqual({ locale: 'uz_cyrl', confident: true, script: 'cyrillic' });
    }
    // An Uzbek line with a Russian greeting is Uzbek — its own mark decides first.
    expect(detectLocale('Здравствуйте, юк бор эди').locale).toBe('uz_cyrl');
    // A long Russian line turns an Uzbek Cyrillic conversation; a short one does not.
    expect(detectLocale('Здравствуйте, сколько стоит доставка?', 'uz_cyrl')).toMatchObject({ locale: 'ru', confident: true });
    expect(detectLocale('да, есть', 'uz_cyrl')).toMatchObject({ locale: 'uz_cyrl', confident: false });
  });

  it('«Hello», «price?» in an Uzbek conversation is a loan word, not English — the Cyrillic rule’s twin', () => {
    expect(detectLocale('Hello', 'uz')).toEqual({ locale: 'uz', confident: false, script: 'latin' });
    expect(detectLocale('price?', 'uz')).toEqual({ locale: 'uz', confident: false, script: 'latin' });
    // …a sentence of English is English, in any conversation; and with no history «Hello» is all there is to go on.
    expect(detectLocale('Hello, how much is shipping from China?', 'uz')).toMatchObject({ locale: 'en', confident: true });
    expect(detectLocale('Hello')).toMatchObject({ locale: 'en', confident: true });
    expect(detectLocale('Hello', 'ru')).toMatchObject({ locale: 'en', confident: true });
  });

  it('every locale names the script its reply must be written in', () => {
    expect(scriptOf('fa')).toBe('arabic');
    expect(scriptOf('zh')).toBe('han');
    expect(scriptOf('uz_cyrl')).toBe('cyrillic');
    expect(scriptOf('en')).toBe('latin');
    expect(dominantScript('سلام GS777')).toBe('arabic');
  });
});
